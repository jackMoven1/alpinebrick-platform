# Walmart Marketplace Integration — Design

**Date:** 2026-08-03
**Status:** Approved by Jack (brainstorming session); pending spec review
**Owner:** Engineering (connector lives in `systems/core`)

## Purpose

Let Walmart integrate with ImagiBricks as a sales channel: Walmart pulls our
product information and availability, and sends us orders to fulfill. Business
model: **Walmart Marketplace third-party seller** (not DSV/first-party). The
seller account and API credentials already exist.

V1 scope covers the full channel lifecycle:

1. Product listings (item setup and maintenance)
2. Inventory availability sync
3. Order receipt and acknowledgement
4. Shipping + tracking updates
5. Returns and refunds
6. Price management
7. Settlement reconciliation

## Locked decisions from brainstorming

- **Approach A:** connector is a `channels/walmart` module inside
  `systems/core` — not a standalone service, not third-party middleware.
  Module boundary is kept clean (port-style seam, like `TaxPort`) so it can be
  extracted later if needed.
- **Inventory:** single shared pool with a safety buffer. Walmart is offered
  `available-to-sell = on_hand − reserved − buffer` (per-SKU configurable
  buffer, default 10% rounded up, minimum 1 when stock > 0).
- **Orders:** Walmart orders become canonical rows in the core `Order` table
  with a `channel` discriminator. One fulfillment pipeline, one inventory
  flow, one reporting view. Affiliate attribution remains order-level
  (null for Walmart orders — the schema constraint is unchanged).
- **Payment/tax:** Walmart is marketplace facilitator — it collects customer
  payment and sales tax. Walmart orders skip Stripe and the `TaxPort`
  entirely; channel-collected amounts are stored on the order for the books.

## Walmart API surface (v3, verified 2026-08-03)

- **Item Management API** — item setup via feeds using **item spec 5.x**
  (4.x sunset 2026-01-31; 5.x is mandatory).
- **Inventory API** — get/update quantity by SKU and ship node.
- **Price API** — price updates for listed SKUs.
- **Orders API** — retrieve, acknowledge, ship, cancel.
- **Returns API** — retrieve return orders, approve/reject, issue refunds.
- **On-Request Reports API** — settlement/reconciliation reports.
- **Notifications (webhooks)** — Walmart recommends webhooks for order/return
  status events, with API polling as the reliability fallback. We implement
  both.

References:
- https://developer.walmart.com/us-marketplace/docs/inventory-api-overview
- https://developer.walmart.com/us-marketplace/docs/returns-and-refunds-api-overview
- https://developer.walmart.com/us-marketplace/docs/on-request-reports-api-overview
- https://developer.walmart.com/us-marketplace/docs/notifications-overview

## Architecture

`systems/core` gains a `src/channels/walmart/` module with five components:

### 1. Walmart API client (`client/`)
Thin typed wrapper over Marketplace v3: token auth, request signing headers,
rate-limit awareness (honor retry headers), retries with exponential backoff.
No business logic. Credentials come from environment variables only — never
source control.

### 2. Anti-corruption layer (`mappers/`)
Pure functions, no I/O:
- canonical `Product`/`Variant` → item spec 5.x feed payload
- Walmart order JSON → canonical order input
- canonical shipment/refund → Walmart ship/refund payloads

All knowledge of Walmart's formats lives here and nowhere else. This is the
seam that keeps the rest of core Walmart-agnostic.

### 3. Outbound sync worker (`sync/`)
Scheduled/evented jobs:
- **Item feeds:** build + submit feeds for listings, record feed ID, poll
  feed status until accepted/rejected, persist per-item errors.
- **Inventory push:** on stock-change events (order placed / fulfilled /
  cancelled / restock) recompute available-to-sell and push; hourly full
  re-push of all listed SKUs as drift correction.
- **Price push:** on catalog price change for a listed SKU; per-listing
  override supported (Walmart price = catalog price unless overridden).

### 4. Inbound: webhook receiver + polling reconciler (`inbound/`)
- `POST /api/v1/channels/walmart/webhooks` — authenticated endpoint for
  order/return event notifications.
