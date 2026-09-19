import type { RequestHandler } from 'express'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Spec §6 layer 3 of the three-layer CSRF defence (layers 1-2 are the CORS
 * allowlist and `requireOrigin`). A cross-site HTML form can only submit
 * `application/x-www-form-urlencoded`, `multipart/form-data` or
 * `text/plain` -- never `application/json` -- so requiring JSON on every
 * admin write forces an attacker's forged request to fail, or forces a
 * preflight that the CORS allowlist then governs.
 *
 * No hole is open without this today: layer 2 (`requireOrigin`) already
 * catches a cross-site form POST. This exists for the budgeted margin the
 * spec calls out -- CORS drifting *and* someone independently loosening the
 * Origin check -- which this layer does not depend on either.
 *
 * Deliberately synchronous. An async middleware that can throw is the exact
 * unhandled-rejection class this branch has already fixed twice (Express 4
 * does not catch a rejection thrown out of an async handler); a header
 * comparison never needs to be async in the first place.
 *
 * `Content-Type` may carry parameters (`application/json; charset=utf-8`),
 * so only the media type before the first `;` is compared, case-insensitively.
 */
export const requireJsonContentType: RequestHandler = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next()

  const raw = req.headers['content-type']
  const mediaType = (typeof raw === 'string' ? raw : '').split(';')[0]!.trim().toLowerCase()

  if (mediaType === 'application/json') return next()

  res.status(403).json({ code: 'UNSUPPORTED_CONTENT_TYPE', message: 'admin writes require application/json' })
}
