import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { getShopSettings, updateShippingSettings } from '../src/settings/shop-settings.service.js'

let actorId: string
beforeEach(async () => {
  await resetDb()
  actorId = (await prisma.actor.create({ data: { type: 'human', name: 'Jack' } })).id
})
afterAll(() => prisma.$disconnect())

describe('shop settings', () => {
  it('reads the seeded defaults', async () => {
    expect(await getShopSettings()).toEqual({ flatRateCents: 995, freeThresholdCents: 15000, sessionMinutes: 30 })
  })

  it('updates shipping settings and audits before/after', async () => {
    const out = await updateShippingSettings({ flatRateCents: 1295, freeThresholdCents: null }, actorId)
    expect(out).toEqual({ flatRateCents: 1295, freeThresholdCents: null, sessionMinutes: 30 })
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'shop_settings.update' } })
    expect(audit.target).toBe('shop_settings:shipping')
    expect(audit.before).toEqual({ flatRateCents: 995, freeThresholdCents: 15000 })
    expect(audit.after).toEqual({ flatRateCents: 1295, freeThresholdCents: null })
  })

  it('rejects bad input with field messages and writes nothing', async () => {
    await expect(updateShippingSettings({ flatRateCents: -1, freeThresholdCents: 0 }, actorId))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', fields: { flatRateCents: expect.any(String), freeThresholdCents: expect.any(String) } })
    await expect(updateShippingSettings({ flatRateCents: 995 }, actorId))
      .rejects.toMatchObject({ fields: { freeThresholdCents: expect.any(String) } })
    await expect(updateShippingSettings({ flatRateCents: 995, freeThresholdCents: 100, extra: 1 }, actorId))
      .rejects.toMatchObject({ fields: { extra: 'unknown field' } })
    expect(await prisma.auditLog.count()).toBe(0)
  })
})
