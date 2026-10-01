import type { RequestHandler } from 'express'
import { asyncHandler } from '../lib/async-handler.js'
import { WebhookSignatureError, type PaymentsPort } from '../ports/payments/payments.port.js'
import type { EmailPort } from '../ports/email/email.port.js'
import { handleStripeEvent } from './stripe-events.js'

/**
 * POST /api/v1/webhooks/stripe. Mounted in app.ts BEFORE express.json with
 * express.raw: signature verification needs the exact bytes Stripe signed.
 * No CORS, auth, origin or content-type middleware -- the signature is the
 * only auth layer (spec §5).
 */
export function createStripeWebhookHandler(deps: { payments: PaymentsPort; email: EmailPort }): RequestHandler {
  return asyncHandler(async (req, res) => {
    if (!deps.payments.configured) return res.status(503).json({ code: 'webhook_not_configured' })
    const signature = req.get('stripe-signature')
    if (!signature || !Buffer.isBuffer(req.body)) return res.status(400).json({ code: 'bad_signature' })
    let event
    try {
      event = deps.payments.constructWebhookEvent(req.body, signature)
    } catch (err) {
      if (err instanceof WebhookSignatureError) return res.status(400).json({ code: 'bad_signature' })
      throw err
    }
    const outcome = await handleStripeEvent(event, { email: deps.email })
    if (outcome === 'retry') return res.status(503).json({ code: 'retry_later' })
    res.status(200).json({ received: true, outcome })
  })
}
