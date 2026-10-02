import type Stripe from 'stripe'
import type { ShippingOption } from '../shipping/shipping.port.js'

/** stripe@22.6.2's pinned version (verified 2026-09-27; see the plan header). */
export const STRIPE_API_VERSION = '2026-08-26.dahlia' as const
/** Stripe Tax "General - Tangible Goods" (§9.5: revisit if an accountant names a toys code). */
export const TANGIBLE_GOODS_TAX_CODE = 'txcd_99999999'
/** Stripe Tax "Shipping". */
export const SHIPPING_TAX_CODE = 'txcd_92010001'
/** Spec §4: shown on the session and in the cart, verbatim. */
export const CONTIGUOUS_US_NOTICE = 'We ship to the contiguous US only.'

export interface CheckoutLine { name: string; unitAmountCents: number; quantity: number }

export interface CreateCheckoutSessionInput {
  orderId: string
  lines: CheckoutLine[]
  shippingOptions: ShippingOption[]
  expiresAt: Date
  /** Must contain {CHECKOUT_SESSION_ID}; Stripe substitutes it. */
  returnUrl: string
}

export interface CheckoutSessionRef { sessionId: string; clientSecret: string }
export type SessionStatus = 'open' | 'complete' | 'expired'
export type SessionPaymentStatus = 'paid' | 'unpaid' | 'no_payment_required'
export interface CheckoutSessionState { id: string; status: SessionStatus; paymentStatus: SessionPaymentStatus }

/** Stripe is not configured on this instance (no keys). Checkout answers 503. */
export class PaymentsUnavailableError extends Error {
  constructor() { super('payments are not configured'); this.name = 'PaymentsUnavailableError' }
}

export class WebhookSignatureError extends Error {
  constructor(message = 'invalid Stripe signature') { super(message); this.name = 'WebhookSignatureError' }
}

/**
 * Everything core asks of Stripe. Unit tests use fake.adapter.ts; the Stripe
 * adapter has a thin mocked-client test and the staging end-to-end run.
 */
export interface PaymentsPort {
  readonly configured: boolean
  /** false for test-mode keys; picks the Dashboard URL shape. */
  readonly livemode: boolean
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSessionRef>
  /** 'complete' when the customer paid before the expire landed. */
  expireCheckoutSession(sessionId: string): Promise<'expired' | 'complete'>
  retrieveCheckoutSession(sessionId: string): Promise<CheckoutSessionState>
  /** Throws WebhookSignatureError on a bad or stale signature. */
  constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event
}
