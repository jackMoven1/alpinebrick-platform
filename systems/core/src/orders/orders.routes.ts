import { Router } from 'express'
import { placeOrder, getOrder, OrderError } from './orders.service.js'

export const ordersRouter = Router()

ordersRouter.post('/', async (req, res) => {
  const body = req.body ?? {}
  if (typeof body.email !== 'string' || typeof body.shipToState !== 'string' || !Array.isArray(body.lines)) {
    return res.status(400).json({ error: 'invalid_body' })
  }
  try {
    const order = await placeOrder({ email: body.email, shipToState: body.shipToState, lines: body.lines })
    res.status(201).json(order)
  } catch (err) {
    if (err instanceof OrderError) return res.status(400).json({ error: err.code })
    throw err
  }
})

ordersRouter.get('/:id', async (req, res) => {
  const order = await getOrder(req.params.id)
  if (!order) return res.status(404).json({ error: 'not_found' })
  res.json(order)
})
