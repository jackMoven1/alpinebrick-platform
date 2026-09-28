import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express'
import { catalogRouter } from './catalog/catalog.routes.js'
import { createAssetsRouter } from './assets/assets.routes.js'
import { createStoragePort } from './ports/storage/index.js'
import { adminCatalogRouter } from './admin/admin-catalog.routes.js'
import { createAdminOrdersRouter } from './admin/admin-orders.routes.js'
import { requireAuth } from './auth/require-auth.js'
import { requireOrigin, allowedOrigins, allowedStorefrontOrigins } from './auth/require-origin.js'
import { requireJsonContentType } from './auth/require-json-content-type.js'
import { createAuthRouter } from './auth/auth.routes.js'
import { createGoogleOidcPort } from './ports/oidc/google.adapter.js'
import { createCors } from './auth/cors.js'
import { walmartWebhookRouter } from './channels/walmart/webhooks.routes.js'
import { errorHandler } from './error-handler.js'
import { createPaymentsPort } from './ports/payments/index.js'
import type { PaymentsPort } from './ports/payments/payments.port.js'
import { createFlatRateShippingPort } from './ports/shipping/flat-rate.adapter.js'
import type { ShippingPort } from './ports/shipping/shipping.port.js'
import { createFlatRateTaxPort } from './ports/tax/flat-rate.adapter.js'
import type { TaxPort } from './ports/tax/tax.port.js'
import { noopEmailAdapter } from './ports/email/noop.adapter.js'
import type { EmailPort } from './ports/email/email.port.js'
import { createCheckoutRouter } from './checkout/checkout.routes.js'
import { createSquareWebhookHandler } from './payments/square-webhook.routes.js'
import { createRateLimiter } from './lib/rate-limit.js'

export interface AppDeps {
  payments: PaymentsPort
  shipping: ShippingPort
  /** Checkout tax: Michigan 6% on goods, $0 elsewhere (spec Q3, Q8). */
  tax: TaxPort
  email: EmailPort
  checkoutRateLimit: RequestHandler
}

/** body-parser marks a JSON parse failure with type 'entity.parse.failed' (a SyntaxError). */
const checkoutJsonErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof SyntaxError && (err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ code: 'invalid_request', message: 'request body is not valid JSON' })
    return
  }
  next(err)
}

