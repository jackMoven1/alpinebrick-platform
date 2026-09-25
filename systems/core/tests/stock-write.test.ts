import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createSession, SESSION_COOKIE } from '../src/auth/session.service.js'
import * as sync from '../src/channels/walmart/inventory.sync.js'

const app = buildApp()
const ORIGIN = 'https://admin-staging.alpinebrickexchange.com'
let cookie: string
let variantId: string

beforeEach(async () => {
  await resetDb()
  vi.restoreAllMocks()
  process.env.ADMIN_CONSOLE_ORIGIN = ORIGIN
  const actor = await prisma.actor.create({ data: { type: 'human', name: 'Jack', email: 'jack@example.com' } })
  cookie = `${SESSION_COOKIE}=${(await createSession(actor.id)).token}`
  const p = await prisma.product.create({ data: { slug: 'p', name: 'P', productType: 'resale' } })
  variantId = (await prisma.variant.create({ data: { productId: p.id, sku: 'A-1', priceCents: 100 } })).id
  await prisma.inventory.create({ data: { variantId, onHand: 5, reserved: 2 } })
})
afterAll(async () => { delete process.env.ADMIN_CONSOLE_ORIGIN; await prisma.$disconnect() })

const put = (body: unknown) => request(app).put(`/api/v1/admin/variants/${variantId}/stock`)
  .set('Cookie', cookie).set('Origin', ORIGIN).set('Content-Type', 'application/json').send(body as object)
const inv = () => prisma.inventory.findUniqueOrThrow({ where: { variantId } })

describe('PUT /variants/:id/stock', () => {
  it('sets an absolute on-hand and audits it with the note', async () => {
    const res = await put({ onHand: 9, expectedOnHand: 5, note: 'recount' })
    expect(res.status).toBe(200)
    expect(res.body.variants[0].inventory).toMatchObject({ onHand: 9, reserved: 2 })
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'variant.stock.set' } })
    expect(a.before).toEqual({ onHand: 5, reserved: 2, walmartAllocation: null })
    expect(a.after).toEqual({ onHand: 9, reserved: 2, walmartAllocation: null, note: 'recount' })
  })

  it('refuses to go below reserved, naming the reserved count', async () => {
    const res = await put({ onHand: 1 })
    expect([res.status, res.body.code]).toEqual([409, 'STOCK_BELOW_RESERVED'])
    expect(res.body.message).toContain('2')
    expect((await inv()).onHand).toBe(5)
  })

  it('refuses a stale expectedOnHand and returns the current figures', async () => {
    const res = await put({ onHand: 9, expectedOnHand: 4 })
    expect([res.status, res.body.code]).toEqual([409, 'STOCK_CHANGED'])
    expect(res.body.details).toEqual({ onHand: 5, reserved: 2, walmartAllocation: null })
  })

  it('sets allocation, including back to shared', async () => {
    expect((await put({ walmartAllocation: 3 })).body.variants[0].inventory)
      .toMatchObject({ walmartAllocation: 3, storefrontAvailable: 0, walmartAvailable: 3 })
    expect((await put({ walmartAllocation: null })).body.variants[0].inventory.walmartAllocation).toBeNull()
  })

  it('refuses reserved + allocation above on-hand, whether from allocation or from on-hand', async () => {
    expect((await put({ walmartAllocation: 4 })).body.code).toBe('ALLOCATION_EXCEEDS_AVAILABLE')
    await put({ walmartAllocation: 3 })
    expect((await put({ onHand: 4 })).body.code).toBe('ALLOCATION_EXCEEDS_AVAILABLE')
    expect((await put({ onHand: 4, walmartAllocation: 2 })).status).toBe(200)
  })

  it('queues the Walmart push after commit, and a failing push does not fail the change', async () => {
    const spy = vi.spyOn(sync, 'enqueueInventoryPush').mockRejectedValue(new Error('outbox down'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await put({ onHand: 7 })
    expect(res.status).toBe(200)
    expect(spy).toHaveBeenCalledWith(variantId)
    expect(err).toHaveBeenCalled()
    expect((await inv()).onHand).toBe(7)
  })

  it('creates a missing inventory row rather than failing', async () => {
    await prisma.inventory.deleteMany()
    expect((await put({ onHand: 1 })).body.variants[0].inventory.onHand).toBe(1)
  })

  it('404s an unknown variant and 400s a bad body', async () => {
    expect((await request(app).put('/api/v1/admin/variants/nope/stock').set('Cookie', cookie).set('Origin', ORIGIN)
      .set('Content-Type', 'application/json').send({ onHand: 1 })).status).toBe(404)
    expect((await put({})).status).toBe(400)
  })
})

describe('GET /variants/:id/stock-history', () => {
  it('lists recent changes newest first, with who and the note', async () => {
    await put({ onHand: 6, note: 'first' })
    await put({ onHand: 7, note: 'second' })
    const res = await request(app).get(`/api/v1/admin/variants/${variantId}/stock-history?limit=10`).set('Cookie', cookie)
    expect(res.status).toBe(200)
    expect(res.body.map((h: any) => [h.note, h.actor])).toEqual([['second', 'jack@example.com'], ['first', 'jack@example.com']])
  })
})
