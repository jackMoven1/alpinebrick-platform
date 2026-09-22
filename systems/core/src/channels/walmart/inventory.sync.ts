import { prisma } from '../../prisma.js'
import { type WalmartClient, getWalmartClient } from './client.js'
import { toInventoryPayload } from './mappers.js'
import { enqueueJob, registerHandler } from './outbox.js'

/**
 * Available-to-sell = on-hand, minus what's already reserved by other
 * orders, minus a safety buffer that biases toward under- rather than
 * over-selling (an oversell is a Walmart metrics penalty; under-selling is
 * just a lost sale nobody notices as a defect).
 *
 * buffer = 10% of on-hand (or the per-listing `bufferPct` override),
 * rounded UP, minimum 1 whenever on-hand > 0. `bufferPct` of exactly `0` is
 * a deliberate "no buffer" override -- the `?? 10` fallback applies only to
 * `null`/`undefined`, never to `0`.
 *
 * The `pct > 0` guard is load-bearing, not a style choice: the task brief's
 * own inline formula --
 *   `Math.max(1, Math.ceil(onHand * (bufferPct ?? 10) / 100))`
 * -- applies the minimum-1 floor unconditionally whenever on-hand > 0. Fed
 * `bufferPct: 0`, `bufferPct ?? 10` evaluates to `0` (0 is not null/
 * undefined), so that formula computes `Math.max(1, Math.ceil(0)) === 1` --
 * a buffer of 1, not 0. That contradicts the brief's own very next sentence
 * ("bufferPct of 0 means no buffer") and its own Step-1 test
 * (`computeAvailableToSell(10, 0, 0)).toBe(10)`), which only 0-buffer output
 * satisfies. The brief's Step-3 code and its offered "simplified" variant
 * both special-case `pct > 0` for exactly this reason. This implementation
 * follows the Step-3/simplified form (and the tests), not the inline prose
 * formula -- see the task report for the full discrepancy writeup.
 *
 * One consequence of that fix, also documented in the report: once `pct > 0`
 * gates the branch, `Math.ceil(onHand * pct / 100)` for on-hand >= 1 and
 * pct > 0 is a ceiling of a strictly positive number, which Math.ceil never
 * rounds below 1 -- so `Math.max(1, ...)` never actually changes the result
 * in this branch. It's kept because the brief explicitly asks for it and
 * because it costs nothing to keep as a defensive floor, not because a test
 * can currently distinguish its presence from its absence.
 */
export function computeAvailableToSell(onHand: number, reserved: number, bufferPct?: number | null): number {
  const pct = bufferPct ?? 10
  const buffer = onHand > 0 && pct > 0 ? Math.max(1, Math.ceil((onHand * pct) / 100)) : 0
  return Math.max(0, onHand - reserved - buffer)
}

const PUSHABLE = new Set(['live', 'submitted'])

export async function pushInventoryForVariant(variantId: string, client: WalmartClient = getWalmartClient()): Promise<void> {
  const listing = await prisma.channelListing.findUnique({
    where: { variantId },
    include: { variant: { include: { inventory: true } } },
  })
  if (!listing || !PUSHABLE.has(listing.status)) return
  const inv = listing.variant.inventory
  const qty = computeAvailableToSell(inv?.onHand ?? 0, inv?.reserved ?? 0, listing.bufferPct)
  await client.request('PUT', '/v3/inventory', { query: { sku: listing.walmartSku }, body: toInventoryPayload(listing.walmartSku, qty) })
  await prisma.channelListing.update({ where: { id: listing.id }, data: { lastPushedQty: qty, lastSyncedAt: new Date() } })
}

export async function enqueueInventoryPush(variantId: string): Promise<void> {
  const listed = await prisma.channelListing.count({ where: { variantId } })
  if (listed === 0) return
  // enqueueJob (not enqueueIdempotentJob): this is the out-of-transaction
  // entry point, and this dedupeKey is deliberately recurring -- the same
  // variant's inventory gets pushed again on every later stock mutation.
  // enqueueJob's dedupe-release recovery (a completed job under this key
  // frees it for a fresh enqueue) is exactly what that needs; see its doc
  // comment in outbox.ts.
  await enqueueJob('walmart_push_inventory', { variantId }, { dedupeKey: `inv:${variantId}` })
}

export async function reconcileAllInventory(client: WalmartClient = getWalmartClient()): Promise<{ pushed: number }> {
  const listings = await prisma.channelListing.findMany({ where: { status: 'live' }, select: { variantId: true } })
  for (const l of listings) await pushInventoryForVariant(l.variantId, client)
  return { pushed: listings.length }
}

export function registerInventoryHandlers(client: WalmartClient = getWalmartClient()): void {
  registerHandler('walmart_push_inventory', (payload) => pushInventoryForVariant(payload.variantId, client))
}
