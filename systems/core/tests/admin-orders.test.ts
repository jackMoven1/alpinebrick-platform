import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import request from 'supertest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { createSession, SESSION_COOKIE } from '../src/auth/session.service.js'
import { makeApp, postCheckout, paidOrder, variantIdBySku, inventoryOf, deliver, squareEvent, sqDispute } from './helpers/checkout.js'
import { stubDelegateOnce } from './helpers/prisma-stub.js'

const ORIGIN = 'https://admin-staging.alpinebrickexchange.com'
let ctx: ReturnType<typeof makeApp>
let cookie: string
let actorId: string

beforeEach(async () => {
  await resetDb(); await seed()
  process.env.ADMIN_CONSOLE_ORIGIN = ORIGIN
  vi.spyOn(console, 'error').mockImplementation(() => {})
  ctx = makeApp()
  const actor = await prisma.actor.create({ data: { type: 'human', name: 'Jack' } })
  actorId = actor.id
  cookie = `${SESSION_COOKIE}=${(await createSession(actor.id)).token}`
})
afterEach(() => { vi.restoreAllMocks() })
afterAll(async () => { delete process.env.ADMIN_CONSOLE_ORIGIN; await prisma.$disconnect() })

const get = (path: string) => request(ctx.app).get(`/api/v1/admin${path}`).set('Cookie', cookie)
const write = (method: 'post' | 'put', path: string, body: unknown = {}) =>
  request(ctx.app)[method](`/api/v1/admin${path}`).set('Cookie', cookie).set('Origin', ORIGIN)
    .set('Content-Type', 'application/json').send(JSON.stringify(body))

async function pending(qty = 1) {
  const res = await postCheckout(ctx.app, { lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: qty }] })
  return prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } })
}
const paid = (qty = 1) => paidOrder(ctx.app, { qty })
async function flagged(qty = 1) {
  const o = await paid(qty)
  return prisma.order.update({ where: { id: o.id }, data: { reviewReason: 'amount_mismatch' } })
}
async function disputed(qty = 1) {
  const q = await paid(qty)
  await deliver(ctx.app, ctx.payments, squareEvent('dispute.created', sqDispute({ id: `dp_${q.id}`, paymentId: q.squarePaymentId! })))
  return prisma.order.findUniqueOrThrow({ where: { id: q.id } })
}

