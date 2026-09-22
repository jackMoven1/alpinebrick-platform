import type { ErrorRequestHandler } from 'express'
import { scrubError } from './auth/scrub.js'

/**
 * Terminal error-handling middleware. MUST be mounted last in app.ts, after
 * every router -- Express identifies error-handling middleware by arity
 * (four parameters), so the unused `next` in the signature below is
 * load-bearing, not dead code.
 *
 * This is the backstop `asyncHandler` (src/lib/async-handler.ts) routes
 * rejected promises to via `next(err)`. It must always respond, never
 * re-throw or call `next(err)` again except in the headersSent case below --
 * doing so would reproduce exactly the crash this exists to prevent, just
 * one hop later. It never leaks the underlying error: `scrubError` (used
 * elsewhere in this codebase for the same reason -- see its own doc comment)
 * reduces it to message/code/status before logging, and the response body
 * is a fixed, generic shape that carries no information about what failed.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  console.error('[unhandled]', scrubError(err))
  if (res.headersSent) {
    // A response is already in flight (e.g. streaming). Can't send a second
    // one -- hand off to Express's own default handler, which closes the
    // connection instead of hanging, rather than trying to write again.
    next(err)
    return
  }
  res.status(500).json({ code: 'INTERNAL_ERROR' })
}
