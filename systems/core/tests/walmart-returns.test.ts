import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { walmartOrderFixture } from './helpers/walmart-fixtures.js'
import { ingestWalmartOrder } from '../src/channels/walmart/orders.ingest.js'
import { recordChannelShipment, registerShippingHandlers } from '../src/channels/walmart/shipping.js'
import { ingestWalmartReturn, markOrderRefunded, issueWalmartRefund } from '../src/channels/walmart/returns.service.js'
import { pollWalmartReturns } from '../src/channels/walmart/pollers.js'
import { clearHandlers } from '../src/channels/walmart/outbox.js'
import { OrderError } from '../src/orders/orders.service.js'
import type { WalmartClient } from '../src/channels/walmart/client.js'

// Same reason as tests/walmart-shipping.test.ts / walmart-orders-ingest.test.ts:
// resetDb() clears every Actor row, including the 'system' actor the one-time
// migration seeds, so it has to be recreated after every resetDb() call for
// recordAudit's default actorId to satisfy the FK. There is no shared
// tests/helpers/seed.ts in this codebase (each walmart test file defines this
// locally) -- matching that existing convention rather than introducing a new
// shared helper module.
async function seedSystemActor() {
  await prisma.actor.create({ data: { id: 'system', type: 'human', name: 'system' } })
}

const returnFixture = {
  returnOrderId: 'RO-1',
  customerOrderInfo: { purchaseOrderId: 'PO-1001' },
  refundedAmount: { currency: 'USD', amount: 105.98 },
}

async function seedFulfilledOrder() {
  const p = await prisma.product.create({ data: { slug: 'castle', name: 'Castle', productType: 'own_designed', status: 'published' } })
  const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-SET-001', priceCents: 4999 } })
  await prisma.inventory.create({ data: { variantId: v.id, onHand: 10 } })
  await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-SET-001-W', status: 'live' } })
  const { orderId } = await ingestWalmartOrder(walmartOrderFixture, 'poll')
  registerShippingHandlers({ request: async () => ({}) })
  await recordChannelShipment(orderId!, { carrier: 'USPS', trackingNumber: 'T-1' })
  return orderId!
}

