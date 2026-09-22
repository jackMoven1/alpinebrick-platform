import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { walmartOrderFixture } from './helpers/walmart-fixtures.js'
import { ingestWalmartOrder } from '../src/channels/walmart/orders.ingest.js'
import { ingestWalmartReturn } from '../src/channels/walmart/returns.service.js'
import {
  parseSettlementCsv,
  importSettlementRows,
  fetchAndImportSettlement,
  reconstructOrderGrossCents,
  type SettlementRow,
} from '../src/channels/walmart/settlement.js'
import type { WalmartClient } from '../src/channels/walmart/client.js'

// Same reason as every other walmart *.test.ts file: resetDb() clears every
// Actor row, including the 'system' actor the one-time migration seeds, and
// ingestWalmartOrder/ingestWalmartReturn/importSettlementRows's recordAudit
// calls all default to actorId 'system'.
async function seedSystemActor() {
  await prisma.actor.create({ data: { id: 'system', type: 'human', name: 'system' } })
}

async function seedListing(qty: number) {
  const p = await prisma.product.create({ data: { slug: 'castle', name: 'Castle', productType: 'own_designed', status: 'published' } })
  const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-SET-001', priceCents: 4999 } })
  await prisma.inventory.create({ data: { variantId: v.id, onHand: qty } })
  await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-SET-001-W', status: 'live' } })
  return v
}

async function seedIngestedOrder(payload: unknown = walmartOrderFixture) {
  await seedListing(10)
  const { orderId } = await ingestWalmartOrder(payload, 'webhook')
  return orderId!
}

const csv = [
  'Purchase Order #,Amount,Commission Amount,Currency,Transaction Type',
  'PO-1001,105.98,-15.90,USD,Sale',
  'PO-9999,49.99,-7.50,USD,Sale',
  ',0.00,0.00,USD,PaymentSummary',
].join('\n')

