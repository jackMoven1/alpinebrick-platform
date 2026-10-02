import { PaymentsUnavailableError, WebhookSignatureError, type PaymentsPort } from './payments.port.js'
import { createStripePaymentsPort } from './stripe.adapter.js'

const STRIPE_KEYS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] as const

/** No Stripe keys: checkout and the webhook answer 503, nothing else is affected. */
export const unconfiguredPaymentsPort: PaymentsPort = {
  configured: false,
  livemode: false,
  async createCheckoutSession() { throw new PaymentsUnavailableError() },
  async expireCheckoutSession() { throw new PaymentsUnavailableError() },
  async retrieveCheckoutSession() { throw new PaymentsUnavailableError() },
  constructWebhookEvent() { throw new WebhookSignatureError('payments are not configured') },
}

/**
 * Picks the payments adapter at startup (spec §8). Half-configured refuses to
 * start, naming each missing key: a deploy with the secret key but no webhook
 * secret would take money and never mark an order paid.
 */
export function createPaymentsPort(env: NodeJS.ProcessEnv = process.env): PaymentsPort {
  const present = STRIPE_KEYS.filter((k) => env[k])
  if (present.length === 0) return unconfiguredPaymentsPort
  const missing: string[] = STRIPE_KEYS.filter((k) => !env[k])
  if (!env.STOREFRONT_PUBLIC_URL) missing.push('STOREFRONT_PUBLIC_URL')
  if (missing.length > 0) throw new Error(`Stripe is half-configured; missing: ${missing.join(', ')}`)
  return createStripePaymentsPort({ secretKey: env.STRIPE_SECRET_KEY!, webhookSecret: env.STRIPE_WEBHOOK_SECRET! })
}
