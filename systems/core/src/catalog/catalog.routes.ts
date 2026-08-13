import { Router, type Response } from 'express'
import {
  listProducts, getProduct, getAvailability,
  CatalogValidationError, VALID_SORTS, type CatalogSort,
} from './catalog.service.js'

// Returns undefined when absent, null when present-but-invalid, so the caller
// can tell "not supplied" from "supplied as garbage" and reject the latter.
function intParam(v: unknown): number | undefined | null {
  if (v === undefined) return undefined
  if (typeof v !== 'string') return null
  const n = Number(v)
  return Number.isInteger(n) ? n : null
}

function notFound(res: Response) {
  return res.status(404).json({ code: 'NOT_FOUND', message: 'Product not found.' })
}

function validationError(res: Response, field: string, message: string) {
  return res.status(400).json({ code: 'VALIDATION_ERROR', message, fields: { [field]: message } })
}

export const catalogRouter = Router()

catalogRouter.get('/products', async (req, res) => {
  const page = intParam(req.query.page)
  if (page === null) return validationError(res, 'page', 'page must be an integer >= 1')
  const pageSize = intParam(req.query.pageSize)
  if (pageSize === null) return validationError(res, 'pageSize', 'pageSize must be an integer between 1 and 100')

  const rawSort = req.query.sort
  if (rawSort !== undefined && (typeof rawSort !== 'string' || !VALID_SORTS.includes(rawSort as CatalogSort))) {
    return validationError(res, 'sort', `sort must be one of: ${VALID_SORTS.join(', ')}`)
  }

  try {
    const result = await listProducts({
      page, pageSize,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      category: typeof req.query.category === 'string' ? req.query.category : undefined,
      sort: rawSort as CatalogSort | undefined,
    })
    res.json(result)
  } catch (err) {
    if (err instanceof CatalogValidationError) {
      return validationError(res, err.field, err.message)
    }
    throw err
  }
})

catalogRouter.get('/products/:idOrSlug', async (req, res) => {
  const p = await getProduct(req.params.idOrSlug)
  if (!p) return notFound(res)
  res.json(p)
})

catalogRouter.get('/products/:idOrSlug/availability', async (req, res) => {
  const a = await getAvailability(req.params.idOrSlug)
  if (!a) return notFound(res)
  res.json(a)
})
