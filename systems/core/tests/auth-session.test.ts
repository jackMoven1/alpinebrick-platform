import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createSession, resolveSession, revokeSession, sessionTtlMs } from '../src/auth/session.service.js'
import { hashToken } from '../src/auth/tokens.js'

beforeEach(resetDb)
afterAll(() => prisma.$disconnect())

const mkActor = () => prisma.actor.create({ data: { type: 'human', name: 'jack' } })

describe('session service', () => {
  it('creates a session and resolves it back to its actor', async () => {
    const actor = await mkActor()
    const { token } = await createSession(actor.id)
    const resolved = await resolveSession(token)
    expect(resolved).toEqual({ id: actor.id, type: 'human', name: 'jack' })
  })

  // The row must never hold anything that could be replayed as a credential.
  it('stores only the hash, never the token', async () => {
    const actor = await mkActor()
    const { token } = await createSession(actor.id)
    const rows = await prisma.adminSession.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0].tokenHash).toBe(hashToken(token))
    expect(JSON.stringify(rows[0])).not.toContain(token)
  })

  it('refuses an expired session', async () => {
    const actor = await mkActor()
    const { token } = await createSession(actor.id)
    await prisma.adminSession.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } })
    expect(await resolveSession(token)).toBeNull()
  })

  it('refuses a revoked session', async () => {
    const actor = await mkActor()
    const { token } = await createSession(actor.id)
    await revokeSession(token)
    expect(await resolveSession(token)).toBeNull()
  })

  it('refuses a session whose actor is disabled', async () => {
    const actor = await mkActor()
    const { token } = await createSession(actor.id)
    await prisma.actor.update({ where: { id: actor.id }, data: { disabled: true } })
    expect(await resolveSession(token)).toBeNull()
  })

  it('refuses an unknown token', async () => {
    expect(await resolveSession('nonsense')).toBeNull()
  })

  it('defaults to a 12 hour ttl and ignores rubbish config', async () => {
    // Cleanup runs in `finally` because vitest shares a process across tests
    // in this file (and this worker): a thrown assertion here must not leak
    // SESSION_TTL_HOURS into later tests.
    try {
      delete process.env.SESSION_TTL_HOURS
      expect(sessionTtlMs()).toBe(12 * 3600_000)
      process.env.SESSION_TTL_HOURS = '1'
      expect(sessionTtlMs()).toBe(3600_000)
      process.env.SESSION_TTL_HOURS = 'banana'
      expect(sessionTtlMs()).toBe(12 * 3600_000)
      process.env.SESSION_TTL_HOURS = '-5'
      expect(sessionTtlMs()).toBe(12 * 3600_000)
    } finally {
      delete process.env.SESSION_TTL_HOURS
    }
  })

  // A huge but finite, perfectly positive hour count overflows Date's
  // representable range once multiplied out (Date.now() + hours * 3600_000),
  // producing an Invalid Date that reaches Prisma and turns sign-in into an
  // opaque 500 -- the same class parseExpiresDays already eliminated for the
  // break-glass script. The cap must fall back to the default, same as any
  // other rubbish input.
  it('caps an absurd ttl at the default rather than producing an Invalid Date', () => {
    try {
      process.env.SESSION_TTL_HOURS = '99999999999999'
      expect(sessionTtlMs()).toBe(12 * 3600_000)
    } finally {
      delete process.env.SESSION_TTL_HOURS
    }
  })

  it('accepts the boundary value (24 * 365 hours, one year)', () => {
    try {
      process.env.SESSION_TTL_HOURS = String(24 * 365)
      expect(sessionTtlMs()).toBe(24 * 365 * 3600_000)
    } finally {
      delete process.env.SESSION_TTL_HOURS
    }
  })

  it('falls back to the default one hour past the cap', () => {
    try {
      process.env.SESSION_TTL_HOURS = String(24 * 365 + 1)
      expect(sessionTtlMs()).toBe(12 * 3600_000)
    } finally {
      delete process.env.SESSION_TTL_HOURS
    }
  })
})
