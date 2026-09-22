import { Router } from 'express'
import { ingestWalmartOrder, ChannelError } from './orders.ingest.js'
import { hashesEqual } from '../../auth/tokens.js'

// Mounted at /api/v1/channels/walmart/webhooks in app.ts, a prefix
// deliberately separate from /api/v1/admin and /api/v1/auth. Walmart sends
// no session cookie and no Origin header, so requireAuth, requireOrigin,
// requireJsonContentType and CORS must NOT apply here -- this router's own
// x-webhook-secret check is the only auth layer. See app.ts for the mount
// comment and tests/walmart-webhooks.test.ts's "reachable without any
// session cookie" test.
export const walmartWebhookRouter = Router()

walmartWebhookRouter.post('/', async (req, res) => {
  const provided = req.get('x-webhook-secret')
  const expected = process.env.WALMART_WEBHOOK_SECRET
  // Constant-time comparison via hashesEqual (src/auth/tokens.ts) -- a plain
  // === on a shared secret leaks length and prefix through timing. Guard the
  // undefined cases explicitly rather than falling into hashesEqual with a
  // missing value: hashesEqual requires two strings, and an unset
  // WALMART_WEBHOOK_SECRET must never make every request pass.
  if (!expected || !provided || !hashesEqual(provided, expected)) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const { eventType, payload } = req.body ?? {}

  if (eventType !== 'ORDER_CREATED') {
    return res.status(202).json({ ignored: true })
  }

  try {
    // A re-delivery resolves { created: false } here -- it is NOT an error.
    // ingestWalmartOrder only throws ChannelError for a genuine mapping/
    // catalog/stock failure (unmappable_order, unknown_sku,
    // insufficient_stock); re-delivery, including a true concurrent race,
    // is handled inside ingestWalmartOrder and returned as a normal
    // resolved value. So this path always responds 200, whether it created
    // a new order or recognized a duplicate delivery.
    const result = await ingestWalmartOrder(payload, 'webhook')
    return res.status(200).json(result)
  } catch (e) {
    if (e instanceof ChannelError) {
      // Walmart gets a 4xx for a real failure; the poller (pollers.ts) is
      // the retry path once the underlying cause (missing listing,
      // insufficient stock) is resolved.
      return res.status(422).json({ error: e.code })
    }
    throw e
  }
})
