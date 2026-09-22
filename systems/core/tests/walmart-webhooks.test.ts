import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { walmartOrderFixture } from './helpers/walmart-fixtures.js'
import { buildApp } from '../src/app.js'
import { pollWalmartOrders } from '../src/channels/walmart/pollers.js'
import type { WalmartClient } from '../src/channels/walmart/client.js'

// See tests/walmart-orders-ingest.test.ts for why this has to be recreated
// after every resetDb() -- the 'system' actor migration only runs once when
// the test DB is provisioned, not per test.
async function seedSystemActor() {
  await prisma.actor.create({ data: { id: 'system', type: 'human', name: 'system' } })
}

process.env.WALMART_WEBHOOK_SECRET = 'test-secret'

async function seedListing() {
  const p = await prisma.product.create({ data: { slug: 'castle', name: 'Castle', productType: 'own_designed', status: 'published' } })
  const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-SET-001', priceCents: 4999 } })
  await prisma.inventory.create({ data: { variantId: v.id, onHand: 10 } })
  await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-SET-001-W', status: 'live' } })
}

describe('walmart webhook endpoint', () => {
  beforeEach(async () => {
    await resetDb()
    await seedSystemActor()
    await seedListing()
  })
  afterAll(() => prisma.$disconnect())

  it('rejects a missing/wrong secret', async () => {
    const res = await request(buildApp())
      .post('/api/v1/channels/walmart/webhooks')
      .send({ eventType: 'ORDER_CREATED', payload: walmartOrderFixture })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
  })

  // WALMART_WEBHOOK_SECRET is set once at module load for the whole file
  // (see the top of this file), so every other test in here only exercises
  // "wrong secret", never "no secret configured at all". A misconfigured
  // deploy -- the env var genuinely unset -- is the case the fail-closed
  // guard matters most for, and until now it was only verified by reading
  // the code, not by a test. Restored in `finally` so an unset env var can't
  // leak into any other test in this worker (vitest.config.ts runs test
  // files sequentially -- fileParallelism: false -- but not test-run order
  // within a file, and other files in this same process read
  // process.env.WALMART_WEBHOOK_SECRET too).
  it('fails closed when WALMART_WEBHOOK_SECRET is unset, regardless of what header is sent', async () => {
    const saved = process.env.WALMART_WEBHOOK_SECRET
    try {
      delete process.env.WALMART_WEBHOOK_SECRET
      const res = await request(buildApp())
        .post('/api/v1/channels/walmart/webhooks')
        .set('x-webhook-secret', 'test-secret') // the value that would have matched
        .send({ eventType: 'ORDER_CREATED', payload: walmartOrderFixture })
      expect(res.status).toBe(401)
      expect(res.body).toEqual({ error: 'unauthorized' })
    } finally {
      process.env.WALMART_WEBHOOK_SECRET = saved
    }
  })

  // Walmart calls this endpoint with no session cookie and no Origin header
  // at all. It must not land behind requireAuth/requireOrigin/CORS the way
  // /api/v1/admin does -- asserting that with a bare supertest call (no
  // .set('Cookie', ...) anywhere) is the point of this test.
  it('is reachable without any session cookie', async () => {
    const res = await request(buildApp())
      .post('/api/v1/channels/walmart/webhooks')
      .set('x-webhook-secret', 'test-secret')
      .send({ eventType: 'ORDER_CREATED', payload: walmartOrderFixture })
    expect(res.status).toBe(200)
    expect(res.body.created).toBe(true)
  })

  it('ingests ORDER_CREATED and ignores unknown events', async () => {
    const app = buildApp()
    const ok = await request(app)
      .post('/api/v1/channels/walmart/webhooks')
      .set('x-webhook-secret', 'test-secret')
      .send({ eventType: 'ORDER_CREATED', payload: walmartOrderFixture })
    expect(ok.status).toBe(200)
    expect(ok.body.created).toBe(true)

    const other = await request(app)
      .post('/api/v1/channels/walmart/webhooks')
      .set('x-webhook-secret', 'test-secret')
      .send({ eventType: 'BUYBOX_CHANGED', payload: {} })
    expect(other.status).toBe(202)
    expect(other.body).toEqual({ ignored: true })

    const bad = await request(app)
      .post('/api/v1/channels/walmart/webhooks')
      .set('x-webhook-secret', 'test-secret')
      .send({ eventType: 'ORDER_CREATED', payload: {} })
    expect(bad.status).toBe(422)
    expect(bad.body).toEqual({ error: 'unmappable_order' })
  })

  // A re-delivery of the same order must resolve as a 200 success, not the
  // 422 ChannelError path -- ingestWalmartOrder resolves { created: false }
  // for this case rather than throwing (Task 5's error contract).
  it('treats a re-delivered order as a 200 success, not an error', async () => {
    const app = buildApp()
    const first = await request(app)
      .post('/api/v1/channels/walmart/webhooks')
      .set('x-webhook-secret', 'test-secret')
      .send({ eventType: 'ORDER_CREATED', payload: walmartOrderFixture })
    expect(first.status).toBe(200)
    expect(first.body.created).toBe(true)

    const redelivered = await request(app)
      .post('/api/v1/channels/walmart/webhooks')
      .set('x-webhook-secret', 'test-secret')
      .send({ eventType: 'ORDER_CREATED', payload: walmartOrderFixture })
    expect(redelivered.status).toBe(200)
    expect(redelivered.body).toEqual({ orderId: first.body.orderId, created: false })
    expect(await prisma.order.count()).toBe(1)
  })
})

