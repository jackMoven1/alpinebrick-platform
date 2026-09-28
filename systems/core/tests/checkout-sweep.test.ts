import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'

vi.mock('../src/channels/walmart/inventory.sync.js', async (importOriginal) => {
  const actual: any = await importOriginal()
  return { ...actual, enqueueInventoryPush: vi.fn(actual.enqueueInventoryPush) }
})
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { markOrderPaid } from '../src/orders/orders.service.js'
import { enqueueInventoryPush } from '../src/channels/walmart/inventory.sync.js'
import { unconfiguredPaymentsPort } from '../src/ports/payments/index.js'
import { sweepAbandonedCheckouts, startCheckoutSweep } from '../src/checkout/sweep.js'
import { paymentBlocksRelease, PAYMENT_ATTEMPT_GRACE_MS } from '../src/checkout/payment-attempt.js'
import { makeApp, postCheckout, readyToPay, postPay, variantIdBySku, inventoryOf } from './helpers/checkout.js'
import { stubDelegateOnce } from './helpers/prisma-stub.js'

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(async () => {
  await resetDb(); await seed()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(enqueueInventoryPush).mockClear()
})
afterEach(() => { errorSpy.mockRestore() })
afterAll(async () => { await prisma.$disconnect() })

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)
const age = (id: string, minutes: number) => prisma.order.update({ where: { id }, data: { createdAt: minutesAgo(minutes) } })

// See tests/helpers/prisma-stub.ts for why this doesn't use vi.spyOn directly.
function stubFindManyOnce(rows: Array<{ id: string }>): () => void {
  return stubDelegateOnce(prisma.order, 'findMany', rows)
}

async function pendingAged(minutes: number, qty = 1): Promise<string> {
  const { app } = makeApp()
  const res = await postCheckout(app, { lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: qty }] })
  await age(res.body.orderId, minutes)
  return res.body.orderId
}

