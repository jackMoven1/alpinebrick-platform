import { Router, type Response } from 'express'
import {
  adminListProducts, adminGetProduct, setProductStatus, getOverview, AdminError,
} from './admin-catalog.service.js'
import { scrubError } from '../auth/auth.routes.js'

// Error codes here are UPPER_SNAKE, matching the catalog routes and the
// console's existing AdminApiError. (/api/v1/admin/images uses lower_snake —
// a known inconsistency, deliberately not changed here.)
const STATUS_BY_CODE: Record<string, number> = {
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  INVALID_TRANSITION: 409,
}

function fail(res: Response, err: unknown) {
  if (err instanceof AdminError) {
    return res.status(STATUS_BY_CODE[err.code] ?? 400).json({ code: err.code, message: err.message })
  }
  // Express 4 does not catch a rejection thrown out of an async handler, so
  // re-throwing an unknown error here (as this used to do) is the same
  // unhandled-rejection hazard fixed in auth.routes.ts -- just harder to
  // trigger, since it needs a genuine service error rather than a bare
  // header. Respond instead of propagating, and scrub before logging.
  console.error('[admin-catalog] unexpected failure', scrubError(err))
  res.status(500).json({ code: 'INTERNAL_ERROR', message: 'internal error' })
}

function intParam(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined
  const n = Number(v)
  return Number.isInteger(n) ? n : undefined
}

/**
 * Admin catalog endpoints.
 *
 * THESE HAVE NO AUTHENTICATION, and they are WRITE endpoints. Anyone who can
 * reach core can unpublish or archive the entire catalogue. Acceptable locally;
 * not acceptable on any reachable network until auth exists.
 */
export const adminCatalogRouter = Router()

adminCatalogRouter.get('/products', async (req, res) => {
  try {
    res.json(await adminListProducts({
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      page: intParam(req.query.page),
      pageSize: intParam(req.query.pageSize),
    }))
  } catch (err) { fail(res, err) }
})

adminCatalogRouter.get('/products/:id', async (req, res) => {
  const p = await adminGetProduct(req.params.id)
  if (!p) return res.status(404).json({ code: 'NOT_FOUND', message: 'product not found' })
  res.json(p)
})

adminCatalogRouter.post('/products/:id/status', async (req, res) => {
  const { status } = req.body ?? {}
  if (typeof status !== 'string') {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'status is required' })
  }
  try {
    res.json(await setProductStatus(req.params.id, status, req.actor!.id))
  } catch (err) { fail(res, err) }
})

adminCatalogRouter.get('/overview', async (_req, res) => {
  res.json(await getOverview())
})
