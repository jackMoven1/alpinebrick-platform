import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createSession, SESSION_COOKIE } from '../src/auth/session.service.js'
import { setProductStatus } from '../src/admin/admin-catalog.service.js'
import { getProduct as publicGetProduct, listProducts } from '../src/catalog/catalog.service.js'

const app = buildApp()
const ORIGIN = 'https://admin-staging.alpinebrickexchange.com'
let cookie: string
let actorId: string

beforeEach(async () => {
  await resetDb()
  process.env.ADMIN_CONSOLE_ORIGIN = ORIGIN
  actorId = (await prisma.actor.create({ data: { type: 'human', name: 'test-admin' } })).id
  cookie = `${SESSION_COOKIE}=${(await createSession(actorId)).token}`
})
afterAll(async () => { delete process.env.ADMIN_CONSOLE_ORIGIN; await prisma.$disconnect() })

const send = (method: 'post' | 'patch', path: string, body: unknown) =>
  request(app)[method](`/api/v1/admin${path}`)
    .set('Cookie', cookie).set('Origin', ORIGIN).set('Content-Type', 'application/json').send(body as object)

describe('POST /products', () => {
  it('creates a draft with a derived slug and audits it', async () => {
    const res = await send('post', '/products', { name: 'Castle Set', productType: 'resale', status: 'published' })
    expect(res.status).toBe(400) // status is not writable here
    const ok = await send('post', '/products', { name: 'Castle Set', productType: 'resale', pieces: 900 })
    expect(ok.status).toBe(201)
    expect(ok.body).toMatchObject({ slug: 'castle-set', status: 'draft', pieces: 900, locked: { slug: false }, variants: [] })
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'product.create' } })
    expect([audit.actorId, audit.target]).toEqual([actorId, `product:${ok.body.id}`])
  })

  it('returns field errors for bad input', async () => {
    const res = await send('post', '/products', { productType: 'toy' })
    expect(res.status).toBe(400)
    expect(Object.keys(res.body.fields).sort()).toEqual(['name', 'productType'])
  })

  it('reports SLUG_TAKEN from the unique constraint', async () => {
    await send('post', '/products', { name: 'Castle', productType: 'resale' })
    const res = await send('post', '/products', { name: 'Castle', productType: 'resale' })
    expect([res.status, res.body.code]).toEqual([409, 'SLUG_TAKEN'])
  })

  it('is not visible on the public storefront until published', async () => {
    const res = await send('post', '/products', { name: 'Hidden', productType: 'resale' })
    expect(res.status).toBe(201)
    expect(await publicGetProduct(res.body.id)).toBeNull()
    const list = await listProducts({})
    expect(list.items.map((i) => i.slug)).not.toContain('hidden')
  })
})

describe('PATCH /products/:id', () => {
  async function created() {
    return (await send('post', '/products', { name: 'Castle', productType: 'resale' })).body
  }

  it('updates only what was sent and audits only what changed', async () => {
    const p = await created()
    const res = await send('patch', `/products/${p.id}`, { name: 'Castle', pieces: 1200, features: ['Lights'] })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ name: 'Castle', pieces: 1200, features: ['Lights'] })
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'product.update' } })
    expect(audit.before).toEqual({ pieces: null, features: [] })
    expect(audit.after).toEqual({ pieces: 1200, features: ['Lights'] })
  })

  it('writes no audit row for a no-op patch', async () => {
    const p = await created()
    await send('patch', `/products/${p.id}`, { name: 'Castle' })
    expect(await prisma.auditLog.count({ where: { action: 'product.update' } })).toBe(0)
  })

  it('allows a slug change before first publish', async () => {
    const p = await created()
    expect((await send('patch', `/products/${p.id}`, { slug: 'castle-2' })).body.slug).toBe('castle-2')
  })

  it('locks the slug after first publish, even once unpublished', async () => {
    const p = await created()
    await setProductStatus(p.id, 'published', actorId)
    await setProductStatus(p.id, 'draft', actorId)
    const res = await send('patch', `/products/${p.id}`, { slug: 'new-url' })
    expect([res.status, res.body.code]).toEqual([409, 'SLUG_LOCKED'])
    // Sending the unchanged slug is fine.
    expect((await send('patch', `/products/${p.id}`, { slug: 'castle' })).status).toBe(200)
  })

  it('edits a published product live', async () => {
    const p = await created()
    await setProductStatus(p.id, 'published', actorId)
    await send('patch', `/products/${p.id}`, { name: 'Castle Deluxe' })
    expect((await publicGetProduct(p.id))?.name).toBe('Castle Deluxe')
  })

  it('404s an unknown product', async () => {
    expect((await send('patch', '/products/nope', { name: 'x' })).status).toBe(404)
  })
})

describe('POST /products/bulk-status', () => {
  it('reports each product separately and does not roll back the others', async () => {
    const a = (await send('post', '/products', { name: 'A', productType: 'resale' })).body
    const b = (await send('post', '/products', { name: 'B', productType: 'resale' })).body
    await setProductStatus(b.id, 'archived', actorId)
    const res = await send('post', '/products/bulk-status', { ids: [a.id, b.id, 'nope'], status: 'published' })
    expect(res.status).toBe(200)
    expect(res.body.results).toEqual([
      { id: a.id, ok: true },
      { id: b.id, ok: false, code: 'INVALID_TRANSITION', message: expect.any(String) },
      { id: 'nope', ok: false, code: 'NOT_FOUND', message: expect.any(String) },
    ])
    expect((await prisma.product.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('published')
  })

  it('validates the body', async () => {
    expect((await send('post', '/products/bulk-status', { ids: [], status: 'published' })).status).toBe(400)
  })
})
