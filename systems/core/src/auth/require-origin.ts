import type { RequestHandler } from 'express'

function parseOriginList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

export function allowedOrigins(): string[] {
  return parseOriginList(process.env.ADMIN_CONSOLE_ORIGIN)
}

/**
 * The storefront's own allowlist, kept separate from `allowedOrigins()`
 * (the console's) on purpose -- see createCors in ./cors.ts. The two must
 * never be interchangeable: the storefront being permitted to call admin
 * endpoints is precisely what the auth work exists to prevent.
 */
export function allowedStorefrontOrigins(): string[] {
  return parseOriginList(process.env.STOREFRONT_ORIGIN)
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * The console is on an unrelated domain, so the session cookie is
 * SameSite=None and the attribute itself defends nothing. This check is
 * server-side and therefore holds even if the CORS configuration drifts or a
 * client declines to enforce it.
 *
 * Bearer requests are exempt: they are not browser-driven, carry no Origin,
 * and are protected by possession of the key.
 */
export const requireOrigin: RequestHandler = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next()
  if (req.headers.authorization) return next()

  const origin = req.headers.origin
  const allowed = allowedOrigins()
  if (typeof origin === 'string' && allowed.includes(origin)) return next()

  res.status(403).json({ code: 'FORBIDDEN_ORIGIN', message: 'origin not allowed' })
}
