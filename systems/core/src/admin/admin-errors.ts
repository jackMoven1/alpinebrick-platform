import { Prisma } from '@prisma/client'

/**
 * Admin API error. `fields` maps an input field to a message the console
 * renders beside it; `details` carries structured data a client needs to
 * recover (e.g. current stock on STOCK_CHANGED).
 */
export class AdminError extends Error {
  constructor(
    public code: string,
    message: string,
    public fields?: Record<string, string>,
    public details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AdminError'
  }
}

/**
 * Turn a unique-constraint violation into the matching AdminError. Taken from
 * the constraint itself rather than a read-then-write check, so two concurrent
 * creates cannot both pass (spec §3).
 */
export function mapUniqueViolation(e: unknown): unknown {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    const target = String((e.meta as { target?: unknown } | undefined)?.target ?? '')
    if (target.includes('slug')) {
      return new AdminError('SLUG_TAKEN', 'that slug is already used by another product', { slug: 'already in use' })
    }
    if (target.includes('sku')) {
      return new AdminError('SKU_TAKEN', 'that SKU is already used by another variant', { sku: 'already in use' })
    }
  }
  return e
}
