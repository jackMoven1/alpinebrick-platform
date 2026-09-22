import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { ingestWalmartOrder, ChannelError } from '../src/channels/walmart/orders.ingest.js'
import { walmartOrderFixture } from './helpers/walmart-fixtures.js'

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
    // target is namespaced `order:<id>`, matching every other recordAudit
    // call in the repo (orders.service.ts's `order:${id}`, etc.) -- not the
    // bare id the task brief specified. A provenance query filtering on
    // `target: 'order:' + id` must find this row.
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'walmart_order_ingested' } })
    expect(audit.target).toBe(`order:${r.orderId}`)
  })

  it('is idempotent across webhook + poll duplication (sequential)', async () => {
    await seedListing(10)
    const first = await ingestWalmartOrder(walmartOrderFixture, 'webhook')
    const second = await ingestWalmartOrder(walmartOrderFixture, 'poll')
    expect(second).toEqual({ orderId: first.orderId, created: false })
    expect(await prisma.order.count()).toBe(1)
    const inv = await prisma.inventory.findFirstOrThrow()
    expect(inv.reserved).toBe(2)
  })

  // The sequential test above covers one delivery fully committing before the
  // next starts, so the second sees the first's ChannelEvent at the
  // idempotency check and never enters the transaction. A TRUE race -- two
  // deliveries both starting before either commits -- can both pass that
  // read and both reach `tx.order.create`; only one can win the unique
  // constraint on `externalOrderId`. This is the case that needs the
  // `isConcurrentDeliveryRace` catch around the transaction: without it, the
  // loser rejects with a raw PrismaClientKnownRequestError (P2002) instead of
  // resolving to `{ created: false }`, and Task 6 has no `unmappable_order` /
  // `unknown_sku` / `insufficient_stock` code to match it against, so it logs
  // as an ingest failure and pages someone for what is actually a success.
  it('resolves a true concurrent re-delivery race to one order, not a raw constraint error', async () => {
    const v = await seedListing(10)
    const [a, b] = await Promise.all([
      ingestWalmartOrder(walmartOrderFixture, 'webhook'),
      ingestWalmartOrder(walmartOrderFixture, 'poll'),
    ])
    const winners = [a, b].filter((r) => r.created)
    const losers = [a, b].filter((r) => !r.created)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0]).toEqual({ orderId: winners[0].orderId, created: false })
    expect(await prisma.order.count()).toBe(1)
    expect(await prisma.channelEvent.count()).toBe(1)
    expect(await prisma.channelJob.count({ where: { type: 'walmart_ack_order' } })).toBe(1)
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { variantId: v.id } })
    expect(inv.reserved).toBe(2) // not 4 -- the loser's reservation rolled back with the rest of its transaction
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
    // The fixture has a single line wanting qty 2 against 1 in stock, so the
    // conditional UPDATE affects 0 rows and never reserves anything -- this
    // proves the gate held (reserved stays at 0), not that a rollback
    // released a reservation that was actually taken. The test below
    // ("rolls back the whole ingest...") is the one with a real reservation
    // to release, since its failure (missing audit actor) happens after a
    // successful reserve.
    expect(inv.reserved).toBe(0)
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
  // against), this goes red: the order/reservation/ChannelEvent/job commit
  // before the now-standalone audit write fails, so order.count() comes back
  // 1, not 0. Because recordAudit is the last statement in the callback and
  // enqueueJob runs just before it in the same transaction, this also proves
  // the ack job is atomic with everything else: if enqueueJob were ever moved
  // outside the transaction (or called with the default client instead of
  // `tx`), it would commit independently before recordAudit's later failure,
  // and channelJob.count() below would come back 1 instead of 0.
  // (Swapping only recordAudit's `tx` argument for the default client while
  // leaving its call site inside the callback is NOT independently caught by
  // this test -- it is the callback's last statement, so any throw there,
  // regardless of which client raised it, still rejects the callback and
  // rolls back the transaction's own writes. That narrower mutation was
  // checked by hand during implementation; see task-5-report.md.)
  it('rolls back the whole ingest -- reservation, order, event, and ack job -- when the audit write fails', async () => {
    const v = await seedListing(10)
    await prisma.actor.delete({ where: { id: 'system' } })
    await expect(ingestWalmartOrder(walmartOrderFixture, 'webhook')).rejects.toThrow()
    expect(await prisma.order.count()).toBe(0)
    expect(await prisma.channelEvent.count()).toBe(0)
    expect(await prisma.channelJob.count({ where: { type: 'walmart_ack_order' } })).toBe(0)
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { variantId: v.id } })
    expect(inv.reserved).toBe(0)
  })
})
