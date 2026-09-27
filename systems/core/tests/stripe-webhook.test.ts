import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

// Pass-through spy: the real enqueue runs, and the release paths can assert
// the post-commit Walmart pushes were requested for the released variants.
vi.mock('../src/channels/walmart/inventory.sync.js', async (importOriginal) => {
  const actual: any = await importOriginal()
  return { ...actual, enqueueInventoryPush: vi.fn(actual.enqueueInventoryPush) }
})
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { fulfillOrder } from '../src/orders/orders.service.js'
import { enqueueInventoryPush } from '../src/channels/walmart/inventory.sync.js'
import { unconfiguredPaymentsPort } from '../src/ports/payments/index.js'
import type { EmailPort } from '../src/ports/email/email.port.js'
import {
  makeApp, postCheckout, variantIdBySku, inventoryOf, stripeEvent, deliver, completedSession,
} from './helpers/checkout.js'

let errorSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>
beforeEach(async () => {
  await resetDb(); await seed()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.mocked(enqueueInventoryPush).mockClear()
})
afterAll(async () => { errorSpy.mockRestore(); warnSpy.mockRestore(); await prisma.$disconnect() })

/** A pending checkout for `qty` x BBS-STD ($49.99), through the real endpoint. */
async function pendingOrder(app: any, qty = 2, extra: Record<string, unknown> = {}) {
  const res = await postCheckout(app, { lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: qty }], ...extra })
  return prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } })
}

function setup() {
  const email: EmailPort = { orderPaid: vi.fn(async () => {}) }
  return { ...makeApp({ email }), email }
}

