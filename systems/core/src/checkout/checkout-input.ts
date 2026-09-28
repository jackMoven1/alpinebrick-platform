import { parseReferralInput } from '../referrals/referrals.service.js'
import { normalizeEmail } from '../customers/customers.service.js'
import type { ShipToAddress } from '../ports/payments/payments.port.js'

export const MAX_LINES = 20
export const MAX_QUANTITY = 10

/** Spec §2 step 2, verbatim. */
export const CONTIGUOUS_US_NOTICE = 'We ship to the contiguous US only.'
/** Refused at quote, before any charge (spec §2 step 2). */
export const OUTSIDE_SHIPPING_AREA: ReadonlySet<string> = new Set(['AK', 'HI', 'PR', 'GU', 'VI', 'AS', 'MP', 'AA', 'AE', 'AP'])
/** The 48 contiguous states and DC. */
export const CONTIGUOUS_STATES: ReadonlySet<string> = new Set([
  'AL', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA',
  'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH',
  'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
])
/** Order ids are cuids; this only keeps junk out of queries and logs. */
export const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Public checkout error: lower_snake `code`, HTTP `status`, optional `details`. */
export class CheckoutError extends Error {
  constructor(public code: string, message: string, public status: number, public details?: Record<string, unknown>) {
    super(message)
    this.name = 'CheckoutError'
  }
}

/** One place for the public error copy (spec §5). */
export const checkoutErrors = {
  unavailable: (details?: Record<string, unknown>) => new CheckoutError('checkout_unavailable', 'Checkout is temporarily unavailable — please try again in a minute.', 503, details),
  notFound: () => new CheckoutError('not_found', 'No checkout for that order.', 404),
  expired: () => new CheckoutError('order_expired', 'This checkout expired.', 409),
  quoteChanged: () => new CheckoutError('quote_changed', 'Your total has changed. Check it and pay again.', 409),
  paymentPending: () => new CheckoutError('payment_pending', "We're still confirming an earlier payment attempt for this order.", 409),
  tooManyAttempts: () => new CheckoutError('too_many_attempts', 'Too many payment attempts for this order. Start again from your cart.', 429),
}

export interface CheckoutRequest {
  lines: { variantId: string; quantity: number }[]
  marketingOptIn: boolean
  referral: { code: string; firstSeenAt: Date } | null
  previousOrderId: string | null
}

const invalid = (field: string, message: string) => new CheckoutError('invalid_request', message, 400, { field })

function asObject(v: unknown, field: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw invalid(field, `${field} must be a JSON object`)
  return v as Record<string, unknown>
}

/** A bad referral is dropped (parseReferralInput -> null), never rejected. */
export function parseCheckoutRequest(body: unknown, now = new Date()): CheckoutRequest {
  const b = asObject(body, 'body')
  if (!Array.isArray(b.lines) || b.lines.length < 1 || b.lines.length > MAX_LINES) {
    throw invalid('lines', `between 1 and ${MAX_LINES} lines`)
  }
  const seen = new Set<string>()
  const lines = b.lines.map((raw, i) => {
    const l = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    if (typeof l.variantId !== 'string' || l.variantId.length < 1 || l.variantId.length > 64) {
      throw invalid(`lines.${i}.variantId`, 'a variant id')
    }
    if (typeof l.quantity !== 'number' || !Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > MAX_QUANTITY) {
      throw invalid(`lines.${i}.quantity`, `a whole number from 1 to ${MAX_QUANTITY}`)
    }
    if (seen.has(l.variantId)) throw invalid(`lines.${i}.variantId`, 'each variant may appear only once')
    seen.add(l.variantId)
    return { variantId: l.variantId, quantity: l.quantity }
  })
  if ('marketingOptIn' in b && typeof b.marketingOptIn !== 'boolean') throw invalid('marketingOptIn', 'true or false')
  const prev = b.previousOrderId
  return {
    lines,
    marketingOptIn: b.marketingOptIn === true,
    referral: parseReferralInput(b.referral, now),
    previousOrderId: typeof prev === 'string' && ORDER_ID_RE.test(prev) ? prev : null,
  }
}

function text(v: unknown, field: string, max: number): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (s.length < 1 || s.length > max) throw invalid(field, `required, at most ${max} characters`)
  return s
}

export interface QuoteRequest { email: string; name: string; address: ShipToAddress }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ZIP_RE = /^\d{5}(-\d{4})?$/

/**
 * Spec §2 steps 2-3. Outside the contiguous US is 422 before anything is
 * written; a malformed field is 400 naming it.
 */
export function parseQuoteRequest(body: unknown): QuoteRequest {
  const b = asObject(body, 'body')
  const email = typeof b.email === 'string' ? b.email.trim() : ''
  if (email.length > 254 || !EMAIL_RE.test(email)) throw invalid('email', 'an email address')
  const name = text(b.name, 'name', 100)
  const a = asObject(b.address, 'address')
  const country = typeof a.country === 'string' && a.country.trim() !== '' ? a.country.trim().toUpperCase() : 'US'
  const state = typeof a.state === 'string' ? a.state.trim().toUpperCase() : ''
  if (country !== 'US' || OUTSIDE_SHIPPING_AREA.has(state)) {
    throw new CheckoutError('outside_shipping_area', CONTIGUOUS_US_NOTICE, 422, { field: 'address.state' })
  }
  const line1 = text(a.line1, 'address.line1', 100)
  const line2 = typeof a.line2 === 'string' ? a.line2.trim() : ''
  if (line2.length > 100) throw invalid('address.line2', 'at most 100 characters')
  const city = text(a.city, 'address.city', 60)
  if (!CONTIGUOUS_STATES.has(state)) throw invalid('address.state', 'a two-letter US state code')
  const postalCode = typeof a.postalCode === 'string' ? a.postalCode.trim() : ''
  if (!ZIP_RE.test(postalCode)) throw invalid('address.postalCode', 'a 5-digit ZIP code')
  return {
    email: normalizeEmail(email),
    name,
    address: { name, line1, line2: line2 || null, city, state, postalCode },
  }
}

export interface PayRequest { sourceToken: string; quoteVersion: number }

export function parsePayRequest(body: unknown): PayRequest {
  const b = asObject(body, 'body')
  if (typeof b.sourceToken !== 'string' || b.sourceToken.length < 1 || b.sourceToken.length > 1024) {
    throw invalid('sourceToken', 'a payment token')
  }
  if (typeof b.quoteVersion !== 'number' || !Number.isInteger(b.quoteVersion) || b.quoteVersion < 1) {
    throw invalid('quoteVersion', 'the quote version being paid')
  }
  return { sourceToken: b.sourceToken, quoteVersion: b.quoteVersion }
}
