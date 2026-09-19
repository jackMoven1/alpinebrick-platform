import express, { type Express } from 'express'
import { catalogRouter } from './catalog/catalog.routes.js'
import { ordersRouter } from './orders/orders.routes.js'
import { createAssetsRouter } from './assets/assets.routes.js'
import { createLocalStoragePort } from './ports/storage/local.adapter.js'
import { adminCatalogRouter } from './admin/admin-catalog.routes.js'
import { requireAuth } from './auth/require-auth.js'
import { requireOrigin } from './auth/require-origin.js'
import { requireJsonContentType } from './auth/require-json-content-type.js'
import { createAuthRouter } from './auth/auth.routes.js'
import { createGoogleOidcPort } from './ports/oidc/google.adapter.js'

export function buildApp(): Express {
  const app = express()
  app.use(express.json())
  app.get('/health', (_req, res) => res.json({ status: 'ok' }))
  app.use('/api/v1/catalog', catalogRouter)
  app.use('/api/v1/orders', ordersRouter)

  // Deliberately NOT behind requireAuth -- sign-in has to work before there
  // is a session. /me is the one route here that needs a session, so it
  // applies requireAuth itself. requireOrigin, though, applies to every
  // non-GET/HEAD request regardless of auth (spec §6 layer 2); /logout is
  // the only non-GET route mounted here, so this affects nothing else.
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
  app.use('/api/v1/admin', requireAuth)
  app.use('/api/v1/admin', requireOrigin)
  // Spec §6 layer 3: admin writes must be application/json. Mounted
  // alongside the other two CSRF layers, ahead of both admin routers below.
  app.use('/api/v1/admin', requireJsonContentType)
  app.use('/api/v1/admin/images', createAssetsRouter(storagePort))
  app.use('/api/v1/admin', adminCatalogRouter)

  return app
}
