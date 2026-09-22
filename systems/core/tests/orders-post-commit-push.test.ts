// Final fix wave B4: once placeOrder's transaction has committed, a failure
// to ENQUEUE the follow-up Walmart inventory push must not surface as a
// failure of the order -- the order exists and the stock is reserved, and an
// HTTP 500 invites the customer to retry and double-order. The push is
// recurring and recovers via the hourly reconcile; the failure is
// console.error'd instead.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'

const real = vi.hoisted(() => ({} as Record<string, any>))
vi.mock('../src/channels/walmart/inventory.sync.js', async (importOriginal) => {
  const actual: any = await importOriginal()
  real.enqueueInventoryPush = actual.enqueueInventoryPush
  return { ...actual, enqueueInventoryPush: vi.fn(actual.enqueueInventoryPush) }
})

import request from 'supertest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { buildApp } from '../src/app.js'
import { placeOrder } from '../src/orders/orders.service.js'
import { enqueueInventoryPush } from '../src/channels/walmart/inventory.sync.js'

const app = buildApp()

describe('post-commit inventory push failure never fails a committed order (B4)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  beforeEach(async () => {
    await resetDb()
    await seed()
    vi.mocked(enqueueInventoryPush).mockRejectedValue(new Error('inventory enqueue down'))
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.mocked(enqueueInventoryPush).mockImplementation(real.enqueueInventoryPush)
    errorSpy.mockRestore()
  })
  afterAll(() => prisma.$disconnect())

  it('placeOrder resolves with the committed order and console.errors the push failure', async () => {
    const v = await prisma.variant.findFirstOrThrow({ where: { sku: 'BBS-STD' } })
    const order = await placeOrder({ email: 'b@example.com', shipToState: 'MI', lines: [{ variantId: v.id, quantity: 1 }] })
    expect(order.status).toBe('pending')
    expect(await prisma.order.count({ where: { id: order.id } })).toBe(1)
    expect(errorSpy).toHaveBeenCalled()
    expect(errorSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain('inventory enqueue down')
  })

  it('POST /api/v1/orders returns 201, not 500, when the post-commit push enqueue throws', async () => {
    const v = await prisma.variant.findFirstOrThrow({ where: { sku: 'BBS-STD' } })
    const res = await request(app).post('/api/v1/orders')
      .send({ email: 'b@example.com', shipToState: 'MI', lines: [{ variantId: v.id, quantity: 1 }] })
    expect(res.status).toBe(201)
    expect(await prisma.order.count()).toBe(1)
  })
})
