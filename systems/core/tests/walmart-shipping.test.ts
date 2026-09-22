import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { ingestWalmartOrder } from '../src/channels/walmart/orders.ingest.js'
import { recordChannelShipment, cancelChannelOrder, registerShippingHandlers } from '../src/channels/walmart/shipping.js'
import { processDueJobs, clearHandlers } from '../src/channels/walmart/outbox.js'
import { walmartOrderFixture } from './helpers/walmart-fixtures.js'
import type { WalmartClient } from '../src/channels/walmart/client.js'

// Same reason as tests/walmart-orders-ingest.test.ts: resetDb() clears every
// Actor row, including the 'system' actor the one-time migration seeds, so it
// has to be recreated after every resetDb() call for recordAudit's default
// actorId to satisfy the FK.
async function seedSystemActor() {
  await prisma.actor.create({ data: { id: 'system', type: 'human', name: 'system' } })
}

async function seedAndIngest() {
  const p = await prisma.product.create({ data: { slug: 'castle', name: 'Castle', productType: 'own_designed', status: 'published' } })
  const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-SET-001', priceCents: 4999 } })
  await prisma.inventory.create({ data: { variantId: v.id, onHand: 10 } })
  await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-SET-001-W', status: 'live' } })
  const { orderId } = await ingestWalmartOrder(walmartOrderFixture, 'poll')
  return { orderId: orderId!, variantId: v.id }
}

