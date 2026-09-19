import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'

// Forces the ApiKey insert to collide on its unique `prefix` (and `keyHash`)
// by making generateApiKey deterministic, so the transaction fails AFTER the
// Actor insert has already run but before it commits. This is the test that
// actually distinguishes "one transaction" from "three separate writes": if
// the Actor, ApiKey and audit-row inserts are not all inside the same
// prisma.$transaction, the Actor from the failing second call would survive
// even though the caller sees a rejected promise.
vi.mock('../src/auth/tokens.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth/tokens.js')>()
  const plaintext = 'abk_collidepfx_afixedsecretvalueusedonlyinthistest'
  return {
    ...actual,
    generateApiKey: () => ({
      plaintext,
      prefix: 'collidepfx',
      keyHash: actual.hashToken(plaintext),
    }),
  }
})

const { createApiKey } = await import('../src/auth/apikey.service.js')

beforeEach(resetDb)
afterAll(() => prisma.$disconnect())

describe('createApiKey atomicity', () => {
  it('rolls back the new Actor (and writes no audit row) when the ApiKey insert fails', async () => {
    await createApiKey({ actorName: 'first', keyName: 'k1' })

    await expect(createApiKey({ actorName: 'second', keyName: 'k2' })).rejects.toThrow()

    expect(await prisma.actor.count({ where: { name: 'second' } })).toBe(0)
    expect(await prisma.apiKey.count()).toBe(1) // only "first"'s
    expect(await prisma.auditLog.count({ where: { action: 'apikey.create' } })).toBe(1) // only "first"'s
  })
})
