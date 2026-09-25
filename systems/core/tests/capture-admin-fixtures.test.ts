// tests/capture-admin-fixtures.test.ts
// Writes real admin API responses to systems/admin-ui/src/data/__fixtures__/
// so console tests run against core's actual shapes (the lesson of PR #32).
// Skipped unless CAPTURE_ADMIN_FIXTURES=1. Re-run whenever a response shape changes.
import { describe, it, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createSession, SESSION_COOKIE } from '../src/auth/session.service.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const OUT = resolve(__dirname, '../../admin-ui/src/data/__fixtures__')
const ORIGIN = 'https://admin-staging.alpinebrickexchange.com'
const run = process.env.CAPTURE_ADMIN_FIXTURES === '1'

describe.runIf(run)('capture admin fixtures', () => {
  const app = buildApp()
  let cookie = ''
  beforeAll(async () => {
    await resetDb()
    process.env.ADMIN_CONSOLE_ORIGIN = ORIGIN
    const a = await prisma.actor.create({ data: { type: 'human', name: 'Jack', email: 'jack@example.com' } })
    cookie = `${SESSION_COOKIE}=${(await createSession(a.id)).token}`
    mkdirSync(OUT, { recursive: true })
  })
  afterAll(() => prisma.$disconnect())

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
  })
})
