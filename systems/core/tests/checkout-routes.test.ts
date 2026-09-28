import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { markOrderPaid } from '../src/orders/orders.service.js'
import { createRateLimiter } from '../src/lib/rate-limit.js'
import { unconfiguredPaymentsPort } from '../src/ports/payments/index.js'
import { makeApp, postCheckout, postQuote, variantIdBySku, inventoryOf, setOnHand } from './helpers/checkout.js'

const ORIGIN = 'https://staging.alpinebrickexchange.com'
beforeEach(async () => {
  await resetDb(); await seed()
  process.env.STOREFRONT_ORIGIN = ORIGIN
})
afterAll(async () => { delete process.env.STOREFRONT_ORIGIN; await prisma.$disconnect() })

describe('POST /api/v1/checkout', () => {
  it('reserves stock and returns only the order id (no provider session)', async () => {
    const { app, payments } = makeApp()
    const v = await variantIdBySku('BBS-STD') // $49.99, onHand 25
    const res = await postCheckout(app, {
      lines: [{ variantId: v, quantity: 2 }], marketingOptIn: true,
      referral: { code: 'Brick-Club', firstSeenAt: new Date(Date.now() - 86_400_000).toISOString() },
    })
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ orderId: expect.any(String) })
    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } })
    expect(order).toMatchObject({
      status: 'pending', email: 'pending@checkout.invalid', shipToState: '', subtotalCents: 9998,
      taxCents: 0, totalCents: 9998, taxJurisdiction: 'quote_pending', quoteVersion: 0,
      marketingOptIn: true, referralCode: 'brick-club', squarePaymentId: null, paymentAttemptAt: null,
    })
    expect((await inventoryOf('BBS-STD')).reserved).toBe(2)
    expect(payments.charges).toEqual([])
  })

  it.each([
    ['no lines', { lines: [] }],
    ['21 lines', { lines: Array.from({ length: 21 }, (_, i) => ({ variantId: `v${i}`, quantity: 1 })) }],
    ['quantity 11', { lines: [{ variantId: 'x', quantity: 11 }] }],
    ['quantity 0', { lines: [{ variantId: 'x', quantity: 0 }] }],
    ['fractional quantity', { lines: [{ variantId: 'x', quantity: 1.5 }] }],
    ['duplicate variants', { lines: [{ variantId: 'x', quantity: 1 }, { variantId: 'x', quantity: 2 }] }],
    ['non-boolean opt-in', { lines: [{ variantId: 'x', quantity: 1 }], marketingOptIn: 'yes' }],
  ])('rejects %s with 400 invalid_request and reserves nothing', async (_name, body) => {
    const { app } = makeApp()
    const res = await postCheckout(app, body)
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_request')
    expect(await prisma.order.count()).toBe(0)
  })

  it('drops an invalid referral instead of rejecting the checkout', async () => {
    const { app } = makeApp()
    const res = await postCheckout(app, {
      lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: 1 }],
      referral: { code: 'not valid!', firstSeenAt: new Date().toISOString() },
    })
    expect(res.status).toBe(201)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } })).referralCode).toBeNull()
  })

  it('409s insufficient_stock naming every short line and how many are left', async () => {
    const { app } = makeApp()
    const a = await setOnHand('CMP-LTD', 2)
    const b = await variantIdBySku('BBS-STD')
    const res = await postCheckout(app, { lines: [{ variantId: a, quantity: 3 }, { variantId: b, quantity: 1 }, { variantId: 'gone', quantity: 1 }] })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('insufficient_stock')
    expect(res.body.details.lines).toEqual([
      { variantId: a, code: 'insufficient_stock', available: 2 },
      { variantId: 'gone', code: 'variant_not_found' },
    ])
    expect(await prisma.order.count()).toBe(0)
  })

  it('503s without touching stock when payments are not configured', async () => {
    const { app } = makeApp({ payments: unconfiguredPaymentsPort })
    const res = await postCheckout(app, { lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: 1 }] })
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('checkout_unavailable')
    expect(await prisma.order.count()).toBe(0)
  })

  it('previousOrderId cancels our own pending order and releases its hold first', async () => {
    const { app } = makeApp()
    const v = await variantIdBySku('BBS-STD')
    const first = await postCheckout(app, { lines: [{ variantId: v, quantity: 3 }] })
    const second = await postCheckout(app, { lines: [{ variantId: v, quantity: 1 }], previousOrderId: first.body.orderId })
    expect(second.status).toBe(201)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: first.body.orderId } })).status).toBe('cancelled')
    expect((await inventoryOf('BBS-STD')).reserved).toBe(1)
  })

  it('ignores a previousOrderId that is already paid', async () => {
    const { app } = makeApp()
    const v = await variantIdBySku('BBS-STD')
    const first = await postCheckout(app, { lines: [{ variantId: v, quantity: 1 }] })
    await markOrderPaid(first.body.orderId)
    await postCheckout(app, { lines: [{ variantId: v, quantity: 1 }], previousOrderId: first.body.orderId })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: first.body.orderId } })).status).toBe('paid')
  })

  // Plan decision 7: another tab may be charging this order right now.
  it('leaves a previousOrderId alone while a payment attempt is in flight', async () => {
    const { app } = makeApp()
    const v = await variantIdBySku('BBS-STD')
    const first = await postCheckout(app, { lines: [{ variantId: v, quantity: 1 }] })
    await prisma.order.update({ where: { id: first.body.orderId }, data: { paymentAttemptAt: new Date() } })
    await postCheckout(app, { lines: [{ variantId: v, quantity: 1 }], previousOrderId: first.body.orderId })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: first.body.orderId } })).status).toBe('pending')
    expect((await inventoryOf('BBS-STD')).reserved).toBe(2)
  })

  it('lets exactly one of two concurrent checkouts take the last unit', async () => {
    const { app } = makeApp()
    const v = await setOnHand('CMP-LTD', 1)
    const results = await Promise.all([1, 2].map(() => postCheckout(app, { lines: [{ variantId: v, quantity: 1 }] })))
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    expect((await inventoryOf('CMP-LTD')).reserved).toBe(1)
  })

  it('rate-limits per IP, counting quotes against the same budget', async () => {
    const { app } = makeApp({ checkoutRateLimit: createRateLimiter({ limit: 2, windowMs: 60_000 }) })
    await postCheckout(app, { lines: [] })
    await postQuote(app, 'some-order', {})
    expect((await postCheckout(app, { lines: [] })).status).toBe(429)
  })

  it('400s malformed JSON as invalid_request, with CORS headers, and reserves nothing', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/v1/checkout')
      .set('Origin', ORIGIN).set('Content-Type', 'application/json').send('{"lines": [')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ code: 'invalid_request', message: expect.any(String) })
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN)
    expect(await prisma.order.count()).toBe(0)
  })

  it('leaves the admin error shape for malformed JSON unchanged', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/v1/admin/orders/x/cancel').set('Content-Type', 'application/json').send('{')
    expect(res.body.code).not.toBe('invalid_request')
  })

  it('answers the storefront preflight for the quote route without credentials', async () => {
    const { app } = makeApp()
    const res = await request(app).options('/api/v1/checkout/abc/quote')
      .set('Origin', ORIGIN).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type')
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN)
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
  })
})

