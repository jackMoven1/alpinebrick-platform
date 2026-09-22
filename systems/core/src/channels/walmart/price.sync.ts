import { prisma } from '../../prisma.js'
import { type WalmartClient, getWalmartClient } from './client.js'
import { toPricePayload } from './mappers.js'
import { enqueueJob, registerHandler } from './outbox.js'

// Same pushable set as inventory.sync.ts (Task 7): a listing only reaches
// `live` via a Walmart-confirmed SUCCESS on the item feed, and `submitted`
// means the item feed is in flight but not yet settled -- both are states
// Walmart already knows this SKU under, so a price PUT is meaningful. A
// `rejected` listing was never accepted onto Walmart's catalog under this
// SKU, so pushing a price against it targets nothing that exists there. A
// `draft` listing was never submitted at all, and `retired` was deliberately
// pulled -- neither should be kept in sync going forward.
const PUSHABLE = new Set(['live', 'submitted'])

/**
 * Pushes the current price for a variant's Walmart listing.
 *
 * Price source, in order: `listing.priceOverrideCents` when set (a
 * per-listing marketplace price, e.g. to stay competitive without changing
 * the storefront price), else `variant.priceCents` (the catalog price).
 * `??` is deliberate over `||` -- an override of `0` is a real (if unusual)
 * override, not "unset"; only `null`/`undefined` fall through to the
 * catalog price.
 */
export async function pushPriceForVariant(variantId: string, client: WalmartClient = getWalmartClient()): Promise<void> {
  const listing = await prisma.channelListing.findUnique({ where: { variantId }, include: { variant: true } })
  if (!listing || !PUSHABLE.has(listing.status)) return
  const priceCents = listing.priceOverrideCents ?? listing.variant.priceCents
  await client.request('PUT', '/v3/price', { body: toPricePayload(listing.walmartSku, priceCents) })
  await prisma.channelListing.update({ where: { id: listing.id }, data: { lastPushedPriceCents: priceCents, lastSyncedAt: new Date() } })
}

/**
 * enqueueJob (not enqueueIdempotentJob): this is the out-of-transaction
 * entry point, and this dedupeKey is deliberately recurring -- the same
 * variant's price gets pushed again on every later price change.
 * enqueueJob's dedupe-release recovery (a completed job under this key
 * frees it for a fresh enqueue) is exactly what that needs; see its doc
 * comment in outbox.ts. Do not swap this for enqueueIdempotentJob here.
 */
export async function enqueuePricePush(variantId: string): Promise<void> {
  const listed = await prisma.channelListing.count({ where: { variantId } })
  if (listed === 0) return
  await enqueueJob('walmart_push_price', { variantId }, { dedupeKey: `price:${variantId}` })
}

export function registerPriceHandlers(client: WalmartClient = getWalmartClient()): void {
  registerHandler('walmart_push_price', (payload) => pushPriceForVariant(payload.variantId, client))
}
