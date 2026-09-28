import { API_BASE_URL } from '../apiBase'

const BASE = `${API_BASE_URL}/api/v1/checkout`

export type CheckoutErrorCode =
  | 'insufficient_stock' | 'variant_not_found' | 'invalid_request' | 'rate_limited' | 'checkout_unavailable' | 'not_found'
  | 'outside_shipping_area' | 'quote_changed' | 'order_expired' | 'payment_declined' | 'payment_pending' | 'too_many_attempts'

export interface LineProblem {
  variantId: string
  code: 'insufficient_stock' | 'variant_not_found'
  available?: number
}

/** Spec copy, verbatim. */
export const UNAVAILABLE_MESSAGE = 'Checkout is temporarily unavailable — please try again in a minute.'
const RATE_LIMIT_MESSAGE = 'Too many checkout attempts. Please wait a minute and try again.'
const KNOWN: ReadonlySet<string> = new Set([
  'insufficient_stock', 'variant_not_found', 'invalid_request', 'rate_limited', 'checkout_unavailable', 'not_found',
  'outside_shipping_area', 'quote_changed', 'order_expired', 'payment_declined', 'payment_pending', 'too_many_attempts',
])

export class CheckoutError extends Error {
  readonly code: CheckoutErrorCode
  readonly lines: LineProblem[]
  /**
   * The field core named in details.field, else null: set for invalid_request
   * (e.g. `address.postalCode`) and for outside_shipping_area (`address.state`).
   */
  readonly field: string | null
  /**
   * Set only when core marks a checkout_unavailable as a DEFINITE payment
   * failure (details.outcome === 'failed'): no payment was created, so a
   * retry can never succeed. Unknown outcomes (where a retry may still land)
   * leave this null.
   */
  readonly outcome: 'failed' | null
  constructor(code: CheckoutErrorCode, message: string, lines: LineProblem[] = [], field: string | null = null, outcome: 'failed' | null = null) {
    super(message)
    this.name = 'CheckoutError'
    this.code = code
    this.lines = lines
    this.field = field
    this.outcome = outcome
  }
}

export interface StartCheckoutRequest {
  lines: { variantId: string; quantity: number }[]
  marketingOptIn: boolean
  referral: { code: string; firstSeenAt: string } | null
  previousOrderId?: string
}

export interface CheckoutStatus {
  status: 'pending' | 'paid' | 'cancelled'
  orderNumber: string
  lines: { name: string; sku: string; quantity: number; unitPriceCents: number; lineSubtotalCents: number }[]
  totals: { subtotalCents: number; shippingCents: number; taxCents: number; totalCents: number }
}

export interface CheckoutConfig {
  flatRateCents: number
  freeShippingThresholdCents: number | null
}

export interface ShipAddress {
  line1: string; line2: string; city: string; state: string; postalCode: string
  /** ISO-2; core accepts only 'US'. The page adds it to every quote request. */
  country?: 'US'
}
export interface QuoteRequest { email: string; name: string; address: ShipAddress }
export interface Quote { quoteVersion: number; subtotalCents: number; shippingCents: number; taxCents: number; totalCents: number }
export type PaidResult = Omit<CheckoutStatus, 'status'> & { status: 'paid' }
export type PayResult = PaidResult | { status: 'processing' }

function isLineProblem(x: unknown): x is LineProblem {
  const l = x as Record<string, unknown>
  return typeof l === 'object' && l !== null && typeof l.variantId === 'string'
    && (l.code === 'insufficient_stock' || l.code === 'variant_not_found')
}

async function toError(res: Response): Promise<CheckoutError> {
  let body: Record<string, unknown> | null = null
  try { body = (await res.json()) as Record<string, unknown> } catch { /* not JSON */ }
  const code = (typeof body?.code === 'string' && KNOWN.has(body.code) ? body.code : 'checkout_unavailable') as CheckoutErrorCode
  const details = body?.details as { lines?: unknown; field?: unknown; outcome?: unknown } | undefined
  const lines = Array.isArray(details?.lines) ? details.lines.filter(isLineProblem) : []
  const field = typeof details?.field === 'string' ? details.field : null
  const outcome = details?.outcome === 'failed' ? 'failed' : null
  const message = code === 'checkout_unavailable' ? UNAVAILABLE_MESSAGE
    : code === 'rate_limited' ? RATE_LIMIT_MESSAGE
      : typeof body?.message === 'string' ? body.message : UNAVAILABLE_MESSAGE
  return new CheckoutError(code, message, lines, field, outcome)
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    throw new CheckoutError('checkout_unavailable', UNAVAILABLE_MESSAGE)
  }
  if (!res.ok) throw await toError(res)
  try {
    return (await res.json()) as T
  } catch {
    throw new CheckoutError('checkout_unavailable', UNAVAILABLE_MESSAGE)
  }
}

/** No cookies: checkout is public and core's CORS has credentials off. */
function post<T>(url: string, body: unknown): Promise<T> {
  return request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

const orderUrl = (orderId: string, action: string) => `${BASE}/${encodeURIComponent(orderId)}/${action}`

export function startCheckout(req: StartCheckoutRequest): Promise<{ orderId: string }> {
  return post(BASE, req)
}

export function quoteCheckout(orderId: string, req: QuoteRequest): Promise<Quote> {
  return post(orderUrl(orderId, 'quote'), req)
}

export function payCheckout(orderId: string, req: { sourceToken: string; quoteVersion: number }): Promise<PayResult> {
  return post(orderUrl(orderId, 'pay'), req)
}

export function getCheckoutStatus(orderId: string): Promise<CheckoutStatus> {
  return request(`${BASE}/status?orderId=${encodeURIComponent(orderId)}`)
}

export function getCheckoutConfig(): Promise<CheckoutConfig> {
  return request(`${BASE}/config`)
}
