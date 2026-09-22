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

/** Backdates a return_created ChannelEvent's processedAt -- the only way
 * these tests can control "was this refund known as of the report date"
 * without waiting for real time to pass. ingestWalmartReturn always stamps
 * `processedAt: now()`. */
async function backdateReturn(returnOrderId: string, processedAt: Date) {
  await prisma.channelEvent.update({
    where: { externalId_eventType: { externalId: returnOrderId, eventType: 'return_created' } },
    data: { processedAt },
  })
}

const csv = [
  'Purchase Order #,Amount,Commission Amount,Currency,Transaction Type',
  'PO-1001,105.98,-15.90,USD,PaymentWithdrawn',
  'PO-9999,49.99,-7.50,USD,PaymentWithdrawn',
  ',0.00,0.00,USD,Adjustment',
].join('\n')

describe('walmart settlement', () => {
  beforeEach(async () => {
    await resetDb()
    await seedSystemActor()
  })
  afterAll(() => prisma.$disconnect())

  // --- Brief Step 1, verbatim -------------------------------------------

  it('parses csv rows to cents and skips rows without a PO', () => {
    const rows = parseSettlementCsv(csv)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ externalOrderId: 'PO-1001', amountCents: 10598, feeCents: -1590, currency: 'USD' })
    expect(rows[0].raw['Transaction Type']).toBe('PaymentWithdrawn')
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
    expect(matched.status).toBe('matched')
    expect(matched.orderId).not.toBeNull()
    const unmatched = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-9999' } })
    expect(unmatched.status).toBe('unmatched') // the review-queue surface
  })

  it('preserves the fee sign convention: a negative Commission Amount stays negative, a positive one stays positive', () => {
    const rows = parseSettlementCsv(
      ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type', 'PO-1,10.00,-1.50,USD,PaymentWithdrawn', 'PO-2,10.00,1.50,USD,Adjustment'].join('\n'),
    )
    expect(rows[0].feeCents).toBe(-150)
    expect(rows[1].feeCents).toBe(150)
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
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type', 'PO-1001,105.98,-15.90,USD,PaymentWithdrawn'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
      expect(row.status).toBe('matched')
      expect(row.discrepancyCents).toBe(0)
    })

    it('mismatch by one cent is recorded exactly, with sign, and flips status to discrepant', async () => {
      await seedIngestedOrder()
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type', 'PO-1001,105.97,-15.90,USD,PaymentWithdrawn'].join('\n'),
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
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type', 'PO-1001,118.68,-17.50,USD,PaymentWithdrawn'].join('\n'),
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

    it('a refunded order: discrepancy nets the order gross against a refund recorded on or before reportDate', async () => {
      const orderId = await seedIngestedOrder()
      await prisma.order.update({ where: { id: orderId }, data: { status: 'fulfilled' } })
      await ingestWalmartReturn(
        { returnOrderId: 'RO-1', customerOrderInfo: { purchaseOrderId: 'PO-1001' }, refundedAmount: { currency: 'USD', amount: 40.0 } },
        'webhook',
      )
      // Backdate to before the report date -- see fact-3 time-filter fix below.
      await backdateReturn('RO-1', new Date('2026-07-20'))
      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('refunded')
      // Walmart's remittance for this PO after the partial refund: gross
      // (105.98) - refunded (40.00) = 65.98.
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type', 'PO-1001,65.98,-9.90,USD,PaymentWithdrawn'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
      expect(row.discrepancyCents).toBe(0)
      expect(row.status).toBe('matched')
    })

    it('nets a refund even when the order never transitioned past paid/fulfilled -- Order.status is not the gate (fact 3, fixed)', async () => {
      // ingestWalmartReturn only transitions fulfilled -> refunded; a refund
      // recorded while the order is still 'paid' leaves the coarse flag
      // alone even though the return event (and its real amount) is on file.
      const orderId = await seedIngestedOrder()
      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('paid')
      await ingestWalmartReturn(
        { returnOrderId: 'RO-EARLY', customerOrderInfo: { purchaseOrderId: 'PO-1001' }, refundedAmount: { currency: 'USD', amount: 40.0 } },
        'webhook',
      )
      await backdateReturn('RO-EARLY', new Date('2026-07-20'))
      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('paid') // unchanged
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type', 'PO-1001,65.98,-9.90,USD,PaymentWithdrawn'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
      expect(row.discrepancyCents).toBe(0)
    })

    it('a refund recorded AFTER the report date is NOT netted -- the report reflects money as of its own date (fact 3 time-filter)', async () => {
      const orderId = await seedIngestedOrder()
      await prisma.order.update({ where: { id: orderId }, data: { status: 'fulfilled' } })
      // No backdating: ingestWalmartReturn stamps `processedAt: now()`, which
      // in this test run is well after 2026-08-01.
      await ingestWalmartReturn(
        { returnOrderId: 'RO-LATE', customerOrderInfo: { purchaseOrderId: 'PO-1001' }, refundedAmount: { currency: 'USD', amount: 40.0 } },
        'webhook',
      )
      // Report is dated BEFORE the refund happened; Walmart's Sale row for
      // that date is the full, unrefunded gross.
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type', 'PO-1001,105.98,-15.90,USD,PaymentWithdrawn'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
      // A time-blind netting would subtract the (not-yet-happened, as of
      // 08-01) refund and report a false +4000 overpayment. Filtered
      // correctly, the 08-01 report is an honest exact match.
      expect(row.discrepancyCents).toBe(0)
      expect(row.status).toBe('matched')
    })

    it('a refunded order with NO matching return event on file: still records a real (non-zero) discrepancy rather than hiding the gap', async () => {
      const orderId = await seedIngestedOrder()
      await prisma.order.update({ where: { id: orderId }, data: { status: 'refunded' } })
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type', 'PO-1001,65.98,-9.90,USD,PaymentWithdrawn'].join('\n'),
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
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type', 'PO-2002,118.68,-17.50,USD,PaymentWithdrawn'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-2002' } })
      expect(row.discrepancyCents).toBeNull()
      expect(row.status).toBe('matched') // an order WAS found -- only the comparison is unavailable
    })

    it('a settlement row for an order we have never seen: unmatched, discrepancyCents stays null (nothing to compare)', async () => {
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type', 'PO-GHOST,10.00,-1.50,USD,PaymentWithdrawn'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-GHOST' } })
      expect(row.status).toBe('unmatched')
      expect(row.discrepancyCents).toBeNull()
    })

    it('a fee that exceeds the amount: feeCents/netCents are stored exactly and do not corrupt the amount-based discrepancy', async () => {
      await seedIngestedOrder()
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type', 'PO-1001,10.00,-150.00,USD,PaymentWithdrawn'].join('\n'),
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

    it('transaction-type gate: a Sale row is reconciled, a same-PO non-sale row (e.g. a separate Refund line) is recorded but never compared', async () => {
      await seedIngestedOrder() // gross 10598, no refund on file
      const rows = parseSettlementCsv(
        [
          'Purchase Order #,Amount,Commission Amount,Currency,Transaction Type',
          'PO-1001,105.98,-15.90,USD,PaymentWithdrawn',
          'PO-1001,40.00,0.00,USD,Refund',
        ].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const sale = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001', transactionType: 'PaymentWithdrawn' } })
      expect(sale.discrepancyCents).toBe(0)
      expect(sale.status).toBe('matched')
      const refundRow = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001', transactionType: 'Refund' } })
      // NOT compared -- a naive whole-order-lifetime comparison would report
      // this row as a ~10198-cent "shortfall" (40.00 vs the 105.98 gross),
      // which is not a real discrepancy: it's just not a sale row.
      expect(refundRow.discrepancyCents).toBeNull()
      expect(refundRow.status).toBe('matched') // still linked to a real order
    })

    it('nets a refund correctly even when the return payload\'s top-level purchaseOrderId disagrees with customerOrderInfo.purchaseOrderId (matches returns.service.ts precedence)', async () => {
      const orderId = await seedIngestedOrder()
      await prisma.order.update({ where: { id: orderId }, data: { status: 'fulfilled' } })
      await ingestWalmartReturn(
        {
          returnOrderId: 'RO-PRECEDENCE',
          purchaseOrderId: 'WRONG-PO', // top-level -- must NOT win
          customerOrderInfo: { purchaseOrderId: 'PO-1001' }, // nested -- must win
          refundedAmount: { currency: 'USD', amount: 40.0 },
        },
        'webhook',
      )
      await backdateReturn('RO-PRECEDENCE', new Date('2026-07-20'))
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type', 'PO-1001,65.98,-9.90,USD,PaymentWithdrawn'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
      expect(row.discrepancyCents).toBe(0)
    })
  })

  // --- audit trail ---------------------------------------------------------

  describe('importSettlementRows: audit trail', () => {
    it('writes one summary audit row per call, inside the transaction, with row count/report date/counts', async () => {
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
      expect(audits[0].after).toMatchObject({ reportDate: '2026-08-01', rowCount: 2, imported: 2, matched: 1, unmatched: 1 })

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
        ['Purchase Order #,Amount,Commission Amount,Currency,Transaction Type', 'PO-1001,105.98,-15.90,USD,PaymentWithdrawn'].join('\n'),
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
        externalOrderId: 'PO-GOOD', amountCents: 1000, feeCents: -100, currency: 'USD', transactionType: 'PaymentWithdrawn',
        raw: { 'Purchase Order #': 'PO-GOOD', Amount: '10.00', 'Commission Amount': '-1.00', Currency: 'USD', 'Transaction Type': 'PaymentWithdrawn' },
      }
      // Simulates parseSettlementCsv's documented comma-shift failure mode: a
      // non-numeric cell landing in Amount parses to NaN cents.
      const badRow: SettlementRow = {
        externalOrderId: 'PO-BAD', amountCents: NaN, feeCents: 0, currency: 'USD', transactionType: 'PaymentWithdrawn',
        raw: { 'Purchase Order #': 'PO-BAD', Amount: 'not-a-number', 'Commission Amount': '0', Currency: 'USD', 'Transaction Type': 'PaymentWithdrawn' },
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
      'PO-7777,10.00,-1.50,USD,PaymentWithdrawn',
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
