import { Router } from 'express'
import { ingestWalmartOrder, ChannelError } from './orders.ingest.js'
import { hashesEqual, hashToken } from '../../auth/tokens.js'
import { asyncHandler } from '../../lib/async-handler.js'

// Mounted at /api/v1/channels/walmart/webhooks in app.ts, a prefix
// deliberately separate from /api/v1/admin and /api/v1/auth. Walmart sends
// no session cookie and no Origin header, so requireAuth, requireOrigin,
// requireJsonContentType and CORS must NOT apply here -- this router's own
// x-webhook-secret check is the only auth layer. See app.ts for the mount
// comment and tests/walmart-webhooks.test.ts's "reachable without any
// session cookie" test.
export const walmartWebhookRouter = Router()

walmartWebhookRouter.post('/', asyncHandler(async (req, res) => {
  const provided = req.get('x-webhook-secret')
  const expected = process.env.WALMART_WEBHOOK_SECRET
  // Fail closed on either side being absent BEFORE ever calling hashesEqual
  // -- it requires two strings, and an unset WALMART_WEBHOOK_SECRET must
  // never make every request pass.
  //
  // Hash both sides to a fixed-length (sha256 hex) digest with hashToken
  // before comparing, rather than calling hashesEqual(provided, expected)
  // directly. hashesEqual's own doc comment says its constant-time guarantee
  // holds "for equal-length inputs" -- it short-circuits to `false` on a
  // raw length mismatch (see tokens.ts), which is correct when comparing two
  // digests of a known fixed length, but WALMART_WEBHOOK_SECRET is a raw
  // variable-length shared secret compared directly. Without hashing first,
  // an attacker probing with different header lengths can distinguish
  // "wrong length" from "right length, wrong content" by timing, narrowing
  // brute force to the correct length before attacking its content. Hashing
  // first makes both operands always the same length, so timingSafeEqual
  // does the real work instead of being bypassed by the length check.
  if (!expected || !provided || !hashesEqual(hashToken(provided), hashToken(expected))) {
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
    // Not a ChannelError -- a genuine unexpected failure (e.g. a raw Prisma
    // error). Re-thrown here, but this handler is wrapped in asyncHandler
    // above, so the rejection reaches errorHandler (error-handler.ts) via
    // next(err) instead of becoming an unhandled rejection that crashes the
    // process. See lib/async-handler.ts's doc comment.
    throw e
  }
}))
