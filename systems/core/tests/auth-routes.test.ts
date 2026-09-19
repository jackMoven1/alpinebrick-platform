import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createAuthRouter } from '../src/auth/auth.routes.js'
import { createFakeOidcPort } from '../src/ports/oidc/fake.adapter.js'
import { SESSION_COOKIE } from '../src/auth/session.service.js'

const IDENTITY = { sub: 'google-sub-1', email: 'jack@example.com', emailVerified: true, name: 'Jack' }

function appWith(identity = IDENTITY) {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/auth', createAuthRouter(createFakeOidcPort(identity)))
  return app
}

beforeEach(async () => {
  await resetDb()
  process.env.ADMIN_ALLOWED_EMAILS = 'jack@example.com'
  process.env.ADMIN_CONSOLE_ORIGIN = 'https://console.example'
})
afterAll(async () => {
  delete process.env.ADMIN_ALLOWED_EMAILS
  delete process.env.ADMIN_CONSOLE_ORIGIN
  await prisma.$disconnect()
})

/** Drives start -> callback, carrying the transaction cookie across. */
async function signIn(app: express.Express, code = 'ok') {
  const start = await request(app).get('/api/v1/auth/google/start')
  const txCookie = (start.headers['set-cookie'] as unknown as string[])[0].split(';')[0]
  const url = new URL(start.headers.location)
  const state = url.searchParams.get('state')!
  return request(app)
    .get(`/api/v1/auth/google/callback?code=${code}&state=${encodeURIComponent(state)}`)
    .set('Cookie', txCookie)
}

describe('auth routes', () => {
  it('redirects to the provider and sets a transaction cookie', async () => {
    const res = await request(appWith()).get('/api/v1/auth/google/start')
    expect(res.status).toBe(302)
    expect(res.headers.location).toContain('state=')
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toContain('ab_oauth_tx')
  })

  it('signs in an allowlisted, verified email', async () => {
    const app = appWith()
    const res = await signIn(app)
    expect(res.status).toBe(302)
    const setCookie = (res.headers['set-cookie'] as unknown as string[]).join(';')
    expect(setCookie).toContain(SESSION_COOKIE)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=None')
    expect(setCookie).toContain('Secure')

    const actor = await prisma.actor.findFirst({ where: { googleSub: 'google-sub-1' } })
    expect(actor?.email).toBe('jack@example.com')
    expect(await prisma.adminSession.count()).toBe(1)
  })

  it('refuses an unverified email and creates no actor', async () => {
    const app = appWith({ ...IDENTITY, emailVerified: false })
    const res = await signIn(app)
    expect(res.status).toBe(403)
    expect(await prisma.actor.count()).toBe(0)
    expect(await prisma.adminSession.count()).toBe(0)
  })

  it('refuses an email off the allowlist and creates no actor', async () => {
    const app = appWith({ ...IDENTITY, email: 'stranger@example.com' })
    const res = await signIn(app)
    expect(res.status).toBe(403)
    expect(await prisma.actor.count()).toBe(0)
  })

  it('refuses a mismatched state', async () => {
    const app = appWith()
    const start = await request(app).get('/api/v1/auth/google/start')
    const txCookie = (start.headers['set-cookie'] as unknown as string[])[0].split(';')[0]
    const res = await request(app)
      .get('/api/v1/auth/google/callback?code=ok&state=tampered')
      .set('Cookie', txCookie)
    expect(res.status).toBe(400)
    expect(await prisma.adminSession.count()).toBe(0)
  })

  // The identity key is sub, not email: an email can be reassigned.
  it('keys the actor on sub, so a changed email updates rather than duplicates', async () => {
    await signIn(appWith())
    process.env.ADMIN_ALLOWED_EMAILS = 'jack@example.com,jack2@example.com'
    await signIn(appWith({ ...IDENTITY, email: 'jack2@example.com' }))
    expect(await prisma.actor.count()).toBe(1)
    const actor = await prisma.actor.findFirst()
    expect(actor?.email).toBe('jack2@example.com')
  })

  it('logout revokes the session', async () => {
    const app = appWith()
    const res = await signIn(app)
    const session = (res.headers['set-cookie'] as unknown as string[])
      .find(c => c.startsWith(SESSION_COOKIE))!.split(';')[0]
    await request(app).post('/api/v1/auth/logout').set('Cookie', session).expect(204)
    const row = await prisma.adminSession.findFirst()
    expect(row?.revokedAt).not.toBeNull()
  })

  it('me returns the signed-in actor and 401 without a session', async () => {
    const app = appWith()
    const res = await signIn(app)
    const session = (res.headers['set-cookie'] as unknown as string[])
      .find(c => c.startsWith(SESSION_COOKIE))!.split(';')[0]
    const me = await request(app).get('/api/v1/auth/me').set('Cookie', session)
    expect(me.status).toBe(200)
    expect(me.body.name).toBe('Jack')
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401)
  })
})
