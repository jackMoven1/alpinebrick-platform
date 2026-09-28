import { Router, type Request, type RequestHandler, type Response } from 'express'
import { asyncHandler } from '../lib/async-handler.js'
import { CheckoutError, ORDER_ID_RE, checkoutErrors, parseCheckoutRequest, parsePayRequest, parseQuoteRequest } from './checkout-input.js'
import { startCheckout, quoteCheckout, getCheckoutStatus, getCheckoutConfig, type CheckoutDeps } from './checkout.service.js'
import { payForOrder } from './pay.service.js'

function send(res: Response, err: CheckoutError) {
  return res.status(err.status).json({ code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) })
}

export function orderIdOf(raw: unknown): string {
  if (typeof raw !== 'string' || !ORDER_ID_RE.test(raw)) throw new CheckoutError('invalid_request', 'an order id', 400, { field: 'orderId' })
  return raw
}

/** Every public checkout answer is per shopper: never cached, and errors use the public envelope. */
export function json(status: number, fn: (req: Request) => Promise<unknown>): RequestHandler {
  return asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      res.status(status).json(await fn(req))
    } catch (err) {
      if (err instanceof CheckoutError) return send(res, err)
      throw err
    }
  })
}

/**
 * Public, storefront CORS, no credentials. Mounted in app.ts. Start, quote
 * and pay share one per-IP limiter (plan decision 6); the status poll has its
 * own, more generous one (final review minor 2).
 */
export function createCheckoutRouter(deps: CheckoutDeps & { rateLimit: RequestHandler; statusRateLimit: RequestHandler }): Router {
  const router = Router()
  router.post('/', deps.rateLimit, json(201, (req) => startCheckout(parseCheckoutRequest(req.body), deps)))
  router.post('/:orderId/quote', deps.rateLimit, json(200, (req) =>
    quoteCheckout(orderIdOf(req.params.orderId), parseQuoteRequest(req.body), deps)))
  router.post('/:orderId/pay', deps.rateLimit, json(200, (req) =>
    payForOrder(orderIdOf(req.params.orderId), parsePayRequest(req.body), deps)))
  router.get('/status', deps.statusRateLimit, json(200, async (req) => {
    const status = await getCheckoutStatus(orderIdOf(req.query.orderId))
    if (!status) throw checkoutErrors.notFound()
    return status
  }))
  router.get('/config', json(200, () => getCheckoutConfig()))
  return router
}
