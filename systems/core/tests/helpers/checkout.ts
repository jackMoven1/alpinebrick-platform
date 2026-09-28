import request from 'supertest'
import type { Express } from 'express'
import { buildApp, type AppDeps } from '../../src/app.js'
import { createFakePaymentsPort, FAKE_LOCATION_ID, type FakePaymentsPort } from '../../src/ports/payments/fake.adapter.js'
import { prisma } from '../../src/prisma.js'

/** An app wired to the fake Square, with the rate limit off unless a test supplies one. */
export function makeApp(over: Partial<AppDeps> = {}): { app: Express; payments: FakePaymentsPort } {
  const payments = (over.payments as FakePaymentsPort | undefined) ?? createFakePaymentsPort()
  const app = buildApp({ checkoutRateLimit: (_req, _res, next) => next(), ...over, payments })
  return { app, payments }
}

export async function variantIdBySku(sku: string): Promise<string> {
  return (await prisma.variant.findFirstOrThrow({ where: { sku } })).id
}

export async function inventoryOf(sku: string) {
  return prisma.inventory.findFirstOrThrow({ where: { variant: { sku } } })
}

export async function setOnHand(sku: string, onHand: number): Promise<string> {
  const id = await variantIdBySku(sku)
  await prisma.inventory.update({ where: { variantId: id }, data: { onHand, reserved: 0 } })
  return id
}

export function postCheckout(app: Express, body: Record<string, unknown>) {
  return request(app).post('/api/v1/checkout').send({ marketingOptIn: false, referral: null, ...body })
}

export const MI_ADDRESS = { line1: '1 Main St', line2: 'Apt 2', city: 'Traverse City', state: 'MI', postalCode: '49684' }

export function quoteBody(over: { email?: string; name?: string; address?: Record<string, unknown> } = {}) {
  return { email: over.email ?? 'Buyer@Example.com', name: over.name ?? 'Ann Buyer', address: { ...MI_ADDRESS, ...over.address } }
}

export function postQuote(app: Express, orderId: string, body: object = quoteBody()) {
  return request(app).post(`/api/v1/checkout/${orderId}/quote`).send(body)
}

/** Start a checkout (`qty` x `sku`, default 2 x BBS-STD at $49.99) and quote it. */
export async function readyToPay(
  app: Express,
  o: { qty?: number; sku?: string; address?: Record<string, unknown>; extra?: Record<string, unknown> } = {},
): Promise<{ orderId: string; quoteVersion: number; totalCents: number }> {
  const start = await postCheckout(app, { lines: [{ variantId: await variantIdBySku(o.sku ?? 'BBS-STD'), quantity: o.qty ?? 2 }], ...o.extra })
  if (start.status !== 201) throw new Error(`checkout failed: ${start.status} ${JSON.stringify(start.body)}`)
  const quote = await postQuote(app, start.body.orderId, quoteBody({ address: o.address }))
  if (quote.status !== 200) throw new Error(`quote failed: ${quote.status} ${JSON.stringify(quote.body)}`)
  return { orderId: start.body.orderId, quoteVersion: quote.body.quoteVersion, totalCents: quote.body.totalCents }
}

export function postPay(app: Express, orderId: string, body: Record<string, unknown>) {
  return request(app).post(`/api/v1/checkout/${orderId}/pay`).send(body)
}

/** readyToPay, then pay with the fake's default outcome (completed). Returns the paid order row. */
export async function paidOrder(app: Express, o: Parameters<typeof readyToPay>[1] = {}) {
  const r = await readyToPay(app, o)
  const res = await postPay(app, r.orderId, { sourceToken: `tok_${r.orderId}`, quoteVersion: r.quoteVersion })
  if (res.body.status !== 'paid') throw new Error(`pay failed: ${res.status} ${JSON.stringify(res.body)}`)
  return prisma.order.findUniqueOrThrow({ where: { id: r.orderId } })
}

let seq = 0
/** A Square webhook envelope as the subscription (API 2026-09-16) delivers it: raw snake_case. */
export function squareEvent(type: string, object: Record<string, unknown>, o: { id?: string; createdAt?: Date } = {}) {
  const dataType = type.split('.')[0]
  return {
    merchant_id: 'MFAKEMERCHANT', type,
    event_id: o.id ?? `evt_${Date.now()}_${++seq}`,
    created_at: (o.createdAt ?? new Date()).toISOString(),
    data: { type: dataType, id: String(object.id ?? ''), object: { [dataType]: object } },
  }
}

/** POSTs `event` exactly as Square does: raw JSON bytes, signed over the notification URL. */
export function deliver(app: Express, payments: FakePaymentsPort, event: object, signature?: string) {
  const payload = JSON.stringify(event)
  return request(app).post('/api/v1/webhooks/square')
    .set('Content-Type', 'application/json')
    .set('x-square-hmacsha256-signature', signature ?? payments.sign(payload))
    .send(payload)
}

export function sqPayment(o: { id: string; orderId?: string; amount: number; status?: string; locationId?: string }) {
  return {
    id: o.id, status: o.status ?? 'COMPLETED', amount_money: { amount: o.amount, currency: 'USD' },
    ...(o.orderId ? { reference_id: o.orderId } : {}), location_id: o.locationId ?? FAKE_LOCATION_ID,
  }
}

export function sqRefund(o: { id: string; paymentId: string; amount: number; status?: string; locationId?: string }) {
  return {
    id: o.id, status: o.status ?? 'COMPLETED', amount_money: { amount: o.amount, currency: 'USD' },
    payment_id: o.paymentId, location_id: o.locationId ?? FAKE_LOCATION_ID,
  }
}

export function sqDispute(o: { id: string; paymentId: string; state?: string; locationId?: string }) {
  return {
    id: o.id, state: o.state ?? 'EVIDENCE_REQUIRED', disputed_payment: { payment_id: o.paymentId },
    location_id: o.locationId ?? FAKE_LOCATION_ID,
  }
}
