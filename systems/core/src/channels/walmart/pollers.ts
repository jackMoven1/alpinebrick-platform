import { type WalmartClient, getWalmartClient } from './client.js'
import { ingestWalmartOrder, ChannelError } from './orders.ingest.js'
import { ingestWalmartReturn } from './returns.service.js'
import { OrderError } from '../../orders/orders.service.js'

/**
 * Reconciliation sweep for anything the webhook missed. Redundant with
 * webhooks.routes.ts by design -- ingestWalmartOrder is idempotent on
 * ChannelEvent(externalId, eventType), so double delivery (webhook already
 * ingested an order the poller also finds) is a no-op, counted here as
 * `created: false` for that order rather than a failure.
 *
 * This function creates no ChannelEvent (or any other row) of its own: every
 * write -- the stock reservation, Order, ChannelEvent (with `raw` populated
 * from the payload exactly as received), outbox ack job, and audit row --
 * happens inside ingestWalmartOrder's own transaction. So the `raw`
 * guarantee established there (Task 5 migration
 * 20260922110000_add_channel_event_raw_payload) holds for this path the same
 * way it holds for the webhook path, with nothing extra required here.
 *
 * A ChannelError from one order (unmappable_order, unknown_sku,
 * insufficient_stock) is logged and counted as a failure, never thrown --
 * one bad order in the batch must not abort the sweep for the rest. An order
 * cancelled in full before we saw it is counted as `skipped` (see
 * ingestWalmartOrder) -- not a failure, and nothing is written for it.
 *
 * Pages via `list.meta.nextCursor`, which Walmart returns as a ready-made
 * query string and omits on the last page. UNVERIFIED against a real sandbox
 * response (launch checklist §1). Two guards keep a misbehaving cursor from
 * turning the 15-minute sweep into an endless loop: a hard page cap, and
 * stopping if the cursor comes back unchanged. Hitting the cap is logged --
 * at 100 a page it means more than 5,000 orders in the 7-day window, far past
 * anything expected, so it is a signal that something is wrong, not load.
 */
export const MAX_ORDER_POLL_PAGES = 50

export async function pollWalmartOrders(
  client: WalmartClient = getWalmartClient(),
): Promise<{ found: number; created: number; skipped: number; failed: number }> {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  let query: Record<string, string> = { createdStartDate: since, limit: '100' }
  let lastCursor: string | undefined

  let found = 0
  let created = 0
  let skipped = 0
  let failed = 0
  for (let page = 1; ; page++) {
    const res = (await client.request('GET', '/v3/orders', { query })) as any
    const orders: unknown[] = res?.list?.elements?.order ?? []
    found += orders.length

    for (const order of orders) {
      try {
        const result = await ingestWalmartOrder(order, 'poll')
        if (result.created) created++
        else if (result.skipped) skipped++
      } catch (e) {
        failed++
        if (e instanceof ChannelError) {
          console.error(`walmart poll: ${e.code} -- ${e.message}`)
        } else {
          throw e
        }
      }
    }

    const cursor: string | undefined = res?.list?.meta?.nextCursor || undefined
    if (!cursor || cursor === lastCursor) break
    if (page >= MAX_ORDER_POLL_PAGES) {
      console.error(`walmart poll: stopped at ${MAX_ORDER_POLL_PAGES} pages with more orders reported -- check the cursor`)
      break
    }
    lastCursor = cursor
    query = Object.fromEntries(new URLSearchParams(cursor.replace(/^\?/, '')))
  }

  return { found, created, skipped, failed }
}

/**
 * Reconciliation sweep for returns, redundant with a returns webhook by the
 * same design as `pollWalmartOrders` above -- `ingestWalmartReturn` is
 * idempotent on `ChannelEvent(externalId, 'return_created')`, so a return the
 * webhook already ingested is a no-op here, counted as `created: false`
 * rather than a failure.
 *
 * `returnCreationStartDate` = 30 days ago, per the brief; no equivalent
 * "since last successful poll" cursor exists yet, so every sweep re-scans the
 * full window and relies on idempotency to make that safe and cheap.
 *
 * A `ChannelError` from one return (e.g. `unmappable_return`) is logged and
 * skipped, never thrown -- one bad return in the batch must not abort the
 * sweep for the rest, matching `pollWalmartOrders`. `OrderError` is caught
 * the same way: `ingestWalmartReturn` swallows its own expected race
 * (`invalid_transition` from a concurrent return already refunding the same
 * order) internally and should never let one escape here, but the poller's
 * job is to survive a batch even if that internal handling has a gap, not to
 * assume it never will -- an uncaught `OrderError` must not abort the sweep
 * for every return after it, the same as an uncaught `ChannelError` must not.
 */
export async function pollWalmartReturns(
  client: WalmartClient = getWalmartClient(),
): Promise<{ found: number; created: number }> {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const res = (await client.request('GET', '/v3/returns', { query: { returnCreationStartDate: since, limit: '100' } })) as any
  const returns: unknown[] = res?.returnOrders ?? []

  let created = 0
  for (const r of returns) {
    try {
      const result = await ingestWalmartReturn(r, 'poll')
      if (result.created) created++
    } catch (e) {
      if (e instanceof ChannelError || e instanceof OrderError) {
        console.error(`walmart returns poll: ${e.code} -- ${e.message}`)
      } else {
        throw e
      }
    }
  }

  return { found: returns.length, created }
}
