import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import request from 'supertest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createSession, SESSION_COOKIE } from '../src/auth/session.service.js'

// admin-catalog.routes.ts has no dependency-injection point (unlike
// assets.routes.ts's createAssetsRouter(port)), so the only way to drive a
// genuine unknown (non-AdminError) failure through the real route -- rather
// than asserting on fail()'s branching in isolation -- is to make the real
// service throw. Scoped to this file only; no other test file mocks this
// module, so the rest of the suite still exercises the real service.
vi.mock('../src/admin/admin-catalog.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/admin/admin-catalog.service.js')>()
  return {
    ...actual,
    setProductStatus: vi.fn(async () => { throw new Error('unexpected db failure') }),
  }
})

const { buildApp } = await import('../src/app.js')
const app = buildApp()
const ORIGIN = 'https://console.example'

beforeEach(async () => {
  await resetDb()
  process.env.ADMIN_CONSOLE_ORIGIN = ORIGIN
})
afterAll(async () => {
  delete process.env.ADMIN_CONSOLE_ORIGIN
  await prisma.$disconnect()
})

describe("admin-catalog.routes.ts's fail() on an unknown error", () => {
  it('responds 500 INTERNAL_ERROR rather than crashing, and logs a scrubbed value', async () => {
    const actor = await prisma.actor.create({ data: { type: 'human', name: 'jack' } })
    const { token } = await createSession(actor.id)
    const p = await prisma.product.create({
      data: { slug: 'fails', name: 'Fails', productType: 'resale', status: 'draft' },
    })

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const res = await request(app)
        .post(`/api/v1/admin/products/${p.id}/status`)
        .set('Cookie', `${SESSION_COOKIE}=${token}`).set('Origin', ORIGIN)
        .send({ status: 'published' })

      expect(res.status).toBe(500)
      expect(res.body.code).toBe('INTERNAL_ERROR')

      expect(spy).toHaveBeenCalledTimes(1)
      const loggedArgs = spy.mock.calls[0]!
      // Scrubbed, not the raw Error: no argument is an Error instance, and the
      // logged object carries only the scrubError shape (message, plus code/
      // status when present) -- never the original error's other properties.
      expect(loggedArgs.some(a => a instanceof Error)).toBe(false)
      expect(loggedArgs).toContainEqual({ message: 'unexpected db failure' })
    } finally {
      spy.mockRestore()
    }
  })
})
