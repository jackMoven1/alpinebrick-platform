import type { RequestHandler } from 'express'

export interface CorsOptions {
  origins: () => string[]
  credentials: boolean
}

/**
 * Hand-rolled CORS response headers -- no `cors` package (removed as an
 * unused dependency two commits ago; not reintroducing it for ~25 lines).
 *
 * Must mount ahead of `requireAuth` on every prefix it covers. A browser's
 * preflight OPTIONS carries no cookie and no Authorization header; if auth
 * ran first every preflight would 401 and the real request behind it would
 * never be sent, while every server-side test kept passing.
 *
 * Never echoes `*`: an unlisted origin gets no Access-Control-Allow-Origin
 * header at all -- requireOrigin already owns rejecting it, and the browser
 * enforces the rest. `Vary: Origin` is set unconditionally so a cache never
 * serves one origin's response to another.
 */
export function createCors({ origins, credentials }: CorsOptions): RequestHandler {
  return (req, res, next) => {
    res.setHeader('Vary', 'Origin')

    const origin = req.headers.origin
    const isAllowed = typeof origin === 'string' && origins().includes(origin)

    if (isAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      if (credentials) res.setHeader('Access-Control-Allow-Credentials', 'true')
    }

    if (req.method === 'OPTIONS') {
      if (isAllowed) {
        const requestedMethod = req.headers['access-control-request-method']
        res.setHeader('Access-Control-Allow-Methods', typeof requestedMethod === 'string' ? requestedMethod : 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
        const requestedHeaders = req.headers['access-control-request-headers']
        if (requestedHeaders) res.setHeader('Access-Control-Allow-Headers', requestedHeaders)
      }
      res.status(204).end()
      return
    }

    next()
  }
}
