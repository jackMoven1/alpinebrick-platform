import express, { type Express } from 'express'
import { catalogRouter } from './catalog/catalog.routes.js'
import { ordersRouter } from './orders/orders.routes.js'
import { createAssetsRouter } from './assets/assets.routes.js'
import { createLocalStoragePort } from './ports/storage/local.adapter.js'

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
  app.use('/api/v1/admin/images', createAssetsRouter(storagePort))

  return app
}
