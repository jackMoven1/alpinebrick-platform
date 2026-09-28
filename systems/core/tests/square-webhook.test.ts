import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

// Pass-through spy: the real enqueue runs, and the release paths can assert
// the post-commit Walmart pushes were requested for the released variants.
vi.mock('../src/channels/walmart/inventory.sync.js', async (importOriginal) => {
  const actual: any = await importOriginal()
  return { ...actual, enqueueInventoryPush: vi.fn(actual.enqueueInventoryPush) }
})
import request from 'supertest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { cancelOrder, fulfillOrder } from '../src/orders/orders.service.js'
import { enqueueInventoryPush } from '../src/channels/walmart/inventory.sync.js'
import { unconfiguredPaymentsPort } from '../src/ports/payments/index.js'
import { FAKE_NOTIFICATION_URL } from '../src/ports/payments/fake.adapter.js'
import type { EmailPort } from '../src/ports/email/email.port.js'
import { createSquareWebhookHandler } from '../src/payments/square-webhook.routes.js'
import {
  makeApp, readyToPay, postPay, postQuote, paidOrder, inventoryOf, variantIdBySku,
  squareEvent, deliver, sqPayment, sqRefund, sqDispute,
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

function setup() {
  const email: EmailPort = { orderPaid: vi.fn(async () => {}) }
  return { ...makeApp({ email }), email }
}
const order = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } })
const DAY_MS = 24 * 60 * 60 * 1000

describe('POST /api/v1/webhooks/square — transport', () => {
  it('rejects a bad signature with 400 and records nothing', async () => {
    const { app, payments } = setup()
    const res = await deliver(app, payments, squareEvent('payment.updated', sqPayment({ id: 'p', amount: 1 })), 'bm90IGEgc2lnbmF0dXJl')
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('bad_signature')
    expect(await prisma.paymentEvent.count()).toBe(0)
  })

  it('rejects a signature computed over any URL but the configured one (§3)', async () => {
    const { app, payments } = setup()
    const evt = squareEvent('payment.updated', sqPayment({ id: 'p', amount: 1 }))
    const res = await deliver(app, payments, evt, payments.sign(JSON.stringify(evt), `${FAKE_NOTIFICATION_URL}?x=1`))
    expect(res.status).toBe(400)
  })

  it('400s a missing signature header and a signed non-JSON body', async () => {
    const { app, payments } = setup()
    expect((await request(app).post('/api/v1/webhooks/square').set('Content-Type', 'application/json').send('{}')).status).toBe(400)
    const junk = 'not json'
    const res = await request(app).post('/api/v1/webhooks/square').set('Content-Type', 'application/json')
      .set('x-square-hmacsha256-signature', payments.sign(junk)).send(junk)
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('bad_payload')
  })

  it('503s when payments are not configured', async () => {
    const { app } = makeApp({ payments: unconfiguredPaymentsPort })
    const { payments: signer } = setup()
    expect((await deliver(app, signer, squareEvent('payment.updated', sqPayment({ id: 'p', amount: 1 })))).status).toBe(503)
  })

  it('acknowledges event types it does not handle without recording them', async () => {
    const { app, payments } = setup()
    const res = await deliver(app, payments, squareEvent('inventory.count.updated', { id: 'x' }))
    expect(res.body).toEqual({ received: true, outcome: 'ignored' })
    expect(await prisma.paymentEvent.count()).toBe(0)
  })

  // Plan decision 2: event readers' POS payments share the subscription.
  it('ignores events for another Square location without recording them', async () => {
    const { app, payments } = setup()
    const res = await deliver(app, payments, squareEvent('payment.updated', sqPayment({ id: 'pos_1', amount: 500, locationId: 'LEVENTS' })))
    expect(res.status).toBe(200)
    expect(res.body.outcome).toBe('ignored')
    expect(await prisma.paymentEvent.count()).toBe(0)
  })
})

