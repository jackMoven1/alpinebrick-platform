import { type WalmartClient, getWalmartClient } from './client.js'
import { ingestWalmartOrder, ChannelError } from './orders.ingest.js'
import { ingestWalmartReturn } from './returns.service.js'

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
 * one bad order in the batch must not abort the sweep for the rest.
 */
export async function pollWalmartOrders(
  client: WalmartClient = getWalmartClient(),
): Promise<{ found: number; created: number; failed: number }> {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const res = (await client.request('GET', '/v3/orders', { query: { createdStartDate: since, limit: '100' } })) as any
  const orders: unknown[] = res?.list?.elements?.order ?? []

  let created = 0
  let failed = 0
  for (const order of orders) {
    try {
      const result = await ingestWalmartOrder(order, 'poll')
      if (result.created) created++
    } catch (e) {
      failed++
      if (e instanceof ChannelError) {
        console.error(`walmart poll: ${e.code} -- ${e.message}`)
      } else {
        throw e
      }
    }
  }

  return { found: orders.length, created, failed }
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
 * sweep for the rest, matching `pollWalmartOrders`.
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
      if (e instanceof ChannelError) {
        console.error(`walmart returns poll: ${e.code} -- ${e.message}`)
      } else {
        throw e
      }
    }
  }

  return { found: returns.length, created }
}
