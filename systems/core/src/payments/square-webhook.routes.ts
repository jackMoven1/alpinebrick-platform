import type { RequestHandler } from 'express'
import { asyncHandler } from '../lib/async-handler.js'
import { WebhookSignatureError, type PaymentsPort } from '../ports/payments/payments.port.js'
import type { EmailPort } from '../ports/email/email.port.js'
import { BadPayloadError, handleSquareEvent, parseSquareEvent } from './square-events.js'

/**
 * POST /api/v1/webhooks/square. Mounted in app.ts BEFORE express.json with a
 * raw-body parser: the signature covers the exact bytes Square sent. No
 * CORS, auth, origin or content-type middleware -- the signature is the
 * only auth layer (spec §3).
 */
export function createSquareWebhookHandler(deps: { payments: PaymentsPort; email: EmailPort }): RequestHandler {
  return asyncHandler(async (req, res) => {
    if (!deps.payments.configured) return res.status(503).json({ code: 'webhook_not_configured' })
    // Normalised before the HMAC (Task 2 carry): a missing, empty or repeated
    // header is a bad signature, never Buffer.from(undefined).
    const header: unknown = req.headers['x-square-hmacsha256-signature']
    const signature = typeof header === 'string' && header.length > 0 ? header : null
    if (signature === null || !Buffer.isBuffer(req.body)) return res.status(400).json({ code: 'bad_signature' })
    try {
      deps.payments.verifyWebhook(req.body, signature)
    } catch (err) {
      if (err instanceof WebhookSignatureError) return res.status(400).json({ code: 'bad_signature' })
      throw err
    }
    let event
    try {
      event = parseSquareEvent(req.body)
    } catch (err) {
      if (err instanceof BadPayloadError) return res.status(400).json({ code: 'bad_payload' })
      throw err
    }
    const outcome = await handleSquareEvent(event, deps)
    if (outcome === 'retry') return res.status(503).json({ code: 'retry_later' })
    res.status(200).json({ received: true, outcome })
  })
}
