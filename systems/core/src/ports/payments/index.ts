import { PaymentsUnavailableError, WebhookSignatureError, type PaymentsPort } from './payments.port.js'
import { createSquarePaymentsPort } from './square.adapter.js'

export const SQUARE_KEYS = [
  'SQUARE_ENVIRONMENT', 'SQUARE_ACCESS_TOKEN', 'SQUARE_LOCATION_ID',
  'SQUARE_WEBHOOK_SIGNATURE_KEY', 'SQUARE_WEBHOOK_NOTIFICATION_URL',
] as const

/** No Square keys: checkout and the webhook answer 503; nothing else is affected. */
export const unconfiguredPaymentsPort: PaymentsPort = {
  configured: false,
  locationId: null,
  async charge() { throw new PaymentsUnavailableError() },
  async getPayment() { throw new PaymentsUnavailableError() },
  async listPaymentRefunds() { throw new PaymentsUnavailableError() },
  verifyWebhook() { throw new WebhookSignatureError('payments are not configured') },
}

/**
 * Picks the payments adapter at startup (spec §4). Partial config refuses to
 * start, naming each missing key: a deploy that can charge but cannot verify
 * webhooks would take money it can never reconcile.
 */
export function createPaymentsPort(env: NodeJS.ProcessEnv = process.env): PaymentsPort {
  if (Object.keys(env).some((k) => k.startsWith('STRIPE_'))) {
    console.warn('payments: STRIPE_* keys are set but no longer used -- remove them from this environment')
  }
  const present = SQUARE_KEYS.filter((k) => env[k])
  if (present.length === 0) return unconfiguredPaymentsPort
  const missing = SQUARE_KEYS.filter((k) => !env[k])
  if (missing.length > 0) throw new Error(`Square is half-configured; missing: ${missing.join(', ')}`)
  const environment = env.SQUARE_ENVIRONMENT
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new Error(`SQUARE_ENVIRONMENT must be sandbox or production, not "${environment}"`)
  }
  const notificationUrl = env.SQUARE_WEBHOOK_NOTIFICATION_URL!
  if (!notificationUrl.startsWith('https://')) throw new Error('SQUARE_WEBHOOK_NOTIFICATION_URL must be an https URL')
  return createSquarePaymentsPort({
    environment,
    accessToken: env.SQUARE_ACCESS_TOKEN!,
    locationId: env.SQUARE_LOCATION_ID!,
    webhookSignatureKey: env.SQUARE_WEBHOOK_SIGNATURE_KEY!,
    webhookNotificationUrl: notificationUrl,
  })
}
