import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { format } from 'node:util'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createAuthRouter } from '../src/auth/auth.routes.js'
import { createFakeOidcPort } from '../src/ports/oidc/fake.adapter.js'
import { SESSION_COOKIE } from '../src/auth/session.service.js'
import type { OidcPort } from '../src/ports/oidc/oidc.port.js'

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

  // Task 8 review, Important 3: this is the PKCE binding the whole flow
  // exists to establish. Without it, `start` and `callback` could disagree
  // about which secret was used and every route test above would still pass.
  it('binds the challenge sent to the provider to the verifier carried in the tx cookie', async () => {
    const start = await request(appWith()).get('/api/v1/auth/google/start')
    const txCookie = (start.headers['set-cookie'] as unknown as string[])[0].split(';')[0]
    const value = txCookie.slice(txCookie.indexOf('=') + 1)
    const tx = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const url = new URL(start.headers.location)
    const challenge = url.searchParams.get('code_challenge')
    expect(challenge).toBe(createHash('sha256').update(tx.codeVerifier).digest('base64url'))
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

  // Task 8 review, Important 1: a known email arriving under a sub the DB
  // has never seen (account recreated/migrated, or simply a second Google
  // account with the same address) must not lock the operator out with an
  // opaque 500 -- it needs a distinct, actionable response.
  it('returns a distinct conflict when the email is already linked to a different actor', async () => {
    await prisma.actor.create({ data: { type: 'human', name: 'Jack', email: 'jack@example.com' } })
    const app = appWith({ ...IDENTITY, sub: 'google-sub-2' })
    // Only un-spied console.error path on this router until now -- adopt the
    // sibling spy-and-assert pattern (see "scrubs the raw error" below) so
    // the suite stops writing to stderr AND this scrubbing is actually
    // verified rather than merely exercised.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const res = await signIn(app)
      expect(res.status).toBe(409)
      expect(res.body.code).toBe('EMAIL_ALREADY_LINKED')
      expect(await prisma.adminSession.count()).toBe(0)

      expect(spy).toHaveBeenCalledTimes(1)
      const loggedArgs = spy.mock.calls[0]!
      expect(loggedArgs[0]).toBe('[auth] email already linked to a different googleSub')
      expect(loggedArgs.some(a => a instanceof Error)).toBe(false)
      expect(loggedArgs[1]).toMatchObject({ code: 'P2002' })
    } finally {
      spy.mockRestore()
    }
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

  // Task 8 review round 2: the exchange-failure catch must scrub the raw
  // error before logging it. The routine failure there -- an expired,
  // replayed, or tampered authorization code -- throws an error carrying the
  // request's own body (code, PKCE codeVerifier, client_secret) as
  // enumerable properties, and neither gaxios's redactor nor a bare
  // `console.error(msg, err)` strips `code`/`code_verifier`. This proves the
  // fix by planting both secrets in a thrown error and asserting neither
  // reaches the log.
  it('scrubs the raw error so a failed exchange never logs the code or PKCE verifier', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const leaky = new Error('invalid_grant') as Error & { config: unknown }
      leaky.config = {
        data: new URLSearchParams({
          code: 'SECRET_CODE_123',
          code_verifier: 'SECRET_VERIFIER_456',
          client_secret: 'also-secret',
          grant_type: 'authorization_code',
        }),
      }
      const throwingOidc: OidcPort = {
        authUrl: ({ state, codeChallenge }) =>
          `https://accounts.example/fake?state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(codeChallenge)}`,
        exchange: async () => { throw leaky },
      }
      const app = express()
      app.use(express.json())
      app.use('/api/v1/auth', createAuthRouter(throwingOidc))

      const start = await request(app).get('/api/v1/auth/google/start')
      const txCookie = (start.headers['set-cookie'] as unknown as string[])[0].split(';')[0]
      const url = new URL(start.headers.location)
      const state = url.searchParams.get('state')!
      const res = await request(app)
        .get(`/api/v1/auth/google/callback?code=whatever&state=${encodeURIComponent(state)}`)
        .set('Cookie', txCookie)

      expect(res.status).toBe(400)
      expect(spy).toHaveBeenCalled()
      // JSON.stringify cannot see this: URLSearchParams keeps its data in
      // internal slots, not enumerable own properties, so
      // JSON.stringify(leaky) is "{}" regardless of whether the logged value
      // was scrubbed -- that assertion would pass even against the raw
      // error. console.error actually formats its arguments with
      // util.format (util.inspect under the hood), which DOES walk into a
      // URLSearchParams and print its entries. Reproduce that formatting
      // here so the assertion exercises the real leak vector.
      const logged = spy.mock.calls.map(call => format(...call)).join('\n')
      expect(logged).not.toContain('SECRET_CODE_123')
      expect(logged).not.toContain('SECRET_VERIFIER_456')
    } finally {
      spy.mockRestore()
    }
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

  // The actor must be resolved BEFORE the session is revoked -- resolving
  // after would find nothing (a revoked session resolves to null) and no row
  // would be written at all.
  it('logout records an audit row for the actor who signed out', async () => {
    const app = appWith()
    const res = await signIn(app)
    const session = (res.headers['set-cookie'] as unknown as string[])
      .find(c => c.startsWith(SESSION_COOKIE))!.split(';')[0]
    const actor = await prisma.actor.findFirst({ where: { googleSub: 'google-sub-1' } })

    await request(app).post('/api/v1/auth/logout').set('Cookie', session).expect(204)

    const rows = await prisma.auditLog.findMany({ where: { action: 'auth.logout' } })
    expect(rows).toHaveLength(1)
    expect(rows[0].actorId).toBe(actor!.id)
    expect(rows[0].target).toBe(`actor:${actor!.id}`)
  })

  // No session cookie at all -- nothing to resolve, nothing to record, and
  // still a clean 204 (matches the pre-existing no-op behaviour).
  it('logout with no session cookie writes no audit row', async () => {
    const app = appWith()
    await request(app).post('/api/v1/auth/logout').expect(204)
    expect(await prisma.auditLog.count()).toBe(0)
  })

  // Task 12 review, item 3: an off-allowlist or unverified-email rejection
  // creates no Actor (see the "Order matters" comment in auth.routes.ts), so
  // no row can be attributed without inventing one -- decided to skip those
  // rather than borrow the codebase's 'system' sentinel actor, which is
  // provisioned by a manual `npm run seed` step and not guaranteed present.
  // A disabled-actor rejection is different: the Actor already exists by
  // that point, so it IS recorded.
  it('records a rejected sign-in when the actor is disabled, since an Actor already exists', async () => {
    const app = appWith()
    await signIn(app)
    const actor = await prisma.actor.findFirst({ where: { googleSub: 'google-sub-1' } })
    await prisma.actor.update({ where: { id: actor!.id }, data: { disabled: true } })

    const res = await signIn(app)
    expect(res.status).toBe(403)

    const rows = await prisma.auditLog.findMany({ where: { action: 'auth.signin.rejected' } })
    expect(rows).toHaveLength(1)
    expect(rows[0].actorId).toBe(actor!.id)
    expect(rows[0].target).toBe(`actor:${actor!.id}`)
  })

  it('writes no audit row for an unverified-email or off-allowlist rejection, since no Actor exists yet', async () => {
    await signIn(appWith({ ...IDENTITY, emailVerified: false }))
    await signIn(appWith({ ...IDENTITY, email: 'stranger@example.com' }))
    expect(await prisma.auditLog.count()).toBe(0)
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