describe('walmart returns', () => {
  beforeEach(async () => {
    await resetDb()
    await seedSystemActor()
    clearHandlers()
  })
  afterAll(() => prisma.$disconnect())

  it('ingests a refunded return idempotently and marks the order refunded', async () => {
    const orderId = await seedFulfilledOrder()

    const r1 = await ingestWalmartReturn(returnFixture, 'webhook')
    expect(r1.created).toBe(true)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('refunded')

    const event = await prisma.channelEvent.findUniqueOrThrow({
      where: { externalId_eventType: { externalId: 'RO-1', eventType: 'return_created' } },
    })
    expect(event.raw).toMatchObject(returnFixture)

    // Re-delivery (poller re-scanning what the webhook already ingested) is a
    // no-op, not a second refund.
    const r2 = await ingestWalmartReturn(returnFixture, 'poll')
    expect(r2.created).toBe(false)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('refunded')
    expect(await prisma.auditLog.count({ where: { action: 'walmart_order_refunded' } })).toBe(1)
    expect(await prisma.auditLog.count({ where: { action: 'walmart_return_ingested' } })).toBe(1)
  })

  it('does not touch stock on refund -- restock is a manual admin action', async () => {
    const orderId = await seedFulfilledOrder()
    const variant = await prisma.variant.findUniqueOrThrow({ where: { sku: 'ABE-SET-001' } })
    const before = await prisma.inventory.findUniqueOrThrow({ where: { variantId: variant.id } })

    await ingestWalmartReturn(returnFixture, 'webhook')

    const after = await prisma.inventory.findUniqueOrThrow({ where: { variantId: variant.id } })
    expect(after.onHand).toBe(before.onHand)
    expect(after.reserved).toBe(before.reserved)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('refunded')
  })

  it('does not transition the order on a zero or missing refund amount', async () => {
    const orderId = await seedFulfilledOrder()
    const zeroRefund = { returnOrderId: 'RO-3', customerOrderInfo: { purchaseOrderId: 'PO-1001' }, refundedAmount: { currency: 'USD', amount: 0 } }
    const r = await ingestWalmartReturn(zeroRefund, 'webhook')
    expect(r.created).toBe(true)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('fulfilled')
    expect(await prisma.auditLog.count({ where: { action: 'walmart_order_refunded' } })).toBe(0)
  })

  it('rejects refunding a nonexistent order', async () => {
    await expect(markOrderRefunded('no-such-order')).rejects.toMatchObject({ code: 'order_not_found' })
  })

  it('resolves a true concurrent re-delivery race to one refund, not a raw constraint error', async () => {
    const orderId = await seedFulfilledOrder()
    const [a, b] = await Promise.all([
      ingestWalmartReturn(returnFixture, 'webhook'),
      ingestWalmartReturn(returnFixture, 'poll'),
    ])
    const winners = [a, b].filter((r) => r.created)
    const losers = [a, b].filter((r) => !r.created)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(await prisma.channelEvent.count({ where: { externalId: 'RO-1' } })).toBe(1)
    expect(await prisma.auditLog.count({ where: { action: 'walmart_order_refunded' } })).toBe(1)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('refunded')
  })

  it('does not double-refund when two distinct returns for the same order race concurrently', async () => {
    const orderId = await seedFulfilledOrder()
    const returnA = { returnOrderId: 'RO-1', customerOrderInfo: { purchaseOrderId: 'PO-1001' }, refundedAmount: { currency: 'USD', amount: 20 } }
    const returnB = { returnOrderId: 'RO-2', customerOrderInfo: { purchaseOrderId: 'PO-1001' }, refundedAmount: { currency: 'USD', amount: 30 } }
    const [a, b] = await Promise.all([
      ingestWalmartReturn(returnA, 'webhook'),
      ingestWalmartReturn(returnB, 'webhook'),
    ])
    // Both are real, distinct returns and must both be recorded -- neither is
    // a re-delivery of the other.
    expect(a.created).toBe(true)
    expect(b.created).toBe(true)
    expect(await prisma.channelEvent.count({ where: { eventType: 'return_created' } })).toBe(2)
    expect(await prisma.auditLog.count({ where: { action: 'walmart_return_ingested' } })).toBe(2)
    // But only one of them can actually flip the order -- the second one to
    // reach the conditional UPDATE loses the race and its transition is
    // skipped, not double-applied.
    expect(await prisma.auditLog.count({ where: { action: 'walmart_order_refunded' } })).toBe(1)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('refunded')
  })

  it('rejects invalid refund transitions', async () => {
    const orderId = await seedFulfilledOrder()
    await markOrderRefunded(orderId) // fulfilled -> refunded succeeds
    await expect(markOrderRefunded(orderId)).rejects.toMatchObject({ code: 'invalid_transition' })
    await expect(markOrderRefunded(orderId)).rejects.toBeInstanceOf(OrderError)
  })

  it('rejects refunding an order that never fulfilled', async () => {
    const p = await prisma.product.create({ data: { slug: 'castle', name: 'Castle', productType: 'own_designed', status: 'published' } })
    const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-SET-001', priceCents: 4999 } })
    await prisma.inventory.create({ data: { variantId: v.id, onHand: 10 } })
    await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-SET-001-W', status: 'live' } })
    const { orderId } = await ingestWalmartOrder(walmartOrderFixture, 'poll') // status: paid
    await expect(markOrderRefunded(orderId!)).rejects.toMatchObject({ code: 'invalid_transition' })
  })

  it('records the return without transitioning the order when Walmart has not refunded yet', async () => {
    const orderId = await seedFulfilledOrder()
    const noRefundYet = { returnOrderId: 'RO-2', customerOrderInfo: { purchaseOrderId: 'PO-1001' } }
    const r = await ingestWalmartReturn(noRefundYet, 'webhook')
    expect(r.created).toBe(true)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('fulfilled')
    expect(await prisma.auditLog.count({ where: { action: 'walmart_order_refunded' } })).toBe(0)
  })

  it('issues a refund via the client and polls returns', async () => {
    await seedFulfilledOrder()
    const calls: any[] = []
    const client: WalmartClient = { request: async (m, path) => { calls.push({ m, path }); return { returnOrders: [returnFixture] } } }
    await issueWalmartRefund('RO-1', client)
    expect(calls[0]).toEqual({ m: 'POST', path: '/v3/returns/RO-1/refund' })
    expect(await prisma.auditLog.count({ where: { action: 'walmart_refund_issued' } })).toBe(1)

    const polled = await pollWalmartReturns(client)
    expect(polled.found).toBe(1)
    expect(polled.created).toBe(1)
  })
})