describe('payment.updated', () => {
  it('marks a pending order paid after a crash between the charge and our write (§5)', async () => {
    const { app, payments, email } = setup()
    const r = await readyToPay(app)
    payments.nextOutcomes = ['lost']
    await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    const p = payments.paymentFor(r.orderId)
    const res = await deliver(app, payments, squareEvent('payment.updated', sqPayment({ id: p.id, orderId: r.orderId, amount: p.amountCents })))
    expect(res.body.outcome).toBe('processed')
    expect(await order(r.orderId)).toMatchObject({ status: 'paid', squarePaymentId: p.id, reviewReason: null })
    expect(email.orderPaid).toHaveBeenCalledTimes(1)
    expect(await prisma.customer.count({ where: { email: 'buyer@example.com' } })).toBe(1)
  })

  it('is a no-op for an order the pay route already marked paid', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app)
    await deliver(app, payments, squareEvent('payment.updated', sqPayment({ id: o.squarePaymentId!, orderId: o.id, amount: o.totalCents })))
    expect(await prisma.auditLog.count({ where: { action: 'order.paid', target: `order:${o.id}` } })).toBe(1)
  })

  it('treats a redelivered event as a duplicate and applies concurrent deliveries exactly once', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    payments.nextOutcomes = ['lost']
    await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    const p = payments.paymentFor(r.orderId)
    const evt = squareEvent('payment.updated', sqPayment({ id: p.id, orderId: r.orderId, amount: p.amountCents }))
    const results = await Promise.all(Array.from({ length: 5 }, () => deliver(app, payments, evt)))
    expect(results.every((x) => x.status === 200)).toBe(true)
    expect(results.map((x) => x.body.outcome).sort()).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'processed'])
    expect(await prisma.auditLog.count({ where: { action: 'order.paid', target: `order:${r.orderId}` } })).toBe(1)
  })

  it('ignores non-final statuses (the event is recorded, the order unchanged)', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    for (const status of ['APPROVED', 'FAILED', 'CANCELED']) {
      const res = await deliver(app, payments, squareEvent('payment.updated', sqPayment({ id: `p_${status}`, orderId: r.orderId, amount: 1, status })))
      expect(res.body.outcome).toBe('processed')
    }
    expect((await order(r.orderId)).status).toBe('pending')
  })

  it('flags paid_after_cancel on a cancelled order and keeps its stock released', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    await cancelOrder(r.orderId)
    await deliver(app, payments, squareEvent('payment.updated', sqPayment({ id: 'sq_late', orderId: r.orderId, amount: r.totalCents })))
    const o = await order(r.orderId)
    expect(o).toMatchObject({ status: 'cancelled', reviewReason: 'paid_after_cancel', squarePaymentId: 'sq_late' })
    expect(o.customerId).not.toBeNull()
    expect((await inventoryOf('BBS-STD')).reserved).toBe(0)
  })

  it('flags amount_mismatch when Square’s amount differs from the order total', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    await deliver(app, payments, squareEvent('payment.updated', sqPayment({ id: 'sq_x', orderId: r.orderId, amount: r.totalCents - 1 })))
    expect(await order(r.orderId)).toMatchObject({ status: 'paid', reviewReason: 'amount_mismatch' })
  })

  it('records but does not apply a second completed payment for a paid order', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app)
    await deliver(app, payments, squareEvent('payment.updated', sqPayment({ id: 'sq_second', orderId: o.id, amount: o.totalCents })))
    expect(await order(o.id)).toMatchObject({ status: 'paid', squarePaymentId: o.squarePaymentId })
    expect(await prisma.auditLog.count({ where: { action: 'order.duplicate_payment', target: `order:${o.id}` } })).toBe(1)
  })

  it('ignores a payment with no reference id (not a storefront payment)', async () => {
    const { app, payments } = setup()
    const res = await deliver(app, payments, squareEvent('payment.updated', sqPayment({ id: 'sq_noref', amount: 100 })))
    expect(res.body.outcome).toBe('processed')
  })
})

