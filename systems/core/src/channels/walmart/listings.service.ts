import { Prisma } from '@prisma/client'
import { prisma } from '../../prisma.js'
import { type WalmartClient, getWalmartClient } from './client.js'
import { toItemFeed } from './mappers.js'
import { ChannelError } from './orders.ingest.js'
import { imageUrl } from '../../assets/image-url.js'

export async function createListing(
  variantId: string,
  walmartSku: string,
  opts: { bufferPct?: number; priceOverrideCents?: number } = {},
): Promise<{ id: string }> {
  const variant = await prisma.variant.findUniqueOrThrow({ where: { id: variantId }, include: { product: true } })
  if (variant.product.status !== 'published') {
    throw new ChannelError('not_published', `product ${variant.product.slug} is not published`)
  }
  const listing = await prisma.channelListing.create({
    data: { variantId, walmartSku, bufferPct: opts.bufferPct, priceOverrideCents: opts.priceOverrideCents },
    select: { id: true },
  })
  return listing
}

/**
 * Resolves a product's READY images, in display order, to absolute delivery
 * URLs -- mirrors the exact query catalog.service.ts uses (`status: 'ready'`,
 * ordered by `position`): a `pending` image is half-uploaded and must never
 * reach a marketplace, just as it must never reach a storefront customer.
 *
 * Throws rather than returning an empty/partial list, because a silently
 * bad image list is worse than a loud one:
 *  - `missing_image`: Walmart's item spec requires a main image. Submitting
 *    without one wastes a feed round trip and pollutes the per-item
 *    rejection signal this task exists to build with our own known-bad
 *    data -- failing locally dead-letters the job with a clear reason
 *    instead.
 *  - `asset_base_url_unset`: `imageUrl()` (src/assets/image-url.ts) falls
 *    back to a *relative* path when `ASSET_PUBLIC_BASE_URL` is unset.
 *    Walmart would accept that feed and happily list a product whose image
 *    resolves to nothing. Checking the resolved URL (not the env var
 *    directly) keeps this correct if imageUrl's grammar ever changes.
 */
function resolveImageUrls(images: { storageKey: string }[], productSlug: string): string[] {
  if (images.length === 0) {
    throw new ChannelError('missing_image', `product ${productSlug} has no ready image`)
  }
  return images.map((img) => {
    const url = imageUrl(img.storageKey)
    if (!/^https?:\/\//i.test(url)) {
      throw new ChannelError(
        'asset_base_url_unset',
        `resolved image URL for product ${productSlug} is not absolute (${url}) -- ASSET_PUBLIC_BASE_URL is likely unset`,
      )
    }
    return url
  })
}

export async function submitItemFeed(
  listingIds: string[],
  client: WalmartClient = getWalmartClient(),
): Promise<{ feedId: string }> {
  const listings = await prisma.channelListing.findMany({
    where: { id: { in: listingIds } },
    include: {
      variant: {
        include: {
          product: {
            include: {
              // Pending images are half-uploaded and must never reach a
              // marketplace -- same query catalog.service.ts uses for
              // customer-facing reads.
              images: { where: { status: 'ready' }, orderBy: { position: 'asc' } },
            },
          },
        },
      },
    },
  })

  const feedBody = toItemFeed(
    listings.map((l) => ({
      walmartSku: l.walmartSku,
      name: l.variant.product.name,
      description: l.variant.product.description,
      priceCents: l.priceOverrideCents ?? l.variant.priceCents,
      imageUrls: resolveImageUrls(l.variant.product.images, l.variant.product.slug),
    })),
  )

  const res = (await client.request('POST', '/v3/feeds', { query: { feedType: 'MP_ITEM' }, body: feedBody })) as {
    feedId: string
  }
  // Record the feed and flip the listings together: a crash between the two
  // writes would otherwise leave a ChannelFeed row with no listing ever
  // reflecting that a submission happened.
  await prisma.$transaction([
    prisma.channelFeed.create({ data: { feedId: res.feedId, type: 'item', listingIds } }),
    prisma.channelListing.updateMany({ where: { id: { in: listingIds } }, data: { status: 'submitted' } }),
  ])
  return { feedId: res.feedId }
}