export function buildApp(deps: Partial<AppDeps> = {}): Express {
  // createPaymentsPort throws on partial Square config -- the process refuses
  // to start rather than take money it can never mark paid (spec 2026-09-28 §4).
  const payments = deps.payments ?? createPaymentsPort()
  const shipping = deps.shipping ?? createFlatRateShippingPort()
  const tax = deps.tax ?? createFlatRateTaxPort()
  const email = deps.email ?? noopEmailAdapter
  const checkoutRateLimit = deps.checkoutRateLimit ?? createRateLimiter({ limit: 20, windowMs: 60_000 })

  const app = express()
  // Render terminates TLS one proxy hop in front of the app. Without this,
  // req.ip is the proxy's address and the checkout rate limit (and the
  // session ip recorded at sign-in) would treat every customer as one.
  app.set('trust proxy', 1)
  // Square webhook: raw body, registered BEFORE express.json. body-parser
  // skips a request whose body was already read, so the JSON parser below
  // never touches these bytes. Any content type is accepted: the HMAC over
  // the configured notification URL + body is the only auth (spec §3).
  app.post(
    '/api/v1/webhooks/square',
    express.raw({ type: () => true, limit: '1mb' }),
    createSquareWebhookHandler({ payments, email }),
  )
  // Checkout CORS mounts BEFORE the JSON parser so a malformed-body 400
  // (below) still carries the storefront's Access-Control-Allow-Origin and
  // the browser can read it. createCors never touches the body.
  app.use('/api/v1/checkout', createCors({ origins: allowedStorefrontOrigins, credentials: false }))
  app.use(express.json())
  // Ruling F-R4: body-parser's SyntaxError is the client's fault. On the
  // public checkout route it becomes 400 in the public envelope instead of
  // falling through to the generic 500. Other prefixes keep their shapes.
  app.use('/api/v1/checkout', checkoutJsonErrorHandler)
  app.get('/health', (_req, res) => res.json({ status: 'ok' }))

  // Catalog is public (no cookies involved) but still cross-origin from the
  // storefront, so it gets its own allowlist with credentials off -- the
  // storefront sends no cookies, and asserting credentials where none exist
  // only widens the surface for nothing.
  app.use('/api/v1/catalog', createCors({ origins: allowedStorefrontOrigins, credentials: false }))
  app.use('/api/v1/catalog', catalogRouter)

  // Storefront checkout (spec §4). Public like catalog: storefront allowlist,
  // credentials off (its CORS is mounted above, ahead of express.json). start,
  // quote and pay are rate-limited per IP inside the router so the endpoint
  // cannot be used to hold stock. The old public POST/GET
  // /api/v1/orders routes are retired (spec §2): POST reserved stock with no
  // payment, GET exposed addresses to anyone holding an order id.
  app.use('/api/v1/checkout', createCheckoutRouter({ payments, shipping, tax, email, rateLimit: checkoutRateLimit }))

  // Walmart calls this endpoint directly with no session cookie and no
  // Origin header -- its own x-webhook-secret header (checked inside the
  // router) is the only auth layer. Deliberately its own prefix, separate
  // from /api/v1/admin and /api/v1/auth below, and mounted with nothing
  // ahead of it on this path: requireAuth, requireOrigin,
  // requireJsonContentType and CORS must NOT apply here, or Walmart's
  // deliveries would 401/403 before ever reaching the router.
  app.use('/api/v1/channels/walmart/webhooks', walmartWebhookRouter)

  // CORS mounts first, ahead of everything else on this prefix -- a
  // preflight OPTIONS carries no cookie, so if auth-adjacent middleware ran
  // first every preflight would fail before the CORS headers are ever set.
  //
  // Deliberately NOT behind requireAuth -- sign-in has to work before there
  // is a session. /me is the one route here that needs a session, so it
  // applies requireAuth itself. requireOrigin, though, applies to every
  // non-GET/HEAD request regardless of auth (spec §6 layer 2); /logout is
  // the only non-GET route mounted here, so this affects nothing else.
  app.use('/api/v1/auth', createCors({ origins: allowedOrigins, credentials: true }))
  app.use('/api/v1/auth', requireOrigin)
  app.use('/api/v1/auth', createAuthRouter(createGoogleOidcPort()))

  const storagePort = createStoragePort()
  // MUST come before both admin routers. Express matches in registration
  // order, and /api/v1/admin/images is registered first -- attaching auth to
  // the catalog router alone would leave image reorder and delete open while
  // looking correct in review. See spec 5.1.
  //
  // CORS is mounted ahead of requireAuth -- this is the ordering trap: a
  // preflight OPTIONS carries no cookie and no Authorization header, so if
  // requireAuth ran first every preflight would 401, the real request would
  // never be sent, and the console would look completely broken while every
  // server-side test still passed.
  app.use('/api/v1/admin', createCors({ origins: allowedOrigins, credentials: true }))
  app.use('/api/v1/admin', requireAuth)
  app.use('/api/v1/admin', requireOrigin)
  // Spec §6 layer 3: admin writes must be application/json. Mounted
  // alongside the other two CSRF layers, ahead of both admin routers below.
  app.use('/api/v1/admin', requireJsonContentType)
  app.use('/api/v1/admin/images', createAssetsRouter(storagePort))
  app.use('/api/v1/admin', adminCatalogRouter)
  app.use('/api/v1/admin', createAdminOrdersRouter())

  // Terminal error-handling middleware -- MUST be mounted last, after every
  // router. It is the backstop for asyncHandler-wrapped routes (and for
  // requireAuth, which already calls next(err) itself): Express 4 does not
  // catch a rejection thrown out of an async handler, so without this and
  // without asyncHandler, an unexpected error anywhere crashes the whole
  // process -- catalog, orders and admin traffic included, not just
  // whichever route happened to throw. See error-handler.ts and
  // lib/async-handler.ts.
  app.use(errorHandler)

  return app
}
