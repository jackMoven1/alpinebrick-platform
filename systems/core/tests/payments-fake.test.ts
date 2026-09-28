import { describe, it, expect } from 'vitest'
import { createFakePaymentsPort, FAKE_NOTIFICATION_URL } from '../src/ports/payments/fake.adapter.js'
import { PaymentAttemptConflictError, PaymentOutcomeUnknownError, DECLINE_MESSAGE } from '../src/ports/payments/payments.port.js'

const input = (over: Record<string, unknown> = {}) => ({
  sourceToken: 'tok_1', amountCents: 1000, idempotencyKey: 'o:1:0', referenceId: 'o', buyerEmail: 'b@example.com',
  shippingAddress: { name: 'A', line1: '1', line2: null, city: 'C', state: 'MI', postalCode: '49684' }, ...over,
})

describe('fake Square', () => {
  it('replays the first result for the same key and token, like Square', async () => {
    const fake = createFakePaymentsPort()
    const a = await fake.charge(input())
    const b = await fake.charge(input())
    expect(b).toEqual(a)
    expect(fake.payments.size).toBe(1)
  })

  it('refuses the same key with a different token', async () => {
    const fake = createFakePaymentsPort()
    await fake.charge(input())
    await expect(fake.charge(input({ sourceToken: 'tok_2' }))).rejects.toBeInstanceOf(PaymentAttemptConflictError)
  })

  it('follows queued outcomes: declined, then a lost response that did charge', async () => {
    const fake = createFakePaymentsPort()
    fake.nextOutcomes = ['declined', 'lost']
    expect(await fake.charge(input())).toEqual({ outcome: 'declined', code: 'GENERIC_DECLINE', message: DECLINE_MESSAGE })
    await expect(fake.charge(input({ idempotencyKey: 'o:1:1' }))).rejects.toThrow(/lost/)
    expect(fake.paymentFor('o').status).toBe('COMPLETED')
    expect(await fake.charge(input({ idempotencyKey: 'o:1:1' }))).toMatchObject({ outcome: 'completed' })
  })

  // Ruling Q-P10: the three failure classes checkout must tell apart.
  it('reports a definite failure as a result, and creates no payment', async () => {
    const fake = createFakePaymentsPort()
    fake.nextOutcomes = ['failed']
    expect(await fake.charge(input())).toMatchObject({ outcome: 'failed', statusCode: 400 })
    expect(fake.payments.size).toBe(0)
  })

  it('throws PaymentOutcomeUnknownError for lost and unavailable', async () => {
    const fake = createFakePaymentsPort()
    fake.nextOutcomes = ['lost', 'unavailable']
    await expect(fake.charge(input())).rejects.toBeInstanceOf(PaymentOutcomeUnknownError)
    await expect(fake.charge(input({ idempotencyKey: 'o:1:1' }))).rejects.toBeInstanceOf(PaymentOutcomeUnknownError)
    expect(fake.payments.size).toBe(1) // lost charged; unavailable did not
  })

  it('signs payloads over the notification URL', () => {
    const fake = createFakePaymentsPort()
    const body = '{"event_id":"e"}'
    expect(() => fake.verifyWebhook(Buffer.from(body), fake.sign(body))).not.toThrow()
    expect(() => fake.verifyWebhook(Buffer.from(body), fake.sign(body, `${FAKE_NOTIFICATION_URL}x`))).toThrow()
  })
})
