import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createAssetsRouter } from '../src/assets/assets.routes.js'
import type { AssetStoragePort, StoredObject } from '../src/ports/storage/storage.port.js'

const OBJ: StoredObject = { width: 1600, height: 1200, byteSize: 5000, contentType: 'image/jpeg' }
const uploaded: Record<string, StoredObject> = {}

const port: AssetStoragePort = {
  createUploadTarget: vi.fn(async (key: string) => ({
    uploadUrl: `https://upload.test/${key}`,
    expiresAt: new Date(Date.now() + 60_000),
  })),
  stat: vi.fn(async (key: string) => uploaded[key] ?? null),
  delete: vi.fn(async () => {}),
}

// The route handlers now record an audit row under `req.actor.id`, guaranteed
// non-null by `requireAuth` in the real app (mounted ahead of this router on
// `/api/v1/admin`). This test app exercises the router standalone, so it
// injects the actor itself rather than running the full auth flow.
let actor: { id: string; type: 'human' | 'agent'; name: string }

function buildTestApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/admin/images', (req, _res, next) => { req.actor = actor; next() })
  app.use('/api/v1/admin/images', createAssetsRouter(port))
  return app
}

const app = buildTestApp()

beforeEach(async () => {
  await resetDb()
  for (const k of Object.keys(uploaded)) delete uploaded[k]
  actor = await prisma.actor.create({ data: { type: 'human', name: 'routes-actor' } })
})
afterAll(async () => { await prisma.$disconnect() })

async function makeProduct() {
  return prisma.product.create({
    data: { slug: 'routes-product', name: 'Routes', productType: 'resale', status: 'published' },
  })
}

async function readyImage(productId: string) {
  const t = await request(app)
    .post('/api/v1/admin/images/upload-token')
    .send({ productId, contentType: 'image/jpeg', byteSize: 100 })
  uploaded[t.body.storageKey] = OBJ
  await request(app).post(`/api/v1/admin/images/${t.body.imageId}/confirm`).send({})
  return t.body as { imageId: string; storageKey: string }
}

