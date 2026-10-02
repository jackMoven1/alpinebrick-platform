import { describe, it, expect } from 'vitest'
import { createPaymentsPort } from '../src/ports/payments/index.js'
import { PaymentsUnavailableError } from '../src/ports/payments/payments.port.js'

const FULL = {
  STRIPE_SECRET_KEY: 'sk_test_unused_placeholder',
  STRIPE_WEBHOOK_SECRET: 'whsec_selection_test',
  STOREFRONT_PUBLIC_URL: 'https://staging.alpinebrickexchange.com',
}

describe('createPaymentsPort', () => {
  it('is unconfigured, not broken, when no Stripe key is set', async () => {
    const port = createPaymentsPort({})
    expect(port.configured).toBe(false)
    await expect(port.retrieveCheckoutSession('cs_x')).rejects.toBeInstanceOf(PaymentsUnavailableError)
  })

  it('refuses to start with only one Stripe key, naming the missing one', () => {
    expect(() => createPaymentsPort({ STRIPE_SECRET_KEY: FULL.STRIPE_SECRET_KEY }))
      .toThrow(/STRIPE_WEBHOOK_SECRET/)
    expect(() => createPaymentsPort({ STRIPE_WEBHOOK_SECRET: FULL.STRIPE_WEBHOOK_SECRET }))
      .toThrow(/STRIPE_SECRET_KEY/)
  })

  it('refuses to start with both keys but no storefront URL for return_url', () => {
    expect(() => createPaymentsPort({ STRIPE_SECRET_KEY: FULL.STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET: FULL.STRIPE_WEBHOOK_SECRET }))
      .toThrow(/STOREFRONT_PUBLIC_URL/)
  })

  it('builds the Stripe adapter when fully configured', () => {
    const port = createPaymentsPort(FULL)
    expect(port.configured).toBe(true)
    expect(port.livemode).toBe(false)
  })
})
