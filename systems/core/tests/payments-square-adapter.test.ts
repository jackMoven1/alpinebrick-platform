import { describe, it, expect, vi } from 'vitest'
import { SquareError, SquareTimeoutError, WebhooksHelper } from 'square'
import { createSquarePaymentsPort, type SquareApi } from '../src/ports/payments/square.adapter.js'
import {
  SQUARE_API_VERSION, DECLINE_MESSAGE, PaymentAttemptConflictError, PaymentOutcomeUnknownError, WebhookSignatureError,
} from '../src/ports/payments/payments.port.js'
import { squareSignature } from '../src/ports/payments/webhook-signature.js'

const CONFIG = {
  environment: 'sandbox' as const,
  accessToken: 'sq-access-token-unused-placeholder',
  locationId: 'LONLINE',
  webhookSignatureKey: 'adapter-test-signature-key',
  webhookNotificationUrl: 'https://api-staging.alpinebrickexchange.com/api/v1/webhooks/square',
}

const INPUT = {
  sourceToken: 'cnon:card-nonce-ok', amountCents: 11593, idempotencyKey: 'ord_1:1:0', referenceId: 'ord_1',
  buyerEmail: 'buyer@example.com',
  shippingAddress: { name: 'Ann Buyer', line1: '1 Main St', line2: 'Apt 2', city: 'Traverse City', state: 'MI', postalCode: '49684' },
}

type AnyAsync = (...args: any[]) => Promise<unknown>
function stub(over: { create?: AnyAsync; get?: AnyAsync; refundGet?: AnyAsync } = {}) {
  const create = vi.fn<AnyAsync>(over.create ?? (async () => ({
    payment: { id: 'sqpay_1', status: 'COMPLETED', amountMoney: { amount: 11593n, currency: 'USD' } },
  })))
  const get = vi.fn<AnyAsync>(over.get ?? (async () => ({ payment: { id: 'sqpay_1', status: 'COMPLETED', amountMoney: { amount: 11593n }, referenceId: 'ord_1', locationId: 'LONLINE', refundIds: [] } })))
  const refundGet = vi.fn<AnyAsync>(over.refundGet ?? (async () => ({ refund: null })))
  const client = { payments: { create, get }, refunds: { get: refundGet } } as unknown as SquareApi
  return { client, create, get, refundGet }
}

const squareError = (statusCode: number | undefined, errors: { category: string; code: string; detail?: string }[]) =>
  new SquareError({ statusCode, body: { errors, payment: { buyer_email_address: 'buyer@example.com' } } })

const throwing = (err: unknown) => stub({ create: async () => { throw err } })

