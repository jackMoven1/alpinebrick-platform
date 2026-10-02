import { Router, type RequestHandler, type Response } from 'express'
import { asyncHandler } from '../lib/async-handler.js'
import { CheckoutError, parseCheckoutRequest } from './checkout-input.js'
import {
  startCheckout, getCheckoutStatus, getCheckoutConfig, SESSION_ID_RE, type CheckoutDeps,
} from './checkout.service.js'

function send(res: Response, err: CheckoutError) {
  return res.status(err.status).json({ code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) })
}

/** Public, storefront-CORS, no credentials (spec §8). Mounted in app.ts. */
export function createCheckoutRouter(deps: CheckoutDeps & { rateLimit: RequestHandler }): Router {
  const router = Router()

  router.post('/', deps.rateLimit, asyncHandler(async (req, res) => {
    try {
      res.status(201).json(await startCheckout(parseCheckoutRequest(req.body), deps))
    } catch (err) {
      if (err instanceof CheckoutError) return send(res, err)
      throw err
    }
  }))

  router.get('/status', asyncHandler(async (req, res) => {
    const id = req.query.session_id
    if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) {
      return res.status(400).json({ code: 'invalid_request', message: 'session_id is required' })
    }
    const status = await getCheckoutStatus(id)
    if (!status) return res.status(404).json({ code: 'not_found', message: 'no checkout for that session' })
    res.setHeader('Cache-Control', 'no-store')
    res.json(status)
  }))

  router.get('/config', asyncHandler(async (_req, res) => {
    res.json(await getCheckoutConfig())
  }))

  return router
}
