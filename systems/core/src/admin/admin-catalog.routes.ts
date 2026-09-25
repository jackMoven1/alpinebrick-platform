import { Router, type Response } from 'express'
import {
  adminListProducts, adminGetProduct, setProductStatus, getOverview, AdminError,
} from './admin-catalog.service.js'
import { createProduct, updateProduct, bulkSetStatus } from './product-write.service.js'
import { scrubError } from '../auth/scrub.js'

// Error codes here are UPPER_SNAKE, matching the catalog routes and the
// console's existing AdminApiError. (/api/v1/admin/images uses lower_snake —
// a known inconsistency, deliberately not changed here.)
const STATUS_BY_CODE: Record<string, number> = {
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  INVALID_TRANSITION: 409,
  SLUG_TAKEN: 409,
  SKU_TAKEN: 409,
  SLUG_LOCKED: 409,
  SKU_LOCKED: 409,
  VARIANT_HAS_SALES: 409,
  STOCK_BELOW_RESERVED: 409,
  STOCK_CHANGED: 409,
  ALLOCATION_EXCEEDS_AVAILABLE: 409,
}

function fail(res: Response, err: unknown) {
  if (err instanceof AdminError) {
    return res.status(STATUS_BY_CODE[err.code] ?? 400).json({
      code: err.code,
      message: err.message,
      ...(err.fields ? { fields: err.fields } : {}),
      ...(err.details ? { details: err.details } : {}),
    })
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
 * PRECONDITION: this router must be mounted behind `requireAuth`. The status
 * handler dereferences `req.actor!.id` to attribute its audit row, and that
 * assertion is sound only because `app.ts` mounts `requireAuth` on
 * `/api/v1/admin` ahead of this router -- `req.actor` is never populated on
 * its own. Mount this router bare (as a standalone test app might) and
 * `req.actor` is `undefined`: `req.actor!.id` throws a synchronous
 * `TypeError` before `setProductStatus` is ever reached, and -- because the
 * handler's `catch` calls `fail()`, which responds rather than re-throws --
 * that surfaces as a quiet 500 instead of a loud crash.
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

adminCatalogRouter.post('/products', async (req, res) => {
  try { res.status(201).json(await createProduct(req.body, req.actor!.id)) } catch (err) { fail(res, err) }
})

adminCatalogRouter.post('/products/bulk-status', async (req, res) => {
  try { res.json(await bulkSetStatus(req.body, req.actor!.id)) } catch (err) { fail(res, err) }
})

adminCatalogRouter.patch('/products/:id', async (req, res) => {
  try { res.json(await updateProduct(req.params.id, req.body, req.actor!.id)) } catch (err) { fail(res, err) }
})

adminCatalogRouter.get('/products/:id', async (req, res) => {
  try {
    const p = await adminGetProduct(req.params.id)
    if (!p) return res.status(404).json({ code: 'NOT_FOUND', message: 'product not found' })
    res.json(p)
  } catch (err) { fail(res, err) }
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
  try {
    res.json(await getOverview())
  } catch (err) { fail(res, err) }
})
