import type { RequestHandler } from 'express'

/**
 * Per-IP fixed-window limiter, in memory (spec §8: "so it cannot be used to
 * lock up stock"). Per process: with N web instances the effective limit is
 * N x `limit`, acceptable at one starter instance. req.ip is the client's
 * address because app.ts sets `trust proxy` to Render's single hop.
 */
export function createRateLimiter(opts: { limit: number; windowMs: number; now?: () => number }): RequestHandler {
  const now = opts.now ?? Date.now
  const hits = new Map<string, { count: number; resetAt: number }>()
  return (req, res, next) => {
    const t = now()
    const key = req.ip ?? 'unknown'
    let entry = hits.get(key)
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + opts.windowMs }
      hits.set(key, entry)
    }
    entry.count += 1
    if (hits.size > 10_000) for (const [k, e] of hits) if (e.resetAt <= t) hits.delete(k)
    if (entry.count > opts.limit) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - t) / 1000)))
      res.status(429).json({ code: 'rate_limited', message: 'Too many checkout attempts. Please wait a minute and try again.' })
      return
    }
    next()
  }
}