describe('refund.created / refund.updated', () => {
  it('a full refund before shipment: refunded, hold released, Walmart push requested', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app)
    payments.addRefund(o.squarePaymentId!, { id: 'r1', status: 'COMPLETED', amountCents: o.totalCents })
    vi.mocked(enqueueInventoryPush).mockClear()
    await deliver(app, payments, squareEvent('refund.updated', sqRefund({ id: 'r1', paymentId: o.squarePaymentId!, amount: o.totalCents })))
    expect(await order(o.id)).toMatchObject({ status: 'refunded', refundedCents: o.totalCents })
    expect(await inventoryOf('BBS-STD')).toMatchObject({ onHand: 25, reserved: 0 })
    expect(enqueueInventoryPush).toHaveBeenCalledWith(await variantIdBySku('BBS-STD'))
  })

  it('a full refund after shipment leaves stock alone', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app)
    await fulfillOrder(o.id)
    payments.addRefund(o.squarePaymentId!, { id: 'r1', status: 'COMPLETED', amountCents: o.totalCents })
    await deliver(app, payments, squareEvent('refund.updated', sqRefund({ id: 'r1', paymentId: o.squarePaymentId!, amount: o.totalCents })))
    expect((await order(o.id)).status).toBe('refunded')
    expect(await inventoryOf('BBS-STD')).toMatchObject({ onHand: 23, reserved: 0 })
  })

  it('sums the payment’s COMPLETED refunds from Square, ignoring pending ones', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app)
    payments.addRefund(o.squarePaymentId!, { id: 'r1', status: 'COMPLETED', amountCents: 500 })
    payments.addRefund(o.squarePaymentId!, { id: 'r2', status: 'PENDING', amountCents: 700 })
    await deliver(app, payments, squareEvent('refund.created', sqRefund({ id: 'r2', paymentId: o.squarePaymentId!, amount: 700, status: 'PENDING' })))
    expect(await order(o.id)).toMatchObject({ status: 'paid', refundedCents: 500 })
    payments.addRefund(o.squarePaymentId!, { id: 'r2', status: 'COMPLETED', amountCents: 700 })
    await deliver(app, payments, squareEvent('refund.updated', sqRefund({ id: 'r2', paymentId: o.squarePaymentId!, amount: 700 })))
    expect(await order(o.id)).toMatchObject({ status: 'paid', refundedCents: 1200 })
    expect((await inventoryOf('BBS-STD')).reserved).toBe(2)
  })

  it('never lowers the refunded amount when Square’s list lags (monotonic)', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app)
    await prisma.order.update({ where: { id: o.id }, data: { refundedCents: 1200 } })
    payments.addRefund(o.squarePaymentId!, { id: 'r1', status: 'COMPLETED', amountCents: 500 })
    await deliver(app, payments, squareEvent('refund.updated', sqRefund({ id: 'r1', paymentId: o.squarePaymentId!, amount: 500 })))
    expect((await order(o.id)).refundedCents).toBe(1200)
  })

  it('a refund the order rules refuse (over the total) is acknowledged, logged and not recorded (T7-R1)', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app, { qty: 1 })
    payments.addRefund(o.squarePaymentId!, { id: 'r1', status: 'COMPLETED', amountCents: o.totalCents + 100 })
    errorSpy.mockClear()
    const evt = squareEvent('refund.updated', sqRefund({ id: 'r1', paymentId: o.squarePaymentId!, amount: o.totalCents + 100 }))
    const res = await deliver(app, payments, evt)
    expect(res.body.outcome).toBe('ignored')
    expect(String(errorSpy.mock.calls[0][0])).toContain(evt.event_id)
    expect(String(errorSpy.mock.calls[0][0])).toContain('invalid_refund')
    expect(await prisma.paymentEvent.count({ where: { eventId: evt.event_id } })).toBe(0)
  })
})

describe('dispute.created / dispute.state.updated', () => {
  it('dispute.created flags the order for review and keeps the prior reason in the audit', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app, { qty: 1 })
    await prisma.order.update({ where: { id: o.id }, data: { reviewReason: 'amount_mismatch' } })
    await deliver(app, payments, squareEvent('dispute.created', sqDispute({ id: 'dp_1', paymentId: o.squarePaymentId! })))
    expect((await order(o.id)).reviewReason).toBe('disputed')
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.disputed', target: `order:${o.id}` } })
    expect(audit.before).toEqual({ reviewReason: 'amount_mismatch' })
    expect(audit.after).toEqual({ dispute: 'dp_1', state: 'EVIDENCE_REQUIRED', reviewReason: 'disputed' })
    expect(errorSpy).toHaveBeenCalled()
  })

  it('dispute.state.updated records the state; LOST logs an error; arriving first still flags the order', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app, { qty: 1 })
    errorSpy.mockClear()
    await deliver(app, payments, squareEvent('dispute.state.updated', sqDispute({ id: 'dp_2', paymentId: o.squarePaymentId!, state: 'LOST' })))
    expect((await order(o.id)).reviewReason).toBe('disputed')
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.dispute_state', target: `order:${o.id}` } })
    expect(audit.after).toMatchObject({ dispute: 'dp_2', state: 'LOST' })
    expect(errorSpy.mock.calls.map((c) => String(c[0])).some((m) => m.includes('LOST'))).toBe(true)
  })
})

describe('out-of-order and unmatched events (P15)', () => {
  it('a refund before the payment is known is retried, then applies', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app, { qty: 1 })
    payments.nextOutcomes = ['lost']
    await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    const p = payments.paymentFor(r.orderId)
    payments.addRefund(p.id, { id: 'r1', status: 'COMPLETED', amountCents: r.totalCents })
    const refundEvt = squareEvent('refund.updated', sqRefund({ id: 'r1', paymentId: p.id, amount: r.totalCents }))
    const early = await deliver(app, payments, refundEvt)
    expect(early.status).toBe(503)
    expect(await prisma.paymentEvent.count({ where: { eventId: refundEvt.event_id } })).toBe(0)

    await deliver(app, payments, squareEvent('payment.updated', sqPayment({ id: p.id, orderId: r.orderId, amount: r.totalCents })))
    const retried = await deliver(app, payments, refundEvt)
    expect(retried.body.outcome).toBe('processed')
    expect((await order(r.orderId)).status).toBe('refunded')
  })

  it.each([
    ['payment.updated', () => sqPayment({ id: 'p_orphan', orderId: 'no-such-order', amount: 100 })],
    ['refund.updated', () => sqRefund({ id: 'r_orphan', paymentId: 'p_unrelated', amount: 100 })],
    ['dispute.created', () => sqDispute({ id: 'dp_orphan', paymentId: 'p_unrelated' })],
  ] as const)('%s with no matching order: 503 under 24h old, 200 + logged over', async (type, object) => {
    const { app, payments } = setup()
    const young = squareEvent(type, object(), { createdAt: new Date(Date.now() - DAY_MS + 60_000) })
    const res = await deliver(app, payments, young)
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('retry_later')

    errorSpy.mockClear()
    const old = squareEvent(type, object(), { createdAt: new Date(Date.now() - DAY_MS - 60_000) })
    const res2 = await deliver(app, payments, old)
    expect(res2.status).toBe(200)
    expect(res2.body.outcome).toBe('ignored')
    expect(String(errorSpy.mock.calls[0][0])).toContain(old.event_id)
    expect(await prisma.paymentEvent.count()).toBe(0)
  })
})

