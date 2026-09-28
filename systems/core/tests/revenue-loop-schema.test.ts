import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { SHOP_SETTING_DEFAULTS } from '../src/settings/defaults.js'

beforeEach(async () => { await resetDb(); await seed() })
afterAll(() => prisma.$disconnect())

describe('revenue loop schema', () => {
  it('seeds the three shop settings with the spec defaults', async () => {
    const rows = await prisma.shopSetting.findMany({ orderBy: { key: 'asc' } })
    expect(Object.fromEntries(rows.map((r) => [r.key, r.value]))).toEqual({
      'checkout.session_minutes': 30,
      'shipping.flat_rate_cents': 995,
      'shipping.free_threshold_cents': 15000,
    })
    expect(SHOP_SETTING_DEFAULTS['shipping.flat_rate_cents']).toBe(995)
  })

  it('resetDb restores settings a test changed', async () => {
    await prisma.shopSetting.update({ where: { key: 'shipping.flat_rate_cents' }, data: { value: 1 } })
    await resetDb()
    expect((await prisma.shopSetting.findUniqueOrThrow({ where: { key: 'shipping.flat_rate_cents' } })).value).toBe(995)
  })

  it('gives existing-style orders the new defaults', async () => {
    const o = await prisma.order.create({
      data: { email: 'a@example.com', shipToState: 'MI', subtotalCents: 100, taxCents: 0, totalCents: 100, taxRateBps: 0, taxJurisdiction: 'none' },
    })
    expect(o).toMatchObject({
      shippingCents: 0, refundedCents: 0, marketingOptIn: false, referralUnmatched: false,
      reviewReason: null, squarePaymentId: null, shipLine1: null,
    })
  })

  it('keeps customer emails unique', async () => {
    await prisma.customer.create({ data: { email: 'x@example.com' } })
    await expect(prisma.customer.create({ data: { email: 'x@example.com' } }))
      .rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
  })

  it('rejects a referral code outside the pattern', async () => {
    const p = await prisma.affiliatePartner.create({ data: { name: 'Partner' } })
    await expect(prisma.referralCode.create({ data: { code: 'Bad Code', partnerId: p.id, commissionRateBps: 500 } }))
      .rejects.toThrow()
    await expect(prisma.referralCode.create({ data: { code: 'good-code', partnerId: p.id, commissionRateBps: 500 } }))
      .resolves.toMatchObject({ active: true })
  })

  it('rejects a non-positive variant weight', async () => {
    const v = await prisma.variant.findFirstOrThrow({ where: { sku: 'BBS-STD' } })
    await expect(prisma.variant.update({ where: { id: v.id }, data: { weightGrams: 0 } })).rejects.toThrow()
    await expect(prisma.variant.update({ where: { id: v.id }, data: { weightGrams: 850, lengthMm: 380 } }))
      .resolves.toMatchObject({ weightGrams: 850, lengthMm: 380, widthMm: null })
  })
})
