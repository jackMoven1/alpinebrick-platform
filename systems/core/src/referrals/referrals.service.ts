import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'

export const REFERRAL_CODE_RE = /^[a-z0-9-]{2,32}$/
export const REFERRAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
/** Tolerated client clock skew for a first-seen time in the "future". */
const FUTURE_SKEW_MS = 5 * 60 * 1000

export function normalizeReferralCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const code = raw.trim().toLowerCase()
  return REFERRAL_CODE_RE.test(code) ? code : null
}

/**
 * Spec §4: an invalid referral is DROPPED, never a reason to reject checkout.
 * The storefront enforces the 30-day window too; this repeats it because the
 * browser's value is not trusted.
 */
export function parseReferralInput(raw: unknown, now = new Date()): { code: string; firstSeenAt: Date } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { code, firstSeenAt } = raw as Record<string, unknown>
  const normalized = normalizeReferralCode(code)
  if (!normalized || typeof firstSeenAt !== 'string') return null
  const seen = new Date(firstSeenAt)
  const t = seen.getTime()
  if (Number.isNaN(t)) return null
  if (t > now.getTime() + FUTURE_SKEW_MS) return null
  if (now.getTime() - t > REFERRAL_WINDOW_MS) return null
  return { code: normalized, firstSeenAt: seen }
}

/** The partner and rate to snapshot on a paid order, or null (unmatched). */
export async function resolveReferral(
  code: string,
  db: Pick<Prisma.TransactionClient, 'referralCode'> = prisma,
): Promise<{ partnerId: string; commissionRateBps: number } | null> {
  const row = await db.referralCode.findUnique({ where: { code }, include: { partner: true } })
  if (!row || !row.active || row.partner.status !== 'active') return null
  return { partnerId: row.partnerId, commissionRateBps: row.commissionRateBps }
}
