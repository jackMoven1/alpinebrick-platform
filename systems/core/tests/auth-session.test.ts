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
})
