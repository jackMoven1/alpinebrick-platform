import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

// Pass-through spy, so one test can make the completion write fail after a
// COMPLETED charge (ruling T4-R4). Every other test runs the real function.
vi.mock('../src/payments/complete-payment.js', async (importOriginal) => {
  const actual: any = await importOriginal()
  return { ...actual, applyCompletedPayment: vi.fn(actual.applyCompletedPayment) }
})
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { cancelOrder } from '../src/orders/orders.service.js'
import { unconfiguredPaymentsPort } from '../src/ports/payments/index.js'
import type { EmailPort } from '../src/ports/email/email.port.js'
import { applyCompletedPayment } from '../src/payments/complete-payment.js'
import { makeApp, readyToPay, postPay, postQuote, postCheckout, variantIdBySku, inventoryOf, paidOrder } from './helpers/checkout.js'

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(async () => {
  await resetDb(); await seed()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterAll(async () => { errorSpy.mockRestore(); await prisma.$disconnect() })

function setup() {
  const email: EmailPort = { orderPaid: vi.fn(async () => {}) }
  return { ...makeApp({ email }), email }
}
const order = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } })

describe('POST /api/v1/checkout/:orderId/pay', () => {
  it('charges the quoted total once and marks the order paid (§2 step 5.4)', async () => {
    const { app, payments, email } = setup()
    const r = await readyToPay(app, { extra: { marketingOptIn: true } })
    const res = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      status: 'paid',
      orderNumber: expect.stringMatching(/^ABE-\d{6}$/),
      lines: [{ name: 'Brick Builder Set', sku: 'BBS-STD', quantity: 2, unitPriceCents: 4999, lineSubtotalCents: 9998 }],
      totals: { subtotalCents: 9998, shippingCents: 995, taxCents: 600, totalCents: 11593 },
    })
    expect(payments.charges).toEqual([{
      sourceToken: 'tok_a', amountCents: 11593, idempotencyKey: `${r.orderId}:1:0`, referenceId: r.orderId,
      buyerEmail: 'buyer@example.com',
      shippingAddress: { name: 'Ann Buyer', line1: '1 Main St', line2: 'Apt 2', city: 'Traverse City', state: 'MI', postalCode: '49684' },
    }])
    expect(payments.charges[0].idempotencyKey.length).toBeLessThanOrEqual(45)
    expect(r.orderId.length).toBeLessThanOrEqual(40)

    const paid = await order(r.orderId)
    expect(paid).toMatchObject({ status: 'paid', squarePaymentId: payments.paymentFor(r.orderId).id, reviewReason: null, paymentAttemptCount: 0 })
    expect(paid.paidAt).toBeInstanceOf(Date)
    expect(paid.paymentAttemptAt).toBeInstanceOf(Date)
    expect(await inventoryOf('BBS-STD')).toMatchObject({ onHand: 25, reserved: 2 }) // paid keeps the hold
    const customer = await prisma.customer.findUniqueOrThrow({ where: { email: 'buyer@example.com' } })
    expect(paid.customerId).toBe(customer.id)
    expect(customer.marketingConsent).toBe(true)
    expect(email.orderPaid).toHaveBeenCalledWith({ orderId: r.orderId, orderNumber: expect.stringMatching(/^ABE-/), email: 'buyer@example.com' })
  })

  it('402s a decline with our copy, keeps the order pending, and a new card gets a new key', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    payments.nextOutcomes = ['declined']
    const declined = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(declined.status).toBe(402)
    expect(declined.body).toEqual({ code: 'payment_declined', message: 'Your card was declined — try another card.' })
    // Ruling T2-R2: a definite answer clears the in-flight stamp.
    expect(await order(r.orderId)).toMatchObject({ status: 'pending', paymentAttemptCount: 1, paymentAttemptAt: null })

    const retry = await postPay(app, r.orderId, { sourceToken: 'tok_b', quoteVersion: r.quoteVersion })
    expect(retry.body.status).toBe('paid')
    expect(payments.charges.map((c) => c.idempotencyKey)).toEqual([`${r.orderId}:1:0`, `${r.orderId}:1:1`])
  })

  it('503s a definite non-decline failure, clears the stamp, and the next attempt gets a new key (Q-P10, T2-R2)', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    payments.nextOutcomes = ['failed']
    const failed = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(failed.status).toBe(503)
    expect(failed.body.code).toBe('checkout_unavailable')
    // Carried item (storefront review S-F1 minor 1): a definite failure is
    // marked so the storefront never offers a Try again that can't succeed.
    expect(failed.body.details).toEqual({ outcome: 'failed' })
    expect(await order(r.orderId)).toMatchObject({ status: 'pending', paymentAttemptCount: 1, paymentAttemptAt: null })
    // Not in flight any more, so the shopper may re-quote.
    expect((await postQuote(app, r.orderId)).status).toBe(200)

    const retry = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion + 1 })
    expect(retry.body.status).toBe('paid')
    expect(payments.charges.map((c) => c.idempotencyKey)).toEqual([`${r.orderId}:1:0`, `${r.orderId}:2:1`])
  })

  it('409s quote_changed for a stale or missing quote, before any charge', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    await postQuote(app, r.orderId) // now version 2
    const stale = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: 1 })
    expect(stale.status).toBe(409)
    expect(stale.body.code).toBe('quote_changed')

    const unquoted = await postCheckout(app, { lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: 1 }] })
    expect((await postPay(app, unquoted.body.orderId, { sourceToken: 'tok_a', quoteVersion: 1 })).body.code).toBe('quote_changed')
    expect(payments.charges).toEqual([])
  })

  it('409s order_expired for an order the sweep or an admin cancelled, before any charge', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    await cancelOrder(r.orderId)
    const res = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('order_expired')
    expect(payments.charges).toEqual([])
  })

  it('answers a repeated pay for a paid order from the database, without charging again (plan decision 4)', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    const again = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(again.body.status).toBe('paid')
    expect(payments.charges).toHaveLength(1)
  })

  it('an unknown outcome is 503; retrying with the same token reuses the key and Square replays the charge', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    payments.nextOutcomes = ['lost']
    const first = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(first.status).toBe(503)
    expect(first.body.code).toBe('checkout_unavailable')
    // Unknown outcomes carry no marker -- unlike the definite-failure case above.
    expect(first.body.details).toBeUndefined()
    const pending = await order(r.orderId)
    expect(pending).toMatchObject({ status: 'pending', paymentAttemptCount: 0 })
    expect(pending.paymentAttemptAt).toBeInstanceOf(Date) // still in flight

    const retry = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(retry.body.status).toBe('paid')
    expect(payments.payments.size).toBe(1) // one charge at Square, not two
    expect(new Set(payments.charges.map((c) => c.idempotencyKey)).size).toBe(1)
  })

  it('a new token after an unknown outcome is 409 payment_pending, never a second charge (plan decision 3)', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    payments.nextOutcomes = ['lost']
    await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    const res = await postPay(app, r.orderId, { sourceToken: 'tok_b', quoteVersion: r.quoteVersion })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('payment_pending')
    expect(payments.payments.size).toBe(1)
    expect((await order(r.orderId)).status).toBe('pending') // the webhook settles it (Task 6)
  })

  it('503s when Square is unreachable and leaves the order pending with the attempt stamped', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    payments.nextOutcomes = ['unavailable']
    const res = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(res.status).toBe(503)
    const o = await order(r.orderId)
    expect(o.status).toBe('pending')
    expect(o.paymentAttemptAt).toBeInstanceOf(Date)
  })

  it('a non-final status answers processing, records the payment id and keeps the attempt stamped (T3-R1)', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    payments.nextOutcomes = ['processing']
    const res = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(res.body).toEqual({ status: 'processing' })
    const o = await order(r.orderId)
    expect(o).toMatchObject({ status: 'pending', squarePaymentId: payments.paymentFor(r.orderId).id, paymentAttemptCount: 0 })
    expect(o.paymentAttemptAt).toBeInstanceOf(Date)
  })

  it('still marks paid, but flags amount_mismatch, when the order total moved during the charge (plan decision 5)', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    payments.duringCharge = async () => { await prisma.order.update({ where: { id: r.orderId }, data: { totalCents: 1 } }) }
    await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(await order(r.orderId)).toMatchObject({ status: 'paid', reviewReason: 'amount_mismatch' })
  })

  it('resolves a seeded referral at payment and flags an unknown one', async () => {
    const { app } = setup()
    const partner = await prisma.affiliatePartner.create({ data: { name: 'Brick Club' } })
    await prisma.referralCode.create({ data: { code: 'club', partnerId: partner.id, commissionRateBps: 800 } })
    const seen = new Date(Date.now() - 3_600_000).toISOString()
    const cases = [
      ['club', { affiliatePartnerId: partner.id, commissionRateBps: 800, referralUnmatched: false }],
      ['nobody', { affiliatePartnerId: null, commissionRateBps: null, referralUnmatched: true }],
    ] as const
    for (const [code, expected] of cases) {
      const r = await readyToPay(app, { qty: 1, extra: { referral: { code, firstSeenAt: seen } } })
      await postPay(app, r.orderId, { sourceToken: `tok_${code}`, quoteVersion: r.quoteVersion })
      expect(await order(r.orderId)).toMatchObject(expected)
    }
  })

  it('429s too_many_attempts after 10 declines (plan decision 6)', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    await prisma.order.update({ where: { id: r.orderId }, data: { paymentAttemptCount: 10 } })
    const res = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(res.status).toBe(429)
    expect(res.body.code).toBe('too_many_attempts')
    expect(payments.charges).toEqual([])
  })

  it.each([
    ['no token', { quoteVersion: 1 }, 'sourceToken'],
    ['no quote version', { sourceToken: 't' }, 'quoteVersion'],
    ['quote version 0', { sourceToken: 't', quoteVersion: 0 }, 'quoteVersion'],
  ] as const)('400s %s', async (_n, body, field) => {
    const { app } = setup()
    const r = await readyToPay(app)
    const res = await postPay(app, r.orderId, body)
    expect(res.status).toBe(400)
    expect(res.body.details).toEqual({ field })
  })

  it('404s an unknown order and 503s when payments are not configured', async () => {
    const { app } = setup()
    expect((await postPay(app, 'no-such-order', { sourceToken: 't', quoteVersion: 1 })).status).toBe(404)
    const { app: bare } = makeApp({ payments: unconfiguredPaymentsPort })
    expect((await postPay(bare, 'no-such-order', { sourceToken: 't', quoteVersion: 1 })).status).toBe(503)
  })
})