// Carried from Task 2: the header is normalised before it reaches the HMAC.
describe('signature header normalisation', () => {
  function call(headers: Record<string, unknown>, body: unknown) {
    const { payments } = setup()
    const verify = vi.spyOn(payments, 'verifyWebhook')
    const handler = createSquareWebhookHandler({ payments, email: { orderPaid: async () => {} } })
    const res: any = { statusCode: 0, body: undefined as unknown }
    res.status = (c: number) => { res.statusCode = c; return res }
    res.json = (b: unknown) => { res.body = b; return res }
    const next = vi.fn()
    return new Promise<{ res: any; next: typeof next; verify: typeof verify }>((resolve) => {
      res.json = (b: unknown) => { res.body = b; resolve({ res, next, verify }); return res }
      handler({ headers, body, get: (n: string) => headers[n.toLowerCase()] } as any, res, (err?: unknown) => { next(err); resolve({ res, next, verify }) })
    })
  }

  it.each([
    ['missing', {}],
    ['repeated (string[])', { 'x-square-hmacsha256-signature': ['a', 'b'] }],
    ['empty', { 'x-square-hmacsha256-signature': '' }],
  ])('rejects a %s header as bad_signature without verifying', async (_label, headers) => {
    const { res, next, verify } = await call(headers, Buffer.from('{}'))
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ code: 'bad_signature' })
    expect(verify).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects a request whose body was not read as raw bytes', async () => {
    const { res, verify } = await call({ 'x-square-hmacsha256-signature': 'c2ln' }, {})
    expect(res.statusCode).toBe(400)
    expect(verify).not.toHaveBeenCalled()
  })
})

describe('payment.updated for a recorded processing payment (T4-R4)', () => {
  async function processingOrder() {
    const s = setup()
    const r = await readyToPay(s.app)
    s.payments.nextOutcomes = ['processing']
    await postPay(s.app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    const p = s.payments.paymentFor(r.orderId)
    expect((await order(r.orderId)).squarePaymentId).toBe(p.id)
    return { ...s, r, p }
  }

  it('COMPLETED marks the order paid through the same path as the pay route', async () => {
    const { app, payments, email, r, p } = await processingOrder()
    const res = await deliver(app, payments, squareEvent('payment.updated', sqPayment({ id: p.id, orderId: r.orderId, amount: p.amountCents })))
    expect(res.body.outcome).toBe('processed')
    expect(await order(r.orderId)).toMatchObject({ status: 'paid', squarePaymentId: p.id, reviewReason: null })
    expect(email.orderPaid).toHaveBeenCalledTimes(1)
  })

  it.each(['FAILED', 'CANCELED'])('%s clears the payment id and the attempt, so the order can be re-quoted', async (status) => {
    const { app, payments, r, p } = await processingOrder()
    expect((await postQuote(app, r.orderId)).status).toBe(409) // payment_pending while the payment is live
    const res = await deliver(app, payments, squareEvent('payment.updated', sqPayment({ id: p.id, orderId: r.orderId, amount: p.amountCents, status })))
    expect(res.body.outcome).toBe('processed')
    expect(await order(r.orderId)).toMatchObject({ status: 'pending', squarePaymentId: null, paymentAttemptAt: null, paymentAttemptCount: 1 })
    expect((await postQuote(app, r.orderId)).status).toBe(200)
  })

  it('FAILED for a payment the order does not carry changes nothing', async () => {
    const { app, payments, r, p } = await processingOrder()
    await deliver(app, payments, squareEvent('payment.updated', sqPayment({ id: 'sq_other', orderId: r.orderId, amount: 1, status: 'FAILED' })))
    const o = await order(r.orderId)
    expect(o).toMatchObject({ status: 'pending', squarePaymentId: p.id, paymentAttemptCount: 0 })
    expect(o.paymentAttemptAt).toBeInstanceOf(Date)
  })
})
