import { parseReferralInput } from '../referrals/referrals.service.js'

export const MAX_LINES = 20
export const MAX_QUANTITY = 10

/** Public checkout error: lower_snake `code`, HTTP `status`, optional `details`. */
export class CheckoutError extends Error {
  constructor(public code: string, message: string, public status: number, public details?: Record<string, unknown>) {
    super(message)
    this.name = 'CheckoutError'
  }
}

export interface CheckoutRequest {
  lines: { variantId: string; quantity: number }[]
  marketingOptIn: boolean
  referral: { code: string; firstSeenAt: Date } | null
  previousOrderId: string | null
}

const invalid = (field: string, message: string) => new CheckoutError('invalid_request', message, 400, { field })

/** Spec §4 step 1. A bad referral is dropped (parseReferralInput -> null), never rejected. */
export function parseCheckoutRequest(body: unknown, now = new Date()): CheckoutRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('body', 'body must be a JSON object')
  const b = body as Record<string, unknown>
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
    previousOrderId: typeof prev === 'string' && prev.length > 0 && prev.length <= 64 ? prev : null,
  }
}
