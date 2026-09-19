import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createSession, SESSION_COOKIE } from '../src/auth/session.service.js'

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

// Spec §6 layer 3: admin writes require Content-Type: application/json. No
// hole is open without it (layer 2 -- requireOrigin -- already catches a
// cross-site form POST); this is the budgeted margin for CORS drifting *and*
// someone independently loosening the Origin check.
describe('admin write content-type validation', () => {
  it('allows a write with a bare application/json content type', async () => {
    const res = await request(app)
      .post('/api/v1/admin/products/nope/status')
      .set('Cookie', await cookie()).set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .send({ status: 'published' })
    expect(res.status).toBe(404) // missing product; not blocked by CSRF
  })

  // Content-Type may legitimately carry parameters.
  it('allows a write with application/json plus a charset parameter', async () => {
    const res = await request(app)
      .post('/api/v1/admin/products/nope/status')
      .set('Cookie', await cookie()).set('Origin', ORIGIN)
      .set('Content-Type', 'application/json; charset=utf-8')
      .send(JSON.stringify({ status: 'published' }))
    expect(res.status).toBe(404)
  })

  it('rejects a write with a non-JSON content type', async () => {
    const res = await request(app)
      .post('/api/v1/admin/products/nope/status')
      .set('Cookie', await cookie()).set('Origin', ORIGIN)
      .set('Content-Type', 'text/plain')
      .send('status=published')
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('UNSUPPORTED_CONTENT_TYPE')
  })

  it('rejects a write with a urlencoded content type (what a cross-site HTML form can send)', async () => {
    const res = await request(app)
      .post('/api/v1/admin/products/nope/status')
      .set('Cookie', await cookie()).set('Origin', ORIGIN)
      .type('form')
      .send({ status: 'published' })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('UNSUPPORTED_CONTENT_TYPE')
  })

  it('rejects a write with no content type at all', async () => {
    const res = await request(app)
      .post('/api/v1/admin/products/nope/status')
      .set('Cookie', await cookie()).set('Origin', ORIGIN)
      .unset('Content-Type')
      .send()
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('UNSUPPORTED_CONTENT_TYPE')
  })

  // Bearer requests are NOT exempt from this layer (unlike layer 2) -- the
  // spec states it as a flat rule on admin writes, with no bearer carve-out.
  it('also gates a bearer-authenticated write', async () => {
    const { createApiKey } = await import('../src/auth/apikey.service.js')
    const { plaintext } = await createApiKey({ actorName: 'svc', keyName: 'k' })
    const res = await request(app)
      .post('/api/v1/admin/products/nope/status')
      .set('Authorization', `Bearer ${plaintext}`)
      .type('form')
      .send({ status: 'published' })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('UNSUPPORTED_CONTENT_TYPE')
  })

  it('does not gate GET requests', async () => {
    const res = await request(app).get('/api/v1/admin/products').set('Cookie', await cookie())
    expect(res.status).toBe(200)
  })
})
