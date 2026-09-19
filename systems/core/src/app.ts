import express, { type Express } from 'express'
import { catalogRouter } from './catalog/catalog.routes.js'
import { ordersRouter } from './orders/orders.routes.js'
import { createAssetsRouter } from './assets/assets.routes.js'
import { createLocalStoragePort } from './ports/storage/local.adapter.js'
import { adminCatalogRouter } from './admin/admin-catalog.routes.js'
import { requireAuth } from './auth/require-auth.js'

export function buildApp(): Express {
  const app = express()
  app.use(express.json())
  app.get('/health', (_req, res) => res.json({ status: 'ok' }))
  app.use('/api/v1/catalog', catalogRouter)
  app.use('/api/v1/orders', ordersRouter)

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
  app.use('/api/v1/admin/images', createAssetsRouter(storagePort))
  app.use('/api/v1/admin', adminCatalogRouter)

  return app
}
