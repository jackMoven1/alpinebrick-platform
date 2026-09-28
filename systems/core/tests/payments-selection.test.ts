import { describe, it, expect, vi, afterEach } from 'vitest'
import { createPaymentsPort, SQUARE_KEYS } from '../src/ports/payments/index.js'
import { PaymentsUnavailableError, WebhookSignatureError } from '../src/ports/payments/payments.port.js'

const FULL = {
  SQUARE_ENVIRONMENT: 'sandbox',
  SQUARE_ACCESS_TOKEN: 'sq-access-token-unused-placeholder',
  SQUARE_LOCATION_ID: 'LONLINE',
  SQUARE_WEBHOOK_SIGNATURE_KEY: 'selection-test-signature-key',
  SQUARE_WEBHOOK_NOTIFICATION_URL: 'https://api-staging.alpinebrickexchange.com/api/v1/webhooks/square',
}
afterEach(() => vi.restoreAllMocks())

describe('createPaymentsPort', () => {
  it('is unconfigured, not broken, when no Square key is set', async () => {
    const port = createPaymentsPort({})
    expect(port.configured).toBe(false)
    expect(port.locationId).toBeNull()
    await expect(port.getPayment('x')).rejects.toBeInstanceOf(PaymentsUnavailableError)
    expect(() => port.verifyWebhook(Buffer.from('{}'), 'x')).toThrow(WebhookSignatureError)
  })

  it.each(SQUARE_KEYS.map((k) => [k]))('refuses to start without %s when the others are set, naming it', (missing) => {
    const env: Record<string, string> = { ...FULL }
    delete env[missing]
    expect(() => createPaymentsPort(env)).toThrow(new RegExp(`Square is half-configured; missing: ${missing}`))
  })

  it('names every missing key when several are missing', () => {
    const { SQUARE_ACCESS_TOKEN: _t, SQUARE_WEBHOOK_SIGNATURE_KEY: _k, SQUARE_WEBHOOK_NOTIFICATION_URL: _u, ...partial } = FULL
    expect(() => createPaymentsPort(partial)).toThrow(
      'Square is half-configured; missing: SQUARE_ACCESS_TOKEN, SQUARE_WEBHOOK_SIGNATURE_KEY, SQUARE_WEBHOOK_NOTIFICATION_URL',
    )
  })

  it('refuses an unknown SQUARE_ENVIRONMENT and a non-https notification URL', () => {
    expect(() => createPaymentsPort({ ...FULL, SQUARE_ENVIRONMENT: 'live' })).toThrow(/sandbox or production/)
    expect(() => createPaymentsPort({ ...FULL, SQUARE_WEBHOOK_NOTIFICATION_URL: 'http://x.example/h' })).toThrow(/https/)
  })

  it('builds the Square adapter when fully configured', () => {
    const port = createPaymentsPort(FULL)
    expect(port.configured).toBe(true)
    expect(port.locationId).toBe('LONLINE')
  })

  it('warns about leftover Stripe keys instead of failing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createPaymentsPort({ ...FULL, STRIPE_SECRET_KEY: 'x' })
    expect(warn.mock.calls.join(' ')).toContain('STRIPE_')
  })
})
