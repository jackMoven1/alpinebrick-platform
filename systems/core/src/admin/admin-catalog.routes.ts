import { Router, type Response } from 'express'
import {
  adminListProducts, adminGetProduct, setProductStatus, getOverview, AdminError,
} from './admin-catalog.service.js'
import { createProduct, updateProduct, bulkSetStatus } from './product-write.service.js'
import { createVariant, bulkCreateVariants, updateVariant, deleteVariant } from './variant-write.service.js'
import { setStock, getStockHistory } from './stock.service.js'
import { fail as failWith, intParam } from './route-helpers.js'

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
  failWith(res, err, STATUS_BY_CODE, 'admin-catalog')
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

adminCatalogRouter.post('/products/:id/variants/bulk', async (req, res) => {
  try { res.status(201).json(await bulkCreateVariants(req.params.id, req.body, req.actor!.id)) } catch (err) { fail(res, err) }
})

adminCatalogRouter.post('/products/:id/variants', async (req, res) => {
  try { res.status(201).json(await createVariant(req.params.id, req.body, req.actor!.id)) } catch (err) { fail(res, err) }
})

adminCatalogRouter.patch('/variants/:id', async (req, res) => {
  try { res.json(await updateVariant(req.params.id, req.body, req.actor!.id)) } catch (err) { fail(res, err) }
})

adminCatalogRouter.delete('/variants/:id', async (req, res) => {
  try { res.json(await deleteVariant(req.params.id, req.actor!.id)) } catch (err) { fail(res, err) }
})

adminCatalogRouter.put('/variants/:id/stock', async (req, res) => {
  try { res.json(await setStock(req.params.id, req.body, req.actor!.id)) } catch (err) { fail(res, err) }
})

adminCatalogRouter.get('/variants/:id/stock-history', async (req, res) => {
  try { res.json(await getStockHistory(req.params.id, intParam(req.query.limit) ?? 10)) } catch (err) { fail(res, err) }
})

adminCatalogRouter.get('/overview', async (_req, res) => {
  try {
    res.json(await getOverview())
  } catch (err) { fail(res, err) }
})
