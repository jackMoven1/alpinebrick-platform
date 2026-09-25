import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createSession, SESSION_COOKIE } from '../src/auth/session.service.js'

const app = buildApp()
const ORIGIN = 'https://admin-staging.alpinebrickexchange.com'
let cookie: string
let productId: string

beforeEach(async () => {
  await resetDb()
  process.env.ADMIN_CONSOLE_ORIGIN = ORIGIN
  const actor = await prisma.actor.create({ data: { type: 'human', name: 'test-admin' } })
  cookie = `${SESSION_COOKIE}=${(await createSession(actor.id)).token}`
  productId = (await prisma.product.create({ data: { slug: 'p', name: 'P', productType: 'resale' } })).id
})
afterAll(async () => { delete process.env.ADMIN_CONSOLE_ORIGIN; await prisma.$disconnect() })

const send = (method: 'post' | 'patch' | 'delete', path: string, body: unknown = {}) =>
  request(app)[method](`/api/v1/admin${path}`)
    .set('Cookie', cookie).set('Origin', ORIGIN).set('Content-Type', 'application/json').send(body as object)

async function addVariant(sku = 'ABE-1', onHand?: number) {
  return send('post', `/products/${productId}/variants`, { sku, priceCents: 1999, ...(onHand !== undefined ? { onHand } : {}) })
}

describe('create', () => {
  it('adds a variant with an inventory row and starting stock', async () => {
    const res = await addVariant('abe-1', 3)
    expect(res.status).toBe(201)
    expect(res.body.variants[0]).toMatchObject({ sku: 'ABE-1', priceCents: 1999, inventory: { onHand: 3, walmartAllocation: null } })
    expect(await prisma.auditLog.count({ where: { action: 'variant.create' } })).toBe(1)
  })
  it('defaults stock to 0', async () => {
    expect((await addVariant()).body.variants[0].inventory.onHand).toBe(0)
  })
  it('reports SKU_TAKEN across products', async () => {
    await addVariant('ABE-1')
    const other = (await prisma.product.create({ data: { slug: 'q', name: 'Q', productType: 'resale' } })).id
    const res = await send('post', `/products/${other}/variants`, { sku: 'ABE-1', priceCents: 1 })
    expect([res.status, res.body.code]).toEqual([409, 'SKU_TAKEN'])
  })
  it('404s an unknown product', async () => {
    expect((await send('post', '/products/nope/variants', { sku: 'X-1', priceCents: 1 })).status).toBe(404)
  })
})

describe('bulk create', () => {
  it('creates all rows in one go', async () => {
    const res = await send('post', `/products/${productId}/variants/bulk`, {
      variants: [{ sku: 'B-S', priceCents: 100, attributes: { size: 'S' } }, { sku: 'B-M', priceCents: 100, attributes: { size: 'M' } }],
    })
    expect(res.status).toBe(201)
    expect(res.body.variants.map((v: any) => v.sku)).toEqual(['B-M', 'B-S'])
  })
  it('creates nothing when any row is invalid', async () => {
    const res = await send('post', `/products/${productId}/variants/bulk`, {
      variants: [{ sku: 'B-S', priceCents: 100 }, { sku: 'B-M', priceCents: 0 }],
    })
    expect(res.status).toBe(400)
    expect(res.body.fields).toHaveProperty(['variants.1.priceCents'])
    expect(await prisma.variant.count()).toBe(0)
  })
  it('rejects duplicate SKUs inside the batch', async () => {
    const res = await send('post', `/products/${productId}/variants/bulk`, {
      variants: [{ sku: 'B-S', priceCents: 1 }, { sku: 'b-s', priceCents: 1 }],
    })
    expect(res.status).toBe(400)
    expect(await prisma.variant.count()).toBe(0)
  })
  it('reports the duplicate SKU under its original row index when an earlier row is also invalid', async () => {
    const res = await send('post', `/products/${productId}/variants/bulk`, {
      variants: [{ sku: 'B-S', priceCents: 0 }, { sku: 'A', priceCents: 1 }, { sku: 'a', priceCents: 1 }],
    })
    expect(res.status).toBe(400)
    expect(res.body.fields['variants.0.priceCents']).toBeTruthy()
    expect(res.body.fields['variants.2.sku']).toBe('duplicates row 2')
    expect(await prisma.variant.count()).toBe(0)
  })
})

