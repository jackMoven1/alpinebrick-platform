// tests/capture-admin-fixtures.test.ts
// Writes real admin API responses to systems/admin-ui/src/data/__fixtures__/
// so console tests run against core's actual shapes (the lesson of PR #32).
// Skipped unless CAPTURE_ADMIN_FIXTURES=1. Re-run whenever a response shape changes.
import { describe, it, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/prisma.js'
import { resetDb, ensureSystemActor } from './helpers/db.js'
import { createSession, SESSION_COOKIE } from '../src/auth/session.service.js'
import { placeOrder, markOrderPaidTx, PENDING_CHECKOUT_EMAIL } from '../src/orders/orders.service.js'
import { BEFORE_QUOTE_TAX } from '../src/checkout/checkout.service.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const OUT = resolve(__dirname, '../../admin-ui/src/data/__fixtures__')
const ORIGIN = 'https://admin-staging.alpinebrickexchange.com'
const run = process.env.CAPTURE_ADMIN_FIXTURES === '1'

// A 1x1 red PNG, base64. Same as storage-local-adapter.test.ts -- small enough
// to inline, real enough for a header read.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

describe.runIf(run)('capture admin fixtures', () => {
  const app = buildApp()
  let cookie = ''
  // Paths this run writes under the local storage dir (outside OUT), so
  // afterAll can remove them -- otherwise a re-run leaves stray asset files
  // behind under systems/core/var.
  const writtenAssetPaths: string[] = []
  beforeAll(async () => {
    await resetDb()
    process.env.ADMIN_CONSOLE_ORIGIN = ORIGIN
    const a = await prisma.actor.create({ data: { type: 'human', name: 'Jack', email: 'jack@example.com' } })
    cookie = `${SESSION_COOKIE}=${(await createSession(a.id)).token}`
    mkdirSync(OUT, { recursive: true })
  })
  afterAll(async () => {
    for (const p of writtenAssetPaths) rmSync(p, { force: true })
    await prisma.$disconnect()
  })

  const send = (m: 'post' | 'patch' | 'put' | 'get', path: string, body?: Record<string, unknown>) => {
    const r = request(app)[m](`/api/v1/admin${path}`).set('Cookie', cookie).set('Origin', ORIGIN)
    return body === undefined ? r : r.set('Content-Type', 'application/json').send(body)
  }
  const save = (name: string, body: unknown) => writeFileSync(`${OUT}/${name}.json`, JSON.stringify(body, null, 2) + '\n')

  it('captures', async () => {
    const p = (await send('post', '/products', { name: 'Castle Set', productType: 'resale', pieces: 900, features: ['Opening gate'] })).body
    save('product', p)
    const withStock = (await send('post', `/products/${p.id}/variants`, { sku: 'ABE-1001', priceCents: 18900, onHand: 3, attributes: { condition: 'sealed' } })).body
    const v = withStock.variants[0]
    save('product-with-stock', (await send('put', `/variants/${v.id}/stock`, { walmartAllocation: 1, note: 'one for Walmart' })).body)
    save('stock-changed', (await send('put', `/variants/${v.id}/stock`, { onHand: 5, expectedOnHand: 99 })).body)
    save('stock-history', (await send('get', `/variants/${v.id}/stock-history`)).body)
    save('bulk-status', (await send('post', '/products/bulk-status', { ids: [p.id, 'missing-id'], status: 'published' })).body)

    const tok = (await send('post', '/images/upload-token', { productId: p.id, contentType: 'image/png', byteSize: PNG_1X1.length })).body
    save('image-upload-token', tok)
    const dir = process.env.ASSET_STORAGE_DIR ?? './var/assets'
    const tokPath = resolve(dir, tok.storageKey)
    mkdirSync(dirname(tokPath), { recursive: true })
    writeFileSync(tokPath, PNG_1X1)
    writtenAssetPaths.push(tokPath)
    save('image-confirmed', (await send('post', `/images/${tok.imageId}/confirm`, {})).body)
    const bad = (await send('post', '/images/upload-token', { productId: p.id, contentType: 'image/png', byteSize: 999 })).body
    const badPath = resolve(dir, bad.storageKey)
    mkdirSync(dirname(badPath), { recursive: true })
    writeFileSync(badPath, PNG_1X1)
    writtenAssetPaths.push(badPath)
    save('image-rejected', (await send('post', `/images/${bad.imageId}/confirm`, {})).body)
  })

  it('captures orders and shipping settings', async () => {
    await ensureSystemActor()
    const v = await prisma.variant.findFirstOrThrow({ where: { sku: 'ABE-1001' }, include: { product: true } })
    await prisma.product.update({ where: { id: v.productId }, data: { status: 'published' } })
    await prisma.inventory.update({ where: { variantId: v.id }, data: { onHand: 10, reserved: 0, walmartAllocation: null } })
    const placed = await placeOrder({
      email: PENDING_CHECKOUT_EMAIL, shipToState: '', lines: [{ variantId: v.id, quantity: 1 }],
      marketingOptIn: true, referral: { code: 'club', firstSeenAt: new Date('2026-09-26T12:00:00Z') },
    }, BEFORE_QUOTE_TAX)
    await prisma.$transaction((tx) => markOrderPaidTx(tx, placed.id, 'system', {
      email: 'buyer@example.com', shipName: 'Ann Buyer', shipLine1: '1 Main St', shipCity: 'Traverse City',
      shipToState: 'MI', shipPostalCode: '49684', shippingCents: 0, taxCents: 1134, totalCents: 20034,
      taxJurisdiction: 'MI', taxRateBps: 600, squarePaymentId: 'sqpay_fixture', quoteVersion: 1,
      paidAt: new Date('2026-09-27T15:00:00Z'), referralUnmatched: true,
    }))
    save('order-queue', (await send('get', '/orders?tab=to_ship')).body)
    save('order-detail', (await send('get', `/orders/${placed.id}`)).body)
    save('shipping-settings', (await send('get', '/settings/shipping')).body)
  })
})