describe('walmart shipping', () => {
  beforeEach(async () => {
    await resetDb()
    await seedSystemActor()
    clearHandlers()
  })
  afterAll(() => prisma.$disconnect())

  it('handles the task 5 ack job end to end via the outbox', async () => {
    const { orderId } = await seedAndIngest()
    const calls: any[] = []
    const client: WalmartClient = { request: async (m, path, opts) => { calls.push({ m, path, opts }); return {} } }
    registerShippingHandlers(client)

    const before = await prisma.channelJob.findFirstOrThrow({ where: { type: 'walmart_ack_order' } })
    expect(before.status).toBe('pending')

    // ingestWalmartOrder also enqueues a walmart_inventory_push job (Task 7),
    // which has no handler registered in this test -- only the ack/ship/cancel
    // handlers under test are registered here -- so it dead-letter-retries and
    // is the one expected failure in this batch. Assert on the ack job
    // specifically rather than the whole batch's failed count.
    await processDueJobs()

    const after = await prisma.channelJob.findFirstOrThrow({ where: { type: 'walmart_ack_order' } })
    expect(after.status).toBe('done')
    expect(calls).toEqual([{ m: 'POST', path: '/v3/orders/PO-1001/acknowledge', opts: undefined }])
    void orderId
  })

  it('fulfills the canonical order and pushes ack + shipment', async () => {
    const { orderId, variantId } = await seedAndIngest()
    const calls: any[] = []
    const client: WalmartClient = { request: async (m, path, opts) => { calls.push({ m, path, opts }); return {} } }
    registerShippingHandlers(client)

    await recordChannelShipment(orderId, { carrier: 'USPS', trackingNumber: 'T-1' })
    await processDueJobs()

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('fulfilled')
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { variantId } })
    expect(inv).toMatchObject({ onHand: 8, reserved: 0 })
    const paths = calls.map((c) => c.path)
    expect(paths).toContain('/v3/orders/PO-1001/acknowledge')
    expect(paths).toContain('/v3/orders/PO-1001/shipping')
    const ship = calls.find((c) => c.path.endsWith('/shipping'))
    expect(ship.opts.body.orderShipment.orderLines.orderLine[0].orderLineStatuses.orderLineStatus[0].trackingInfo.trackingNumber).toBe('T-1')
  })

  it('refuses to ship a non-walmart or non-paid order', async () => {
    const { orderId } = await seedAndIngest()
    registerShippingHandlers({ request: async () => ({}) })
    await recordChannelShipment(orderId, { carrier: 'USPS', trackingNumber: 'T-1' })
    await expect(recordChannelShipment(orderId, { carrier: 'USPS', trackingNumber: 'T-2' }))
      .rejects.toMatchObject({ code: 'not_shippable' })
  })

  // Idempotency at the operation layer: recordChannelShipment's own guard
  // (order.status !== 'paid') is what stops a second shipment push from
  // double-decrementing stock, independent of the job-level dedupeKey. This
  // is the case the brief's second test doesn't quite cover -- it asserts the
  // rejection but not that stock only moved once.
  it('does not double-decrement stock when shipment is recorded twice', async () => {
    const { orderId, variantId } = await seedAndIngest()
    registerShippingHandlers({ request: async () => ({}) })
    await recordChannelShipment(orderId, { carrier: 'USPS', trackingNumber: 'T-1' })
    await expect(recordChannelShipment(orderId, { carrier: 'USPS', trackingNumber: 'T-2' }))
      .rejects.toMatchObject({ code: 'not_shippable' })
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { variantId } })
    expect(inv).toMatchObject({ onHand: 8, reserved: 0 })
    // Exactly one walmart_ship_order job, from the successful first call.
    expect(await prisma.channelJob.count({ where: { type: 'walmart_ship_order' } })).toBe(1)
  })

  // Job-level idempotency: the walmart_ship_order handler never touches
  // stock at all -- stock already moved once, inside recordChannelShipment's
  // call to fulfillOrder, in the same transaction that enqueued the job. So replaying the
  // job (e.g. processDueJobs picks it up again because a crash between the
  // client call and the status='done' write left it 'pending') can only
  // repeat the Walmart HTTP call, never move stock a second time or touch
  // the order row again. Simulate that replay by resetting the job to
  // 'pending' by hand and running processDueJobs a second time.
  it('re-running the walmart_ship_order job after a lost status update does not move stock again', async () => {
    const { orderId, variantId } = await seedAndIngest()
    const calls: any[] = []
    const client: WalmartClient = { request: async (m, path, opts) => { calls.push({ m, path, opts }); return {} } }
    registerShippingHandlers(client)
    await recordChannelShipment(orderId, { carrier: 'USPS', trackingNumber: 'T-1' })
    await processDueJobs()

    const shipJob = await prisma.channelJob.findFirstOrThrow({ where: { type: 'walmart_ship_order' } })
    expect(shipJob.status).toBe('done')
    const shipCallsBefore = calls.filter((c) => c.path.endsWith('/shipping')).length
    expect(shipCallsBefore).toBe(1)

    // Simulate the crash-before-status-write replay.
    await prisma.channelJob.update({ where: { id: shipJob.id }, data: { status: 'pending', runAfter: new Date() } })
    await processDueJobs()

    const shipCallsAfter = calls.filter((c) => c.path.endsWith('/shipping')).length
    expect(shipCallsAfter).toBe(2) // Walmart called again -- that's expected and harmless
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('fulfilled') // unchanged
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { variantId } })
    expect(inv).toMatchObject({ onHand: 8, reserved: 0 }) // stock did not move again
    expect(await prisma.auditLog.count({ where: { action: 'order.fulfilled', target: `order:${orderId}` } })).toBe(1)
  })

  it('cancels a paid walmart order (seller-initiated) and releases the reservation', async () => {
    const { orderId, variantId } = await seedAndIngest()
    const calls: any[] = []
    const client: WalmartClient = { request: async (m, path, opts) => { calls.push({ m, path, opts }); return {} } }
    registerShippingHandlers(client)

    await cancelChannelOrder(orderId)
    await processDueJobs()

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('cancelled')
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { variantId } })
    expect(inv).toMatchObject({ onHand: 10, reserved: 0 })
    const cancel = calls.find((c) => c.path.endsWith('/cancel'))
    expect(cancel).toBeTruthy()
    expect(cancel.path).toBe('/v3/orders/PO-1001/cancel')
    expect(cancel.opts.body.orderCancellation.orderLines.orderLine[0]).toMatchObject({
      lineNumber: '1',
      orderLineStatuses: { orderLineStatus: [{ status: 'Cancelled' }] },
    })
  })

  it('does not double-release stock when cancel is attempted twice', async () => {
    const { orderId, variantId } = await seedAndIngest()
    registerShippingHandlers({ request: async () => ({}) })
    await cancelChannelOrder(orderId)
    await expect(cancelChannelOrder(orderId)).rejects.toMatchObject({ code: 'invalid_transition' })
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { variantId } })
    expect(inv).toMatchObject({ onHand: 10, reserved: 0 })
  })

  it('refuses to cancel a non-walmart order', async () => {
    const order = await prisma.order.create({
      data: {
        email: 'a@b.com', shipToState: 'MI', status: 'paid', channel: 'storefront',
        subtotalCents: 100, taxCents: 0, totalCents: 100, taxRateBps: 0, taxJurisdiction: 'x',
      },
    })
    registerShippingHandlers({ request: async () => ({}) })
    await expect(cancelChannelOrder(order.id)).rejects.toMatchObject({ code: 'not_walmart' })
  })

  it('audits every order state transition driven from this file', async () => {
    const { orderId } = await seedAndIngest()
    registerShippingHandlers({ request: async () => ({}) })
    await recordChannelShipment(orderId, { carrier: 'USPS', trackingNumber: 'T-1' })
    const fulfilledAudit = await prisma.auditLog.findFirst({ where: { action: 'order.fulfilled', target: `order:${orderId}` } })
    expect(fulfilledAudit).toBeTruthy()
  })

  // Final fix wave B2: Walmart line numbers are derived by POSITION, so the
  // handlers must read order lines in the order ingest created them. Without
  // an orderBy, Postgres returns rows in whatever physical order it finds
  // them -- and an ordinary UPDATE of a line (which writes a new row version
  // elsewhere in the heap) is enough to move that line to the end. Here the
  // first-ingested line is touched after ingest; the ship and cancel pushes
  // must still report it as lineNumber '1' with its own quantity.
  async function seedAndIngestThreeLines() {
    const skus = ['ABE-L1', 'ABE-L2', 'ABE-L3']
    for (const [i, sku] of skus.entries()) {
      const p = await prisma.product.create({ data: { slug: `l${i}`, name: `L${i}`, productType: 'own_designed', status: 'published' } })
      const v = await prisma.variant.create({ data: { productId: p.id, sku, priceCents: 1000 } })
      await prisma.inventory.create({ data: { variantId: v.id, onHand: 10 } })
      await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: `${sku}-W`, status: 'live' } })
    }
    const payload = {
      ...walmartOrderFixture,
      purchaseOrderId: 'PO-3L',
      orderLines: {
        orderLine: skus.map((sku, i) => ({
          lineNumber: String(i + 1),
          item: { sku: `${sku}-W`, productName: sku },
          orderLineQuantity: { unitOfMeasurement: 'EACH', amount: String(i + 1) }, // L1=1, L2=2, L3=3
          charges: { charge: [{ chargeType: 'PRODUCT', chargeAmount: { currency: 'USD', amount: 10 } }] },
        })),
      },
    }
    const { orderId } = await ingestWalmartOrder(payload, 'poll')
    // Touch the first-ingested line so its row version moves in the heap.
    const first = await prisma.orderLine.findFirstOrThrow({ where: { orderId: orderId!, sku: 'ABE-L1' } })
    await prisma.orderLine.update({ where: { id: first.id }, data: { discountCents: 0 } })
    return orderId!
  }

  function lineQuantities(orderLines: any[]): Record<string, string> {
    return Object.fromEntries(orderLines.map((l) => [l.lineNumber, l.orderLineStatuses.orderLineStatus[0].statusQuantity.amount]))
  }

  it('B2: ship push numbers lines in ingest order, even after a line row was updated', async () => {
    const orderId = await seedAndIngestThreeLines()
    const calls: any[] = []
    registerShippingHandlers({ request: async (m, path, opts) => { calls.push({ m, path, opts }); return {} } })
    await recordChannelShipment(orderId, { carrier: 'USPS', trackingNumber: 'T-3' })
    await processDueJobs()
    const ship = calls.find((c) => c.path.endsWith('/shipping'))
    expect(lineQuantities(ship.opts.body.orderShipment.orderLines.orderLine)).toEqual({ 1: '1', 2: '2', 3: '3' })
  })

  it('B2: cancel push numbers lines in ingest order, even after a line row was updated', async () => {
    const orderId = await seedAndIngestThreeLines()
    const calls: any[] = []
    registerShippingHandlers({ request: async (m, path, opts) => { calls.push({ m, path, opts }); return {} } })
    await cancelChannelOrder(orderId)
    await processDueJobs()
    const cancel = calls.find((c) => c.path.endsWith('/cancel'))
    expect(lineQuantities(cancel.opts.body.orderCancellation.orderLines.orderLine)).toEqual({ 1: '1', 2: '2', 3: '3' })
  })
})