// Walmart's own published item ingestion statuses --
// https://developer.walmart.com/doc/us/mp/us-mp-feeds/ -- confirmed before
// enumerating rather than assumed:
//   SUCCESS    -- the item was ingested. The only value that goes live.
//   INPROGRESS -- Walmart has not finished with this item yet. This is NOT
//                 a failure -- it is an outcome we understand and it means
//                 "no verdict yet, ask again later."
//   DATA_ERROR / SYSTEM_ERROR / TIMEOUT_ERROR -- terminal failures.
// Anything not on this list -- a missing status, or a string we don't
// recognise -- fails closed as a rejection, same as a terminal error: an
// outcome we DON'T understand must never become a live product. INPROGRESS
// is deliberately excluded from that fail-closed bucket because it IS
// understood and is not terminal.
const WALMART_ITEM_SUCCESS_STATUS = 'SUCCESS'
const WALMART_ITEM_INPROGRESS_STATUS = 'INPROGRESS'

type ItemOutcome = 'live' | 'rejected' | 'in_progress'

function hasIngestionErrors(entry: unknown): boolean {
  const errors = (entry as any)?.ingestionErrors?.ingestionError
  return Array.isArray(errors) && errors.length > 0
}

/**
 * Per-SKU outcome extracted from Walmart's `itemDetails.itemIngestionStatus`
 * (present when the feed status check is called with `includeDetails=true`).
 *
 * Three outcomes, not two:
 *  - `live`: Walmart's own explicit `ingestionStatus === 'SUCCESS'`, with no
 *    populated `ingestionErrors` (an errors array is always a failure,
 *    regardless of what the status string says).
 *  - `in_progress`: `ingestionStatus === 'INPROGRESS'` and no errors. Not
 *    terminal -- the caller must leave the listing exactly as it is rather
 *    than recording a verdict that hasn't happened yet.
 *  - `rejected`: everything else -- a terminal error status, a missing
 *    status, an unrecognised one, or a populated `ingestionErrors`. An
 *    earlier version of this function only checked for a populated errors
 *    array, which meant an entry like `{ sku, ingestionStatus:
 *    'SYSTEM_ERROR' }` (no `ingestionErrors` populated) was indistinguishable
 *    from success and went live -- exactly the "unrecognised outcome
 *    becomes a live product" failure mode this task exists to prevent, one
 *    layer below the feed-level version of the same bug. A second, equally
 *    wrong attempt at closing that gap treated INPROGRESS as a rejection
 *    too, which writes a terminal, wrong verdict onto an item that hasn't
 *    finished processing -- fail-closed applies to outcomes we don't
 *    understand, and INPROGRESS is one we do.
 */
function itemOutcomesBySku(itemDetails: unknown): Map<string, ItemOutcome> {
  const outcomes = new Map<string, ItemOutcome>()
  const entries = (itemDetails as any)?.itemIngestionStatus
  if (!Array.isArray(entries)) return outcomes
  for (const entry of entries) {
    const sku = entry?.sku
    if (typeof sku !== 'string') continue
    if (hasIngestionErrors(entry)) {
      outcomes.set(sku, 'rejected')
      continue
    }
    if (entry?.ingestionStatus === WALMART_ITEM_SUCCESS_STATUS) {
      outcomes.set(sku, 'live')
      continue
    }
    if (entry?.ingestionStatus === WALMART_ITEM_INPROGRESS_STATUS) {
      outcomes.set(sku, 'in_progress')
      continue
    }
    outcomes.set(sku, 'rejected')
  }
  return outcomes
}

/**
 * Merges this poll's `itemDetails` into whatever diagnostic detail is
 * already stored on the feed, keyed by sku. Never lets a later, emptier
 * response erase an earlier, more informative one: Walmart returning less
 * detail on a later poll of an already-settled feed (or none at all) must
 * not wipe out a previously-captured rejection reason -- that reason is
 * most of what makes a rejection investigable rather than just a status
 * flip nobody can explain.
 */
