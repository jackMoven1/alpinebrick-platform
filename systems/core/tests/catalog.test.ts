import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { buildApp } from '../src/app.js'

const app = buildApp()
beforeEach(async () => { await resetDb(); await seed() })
afterAll(() => prisma.$disconnect())

describe('catalog API', () => {
  it('lists only published products with total', async () => {
    const res = await request(app).get('/api/v1/catalog/products')
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(2)
    expect(res.body.items).toHaveLength(2)
  })

  it('gets a product by slug', async () => {
    const res = await request(app).get('/api/v1/catalog/products/brick-builder-set')
    expect(res.status).toBe(200)
    expect(res.body.productType).toBe('own_designed')
  })

  it('returns 404 for an unknown product', async () => {
    const res = await request(app).get('/api/v1/catalog/products/nope')
    expect(res.status).toBe(404)
  })

  it('reports availability as onHand minus reserved', async () => {
    const res = await request(app).get('/api/v1/catalog/products/castle-mega-pack/availability')
    expect(res.status).toBe(200)
    expect(res.body[0].available).toBe(8)
  })
})