describe('admin orders', () => {
  it('requires a session', async () => {
    expect((await request(ctx.app).get('/api/v1/admin/orders?tab=to_ship')).status).toBe(401)
  })

  it('queues storefront orders by tab, newest first', async () => {
    const p = await pending()
    const q = await paid()
    const r = await flagged()
    await prisma.order.create({ data: {
      channel: 'walmart', externalOrderId: 'PO-9', status: 'paid', email: 'w@example.com', shipToState: 'MI',
      subtotalCents: 1, taxCents: 0, totalCents: 1, taxRateBps: 0, taxJurisdiction: 'none',
    } })
    const ids = async (tab: string) => (await get(`/orders?tab=${tab}`)).body.items.map((i: { id: string }) => i.id)
    expect(await ids('to_ship')).toEqual([r.id, q.id])
    expect(await ids('pending')).toEqual([p.id])
    expect(await ids('review')).toEqual([r.id])
    expect(await ids('shipped')).toEqual([])
    expect(await ids('closed')).toEqual([])
    const page = (await get('/orders?tab=pending')).body
    expect(page).toMatchObject({ total: 1, page: 1, pageSize: 25 })
    expect(page.items[0]).toMatchObject({ email: null, itemCount: 1, totalCents: 4999, shipToState: null, status: 'pending', reviewReason: null })
    expect((await get('/orders?tab=to_ship')).body.items[1]).toMatchObject({ email: 'buyer@example.com', shipToState: 'MI' })
  })

  it('400s an unknown tab', async () => {
    const res = await get('/orders?tab=everything')
    expect(res.status).toBe(400)
    expect(res.body.fields.tab).toBeDefined()
  })

  it('returns the order detail with the payment reference and no provider copy', async () => {
    const q = await paid()
    const res = await get(`/orders/${q.id}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: q.id, status: 'paid', email: 'buyer@example.com',
      shipTo: { name: 'Ann Buyer', line1: '1 Main St', line2: 'Apt 2', city: 'Traverse City', state: 'MI', postalCode: '49684' },
      lines: [{ sku: 'BBS-STD', name: 'Brick Builder Set', quantity: 1, unitPriceCents: 4999, lineSubtotalCents: 4999 }],
      subtotalCents: 4999, shippingCents: 995, taxCents: 300, totalCents: 6294, refundedCents: 0, referral: null,
      taxJurisdiction: 'MI', payment: { provider: 'square', id: q.squarePaymentId, url: null },
    })
    expect(res.body).not.toHaveProperty('stripePaymentUrl')
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('stripe')
    expect(res.body.audit.map((a: { action: string }) => a.action)).toEqual(['order.place', 'order.paid'])
    expect((await get(`/orders/${(await pending()).id}`)).body.payment).toBeNull()
    expect((await get('/orders/nope')).status).toBe(404)
  })

  it('validates the ship form', async () => {
    const q = await paid()
    const noTracking = await write('post', `/orders/${q.id}/ship`, { carrier: 'USPS' })
    expect(noTracking.status).toBe(400)
    expect(noTracking.body.fields.trackingNumber).toBeDefined()
    expect((await write('post', `/orders/${q.id}/ship`, { carrier: 'Pigeon', trackingNumber: '1' })).body.fields.carrier).toBeDefined()
  })

  it('marks shipped: fulfilled, stock decremented, carrier recorded, audited', async () => {
    const q = await paid(2)
    const res = await write('post', `/orders/${q.id}/ship`, { carrier: 'USPS', trackingNumber: ' 9400 1000 0000 0000 0000 00 ' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'fulfilled', carrier: 'USPS', trackingNumber: '9400 1000 0000 0000 0000 00' })
    expect(await inventoryOf('BBS-STD')).toMatchObject({ onHand: 23, reserved: 0 })
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.ship', target: `order:${q.id}` } })).actorId).toBe(actorId)
  })

  it('ships with carrier Other and no tracking number', async () => {
    const q = await paid()
    expect((await write('post', `/orders/${q.id}/ship`, { carrier: 'Other' })).body).toMatchObject({ status: 'fulfilled', trackingNumber: null })
  })

  it('requires acknowledgement before shipping a flagged order', async () => {
    const r = await flagged()
    const refused = await write('post', `/orders/${r.id}/ship`, { carrier: 'UPS', trackingNumber: '1Z999' })
    expect(refused.status).toBe(409)
    expect(refused.body.code).toBe('REVIEW_REQUIRED')
    expect((await write('post', `/orders/${r.id}/ship`, { carrier: 'UPS', trackingNumber: '1Z999', acknowledgeReview: true })).status).toBe(200)
  })

  it('refuses to ship a pending order', async () => {
    const p = await pending()
    const res = await write('post', `/orders/${p.id}/ship`, { carrier: 'UPS', trackingNumber: '1Z999' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('INVALID_TRANSITION')
  })

  it('cancels a pending order without calling the payment provider, releasing stock', async () => {
    const p = await pending(3)
    // Q-P5: `charges` staying [] can never fail now that cancel makes no
    // provider call at all -- assert against a spy that would actually
    // record a call if one were made.
    const chargeSpy = vi.spyOn(ctx.payments, 'charge')
    const res = await write('post', `/orders/${p.id}/cancel`)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('cancelled')
    expect(chargeSpy).not.toHaveBeenCalled()
    expect((await inventoryOf('BBS-STD')).reserved).toBe(0)
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.cancelled', target: `order:${p.id}` } })).actorId).toBe(actorId)
  })

  // Plan decision 7.
  it('refuses to cancel while the customer is paying (409 PAYMENT_IN_PROGRESS)', async () => {
    const p = await pending()
    await prisma.order.update({ where: { id: p.id }, data: { paymentAttemptAt: new Date() } })
    const res = await write('post', `/orders/${p.id}/cancel`)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PAYMENT_IN_PROGRESS')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('pending')
  })

  it('answers ORDER_PAID, without naming a provider, when the order was paid after the page loaded', async () => {
    const q = await paid()
    const stale = { channel: 'storefront', status: 'pending', reviewReason: null, paymentAttemptAt: null }
    const restore = stubDelegateOnce(prisma.order, 'findUnique', stale)
    let res: Awaited<ReturnType<typeof write>>
    try {
      res = await write('post', `/orders/${q.id}/cancel`)
    } finally { restore() }
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('ORDER_PAID')
    expect(res.body.message).toContain('payment dashboard')
    expect(res.body.message.toLowerCase()).not.toContain('stripe')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: q.id } })).status).toBe('paid')
  })

  it('refuses to cancel a paid order, pointing at the payment dashboard', async () => {
    const q = await paid()
    const res = await write('post', `/orders/${q.id}/cancel`)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('INVALID_TRANSITION')
    expect(res.body.message).toContain('payment dashboard')
  })

  it('cancels a disputed paid order with acknowledgement, releasing its stock (F-R1)', async () => {
    const d = await disputed(2)
    expect(d).toMatchObject({ status: 'paid', reviewReason: 'disputed' })
    const res = await write('post', `/orders/${d.id}/cancel`, { acknowledgeReview: true })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('cancelled')
    expect(await inventoryOf('BBS-STD')).toMatchObject({ onHand: 25, reserved: 0 })
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.cancelled', target: `order:${d.id}` } })
    expect(audit.actorId).toBe(actorId)
    expect(audit.after).toMatchObject({ status: 'cancelled', acknowledgedReview: 'disputed' })
  })

  it('refuses to cancel a disputed paid order without acknowledgement (F-R1)', async () => {
    const d = await disputed()
    const res = await write('post', `/orders/${d.id}/cancel`)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('REVIEW_REQUIRED')
    expect(res.body.details).toEqual({ reviewReason: 'disputed' })
    expect((await inventoryOf('BBS-STD')).reserved).toBe(1)
  })

  it('still refuses to cancel a non-disputed paid order, acknowledged or flagged (F-R1)', async () => {
    const q = await paid()
    expect((await write('post', `/orders/${q.id}/cancel`, { acknowledgeReview: true })).body.code).toBe('INVALID_TRANSITION')
    const r = await flagged()
    expect((await write('post', `/orders/${r.id}/cancel`, { acknowledgeReview: true })).body.code).toBe('INVALID_TRANSITION')
    expect((await inventoryOf('BBS-STD')).reserved).toBe(2)
  })

  it('validates the cancel body', async () => {
    const d = await disputed()
    const res = await write('post', `/orders/${d.id}/cancel`, { acknowledgeReview: 'yes' })
    expect(res.status).toBe(400)
    expect(res.body.fields.acknowledgeReview).toBeDefined()
  })

  it('refuses to ship when the order was flagged after the unlocked read (F-R3)', async () => {
    const q = await paid()
    await prisma.order.update({ where: { id: q.id }, data: { reviewReason: 'disputed' } })
    const stale = { channel: 'storefront', status: 'paid', reviewReason: null, paymentAttemptAt: null }
    const restore = stubDelegateOnce(prisma.order, 'findUnique', stale)
    let res: Awaited<ReturnType<typeof write>>
    try {
      res = await write('post', `/orders/${q.id}/ship`, { carrier: 'UPS', trackingNumber: '1Z999' })
    } finally { restore() }
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('REVIEW_REQUIRED')
    expect(res.body.details).toEqual({ reviewReason: 'disputed' })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: q.id } })).toMatchObject({ status: 'paid', shippedAt: null })
  })

  it('audits the locked reviewReason when an acknowledged ship races a flag (F-R3)', async () => {
    const q = await paid()
    await prisma.order.update({ where: { id: q.id }, data: { reviewReason: 'disputed' } })
    const stale = { channel: 'storefront', status: 'paid', reviewReason: null, paymentAttemptAt: null }
    const restore = stubDelegateOnce(prisma.order, 'findUnique', stale)
    let status: number
    try {
      status = (await write('post', `/orders/${q.id}/ship`, { carrier: 'UPS', trackingNumber: '1Z999', acknowledgeReview: true })).status
    } finally { restore() }
    expect(status).toBe(200)
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.ship', target: `order:${q.id}` } })
    expect(audit.after).toMatchObject({ acknowledgedReview: 'disputed' })
  })

  it('reads and updates shipping settings', async () => {
    expect((await get('/settings/shipping')).body).toEqual({ flatRateCents: 995, freeThresholdCents: 15000, sessionMinutes: 30 })
    const ok = await write('put', '/settings/shipping', { flatRateCents: 1295, freeThresholdCents: 20000 })
    expect(ok.body).toMatchObject({ flatRateCents: 1295, freeThresholdCents: 20000 })
    const bad = await write('put', '/settings/shipping', { flatRateCents: 'free', freeThresholdCents: null })
    expect(bad.status).toBe(400)
    expect(bad.body.fields.flatRateCents).toBeDefined()
  })
})
