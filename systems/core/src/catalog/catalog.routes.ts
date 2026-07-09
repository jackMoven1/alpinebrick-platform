import { Router } from 'express'
import { listProducts, getProduct, getAvailability } from './catalog.service.js'

export const catalogRouter = Router()

catalogRouter.get('/products', async (req, res) => {
  const result = await listProducts({
    page: req.query.page ? Number(req.query.page) : undefined,
    pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
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
