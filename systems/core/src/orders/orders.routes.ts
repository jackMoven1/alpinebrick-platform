import { Router } from 'express'
import { placeOrder, getOrder, OrderError } from './orders.service.js'
import { asyncHandler } from '../lib/async-handler.js'

export const ordersRouter = Router()

ordersRouter.post('/', asyncHandler(async (req, res) => {
  const body = req.body ?? {}
  if (typeof body.email !== 'string' || typeof body.shipToState !== 'string' || !Array.isArray(body.lines)) {
    return res.status(400).json({ error: 'invalid_body' })
  }
  try {
    const order = await placeOrder({ email: body.email, shipToState: body.shipToState, lines: body.lines })
    res.status(201).json(order)
  } catch (err) {
    if (err instanceof OrderError) return res.status(400).json({ error: err.code })
    // See lib/async-handler.ts -- this route is wrapped, so the rejection
    // reaches error-handler.ts via next(err) instead of crashing the
    // process the way a bare throw out of an unwrapped async handler would.
    throw err
  }
}))

ordersRouter.get('/:id', asyncHandler(async (req, res) => {
  const order = await getOrder(req.params.id)
  if (!order) return res.status(404).json({ error: 'not_found' })
  res.json(order)
}))
