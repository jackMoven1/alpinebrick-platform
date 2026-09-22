import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { ingestWalmartOrder, ChannelError } from '../src/channels/walmart/orders.ingest.js'
import { walmartOrderFixture } from './walmart-mappers.test.js'

// resetDb() clears every Actor row (tests/helpers/db.ts), including the
// 'system' actor that migration 20260922100000_seed_system_actor creates.
// That migration only runs once, when the test database is provisioned; it
// does not re-run per test. So the actor recordAudit's default actorId
// depends on (see src/audit.ts, src/orders/orders.service.ts) has to be
// recreated after every resetDb() call -- the same thing
// tests/orders-audit-atomicity.test.ts does inline for the same reason.
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

describe('ingestWalmartOrder', () => {
  beforeEach(async () => {
    await resetDb()
    await seedSystemActor()
  })
  afterAll(() => prisma.$disconnect())

  it('creates a paid walmart order, reserves stock, records event + audit, enqueues ack', async () => {
    const v = await seedListing(10)
    const r = await ingestWalmartOrder(walmartOrderFixture, 'webhook')
    expect(r.created).toBe(true)
    const order = await prisma.order.findUniqueOrThrow({ where: { id: r.orderId! }, include: { lines: true } })
    expect(order).toMatchObject({
      status: 'paid', channel: 'walmart', externalOrderId: 'PO-1001',
      subtotalCents: 9998, taxCents: 600, totalCents: 10598,
      taxRateBps: 0, taxJurisdiction: 'walmart_facilitator',
    })
    expect(order.lines[0]).toMatchObject({ sku: 'ABE-SET-001', quantity: 2, unitPriceCents: 4999, lineSubtotalCents: 9998 })
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { variantId: v.id } })
    expect(inv.reserved).toBe(2)
    expect(await prisma.channelEvent.count({ where: { externalId: 'PO-1001', eventType: 'order_created' } })).toBe(1)
    expect(await prisma.channelJob.count({ where: { type: 'walmart_ack_order' } })).toBe(1)
    expect(await prisma.auditLog.count({ where: { action: 'walmart_order_ingested' } })).toBe(1)
  })

  it('is idempotent across webhook + poll duplication', async () => {
    await seedListing(10)
    const first = await ingestWalmartOrder(walmartOrderFixture, 'webhook')
    const second = await ingestWalmartOrder(walmartOrderFixture, 'poll')
    expect(second).toEqual({ orderId: first.orderId, created: false })
    expect(await prisma.order.count()).toBe(1)
    const inv = await prisma.inventory.findFirstOrThrow()
    expect(inv.reserved).toBe(2)
  })

  it('rejects unknown skus and insufficient stock without writing an event', async () => {
    await expect(ingestWalmartOrder(walmartOrderFixture, 'poll')).rejects.toMatchObject({ code: 'unknown_sku' })
    await seedListing(1) // order wants 2
    await expect(ingestWalmartOrder(walmartOrderFixture, 'poll')).rejects.toMatchObject({ code: 'insufficient_stock' })
    expect(await prisma.channelEvent.count()).toBe(0)
    expect(await prisma.order.count()).toBe(0)
    expect(await prisma.orderLine.count()).toBe(0)
    expect(await prisma.auditLog.count({ where: { action: 'walmart_order_ingested' } })).toBe(0)
    const inv = await prisma.inventory.findFirstOrThrow()
    expect(inv.reserved).toBe(0) // rollback released the partial reservation
  })

  it('throws ChannelError on unmappable payloads', async () => {
    await expect(ingestWalmartOrder({}, 'webhook')).rejects.toBeInstanceOf(ChannelError)
  })

  // Forces recordAudit to fail (no 'system' actor row, so the audit insert
  // violates its FK constraint) and checks the rest of the ingest. This is
  // the test that actually distinguishes "recordAudit's call site is inside
  // prisma.$transaction" from "it runs after that transaction has already
  // committed" -- mirrors tests/orders-audit-atomicity.test.ts's
  // discriminating test for the same class of defect on the storefront order
  // flow. If recordAudit is ever moved to run after the $transaction() block
  // returns (the literal reading of the plan text this task's brief warned
  // against), this goes red: the order/reservation/ChannelEvent commit before
  // the now-standalone audit write fails, so order.count() comes back 1, not
  // 0. (Swapping only the `tx` argument for the default client while leaving
  // the call inside the callback is NOT independently caught by this test --
  // recordAudit is the last statement in the callback, so any throw there,
  // regardless of which client raised it, still rejects the callback and
  // rolls back the transaction's own writes. That narrower mutation was
  // checked by hand during implementation; see task-5-report.md.)
  it('rolls back the whole ingest, including the reservation, when the audit write fails', async () => {
    const v = await seedListing(10)
    await prisma.actor.delete({ where: { id: 'system' } })
    await expect(ingestWalmartOrder(walmartOrderFixture, 'webhook')).rejects.toThrow()
    expect(await prisma.order.count()).toBe(0)
    expect(await prisma.channelEvent.count()).toBe(0)
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { variantId: v.id } })
    expect(inv.reserved).toBe(0)
  })
})
