import request from 'supertest'
import type { Express } from 'express'
import { buildApp, type AppDeps } from '../../src/app.js'
import { createFakePaymentsPort, type FakePaymentsPort } from '../../src/ports/payments/fake.adapter.js'
import { prisma } from '../../src/prisma.js'

export const STOREFRONT_URL = 'https://staging.alpinebrickexchange.com'

/** An app wired to the fake Stripe, with the rate limit off unless a test supplies one. */
export function makeApp(over: Partial<AppDeps> = {}): { app: Express; payments: FakePaymentsPort } {
  const payments = (over.payments as FakePaymentsPort | undefined) ?? createFakePaymentsPort()
  const app = buildApp({
    storefrontUrl: STOREFRONT_URL,
    checkoutRateLimit: (_req, _res, next) => next(),
    ...over,
    payments,
  })
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

let seq = 0
/** A Stripe event envelope as the endpoint would render it (API 2026-08-26.dahlia). */
export function stripeEvent(type: string, object: Record<string, unknown>, id = `evt_test_${Date.now()}_${++seq}`) {
  return {
    id, object: 'event', type, api_version: '2026-08-26.dahlia', created: Math.floor(Date.now() / 1000),
    livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null }, data: { object },
  }
}

/** POSTs `event` with a valid signature (or the one given) exactly as Stripe does: raw JSON bytes. */
export function deliver(app: Express, payments: FakePaymentsPort, event: object, signature?: string) {
  const payload = JSON.stringify(event)
  return request(app).post('/api/v1/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', signature ?? payments.sign(payload))
    .send(payload)
}

/**
 * A checkout.session.completed object. Defaults are internally consistent:
 * amount_total = subtotal + shipping + tax.
 */
export function completedSession(o: {
  orderId: string; sessionId: string; subtotal: number; shipping?: number; tax?: number; total?: number
  state?: string; country?: string; email?: string; name?: string; paymentIntent?: string; paymentStatus?: string
}) {
  const shipping = o.shipping ?? 995
  const tax = o.tax ?? 0
  return {
    id: o.sessionId, object: 'checkout.session', mode: 'payment', status: 'complete',
    payment_status: o.paymentStatus ?? 'paid',
    client_reference_id: o.orderId, metadata: { orderId: o.orderId },
    amount_subtotal: o.subtotal, amount_total: o.total ?? o.subtotal + shipping + tax,
    total_details: { amount_discount: 0, amount_shipping: shipping, amount_tax: tax },
    shipping_cost: { amount_subtotal: shipping, amount_tax: 0, amount_total: shipping, shipping_rate: 'shr_test' },
    customer_details: { email: o.email ?? 'Buyer@Example.com', name: o.name ?? 'Ann Buyer', address: null },
    collected_information: {
      shipping_details: {
        name: o.name ?? 'Ann Buyer',
        address: { line1: '1 Main St', line2: 'Apt 2', city: 'Traverse City', state: o.state ?? 'MI', postal_code: '49684', country: o.country ?? 'US' },
      },
    },
    payment_intent: o.paymentIntent ?? `pi_test_${o.orderId}`,
  }
}
