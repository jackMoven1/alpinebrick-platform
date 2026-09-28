import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import type { Express } from 'express'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { cancelOrder } from '../src/orders/orders.service.js'
import { unconfiguredPaymentsPort } from '../src/ports/payments/index.js'
import { CONTIGUOUS_STATES, OUTSIDE_SHIPPING_AREA } from '../src/checkout/checkout-input.js'
import { PAYMENT_ATTEMPT_GRACE_MS } from '../src/checkout/payment-attempt.js'
import { makeApp, postCheckout, postQuote, quoteBody, variantIdBySku } from './helpers/checkout.js'

beforeEach(async () => { await resetDb(); await seed() })
afterAll(() => prisma.$disconnect())

async function started(app: Express, sku = 'BBS-STD', quantity = 2): Promise<string> {
  const res = await postCheckout(app, { lines: [{ variantId: await variantIdBySku(sku), quantity }] })
  return res.body.orderId
}

describe('POST /api/v1/checkout/:orderId/quote', () => {
  it('quotes Michigan: $9.95 shipping and 6% tax on the goods only (Q3, Q8)', async () => {
    const { app } = makeApp()
    const id = await started(app) // 2 x $49.99 = $99.98
    const res = await postQuote(app, id)
    expect(res.status).toBe(200)
    // 9998 x 6% = 599.88 -> 600. Tax on goods + shipping would be 660.
    expect(res.body).toEqual({ quoteVersion: 1, subtotalCents: 9998, shippingCents: 995, taxCents: 600, totalCents: 11593 })
    expect(await prisma.order.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'pending', email: 'buyer@example.com', shipName: 'Ann Buyer', shipLine1: '1 Main St', shipLine2: 'Apt 2',
      shipCity: 'Traverse City', shipToState: 'MI', shipPostalCode: '49684',
      shippingCents: 995, taxCents: 600, taxRateBps: 600, taxJurisdiction: 'MI', totalCents: 11593, quoteVersion: 1,
    })
  })

  it('charges no tax outside Michigan', async () => {
    const { app } = makeApp()
    const id = await started(app)
    const res = await postQuote(app, id, quoteBody({ address: { state: 'CA', city: 'Fresno', postalCode: '93650' } }))
    expect(res.body).toMatchObject({ taxCents: 0, totalCents: 9998 + 995 })
    expect((await prisma.order.findUniqueOrThrow({ where: { id } })).taxJurisdiction).toBe('none')
  })

  it('gives free shipping at the threshold', async () => {
    const { app } = makeApp()
    const id = await started(app, 'ABE-1001', 1) // $189
    expect((await postQuote(app, id)).body).toEqual({ quoteVersion: 1, subtotalCents: 18900, shippingCents: 0, taxCents: 1134, totalCents: 20034 })
  })

  it('increments the quote version on every quote and keeps the latest address', async () => {
    const { app } = makeApp()
    const id = await started(app)
    await postQuote(app, id)
    const second = await postQuote(app, id, quoteBody({ address: { state: 'OH', city: 'Toledo', postalCode: '43604' } }))
    expect(second.body.quoteVersion).toBe(2)
    expect(await prisma.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ shipToState: 'OH', taxCents: 0, quoteVersion: 2 })
  })

  it('knows the 48 contiguous states plus DC', () => {
    expect(CONTIGUOUS_STATES.size).toBe(49)
    for (const s of ['AK', 'HI', 'PR']) expect(CONTIGUOUS_STATES.has(s)).toBe(false)
    expect(CONTIGUOUS_STATES.has('DC')).toBe(true)
  })

  it.each([...OUTSIDE_SHIPPING_AREA])('refuses %s with 422 outside_shipping_area before any charge, changing nothing', async (state) => {
    const { app, payments } = makeApp()
    const id = await started(app)
    const res = await postQuote(app, id, quoteBody({ address: { state } }))
    expect(res.status).toBe(422)
    expect(res.body).toMatchObject({ code: 'outside_shipping_area', message: 'We ship to the contiguous US only.' })
    expect(await prisma.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ quoteVersion: 0, shipLine1: null, email: 'pending@checkout.invalid' })
    expect(payments.charges).toEqual([])
  })

  it('refuses a non-US country with 422', async () => {
    const { app } = makeApp()
    const id = await started(app)
    const res = await postQuote(app, id, quoteBody({ address: { country: 'CA', state: 'ON' } }))
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('outside_shipping_area')
  })

  it.each([
    ['a bad email', { email: 'nope' }, 'email'],
    ['a missing name', { name: '' }, 'name'],
    ['a missing street', { address: { line1: '' } }, 'address.line1'],
    ['a blank city', { address: { city: ' ' } }, 'address.city'],
    ['an unknown state', { address: { state: 'ZZ' } }, 'address.state'],
    ['a bad ZIP', { address: { postalCode: '4968' } }, 'address.postalCode'],
  ] as const)('400s %s naming the field', async (_n, over, field) => {
    const { app } = makeApp()
    const id = await started(app)
    const res = await postQuote(app, id, quoteBody(over as Parameters<typeof quoteBody>[0]))
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'invalid_request', details: { field } })
  })

  it('409s order_expired for a cancelled order, 404s an unknown one, 400s a malformed id', async () => {
    const { app } = makeApp()
    const id = await started(app)
    await cancelOrder(id)
    expect((await postQuote(app, id)).body.code).toBe('order_expired')
    expect((await postQuote(app, 'no-such-order')).status).toBe(404)
    expect((await postQuote(app, 'bad id!')).status).toBe(400)
  })

  // Ruling Q-P1: a re-quote could change the total under a charge that is landing.
  it('409s payment_pending while a payment attempt is in flight, changing nothing', async () => {
    const { app } = makeApp()
    const id = await started(app)
    await postQuote(app, id)
    await prisma.order.update({ where: { id }, data: { paymentAttemptAt: new Date(Date.now() - 60_000) } })
    const res = await postQuote(app, id, quoteBody({ address: { state: 'OH', city: 'Toledo', postalCode: '43604' } }))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('payment_pending')
    expect(await prisma.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ shipToState: 'MI', taxCents: 600, quoteVersion: 1 })
  })

  // Ruling T3-R1: a Square payment exists (final or not), so the total must not change.
  it('409s payment_pending for a pending order that already has a Square payment id, even outside the grace window', async () => {
    const { app } = makeApp()
    const id = await started(app)
    await postQuote(app, id)
    await prisma.order.update({
      where: { id },
      data: { squarePaymentId: 'sqpay_processing', paymentAttemptAt: new Date(Date.now() - PAYMENT_ATTEMPT_GRACE_MS - 1000) },
    })
    const res = await postQuote(app, id, quoteBody({ address: { state: 'OH', city: 'Toledo', postalCode: '43604' } }))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('payment_pending')
    expect(await prisma.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ shipToState: 'MI', taxCents: 600, quoteVersion: 1 })
  })

  it('quotes again once the attempt is older than the grace window', async () => {
    const { app } = makeApp()
    const id = await started(app)
    await prisma.order.update({ where: { id }, data: { paymentAttemptAt: new Date(Date.now() - PAYMENT_ATTEMPT_GRACE_MS - 1000) } })
    const res = await postQuote(app, id)
    expect(res.status).toBe(200)
    expect(res.body.quoteVersion).toBe(1)
  })

  it('503s when payments are not configured', async () => {
    const { app } = makeApp({ payments: unconfiguredPaymentsPort })
    expect((await postQuote(app, 'anything')).status).toBe(503)
  })
})
