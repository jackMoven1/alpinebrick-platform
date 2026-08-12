import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { buildApp } from '../src/app.js'

const app = buildApp()
beforeEach(async () => { await resetDb(); await seed() })
afterAll(() => prisma.$disconnect())

async function variantId(sku: string) {
  const v = await prisma.variant.findFirstOrThrow({ where: { sku } })
  return v.id
}

describe('orders API', () => {
  it('places an order and returns 201 with computed totals', async () => {
    const vid = await variantId('BBS-STD')
    const res = await request(app).post('/api/v1/orders')
      .send({ email: 'buyer@example.com', shipToState: 'MI', lines: [{ variantId: vid, quantity: 1 }] })
    expect(res.status).toBe(201)
    expect(res.body.status).toBe('pending')
    expect(res.body.taxCents).toBe(300)
    expect(res.body.totalCents).toBe(5299)
  })

  it('returns 400 with the error code when stock is insufficient', async () => {
    const vid = await variantId('CMP-LTD') // onHand 8
    const res = await request(app).post('/api/v1/orders')
      .send({ email: 'b@example.com', shipToState: 'MI', lines: [{ variantId: vid, quantity: 99 }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('insufficient_stock')
  })

  it('gets an order by id and 404s for an unknown id', async () => {
    const vid = await variantId('BBS-STD')
    const placed = await request(app).post('/api/v1/orders')
      .send({ email: 'b@example.com', shipToState: 'MI', lines: [{ variantId: vid, quantity: 1 }] })
    const got = await request(app).get(`/api/v1/orders/${placed.body.id}`)
    expect(got.status).toBe(200)
    expect(got.body.id).toBe(placed.body.id)
    expect((await request(app).get('/api/v1/orders/nope')).status).toBe(404)
  })
})
