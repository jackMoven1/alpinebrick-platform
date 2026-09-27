import express, { type Express, type RequestHandler } from 'express'
import { catalogRouter } from './catalog/catalog.routes.js'
import { createAssetsRouter } from './assets/assets.routes.js'
import { createStoragePort } from './ports/storage/index.js'
import { adminCatalogRouter } from './admin/admin-catalog.routes.js'
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
import { noopEmailAdapter } from './ports/email/noop.adapter.js'
import type { EmailPort } from './ports/email/email.port.js'
import { createCheckoutRouter } from './checkout/checkout.routes.js'
import { createRateLimiter } from './lib/rate-limit.js'

export interface AppDeps {
  payments: PaymentsPort
  shipping: ShippingPort
  email: EmailPort
  /** Base for Stripe's return_url; env STOREFRONT_PUBLIC_URL by default. */
  storefrontUrl: string | null
  checkoutRateLimit: RequestHandler
}

export function buildApp(deps: Partial<AppDeps> = {}): Express {
  // createPaymentsPort throws on half-configured Stripe -- the process refuses
  // to start rather than take money it can never mark paid (spec §8).
  const payments = deps.payments ?? createPaymentsPort()
  const shipping = deps.shipping ?? createFlatRateShippingPort()
  // `email` is used by the Stripe webhook (Task 7).
  const email = deps.email ?? noopEmailAdapter
  const storefrontUrl = (deps.storefrontUrl !== undefined ? deps.storefrontUrl : (process.env.STOREFRONT_PUBLIC_URL ?? null))
    ?.replace(/\/+$/, '') ?? null
  const checkoutRateLimit = deps.checkoutRateLimit ?? createRateLimiter({ limit: 20, windowMs: 60_000 })

  const app = express()
  // Render terminates TLS one proxy hop in front of the app. Without this,
  // req.ip is the proxy's address and the checkout rate limit (and the
  // session ip recorded at sign-in) would treat every customer as one.
  app.set('trust proxy', 1)
  app.use(express.json())
  app.get('/health', (_req, res) => res.json({ status: 'ok' }))

  // Catalog is public (no cookies involved) but still cross-origin from the
  // storefront, so it gets its own allowlist with credentials off -- the
  // storefront sends no cookies, and asserting credentials where none exist
  // only widens the surface for nothing.
  app.use('/api/v1/catalog', createCors({ origins: allowedStorefrontOrigins, credentials: false }))
  app.use('/api/v1/catalog', catalogRouter)

  // Storefront checkout (spec §4). Public like catalog: storefront allowlist,
  // credentials off. POST is rate-limited per IP inside the router so the
  // endpoint cannot be used to hold stock. The old public POST/GET
  // /api/v1/orders routes are retired (spec §2): POST reserved stock with no
  // payment, GET exposed addresses to anyone holding an order id.
  app.use('/api/v1/checkout', createCors({ origins: allowedStorefrontOrigins, credentials: false }))
  app.use('/api/v1/checkout', createCheckoutRouter({ payments, shipping, storefrontUrl, rateLimit: checkoutRateLimit }))

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
