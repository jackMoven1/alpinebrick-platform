import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createApiKey, resolveApiKey } from '../src/auth/apikey.service.js'

beforeEach(resetDb)
afterAll(() => prisma.$disconnect())

describe('api key service', () => {
  it('mints a key that resolves to a new agent actor', async () => {
    const { plaintext, actorId } = await createApiKey({ actorName: 'mcp-connector', keyName: 'mcp' })
    const resolved = await resolveApiKey(`Bearer ${plaintext}`)
    expect(resolved).toEqual({ id: actorId, type: 'agent', name: 'mcp-connector' })
  })

  it('stores only the hash, never the plaintext', async () => {
    const { plaintext } = await createApiKey({ actorName: 'a', keyName: 'k' })
    const rows = await prisma.apiKey.findMany()
    expect(JSON.stringify(rows)).not.toContain(plaintext.split('_')[2])
  })

  it('refuses a revoked key', async () => {
    const { plaintext, id } = await createApiKey({ actorName: 'a', keyName: 'k' })
    await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } })
    expect(await resolveApiKey(`Bearer ${plaintext}`)).toBeNull()
  })

  it('refuses an expired key', async () => {
    const { plaintext, id } = await createApiKey({ actorName: 'a', keyName: 'k' })
    await prisma.apiKey.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect(await resolveApiKey(`Bearer ${plaintext}`)).toBeNull()
  })

  it('refuses a key whose actor is disabled', async () => {
    const { plaintext, actorId } = await createApiKey({ actorName: 'a', keyName: 'k' })
    await prisma.actor.update({ where: { id: actorId }, data: { disabled: true } })
    expect(await resolveApiKey(`Bearer ${plaintext}`)).toBeNull()
  })

  it('refuses an unknown prefix and a tampered secret', async () => {
    const { plaintext } = await createApiKey({ actorName: 'a', keyName: 'k' })
    expect(await resolveApiKey('Bearer abk_zzzzzzzz_whatever')).toBeNull()
    // Right prefix, wrong secret -- the case a prefix-only lookup would pass.
    const [scheme, prefix] = plaintext.split('_')
    expect(await resolveApiKey(`Bearer ${scheme}_${prefix}_wrongsecret`)).toBeNull()
  })

  it('refuses a missing or malformed header', async () => {
    expect(await resolveApiKey(undefined)).toBeNull()
    expect(await resolveApiKey('Bearer junk')).toBeNull()
  })

  it('records last use', async () => {
    const { plaintext, id } = await createApiKey({ actorName: 'a', keyName: 'k' })
    expect((await prisma.apiKey.findUnique({ where: { id } }))!.lastUsedAt).toBeNull()
    await resolveApiKey(`Bearer ${plaintext}`)
    // Written best-effort and not awaited by the caller, so settle first.
    await new Promise(r => setTimeout(r, 50))
    expect((await prisma.apiKey.findUnique({ where: { id } }))!.lastUsedAt).not.toBeNull()
  })
})
