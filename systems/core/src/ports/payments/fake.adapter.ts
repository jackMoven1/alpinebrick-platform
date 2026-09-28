import {
  DECLINE_MESSAGE, PaymentAttemptConflictError, PaymentOutcomeUnknownError,
  type ChargeInput, type ChargeResult, type PaymentSummary, type PaymentsPort, type RefundSummary,
} from './payments.port.js'
import { squareSignature, verifySquareSignature } from './webhook-signature.js'

export const FAKE_SIGNATURE_KEY = 'fake-square-signature-key'
export const FAKE_NOTIFICATION_URL = 'https://api-staging.alpinebrickexchange.com/api/v1/webhooks/square'
export const FAKE_LOCATION_ID = 'LFAKEONLINE'

/**
 * - completed / declined / processing: Square's three payment answers.
 * - failed: Square answered a non-decline 4xx; no payment (ruling Q-P10).
 * - lost: Square charged, then the response never arrived (the charge is
 *   recorded under the key, and charge() throws PaymentOutcomeUnknownError).
 * - unavailable: the request never reached Square (nothing recorded; throws
 *   PaymentOutcomeUnknownError -- core cannot tell this from lost).
 */
export type FakeOutcome = 'completed' | 'declined' | 'processing' | 'failed' | 'lost' | 'unavailable'

export interface FakePaymentsPort extends PaymentsPort {
  charges: ChargeInput[]
  /** Outcomes for the next charges that reach "Square"; empty means completed. */
  nextOutcomes: FakeOutcome[]
  payments: Map<string, PaymentSummary>
  refunds: Map<string, RefundSummary[]>
  /** Runs once, inside the next charge, before it answers: races the sweep or an admin against a charge. */
  duringCharge: (() => Promise<void>) | null
  addRefund(paymentId: string, refund: RefundSummary): void
  /** The Square payment taken for `orderId` (by reference id). Throws if none. */
  paymentFor(orderId: string): PaymentSummary
  /** A valid x-square-hmacsha256-signature for `payload` (over `notificationUrl`). */
  sign(payload: string, notificationUrl?: string): string
}

/**
 * In-memory Square with Square's idempotency semantics: the same key and the
 * same token replay the first result; the same key with a different token is
 * refused. Signatures use the real HMAC helper, so webhook tests exercise
 * genuine verification.
 */
export function createFakePaymentsPort(): FakePaymentsPort {
  const byKey = new Map<string, { token: string; result: ChargeResult }>()
  let n = 0
  const fake: FakePaymentsPort = {
    configured: true,
    locationId: FAKE_LOCATION_ID,
    charges: [],
    nextOutcomes: [],
    payments: new Map(),
    refunds: new Map(),
    duringCharge: null,

    async charge(input) {
      fake.charges.push(input)
      const prior = byKey.get(input.idempotencyKey)
      if (prior) {
        if (prior.token !== input.sourceToken) throw new PaymentAttemptConflictError()
        return prior.result
      }
      if (fake.duringCharge) {
        const hook = fake.duringCharge
        fake.duringCharge = null
        await hook()
      }
      const next = fake.nextOutcomes.shift() ?? 'completed'
      if (next === 'unavailable') throw new PaymentOutcomeUnknownError('square is down (fake)')
      let result: ChargeResult
      if (next === 'declined') {
        result = { outcome: 'declined', code: 'GENERIC_DECLINE', message: DECLINE_MESSAGE }
      } else if (next === 'failed') {
        result = { outcome: 'failed', statusCode: 400, code: 'INVALID_VALUE', reason: 'Square request failed (400): INVALID_VALUE' }
      } else {
        const id = `sqpay_fake_${++n}`
        const status = next === 'processing' ? 'PENDING' : 'COMPLETED'
        fake.payments.set(id, { id, status, amountCents: input.amountCents, referenceId: input.referenceId, locationId: FAKE_LOCATION_ID })
        result = status === 'COMPLETED'
          ? { outcome: 'completed', paymentId: id, amountCents: input.amountCents }
          : { outcome: 'processing', paymentId: id, status }
      }
      byKey.set(input.idempotencyKey, { token: input.sourceToken, result })
      if (next === 'lost') throw new PaymentOutcomeUnknownError('response lost after Square charged (fake)')
      return result
    },

    async getPayment(paymentId) {
      const p = fake.payments.get(paymentId)
      if (!p) throw new Error(`no such payment ${paymentId} (fake)`)
      return p
    },

    async listPaymentRefunds(paymentId) {
      return fake.refunds.get(paymentId) ?? []
    },

    verifyWebhook(rawBody, signature) {
      verifySquareSignature(rawBody, signature, FAKE_SIGNATURE_KEY, FAKE_NOTIFICATION_URL)
    },

    addRefund(paymentId, refund) {
      const list = (fake.refunds.get(paymentId) ?? []).filter((r) => r.id !== refund.id)
      fake.refunds.set(paymentId, [...list, refund])
    },

    paymentFor(orderId) {
      const p = [...fake.payments.values()].find((x) => x.referenceId === orderId)
      if (!p) throw new Error(`no payment for order ${orderId} (fake)`)
      return p
    },

    sign(payload, notificationUrl = FAKE_NOTIFICATION_URL) {
      return squareSignature(notificationUrl, Buffer.from(payload, 'utf8'), FAKE_SIGNATURE_KEY)
    },
  }
  return fake
}