describe('sweepAbandonedCheckouts', () => {
  it('cancels a pending order older than the session lifetime (30 min) with no payment attempt', async () => {
    const id = await pendingAged(31, 2)
    vi.mocked(enqueueInventoryPush).mockClear()
    expect(await sweepAbandonedCheckouts()).toEqual({ cancelled: [id], skipped: [] })
    expect((await prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('cancelled')
    expect((await inventoryOf('BBS-STD')).reserved).toBe(0)
    expect(enqueueInventoryPush).toHaveBeenCalledWith(await variantIdBySku('BBS-STD'))
  })

  it('leaves an order younger than the session lifetime alone', async () => {
    await pendingAged(29)
    expect(await sweepAbandonedCheckouts()).toEqual({ cancelled: [], skipped: [] })
  })

  it('waits 10 minutes after the last payment attempt, then cancels', async () => {
    const id = await pendingAged(45)
    await prisma.order.update({ where: { id }, data: { paymentAttemptAt: minutesAgo(9) } })
    expect(await sweepAbandonedCheckouts()).toEqual({ cancelled: [], skipped: [] })
    await prisma.order.update({ where: { id }, data: { paymentAttemptAt: minutesAgo(11) } })
    expect(await sweepAbandonedCheckouts()).toEqual({ cancelled: [id], skipped: [] })
  })

  // Spec §2 race rule: pay stamps paymentAttemptAt and commits before charging.
  it('skips an order whose charge is in flight, and the charge completes', async () => {
    const { app, payments } = makeApp()
    const r = await readyToPay(app)
    await age(r.orderId, 45)
    let during: Awaited<ReturnType<typeof sweepAbandonedCheckouts>> | null = null
    payments.duringCharge = async () => { during = await sweepAbandonedCheckouts() }
    const res = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(during).toEqual({ cancelled: [], skipped: [] })
    expect(res.body.status).toBe('paid')
    expect((await inventoryOf('BBS-STD')).reserved).toBe(2)
  })

  it('re-checks the attempt under the row lock (stamped after the sweep read it)', async () => {
    const id = await pendingAged(45)
    await prisma.order.update({ where: { id }, data: { paymentAttemptAt: new Date() } })
    // The unlocked read predates the stamp: make it return the order anyway.
    const restore = stubFindManyOnce([{ id }])
    try {
      expect(await sweepAbandonedCheckouts()).toEqual({ cancelled: [], skipped: [id] })
    } finally { restore() }
    expect((await prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('pending')
  })

  it('never cancels an order that became paid after the read', async () => {
    const id = await pendingAged(45)
    await markOrderPaid(id)
    const restore = stubFindManyOnce([{ id }])
    try {
      expect(await sweepAbandonedCheckouts()).toEqual({ cancelled: [], skipped: [id] })
    } finally { restore() }
    expect(await prisma.auditLog.count({ where: { action: 'order.cancelled', target: `order:${id}` } })).toBe(0)
  })

  it('never cancels an order with a squarePaymentId even when the payment attempt stamp is stale', async () => {
    const id = await pendingAged(45)
    await prisma.order.update({
      where: { id },
      data: { squarePaymentId: `sqp_${id}`, paymentAttemptAt: minutesAgo(45) },
    })
    // The query itself excludes squarePaymentId rows, so the order is never
    // read as a candidate at all -- neither cancelled nor skipped.
    expect(await sweepAbandonedCheckouts()).toEqual({ cancelled: [], skipped: [] })
    expect((await prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('pending')
  })

  it('re-checks squarePaymentId under the row lock (recorded after the sweep read it)', async () => {
    const id = await pendingAged(45)
    // The unlocked read predates pay recording the payment id: make it return
    // the order anyway, as if the read raced a pay that just landed.
    const restore = stubFindManyOnce([{ id }])
    await prisma.order.update({ where: { id }, data: { squarePaymentId: `sqp_${id}` } })
    try {
      expect(await sweepAbandonedCheckouts()).toEqual({ cancelled: [], skipped: [id] })
    } finally { restore() }
    expect((await prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('pending')
  })

  it('never touches Walmart orders', async () => {
    const w = await prisma.order.create({ data: {
      channel: 'walmart', externalOrderId: 'PO-1', email: 'w@example.com', shipToState: 'MI',
      subtotalCents: 100, taxCents: 0, totalCents: 100, taxRateBps: 0, taxJurisdiction: 'none', createdAt: minutesAgo(180),
    } })
    expect(await sweepAbandonedCheckouts()).toEqual({ cancelled: [], skipped: [] })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: w.id } })).status).toBe('pending')
  })

  it('does not start without payments, and starts (returning a stop function) with them', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    startCheckoutSweep(unconfiguredPaymentsPort)()
    expect(logSpy.mock.calls.join(' ')).toContain('not started')
    const stop = startCheckoutSweep({ configured: true }, 60_000)
    expect(typeof stop).toBe('function')
    stop()
    logSpy.mockRestore()
  })
})

// Final review C1: the one rule every release path asks.
describe('paymentBlocksRelease', () => {
  const now = new Date('2026-09-28T12:00:00Z')
  const ago = (ms: number) => new Date(now.getTime() - ms)
  it.each([
    ['no payment id, no attempt', { squarePaymentId: null, paymentAttemptAt: null }, false],
    ['no payment id, stale attempt', { squarePaymentId: null, paymentAttemptAt: ago(PAYMENT_ATTEMPT_GRACE_MS) }, false],
    ['no payment id, attempt in flight', { squarePaymentId: null, paymentAttemptAt: ago(PAYMENT_ATTEMPT_GRACE_MS - 1) }, true],
    ['payment id, no attempt', { squarePaymentId: 'sq_1', paymentAttemptAt: null }, true],
    ['payment id, stale attempt', { squarePaymentId: 'sq_1', paymentAttemptAt: ago(60 * 60_000) }, true],
  ] as const)('%s -> %s', (_label, order, blocks) => {
    expect(paymentBlocksRelease(order, now)).toBe(blocks)
  })
})
