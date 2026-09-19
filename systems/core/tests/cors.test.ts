import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createSession, SESSION_COOKIE } from '../src/auth/session.service.js'

const app = buildApp()
const ADMIN_ORIGIN = 'https://alpinebrick-admin.onrender.com'
const STOREFRONT_ORIGIN = 'https://www.alpinebrickexchange.com'
const UNLISTED_ORIGIN = 'https://evil.example'

beforeEach(async () => {
  await resetDb()
  process.env.ADMIN_CONSOLE_ORIGIN = ADMIN_ORIGIN
  process.env.STOREFRONT_ORIGIN = STOREFRONT_ORIGIN
})
afterAll(async () => {
  delete process.env.ADMIN_CONSOLE_ORIGIN
  delete process.env.STOREFRONT_ORIGIN
  await prisma.$disconnect()
})

async function cookie(): Promise<string> {
  const actor = await prisma.actor.create({ data: { type: 'human', name: 'jack' } })
  const { token } = await createSession(actor.id)
  return `${SESSION_COOKIE}=${token}`
}

// This is the test that matters most: it must fail if CORS is mounted after
// requireAuth, because a preflight OPTIONS carries no cookie and no
// Authorization header -- if requireAuth runs first, every preflight 401s
// and the real request behind it is never sent.
describe('preflight OPTIONS succeeds unauthenticated', () => {
  it('admin surface', async () => {
    const res = await request(app)
      .options('/api/v1/admin/products')
      .set('Origin', ADMIN_ORIGIN)
      .set('Access-Control-Request-Method', 'GET')
    expect(res.status).toBe(204)
    expect(res.text).toBe('')
  })

  it('auth surface', async () => {
    const res = await request(app)
      .options('/api/v1/auth/logout')
      .set('Origin', ADMIN_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
    expect(res.status).toBe(204)
    expect(res.text).toBe('')
  })

  it('catalog surface', async () => {
    const res = await request(app)
      .options('/api/v1/catalog/products')
      .set('Origin', STOREFRONT_ORIGIN)
      .set('Access-Control-Request-Method', 'GET')
    expect(res.status).toBe(204)
    expect(res.text).toBe('')
  })
})

describe('allowlisted origin is echoed exactly; unlisted origin gets no header', () => {
  it('admin echoes the allowlisted console origin', async () => {
    const res = await request(app)
      .get('/api/v1/admin/products')
      .set('Cookie', await cookie())
      .set('Origin', ADMIN_ORIGIN)
    expect(res.headers['access-control-allow-origin']).toBe(ADMIN_ORIGIN)
  })

  it('admin gives no header for an unlisted origin (never *)', async () => {
    const res = await request(app)
      .get('/api/v1/admin/products')
      .set('Cookie', await cookie())
      .set('Origin', UNLISTED_ORIGIN)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('catalog echoes the allowlisted storefront origin', async () => {
    const res = await request(app).get('/api/v1/catalog/products').set('Origin', STOREFRONT_ORIGIN)
    expect(res.headers['access-control-allow-origin']).toBe(STOREFRONT_ORIGIN)
  })

  it('catalog gives no header for an unlisted origin, but the request still succeeds', async () => {
    const res = await request(app).get('/api/v1/catalog/products').set('Origin', UNLISTED_ORIGIN)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    expect(res.status).toBe(200)
  })

  it('the console origin is never permitted on the catalog allowlist', async () => {
    // The two allowlists must not be interchangeable -- the storefront being
    // permitted to call admin endpoints is exactly what auth exists to
    // prevent, and the same must hold in reverse.
    const res = await request(app).get('/api/v1/catalog/products').set('Origin', ADMIN_ORIGIN)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('Access-Control-Allow-Credentials present only where cookies are used', () => {
  it('present on admin', async () => {
    const res = await request(app)
      .get('/api/v1/admin/products')
      .set('Cookie', await cookie())
      .set('Origin', ADMIN_ORIGIN)
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  it('present on auth', async () => {
    const res = await request(app)
      .options('/api/v1/auth/logout')
      .set('Origin', ADMIN_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  it('absent on catalog', async () => {
    const res = await request(app).get('/api/v1/catalog/products').set('Origin', STOREFRONT_ORIGIN)
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
  })
})

describe('Vary: Origin is present on every response', () => {
  it('present when the origin matches', async () => {
    const res = await request(app).get('/api/v1/catalog/products').set('Origin', STOREFRONT_ORIGIN)
    expect(res.headers['vary']).toContain('Origin')
  })

  it('present when the origin does not match', async () => {
    const res = await request(app).get('/api/v1/catalog/products').set('Origin', UNLISTED_ORIGIN)
    expect(res.headers['vary']).toContain('Origin')
  })

  it('present when no Origin header is sent at all', async () => {
    const res = await request(app).get('/api/v1/catalog/products')
    expect(res.headers['vary']).toContain('Origin')
  })
})

describe('the catalog surface still works for the storefront real GETs', () => {
  it('returns the catalog JSON body, not blocked by CORS handling', async () => {
    const res = await request(app).get('/api/v1/catalog/products').set('Origin', STOREFRONT_ORIGIN)
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('items')
  })
})