describe('walmart settlement', () => {
  beforeEach(async () => {
    await resetDb()
    await seedSystemActor()
  })
  afterAll(() => prisma.$disconnect())

  // --- Brief Step 1, structurally verbatim; VALUES corrected (review round 2)
  //
  // The brief's own literal fixture used 'PaymentWithdrawn'/'Adjustment' for
  // "Transaction Type" -- invented placeholders, not real Walmart values.
  // developer.walmart.com/us-marketplace/docs/recon-report-json documents
  // 'Sale' and 'PaymentSummary' as the actual values (see
  // SALE_TRANSACTION_TYPE's doc comment in settlement.ts). That invented
  // value is exactly how the transaction-type gate's bug (comparing against
  // a constant equal to the fixture's own made-up value) survived a green
  // suite: "verified against itself." Deliberately deviating from the
  // brief's literal string here per explicit instruction, disclosed in the
  // task report.

  it('parses csv rows to cents and skips rows without a PO', () => {
    const rows = parseSettlementCsv(csv)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ externalOrderId: 'PO-1001', amountCents: 10598, feeCents: -1590, currency: 'USD' })
    expect(rows[0].raw['Transaction Type']).toBe('Sale')
  })

  it('imports rows and matches them to orders by external id', async () => {
    await prisma.order.create({
      data: {
        email: 'w@c.l', shipToState: 'MI', status: 'fulfilled', channel: 'walmart', externalOrderId: 'PO-1001',
        subtotalCents: 9998, taxCents: 600, totalCents: 10598, taxRateBps: 0, taxJurisdiction: 'walmart_facilitator',
      },
    })
    const rows = parseSettlementCsv(csv)
    const date = new Date('2026-08-01')
    const r = await importSettlementRows(date, rows)
    expect(r).toEqual({ imported: 2, matched: 1, unmatched: 1 })
    const again = await importSettlementRows(date, rows)
    expect(again.imported).toBe(0) // duplicate rows skipped
    const matched = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
    // Review round 3 (finding B3): status is 'unreconciled', NOT 'matched' --
    // this order was created directly (no ingestWalmartOrder), so there is
    // no order_created ChannelEvent to reconstruct an expected gross from,
    // and the amount was therefore NEVER COMPARED. 'matched' now means only
    // "compared, and exactly right"; an order being found by externalOrderId
    // (the `matched` COUNT in the return value above) is a coarser, separate
    // fact from that. Deliberately deviating from the brief's literal
    // `.toBe('matched')` assertion here -- disclosed in the task report.
    expect(matched.status).toBe('unreconciled')
    expect(matched.orderId).not.toBeNull()
    const unmatched = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-9999' } })
    expect(unmatched.status).toBe('unmatched') // the review-queue surface
  })

  it('preserves the fee sign convention: a negative Commission Amount stays negative, a positive one stays positive', () => {
    const rows = parseSettlementCsv(
      ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type', 'PO-1,10.00,-1.50,USD,Sale', 'PO-2,10.00,1.50,USD,PaymentSummary'].join('\n'),
    )
    expect(rows[0].feeCents).toBe(-150)
    expect(rows[1].feeCents).toBe(150)
  })

  it('rejects a Sale row carrying a positive commission rather than letting it pass silently (item 10)', async () => {
    await seedIngestedOrder()
    const rows: SettlementRow[] = [
      {
        externalOrderId: 'PO-1001', amountCents: 10598, feeCents: 100, currency: 'USD', transactionType: 'Sale',
        transactionKey: 'TK-BAD-FEE', purchaseOrderLine: '1', amountType: 'Product Price',
        raw: { 'Purchase Order #': 'PO-1001', Amount: '105.98', 'Commission Amount': '1.00', Currency: 'USD', 'Transaction Type': 'Sale' },
      },
    ]
    await expect(importSettlementRows(new Date('2026-08-01'), rows)).rejects.toThrow(/positive commission/)
    // The whole import rolled back -- nothing committed, not even as a
    // recorded-but-flagged row.
    expect(await prisma.channelSettlement.count()).toBe(0)
  })

  // --- reconstructOrderGrossCents (fact 1: shipping) ---------------------

  describe('reconstructOrderGrossCents (fact 1: shipping)', () => {
    it('matches Order.totalCents exactly when there is no shipping charge (base-case invariant)', () => {
      expect(reconstructOrderGrossCents(walmartOrderFixture)).toBe(10598)
    })

    it('includes a SHIPPING charge and its tax that the order mapper drops', () => {
      const withShipping = structuredClone(walmartOrderFixture) as any
      withShipping.orderLines.orderLine[0].charges.charge.push({
        chargeType: 'SHIPPING',
        chargeAmount: { currency: 'USD', amount: 5.99 },
        tax: { taxName: 'Tax1', taxAmount: { currency: 'USD', amount: 0.36 } },
      })
      // qty=2: PRODUCT (49.99+3.00) + SHIPPING (5.99+0.36) = 59.34/unit * 2 = 118.68
      expect(reconstructOrderGrossCents(withShipping)).toBe(11868)
    })

    it('returns null (not 0, not a guess) for a payload missing orderLines', () => {
      expect(reconstructOrderGrossCents({ purchaseOrderId: 'PO-1' })).toBeNull()
    })
  })

  // --- importSettlementRows: discrepancyCents / status -------------------

  describe('importSettlementRows: discrepancyCents', () => {
    it('exact match: settlement amount equals the reconstructed order gross -> discrepancyCents is 0, status stays matched', async () => {
      await seedIngestedOrder()
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type', 'PO-1001,105.98,-15.90,USD,Sale'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
      expect(row.status).toBe('matched')
      expect(row.discrepancyCents).toBe(0)
    })

    it('mismatch by one cent is recorded exactly, with sign, and flips status to discrepant', async () => {
      await seedIngestedOrder()
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type', 'PO-1001,105.97,-15.90,USD,Sale'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
      // amountCents(10597) - expectedNetCents(10598) = -1
      expect(row.discrepancyCents).toBe(-1)
      expect(row.status).toBe('discrepant')
    })

    it('an order with a SHIPPING charge: discrepancy is computed against the shipping-inclusive reconstruction, not Order.totalCents', async () => {
      const withShipping = structuredClone(walmartOrderFixture) as any
      withShipping.orderLines.orderLine[0].charges.charge.push({
        chargeType: 'SHIPPING',
        chargeAmount: { currency: 'USD', amount: 5.99 },
        tax: { taxName: 'Tax1', taxAmount: { currency: 'USD', amount: 0.36 } },
      })
      const orderId = await seedIngestedOrder(withShipping)
      // Order.totalCents is still 10598 (PRODUCT only); Walmart's true gross is 11868.
      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).totalCents).toBe(10598)
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type', 'PO-1001,118.68,-17.50,USD,Sale'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
      // A naive comparison against Order.totalCents (10598) would report a
      // 1270-cent "discrepancy" that is really just the shipping charge (and
      // its tax) the order mapper drops. Reconciling against the
      // reconstructed gross (11868) shows the true, zero, discrepancy instead.
      expect(row.discrepancyCents).toBe(0)
      expect(row.status).toBe('matched')
    })

    // --- fact 3 / B2: Sale rows are GROSS; refunds reconcile as their own
    // rows and do NOT net into this comparison (review round 3 reverses
    // round 1's refund-netting design -- see expectedNetCents' doc comment
    // in settlement.ts for why netting a refund into a Sale row's expected
    // figure produced a phantom overpayment whenever a refund landed before
    // the sale settled).

    it('a Sale row compares against GROSS only -- a refund on the order does not net into the comparison', async () => {
      const orderId = await seedIngestedOrder()
      await prisma.order.update({ where: { id: orderId }, data: { status: 'fulfilled' } })
      await ingestWalmartReturn(
        { returnOrderId: 'RO-1', customerOrderInfo: { purchaseOrderId: 'PO-1001' }, refundedAmount: { currency: 'USD', amount: 40.0 } },
        'webhook',
      )
      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('refunded')
      // Even though $40 was refunded, Walmart's Sale row is documented as
      // gross -- the full, unrefunded amount is the correct comparison.
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type', 'PO-1001,105.98,-15.90,USD,Sale'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
      expect(row.discrepancyCents).toBe(0)
      expect(row.status).toBe('matched')
    })

    it('a Sale row reported net-of-refund (a shape Walmart\'s docs do not show) is honestly flagged discrepant, not silently absorbed', async () => {
      const orderId = await seedIngestedOrder()
      await prisma.order.update({ where: { id: orderId }, data: { status: 'fulfilled' } })
      await ingestWalmartReturn(
        { returnOrderId: 'RO-2', customerOrderInfo: { purchaseOrderId: 'PO-1001' }, refundedAmount: { currency: 'USD', amount: 40.0 } },
        'webhook',
      )
      // If a Sale row ever DID arrive net-of-refund (65.98 instead of the
      // full 105.98 gross) -- the shape round 1's design silently absorbed
      // -- it now surfaces honestly as a real, non-zero discrepancy instead
      // of being explained away.
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type', 'PO-1001,65.98,-9.90,USD,Sale'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
      expect(row.discrepancyCents).toBe(-4000)
      expect(row.status).toBe('discrepant')
    })

    it('no order_created ChannelEvent on file (e.g. a legacy/directly-created order): REFUSES to compare rather than falling back to Order.totalCents, even with shipping in play', async () => {
      // Mirrors the brief's own required test's fixture shape -- created
      // directly, no ingestWalmartOrder, so no ChannelEvent exists at all.
      await prisma.order.create({
        data: {
          email: 'w@c.l', shipToState: 'MI', status: 'fulfilled', channel: 'walmart', externalOrderId: 'PO-2002',
          subtotalCents: 9998, taxCents: 600, totalCents: 10598, taxRateBps: 0, taxJurisdiction: 'walmart_facilitator',
        },
      })
      // Simulates the real order having had a SHIPPING charge Walmart
      // actually remits for -- unknowable to us with no raw payload on file.
      // The old fallback-to-Order.totalCents design would have manufactured
      // a -1270 "discrepancy" here (exactly the shipping charge). The fix
      // refuses instead.
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type', 'PO-2002,118.68,-17.50,USD,Sale'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-2002' } })
      expect(row.discrepancyCents).toBeNull()
      // Review round 3 (finding B3): 'unreconciled', not 'matched' -- an
      // order WAS found, but the amount was never actually compared.
      expect(row.status).toBe('unreconciled')
    })

    it('a settlement row for an order we have never seen: unmatched, discrepancyCents stays null (nothing to compare)', async () => {
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type', 'PO-GHOST,10.00,-1.50,USD,Sale'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-GHOST' } })
      expect(row.status).toBe('unmatched')
      expect(row.discrepancyCents).toBeNull()
    })

    it('a fee that exceeds the amount: feeCents/netCents are stored exactly and do not corrupt the amount-based discrepancy', async () => {
      await seedIngestedOrder()
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type', 'PO-1001,10.00,-150.00,USD,Sale'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
      expect(row.feeCents).toBe(-15000)
      expect(row.amountCents).toBe(1000)
      // 1000 - 10598 = -9598, unaffected by the fee.
      expect(row.discrepancyCents).toBe(-9598)
      expect(row.status).toBe('discrepant')
      // What actually lands in the bank: 1000 + (-15000) = -14000.
      expect(row.netCents).toBe(-14000)
    })

    it('transaction-type gate: a Sale row is reconciled, a same-PO row of the OTHER documented type (PaymentSummary) is recorded but never compared', async () => {
      await seedIngestedOrder() // gross 10598
      // Transaction Key distinguishes the two rows -- without it, both would
      // fall back to the SAME (PO, '', '', reportDate) ledger key (neither
      // row carries a Purchase Order line # or Amount Type column) and the
      // second would be silently treated as a duplicate of the first, which
      // is exactly the degenerate-fallback-key limitation computeLedgerKey's
      // doc comment names: with no identifying columns at all, this file
      // cannot tell two genuinely different rows apart.
      const rows = parseSettlementCsv(
        [
          'Purchase Order #,Amount,Commission Amount,Currency,Transaction Type,Transaction Key',
          'PO-1001,105.98,-15.90,USD,Sale,TK-SALE-1',
          'PO-1001,40.00,0.00,USD,PaymentSummary,TK-SUMMARY-1',
        ].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const sale = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001', transactionType: 'Sale' } })
      expect(sale.discrepancyCents).toBe(0)
      expect(sale.status).toBe('matched')
      const summaryRow = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001', transactionType: 'PaymentSummary' } })
      // NOT compared -- a naive whole-order-lifetime comparison would report
      // this row as a ~10198-cent "shortfall" (40.00 vs the 105.98 gross),
      // which is not a real discrepancy: it's just not a Sale row.
      expect(summaryRow.discrepancyCents).toBeNull()
      // Review round 3 (finding B3): 'unreconciled', not 'matched' -- linked
      // to a real order, but never compared.
      expect(summaryRow.status).toBe('unreconciled')
    })

    // --- Amount Type itemisation (review round 2) -------------------------
    //
    // developer.walmart.com/us-marketplace/docs/recon-report-json's example
    // Sale row carries "Amount Type": "Product Price" alongside "Amount":
    // "14.98" -- evidence a single sale settlement arrives as SEVERAL Sale
    // rows per PO (one per Amount Type: product, shipping, tax), not one row
    // carrying the whole order's total. See saleAmountSumByOrder's doc
    // comment in settlement.ts for the full reasoning and the aggregation
    // fix. This fixture is shaped like the documented example: three Sale
    // rows for the same PO, one per Amount Type, summing to the order's true
    // gross (including the SHIPPING charge the order mapper itself drops --
    // fact 1 all over again, one level deeper).
    it('itemised Sale rows (Amount Type: Product Price / Shipping / Tax) aggregate to the order gross, not compared row by row', async () => {
      const withShipping = structuredClone(walmartOrderFixture) as any
      withShipping.orderLines.orderLine[0].charges.charge.push({
        chargeType: 'SHIPPING',
        chargeAmount: { currency: 'USD', amount: 5.99 },
        tax: { taxName: 'Tax1', taxAmount: { currency: 'USD', amount: 0.36 } },
      })
      await seedIngestedOrder(withShipping) // true gross 11868 (see the SHIPPING test above)

      // qty=2: Product Price 49.99*2=99.98, Shipping 5.99*2=11.98,
      // Tax (3.00+0.36)*2=6.72 -- sums to 118.68, the full documented-shape
      // itemisation of the same 11868-cent gross.
      const rows = parseSettlementCsv(
        [
          'Purchase Order #,Amount,Commission Amount,Currency,Transaction Type,Amount Type',
          'PO-1001,99.98,0.00,USD,Sale,Product Price',
          'PO-1001,11.98,0.00,USD,Sale,Shipping',
          'PO-1001,6.72,-17.50,USD,Sale,Tax',
        ].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)

      const itemisedRows = await prisma.channelSettlement.findMany({ where: { externalOrderId: 'PO-1001' }, orderBy: { amountCents: 'desc' } })
      expect(itemisedRows).toHaveLength(3)
      // Each row still records its OWN true received amount and Amount Type.
      expect(itemisedRows.map((r) => r.amountCents).sort((a, b) => a - b)).toEqual([672, 1198, 9998])
      // But every row carries the SAME order-level discrepancy: the group
      // (99.98+11.98+6.72=118.68) reconciles exactly to the 118.68 gross.
      // Row-by-row, "Product Price" alone (99.98) against the 118.68 gross
      // would show a false ~1870-cent "shortfall".
      for (const r of itemisedRows) {
        expect(r.discrepancyCents).toBe(0)
        expect(r.status).toBe('matched')
      }
      // Amount Type is preserved verbatim in raw for a human to inspect.
      expect(itemisedRows.map((r) => (r.raw as any)['Amount Type']).sort()).toEqual(['Product Price', 'Shipping', 'Tax'])
    })

    // --- ledger key (review round 3, finding B1 -- Critical) --------------

    it('two Sale rows for the same order with the SAME amount/fee both persist when their identities differ (Walmart splits quantity into separate lines)', async () => {
      await seedIngestedOrder() // two units of the same $49.99 SKU
      const rows: SettlementRow[] = [
        {
          externalOrderId: 'PO-1001', amountCents: 4999, feeCents: 0, currency: 'USD', transactionType: 'Sale',
          transactionKey: '', purchaseOrderLine: '1', amountType: 'Product Price',
          raw: {
            'Purchase Order #': 'PO-1001', Amount: '49.99', 'Commission Amount': '0.00', Currency: 'USD',
            'Transaction Type': 'Sale', 'Purchase Order line #': '1', 'Amount Type': 'Product Price',
          },
        },
        {
          // Identical amountCents/feeCents/transactionType to the row above
          // -- a value-based key (round 1's design) would find the first
          // row via findFirst and silently skip this one as if it were a
          // re-delivery. A different Purchase Order line # makes this a
          // genuinely distinct ledger entry.
          externalOrderId: 'PO-1001', amountCents: 4999, feeCents: 0, currency: 'USD', transactionType: 'Sale',
          transactionKey: '', purchaseOrderLine: '2', amountType: 'Product Price',
          raw: {
            'Purchase Order #': 'PO-1001', Amount: '49.99', 'Commission Amount': '0.00', Currency: 'USD',
            'Transaction Type': 'Sale', 'Purchase Order line #': '2', 'Amount Type': 'Product Price',
          },
        },
      ]
      const r = await importSettlementRows(new Date('2026-08-01'), rows)
      expect(r.imported).toBe(2) // NOT collapsed to 1
      const persisted = await prisma.channelSettlement.findMany({ where: { externalOrderId: 'PO-1001' } })
      expect(persisted).toHaveLength(2)
      const ledgerKeys = new Set(persisted.map((p) => (p as any).ledgerKey))
      expect(ledgerKeys.size).toBe(2) // distinct identities -> distinct keys
    })

    it('a Transaction Key, when present, is used as the ledger key directly (and re-importing the identical row is still deduped)', async () => {
      await seedIngestedOrder()
      const rows = parseSettlementCsv(
        [
          'Purchase Order #,Amount,Commission Amount,Currency,Transaction Type,Transaction Key',
          'PO-1001,105.98,-15.90,USD,Sale,2020_12_19_317',
        ].join('\n'),
      )
      const first = await importSettlementRows(new Date('2026-08-01'), rows)
      expect(first.imported).toBe(1)
      const second = await importSettlementRows(new Date('2026-08-01'), rows)
      expect(second.imported).toBe(0) // same Transaction Key -- a genuine re-delivery
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
      expect((row as any).ledgerKey).toBe('2020_12_19_317')
    })
  })

  // --- audit trail ---------------------------------------------------------

  describe('importSettlementRows: audit trail', () => {
    it('writes one summary audit row per call, inside the transaction, with row count/report date/counts (including unreconciled)', async () => {
      await prisma.order.create({
        data: {
          email: 'w@c.l', shipToState: 'MI', status: 'fulfilled', channel: 'walmart', externalOrderId: 'PO-1001',
          subtotalCents: 9998, taxCents: 600, totalCents: 10598, taxRateBps: 0, taxJurisdiction: 'walmart_facilitator',
        },
      })
      const rows = parseSettlementCsv(csv)
      await importSettlementRows(new Date('2026-08-01'), rows)
      const audits = await prisma.auditLog.findMany({ where: { action: 'walmart_settlement_imported' } })
      expect(audits).toHaveLength(1)
      expect(audits[0].target).toBe('settlement_report:2026-08-01')
      // PO-1001 was created directly (no ChannelEvent) -> unreconciled: 1.
      expect(audits[0].after).toMatchObject({ reportDate: '2026-08-01', rowCount: 2, imported: 2, matched: 1, unmatched: 1, unreconciled: 1 })

      // A second, all-duplicate call still records its own summary row.
      await importSettlementRows(new Date('2026-08-01'), rows)
      expect(await prisma.auditLog.count({ where: { action: 'walmart_settlement_imported' } })).toBe(2)
      const second = await prisma.auditLog.findMany({ where: { action: 'walmart_settlement_imported' }, orderBy: { createdAt: 'asc' } })
      expect(second[1].after).toMatchObject({ imported: 0 })
    })
  })

  // --- reportDate normalization ---------------------------------------------

  describe('importSettlementRows: reportDate normalization', () => {
    it('two calls for the same UTC day with different times dedupe as one report, not two', async () => {
      await seedIngestedOrder()
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type', 'PO-1001,105.98,-15.90,USD,Sale'].join('\n'),
      )
      const first = await importSettlementRows(new Date('2026-08-01T09:00:00Z'), rows)
      const second = await importSettlementRows(new Date('2026-08-01T23:00:00Z'), rows)
      expect(first.imported).toBe(1)
      expect(second.imported).toBe(0) // same UTC day -- deduped, not a second row
      expect(await prisma.channelSettlement.count({ where: { externalOrderId: 'PO-1001' } })).toBe(1)
    })
  })

  // --- atomicity -------------------------------------------------------------

  describe('importSettlementRows: atomicity', () => {
    it('a malformed row rolls back the WHOLE import -- no half-imported report', async () => {
      const validRow: SettlementRow = {
        externalOrderId: 'PO-GOOD', amountCents: 1000, feeCents: -100, currency: 'USD', transactionType: 'Sale',
        transactionKey: 'TK-GOOD', purchaseOrderLine: '1', amountType: 'Product Price',
        raw: { 'Purchase Order #': 'PO-GOOD', Amount: '10.00', 'Commission Amount': '-1.00', Currency: 'USD', 'Transaction Type': 'Sale' },
      }
      // Simulates parseSettlementCsv's documented comma-shift failure mode: a
      // non-numeric cell landing in Amount parses to NaN cents.
      const badRow: SettlementRow = {
        externalOrderId: 'PO-BAD', amountCents: NaN, feeCents: 0, currency: 'USD', transactionType: 'Sale',
        transactionKey: 'TK-BAD', purchaseOrderLine: '1', amountType: 'Product Price',
        raw: { 'Purchase Order #': 'PO-BAD', Amount: 'not-a-number', 'Commission Amount': '0', Currency: 'USD', 'Transaction Type': 'Sale' },
      }
      await expect(importSettlementRows(new Date('2026-08-01'), [validRow, badRow])).rejects.toThrow()
      expect(await prisma.channelSettlement.count()).toBe(0)
      expect(await prisma.auditLog.count({ where: { action: 'walmart_settlement_imported' } })).toBe(0)
    })
  })

  // --- fetchAndImportSettlement ---------------------------------------------

  describe('fetchAndImportSettlement', () => {
    const oneRowCsv = [
      'Purchase Order #,Amount,Commission Amount,Currency,Transaction Type',
      'PO-7777,10.00,-1.50,USD,Sale',
    ].join('\n')

    it('imports when the client returns a bare CSV string, and queries reportDate as YYYY-MM-DD', async () => {
      let capturedQuery: Record<string, string> | undefined
      const client: WalmartClient = {
        request: async (_method, _path, opts) => {
          capturedQuery = opts?.query
          return oneRowCsv
        },
      }
      const r = await fetchAndImportSettlement(new Date('2026-08-01T12:00:00Z'), client)
      expect(r).toEqual({ imported: 1, matched: 0, unmatched: 1 })
      expect(capturedQuery).toEqual({ reportDate: '2026-08-01' })
    })

    it('imports when the client returns { csv: string }', async () => {
      const client: WalmartClient = { request: async () => ({ csv: oneRowCsv }) }
      const r = await fetchAndImportSettlement(new Date('2026-08-01'), client)
      expect(r).toEqual({ imported: 1, matched: 0, unmatched: 1 })
    })

    it('throws on an unexpected response shape rather than silently importing nothing', async () => {
      const client: WalmartClient = { request: async () => ({ notCsv: true }) }
      await expect(fetchAndImportSettlement(new Date('2026-08-01'), client)).rejects.toThrow('unexpected report response shape')
      expect(await prisma.channelSettlement.count()).toBe(0)
    })
  })
})
