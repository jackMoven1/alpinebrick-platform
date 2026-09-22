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
    // Review round 4 (finding 3): the brief's `matched` COUNT is renamed
    // `linked` -- it counts "an order was found", which is not what
    // `status: 'matched'` ("compared, and exactly right") means. Deviation
    // from the brief's literal interface, disclosed in the task report.
    expect(r).toEqual({ imported: 2, linked: 1, unmatched: 1 })
    const again = await importSettlementRows(date, rows)
    expect(again.imported).toBe(0) // duplicate rows skipped
    const linkedRow = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
    // 'unreconciled', NOT 'matched' (round 3, B3; deviation from the brief's
    // literal assertion, disclosed): the order was created directly, so no
    // order_created payload exists to compare against -- and (round 4,
    // finding 1b) this brief-shaped row carries no Transaction Key, line #
    // or Amount Type, so it has no identity and is never compared anyway.
    expect(linkedRow.status).toBe('unreconciled')
    expect(linkedRow.orderId).not.toBeNull()
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

  it('a Sale row carrying a positive commission is persisted unreconciled and audited -- it does not block the rest of the report (finding 4)', async () => {
    await seedIngestedOrder() // PO-1001, gross 10598
    await ingestWalmartOrder({ ...walmartOrderFixture, purchaseOrderId: 'PO-1002', customerOrderId: 'CO-9002' }, 'webhook') // gross 10598
    const rows: SettlementRow[] = [
      {
        externalOrderId: 'PO-1001', amountCents: 10598, feeCents: 100, currency: 'USD', transactionType: 'Sale',
        transactionKey: 'TK-BAD-FEE', purchaseOrderLine: '1', amountType: 'Product Price',
        raw: { 'Purchase Order #': 'PO-1001', Amount: '105.98', 'Commission Amount': '1.00', Currency: 'USD', 'Transaction Type': 'Sale' },
      },
      {
        externalOrderId: 'PO-1002', amountCents: 10598, feeCents: -1590, currency: 'USD', transactionType: 'Sale',
        transactionKey: 'TK-GOOD-FEE', purchaseOrderLine: '1', amountType: 'Product Price',
        raw: { 'Purchase Order #': 'PO-1002', Amount: '105.98', 'Commission Amount': '-15.90', Currency: 'USD', 'Transaction Type': 'Sale' },
      },
    ]
    const r = await importSettlementRows(new Date('2026-08-01'), rows)
    expect(r.imported).toBe(2)
    // The odd row is kept, as received, but never compared -- its amount
    // alone would have been an exact match, which is precisely what must
    // not be stamped 'matched' for a row we do not understand.
    const odd = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
    expect(odd.feeCents).toBe(100)
    expect(odd.status).toBe('unreconciled')
    expect(odd.discrepancyCents).toBeNull()
    // The other order in the same report still reconciles.
    const other = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1002' } })
    expect(other.status).toBe('matched')
    expect(other.discrepancyCents).toBe(0)
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'walmart_settlement_imported' } })
    expect((audit.after as any).anomalies).toEqual([
      { ledgerKey: odd.ledgerKey, externalOrderId: 'PO-1001', transactionType: 'Sale', reasons: ['positive_commission'] },
    ])
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
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type,Amount Type', 'PO-1001,105.98,-15.90,USD,Sale,Product Price'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
      expect(row.status).toBe('matched')
      expect(row.discrepancyCents).toBe(0)
    })

    it('mismatch by one cent is recorded exactly, with sign, and flips status to discrepant', async () => {
      await seedIngestedOrder()
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type,Amount Type', 'PO-1001,105.97,-15.90,USD,Sale,Product Price'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
      // amountCents(10597) - expectedGrossCents(10598) = -1
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
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type,Amount Type', 'PO-1001,118.68,-17.50,USD,Sale,Product Price'].join('\n'),
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
    // round 1's refund-netting design -- see expectedGrossCents' doc comment
    // in settlement.ts for why netting a refund into a Sale row's expected
    // figure produced a phantom overpayment whenever a refund landed before
    // the sale settled).

    // Review round 4, finding 2: both refund tests BACKDATE the return to
    // before the 2026-08-01 report date. Round 3's versions did not, so the
    // refund's processedAt was "now" -- after the report date -- and the
    // refund-netting code these tests exist to catch (5941deb, which only
    // netted refunds with processedAt < reportDate + 1 day) skipped the
    // refund and passed them too. Verified: with the backdate, both tests
    // FAIL against 5941deb's actual settlement.ts (4000 vs 0; 0 vs -4000);
    // without it, both pass there. See the task-12 report, round 4.
    async function backdateReturn(returnOrderId: string) {
      await prisma.channelEvent.update({
        where: { externalId_eventType: { externalId: returnOrderId, eventType: 'return_created' } },
        data: { processedAt: new Date('2026-07-30T12:00:00Z') },
      })
    }

    it('a Sale row compares against GROSS only -- a refund on file before the report date does not net into the comparison', async () => {
      const orderId = await seedIngestedOrder()
      await prisma.order.update({ where: { id: orderId }, data: { status: 'fulfilled' } })
      await ingestWalmartReturn(
        { returnOrderId: 'RO-1', customerOrderInfo: { purchaseOrderId: 'PO-1001' }, refundedAmount: { currency: 'USD', amount: 40.0 } },
        'webhook',
      )
      await backdateReturn('RO-1')
      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('refunded')
      // Even though $40 was refunded, Walmart's Sale row is documented as
      // gross -- the full, unrefunded amount is the correct comparison.
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type,Amount Type', 'PO-1001,105.98,-15.90,USD,Sale,Product Price'].join('\n'),
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
      await backdateReturn('RO-2')
      // If a Sale row ever DID arrive net-of-refund (65.98 instead of the
      // full 105.98 gross) -- the shape round 1's design silently absorbed
      // -- it now surfaces honestly as a real, non-zero discrepancy instead
      // of being explained away.
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type,Amount Type', 'PO-1001,65.98,-9.90,USD,Sale,Product Price'].join('\n'),
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
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type,Amount Type', 'PO-2002,118.68,-17.50,USD,Sale,Product Price'].join('\n'),
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
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type,Amount Type', 'PO-1001,10.00,-150.00,USD,Sale,Product Price'].join('\n'),
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
      // Transaction Keys give both rows an identity, so the Sale row can be
      // compared. (Round 3 needed them here to stop the second row being
      // silently dropped; since round 4 an identity-less row is kept anyway,
      // but is never compared -- see the fallback-key tests below.)
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
    // carrying the whole order's total. See importSettlementRowsAttempt's doc
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

    it('a Transaction Key, when present, anchors the ledger key (and re-importing the identical row is still deduped)', async () => {
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
      // Round 4: Transaction Type / line # / Amount Type are composed in, in
      // case one Transaction Key is shared by a transaction's itemised rows.
      expect(row.ledgerKey).toBe('tk:2020_12_19_317|Sale||')
    })

    // --- fallback-key collisions (review round 4, finding 1) ---------------

    it('(1a) a Sale row and a PaymentSummary row sharing PO, line # and Amount Type both persist -- Transaction Type is part of the key', async () => {
      await seedIngestedOrder() // gross 10598
      const rows = parseSettlementCsv(
        [
          'Purchase Order #,Amount,Commission Amount,Currency,Transaction Type,Purchase Order line #,Amount Type',
          'PO-1001,105.98,-15.90,USD,Sale,1,Product Price',
          'PO-1001,40.00,0.00,USD,PaymentSummary,1,Product Price',
        ].join('\n'),
      )
      // Delivered in SEPARATE import calls for the same report date: this is
      // where a key without Transaction Type silently drops the second row
      // (it looks like a re-delivery of the first). Within one call the
      // in-batch collision suffix would rescue it -- see (1c) -- so a
      // single-call version of this test cannot tell the two keys apart.
      const first = await importSettlementRows(new Date('2026-08-01'), [rows[0]])
      const second = await importSettlementRows(new Date('2026-08-01'), [rows[1]])
      expect(first.imported).toBe(1)
      expect(second.imported).toBe(1)
      const persisted = await prisma.channelSettlement.findMany({ where: { externalOrderId: 'PO-1001' } })
      expect(persisted.map((p) => p.transactionType).sort()).toEqual(['PaymentSummary', 'Sale'])
      expect(persisted.map((p) => p.ledgerKey).sort()).toEqual([
        'po:PO-1001|PaymentSummary|1|Product Price|2026-08-01',
        'po:PO-1001|Sale|1|Product Price|2026-08-01',
      ])
      const sale = persisted.find((p) => p.transactionType === 'Sale')!
      expect(sale.status).toBe('matched')
      expect(sale.discrepancyCents).toBe(0)
    })

    it('(1b) rows with NO identity (no Transaction Key, line # or Amount Type -- the brief\'s own CSV shape) are all persisted, never compared, and flagged', async () => {
      await seedIngestedOrder() // gross 10598
      // Two genuinely different rows for one PO on one day, plus an exact
      // repeat of the first. Round 3 keyed all three `PO-1001|||2026-08-01`
      // and kept only the first; round 4 keeps all three.
      const rows = parseSettlementCsv(
        [
          'Purchase Order #,Amount,Commission Amount,Currency,Transaction Type',
          'PO-1001,99.98,-15.90,USD,Sale',
          'PO-1001,6.00,0.00,USD,Sale',
          'PO-1001,99.98,-15.90,USD,Sale',
        ].join('\n'),
      )
      const r = await importSettlementRows(new Date('2026-08-01'), rows)
      expect(r.imported).toBe(3)
      const persisted = await prisma.channelSettlement.findMany({ where: { externalOrderId: 'PO-1001' } })
      expect(persisted).toHaveLength(3)
      // Nothing dropped: the persisted rows sum to exactly what was delivered.
      expect(persisted.reduce((a, p) => a + p.amountCents, 0)).toBe(rows.reduce((a, row) => a + row.amountCents, 0))
      // Nothing compared -- even though 99.98 + 6.00 alone would have summed
      // to the order's exact gross.
      for (const p of persisted) {
        expect(p.status).toBe('unreconciled')
        expect(p.discrepancyCents).toBeNull()
        expect(p.ledgerKey.startsWith('raw:2026-08-01|')).toBe(true)
      }
      expect(new Set(persisted.map((p) => p.ledgerKey)).size).toBe(3)
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'walmart_settlement_imported' } })
      const reasons = ((audit.after as any).anomalies as Array<{ reasons: string[] }>).map((a) => a.reasons)
      expect(reasons).toEqual([['no_identity'], ['no_identity'], ['no_identity', 'identity_collision']])

      // Re-importing the same report is still idempotent.
      const again = await importSettlementRows(new Date('2026-08-01'), rows)
      expect(again.imported).toBe(0)
      expect(await prisma.channelSettlement.count({ where: { externalOrderId: 'PO-1001' } })).toBe(3)
    })

    it('(1c) an in-report identity collision persists BOTH rows and leaves the group uncompared, so no stored figure disagrees with the persisted rows', async () => {
      await seedIngestedOrder() // gross 10598
      // Same PO, Transaction Type, line # and Amount Type, different amounts:
      // the uniqueness assumption is violated. Round 3 kept the first row
      // (99.98) but summed both (105.98) into its discrepancy, stamping it
      // 'matched' against rows that no longer existed.
      const rows = parseSettlementCsv(
        [
          'Purchase Order #,Amount,Commission Amount,Currency,Transaction Type,Purchase Order line #,Amount Type',
          'PO-1001,99.98,-15.90,USD,Sale,1,Product Price',
          'PO-1001,6.00,0.00,USD,Sale,1,Product Price',
        ].join('\n'),
      )
      const r = await importSettlementRows(new Date('2026-08-01'), rows)
      expect(r.imported).toBe(2)
      const persisted = await prisma.channelSettlement.findMany({ where: { externalOrderId: 'PO-1001' }, orderBy: { amountCents: 'desc' } })
      expect(persisted.map((p) => p.amountCents)).toEqual([9998, 600])
      expect(persisted.map((p) => p.ledgerKey)).toEqual(['po:PO-1001|Sale|1|Product Price|2026-08-01', 'po:PO-1001|Sale|1|Product Price|2026-08-01#1'])
      for (const p of persisted) {
        expect(p.status).toBe('unreconciled')
        expect(p.discrepancyCents).toBeNull()
      }
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'walmart_settlement_imported' } })
      expect((audit.after as any).anomalies).toEqual([
        { ledgerKey: 'po:PO-1001|Sale|1|Product Price|2026-08-01#1', externalOrderId: 'PO-1001', transactionType: 'Sale', reasons: ['identity_collision'] },
      ])
    })

    it('two itemised rows sharing ONE Transaction Key but different Amount Types both persist and aggregate', async () => {
      const withShipping = structuredClone(walmartOrderFixture) as any
      withShipping.orderLines.orderLine[0].charges.charge.push({
        chargeType: 'SHIPPING',
        chargeAmount: { currency: 'USD', amount: 5.99 },
        tax: { taxName: 'Tax1', taxAmount: { currency: 'USD', amount: 0.36 } },
      })
      await seedIngestedOrder(withShipping) // gross 11868
      const rows = parseSettlementCsv(
        [
          'Purchase Order #,Amount,Commission Amount,Currency,Transaction Type,Transaction Key,Amount Type',
          'PO-1001,106.70,-17.50,USD,Sale,TK-1,Product Price',
          'PO-1001,11.98,0.00,USD,Sale,TK-1,Shipping',
        ].join('\n'),
      )
      const r = await importSettlementRows(new Date('2026-08-01'), rows)
      expect(r.imported).toBe(2)
      const persisted = await prisma.channelSettlement.findMany({ where: { externalOrderId: 'PO-1001' } })
      expect(persisted).toHaveLength(2)
      for (const p of persisted) {
        expect(p.discrepancyCents).toBe(0)
        expect(p.status).toBe('matched')
      }
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
      // Round 4, finding 3: `linked` (an order was found) and `byStatus`
      // (the per-row status tally) are separate fields -- round 3 reported
      // `matched: 1, unreconciled: 1` here for ONE row, the same word
      // meaning two things. No top-level `matched` field survives.
      // Finding 5: the provisional status is carried in the data.
      expect(audits[0].after).toMatchObject({
        reportDate: '2026-08-01',
        reconciliationModel: 'unverified',
        rowCount: 2,
        imported: 2,
        linked: 1,
        byStatus: { matched: 0, unmatched: 1, discrepant: 0, unreconciled: 1 },
      })
      expect(audits[0].after).not.toHaveProperty('matched')
      expect(audits[0].after).not.toHaveProperty('unreconciled')
      // ...and on every row, for anyone reading channel_settlements directly.
      const models = await prisma.channelSettlement.findMany({ select: { reconciliationModel: true } })
      expect(models).toEqual([{ reconciliationModel: 'unverified' }, { reconciliationModel: 'unverified' }])

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
      expect(r).toEqual({ imported: 1, linked: 0, unmatched: 1 })
      expect(capturedQuery).toEqual({ reportDate: '2026-08-01' })
    })

    it('imports when the client returns { csv: string }', async () => {
      const client: WalmartClient = { request: async () => ({ csv: oneRowCsv }) }
      const r = await fetchAndImportSettlement(new Date('2026-08-01'), client)
      expect(r).toEqual({ imported: 1, linked: 0, unmatched: 1 })
    })

    it('throws on an unexpected response shape rather than silently importing nothing', async () => {
      const client: WalmartClient = { request: async () => ({ notCsv: true }) }
      await expect(fetchAndImportSettlement(new Date('2026-08-01'), client)).rejects.toThrow('unexpected report response shape')
      expect(await prisma.channelSettlement.count()).toBe(0)
    })
  })
})
