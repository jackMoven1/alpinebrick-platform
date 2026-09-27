import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { markOrderPaid } from '../src/orders/orders.service.js'
import { createRateLimiter } from '../src/lib/rate-limit.js'
import { unconfiguredPaymentsPort } from '../src/ports/payments/index.js'
import { makeApp, postCheckout, variantIdBySku, inventoryOf, setOnHand, STOREFRONT_URL } from './helpers/checkout.js'

const ORIGIN = 'https://staging.alpinebrickexchange.com'
beforeEach(async () => {
  await resetDb(); await seed()
  process.env.STOREFRONT_ORIGIN = ORIGIN
})
afterAll(async () => { delete process.env.STOREFRONT_ORIGIN; await prisma.$disconnect() })

describe('POST /api/v1/checkout', () => {
  it('reserves stock, creates a pending order and returns the client secret', async () => {
    const { app, payments } = makeApp()
    const v = await variantIdBySku('BBS-STD') // $49.99, onHand 25
    const res = await postCheckout(app, {
      lines: [{ variantId: v, quantity: 2 }], marketingOptIn: true,
      referral: { code: 'Brick-Club', firstSeenAt: new Date(Date.now() - 86_400_000).toISOString() },
    })
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ orderId: expect.any(String), clientSecret: expect.stringMatching(/_secret_/) })

    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } })
    expect(order).toMatchObject({
      status: 'pending', email: 'pending@checkout.invalid', shipToState: '', subtotalCents: 9998,
      taxJurisdiction: 'stripe_tax_pending', marketingOptIn: true, referralCode: 'brick-club',
    })
    expect(order.stripeCheckoutSessionId).toMatch(/^cs_test_fake_/)
    expect((await inventoryOf('BBS-STD')).reserved).toBe(2)

    const session = payments.sessions.get(order.stripeCheckoutSessionId!)!
    expect(session.input.lines).toEqual([{ name: 'Brick Builder Set', unitAmountCents: 4999, quantity: 2 }])
    expect(session.input.shippingOptions).toEqual([{ displayName: 'Standard shipping', amountCents: 995 }])
    expect(session.input.returnUrl).toBe(`${STOREFRONT_URL}/order/complete?session_id={CHECKOUT_SESSION_ID}`)
    expect(session.input.expiresAt.getTime() - Date.now()).toBeGreaterThan(30 * 60_000)
    expect(session.input.orderId).toBe(order.id)
  })

  it('offers free shipping at the threshold', async () => {
    const { app, payments } = makeApp()
    const res = await postCheckout(app, { lines: [{ variantId: await variantIdBySku('ABE-1001'), quantity: 1 }] }) // $189
    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } })
    expect(payments.sessions.get(order.stripeCheckoutSessionId!)!.input.shippingOptions)
      .toEqual([{ displayName: 'Free shipping', amountCents: 0 }])
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

  it('cancels the order and 503s when Stripe fails, releasing the hold', async () => {
    const { app, payments } = makeApp()
    payments.failNextCreate = true
    const res = await postCheckout(app, { lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: 2 }] })
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('checkout_unavailable')
    expect((await prisma.order.findFirstOrThrow()).status).toBe('cancelled')
    expect((await inventoryOf('BBS-STD')).reserved).toBe(0)
  })

  it('503s without touching stock when Stripe is not configured', async () => {
    const { app } = makeApp({ payments: unconfiguredPaymentsPort })
    const res = await postCheckout(app, { lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: 1 }] })
    expect(res.status).toBe(503)
    expect(await prisma.order.count()).toBe(0)
  })

  it('previousOrderId expires the old session and releases its hold first', async () => {
    const { app, payments } = makeApp()
    const v = await variantIdBySku('BBS-STD')
    const first = await postCheckout(app, { lines: [{ variantId: v, quantity: 3 }] })
    const second = await postCheckout(app, { lines: [{ variantId: v, quantity: 1 }], previousOrderId: first.body.orderId })
    expect(second.status).toBe(201)
    const old = await prisma.order.findUniqueOrThrow({ where: { id: first.body.orderId } })
    expect(old.status).toBe('cancelled')
    expect(payments.expired).toEqual([old.stripeCheckoutSessionId])
    expect((await inventoryOf('BBS-STD')).reserved).toBe(1)
  })

  it('ignores a previousOrderId that is already paid', async () => {
    const { app, payments } = makeApp()
    const v = await variantIdBySku('BBS-STD')
    const first = await postCheckout(app, { lines: [{ variantId: v, quantity: 1 }] })
    await markOrderPaid(first.body.orderId)
    await postCheckout(app, { lines: [{ variantId: v, quantity: 1 }], previousOrderId: first.body.orderId })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: first.body.orderId } })).status).toBe('paid')
    expect(payments.expired).toEqual([])
  })

  it('lets exactly one of two concurrent checkouts take the last unit', async () => {
    const { app } = makeApp()
    const v = await setOnHand('CMP-LTD', 1)
    const results = await Promise.all([1, 2].map(() => postCheckout(app, { lines: [{ variantId: v, quantity: 1 }] })))
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    expect((await inventoryOf('CMP-LTD')).reserved).toBe(1)
  })

  it('rate-limits per IP', async () => {
    const { app } = makeApp({ checkoutRateLimit: createRateLimiter({ limit: 2, windowMs: 60_000 }) })
    await postCheckout(app, { lines: [] })
    await postCheckout(app, { lines: [] })
    expect((await postCheckout(app, { lines: [] })).status).toBe(429)
  })

  it('answers the storefront preflight without credentials', async () => {
    const { app } = makeApp()
    const res = await request(app).options('/api/v1/checkout')
      .set('Origin', ORIGIN).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type')
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN)
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
  })
})