describe('asset admin routes', () => {
  it('issues an upload token', async () => {
    const p = await makeProduct()
    const res = await request(app)
      .post('/api/v1/admin/images/upload-token')
      .send({ productId: p.id, contentType: 'image/jpeg', byteSize: 5000 })
    expect(res.status).toBe(201)
    expect(res.body.storageKey).toBe(`products/${p.id}/${res.body.imageId}/original.jpg`)
    expect(res.body.uploadUrl).toContain(res.body.storageKey)
  })

  it('rejects an unsupported content type with a structured error', async () => {
    const p = await makeProduct()
    const res = await request(app)
      .post('/api/v1/admin/images/upload-token')
      .send({ productId: p.id, contentType: 'application/pdf', byteSize: 100 })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('unsupported_content_type')
    expect(typeof res.body.message).toBe('string')
  })

  it('404s an unknown product', async () => {
    const res = await request(app)
      .post('/api/v1/admin/images/upload-token')
      .send({ productId: 'nope', contentType: 'image/jpeg', byteSize: 100 })
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('product_not_found')
  })

  it('413s a file over the ceiling', async () => {
    const p = await makeProduct()
    const res = await request(app)
      .post('/api/v1/admin/images/upload-token')
      .send({ productId: p.id, contentType: 'image/jpeg', byteSize: 50_000_000 })
    expect(res.status).toBe(413)
    expect(res.body.code).toBe('file_too_large')
  })

  it('confirms an upload once the bytes exist', async () => {
    const p = await makeProduct()
    const token = await request(app)
      .post('/api/v1/admin/images/upload-token')
      .send({ productId: p.id, contentType: 'image/jpeg', byteSize: 5000 })
    uploaded[token.body.storageKey] = OBJ

    const res = await request(app).post(`/api/v1/admin/images/${token.body.imageId}/confirm`).send({})
    expect(res.status).toBe(200)
    expect(res.body.width).toBe(1600)
    expect(res.body.height).toBe(1200)
  })

  it('refuses to confirm when nothing was uploaded', async () => {
    const p = await makeProduct()
    const token = await request(app)
      .post('/api/v1/admin/images/upload-token')
      .send({ productId: p.id, contentType: 'image/jpeg', byteSize: 5000 })
    const res = await request(app).post(`/api/v1/admin/images/${token.body.imageId}/confirm`).send({})
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('object_missing')
  })

  it('reorders images', async () => {
    const p = await makeProduct()
    const a = await readyImage(p.id)
    const b = await readyImage(p.id)

    const res = await request(app)
      .put('/api/v1/admin/images/reorder')
      .send({ productId: p.id, orderedIds: [b.imageId, a.imageId] })
    expect(res.status).toBe(200)

    const rows = await prisma.image.findMany({ where: { productId: p.id }, orderBy: { position: 'asc' } })
    expect(rows.map(r => r.id)).toEqual([b.imageId, a.imageId])
  })

  it('rejects a reorder that omits an image', async () => {
    const p = await makeProduct()
    await readyImage(p.id)
    const res = await request(app)
      .put('/api/v1/admin/images/reorder')
      .send({ productId: p.id, orderedIds: [] })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_order')
  })

  it('updates alt text and records who changed it', async () => {
    const p = await makeProduct()
    const a = await readyImage(p.id)

    const res = await request(app)
      .patch(`/api/v1/admin/images/${a.imageId}`)
      .send({ alt: 'Front three-quarter view' })
    expect(res.status).toBe(200)
    expect(res.body.alt).toBe('Front three-quarter view')

    const rows = await prisma.auditLog.findMany({ where: { action: 'image.alt' } })
    expect(rows).toHaveLength(1)
    expect(rows[0].actorId).toBe(actor.id)
    expect(rows[0].target).toBe(`image:${a.imageId}`)
    expect((rows[0].after as any).alt).toBe('Front three-quarter view')
  })

  it('404s an alt-text update for an unknown image', async () => {
    const res = await request(app)
      .patch('/api/v1/admin/images/nope')
      .send({ alt: 'x' })
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('image_not_found')
    expect(await prisma.auditLog.count({ where: { action: 'image.alt' } })).toBe(0)
  })

  // Same unhandled-rejection class fixed in admin-catalog.routes.ts's fail() --
  // an async Express-4 handler whose catch re-throws an unknown error never
  // resolves the request. This router's fail() must respond instead, using
  // this file's own lower_snake convention (deliberately not unified with the
  // catalog router's UPPER_SNAKE).
  it('responds 500 rather than crashing when the storage port fails unexpectedly, and logs a scrubbed value', async () => {
    const p = await makeProduct()
    const failingPort: AssetStoragePort = {
      createUploadTarget: vi.fn(async () => { throw new Error('storage backend unreachable') }),
      stat: vi.fn(async () => null),
      delete: vi.fn(async () => {}),
    }
    const failingApp = express()
    failingApp.use(express.json())
    failingApp.use('/api/v1/admin/images', (req, _res, next) => { req.actor = actor; next() })
    failingApp.use('/api/v1/admin/images', createAssetsRouter(failingPort))

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const res = await request(failingApp)
        .post('/api/v1/admin/images/upload-token')
        .send({ productId: p.id, contentType: 'image/jpeg', byteSize: 100 })
      expect(res.status).toBe(500)
      expect(res.body.code).toBe('internal_error')

      expect(spy).toHaveBeenCalledTimes(1)
      const loggedArgs = spy.mock.calls[0]!
      // Scrubbed, not the raw Error: no argument is an Error instance, and the
      // logged object carries only the scrubError shape.
      expect(loggedArgs.some(a => a instanceof Error)).toBe(false)
      expect(loggedArgs).toContainEqual({ message: 'storage backend unreachable' })
    } finally {
      spy.mockRestore()
    }
  })

  it('deletes an image', async () => {
    const p = await makeProduct()
    const a = await readyImage(p.id)

    const res = await request(app).delete(`/api/v1/admin/images/${a.imageId}`)
    expect(res.status).toBe(204)
    expect(await prisma.image.count({ where: { productId: p.id } })).toBe(0)
  })
})
