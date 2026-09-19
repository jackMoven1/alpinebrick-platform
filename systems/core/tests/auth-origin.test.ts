import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createSession, SESSION_COOKIE } from '../src/auth/session.service.js'
import { createApiKey } from '../src/auth/apikey.service.js'

const app = buildApp()
const ORIGIN = 'https://alpinebrick-admin.onrender.com'

beforeEach(async () => {
  await resetDb()
  process.env.ADMIN_CONSOLE_ORIGIN = ORIGIN
})
afterAll(async () => {
  delete process.env.ADMIN_CONSOLE_ORIGIN
  await prisma.$disconnect()
})

async function cookie(): Promise<string> {
  const actor = await prisma.actor.create({ data: { type: 'human', name: 'jack' } })
  const { token } = await createSession(actor.id)
  return `${SESSION_COOKIE}=${token}`
}

describe('origin validation', () => {
  it('allows a cookie POST from the allowlisted origin', async () => {
    const res = await request(app)
      .post('/api/v1/admin/products/nope/status')
      .set('Cookie', await cookie()).set('Origin', ORIGIN)
      .send({ status: 'published' })
    expect(res.status).toBe(404)   // missing product; not blocked by CSRF
  })

  it('rejects a cookie POST from another origin', async () => {
    const res = await request(app)
      .post('/api/v1/admin/products/nope/status')
      .set('Cookie', await cookie()).set('Origin', 'https://evil.example')
      .send({ status: 'published' })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('FORBIDDEN_ORIGIN')
  })

  it('rejects a cookie POST with no Origin at all', async () => {
    const res = await request(app)
      .post('/api/v1/admin/products/nope/status')
      .set('Cookie', await cookie())
      .send({ status: 'published' })
    expect(res.status).toBe(403)
  })

  // Not browser-driven, carries no Origin, protected by possession of the key.
  it('allows a bearer POST with no Origin', async () => {
    const { plaintext } = await createApiKey({ actorName: 'svc', keyName: 'k' })
    const res = await request(app)
      .post('/api/v1/admin/products/nope/status')
      .set('Authorization', `Bearer ${plaintext}`)
      .send({ status: 'published' })
    expect(res.status).toBe(404)   // missing product; not blocked by CSRF
  })

  it('does not gate GET requests', async () => {
    const res = await request(app).get('/api/v1/admin/products').set('Cookie', await cookie())
    expect(res.status).toBe(200)
  })

  // requireOrigin also covers /api/v1/auth now (item 6): /logout is its only
  // non-GET route, and it carries the same cross-site CSRF exposure as the
  // admin writes -- the session cookie is SameSite=None there too.
  it('gates POST /api/v1/auth/logout the same way', async () => {
    const actor = await prisma.actor.create({ data: { type: 'human', name: 'jack' } })
    const { token: tokenNoOrigin } = await createSession(actor.id)
    const withoutOrigin = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', `${SESSION_COOKIE}=${tokenNoOrigin}`)
    expect(withoutOrigin.status).toBe(403)
    expect(withoutOrigin.body.code).toBe('FORBIDDEN_ORIGIN')

    const { token: tokenWithOrigin } = await createSession(actor.id)
    const withOrigin = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', `${SESSION_COOKIE}=${tokenWithOrigin}`).set('Origin', ORIGIN)
    expect(withOrigin.status).toBe(204)
  })
})
