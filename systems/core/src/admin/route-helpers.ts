import type { Response } from 'express'
import { AdminError } from './admin-errors.js'
import { scrubError } from '../auth/scrub.js'

/**
 * Shared by every admin router (catalog, orders, ...): map an AdminError to
 * its HTTP status via that router's own code table, or log and 500 on
 * anything else. Express 4 does not catch a rejection thrown out of an async
 * handler, so responding here (rather than re-throwing) is what keeps an
 * unexpected error from crashing the whole process -- see admin-catalog.routes.ts.
 */
export function fail(res: Response, err: unknown, statusByCode: Record<string, number>, logPrefix: string) {
  if (err instanceof AdminError) {
    return res.status(statusByCode[err.code] ?? 400).json({
      code: err.code,
      message: err.message,
      ...(err.fields ? { fields: err.fields } : {}),
      ...(err.details ? { details: err.details } : {}),
    })
  }
  console.error(`[${logPrefix}] unexpected failure`, scrubError(err))
  res.status(500).json({ code: 'INTERNAL_ERROR', message: 'internal error' })
}

export function intParam(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined
  const n = Number(v)
  return Number.isInteger(n) ? n : undefined
}
