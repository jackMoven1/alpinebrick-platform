import { ChannelError } from './orders.ingest.js'

interface PricedListing {
  priceOverrideCents: number | null
  variant: { priceCents: number }
}

/**
 * The one place `priceOverrideCents ?? variant.priceCents` precedence is
 * resolved, and the one gate a resolved price must clear before it reaches
 * either outbound boundary that carries it to Walmart: the item feed price
 * at listing-submit time (`listings.service.ts`) and the recurring price
 * push (`price.sync.ts`). Both call this rather than inlining the `??`
 * themselves, so the guard below cannot be bypassed by one of the two
 * forgetting it.
 *
 * Throws rather than returning a bad value: `<= 0` cents means a $0 or
 * negative listing, and nothing downstream of this function is positioned
 * to catch that -- `centsToDollars` accepts `0` and negative numbers as
 * perfectly valid integers, and Walmart's API has no reason to reject a
 * price of `$0.00` it is offered in good faith. A thrown `ChannelError`
 * dead-letters the enqueued job (or aborts `submitItemFeed` before any HTTP
 * call) with a readable `lastError` -- silent is the failure mode this
 * exists to prevent, not the correct one to fall back to.
 *
 * Deliberately does not enforce a business price floor above `0` -- that
 * number is Jack's to set, not inferred here. `<= 0` needs no such number:
 * a listing can never legitimately be free or negative regardless of what
 * floor is eventually chosen.
 */
export function resolveListingPriceCents(listing: PricedListing): number {
  const priceCents = listing.priceOverrideCents ?? listing.variant.priceCents
  if (priceCents <= 0) {
    throw new ChannelError(
      'invalid_price',
      `resolved price ${priceCents} cents is not > 0 (override=${listing.priceOverrideCents ?? 'null'}, catalog=${listing.variant.priceCents})`,
    )
  }
  return priceCents
}
