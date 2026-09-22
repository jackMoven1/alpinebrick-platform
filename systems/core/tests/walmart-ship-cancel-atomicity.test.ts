// Final fix wave A1: the Walmart ship/cancel job must commit in the SAME
// transaction as the order's status change. Before this fix fulfillOrder /
// cancelOrder committed first, then ran the post-commit inventory pushes,
// then recordChannelShipment / cancelChannelOrder enqueued the job -- a throw
// or crash in between left a fulfilled/cancelled order with no outbound job,
// and a retry was refused by the status guard.
//
// Both the inventory-push enqueue and the outbox enqueue functions are
// wrapped in vi.fn around their real implementations, so each test can make
// exactly one of them fail and everything else stays real (real Postgres,
// real transactions, real conditional stock UPDATEs).
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'

const real = vi.hoisted(() => ({} as Record<string, any>))

vi.mock('../src/channels/walmart/inventory.sync.js', async (importOriginal) => {
  const actual: any = await importOriginal()
  real.enqueueInventoryPush = actual.enqueueInventoryPush
  return { ...actual, enqueueInventoryPush: vi.fn(actual.enqueueInventoryPush) }
})
vi.mock('../src/channels/walmart/outbox.js', async (importOriginal) => {
  const actual: any = await importOriginal()
  real.enqueueJob = actual.enqueueJob
  real.enqueueIdempotentJob = actual.enqueueIdempotentJob
  return {
    ...actual,
    enqueueJob: vi.fn(actual.enqueueJob),
    enqueueIdempotentJob: vi.fn(actual.enqueueIdempotentJob),
  }
})

import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { ingestWalmartOrder } from '../src/channels/walmart/orders.ingest.js'
import { recordChannelShipment, cancelChannelOrder } from '../src/channels/walmart/shipping.js'
import { enqueueInventoryPush } from '../src/channels/walmart/inventory.sync.js'
import { enqueueJob, enqueueIdempotentJob } from '../src/channels/walmart/outbox.js'
import { walmartOrderFixture } from './helpers/walmart-fixtures.js'

async function seedAndIngest() {
  await prisma.actor.create({ data: { id: 'system', type: 'human', name: 'system' } })
  const p = await prisma.product.create({ data: { slug: 'castle', name: 'Castle', productType: 'own_designed', status: 'published' } })
  const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-SET-001', priceCents: 4999 } })
  await prisma.inventory.create({ data: { variantId: v.id, onHand: 10 } })
  await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-SET-001-W', status: 'live' } })
  const { orderId } = await ingestWalmartOrder(walmartOrderFixture, 'poll')
  return { orderId: orderId!, variantId: v.id }
}

// Fails the enqueue of one job type whichever outbox entry point is used,
// so the test does not depend on which function the code under test calls.
function failEnqueueOf(type: string) {
  vi.mocked(enqueueJob).mockImplementation(async (t: string, ...rest: any[]) => {
    if (t === type) throw new Error(`simulated ${type} insert failure`)
    return real.enqueueJob(t, ...rest)
  })
  vi.mocked(enqueueIdempotentJob).mockImplementation(async (t: string, ...rest: any[]) => {
    if (t === type) throw new Error(`simulated ${type} insert failure`)
    return real.enqueueIdempotentJob(t, ...rest)
  })
}

describe('walmart ship/cancel job is atomic with the status change (A1)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  beforeEach(async () => {
    await resetDb()
    vi.mocked(enqueueInventoryPush).mockImplementation(real.enqueueInventoryPush)
    vi.mocked(enqueueJob).mockImplementation(real.enqueueJob)
    vi.mocked(enqueueIdempotentJob).mockImplementation(real.enqueueIdempotentJob)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { errorSpy.mockRestore() })
  afterAll(() => prisma.$disconnect())

  it('ship: the walmart_ship_order job exists even when the post-commit inventory enqueue throws', async () => {
    const { orderId } = await seedAndIngest()
    vi.mocked(enqueueInventoryPush).mockRejectedValue(new Error('inventory enqueue down'))

    await recordChannelShipment(orderId, { carrier: 'USPS', trackingNumber: 'T-1' }).catch(() => {})

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('fulfilled')
    const job = await prisma.channelJob.findUnique({ where: { dedupeKey: `ship:${orderId}` } })
    expect(job).toMatchObject({ type: 'walmart_ship_order', status: 'pending' })
    expect(job!.payload).toMatchObject({ orderId, carrier: 'USPS', trackingNumber: 'T-1' })
  })

  it('ship: if the job insert fails, the status change and the stock movement roll back', async () => {
    const { orderId, variantId } = await seedAndIngest()
    failEnqueueOf('walmart_ship_order')

    await expect(recordChannelShipment(orderId, { carrier: 'USPS', trackingNumber: 'T-1' })).rejects.toThrow()

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('paid')
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { variantId } })
    expect(inv).toMatchObject({ onHand: 10, reserved: 2 })
    expect(await prisma.auditLog.count({ where: { action: 'order.fulfilled' } })).toBe(0)
    expect(await prisma.channelJob.count({ where: { type: 'walmart_ship_order' } })).toBe(0)
  })

  it('cancel: the walmart_cancel_order job exists even when the post-commit inventory enqueue throws', async () => {
    const { orderId } = await seedAndIngest()
    vi.mocked(enqueueInventoryPush).mockRejectedValue(new Error('inventory enqueue down'))

    await cancelChannelOrder(orderId).catch(() => {})

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('cancelled')
    const job = await prisma.channelJob.findUnique({ where: { dedupeKey: `cancel:${orderId}` } })
    expect(job).toMatchObject({ type: 'walmart_cancel_order', status: 'pending' })
  })

  it('cancel: if the job insert fails, the status change and the reservation release roll back', async () => {
    const { orderId, variantId } = await seedAndIngest()
    failEnqueueOf('walmart_cancel_order')

    await expect(cancelChannelOrder(orderId)).rejects.toThrow()

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('paid')
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { variantId } })
    expect(inv).toMatchObject({ onHand: 10, reserved: 2 })
    expect(await prisma.auditLog.count({ where: { action: 'order.cancelled' } })).toBe(0)
    expect(await prisma.channelJob.count({ where: { type: 'walmart_cancel_order' } })).toBe(0)
  })
})