describe('GET /api/v1/checkout/status', () => {
  it('reads by order id and returns non-sensitive fields only, even after the address is quoted', async () => {
    const { app } = makeApp()
    const created = await postCheckout(app, { lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: 1 }] })
    await postQuote(app, created.body.orderId)
    const res = await request(app).get(`/api/v1/checkout/status?orderId=${created.body.orderId}`)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toEqual({
      status: 'pending',
      orderNumber: expect.stringMatching(/^ABE-\d{6}$/),
      lines: [{ name: 'Brick Builder Set', sku: 'BBS-STD', quantity: 1, unitPriceCents: 4999, lineSubtotalCents: 4999 }],
      totals: { subtotalCents: 4999, shippingCents: 995, taxCents: 300, totalCents: 6294 },
    })
    const text = JSON.stringify(res.body)
    expect(text).not.toContain('@')
    expect(text).not.toContain('Main St')
  })

  it('404s an unknown order and 400s a malformed or missing id', async () => {
    const { app } = makeApp()
    expect((await request(app).get('/api/v1/checkout/status?orderId=nope')).status).toBe(404)
    expect((await request(app).get('/api/v1/checkout/status?orderId=../../x')).status).toBe(400)
    expect((await request(app).get('/api/v1/checkout/status')).status).toBe(400)
  })
})

describe('GET /api/v1/checkout/config', () => {
  it('exposes the shipping settings the cart needs', async () => {
    const { app } = makeApp()
    expect((await request(app).get('/api/v1/checkout/config')).body).toEqual({ flatRateCents: 995, freeShippingThresholdCents: 15000 })
  })
})

describe('retired public order routes', () => {
  it('404s POST and GET /api/v1/orders', async () => {
    const { app } = makeApp()
    const v = await variantIdBySku('BBS-STD')
    expect((await request(app).post('/api/v1/orders').send({ email: 'a@b.c', shipToState: 'MI', lines: [{ variantId: v, quantity: 1 }] })).status).toBe(404)
    expect((await request(app).get('/api/v1/orders/anything')).status).toBe(404)
    expect(await prisma.order.count()).toBe(0)
  })
})