describe('pollWalmartOrders', () => {
  beforeEach(async () => {
    await resetDb()
    await seedSystemActor()
    await seedListing()
  })
  afterAll(() => prisma.$disconnect())

  it('sweeps orders and is idempotent with prior webhook ingestion', async () => {
    const stub: WalmartClient = {
      request: async () => ({ list: { elements: { order: [walmartOrderFixture] } } }),
    }
    const first = await pollWalmartOrders(stub)
    expect(first).toEqual({ found: 1, created: 1, failed: 0 })
    const second = await pollWalmartOrders(stub)
    expect(second).toEqual({ found: 1, created: 0, failed: 0 })
    expect(await prisma.order.count()).toBe(1)
  })

  it('requests /v3/orders with a createdStartDate 7 days back', async () => {
    let seenPath = ''
    let seenQuery: Record<string, string> | undefined
    const stub: WalmartClient = {
      request: async (_method, path, opts) => {
        seenPath = path
        seenQuery = opts?.query
        return { list: { elements: { order: [] } } }
      },
    }
    const before = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    await pollWalmartOrders(stub)
    expect(seenPath).toBe('/v3/orders')
    expect(seenQuery?.createdStartDate).toBe(before)
  })

  // A ChannelError (e.g. unknown_sku, insufficient_stock) on one order must
  // not abort the sweep -- it's counted as a failure and the poller moves on
  // to the rest of the batch, logging via console.error rather than
  // throwing.
  it('counts a ChannelError as failed without throwing or aborting the sweep', async () => {
    const badOrder = { ...walmartOrderFixture, purchaseOrderId: 'PO-UNKNOWN', orderLines: { orderLine: [{ ...walmartOrderFixture.orderLines.orderLine[0], item: { sku: 'NOT-LISTED-W' } }] } }
    const stub: WalmartClient = {
      request: async () => ({ list: { elements: { order: [badOrder, walmartOrderFixture] } } }),
    }
    const result = await pollWalmartOrders(stub)
    expect(result).toEqual({ found: 2, created: 1, failed: 1 })
    expect(await prisma.order.count()).toBe(1)
  })

  it('treats an empty order list as zero found/created/failed', async () => {
    const stub: WalmartClient = {
      request: async () => ({ list: { elements: { order: [] } } }),
    }
    expect(await pollWalmartOrders(stub)).toEqual({ found: 0, created: 0, failed: 0 })
  })
})
