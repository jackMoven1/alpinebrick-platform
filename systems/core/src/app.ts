import express, { type Express } from 'express'
import { catalogRouter } from './catalog/catalog.routes.js'

export function buildApp(): Express {
  const app = express()
  app.use(express.json())
  app.get('/health', (_req, res) => res.json({ status: 'ok' }))
  app.use('/api/v1/catalog', catalogRouter)
  return app
}