- Poller (~15 min) sweeps Orders and Returns APIs for anything a webhook
  missed.
- Both funnel into one **idempotent ingestion path** keyed on Walmart's
  purchase-order ID + event type (checked against `ChannelEvent`), so
  webhook/poller overlap and redeliveries are no-ops.

### 5. Channel sync state (DB tables)
Everything resumable and auditable. See data model below.

## Data model changes

`Order` (modify):
- `channel` — enum `storefront | walmart`, default `storefront`
- `externalOrderId` — Walmart purchase-order ID (unique per channel, null for
  storefront)
- `channelTaxCents`, `channelTotalCents` — amounts Walmart collected
  (null for storefront; existing Stripe/tax-port fields null for walmart)

New tables:
- `ChannelListing` — variant ↔ Walmart SKU, listing status
  (`draft | submitted | live | rejected | retired`), buffer override, price
  override, last-pushed qty/price + timestamps.
- `ChannelFeed` — feed ID, type (item/price/inventory), status, submitted-at,
  raw error payloads.
- `ChannelEvent` — inbound event log: source (webhook/poll), external ID,
  event type, processed-at. Uniqueness enforces idempotency.
- `ChannelSettlement` — imported settlement report lines, auto-matched to
  orders by purchase-order ID; unmatched lines flagged for review;
  exportable for bookkeeping.

All money integer cents; all state transitions write audit rows via the
existing `recordAudit`; new models added to `tests/helpers/db.ts` `resetDb()`
per core convention.

## Data flows

- **Listing:** admin marks a *published* product as listed on Walmart →
  feed built from catalog → submitted → feed status polled → `ChannelListing`
  updated; rejections surfaced in admin with Walmart's per-item errors.
- **Inventory:** stock change → available-to-sell recomputed → push;
  hourly reconciliation re-push.
- **Order in:** webhook/poll → idempotency check → mapper → order service
  creates canonical order (channel=walmart, inventory **reserved** at
  creation, audit row) → acknowledge to Walmart within SLA.
- **Ship:** fulfillment records carrier + tracking → push shipment update →
  Walmart marks shipped; core order follows the existing
  fulfillment transition (decrement on_hand + reserved).
- **Cancel:** both directions — Walmart-initiated cancels release the
  reservation; seller-initiated cancels push to Walmart then release.
- **Returns/refunds:** return events ingest via the same idempotent path;
  refunds issued through the Returns API; order marked channel-refunded
  (no Stripe).
- **Settlement:** scheduled report pull → `ChannelSettlement` → auto-match →
  review queue for mismatches.

## Error handling

- Every outbound push is a retryable job: exponential backoff, then a
  dead-letter state visible in admin. No silent failures.
- Rate limiting honors Walmart's retry headers.
- Inbound is idempotent by construction; the poller bounds webhook loss to
  one poll interval of delay — orders can be late, never lost.
- Feed rejections and orders that can't be fulfilled (e.g. SKU unmapped,
  insufficient stock at ingest) raise operator alerts.
- Walmart outage does not affect the storefront; the connector queues and
  catches up.

## Testing

- **Mappers:** unit tests against recorded real payloads (item spec 5.x
  feeds, order JSON, return JSON).
- **Ingestion + order creation:** vitest integration tests against real
  Postgres (existing core convention: container `imagibrick-core-db`,
  `fileParallelism:false`), Walmart client stubbed.
- **Sandbox E2E:** full listing → order → ship → return cycle against
  Walmart's sandbox before any production listing.
- **Contract drift check:** recorded payloads vs. live sandbox responses
  before launch.

## Out of scope (deliberate)

- No generic multi-channel framework — the seams (channel enum, mapper
  isolation, sync-state tables) are sufficient for a future second channel.
- No Walmart Fulfillment Services (we self-ship).
- No automated repricing/buy-box logic.
- No DSV/EDI path.

## Open items / non-engineering

- Production listing go-live, and anything constituting a new Walmart
  agreement or spend, needs Jack + partner sign-off per business policy.
- Category/compliance review of custom LEGO-compatible set listings on
  Walmart (brand terms, product compliance attributes required by item
  spec 5.x) happens during the listing task, before first submission.