describe('Square payments adapter', () => {
  it('pins the API version square@46.0.0 is typed for', () => {
    expect(SQUARE_API_VERSION).toBe('2026-09-16')
  })

  it('charges the quoted total at the Online location, with no Square Order, and reports COMPLETED', async () => {
    const { client, create } = stub()
    const port = createSquarePaymentsPort(CONFIG, client)
    expect(await port.charge(INPUT)).toEqual({ outcome: 'completed', paymentId: 'sqpay_1', amountCents: 11593 })
    expect(create).toHaveBeenCalledWith({
      sourceId: 'cnon:card-nonce-ok',
      idempotencyKey: 'ord_1:1:0',
      amountMoney: { amount: 11593n, currency: 'USD' },
      autocomplete: true,
      locationId: 'LONLINE',
      referenceId: 'ord_1',
      buyerEmailAddress: 'buyer@example.com',
      shippingAddress: {
        firstName: 'Ann Buyer', addressLine1: '1 Main St', addressLine2: 'Apt 2', locality: 'Traverse City',
        administrativeDistrictLevel1: 'MI', postalCode: '49684', country: 'US',
      },
    })
    expect(create.mock.calls[0][0]).not.toHaveProperty('orderId') // Q5: payments only
  })

  it('reports APPROVED or PENDING as processing', async () => {
    const { client } = stub({ create: async () => ({ payment: { id: 'sqpay_2', status: 'APPROVED', amountMoney: { amount: 1n } } }) })
    expect(await createSquarePaymentsPort(CONFIG, client).charge(INPUT)).toEqual({ outcome: 'processing', paymentId: 'sqpay_2', status: 'APPROVED' })
  })

  it.each(['FAILED', 'CANCELED'])('reports a 200 whose payment is %s as declined, with our copy', async (status) => {
    const { client } = stub({ create: async () => ({ payment: { id: 'sqpay_3', status, amountMoney: { amount: 11593n } } }) })
    expect(await createSquarePaymentsPort(CONFIG, client).charge(INPUT)).toEqual({ outcome: 'declined', code: status, message: DECLINE_MESSAGE })
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])('refuses amountCents %s as a programming error, before calling Square', async (amountCents) => {
    const { client, create } = stub()
    const err = await createSquarePaymentsPort(CONFIG, client).charge({ ...INPUT, amountCents }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(PaymentOutcomeUnknownError)
    expect(err.message).toMatch(/amountCents/)
    expect(create).not.toHaveBeenCalled()
  })

  it('turns a card decline into declined with our buyer-safe copy, not Square detail text', async () => {
    const { client } = stub({ create: async () => { throw squareError(402, [{ category: 'PAYMENT_METHOD_ERROR', code: 'GENERIC_DECLINE', detail: "Authorization error: 'GENERIC_DECLINE'" }]) } })
    expect(await createSquarePaymentsPort(CONFIG, client).charge(INPUT)).toEqual({ outcome: 'declined', code: 'GENERIC_DECLINE', message: DECLINE_MESSAGE })
  })

  it('names a CVV mismatch and a used token specifically', async () => {
    const cvv = stub({ create: async () => { throw squareError(400, [{ category: 'PAYMENT_METHOD_ERROR', code: 'CVV_FAILURE' }]) } })
    expect((await createSquarePaymentsPort(CONFIG, cvv.client).charge(INPUT))).toMatchObject({ outcome: 'declined', message: 'The security code did not match — check it and try again.' })
    const used = stub({ create: async () => { throw squareError(400, [{ category: 'INVALID_REQUEST_ERROR', code: 'CARD_TOKEN_USED' }]) } })
    expect((await createSquarePaymentsPort(CONFIG, used.client).charge(INPUT))).toMatchObject({ outcome: 'declined', message: 'Please re-enter your card details and try again.' })
  })

  it('raises PaymentAttemptConflictError when Square refuses a reused idempotency key', async () => {
    const { client } = stub({ create: async () => { throw squareError(400, [{ category: 'INVALID_REQUEST_ERROR', code: 'IDEMPOTENCY_KEY_REUSED' }]) } })
    await expect(createSquarePaymentsPort(CONFIG, client).charge(INPUT)).rejects.toBeInstanceOf(PaymentAttemptConflictError)
  })

  // Ruling Q-P10: a non-decline 4xx means Square created no payment -- a
  // definite failure, returned (not thrown) so checkout can clear the attempt.
  describe('definite failures (non-decline 4xx)', () => {
    it.each([
      [401, 'AUTHENTICATION_ERROR', 'UNAUTHORIZED'],
      [400, 'INVALID_REQUEST_ERROR', 'INVALID_VALUE'],
      [429, 'RATE_LIMIT_ERROR', 'RATE_LIMITED'],
    ])('reports %i %s as failed, WITHOUT the response body (it can hold the buyer email and address)', async (status, category, code) => {
      const result = await createSquarePaymentsPort(CONFIG, throwing(squareError(status, [{ category, code }])).client).charge(INPUT)
      expect(result).toEqual({ outcome: 'failed', statusCode: status, code, reason: `Square request failed (${status}): ${code}` })
      expect(JSON.stringify(result)).not.toContain('buyer@example.com')
    })
  })

  // Ruling Q-P10: no status, a timeout, 408 or 5xx (after the SDK's retries)
  // means Square may have charged. Thrown, sanitized, never a result.
  describe('unknown outcomes', () => {
    it.each([
      ['a 500', squareError(500, [{ category: 'API_ERROR', code: 'INTERNAL_SERVER_ERROR' }]), 'Square request failed (500): INTERNAL_SERVER_ERROR'],
      ['a 503', squareError(503, [{ category: 'API_ERROR', code: 'SERVICE_UNAVAILABLE' }]), 'Square request failed (503): SERVICE_UNAVAILABLE'],
      ['a 408', squareError(408, [{ category: 'API_ERROR', code: 'REQUEST_TIMEOUT' }]), 'Square request failed (408): REQUEST_TIMEOUT'],
      ['a network error (no status)', new SquareError({ message: 'fetch failed for buyer@example.com', cause: new TypeError('fetch failed') }), 'Square request failed (no status): Unknown'],
      ['a timeout', new SquareTimeoutError('Timeout exceeded when calling POST /v2/payments.'), 'Square request timed out'],
      ['a non-Square error (its name only; the message could carry anything)', new TypeError('socket hang up for buyer@example.com'), 'Square request failed: TypeError'],
    ])('throws PaymentOutcomeUnknownError on %s, without the response body', async (_label, thrown, message) => {
      const err = await createSquarePaymentsPort(CONFIG, throwing(thrown).client).charge(INPUT).catch((e) => e)
      expect(err).toBeInstanceOf(PaymentOutcomeUnknownError)
      expect(err.message).toBe(message)
      expect(err.message).not.toContain('buyer@example.com')
    })

    it('treats a 2xx without a payment as unknown (Square may have charged)', async () => {
      const { client } = stub({ create: async () => ({}) })
      await expect(createSquarePaymentsPort(CONFIG, client).charge(INPUT)).rejects.toBeInstanceOf(PaymentOutcomeUnknownError)
    })
  })

  it('reads a payment', async () => {
    const { client, get } = stub()
    expect(await createSquarePaymentsPort(CONFIG, client).getPayment('sqpay_1')).toEqual({
      id: 'sqpay_1', status: 'COMPLETED', amountCents: 11593, referenceId: 'ord_1', locationId: 'LONLINE',
    })
    expect(get).toHaveBeenCalledWith({ paymentId: 'sqpay_1' })
  })

  it('rethrows a failed read WITHOUT the response body', async () => {
    const { client } = stub({ get: async () => { throw squareError(404, [{ category: 'INVALID_REQUEST_ERROR', code: 'NOT_FOUND' }]) } })
    const err = await createSquarePaymentsPort(CONFIG, client).getPayment('sqpay_x').catch((e) => e)
    expect(err.message).toBe('Square request failed (404): NOT_FOUND')
  })

  it('lists a payment’s refunds through payment.refundIds', async () => {
    const refunds: Record<string, unknown> = {
      r1: { id: 'r1', status: 'COMPLETED', amountMoney: { amount: 500n } },
      r2: { id: 'r2', status: 'PENDING', amountMoney: { amount: 700n } },
    }
    const { client, refundGet } = stub({
      get: async () => ({ payment: { id: 'sqpay_1', refundIds: ['r1', 'r2'] } }),
      refundGet: async ({ refundId }: { refundId: string }) => ({ refund: refunds[refundId] }),
    })
    expect(await createSquarePaymentsPort(CONFIG, client).listPaymentRefunds('sqpay_1')).toEqual([
      { id: 'r1', status: 'COMPLETED', amountCents: 500 },
      { id: 'r2', status: 'PENDING', amountCents: 700 },
    ])
    expect(refundGet).toHaveBeenCalledTimes(2)
  })

  describe('webhook signature', () => {
    const body = Buffer.from('{"event_id":"e1","type":"payment.updated"}')
    const port = createSquarePaymentsPort(CONFIG, stub().client)

    it('matches Square’s own WebhooksHelper', async () => {
      const sig = squareSignature(CONFIG.webhookNotificationUrl, body, CONFIG.webhookSignatureKey)
      expect(await WebhooksHelper.verifySignature({
        requestBody: body.toString('utf8'), signatureHeader: sig,
        signatureKey: CONFIG.webhookSignatureKey, notificationUrl: CONFIG.webhookNotificationUrl,
      })).toBe(true)
      expect(() => port.verifyWebhook(body, sig)).not.toThrow()
    })

    it('rejects a signature over another URL, a tampered body, and a wrong-length header', () => {
      const otherUrl = squareSignature('https://evil.example/hook', body, CONFIG.webhookSignatureKey)
      expect(() => port.verifyWebhook(body, otherUrl)).toThrow(WebhookSignatureError)
      const sig = squareSignature(CONFIG.webhookNotificationUrl, body, CONFIG.webhookSignatureKey)
      expect(() => port.verifyWebhook(Buffer.from('{"event_id":"e2"}'), sig)).toThrow(WebhookSignatureError)
      expect(() => port.verifyWebhook(body, 'short')).toThrow(WebhookSignatureError)
    })
  })
})
