import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'

const app = buildApp()

async function make(slug: string, status: 'draft' | 'published' | 'archived') {
  return prisma.product.create({
    data: {
      slug, name: slug, productType: 'resale', status,
      variants: { create: [{ sku: `${slug}-1`, priceCents: 1000 }] },
    },
  })
}

beforeEach(async () => { await resetDb() })
afterAll(async () => { await prisma.$disconnect() })

describe('admin catalog routes', () => {
  it('lists every status', async () => {
    await make('d', 'draft'); await make('p', 'published')
    const res = await request(app).get('/api/v1/admin/products')
    expect(res.status).toBe(200)
    expect(res.body.items.map((i: any) => i.slug).sort()).toEqual(['d', 'p'])
    expect(res.body.items[0]).toHaveProperty('variantCount')
    expect(res.body.items[0]).toHaveProperty('updatedAt')
  })

  it('filters by status', async () => {
    await make('d', 'draft'); await make('p', 'published')
    const res = await request(app).get('/api/v1/admin/products?status=draft')
    expect(res.body.items.map((i: any) => i.slug)).toEqual(['d'])
  })

  it('rejects a bad status with a structured error', async () => {
    const res = await request(app).get('/api/v1/admin/products?status=bogus')
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_ERROR')
    expect(typeof res.body.message).toBe('string')
  })

  it('loads a draft by id', async () => {
    const p = await make('draft-detail', 'draft')
    const res = await request(app).get(`/api/v1/admin/products/${p.id}`)
    expect(res.status).toBe(200)
    expect(res.body.slug).toBe('draft-detail')
  })

  it('404s an unknown product', async () => {
    const res = await request(app).get('/api/v1/admin/products/nope')
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })

  it('publishes a draft', async () => {
    const p = await make('to-publish', 'draft')
    const res = await request(app)
      .post(`/api/v1/admin/products/${p.id}/status`).send({ status: 'published' })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('published')
  })

  it('409s an illegal transition', async () => {
    const p = await make('arch', 'archived')
    const res = await request(app)
      .post(`/api/v1/admin/products/${p.id}/status`).send({ status: 'published' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('INVALID_TRANSITION')
  })

  it('400s a missing status in the body', async () => {
    const p = await make('nobody', 'draft')
    const res = await request(app).post(`/api/v1/admin/products/${p.id}/status`).send({})
    expect(res.status).toBe(400)
  })

  it('returns overview counts', async () => {
    await make('d', 'draft'); await make('p', 'published')
    const res = await request(app).get('/api/v1/admin/overview')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ totalProducts: 2, draft: 1, published: 1 })
    expect(res.body).not.toHaveProperty('missingImages')
  })

  // The regression that would leak unpublished products to customers.
  it('does not widen the PUBLIC catalog route', async () => {
    await make('still-secret', 'draft')
    const res = await request(app).get('/api/v1/catalog/products')
    expect(res.body.items.map((i: any) => i.slug)).not.toContain('still-secret')
  })
})
