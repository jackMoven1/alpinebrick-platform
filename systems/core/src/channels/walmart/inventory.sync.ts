import { prisma } from '../../prisma.js'
import { type WalmartClient, getWalmartClient } from './client.js'
import { toInventoryPayload } from './mappers.js'
import { enqueueJob, registerHandler } from './outbox.js'
import { walmartSellable } from '../../inventory/allocation.js'

const PUSHABLE = new Set(['live', 'submitted'])

/**
 * The percentage buffer was removed 2026-09-24 because it told Walmart 0 for
 * every one-off (on_hand 1, ceil(10%) with the minimum-1 floor consumed the
 * entire unit). Split allocation (`Inventory.walmartAllocation`) replaces it:
 * it cannot double-sell by construction (Walmart's reserve/ingest guard
 * refuses past its own allocation, spec §5.1 rule 2), and pushing the true
 * shared figure for unsplit stock is a deliberate risk the business accepts
 * rather than a defect to buffer against (spec §5.1).
 */
export async function pushInventoryForVariant(variantId: string, client: WalmartClient = getWalmartClient()): Promise<void> {
  const listing = await prisma.channelListing.findUnique({
    where: { variantId },
    include: { variant: { include: { inventory: true } } },
  })
  if (!listing || !PUSHABLE.has(listing.status)) return
  const inv = listing.variant.inventory
  const qty = walmartSellable(inv?.onHand ?? 0, inv?.reserved ?? 0, inv?.walmartAllocation ?? null)
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

/**
 * Push current available-to-sell for every live listing.
 *
 * Each listing is isolated (final fix wave B3): one listing throwing (a
 * Walmart 4xx/5xx for that SKU, a bad row) is console.error'd and the sweep
 * carries on, instead of aborting and leaving every later listing
 * un-reconciled for another hour. `pushed` counts only listings whose push
 * completed; `failed` counts the ones that threw.
 */
export async function reconcileAllInventory(
  client: WalmartClient = getWalmartClient(),
): Promise<{ pushed: number; failed: number }> {
  const listings = await prisma.channelListing.findMany({ where: { status: 'live' }, select: { variantId: true } })
  let pushed = 0
  let failed = 0
  for (const l of listings) {
    try {
      await pushInventoryForVariant(l.variantId, client)
      pushed++
    } catch (e) {
      failed++
      console.error(`walmart inventory reconcile: push failed for variant ${l.variantId}:`, e)
    }
  }
  return { pushed, failed }
}

export function registerInventoryHandlers(client: WalmartClient = getWalmartClient()): void {
  registerHandler('walmart_push_inventory', (payload) => pushInventoryForVariant(payload.variantId, client))
}