describe('pay: carried rulings T4-R4 and T4-R5', () => {
  it('a paid order answers the paid replay for any quoteVersion, without charging (T4-R5)', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    // Another tab re-quotes and pays at v2; the first tab still holds v1.
    const v2 = await postQuote(app, r.orderId)
    expect(v2.body.quoteVersion).toBe(r.quoteVersion + 1)
    await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: v2.body.quoteVersion })
    const stale = await postPay(app, r.orderId, { sourceToken: 'tok_b', quoteVersion: r.quoteVersion })
    expect(stale.status).toBe(200)
    expect(stale.body.status).toBe('paid')
    expect(payments.charges).toHaveLength(1)
  })

  it('logs and records the payment id when the completion write fails after a COMPLETED charge, then rethrows (T4-R4a)', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    vi.mocked(applyCompletedPayment).mockRejectedValueOnce(new Error('db went away'))
    errorSpy.mockClear()
    const res = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(res.status).toBe(500)
    const p = payments.paymentFor(r.orderId)
    // The sweep never releases an order carrying a payment id (Q-P7), so the stock stays held for the webhook.
    const o = await order(r.orderId)
    expect(o).toMatchObject({ status: 'pending', squarePaymentId: p.id })
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).find((l) => l.includes(p.id))
    expect(logged).toContain(r.orderId)
    // The webhook (or a replay) then completes it with the real code.
    const again = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(again.body.status).toBe('paid')
    expect(payments.payments.size).toBe(1)
  })

  it.each(['FAILED', 'CANCELED'] as const)('a replayed processing payment that ended %s clears the payment id so the order can be re-quoted (T4-R4b)', async (status) => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    payments.nextOutcomes = ['processing']
    await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    const p = payments.paymentFor(r.orderId)
    payments.resolvePayment(p.id, status)
    const replay = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(replay.status).toBe(402)
    expect(await order(r.orderId)).toMatchObject({ status: 'pending', squarePaymentId: null, paymentAttemptAt: null, paymentAttemptCount: 1 })
    const requote = await postQuote(app, r.orderId)
    expect(requote.status).toBe(200)
    const paid = await postPay(app, r.orderId, { sourceToken: 'tok_b', quoteVersion: requote.body.quoteVersion })
    expect(paid.body.status).toBe('paid')
    expect(payments.charges.at(-1)!.idempotencyKey).toBe(`${r.orderId}:${requote.body.quoteVersion}:1`)
  })
})

