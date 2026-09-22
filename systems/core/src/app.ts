import express, { type Express } from 'express'
import { catalogRouter } from './catalog/catalog.routes.js'
import { ordersRouter } from './orders/orders.routes.js'
import { createAssetsRouter } from './assets/assets.routes.js'
import { createLocalStoragePort } from './ports/storage/local.adapter.js'
import { adminCatalogRouter } from './admin/admin-catalog.routes.js'
import { requireAuth } from './auth/require-auth.js'
import { requireOrigin, allowedOrigins, allowedStorefrontOrigins } from './auth/require-origin.js'
import { requireJsonContentType } from './auth/require-json-content-type.js'
import { createAuthRouter } from './auth/auth.routes.js'
import { createGoogleOidcPort } from './ports/oidc/google.adapter.js'
import { createCors } from './auth/cors.js'
import { walmartWebhookRouter } from './channels/walmart/webhooks.routes.js'
import { errorHandler } from './error-handler.js'

export function buildApp(): Express {
  const app = express()
  app.use(express.json())
  app.get('/health', (_req, res) => res.json({ status: 'ok' }))

  // Catalog is public (no cookies involved) but still cross-origin from the
  // storefront, so it gets its own allowlist with credentials off -- the
  // storefront sends no cookies, and asserting credentials where none exist
  // only widens the surface for nothing.
  app.use('/api/v1/catalog', createCors({ origins: allowedStorefrontOrigins, credentials: false }))
  app.use('/api/v1/catalog', catalogRouter)
  // Deliberately no CORS handler here -- nothing calls this endpoint
  // cross-origin yet (the storefront has no checkout wired up). When
  // checkout lands, this needs the same catalog-shaped treatment: a
  // createCors({ origins: allowedStorefrontOrigins, credentials: false })
  // mount ahead of it, since orders is public the same way catalog is.
  app.use('/api/v1/orders', ordersRouter)

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

  // Local filesystem storage until a CDN provider is chosen (ADR-0002).
  // Swapping the adapter is the only change required here.
  const storagePort = createLocalStoragePort(
    process.env.ASSET_STORAGE_DIR ?? './var/assets',
    process.env.ASSET_PUBLIC_BASE_URL ?? 'http://localhost:4000/assets',
  )
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
