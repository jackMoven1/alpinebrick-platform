import { Router, type Response } from 'express'
import { listAdminOrders, getAdminOrder, shipOrder, cancelPendingOrder } from './admin-orders.service.js'
import { getShopSettings, updateShippingSettings } from '../settings/shop-settings.service.js'
import type { PaymentsPort } from '../ports/payments/payments.port.js'
import { fail as failWith, intParam } from './route-helpers.js'

const STATUS_BY_CODE: Record<string, number> = {
  NOT_FOUND: 404, VALIDATION_ERROR: 400, INVALID_TRANSITION: 409, INVENTORY_CONFLICT: 409,
  REVIEW_REQUIRED: 409, WRONG_CHANNEL: 409, ORDER_PAID: 409, STRIPE_UNAVAILABLE: 503,
}

function fail(res: Response, err: unknown) {
  failWith(res, err, STATUS_BY_CODE, 'admin-orders')
}

/** PRECONDITION: mounted behind requireAuth (req.actor!.id), like adminCatalogRouter. */
export function createAdminOrdersRouter(payments: PaymentsPort): Router {
  const router = Router()

  router.get('/orders', async (req, res) => {
    try {
      res.json(await listAdminOrders({ tab: req.query.tab, page: intParam(req.query.page), pageSize: intParam(req.query.pageSize) }))
    } catch (err) { fail(res, err) }
  })

  router.get('/orders/:id', async (req, res) => {
    try {
      const o = await getAdminOrder(req.params.id, payments)
      if (!o) return res.status(404).json({ code: 'NOT_FOUND', message: 'order not found' })
      res.json(o)
    } catch (err) { fail(res, err) }
  })

  router.post('/orders/:id/ship', async (req, res) => {
    try { res.json(await shipOrder(req.params.id, req.body, req.actor!.id, payments)) } catch (err) { fail(res, err) }
  })

  router.post('/orders/:id/cancel', async (req, res) => {
    try { res.json(await cancelPendingOrder(req.params.id, req.body, req.actor!.id, payments)) } catch (err) { fail(res, err) }
  })

  router.get('/settings/shipping', async (_req, res) => {
    try { res.json(await getShopSettings()) } catch (err) { fail(res, err) }
  })

  router.put('/settings/shipping', async (req, res) => {
    try { res.json(await updateShippingSettings(req.body, req.actor!.id)) } catch (err) { fail(res, err) }
  })

  return router
}
