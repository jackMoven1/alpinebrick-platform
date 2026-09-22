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

/**
 * Per-SKU outcome extracted from Walmart's `itemDetails.itemIngestionStatus`
 * (present when the feed status check is called with `includeDetails=true`).
 * An entry with a non-empty `ingestionErrors.ingestionError` failed; anything
 * else reported for that sku is treated as success.
 */
function itemOutcomesBySku(itemDetails: unknown): Map<string, boolean> {
  const outcomes = new Map<string, boolean>()
  const entries = (itemDetails as any)?.itemIngestionStatus
  if (!Array.isArray(entries)) return outcomes
  for (const entry of entries) {
    const sku = entry?.sku
    if (typeof sku !== 'string') continue
    const errors = entry?.ingestionErrors?.ingestionError
    const failed = Array.isArray(errors) && errors.length > 0
    outcomes.set(sku, !failed)
  }
  return outcomes
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
    // A listing goes live only when ITS OWN item reports success. When
    // Walmart's response carries no per-item detail for this sku at all,
    // fall back to the feed-level status -- but an item explicitly reported
    // as failed is NEVER live, regardless of the feed's overall status.
    // This is the distinction the whole task exists to enforce: a
    // "processed" feed can still carry rejected items.
    const isLive = outcome === undefined ? feedLevelStatus === 'processed' : outcome
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
        errors: res.itemDetails ?? (feedLevelStatus === 'error' ? res : null),
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