describe('POST /api/v1/webhooks/stripe', () => {
  it('rejects a bad signature with 400 and records nothing', async () => {
    const { app, payments } = setup()
    const res = await deliver(app, payments, stripeEvent('checkout.session.expired', {}), 't=1,v1=deadbeef')
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('bad_signature')
    expect(await prisma.stripeEvent.count()).toBe(0)
  })

  it('503s when Stripe is not configured', async () => {
    const { app } = makeApp({ payments: unconfiguredPaymentsPort })
    const { payments: signer } = makeApp() // only used to produce a well-formed signature
    expect((await deliver(app, signer, stripeEvent('checkout.session.expired', {}))).status).toBe(503)
  })

  it('checkout.session.completed marks the order paid with Stripe’s figures', async () => {
    const { app, payments, email } = setup()
    const order = await pendingOrder(app, 2, { marketingOptIn: true })
    const res = await deliver(app, payments, stripeEvent('checkout.session.completed', completedSession({
      orderId: order.id, sessionId: order.stripeCheckoutSessionId!, subtotal: 9998, shipping: 995, tax: 660,
    })))
    expect(res.status).toBe(200)
    expect(res.body.outcome).toBe('processed')

    const paid = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(paid).toMatchObject({
      status: 'paid', email: 'buyer@example.com', taxCents: 660, shippingCents: 995, totalCents: 11653,
      taxJurisdiction: 'stripe_tax', taxRateBps: 600, shipToState: 'MI', shipName: 'Ann Buyer',
      shipLine1: '1 Main St', shipLine2: 'Apt 2', shipCity: 'Traverse City', shipPostalCode: '49684',
      stripePaymentIntentId: `pi_test_${order.id}`, reviewReason: null,
    })
    expect(paid.paidAt).toBeInstanceOf(Date)
    expect((await inventoryOf('BBS-STD'))).toMatchObject({ onHand: 25, reserved: 2 }) // paid keeps the hold
    const customer = await prisma.customer.findUniqueOrThrow({ where: { email: 'buyer@example.com' } })
    expect(paid.customerId).toBe(customer.id)
    expect(customer.marketingConsent).toBe(true)
    expect(email.orderPaid).toHaveBeenCalledWith({ orderId: order.id, orderNumber: expect.stringMatching(/^ABE-/), email: 'buyer@example.com' })
  })

  it('treats a redelivered event as already processed', async () => {
    const { app, payments } = setup()
    const order = await pendingOrder(app)
    const evt = stripeEvent('checkout.session.completed', completedSession({ orderId: order.id, sessionId: order.stripeCheckoutSessionId!, subtotal: 9998 }))
    expect((await deliver(app, payments, evt)).body.outcome).toBe('processed')
    const again = await deliver(app, payments, evt)
    expect(again.status).toBe(200)
    expect(again.body.outcome).toBe('duplicate')
    expect(await prisma.auditLog.count({ where: { action: 'order.paid', target: `order:${order.id}` } })).toBe(1)
  })

  it('applies concurrent duplicate deliveries exactly once', async () => {
    const { app, payments } = setup()
    const order = await pendingOrder(app)
    const evt = stripeEvent('checkout.session.completed', completedSession({ orderId: order.id, sessionId: order.stripeCheckoutSessionId!, subtotal: 9998 }))
    const results = await Promise.all(Array.from({ length: 5 }, () => deliver(app, payments, evt)))
    expect(results.every((r) => r.status === 200)).toBe(true)
    expect(results.map((r) => r.body.outcome).sort()).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'processed'])
    expect(await prisma.auditLog.count({ where: { action: 'order.paid', target: `order:${order.id}` } })).toBe(1)
  })

  it('still marks paid, but flags amount_mismatch, when totals disagree', async () => {
    const { app, payments } = setup()
    const order = await pendingOrder(app)
    await deliver(app, payments, stripeEvent('checkout.session.completed', completedSession({
      orderId: order.id, sessionId: order.stripeCheckoutSessionId!, subtotal: 9998, total: 1,
    })))
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'paid', reviewReason: 'amount_mismatch', totalCents: 1 })
  })

  it('flags paid_after_cancel and leaves stock released', async () => {
    const { app, payments } = setup()
    const order = await pendingOrder(app)
    await deliver(app, payments, stripeEvent('checkout.session.expired', { id: order.stripeCheckoutSessionId, object: 'checkout.session', metadata: { orderId: order.id } }))
    await deliver(app, payments, stripeEvent('checkout.session.completed', completedSession({ orderId: order.id, sessionId: order.stripeCheckoutSessionId!, subtotal: 9998 })))
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(o).toMatchObject({ status: 'cancelled', reviewReason: 'paid_after_cancel', stripePaymentIntentId: `pi_test_${order.id}` })
    expect((await inventoryOf('BBS-STD')).reserved).toBe(0)
    // Ruling P16: money was taken, so the payer still becomes a Customer.
    const customer = await prisma.customer.findUniqueOrThrow({ where: { email: 'buyer@example.com' } })
    expect(o.customerId).toBe(customer.id)
  })

  it('flags amount_mismatch over outside_shipping_area when both apply, and logs both', async () => {
    const { app, payments } = setup()
    const order = await pendingOrder(app)
    await deliver(app, payments, stripeEvent('checkout.session.completed', completedSession({
      orderId: order.id, sessionId: order.stripeCheckoutSessionId!, subtotal: 9998, total: 1, state: 'HI',
    })))
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'paid', reviewReason: 'amount_mismatch', shipToState: 'HI' })
    const logged = errorSpy.mock.calls.map((c) => String(c[0]))
    expect(logged.some((m) => m.includes('amount mismatch'))).toBe(true)
    expect(logged.some((m) => m.includes('outside the contiguous US'))).toBe(true)
  })

  it.each(['AK', 'HI', 'PR', 'AE'])('flags a paid order shipping to %s as outside_shipping_area', async (state) => {
    const { app, payments } = setup()
    const order = await pendingOrder(app)
    await deliver(app, payments, stripeEvent('checkout.session.completed', completedSession({ orderId: order.id, sessionId: order.stripeCheckoutSessionId!, subtotal: 9998, state })))
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'paid', reviewReason: 'outside_shipping_area', shipToState: state })
  })

  it('resolves a seeded referral and flags an unknown one', async () => {
    const { app, payments } = setup()
    const partner = await prisma.affiliatePartner.create({ data: { name: 'Brick Club' } })
    await prisma.referralCode.create({ data: { code: 'club', partnerId: partner.id, commissionRateBps: 800 } })
    const seen = new Date(Date.now() - 3_600_000).toISOString()
    const matched = await pendingOrder(app, 1, { referral: { code: 'club', firstSeenAt: seen } })
    const unknown = await pendingOrder(app, 1, { referral: { code: 'nobody', firstSeenAt: seen } })
    for (const o of [matched, unknown]) {
      await deliver(app, payments, stripeEvent('checkout.session.completed', completedSession({ orderId: o.id, sessionId: o.stripeCheckoutSessionId!, subtotal: 4999 })))
    }
    expect(await prisma.order.findUniqueOrThrow({ where: { id: matched.id } })).toMatchObject({ affiliatePartnerId: partner.id, commissionRateBps: 800, referralUnmatched: false })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: unknown.id } })).toMatchObject({ affiliatePartnerId: null, commissionRateBps: null, referralUnmatched: true })
  })

  it('ignores an unpaid completed session', async () => {
    const { app, payments } = setup()
    const order = await pendingOrder(app)
    await deliver(app, payments, stripeEvent('checkout.session.completed', completedSession({ orderId: order.id, sessionId: order.stripeCheckoutSessionId!, subtotal: 9998, paymentStatus: 'unpaid' })))
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('pending')
  })

  it('checkout.session.expired cancels a pending order and ignores a paid one', async () => {
    const { app, payments } = setup()
    const a = await pendingOrder(app, 1)
    const b = await pendingOrder(app, 1)
    await deliver(app, payments, stripeEvent('checkout.session.completed', completedSession({ orderId: b.id, sessionId: b.stripeCheckoutSessionId!, subtotal: 4999 })))
    vi.mocked(enqueueInventoryPush).mockClear() // placeOrder enqueued too
    for (const o of [a, b]) {
      await deliver(app, payments, stripeEvent('checkout.session.expired', { id: o.stripeCheckoutSessionId, object: 'checkout.session', metadata: { orderId: o.id } }))
    }
    expect((await prisma.order.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('cancelled')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('paid')
    expect((await inventoryOf('BBS-STD')).reserved).toBe(1)
    // expired -> cancel released a hold, so a Walmart push follows the commit.
    expect(enqueueInventoryPush).toHaveBeenCalledWith(await variantIdBySku('BBS-STD'))
  })

  async function paidOrder(app: any, payments: any, qty = 2) {
    const o = await pendingOrder(app, qty)
    await deliver(app, payments, stripeEvent('checkout.session.completed', completedSession({ orderId: o.id, sessionId: o.stripeCheckoutSessionId!, subtotal: 4999 * qty })))
    return prisma.order.findUniqueOrThrow({ where: { id: o.id } })
  }
  const charge = (pi: string, amount: number, amountRefunded: number) => ({
    id: `ch_${pi}`, object: 'charge', payment_intent: pi, amount, amount_refunded: amountRefunded, refunded: amountRefunded >= amount,
  })

  it('full refund before shipment: refunded and the hold released', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app, payments)
    vi.mocked(enqueueInventoryPush).mockClear()
    await deliver(app, payments, stripeEvent('charge.refunded', charge(o.stripePaymentIntentId!, o.totalCents, o.totalCents)))
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ status: 'refunded', refundedCents: o.totalCents })
    expect(await inventoryOf('BBS-STD')).toMatchObject({ onHand: 25, reserved: 0 })
    expect(enqueueInventoryPush).toHaveBeenCalledWith(await variantIdBySku('BBS-STD'))
  })

  it('full refund after shipment: refunded, stock untouched', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app, payments)
    await fulfillOrder(o.id)
    await deliver(app, payments, stripeEvent('charge.refunded', charge(o.stripePaymentIntentId!, o.totalCents, o.totalCents)))
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('refunded')
    expect(await inventoryOf('BBS-STD')).toMatchObject({ onHand: 23, reserved: 0 })
  })

  it('partial refund: amount only', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app, payments)
    vi.mocked(enqueueInventoryPush).mockClear()
    await deliver(app, payments, stripeEvent('charge.refunded', charge(o.stripePaymentIntentId!, o.totalCents, 500)))
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ status: 'paid', refundedCents: 500 })
    expect((await inventoryOf('BBS-STD')).reserved).toBe(2)
    expect(enqueueInventoryPush).not.toHaveBeenCalled()
  })

  it('out of order: a refund before the completed event is retried, then applies', async () => {
    const { app, payments } = setup()
    const o = await pendingOrder(app, 1)
    const pi = `pi_test_${o.id}`
    const refundEvt = stripeEvent('charge.refunded', charge(pi, 5994, 5994))
    const early = await deliver(app, payments, refundEvt)
    expect(early.status).toBe(503)
    expect(await prisma.stripeEvent.count({ where: { id: refundEvt.id } })).toBe(0)

    await deliver(app, payments, stripeEvent('checkout.session.completed', completedSession({ orderId: o.id, sessionId: o.stripeCheckoutSessionId!, subtotal: 4999, paymentIntent: pi })))
    const retried = await deliver(app, payments, refundEvt)
    expect(retried.body.outcome).toBe('processed')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('refunded')
  })

  // Ruling P15: an unmatched refund/dispute is retried only while it is young
  // enough to be an out-of-order delivery; an old one is logged and acknowledged.
  const aged = (evt: ReturnType<typeof stripeEvent>, seconds: number) => ({ ...evt, created: Math.floor(Date.now() / 1000) - seconds })
  const DAY = 24 * 60 * 60

  it.each([
    ['charge.refunded', charge('pi_unrelated', 1000, 1000)],
    ['charge.dispute.created', { id: 'dp_orphan', object: 'dispute', charge: 'ch_x', payment_intent: 'pi_unrelated' }],
  ] as const)('%s with no matching order: 503 just under 24h old, 200 + logged just over', async (type, object) => {
    const { app, payments } = setup()
    const young = aged(stripeEvent(type, object), DAY - 60)
    const res = await deliver(app, payments, young)
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('retry_later')

    errorSpy.mockClear()
    const old = aged(stripeEvent(type, object), DAY + 60)
    const res2 = await deliver(app, payments, old)
    expect(res2.status).toBe(200)
    expect(res2.body.outcome).toBe('ignored')
    expect(errorSpy).toHaveBeenCalled()
    expect(String(errorSpy.mock.calls[0][0])).toContain(old.id)
    expect(await prisma.stripeEvent.count()).toBe(0)
  })

  it('a paid-after-cancel order carries Stripe’s figures, so refunding Stripe’s total applies', async () => {
    const { app, payments } = setup()
    const order = await pendingOrder(app)
    await deliver(app, payments, stripeEvent('checkout.session.expired', { id: order.stripeCheckoutSessionId, object: 'checkout.session', metadata: { orderId: order.id } }))
    await deliver(app, payments, stripeEvent('checkout.session.completed', completedSession({
      orderId: order.id, sessionId: order.stripeCheckoutSessionId!, subtotal: 9998, shipping: 995, tax: 660,
    })))
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      status: 'cancelled', reviewReason: 'paid_after_cancel',
      taxCents: 660, shippingCents: 995, totalCents: 11653, taxJurisdiction: 'stripe_tax', taxRateBps: 600,
    })
    const res = await deliver(app, payments, stripeEvent('charge.refunded', charge(`pi_test_${order.id}`, 11653, 11653)))
    expect(res.status).toBe(200)
    expect(res.body.outcome).toBe('processed')
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'refunded', refundedCents: 11653 })
    expect((await inventoryOf('BBS-STD')).reserved).toBe(0)
  })

  it('a refund the order rules refuse (amount over the total) is acknowledged, logged and not recorded', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app, payments, 1)
    errorSpy.mockClear()
    const evt = stripeEvent('charge.refunded', charge(o.stripePaymentIntentId!, o.totalCents + 100, o.totalCents + 100))
    const res = await deliver(app, payments, evt)
    expect(res.status).toBe(200)
    expect(res.body.outcome).toBe('ignored')
    expect(errorSpy).toHaveBeenCalled()
    const msg = String(errorSpy.mock.calls[0][0])
    expect(msg).toContain(evt.id)
    expect(msg).toContain('invalid_refund')
    expect(await prisma.stripeEvent.count({ where: { id: evt.id } })).toBe(0)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ status: 'paid', refundedCents: 0 })
  })

  it('charge.dispute.created flags the order for review', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app, payments, 1)
    await deliver(app, payments, stripeEvent('charge.dispute.created', { id: 'dp_1', object: 'dispute', charge: 'ch_1', payment_intent: o.stripePaymentIntentId }))
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).reviewReason).toBe('disputed')
    expect(errorSpy).toHaveBeenCalled()
  })

  it('acknowledges event types it does not handle without recording them', async () => {
    const { app, payments } = setup()
    const res = await deliver(app, payments, stripeEvent('customer.created', { id: 'cus_1' }))
    expect(res.status).toBe(200)
    expect(res.body.outcome).toBe('ignored')
    expect(await prisma.stripeEvent.count()).toBe(0)
  })
})
