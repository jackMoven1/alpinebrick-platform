import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createApiKey, resolveApiKey } from '../src/auth/apikey.service.js'
import { parseExpiresDays } from '../src/scripts/create-api-key.js'

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

describe('expires-days validation', () => {
  // Omitted stays omitted: no expiry, exactly the current behaviour.
  it('accepts an omitted expiry as "never"', () => {
    expect(parseExpiresDays(undefined)).toEqual({ ok: true, value: null })
  })

  it('accepts a positive integer', () => {
    expect(parseExpiresDays('1')).toEqual({ ok: true, value: 1 })
    expect(parseExpiresDays('30')).toEqual({ ok: true, value: 30 })
  })

  // Fails loudly today (an Invalid Date reaches Prisma and throws), but the
  // operator should get a one-line usage error instead of a stack trace.
  it('rejects a non-numeric expiry', () => {
    expect(parseExpiresDays('abc')).toEqual({ ok: false, message: expect.any(String) })
  })

  // The dangerous case: a negative number is perfectly valid arithmetic, so
  // without this check it silently produces an already-expired key. The
  // operator sees "API key created" and a plausible timestamp, and only
  // discovers the problem as an unexplained 401 later.
  it('rejects a negative expiry', () => {
    expect(parseExpiresDays('-1')).toEqual({ ok: false, message: expect.any(String) })
  })

  it('rejects a zero expiry', () => {
    expect(parseExpiresDays('0')).toEqual({ ok: false, message: expect.any(String) })
  })

  it('rejects a non-integer expiry', () => {
    expect(parseExpiresDays('1.5')).toEqual({ ok: false, message: expect.any(String) })
  })

  // A large but finite integer passes Number.isInteger and is > 0, so it
  // isn't caught by the checks above -- but Date.now() + n * 86_400_000
  // overflows Date's representable range, producing an Invalid Date that
  // reaches Prisma and throws. This is the same operator-facing raw stack
  // trace the validation exists to eliminate, reached by a different input.
  it('accepts the boundary value (3650 days, ten years)', () => {
    expect(parseExpiresDays('3650')).toEqual({ ok: true, value: 3650 })
  })

  it('rejects a value above the cap', () => {
    expect(parseExpiresDays('3651')).toEqual({ ok: false, message: expect.any(String) })
  })

  it('rejects a huge value that would overflow Date', () => {
    expect(parseExpiresDays('999999999')).toEqual({ ok: false, message: expect.any(String) })
  })

  it('rejects a value beyond Number.MAX_SAFE_INTEGER', () => {
    expect(parseExpiresDays('9007199254740993')).toEqual({ ok: false, message: expect.any(String) })
  })
})
