// tests/checkout-sweep.test.ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { placeOrder, markOrderPaid, PENDING_CHECKOUT_EMAIL } from '../src/orders/orders.service.js'
import { deferredTaxAdapter } from '../src/ports/tax/deferred.adapter.js'
import { unconfiguredPaymentsPort } from '../src/ports/payments/index.js'
import { sweepAbandonedCheckouts, startCheckoutSweep } from '../src/checkout/sweep.js'
import { makeApp, postCheckout, variantIdBySku, inventoryOf } from './helpers/checkout.js'

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(async () => {
  await resetDb(); await seed()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterAll(async () => { errorSpy.mockRestore(); await prisma.$disconnect() })

const age = (id: string, minutes: number) =>
  prisma.order.update({ where: { id }, data: { createdAt: new Date(Date.now() - minutes * 60_000) } })

async function agedCheckout(app: any, minutes: number) {
  const res = await postCheckout(app, { lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: 1 }] })
  await age(res.body.orderId, minutes)
  return prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } })
}

describe('sweepAbandonedCheckouts', () => {
  it('cancels an old pending order whose session Stripe reports expired', async () => {
    const { app, payments } = makeApp()
    const o = await agedCheckout(app, 41) // session 30 + grace 10
    payments.setSession(o.stripeCheckoutSessionId!, 'expired')
    expect(await sweepAbandonedCheckouts(payments)).toEqual({ cancelled: [o.id], skipped: [] })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('cancelled')
    expect((await inventoryOf('BBS-STD')).reserved).toBe(0)
  })

  it('cancels complete-but-unpaid sessions', async () => {
    const { app, payments } = makeApp()
    const o = await agedCheckout(app, 41)
    payments.setSession(o.stripeCheckoutSessionId!, 'complete', 'unpaid')
    expect((await sweepAbandonedCheckouts(payments)).cancelled).toEqual([o.id])
  })

  it('leaves a paid session alone and logs the missed webhook', async () => {
    const { app, payments } = makeApp()
    const o = await agedCheckout(app, 41)
    payments.setSession(o.stripeCheckoutSessionId!, 'complete', 'paid')
    expect(await sweepAbandonedCheckouts(payments)).toEqual({ cancelled: [], skipped: [o.id] })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('pending')
    expect(errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('webhook')
  })

  it('leaves open sessions and young orders alone', async () => {
    const { app, payments } = makeApp()
    const open = await agedCheckout(app, 41)
    const young = await agedCheckout(app, 39)
    payments.setSession(young.stripeCheckoutSessionId!, 'expired')
    const out = await sweepAbandonedCheckouts(payments)
    expect(out.cancelled).toEqual([])
    expect(out.skipped).toEqual([open.id])
  })

  it('cancels a stale storefront order that never got a session', async () => {
    const { payments } = makeApp()
    const orphan = await placeOrder({ email: PENDING_CHECKOUT_EMAIL, shipToState: '', lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: 2 }] }, deferredTaxAdapter)
    await age(orphan.id, 41)
    expect((await sweepAbandonedCheckouts(payments)).cancelled).toEqual([orphan.id])
    expect((await inventoryOf('BBS-STD')).reserved).toBe(0)
  })

  // Fix round 1 (Ruling T8-R1): the sweep's initial SELECT picks up the order
  // while it is still `pending`, then Stripe reports the session expired --
  // but the webhook commits pending->paid in the gap between that Stripe
  // read and the sweep's cancel taking the row lock. The lock forces the
  // cancel to re-read the committed status: with `onlyIfPending`, it must
  // skip rather than release stock Stripe was just paid for.
  it('never cancels an order the webhook marks paid between the Stripe read and the cancel', async () => {
    const { app, payments } = makeApp()
    const o = await agedCheckout(app, 41)
    payments.setSession(o.stripeCheckoutSessionId!, 'expired')
    const originalRetrieve = payments.retrieveCheckoutSession.bind(payments)
    payments.retrieveCheckoutSession = async (id: string) => {
      await markOrderPaid(o.id)
      return originalRetrieve(id)
    }

    expect(await sweepAbandonedCheckouts(payments)).toEqual({ cancelled: [], skipped: [o.id] })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('paid')
    expect((await inventoryOf('BBS-STD')).reserved).toBe(1)
    expect(await prisma.auditLog.count({ where: { action: 'order.cancelled', target: `order:${o.id}` } })).toBe(0)
  })

  it('never touches Walmart orders', async () => {
    const { payments } = makeApp()
    const w = await prisma.order.create({ data: {
      channel: 'walmart', externalOrderId: 'PO-1', email: 'w@example.com', shipToState: 'MI',
      subtotalCents: 100, taxCents: 0, totalCents: 100, taxRateBps: 0, taxJurisdiction: 'none',
      createdAt: new Date(Date.now() - 3 * 3_600_000),
    } })
    expect(await sweepAbandonedCheckouts(payments)).toEqual({ cancelled: [], skipped: [] })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: w.id } })).status).toBe('pending')
  })

  it('does not start without Stripe', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const stop = startCheckoutSweep(unconfiguredPaymentsPort)
    expect(typeof stop).toBe('function')
    stop()
    expect(logSpy.mock.calls.join(' ')).toContain('not started')
    logSpy.mockRestore()
  })
})
