import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'

beforeEach(resetDb)
afterAll(() => prisma.$disconnect())

describe('admin auth schema', () => {
  it('stores an admin session against an actor', async () => {
    const actor = await prisma.actor.create({ data: { type: 'human', name: 'jack' } })
    const s = await prisma.adminSession.create({
      data: {
        actorId: actor.id,
        tokenHash: 'hash-1',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    })
    expect(s.revokedAt).toBeNull()
    expect(s.actorId).toBe(actor.id)
  })

  it('rejects a duplicate session token hash', async () => {
    const actor = await prisma.actor.create({ data: { type: 'human', name: 'jack' } })
    const data = { actorId: actor.id, tokenHash: 'dupe', expiresAt: new Date(Date.now() + 1000) }
    await prisma.adminSession.create({ data })
    await expect(prisma.adminSession.create({ data })).rejects.toThrow()
  })

  it('stores an api key with a unique prefix and hash', async () => {
    const actor = await prisma.actor.create({ data: { type: 'agent', name: 'mcp-connector' } })
    const k = await prisma.apiKey.create({
      data: { actorId: actor.id, name: 'mcp', prefix: 'abcd1234', keyHash: 'kh-1' },
    })
    expect(k.revokedAt).toBeNull()
    expect(k.expiresAt).toBeNull()
  })

  // Nullable uniques must permit multiple NULLs, or the seeded 'system' actor
  // (which has no email and no googleSub) blocks every later actor.
  it('allows many actors with no email and no googleSub', async () => {
    await prisma.actor.create({ data: { type: 'human', name: 'a' } })
    await prisma.actor.create({ data: { type: 'human', name: 'b' } })
    const n = await prisma.actor.count()
    expect(n).toBe(2)
  })

  it('enforces a unique googleSub when present', async () => {
    await prisma.actor.create({ data: { type: 'human', name: 'a', googleSub: 'sub-1' } })
    await expect(
      prisma.actor.create({ data: { type: 'human', name: 'b', googleSub: 'sub-1' } }),
    ).rejects.toThrow()
  })
})
