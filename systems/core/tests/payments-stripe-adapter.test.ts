import { describe, it, expect, vi } from 'vitest'
import Stripe from 'stripe'
import {
  createStripePaymentsPort,
} from '../src/ports/payments/stripe.adapter.js'
import { WebhookSignatureError, STRIPE_API_VERSION } from '../src/ports/payments/payments.port.js'

const SECRET = 'whsec_adapter_test'
// Offline instance used only for its webhook helpers. Not a key.
const offline = new Stripe('sk_test_unused_placeholder')

function mockClient() {
  const sessions = {
    create: vi.fn(async (_p: Stripe.Checkout.SessionCreateParams) => ({ id: 'cs_test_1', client_secret: 'cs_test_1_secret_abc' })),
    expire: vi.fn(async () => ({ id: 'cs_test_1', status: 'expired' })),
    retrieve: vi.fn(async () => ({ id: 'cs_test_1', status: 'complete', payment_status: 'paid' })),
  }
  const client = { checkout: { sessions }, webhooks: offline.webhooks } as unknown as Stripe
  return { client, sessions }
}

const INPUT = {
  orderId: 'ord_1',
  lines: [{ name: 'Brick Builder Set', unitAmountCents: 4999, quantity: 2 }],
  shippingOptions: [{ displayName: 'Standard shipping', amountCents: 995 }],
  expiresAt: new Date('2026-10-01T12:31:00Z'),
  returnUrl: 'https://staging.alpinebrickexchange.com/order/complete?session_id={CHECKOUT_SESSION_ID}',
}

describe('Stripe payments adapter', () => {
  it('pins the API version the SDK was verified against', () => {
    expect(STRIPE_API_VERSION).toBe('2026-08-26.dahlia')
  })

  it('creates an embedded_page session with tax, US shipping and card only', async () => {
    const { client, sessions } = mockClient()
    const port = createStripePaymentsPort({ secretKey: 'sk_test_unused_placeholder', webhookSecret: SECRET }, client)
    expect(await port.createCheckoutSession(INPUT)).toEqual({ sessionId: 'cs_test_1', clientSecret: 'cs_test_1_secret_abc' })
    expect(sessions.create).toHaveBeenCalledWith({
      ui_mode: 'embedded_page',
      mode: 'payment',
      line_items: [{
        quantity: 2,
        price_data: {
          currency: 'usd', unit_amount: 4999, tax_behavior: 'exclusive',
          product_data: { name: 'Brick Builder Set', tax_code: 'txcd_99999999' },
        },
      }],
      automatic_tax: { enabled: true },
      shipping_address_collection: { allowed_countries: ['US'] },
      shipping_options: [{
        shipping_rate_data: {
          type: 'fixed_amount', display_name: 'Standard shipping',
          fixed_amount: { amount: 995, currency: 'usd' },
          tax_behavior: 'exclusive', tax_code: 'txcd_92010001',
        },
      }],
      payment_method_types: ['card'],
      custom_text: { shipping_address: { message: 'We ship to the contiguous US only.' } },
      expires_at: Math.floor(INPUT.expiresAt.getTime() / 1000),
      client_reference_id: 'ord_1',
      metadata: { orderId: 'ord_1' },
      payment_intent_data: { metadata: { orderId: 'ord_1' } },
      return_url: INPUT.returnUrl,
    })
  })

  it('reports an already-completed session instead of failing to expire it', async () => {
    const { client, sessions } = mockClient()
    sessions.expire.mockRejectedValueOnce(new Error('session is not open'))
    const port = createStripePaymentsPort({ secretKey: 'sk_test_unused_placeholder', webhookSecret: SECRET }, client)
    expect(await port.expireCheckoutSession('cs_test_1')).toBe('complete')
  })

  it('maps a retrieved session', async () => {
    const { client } = mockClient()
    const port = createStripePaymentsPort({ secretKey: 'sk_test_unused_placeholder', webhookSecret: SECRET }, client)
    expect(await port.retrieveCheckoutSession('cs_test_1')).toEqual({ id: 'cs_test_1', status: 'complete', paymentStatus: 'paid' })
  })

  it('verifies a correctly signed payload and rejects a tampered one', () => {
    const { client } = mockClient()
    const port = createStripePaymentsPort({ secretKey: 'sk_test_unused_placeholder', webhookSecret: SECRET }, client)
    const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'checkout.session.expired', data: { object: {} } })
    const header = offline.webhooks.generateTestHeaderString({ payload, secret: SECRET })
    expect(port.constructWebhookEvent(Buffer.from(payload), header).id).toBe('evt_1')
    expect(() => port.constructWebhookEvent(Buffer.from(payload.replace('evt_1', 'evt_2')), header))
      .toThrow(WebhookSignatureError)
  })

  it('knows test mode from the key prefix', () => {
    const { client } = mockClient()
    expect(createStripePaymentsPort({ secretKey: 'sk_test_unused_placeholder', webhookSecret: SECRET }, client).livemode).toBe(false)
    expect(createStripePaymentsPort({ secretKey: 'sk_live_unused_placeholder', webhookSecret: SECRET }, client).livemode).toBe(true)
  })
})
