import { API_BASE_URL } from '../apiBase'

const BASE = `${API_BASE_URL}/api/v1/checkout`

export type CheckoutErrorCode =
  | 'insufficient_stock' | 'variant_not_found' | 'invalid_request' | 'rate_limited' | 'checkout_unavailable' | 'not_found'

export interface LineProblem {
  variantId: string
  code: 'insufficient_stock' | 'variant_not_found'
  available?: number
}

/** Spec §6, verbatim. */
export const UNAVAILABLE_MESSAGE = 'Checkout is temporarily unavailable — please try again in a minute.'
const RATE_LIMIT_MESSAGE = 'Too many checkout attempts. Please wait a minute and try again.'
/**
 * Ruling P10: core's 404 `not_found` is its own terminal error kind, not a
 * temporary/retryable failure -- Task 13's /order/complete shows "We couldn't
 * find that order" for it rather than folding it into checkout_unavailable.
 */
const KNOWN: ReadonlySet<string> = new Set(['insufficient_stock', 'variant_not_found', 'invalid_request', 'rate_limited', 'checkout_unavailable', 'not_found'])

export class CheckoutError extends Error {
  readonly code: CheckoutErrorCode
  readonly lines: LineProblem[]
  constructor(code: CheckoutErrorCode, message: string, lines: LineProblem[] = []) {
    super(message)
    this.name = 'CheckoutError'
    this.code = code
    this.lines = lines
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

function isLineProblem(x: unknown): x is LineProblem {
  const l = x as Record<string, unknown>
  return typeof l === 'object' && l !== null && typeof l.variantId === 'string'
    && (l.code === 'insufficient_stock' || l.code === 'variant_not_found')
}

async function toError(res: Response): Promise<CheckoutError> {
  let body: Record<string, unknown> | null = null
  try { body = (await res.json()) as Record<string, unknown> } catch { /* not JSON */ }
  const code = (typeof body?.code === 'string' && KNOWN.has(body.code) ? body.code : 'checkout_unavailable') as CheckoutErrorCode
  const details = body?.details as { lines?: unknown } | undefined
  const lines = Array.isArray(details?.lines) ? details.lines.filter(isLineProblem) : []
  const message = code === 'checkout_unavailable' ? UNAVAILABLE_MESSAGE
    : code === 'rate_limited' ? RATE_LIMIT_MESSAGE
      : typeof body?.message === 'string' ? body.message : UNAVAILABLE_MESSAGE
  return new CheckoutError(code, message, lines)
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
export function startCheckout(req: StartCheckoutRequest): Promise<{ orderId: string; clientSecret: string }> {
  return request(BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) })
}

export function getCheckoutStatus(sessionId: string): Promise<CheckoutStatus> {
  return request(`${BASE}/status?session_id=${encodeURIComponent(sessionId)}`)
}

export function getCheckoutConfig(): Promise<CheckoutConfig> {
  return request(`${BASE}/config`)
}
