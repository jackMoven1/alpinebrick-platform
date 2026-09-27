import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { normalizeReferralCode, parseReferralInput, resolveReferral } from '../src/referrals/referrals.service.js'

beforeEach(() => resetDb())
afterAll(() => prisma.$disconnect())

const NOW = new Date('2026-10-01T12:00:00Z')

describe('referral input', () => {
  it('lowercases and trims a valid code', () => {
    expect(normalizeReferralCode('  Brick-Club ')).toBe('brick-club')
  })

  it('drops codes outside the pattern', () => {
    for (const bad of ['a', 'x'.repeat(33), 'has space', 'semi;colon', 42, null]) {
      expect(normalizeReferralCode(bad)).toBeNull()
    }
  })

  it('accepts a first-seen time inside the 30-day window', () => {
    expect(parseReferralInput({ code: 'club', firstSeenAt: '2026-09-15T00:00:00Z' }, NOW))
      .toEqual({ code: 'club', firstSeenAt: new Date('2026-09-15T00:00:00Z') })
  })

  it('drops a referral older than 30 days, in the future, or with a bad date', () => {
    expect(parseReferralInput({ code: 'club', firstSeenAt: '2026-08-31T11:59:00Z' }, NOW)).toBeNull()
    expect(parseReferralInput({ code: 'club', firstSeenAt: '2026-10-01T12:10:00Z' }, NOW)).toBeNull()
    expect(parseReferralInput({ code: 'club', firstSeenAt: 'yesterday' }, NOW)).toBeNull()
    expect(parseReferralInput({ code: 'bad code', firstSeenAt: '2026-09-30T00:00:00Z' }, NOW)).toBeNull()
    expect(parseReferralInput(null, NOW)).toBeNull()
  })
})

describe('resolveReferral', () => {
  async function partner(status: 'active' | 'inactive', code: string, active = true) {
    const p = await prisma.affiliatePartner.create({ data: { name: `P-${code}`, status } })
    await prisma.referralCode.create({ data: { code, partnerId: p.id, commissionRateBps: 750, active } })
    return p
  }

  it('returns partner and rate for an active code of an active partner', async () => {
    const p = await partner('active', 'club')
    expect(await resolveReferral('club')).toEqual({ partnerId: p.id, commissionRateBps: 750 })
  })

  it('returns null for unknown, inactive codes and inactive partners', async () => {
    await partner('active', 'off', false)
    await partner('inactive', 'gone')
    expect(await resolveReferral('nobody')).toBeNull()
    expect(await resolveReferral('off')).toBeNull()
    expect(await resolveReferral('gone')).toBeNull()
  })
})
