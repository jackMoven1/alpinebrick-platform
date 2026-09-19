import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createApiKey, resolveApiKey } from '../src/auth/apikey.service.js'

beforeEach(resetDb)
afterAll(() => prisma.$disconnect())

describe('key issuance', () => {
  it('mints a key that authenticates', async () => {
    const { plaintext } = await createApiKey({ actorName: 'break-glass', keyName: 'emergency' })
    expect(await resolveApiKey(`Bearer ${plaintext}`)).toMatchObject({ name: 'break-glass' })
  })

  // The break-glass procedure passes 1 day. A permanent emergency credential
  // is the thing spec 5.4 exists to avoid.
  it('honours a short expiry', async () => {
    const { plaintext, id } = await createApiKey({
      actorName: 'break-glass', keyName: 'emergency',
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    expect(await resolveApiKey(`Bearer ${plaintext}`)).not.toBeNull()
    await prisma.apiKey.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1) } })
    expect(await resolveApiKey(`Bearer ${plaintext}`)).toBeNull()
  })
})