function mergeFeedErrors(
  existingErrors: unknown,
  res: { itemDetails?: unknown },
  feedLevelStatus: 'processed' | 'error',
): Record<string, unknown> | null {
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)

  const merged: Record<string, unknown> = isRecord(existingErrors) ? { ...existingErrors } : {}
  const entries = (res.itemDetails as any)?.itemIngestionStatus

  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const sku = entry?.sku
      if (typeof sku !== 'string') continue
      const existingEntry = merged[sku]
      // Don't replace an entry that already carries ingestion errors with
      // one that doesn't -- that would be trading known detail for nothing.
      if (isRecord(existingEntry) && hasIngestionErrors(existingEntry) && !hasIngestionErrors(entry)) {
        continue
      }
      merged[sku] = entry
    }
  } else if (feedLevelStatus === 'error' && Object.keys(merged).length === 0) {
    // Walmart reported the feed as ERROR but sent no per-item detail at all,
    // and nothing has ever been captured for this feed -- fall back to the
    // raw response rather than recording nothing.
    merged.__feed = res
  }

  return Object.keys(merged).length > 0 ? merged : null
}

export async function checkFeedStatus(
  feedId: string,
  client: WalmartClient = getWalmartClient(),
): Promise<'submitted' | 'processed' | 'error'> {
  const res = (await client.request('GET', `/v3/feeds/${feedId}`, { query: { includeDetails: 'true' } })) as any
  const feed = await prisma.channelFeed.findUniqueOrThrow({ where: { feedId } })

  if (res.feedStatus !== 'PROCESSED' && res.feedStatus !== 'ERROR') {
    return 'submitted'
  }

  const feedLevelStatus: 'processed' | 'error' = res.feedStatus === 'PROCESSED' ? 'processed' : 'error'
  const outcomes = itemOutcomesBySku(res.itemDetails)

  const ids = (feed.listingIds as string[] | null) ?? []
  const listings =
    ids.length > 0
      ? await prisma.channelListing.findMany({ where: { id: { in: ids } }, select: { id: true, walmartSku: true } })
      : []

  const liveIds: string[] = []
  const rejectedIds: string[] = []
  for (const listing of listings) {
    const outcome = outcomes.get(listing.walmartSku)
    // A listing goes live only when ITS OWN item reports explicit success.
    // An item still `in_progress` gets NO state change at all -- it is left
    // out of both buckets below, so it stays exactly as it was and remains
    // eligible for the next poll. This is what makes a mixed feed settle
    // correctly: the live/rejected items decided in THIS SAME poll are
    // written immediately, without waiting for the in-progress ones to
    // reach a terminal state too. When Walmart's response carries no
    // per-item detail for this sku at all, fall back to the feed-level
    // status -- but an item explicitly reported as failed is NEVER live,
    // regardless of the feed's overall status. This is the distinction the
    // whole task exists to enforce: a "processed" feed can still carry
    // rejected items.
    if (outcome === 'in_progress') continue
    const isLive = outcome === undefined ? feedLevelStatus === 'processed' : outcome === 'live'
    ;(isLive ? liveIds : rejectedIds).push(listing.id)
  }

  // Flip the feed and its listings together: a crash between separate writes
  // would otherwise leave the feed marked processed/error while the
  // listings it covers still say submitted -- exactly the "averaged away"
  // partial-failure risk this task exists to close, just via a crash window
  // instead of a status-mapping bug.
  await prisma.$transaction([
    prisma.channelFeed.update({
      where: { feedId },
      data: {
        status: feedLevelStatus,
        errors: (mergeFeedErrors(feed.errors, res, feedLevelStatus) as Prisma.InputJsonValue | null) ?? Prisma.JsonNull,
      },
    }),
    ...(liveIds.length > 0
      ? [prisma.channelListing.updateMany({ where: { id: { in: liveIds } }, data: { status: 'live' } })]
      : []),
    ...(rejectedIds.length > 0
      ? [prisma.channelListing.updateMany({ where: { id: { in: rejectedIds } }, data: { status: 'rejected' } })]
      : []),
  ])

  return feedLevelStatus
}
