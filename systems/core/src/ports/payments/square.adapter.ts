import { SquareClient, SquareEnvironment, SquareError, SquareTimeoutError } from 'square'
import {
  SQUARE_API_VERSION, PaymentAttemptConflictError, PaymentOutcomeUnknownError, declineMessage,
  type PaymentsPort, type ShipToAddress, type RefundSummary,
} from './payments.port.js'
import { verifySquareSignature } from './webhook-signature.js'

export interface SquareConfig {
  environment: 'sandbox' | 'production'
  accessToken: string
  locationId: string
  webhookSignatureKey: string
  /** Exactly the URL registered on the webhook subscription (spec §3). */
  webhookNotificationUrl: string
}

/** The slice of SquareClient the adapter calls. Tests pass a stub. */
export interface SquareApi {
  payments: Pick<SquareClient['payments'], 'create' | 'get'>
  refunds: Pick<SquareClient['refunds'], 'get'>
}

/** Codes that mean "this token cannot be charged; ask for the card again". */
const TOKEN_CODES: ReadonlySet<string> = new Set(['CARD_TOKEN_EXPIRED', 'CARD_TOKEN_USED', 'SOURCE_USED', 'SOURCE_EXPIRED', 'INVALID_CARD_DATA'])

const cents = (amount: bigint | null | undefined): number => Number(amount ?? 0n)
/** A COMPLETED payment's amount in USD cents, or null when it has none or another currency (ruling F-R2). */
const usdCents = (money: { amount?: bigint | null; currency?: string | null } | null | undefined): number | null =>
  money?.amount != null && money.currency === 'USD' ? Number(money.amount) : null

/**
 * SquareError.message embeds the whole response body, which can carry the
 * buyer's email and address. Nothing above this adapter ever sees it: every
 * failure is reduced to a message naming only the status and codes.
 */
function describeFailure(err: unknown): string {
  if (err instanceof SquareError) {
    return `Square request failed (${err.statusCode ?? 'no status'}): ${err.errors.map((e) => e.code).join(', ')}`
  }
  if (err instanceof SquareTimeoutError) return 'Square request timed out'
  // Anything else (a fetch or socket error) is named by its class only: its
  // message is not ours and could carry anything, including buyer details.
  return `Square request failed: ${err instanceof Error ? err.name : 'non-Error thrown'}`
}

function sanitize(err: unknown): Error {
  return new Error(describeFailure(err))
}

/**
 * Ruling Q-P10: a 4xx Square answered means no payment was created. 408 is
 * the exception -- it is a timeout, and the SDK retries it like a 5xx -- so
 * it joins the unknown outcomes with 5xx, timeouts and network errors.
 */
function isDefinite4xx(err: SquareError): err is SquareError & { statusCode: number } {
  return err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 408
}

function toSquareAddress(a: ShipToAddress) {
  return {
    firstName: a.name,
    addressLine1: a.line1,
    ...(a.line2 ? { addressLine2: a.line2 } : {}),
    locality: a.city,
    administrativeDistrictLevel1: a.state,
    postalCode: a.postalCode,
    country: 'US' as const,
  }
}

export function createSquarePaymentsPort(
  config: SquareConfig,
  client: SquareApi = new SquareClient({
    token: config.accessToken,
    environment: config.environment === 'production' ? SquareEnvironment.Production : SquareEnvironment.Sandbox,
    version: SQUARE_API_VERSION,
    timeoutInSeconds: 20,
    // The SDK retries 408/429/5xx with the same body -- same idempotency key.
    maxRetries: 2,
  }),
): PaymentsPort {
  return {
    configured: true,
    locationId: config.locationId,

    async charge(input) {
      // A bad amount is our bug, not an unknown outcome: nothing is sent to Square.
      if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
        throw new Error(`charge: amountCents must be a positive safe integer, got ${input.amountCents}`)
      }
      let payment
      try {
        const res = await client.payments.create({
          sourceId: input.sourceToken,
          idempotencyKey: input.idempotencyKey,
          amountMoney: { amount: BigInt(input.amountCents), currency: 'USD' },
          autocomplete: true,
          locationId: config.locationId,
          referenceId: input.referenceId,
          buyerEmailAddress: input.buyerEmail,
          shippingAddress: toSquareAddress(input.shippingAddress),
        })
        payment = res.payment
      } catch (err) {
        if (err instanceof SquareError && isDefinite4xx(err)) {
          if (err.errors.some((e) => e.code === 'IDEMPOTENCY_KEY_REUSED')) throw new PaymentAttemptConflictError()
          const decline = err.errors.find((e) => e.category === 'PAYMENT_METHOD_ERROR' || TOKEN_CODES.has(e.code))
          if (decline) return { outcome: 'declined', code: decline.code, message: declineMessage(decline.code) }
          return {
            outcome: 'failed', statusCode: err.statusCode,
            code: err.errors.map((e) => e.code).join(', '), reason: describeFailure(err),
          }
        }
        throw new PaymentOutcomeUnknownError(describeFailure(err))
      }
      if (!payment?.id) throw new PaymentOutcomeUnknownError('Square returned no payment')
      if (payment.status === 'COMPLETED') {
        return { outcome: 'completed', paymentId: payment.id, amountCents: usdCents(payment.amountMoney) }
      }
      if (payment.status === 'FAILED' || payment.status === 'CANCELED') {
        return { outcome: 'declined', code: payment.status, message: declineMessage(payment.status), paymentId: payment.id }
      }
      // APPROVED or PENDING: not expected for cards (spec §2 step 5.6); the webhook finishes it.
      return { outcome: 'processing', paymentId: payment.id, status: payment.status ?? 'UNKNOWN' }
    },

    async getPayment(paymentId) {
      let payment
      try { payment = (await client.payments.get({ paymentId })).payment } catch (err) { throw sanitize(err) }
      if (!payment?.id) throw new Error(`Square returned no payment for ${paymentId}`)
      return {
        id: payment.id, status: payment.status ?? 'UNKNOWN', amountCents: cents(payment.amountMoney?.amount),
        currency: payment.amountMoney?.currency ?? null,
        referenceId: payment.referenceId ?? null, locationId: payment.locationId ?? null,
      }
    },

    // square@46.0.0 has no per-payment refund listing; RefundsApi.list filters
    // by location and time only. A payment carries at most 20 refund ids.
    async listPaymentRefunds(paymentId) {
      try {
        const { payment } = await client.payments.get({ paymentId })
        const out: RefundSummary[] = []
        for (const refundId of payment?.refundIds ?? []) {
          const { refund } = await client.refunds.get({ refundId })
          if (refund) out.push({ id: refund.id, status: refund.status ?? 'UNKNOWN', amountCents: cents(refund.amountMoney.amount) })
        }
        return out
      } catch (err) { throw sanitize(err) }
    },

    verifyWebhook(rawBody, signature) {
      verifySquareSignature(rawBody, signature, config.webhookSignatureKey, config.webhookNotificationUrl)
    },
  }
}