describe('GET /api/v1/checkout/status', () => {
  it('returns non-sensitive fields only', async () => {
    const { app } = makeApp()
    const created = await postCheckout(app, { lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: 1 }] })
    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.body.orderId } })
    const res = await request(app).get(`/api/v1/checkout/status?session_id=${order.stripeCheckoutSessionId}`)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toEqual({
      status: 'pending',
      orderNumber: expect.stringMatching(/^ABE-\d{6}$/),
      lines: [{ name: 'Brick Builder Set', sku: 'BBS-STD', quantity: 1, unitPriceCents: 4999, lineSubtotalCents: 4999 }],
      totals: { subtotalCents: 4999, shippingCents: 0, taxCents: 0, totalCents: 4999 },
    })
    expect(JSON.stringify(res.body)).not.toContain('@')
  })

  it('404s an unknown session and 400s a malformed one', async () => {
    const { app } = makeApp()
    expect((await request(app).get('/api/v1/checkout/status?session_id=cs_test_nope')).status).toBe(404)
    expect((await request(app).get('/api/v1/checkout/status?session_id=../../x')).status).toBe(400)
    expect((await request(app).get('/api/v1/checkout/status')).status).toBe(400)
  })
})

describe('GET /api/v1/checkout/config', () => {
  it('exposes the shipping settings the cart needs', async () => {
    const { app } = makeApp()
    const res = await request(app).get('/api/v1/checkout/config')
    expect(res.body).toEqual({ flatRateCents: 995, freeShippingThresholdCents: 15000 })
  })
})

describe('retired public order routes (spec §2)', () => {
  it('404s POST and GET /api/v1/orders', async () => {
    const { app } = makeApp()
    const v = await variantIdBySku('BBS-STD')
    expect((await request(app).post('/api/v1/orders').send({ email: 'a@b.c', shipToState: 'MI', lines: [{ variantId: v, quantity: 1 }] })).status).toBe(404)
    expect((await request(app).get('/api/v1/orders/anything')).status).toBe(404)
    expect(await prisma.order.count()).toBe(0)
  })
})
