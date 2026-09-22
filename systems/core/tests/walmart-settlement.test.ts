import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { walmartOrderFixture } from './helpers/walmart-fixtures.js'
import { ingestWalmartOrder } from '../src/channels/walmart/orders.ingest.js'
import { ingestWalmartReturn } from '../src/channels/walmart/returns.service.js'
import { parseSettlementCsv, importSettlementRows, reconstructOrderGrossCents } from '../src/channels/walmart/settlement.js'

// Same reason as every other walmart *.test.ts file: resetDb() clears every
// Actor row, including the 'system' actor the one-time migration seeds, and
// ingestWalmartOrder/ingestWalmartReturn's recordAudit calls default to
// actorId 'system'.
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

const csv = [
  'Purchase Order #,Amount,Commission Amount,Currency,Transaction Type',
  'PO-1001,105.98,-15.90,USD,PaymentWithdrawn',
  'PO-9999,49.99,-7.50,USD,PaymentWithdrawn',
  ',0.00,0.00,USD,Adjustment',
].join('\n')

describe('walmart settlement', () => {
  beforeEach(resetDb)
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

  // --- Reconciliation arithmetic (task context, "three facts") ----------

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

  describe('importSettlementRows: discrepancyCents', () => {
    async function seedIngestedOrder(payload: unknown = walmartOrderFixture) {
      await seedListing(10)
      const { orderId } = await ingestWalmartOrder(payload, 'webhook')
      return orderId!
    }

    beforeEach(seedSystemActor)

    it('exact match: settlement amount equals the reconstructed order gross -> discrepancyCents is 0', async () => {
      await seedIngestedOrder()
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency', 'PO-1001,105.98,-15.90,USD'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
      expect(row.status).toBe('matched')
      expect(row.discrepancyCents).toBe(0)
    })

    it('mismatch by one cent is recorded exactly, with sign: settlement paid less than expected is negative', async () => {
      await seedIngestedOrder()
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency', 'PO-1001,105.97,-15.90,USD'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
      // amountCents(10597) - expectedNetCents(10598) = -1
      expect(row.discrepancyCents).toBe(-1)
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
      // Walmart remits the TRUE gross including shipping.
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency', 'PO-1001,118.68,-17.50,USD'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
      // A naive comparison against Order.totalCents (10598) would report a
      // 1270-cent "discrepancy" that is really just the shipping charge (and
      // its tax) the order mapper drops. Reconciling against the
      // reconstructed gross (11868) shows the true, zero, discrepancy instead.
      expect(row.discrepancyCents).toBe(0)
    })

    it('a refunded order: discrepancy nets the order gross against the recorded refund amount, not the coarse status flag', async () => {
      const orderId = await seedIngestedOrder()
      // Fulfil then refund via the real ingestion path so the refund amount
      // lives only where fact 3 says it does: ChannelEvent.raw.
      await prisma.order.update({ where: { id: orderId }, data: { status: 'fulfilled' } })
      await ingestWalmartReturn(
        { returnOrderId: 'RO-1', customerOrderInfo: { purchaseOrderId: 'PO-1001' }, refundedAmount: { currency: 'USD', amount: 40.0 } },
        'webhook',
      )
      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('refunded')
      // Walmart's remittance for this PO after the partial refund: gross
      // (105.98) - refunded (40.00) = 65.98.
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency', 'PO-1001,65.98,-9.90,USD'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
      expect(row.discrepancyCents).toBe(0)
    })

    it('a refunded order with NO matching return event on file: still records a real (non-zero) discrepancy rather than hiding the gap', async () => {
      const orderId = await seedIngestedOrder()
      // Force the coarse flag to 'refunded' without any return_created
      // ChannelEvent -- simulates a data gap (e.g. an out-of-band refund).
      await prisma.order.update({ where: { id: orderId }, data: { status: 'refunded' } })
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency', 'PO-1001,65.98,-9.90,USD'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
      // No return event found -> refundedCents treated as 0 -> expected stays
      // the full gross (105.98) -> discrepancy is honestly non-zero (-40.00),
      // not silently swallowed as a "match".
      expect(row.discrepancyCents).toBe(-4000)
    })

    it('a settlement row for an order we have never seen: unmatched, discrepancyCents stays null (nothing to compare)', async () => {
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency', 'PO-GHOST,10.00,-1.50,USD'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-GHOST' } })
      expect(row.status).toBe('unmatched')
      expect(row.discrepancyCents).toBeNull()
    })

    it('a fee that exceeds the amount: feeCents is stored exactly and does not corrupt the amount-based discrepancy', async () => {
      await seedIngestedOrder()
      // Commission (-150.00) is larger in magnitude than the Amount (10.00) --
      // an implausible commission, but the CSV/import layer must not crash,
      // clamp, or let the fee bleed into the gross-amount comparison.
      const rows = parseSettlementCsv(
        ['Purchase Order #,Amount,Commission Amount,Currency', 'PO-1001,10.00,-150.00,USD'].join('\n'),
      )
      await importSettlementRows(new Date('2026-08-01'), rows)
      const row = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
      expect(row.feeCents).toBe(-15000)
      expect(row.amountCents).toBe(1000)
      // 1000 - 10598 = -9598, unaffected by the fee.
      expect(row.discrepancyCents).toBe(-9598)
    })
  })
})
