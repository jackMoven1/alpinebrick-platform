import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { recordAudit } from '../audit.js'
import { AdminError } from '../admin/admin-errors.js'
import { SETTING_KEYS, SHOP_SETTING_DEFAULTS } from './defaults.js'

export interface ShopSettings {
  flatRateCents: number
  /** null = no free shipping. */
  freeThresholdCents: number | null
  sessionMinutes: number
}

type Db = Pick<Prisma.TransactionClient, 'shopSetting'>

/** A missing row falls back to the seeded default; a present NULL is kept. */
export async function getShopSettings(db: Db = prisma): Promise<ShopSettings> {
  const rows = await db.shopSetting.findMany()
  const byKey = new Map(rows.map((r) => [r.key, r.value]))
  const read = (key: string): number | null =>
    byKey.has(key) ? (byKey.get(key) as number | null) : (SHOP_SETTING_DEFAULTS[key] ?? null)
  return {
    flatRateCents: read(SETTING_KEYS.flatRateCents) ?? (SHOP_SETTING_DEFAULTS[SETTING_KEYS.flatRateCents] as number),
    freeThresholdCents: read(SETTING_KEYS.freeThresholdCents),
    sessionMinutes: read(SETTING_KEYS.sessionMinutes) ?? (SHOP_SETTING_DEFAULTS[SETTING_KEYS.sessionMinutes] as number),
  }
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const ALLOWED = ['flatRateCents', 'freeThresholdCents']

/** Both fields are required: the Settings page always sends the pair. */
export async function updateShippingSettings(body: unknown, actorId: string): Promise<ShopSettings> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AdminError('VALIDATION_ERROR', 'body must be a JSON object')
  }
  const b = body as Record<string, unknown>
  const fields: Record<string, string> = {}
  for (const k of Object.keys(b)) if (!ALLOWED.includes(k)) fields[k] = 'unknown field'
  if (!isInt(b.flatRateCents) || b.flatRateCents < 0 || b.flatRateCents > 100_000) {
    fields.flatRateCents = 'a whole number of cents from 0 to 100000'
  }
  const t = b.freeThresholdCents
  if (!('freeThresholdCents' in b) || (t !== null && (!isInt(t) || t < 1 || t > 10_000_000))) {
    fields.freeThresholdCents = 'a whole number of cents from 1 to 10000000, or null for no free shipping'
  }
  if (Object.keys(fields).length > 0) throw new AdminError('VALIDATION_ERROR', 'invalid input', fields)

  const flatRateCents = b.flatRateCents as number
  const freeThresholdCents = t as number | null
  await prisma.$transaction(async (tx) => {
    const before = await getShopSettings(tx)
    await tx.shopSetting.upsert({
      where: { key: SETTING_KEYS.flatRateCents },
      create: { key: SETTING_KEYS.flatRateCents, value: flatRateCents },
      update: { value: flatRateCents },
    })
    await tx.shopSetting.upsert({
      where: { key: SETTING_KEYS.freeThresholdCents },
      create: { key: SETTING_KEYS.freeThresholdCents, value: freeThresholdCents },
      update: { value: freeThresholdCents },
    })
    await recordAudit({
      actorId, action: 'shop_settings.update', target: 'shop_settings:shipping',
      before: { flatRateCents: before.flatRateCents, freeThresholdCents: before.freeThresholdCents },
      after: { flatRateCents, freeThresholdCents },
    }, tx)
  })
  return getShopSettings()
}
