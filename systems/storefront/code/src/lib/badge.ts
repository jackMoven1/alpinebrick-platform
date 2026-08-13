import type { Product } from './api/types'

export type Badge = 'Limited' | 'New'

const NEW_WINDOW_DAYS = 30

/**
 * Derived, never stored. A stored badge duplicates releaseType and createdAt
 * and will drift from them. Limited outranks New so a product never claims
 * two badges at once.
 */
export function deriveBadge(p: Product, now: Date = new Date()): Badge | null {
  if (p.releaseType === 'limited_run') return 'Limited'
  const created = new Date(p.createdAt).getTime()
  if (Number.isNaN(created)) return null
  const ageDays = (now.getTime() - created) / 86_400_000
  return ageDays <= NEW_WINDOW_DAYS ? 'New' : null
}
