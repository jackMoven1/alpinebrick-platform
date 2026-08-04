import { Router } from 'express'
import { listProducts, getProduct, getAvailability } from './catalog.service.js'

function toPosInt(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

export const catalogRouter = Router()

catalogRouter.get('/products', async (req, res) => {
  const result = await listProducts({
    page: toPosInt(req.query.page),
    pageSize: toPosInt(req.query.pageSize),
    search: typeof req.query.search === 'string' ? req.query.search : undefined,
  })
  res.json(result)
})

catalogRouter.get('/products/:idOrSlug', async (req, res) => {
  const p = await getProduct(req.params.idOrSlug)
  if (!p) return res.status(404).json({ error: 'not_found' })
  res.json(p)
})

catalogRouter.get('/products/:idOrSlug/availability', async (req, res) => {
  const a = await getAvailability(req.params.idOrSlug)
  if (!a) return res.status(404).json({ error: 'not_found' })
  res.json(a)
})