describe('applyCompletedPayment: a second completed payment (ruling Q-P1)', () => {
  const email: EmailPort = { orderPaid: async () => {} }
  const apply = (orderId: string, paymentId: string, amountCents: number) =>
    prisma.$transaction((tx) => applyCompletedPayment(tx, orderId, { paymentId, amountCents }, { email }))

  it('flags duplicate_payment and logs the order and both payment ids', async () => {
    const { app } = setup()
    const paid = await paidOrder(app)
    const res = await apply(paid.id, 'sqpay_second', paid.totalCents)
    expect(res).toEqual({ outcome: 'not_applied', followUp: null })
    expect(await order(paid.id)).toMatchObject({ status: 'paid', squarePaymentId: paid.squarePaymentId, reviewReason: 'duplicate_payment' })
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).find((l) => l.includes('sqpay_second'))
    expect(logged).toContain(paid.id)
    expect(logged).toContain(paid.squarePaymentId!)
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.duplicate_payment', target: `order:${paid.id}` } })
    expect(audit.after).toMatchObject({ squarePaymentId: 'sqpay_second', existingSquarePaymentId: paid.squarePaymentId })
  })

  it('replaces a milder reason but keeps a more severe one, logging either way', async () => {
    const { app } = setup()
    const mild = await paidOrder(app, { qty: 1 })
    await prisma.order.update({ where: { id: mild.id }, data: { reviewReason: 'amount_mismatch' } })
    await apply(mild.id, 'sqpay_dup_1', mild.totalCents)
    expect((await order(mild.id)).reviewReason).toBe('duplicate_payment')

    const severe = await paidOrder(app, { qty: 1 })
    await prisma.order.update({ where: { id: severe.id }, data: { reviewReason: 'disputed' } })
    await apply(severe.id, 'sqpay_dup_2', severe.totalCents)
    expect((await order(severe.id)).reviewReason).toBe('disputed')
    expect(errorSpy.mock.calls.map((c) => c.join(' ')).some((l) => l.includes('sqpay_dup_2') && l.includes(severe.id))).toBe(true)
  })

  it('is a no-op for the same payment applied twice', async () => {
    const { app } = setup()
    const paid = await paidOrder(app)
    expect(await apply(paid.id, paid.squarePaymentId!, paid.totalCents)).toEqual({ outcome: 'already_paid', followUp: null })
    expect((await order(paid.id)).reviewReason).toBeNull()
  })

  it('a second payment on an order already paid-after-cancel keeps the first payment id', async () => {
    const { app } = setup()
    const r = await readyToPay(app)
    await cancelOrder(r.orderId)
    expect((await apply(r.orderId, 'sqpay_first', r.totalCents)).outcome).toBe('paid_after_cancel')
    expect((await apply(r.orderId, 'sqpay_again', r.totalCents)).outcome).toBe('not_applied')
    expect(await order(r.orderId)).toMatchObject({ status: 'cancelled', squarePaymentId: 'sqpay_first', reviewReason: 'paid_after_cancel' })
    expect(errorSpy.mock.calls.map((c) => c.join(' ')).some((l) => l.includes('sqpay_again') && l.includes('sqpay_first'))).toBe(true)
  })
})

// Ruling F-R2: a COMPLETED charge whose amount could not be read is never an amount_mismatch.
describe('pay: a completed charge with no usable amount', () => {
  it.each([null, 0])('amountCents %s: paid, no amount_mismatch, and logged', async (amountCents) => {
    const { app, payments } = setup()
    const r = await readyToPay(app, { qty: 1 })
    payments.charge = async () => ({ outcome: 'completed', paymentId: 'sq_noamt', amountCents })
    errorSpy.mockClear()
    const res = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(res.body.status).toBe('paid')
    expect(await order(r.orderId)).toMatchObject({ status: 'paid', squarePaymentId: 'sq_noamt', reviewReason: null })
    expect(errorSpy.mock.calls.map((c) => c.map(String).join(' ')).some((m) => m.includes('sq_noamt') && m.includes(r.orderId))).toBe(true)
  })
})
