/**
 * square@46.0.0 is generated for this Square API version; its client option
 * `version` is typed as exactly this literal (plan header, verified 2026-09-28).
 * The webhook subscription must be pinned to the same version (runbook §3).
 */
export const SQUARE_API_VERSION = '2026-09-16' as const

export interface ShipToAddress {
  name: string
  line1: string
  line2: string | null
  city: string
  state: string
  postalCode: string
}

export interface ChargeInput {
  /** The Web Payments SDK token (card or wallet). Single use. */
  sourceToken: string
  amountCents: number
  /** `<orderId>:<quoteVersion>:<attemptCount>`; Square allows at most 45 characters. */
  idempotencyKey: string
  /** Our order id, Square's `reference_id` (at most 40 characters). */
  referenceId: string
  buyerEmail: string
  shippingAddress: ShipToAddress
}

/**
 * What a charge settled to. Every variant is a DEFINITE answer from Square;
 * an unknown outcome is never a result, it is a thrown
 * PaymentOutcomeUnknownError (ruling Q-P10).
 *
 * - completed: money taken.
 * - processing: a payment exists but is not final; the webhook finishes it.
 * - declined: the card was refused. No payment. `message` is buyer-safe copy.
 * - failed: Square answered a 4xx that is not a decline (validation, auth,
 *   rate limit...). No payment was created. `reason` names only the status
 *   and error codes, is for logs, and is never shown to the buyer.
 *
 * `declined` and `failed` both mean "no payment in flight"; only `declined`
 * counts as a card attempt (plan decision 3).
 */
export type ChargeResult =
  | { outcome: 'completed'; paymentId: string; amountCents: number }
  | { outcome: 'processing'; paymentId: string; status: string }
  | { outcome: 'declined'; code: string; message: string }
  | { outcome: 'failed'; statusCode: number; code: string; reason: string }

export interface PaymentSummary {
  id: string
  status: string
  amountCents: number
  referenceId: string | null
  locationId: string | null
}

export interface RefundSummary { id: string; status: string; amountCents: number }

/** No Square keys on this instance. Checkout answers 503. */
export class PaymentsUnavailableError extends Error {
  constructor() { super('payments are not configured'); this.name = 'PaymentsUnavailableError' }
}

/**
 * Square refused the idempotency key because an earlier attempt used it with
 * a different card token. That attempt's outcome is unknown to us; the
 * payment.updated webhook, or the sweep, settles the order (plan decision 3).
 */
export class PaymentAttemptConflictError extends Error {
  constructor() { super('an earlier payment attempt for this order is unresolved'); this.name = 'PaymentAttemptConflictError' }
}

/**
 * The charge may or may not have happened: network error, timeout, 408 or 5xx
 * after the SDK's retries, or a success response with no payment in it. The
 * attempt stays in flight; the webhook or the sweep settles it (ruling Q-P10).
 * The message names only the status and error codes, never the response body.
 */
export class PaymentOutcomeUnknownError extends Error {
  constructor(message: string) { super(message); this.name = 'PaymentOutcomeUnknownError' }
}

export class WebhookSignatureError extends Error {
  constructor(message = 'invalid Square signature') { super(message); this.name = 'WebhookSignatureError' }
}

/** Spec §4 Storefront, verbatim. */
export const DECLINE_MESSAGE = 'Your card was declined — try another card.'
const RETYPE = 'Please re-enter your card details and try again.'
const POSTAL = 'The billing ZIP code did not match — check it and try again.'
const EXPIRY = 'The expiry date is not valid — check it and try again.'
/** Buyer-safe copy per Square error code (plan decision 8). Anything else gets DECLINE_MESSAGE. */
const DECLINE_MESSAGES: Record<string, string> = {
  CVV_FAILURE: 'The security code did not match — check it and try again.',
  ADDRESS_VERIFICATION_FAILURE: POSTAL,
  INVALID_POSTAL_CODE: POSTAL,
  INVALID_EXPIRATION: EXPIRY,
  EXPIRATION_FAILURE: EXPIRY,
  BAD_EXPIRATION: EXPIRY,
  CARD_EXPIRED: 'This card has expired — try another card.',
  CARD_TOKEN_EXPIRED: RETYPE,
  CARD_TOKEN_USED: RETYPE,
  SOURCE_USED: RETYPE,
  SOURCE_EXPIRED: RETYPE,
  INVALID_CARD_DATA: RETYPE,
}
export function declineMessage(code: string): string {
  return DECLINE_MESSAGES[code] ?? DECLINE_MESSAGE
}

/**
 * Everything core asks of the payment provider (spec §4). Unit tests use
 * fake.adapter.ts; the Square adapter has a stubbed-client test and the
 * staging sandbox run.
 */
export interface PaymentsPort {
  readonly configured: boolean
  /** The Square "Online" location (Q7). Webhooks for any other location are not ours. */
  readonly locationId: string | null
  /**
   * Resolves with a definite ChargeResult. Throws PaymentAttemptConflictError
   * (key reused with another token), PaymentOutcomeUnknownError (Square may
   * have charged), or PaymentsUnavailableError (not configured).
   */
  charge(input: ChargeInput): Promise<ChargeResult>
  getPayment(paymentId: string): Promise<PaymentSummary>
  listPaymentRefunds(paymentId: string): Promise<RefundSummary[]>
  /** Throws WebhookSignatureError unless `signature` is the HMAC of notification URL + raw body. */
  verifyWebhook(rawBody: Buffer, signature: string): void
}