describe('update and delete', () => {
  async function sell(variantId: string) {
    await prisma.order.create({ data: {
      email: 'a@example.com', shipToState: 'MI', status: 'paid', subtotalCents: 1999, taxCents: 0, totalCents: 1999,
      taxRateBps: 0, taxJurisdiction: 'MI',
      lines: { create: [{ variantId, sku: 'ABE-1', quantity: 1, unitPriceCents: 1999, lineSubtotalCents: 1999 }] },
    } })
  }

  it('edits price and attributes and audits the change', async () => {
    const v = (await addVariant()).body.variants[0]
    const res = await send('patch', `/variants/${v.id}`, { priceCents: 2499, attributes: { condition: 'sealed' } })
    expect(res.body.variants[0]).toMatchObject({ priceCents: 2499, attributes: { condition: 'sealed' } })
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'variant.update' } })
    expect(a.before).toEqual({ priceCents: 1999, attributes: {} })
  })

  it('renames an unsold SKU but refuses once sold', async () => {
    const v = (await addVariant()).body.variants[0]
    expect((await send('patch', `/variants/${v.id}`, { sku: 'ABE-2' })).body.variants[0].sku).toBe('ABE-2')
    await sell(v.id)
    const res = await send('patch', `/variants/${v.id}`, { sku: 'ABE-3' })
    expect([res.status, res.body.code]).toEqual([409, 'SKU_LOCKED'])
    // price is still editable on a sold variant
    expect((await send('patch', `/variants/${v.id}`, { priceCents: 100 })).status).toBe(200)
  })

  it('refuses a SKU change while a live Walmart listing exists, allows it once retired', async () => {
    const v = (await addVariant()).body.variants[0]
    const l = await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-1-W', status: 'live' } })
    expect((await send('patch', `/variants/${v.id}`, { sku: 'ABE-9' })).body.code).toBe('SKU_LOCKED')
    await prisma.channelListing.update({ where: { id: l.id }, data: { status: 'retired' } })
    expect((await send('patch', `/variants/${v.id}`, { sku: 'ABE-9' })).status).toBe(200)
  })

  it('deletes an unsold variant, with its inventory, and audits it', async () => {
    const v = (await addVariant('ABE-1', 2)).body.variants[0]
    const res = await send('delete', `/variants/${v.id}`)
    expect([res.status, res.body.variants]).toEqual([200, []])
    expect(await prisma.inventory.count()).toBe(0)
    expect(await prisma.auditLog.count({ where: { action: 'variant.delete' } })).toBe(1)
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'variant.delete' } })
    expect(audit.before).toMatchObject({ onHand: 2 })
  })

  it('refuses to delete a sold variant or one with a live listing', async () => {
    const sold = (await addVariant('ABE-1')).body.variants[0]
    await sell(sold.id)
    expect((await send('delete', `/variants/${sold.id}`)).body.code).toBe('VARIANT_HAS_SALES')
    const listed = (await addVariant('ABE-2')).body.variants.find((x: any) => x.sku === 'ABE-2')
    await prisma.channelListing.create({ data: { variantId: listed.id, walmartSku: 'ABE-2-W', status: 'submitted' } })
    expect((await send('delete', `/variants/${listed.id}`)).body.code).toBe('VARIANT_HAS_SALES')
    expect(await prisma.channelListing.count()).toBe(1)
  })

  it('404s an unknown variant', async () => {
    expect((await send('patch', '/variants/nope', { priceCents: 1 })).status).toBe(404)
    expect((await send('delete', '/variants/nope')).status).toBe(404)
  })
})
