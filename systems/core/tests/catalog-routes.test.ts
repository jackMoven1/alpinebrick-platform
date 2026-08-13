import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'

const app = buildApp()

describe('catalog routes', () => {
  beforeAll(async () => {
    await resetDb()
    await prisma.product.create({
      data: {
        slug: 'route-fixture', name: 'Route Fixture', productType: 'resale',
        status: 'published', categories: ['space'],
        images: [{ url: '/img/r.jpg', alt: 'Route fixture' }],
        homePosition: 1, collectionPosition: 1,
        variants: { create: [{ sku: 'RF-1', priceCents: 2500 }] },
      },
    })
  })
  afterAll(async () => { await prisma.$disconnect() })

  it('passes category and sort through to the service', async () => {
    const res = await request(app).get('/api/v1/catalog/products?category=space&sort=price_asc')
    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].slug).toBe('route-fixture')
    expect(res.body.items[0].images).toEqual([{ url: '/img/r.jpg', alt: 'Route fixture' }])
    expect(res.body.pageSize).toBe(20)
  })

  it('accepts the display sorts', async () => {
    for (const sort of ['home_display', 'collection_display']) {
      const res = await request(app).get(`/api/v1/catalog/products?sort=${sort}`)
      expect(res.status).toBe(200)
      expect(res.body.items).toHaveLength(1)
    }
  })

  it('returns VALIDATION_ERROR with the offending field for a bad sort', async () => {
    const res = await request(app).get('/api/v1/catalog/products?sort=cheapest')
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_ERROR')
    expect(typeof res.body.message).toBe('string')
    expect(res.body.fields).toHaveProperty('sort')
  })

  it('returns VALIDATION_ERROR for a non-numeric page', async () => {
    const res = await request(app).get('/api/v1/catalog/products?page=abc')
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_ERROR')
    expect(res.body.fields).toHaveProperty('page')
  })

  it('returns VALIDATION_ERROR for a pageSize above the maximum', async () => {
    const res = await request(app).get('/api/v1/catalog/products?pageSize=101')
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_ERROR')
    expect(res.body.fields).toHaveProperty('pageSize')
  })

  it('returns NOT_FOUND with the structured envelope', async () => {
    const res = await request(app).get('/api/v1/catalog/products/does-not-exist')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) })
  })

  it('returns NOT_FOUND for availability on a missing product', async () => {
    const res = await request(app).get('/api/v1/catalog/products/nope/availability')
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })
})
