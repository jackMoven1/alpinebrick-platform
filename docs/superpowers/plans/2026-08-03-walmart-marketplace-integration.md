# Walmart Marketplace Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `channels/walmart` module to `systems/core` that lists products on Walmart Marketplace, syncs inventory/price, ingests Walmart orders as canonical orders, pushes shipments, handles returns/refunds, and imports settlement reports.

**Architecture:** Anti-corruption layer (pure mappers) + thin Walmart v3 API client + a DB-backed outbox job runner for all outbound pushes (retry w/ backoff → dead-letter) + idempotent inbound ingestion (webhook + pollers keyed on `ChannelEvent`). Walmart orders enter the existing order spine as `channel = walmart`, created in status `paid` (Walmart collects payment/tax as marketplace facilitator — no Stripe, no TaxPort).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Express 4, Prisma 5 + PostgreSQL, Vitest 2 + supertest, native `fetch` (Node 18+). No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-03-walmart-marketplace-integration-design.md`

**PREREQUISITE:** Plan 2 (`docs/superpowers/plans/2026-07-08-phase2-orders-inventory-tax.md`) must be fully executed first. This plan consumes its deliverables: `Order`/`OrderLine` models, `OrderStatus` enum, `src/orders/orders.service.ts` (`placeOrder`, `fulfillOrder`, `cancelOrder`, `OrderError`), and its stock-mutation conventions (conditional SQL, reserve/decrement).

**Spec refinement (documented deviation):** the spec proposed nullable `channelTaxCents`/`channelTotalCents` columns. Plan 2 made `subtotalCents`/`taxCents`/`totalCents` non-nullable canonical money columns, so this plan stores Walmart-collected amounts in those same columns and uses `taxJurisdiction = 'walmart_facilitator'`, `taxRateBps = 0` as provenance. The `channel` column is the discriminator. Same information, one money model.

## Global Constraints

- **Money = integer cents.** Walmart sends decimal dollars — always convert with `toCents()` (Task 3); never store floats.
- **ESM import specifiers end in `.js`** even for `.ts` files.
- **Item spec 5.x only** for item feeds (4.x sunset 2026-01-31).
- **Every order state transition writes an audit row** via `recordAudit` (existing `src/audit.ts`).
- **Tests run against real Postgres** (container `imagibrick-core-db`, port 5433; `vitest.config.ts` already sets `fileParallelism:false`). Walmart HTTP is always stubbed in tests via an injected `fetchFn`/`WalmartClient` — tests never call Walmart.
- **New models must be added to `tests/helpers/db.ts` `resetDb()`** in child-before-parent delete order.
- **Credentials only from env:** `WALMART_CLIENT_ID`, `WALMART_CLIENT_SECRET`, `WALMART_API_BASE` (default `https://sandbox.walmartapis.com`), `WALMART_WEBHOOK_SECRET`, `WALMART_SYNC_ENABLED`. Never in source.
- **Inbound ingestion is idempotent:** uniqueness on `ChannelEvent(externalId, eventType)`; re-delivery is a no-op.
- **Safety buffer default:** 10% of on-hand rounded up, minimum 1 when on-hand > 0; per-listing override via `bufferPct`.
- **Commit format:** conventional (`feat(core):`, `test(core):`), one commit per task minimum.
- All work on a feature branch off `main` (e.g. `feat/walmart-channel`); PR review before merge.

## File Structure

- `prisma/schema.prisma` — **modify.** `OrderChannel` + `refunded` status; channel tables.
- `src/channels/walmart/client.ts` — API client: token auth, retries. No business logic.
- `src/channels/walmart/outbox.ts` — DB-backed job queue: enqueue, handlers, backoff, dead-letter.
- `src/channels/walmart/mappers.ts` — pure canonical↔Walmart translation. All Walmart formats live here.
- `src/channels/walmart/orders.ingest.ts` — idempotent Walmart order → canonical order.
- `src/channels/walmart/webhooks.routes.ts` — webhook endpoint.
- `src/channels/walmart/pollers.ts` — order/return polling reconcilers.
- `src/channels/walmart/inventory.sync.ts` — available-to-sell + inventory push.
- `src/channels/walmart/listings.service.ts` — listing lifecycle + item feeds.
- `src/channels/walmart/price.sync.ts` — price push.
- `src/channels/walmart/shipping.ts` — order ack + shipment push.
- `src/channels/walmart/returns.service.ts` — return ingestion + refunds.
- `src/channels/walmart/settlement.ts` — settlement import + matching.
- `src/channels/walmart/scheduler.ts` — intervals wiring (not run in tests).
- `src/app.ts` — **modify.** Mount webhook router.
- `src/server.ts` — **modify.** Start scheduler when enabled.

---

### Task 1: Schema — channel columns + channel tables

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `tests/helpers/db.ts`
- Test: `tests/walmart-schema.test.ts`

**Interfaces:**
- Consumes: Plan 2's `Order`, `OrderStatus`, `Variant`.
- Produces (Prisma models used by every later task): `OrderChannel`, `Order.channel`, `Order.externalOrderId`, `OrderStatus.refunded`, `ChannelListing`, `ChannelFeed`, `ChannelEvent`, `ChannelSettlement`, `ChannelJob` (+ enums below).

- [ ] **Step 1: Write the failing test**

```ts
// tests/walmart-schema.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'

describe('walmart channel schema', () => {
  beforeEach(resetDb)

  it('creates a walmart-channel order with external id', async () => {
    const o = await prisma.order.create({
      data: {
        email: 'walmart-customer@channel.local', shipToState: 'MI',
        subtotalCents: 9998, taxCents: 600, totalCents: 10598,
        taxRateBps: 0, taxJurisdiction: 'walmart_facilitator',
        status: 'paid', channel: 'walmart', externalOrderId: 'PO-1001',
      },
    })
    expect(o.channel).toBe('walmart')
    await expect(prisma.order.create({
      data: {
        email: 'x@y.z', shipToState: 'MI', subtotalCents: 1, taxCents: 0, totalCents: 1,
        taxRateBps: 0, taxJurisdiction: 'walmart_facilitator',
        channel: 'walmart', externalOrderId: 'PO-1001',
      },
    })).rejects.toThrow() // unique externalOrderId
  })

  it('defaults channel to storefront', async () => {
    const o = await prisma.order.create({
      data: { email: 'a@b.c', shipToState: 'MI', subtotalCents: 1, taxCents: 0, totalCents: 1, taxRateBps: 600, taxJurisdiction: 'MI' },
    })
    expect(o.channel).toBe('storefront')
    expect(o.externalOrderId).toBeNull()
  })

  it('enforces ChannelEvent idempotency key and creates channel tables', async () => {
    const p = await prisma.product.create({ data: { slug: 'p1', name: 'P1', productType: 'own_designed', status: 'published' } })
    const v = await prisma.variant.create({ data: { productId: p.id, sku: 'IB-1', priceCents: 4999 } })
    await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'IB-1-W' } })
    await prisma.channelJob.create({ data: { type: 'walmart_push_inventory', payload: { variantId: v.id } } })
    await prisma.channelFeed.create({ data: { feedId: 'F1', type: 'item', status: 'submitted' } })
    await prisma.channelSettlement.create({ data: { reportDate: new Date(), externalOrderId: 'PO-1', amountCents: 100, feeCents: 15, raw: {} } })
    await prisma.channelEvent.create({ data: { source: 'webhook', externalId: 'PO-1', eventType: 'order_created' } })
    await expect(prisma.channelEvent.create({ data: { source: 'poll', externalId: 'PO-1', eventType: 'order_created' } }))
      .rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/walmart-schema.test.ts` (from `systems/core`)
Expected: FAIL — `channel` unknown arg / `prisma.channelListing` undefined.

- [ ] **Step 3: Add schema changes**

In `prisma/schema.prisma` add `refunded` to the existing `OrderStatus` enum, then append:

```prisma
enum OrderChannel {
  storefront
  walmart
}

enum ChannelListingStatus {
  draft
  submitted
  live
  rejected
  retired
}

enum ChannelFeedType {
  item
  price
  inventory
}

enum ChannelFeedStatus {
  submitted
  processed
  error
}

enum ChannelEventSource {
  webhook
  poll
}

enum ChannelJobStatus {
  pending
  done
  dead
}

enum ChannelSettlementStatus {
  matched
  unmatched
}

model ChannelListing {
  id                   String               @id @default(cuid())
  variantId            String               @unique @map("variant_id")
  variant              Variant              @relation(fields: [variantId], references: [id], onDelete: Cascade)
  walmartSku           String               @unique @map("walmart_sku")
  status               ChannelListingStatus @default(draft)
  bufferPct            Int?                 @map("buffer_pct")
  priceOverrideCents   Int?                 @map("price_override_cents")
  lastPushedQty        Int?                 @map("last_pushed_qty")
  lastPushedPriceCents Int?                 @map("last_pushed_price_cents")
  lastSyncedAt         DateTime?            @map("last_synced_at")
  createdAt            DateTime             @default(now()) @map("created_at")
  updatedAt            DateTime             @updatedAt @map("updated_at")
  @@map("channel_listings")
}

model ChannelFeed {
  id          String            @id @default(cuid())
  feedId      String            @unique @map("feed_id")
  type        ChannelFeedType
  status      ChannelFeedStatus @default(submitted)
  errors      Json?
  submittedAt DateTime          @default(now()) @map("submitted_at")
  updatedAt   DateTime          @updatedAt @map("updated_at")
  @@map("channel_feeds")
}

model ChannelEvent {
  id          String             @id @default(cuid())
  source      ChannelEventSource
  externalId  String             @map("external_id")
  eventType   String             @map("event_type")
  processedAt DateTime           @default(now()) @map("processed_at")
  @@unique([externalId, eventType])
  @@map("channel_events")
}

model ChannelJob {
  id        String           @id @default(cuid())
  type      String
  payload   Json
  status    ChannelJobStatus @default(pending)
  attempts  Int              @default(0)
  runAfter  DateTime         @default(now()) @map("run_after")
  lastError String?          @map("last_error")
  dedupeKey String?          @unique @map("dedupe_key")
  createdAt DateTime         @default(now()) @map("created_at")
  updatedAt DateTime         @updatedAt @map("updated_at")
  @@index([status, runAfter])
  @@map("channel_jobs")
}

model ChannelSettlement {
  id              String                  @id @default(cuid())
  reportDate      DateTime                @map("report_date")
  externalOrderId String                  @map("external_order_id")
  amountCents     Int                     @map("amount_cents")
  feeCents        Int                     @map("fee_cents")
  currency        String                  @default("USD")
  orderId         String?                 @map("order_id")
  status          ChannelSettlementStatus @default(unmatched)
  raw             Json
  createdAt       DateTime                @default(now()) @map("created_at")
  @@index([externalOrderId])
  @@map("channel_settlements")
}
```

Inside the existing `Order` model add:

```prisma
  channel         OrderChannel @default(storefront)
  externalOrderId String?      @unique @map("external_order_id")
```

Inside the existing `Variant` model add the back-relation:

```prisma
  channelListing ChannelListing?
```

- [ ] **Step 4: Update resetDb**

In `tests/helpers/db.ts`, add before `variant` deletion (children first; channel tables have no FK children):

```ts
  await prisma.channelEvent.deleteMany()
  await prisma.channelJob.deleteMany()
  await prisma.channelFeed.deleteMany()
  await prisma.channelSettlement.deleteMany()
  await prisma.channelListing.deleteMany()
```

(Keep Plan 2's `orderLine`/`order` deletions in place; `channelListing` must be deleted before `variant`.)

- [ ] **Step 5: Migrate**

Run: `npx prisma migrate dev --name add_walmart_channel`
Expected: migration created; client regenerated; "Your database is now in sync with your schema."

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/walmart-schema.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add prisma tests
git commit -m "feat(core): walmart channel schema — order channel, listings, feeds, events, jobs, settlements"
```

---

### Task 2: Walmart API client

**Files:**
- Create: `src/channels/walmart/client.ts`
- Test: `tests/walmart-client.test.ts`

**Interfaces:**
- Consumes: nothing (env + injected fetch).
- Produces:
  - `class WalmartApiError extends Error { status: number; body: string }`
  - `interface WalmartClient { request(method: 'GET'|'POST'|'PUT', path: string, opts?: { body?: unknown; query?: Record<string, string> }): Promise<unknown> }`
  - `function createWalmartClient(cfg?: { clientId?: string; clientSecret?: string; baseUrl?: string; fetchFn?: typeof fetch }): WalmartClient` — cfg fields default to env `WALMART_CLIENT_ID` / `WALMART_CLIENT_SECRET` / `WALMART_API_BASE` (default sandbox URL) and global `fetch`.
  - `function getWalmartClient(): WalmartClient` — lazy module singleton used by handlers in later tasks.

Behavior: `POST {base}/v3/token` (basic auth, `grant_type=client_credentials`) with token cached until 60s before expiry; every request sends `WM_SEC.ACCESS_TOKEN`, `WM_QOS.CORRELATION_ID` (random UUID), `WM_SVC.NAME: ImagiBricks`, `Accept: application/json`; on 401 refresh token once; on 429/5xx retry up to 3 attempts with backoff `attempt * 500ms` (honor numeric `Retry-After` seconds if present); non-OK after retries throws `WalmartApiError`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/walmart-client.test.ts
import { describe, it, expect } from 'vitest'
import { createWalmartClient, WalmartApiError } from '../src/channels/walmart/client.js'

function stubFetch(script: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchFn = (async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    const next = script.shift() ?? { status: 500, body: 'exhausted' }
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json', ...next.headers },
    })
  }) as typeof fetch
  return { fetchFn, calls }
}

const token = { access_token: 'tok-1', expires_in: 900 }

describe('walmart client', () => {
  it('fetches a token once and sends auth headers', async () => {
    const { fetchFn, calls } = stubFetch([
      { status: 200, body: token },
      { status: 200, body: { ok: 1 } },
      { status: 200, body: { ok: 2 } },
    ])
    const c = createWalmartClient({ clientId: 'id', clientSecret: 'sec', baseUrl: 'https://sandbox.test', fetchFn })
    await c.request('GET', '/v3/orders', { query: { limit: '10' } })
    await c.request('GET', '/v3/orders')
    expect(calls[0].url).toBe('https://sandbox.test/v3/token')
    expect(calls[1].url).toBe('https://sandbox.test/v3/orders?limit=10')
    const h = calls[1].init.headers as Record<string, string>
    expect(h['WM_SEC.ACCESS_TOKEN']).toBe('tok-1')
    expect(h['WM_SVC.NAME']).toBe('ImagiBricks')
    expect(h['WM_QOS.CORRELATION_ID']).toBeTruthy()
    expect(calls.length).toBe(3) // token reused for second call
  })

  it('retries 429 then succeeds', async () => {
    const { fetchFn, calls } = stubFetch([
      { status: 200, body: token },
      { status: 429, body: 'slow down', headers: { 'retry-after': '0' } },
      { status: 200, body: { ok: true } },
    ])
    const c = createWalmartClient({ clientId: 'id', clientSecret: 'sec', baseUrl: 'https://sandbox.test', fetchFn })
    const res = await c.request('GET', '/v3/inventory')
    expect(res).toEqual({ ok: true })
    expect(calls.length).toBe(3)
  })

  it('throws WalmartApiError after exhausting retries', async () => {
    const { fetchFn } = stubFetch([
      { status: 200, body: token },
      { status: 500, body: 'boom' }, { status: 500, body: 'boom' }, { status: 500, body: 'boom' },
    ])
    const c = createWalmartClient({ clientId: 'id', clientSecret: 'sec', baseUrl: 'https://sandbox.test', fetchFn })
    await expect(c.request('POST', '/v3/feeds', { body: { a: 1 } })).rejects.toBeInstanceOf(WalmartApiError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/walmart-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/channels/walmart/client.ts
import { randomUUID } from 'node:crypto'

export class WalmartApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`walmart api error ${status}: ${body.slice(0, 500)}`)
    this.name = 'WalmartApiError'
  }
}

export interface WalmartClient {
  request(method: 'GET' | 'POST' | 'PUT', path: string, opts?: { body?: unknown; query?: Record<string, string> }): Promise<unknown>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function createWalmartClient(cfg: { clientId?: string; clientSecret?: string; baseUrl?: string; fetchFn?: typeof fetch } = {}): WalmartClient {
  const clientId = cfg.clientId ?? process.env.WALMART_CLIENT_ID ?? ''
  const clientSecret = cfg.clientSecret ?? process.env.WALMART_CLIENT_SECRET ?? ''
  const baseUrl = (cfg.baseUrl ?? process.env.WALMART_API_BASE ?? 'https://sandbox.walmartapis.com').replace(/\/$/, '')
  const fetchFn = cfg.fetchFn ?? fetch
  let token: { value: string; expiresAt: number } | null = null

  async function getToken(force = false): Promise<string> {
    if (!force && token && token.expiresAt > Date.now() + 60_000) return token.value
    const res = await fetchFn(`${baseUrl}/v3/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'WM_QOS.CORRELATION_ID': randomUUID(),
        'WM_SVC.NAME': 'ImagiBricks',
      },
      body: 'grant_type=client_credentials',
    })
    if (!res.ok) throw new WalmartApiError(res.status, await res.text())
    const data = (await res.json()) as { access_token: string; expires_in: number }
    token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 }
    return token.value
  }

  async function request(method: 'GET' | 'POST' | 'PUT', path: string, opts: { body?: unknown; query?: Record<string, string> } = {}): Promise<unknown> {
    const qs = opts.query ? `?${new URLSearchParams(opts.query)}` : ''
    let refreshed = false
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetchFn(`${baseUrl}${path}${qs}`, {
        method,
        headers: {
          'WM_SEC.ACCESS_TOKEN': await getToken(),
          'WM_QOS.CORRELATION_ID': randomUUID(),
          'WM_SVC.NAME': 'ImagiBricks',
          Accept: 'application/json',
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      })
      if (res.ok) {
        const text = await res.text()
        return text ? JSON.parse(text) : null
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true
        await getToken(true)
        continue
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const retryAfter = Number(res.headers.get('retry-after'))
        await sleep(Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : attempt * 500)
        continue
      }
      throw new WalmartApiError(res.status, await res.text())
    }
    throw new WalmartApiError(0, 'unreachable')
  }

  return { request }
}

let singleton: WalmartClient | null = null
export function getWalmartClient(): WalmartClient {
  if (!singleton) singleton = createWalmartClient()
  return singleton
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/walmart-client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/channels/walmart/client.ts tests/walmart-client.test.ts
git commit -m "feat(core): walmart v3 api client with token auth and retry"
```

---

### Task 3: Mappers + `toCents` (anti-corruption layer)

**Files:**
- Create: `src/channels/walmart/mappers.ts`
- Test: `tests/walmart-mappers.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `function toCents(dollars: number): number` — `Math.round(dollars * 100)`.
  - `interface CanonicalChannelOrder { externalOrderId: string; email: string; shipToState: string; lines: { walmartSku: string; quantity: number; unitPriceCents: number; lineTaxCents: number }[] }`
  - `function toCanonicalOrder(payload: unknown): CanonicalChannelOrder` — parses Walmart order JSON; throws `Error('unmappable_order: <reason>')` on missing fields.
  - `function toItemFeed(items: { walmartSku: string; name: string; description: string; priceCents: number; imageUrls: string[] }[]): unknown` — item spec 5.x `MP_ITEM` feed body.
  - `function toShipPayload(input: { lineNumbers: string[]; quantityByLine: Record<string, number>; carrier: string; trackingNumber: string; trackingUrl?: string; shipDateIso: string }): unknown`
  - `function toInventoryPayload(walmartSku: string, quantity: number): unknown` — `{ sku, quantity: { unit: 'EACH', amount } }`
  - `function toPricePayload(walmartSku: string, priceCents: number): unknown`

- [ ] **Step 1: Write the failing test**

```ts
// tests/walmart-mappers.test.ts
import { describe, it, expect } from 'vitest'
import { toCents, toCanonicalOrder, toItemFeed, toInventoryPayload, toPricePayload, toShipPayload } from '../src/channels/walmart/mappers.js'

// Trimmed from a real sandbox order response shape (Orders API v3).
export const walmartOrderFixture = {
  purchaseOrderId: 'PO-1001',
  customerOrderId: 'CO-9001',
  customerEmailId: 'mgr@relay.walmart.com',
  orderDate: 1754160000000,
  shippingInfo: { postalAddress: { state: 'MI', postalCode: '48823' } },
  orderLines: {
    orderLine: [
      {
        lineNumber: '1',
        item: { sku: 'IB-SET-001-W', productName: 'Castle Set' },
        orderLineQuantity: { unitOfMeasurement: 'EACH', amount: '2' },
        charges: {
          charge: [
            {
              chargeType: 'PRODUCT',
              chargeAmount: { currency: 'USD', amount: 49.99 },
              tax: { taxName: 'Tax1', taxAmount: { currency: 'USD', amount: 3.0 } },
            },
          ],
        },
      },
    ],
  },
}

describe('walmart mappers', () => {
  it('toCents rounds decimal dollars', () => {
    expect(toCents(49.99)).toBe(4999)
    expect(toCents(3.0)).toBe(300)
    expect(toCents(0.015)).toBe(2)
  })

  it('maps a walmart order to canonical form (per-unit charges multiplied by qty downstream)', () => {
    const o = toCanonicalOrder(walmartOrderFixture)
    expect(o).toEqual({
      externalOrderId: 'PO-1001',
      email: 'mgr@relay.walmart.com',
      shipToState: 'MI',
      lines: [{ walmartSku: 'IB-SET-001-W', quantity: 2, unitPriceCents: 4999, lineTaxCents: 600 }],
    })
  })

  it('falls back to placeholder email and rejects unmappable payloads', () => {
    const noEmail = { ...walmartOrderFixture, customerEmailId: undefined }
    expect(toCanonicalOrder(noEmail).email).toBe('walmart-customer@channel.local')
    expect(() => toCanonicalOrder({})).toThrow(/unmappable_order/)
  })

  it('builds an item spec 5.x feed', () => {
    const feed = toItemFeed([{ walmartSku: 'IB-1-W', name: 'Set', description: 'Bricks', priceCents: 4999, imageUrls: ['https://img/1.jpg'] }]) as any
    expect(feed.MPItemFeedHeader.version).toBe('5.0')
    expect(feed.MPItem).toHaveLength(1)
    expect(feed.MPItem[0].Orderable.sku).toBe('IB-1-W')
    expect(feed.MPItem[0].Orderable.price).toBe(49.99)
  })

  it('builds inventory, price, and ship payloads', () => {
    expect(toInventoryPayload('IB-1-W', 7)).toEqual({ sku: 'IB-1-W', quantity: { unit: 'EACH', amount: 7 } })
    const price = toPricePayload('IB-1-W', 4999) as any
    expect(price.pricing[0].currentPrice.amount).toBe(49.99)
    const ship = toShipPayload({ lineNumbers: ['1'], quantityByLine: { '1': 2 }, carrier: 'USPS', trackingNumber: 'T123', shipDateIso: '2026-08-03T12:00:00Z' }) as any
    expect(ship.orderShipment.orderLines.orderLine[0].orderLineStatuses.orderLineStatus[0].trackingInfo.trackingNumber).toBe('T123')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/walmart-mappers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/channels/walmart/mappers.ts
export function toCents(dollars: number): number {
  return Math.round(dollars * 100)
}

export interface CanonicalChannelOrder {
  externalOrderId: string
  email: string
  shipToState: string
  lines: { walmartSku: string; quantity: number; unitPriceCents: number; lineTaxCents: number }[]
}

export function toCanonicalOrder(payload: unknown): CanonicalChannelOrder {
  const p = payload as any
  if (!p?.purchaseOrderId || !p?.orderLines?.orderLine?.length) {
    throw new Error('unmappable_order: missing purchaseOrderId or orderLines')
  }
  const state = p.shippingInfo?.postalAddress?.state
  if (!state) throw new Error('unmappable_order: missing ship-to state')
  const lines = (p.orderLines.orderLine as any[]).map((l) => {
    const qty = Number(l?.orderLineQuantity?.amount)
    const product = (l?.charges?.charge as any[] | undefined)?.find((c) => c.chargeType === 'PRODUCT')
    if (!l?.item?.sku || !Number.isInteger(qty) || qty <= 0 || !product?.chargeAmount) {
      throw new Error(`unmappable_order: bad line ${l?.lineNumber}`)
    }
    const taxDollars = product.tax?.taxAmount?.amount ?? 0
    return {
      walmartSku: l.item.sku as string,
      quantity: qty,
      unitPriceCents: toCents(product.chargeAmount.amount),
      lineTaxCents: toCents(taxDollars) * qty, // Walmart charges/tax are per unit
    }
  })
  return {
    externalOrderId: p.purchaseOrderId,
    email: p.customerEmailId ?? 'walmart-customer@channel.local',
    shipToState: state,
    lines,
  }
}

export function toItemFeed(items: { walmartSku: string; name: string; description: string; priceCents: number; imageUrls: string[] }[]): unknown {
  return {
    MPItemFeedHeader: { version: '5.0', requestId: undefined, requestBatchId: undefined, locale: 'en', sellingChannel: 'marketplace' },
    MPItem: items.map((i) => ({
      Orderable: {
        sku: i.walmartSku,
        productIdentifiers: { productIdType: 'SKU', productId: i.walmartSku },
        productName: i.name,
        price: i.priceCents / 100,
        ShippingWeight: 1,
      },
      Visible: {
        Toys: { shortDescription: i.description, mainImageUrl: i.imageUrls[0], productSecondaryImageURL: i.imageUrls.slice(1) },
      },
    })),
  }
}

export function toInventoryPayload(walmartSku: string, quantity: number): unknown {
  return { sku: walmartSku, quantity: { unit: 'EACH', amount: quantity } }
}

export function toPricePayload(walmartSku: string, priceCents: number): unknown {
  return { sku: walmartSku, pricing: [{ currentPriceType: 'BASE', currentPrice: { currency: 'USD', amount: priceCents / 100 } }] }
}

export function toShipPayload(input: { lineNumbers: string[]; quantityByLine: Record<string, number>; carrier: string; trackingNumber: string; trackingUrl?: string; shipDateIso: string }): unknown {
  return {
    orderShipment: {
      orderLines: {
        orderLine: input.lineNumbers.map((n) => ({
          lineNumber: n,
          orderLineStatuses: {
            orderLineStatus: [{
              status: 'Shipped',
              statusQuantity: { unitOfMeasurement: 'EACH', amount: String(input.quantityByLine[n] ?? 1) },
              trackingInfo: {
                shipDateTime: input.shipDateIso,
                carrierName: { carrier: input.carrier },
                methodCode: 'Standard',
                trackingNumber: input.trackingNumber,
                trackingURL: input.trackingUrl,
              },
            }],
          },
        })),
      },
    },
  }
}
```

Note for implementer: exact 5.x `Visible` category attributes (Toys) must be verified against the sandbox during Task 13 — the mapper isolates any correction to this one file.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/walmart-mappers.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/channels/walmart/mappers.ts tests/walmart-mappers.test.ts
git commit -m "feat(core): walmart anti-corruption mappers (order, item feed 5.x, inventory, price, ship)"
```

---

### Task 4: Outbox job runner

**Files:**
- Create: `src/channels/walmart/outbox.ts`
- Test: `tests/walmart-outbox.test.ts`

**Interfaces:**
- Consumes: `prisma`, `ChannelJob` model (Task 1).
- Produces:
  - `function registerHandler(type: string, handler: (payload: any) => Promise<void>): void`
  - `function clearHandlers(): void` — test helper.
  - `function enqueueJob(type: string, payload: unknown, opts?: { dedupeKey?: string; runAfter?: Date }): Promise<{ id: string } | null>` — returns `null` if `dedupeKey` already queued (unique constraint swallowed).
  - `function processDueJobs(now?: Date): Promise<{ processed: number; failed: number }>` — runs every `pending` job with `runAfter <= now`; success → `done`; failure → `attempts+1`, `lastError`, `runAfter = now + 2^attempts minutes`; after 5 attempts → `dead` (the dead-letter state; surfaced later via admin query).

- [ ] **Step 1: Write the failing test**

```ts
// tests/walmart-outbox.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { enqueueJob, processDueJobs, registerHandler, clearHandlers } from '../src/channels/walmart/outbox.js'

describe('walmart outbox', () => {
  beforeEach(async () => {
    await resetDb()
    clearHandlers()
  })

  it('runs a due job and marks it done', async () => {
    const seen: unknown[] = []
    registerHandler('t', async (p) => { seen.push(p) })
    await enqueueJob('t', { a: 1 })
    const r = await processDueJobs()
    expect(r).toEqual({ processed: 1, failed: 0 })
    expect(seen).toEqual([{ a: 1 }])
    expect((await prisma.channelJob.findFirstOrThrow()).status).toBe('done')
  })

  it('dedupes by dedupeKey', async () => {
    registerHandler('t', async () => {})
    expect(await enqueueJob('t', {}, { dedupeKey: 'k1' })).not.toBeNull()
    expect(await enqueueJob('t', {}, { dedupeKey: 'k1' })).toBeNull()
    expect(await prisma.channelJob.count()).toBe(1)
  })

  it('backs off on failure and dead-letters after 5 attempts', async () => {
    registerHandler('t', async () => { throw new Error('nope') })
    await enqueueJob('t', {})
    for (let i = 0; i < 5; i++) {
      const job = await prisma.channelJob.findFirstOrThrow()
      await processDueJobs(new Date(job.runAfter.getTime() + 1))
    }
    const job = await prisma.channelJob.findFirstOrThrow()
    expect(job.status).toBe('dead')
    expect(job.attempts).toBe(5)
    expect(job.lastError).toContain('nope')
  })

  it('skips jobs with runAfter in the future and unknown types fail', async () => {
    registerHandler('known', async () => {})
    await enqueueJob('known', {}, { runAfter: new Date(Date.now() + 60_000) })
    await enqueueJob('unknown', {})
    const r = await processDueJobs()
    expect(r.processed).toBe(0)
    expect(r.failed).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/walmart-outbox.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/channels/walmart/outbox.ts
import { prisma } from '../../prisma.js'
import type { Prisma } from '@prisma/client'

type Handler = (payload: any) => Promise<void>
const handlers = new Map<string, Handler>()

export function registerHandler(type: string, handler: Handler): void {
  handlers.set(type, handler)
}

export function clearHandlers(): void {
  handlers.clear()
}

export async function enqueueJob(
  type: string,
  payload: unknown,
  opts: { dedupeKey?: string; runAfter?: Date } = {},
): Promise<{ id: string } | null> {
  try {
    const job = await prisma.channelJob.create({
      data: {
        type,
        payload: payload as Prisma.InputJsonValue,
        dedupeKey: opts.dedupeKey,
        runAfter: opts.runAfter ?? new Date(),
      },
      select: { id: true },
    })
    return job
  } catch (e: any) {
    if (e?.code === 'P2002') return null // dedupeKey already queued
    throw e
  }
}

const MAX_ATTEMPTS = 5

export async function processDueJobs(now: Date = new Date()): Promise<{ processed: number; failed: number }> {
  const due = await prisma.channelJob.findMany({
    where: { status: 'pending', runAfter: { lte: now } },
    orderBy: { createdAt: 'asc' },
    take: 50,
  })
  let processed = 0
  let failed = 0
  for (const job of due) {
    const handler = handlers.get(job.type)
    try {
      if (!handler) throw new Error(`no handler registered for job type ${job.type}`)
      await handler(job.payload)
      await prisma.channelJob.update({ where: { id: job.id }, data: { status: 'done' } })
      processed++
    } catch (e: any) {
      const attempts = job.attempts + 1
      failed++
      await prisma.channelJob.update({
        where: { id: job.id },
        data: {
          attempts,
          lastError: String(e?.message ?? e).slice(0, 1000),
          status: attempts >= MAX_ATTEMPTS ? 'dead' : 'pending',
          runAfter: new Date(now.getTime() + 2 ** attempts * 60_000),
        },
      })
    }
  }
  return { processed, failed }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/walmart-outbox.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/channels/walmart/outbox.ts tests/walmart-outbox.test.ts
git commit -m "feat(core): channel outbox job runner with backoff and dead-letter"
```

---

### Task 5: Order ingestion — Walmart order → canonical order

**Files:**
- Create: `src/channels/walmart/orders.ingest.ts`
- Test: `tests/walmart-orders-ingest.test.ts`

**Interfaces:**
- Consumes: `toCanonicalOrder` (Task 3), `enqueueJob` (Task 4), `prisma`, `recordAudit`, `ChannelEvent`/`ChannelListing` (Task 1).
- Produces:
  - `class ChannelError extends Error { code: string }` (constructor `(code, message)`)
  - `function ingestWalmartOrder(payload: unknown, source: 'webhook' | 'poll'): Promise<{ orderId: string | null; created: boolean }>` — behavior:
    1. Map payload (`toCanonicalOrder`); unmappable → `ChannelError('unmappable_order')`.
    2. If `ChannelEvent(externalId, 'order_created')` exists → return `{ orderId: existing order id or null, created: false }`.
    3. Resolve each `walmartSku` via `ChannelListing` → variant; missing listing → `ChannelError('unknown_sku')`.
    4. In one transaction: conditionally reserve stock per line (`UPDATE inventory SET reserved = reserved + qty WHERE variant_id = ? AND on_hand - reserved >= qty`; zero rows → `ChannelError('insufficient_stock')`, transaction rolls back so a later retry can succeed after restock); create `Order` (`status: 'paid'`, `channel: 'walmart'`, `externalOrderId`, money = sums of Walmart line amounts, `taxRateBps: 0`, `taxJurisdiction: 'walmart_facilitator'`) with `OrderLine`s (`sku` = internal variant sku, `unitPriceCents`, `lineSubtotalCents = qty * unitPriceCents`); create the `ChannelEvent`; `recordAudit({ action: 'walmart_order_ingested', target: order.id, after: { externalOrderId } })` with the seeded system actor.
    5. Enqueue `walmart_ack_order` job with `{ externalOrderId }`, dedupeKey `ack:<externalOrderId>`.
- Error codes produced: `unmappable_order`, `unknown_sku`, `insufficient_stock`. Callers (Task 6) catch and log; failed ingests do NOT write a `ChannelEvent`, so the poller retries them — that is the operator-alert surface plus recovery path.

- [ ] **Step 1: Write the failing test**

```ts
// tests/walmart-orders-ingest.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seedSystemActor } from './helpers/seed.js' // Plan 2 helper; if named differently, use the Plan 2 equivalent that seeds the 'system' actor
import { ingestWalmartOrder, ChannelError } from '../src/channels/walmart/orders.ingest.js'
import { walmartOrderFixture } from './walmart-mappers.test.js'

async function seedListing(qty: number) {
  const p = await prisma.product.create({ data: { slug: 'castle', name: 'Castle', productType: 'own_designed', status: 'published' } })
  const v = await prisma.variant.create({ data: { productId: p.id, sku: 'IB-SET-001', priceCents: 4999 } })
  await prisma.inventory.create({ data: { variantId: v.id, onHand: qty } })
  await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'IB-SET-001-W', status: 'live' } })
  return v
}

describe('ingestWalmartOrder', () => {
  beforeEach(async () => {
    await resetDb()
    await seedSystemActor()
  })

  it('creates a paid walmart order, reserves stock, records event + audit, enqueues ack', async () => {
    const v = await seedListing(10)
    const r = await ingestWalmartOrder(walmartOrderFixture, 'webhook')
    expect(r.created).toBe(true)
    const order = await prisma.order.findUniqueOrThrow({ where: { id: r.orderId! }, include: { lines: true } })
    expect(order).toMatchObject({
      status: 'paid', channel: 'walmart', externalOrderId: 'PO-1001',
      subtotalCents: 9998, taxCents: 600, totalCents: 10598,
      taxRateBps: 0, taxJurisdiction: 'walmart_facilitator',
    })
    expect(order.lines[0]).toMatchObject({ sku: 'IB-SET-001', quantity: 2, unitPriceCents: 4999, lineSubtotalCents: 9998 })
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { variantId: v.id } })
    expect(inv.reserved).toBe(2)
    expect(await prisma.channelEvent.count({ where: { externalId: 'PO-1001', eventType: 'order_created' } })).toBe(1)
    expect(await prisma.channelJob.count({ where: { type: 'walmart_ack_order' } })).toBe(1)
    expect(await prisma.auditLog.count({ where: { action: 'walmart_order_ingested' } })).toBe(1)
  })

  it('is idempotent across webhook + poll duplication', async () => {
    await seedListing(10)
    const first = await ingestWalmartOrder(walmartOrderFixture, 'webhook')
    const second = await ingestWalmartOrder(walmartOrderFixture, 'poll')
    expect(second).toEqual({ orderId: first.orderId, created: false })
    expect(await prisma.order.count()).toBe(1)
    const inv = await prisma.inventory.findFirstOrThrow()
    expect(inv.reserved).toBe(2)
  })

  it('rejects unknown skus and insufficient stock without writing an event', async () => {
    await expect(ingestWalmartOrder(walmartOrderFixture, 'poll')).rejects.toMatchObject({ code: 'unknown_sku' })
    await seedListing(1) // order wants 2
    await expect(ingestWalmartOrder(walmartOrderFixture, 'poll')).rejects.toMatchObject({ code: 'insufficient_stock' })
    expect(await prisma.channelEvent.count()).toBe(0)
    expect(await prisma.order.count()).toBe(0)
    const inv = await prisma.inventory.findFirstOrThrow()
    expect(inv.reserved).toBe(0) // rollback released the partial reservation
  })

  it('throws ChannelError on unmappable payloads', async () => {
    await expect(ingestWalmartOrder({}, 'webhook')).rejects.toBeInstanceOf(ChannelError)
  })
})
```

(If Plan 2's seed helper has a different name/location, adapt the import — the requirement is only that the `'system'` actor used by `recordAudit`'s default exists.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/walmart-orders-ingest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/channels/walmart/orders.ingest.ts
import { prisma } from '../../prisma.js'
import { recordAudit } from '../../audit.js'
import { toCanonicalOrder } from './mappers.js'
import { enqueueJob } from './outbox.js'

export class ChannelError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'ChannelError'
  }
}

export async function ingestWalmartOrder(
  payload: unknown,
  source: 'webhook' | 'poll',
): Promise<{ orderId: string | null; created: boolean }> {
  let canonical
  try {
    canonical = toCanonicalOrder(payload)
  } catch (e: any) {
    throw new ChannelError('unmappable_order', String(e?.message ?? e))
  }

  const existing = await prisma.channelEvent.findUnique({
    where: { externalId_eventType: { externalId: canonical.externalOrderId, eventType: 'order_created' } },
  })
  if (existing) {
    const order = await prisma.order.findUnique({ where: { externalOrderId: canonical.externalOrderId }, select: { id: true } })
    return { orderId: order?.id ?? null, created: false }
  }

  const listings = await prisma.channelListing.findMany({
    where: { walmartSku: { in: canonical.lines.map((l) => l.walmartSku) } },
    include: { variant: true },
  })
  const byWalmartSku = new Map(listings.map((l) => [l.walmartSku, l]))
  for (const line of canonical.lines) {
    if (!byWalmartSku.has(line.walmartSku)) {
      throw new ChannelError('unknown_sku', `no channel listing for walmart sku ${line.walmartSku}`)
    }
  }

  const subtotalCents = canonical.lines.reduce((s, l) => s + l.quantity * l.unitPriceCents, 0)
  const taxCents = canonical.lines.reduce((s, l) => s + l.lineTaxCents, 0)

  const orderId = await prisma.$transaction(async (tx) => {
    for (const line of canonical.lines) {
      const listing = byWalmartSku.get(line.walmartSku)!
      const affected = await tx.$executeRaw`
        UPDATE inventory SET reserved = reserved + ${line.quantity}
        WHERE variant_id = ${listing.variantId} AND on_hand - reserved >= ${line.quantity}`
      if (affected === 0) {
        throw new ChannelError('insufficient_stock', `not enough stock for walmart sku ${line.walmartSku}`)
      }
    }
    const order = await tx.order.create({
      data: {
        email: canonical.email,
        shipToState: canonical.shipToState,
        status: 'paid',
        channel: 'walmart',
        externalOrderId: canonical.externalOrderId,
        subtotalCents,
        taxCents,
        totalCents: subtotalCents + taxCents,
        taxRateBps: 0,
        taxJurisdiction: 'walmart_facilitator',
        lines: {
          create: canonical.lines.map((l) => {
            const listing = byWalmartSku.get(l.walmartSku)!
            return {
              variantId: listing.variantId,
              sku: listing.variant.sku,
              quantity: l.quantity,
              unitPriceCents: l.unitPriceCents,
              lineSubtotalCents: l.quantity * l.unitPriceCents,
            }
          }),
        },
      },
      select: { id: true },
    })
    await tx.channelEvent.create({
      data: { source, externalId: canonical.externalOrderId, eventType: 'order_created' },
    })
    return order.id
  })

  await recordAudit({
    actorId: (await prisma.actor.findFirstOrThrow({ where: { name: 'system' } })).id,
    action: 'walmart_order_ingested',
    target: orderId,
    after: { externalOrderId: canonical.externalOrderId, source },
  })
  await enqueueJob('walmart_ack_order', { externalOrderId: canonical.externalOrderId }, { dedupeKey: `ack:${canonical.externalOrderId}` })
  return { orderId, created: true }
}
```

(If Plan 2 established a different way to resolve the system actor id — e.g. a `systemActorId()` helper — use that instead of the inline `findFirstOrThrow`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/walmart-orders-ingest.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/channels/walmart/orders.ingest.ts tests/walmart-orders-ingest.test.ts
git commit -m "feat(core): idempotent walmart order ingestion into canonical order spine"
```

---

### Task 6: Webhook endpoint + order poller

**Files:**
- Create: `src/channels/walmart/webhooks.routes.ts`
- Create: `src/channels/walmart/pollers.ts`
- Modify: `src/app.ts` (mount router)
- Test: `tests/walmart-webhooks.test.ts`

**Interfaces:**
- Consumes: `ingestWalmartOrder`, `ChannelError` (Task 5); `WalmartClient` (Task 2); `buildApp` (existing).
- Produces:
  - `walmartWebhookRouter` — `POST /api/v1/channels/walmart/webhooks`. Auth: header `x-webhook-secret` must equal `process.env.WALMART_WEBHOOK_SECRET` → else `401 { error: 'unauthorized' }`. Body `{ eventType: string, payload: unknown }`. `ORDER_CREATED` → `ingestWalmartOrder(payload, 'webhook')`. Unknown eventType → `202 { ignored: true }`. `ChannelError` → `422 { error: code }` (Walmart gets a 4xx; the poller is the retry path). Success → `200 { orderId, created }`.
  - `async function pollWalmartOrders(client?: WalmartClient): Promise<{ found: number; created: number; failed: number }>` — `GET /v3/orders` with `createdStartDate` = 7 days ago (ISO date); for each element of `response.list.elements.order`, run `ingestWalmartOrder(order, 'poll')`; count successes/duplicates/failures; `ChannelError`s are logged (`console.error`) and counted, never thrown.

- [ ] **Step 1: Write the failing test**

```ts
// tests/walmart-webhooks.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seedSystemActor } from './helpers/seed.js'
import { buildApp } from '../src/app.js'
import { pollWalmartOrders } from '../src/channels/walmart/pollers.js'
import { walmartOrderFixture } from './walmart-mappers.test.js'
import type { WalmartClient } from '../src/channels/walmart/client.js'

process.env.WALMART_WEBHOOK_SECRET = 'test-secret'

async function seedListing() {
  const p = await prisma.product.create({ data: { slug: 'castle', name: 'Castle', productType: 'own_designed', status: 'published' } })
  const v = await prisma.variant.create({ data: { productId: p.id, sku: 'IB-SET-001', priceCents: 4999 } })
  await prisma.inventory.create({ data: { variantId: v.id, onHand: 10 } })
  await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'IB-SET-001-W', status: 'live' } })
}

describe('walmart webhook endpoint', () => {
  beforeEach(async () => { await resetDb(); await seedSystemActor(); await seedListing() })

  it('rejects a missing/wrong secret', async () => {
    const res = await request(buildApp()).post('/api/v1/channels/walmart/webhooks').send({ eventType: 'ORDER_CREATED', payload: walmartOrderFixture })
    expect(res.status).toBe(401)
  })

  it('ingests ORDER_CREATED and ignores unknown events', async () => {
    const app = buildApp()
    const ok = await request(app).post('/api/v1/channels/walmart/webhooks')
      .set('x-webhook-secret', 'test-secret')
      .send({ eventType: 'ORDER_CREATED', payload: walmartOrderFixture })
    expect(ok.status).toBe(200)
    expect(ok.body.created).toBe(true)
    const other = await request(app).post('/api/v1/channels/walmart/webhooks')
      .set('x-webhook-secret', 'test-secret')
      .send({ eventType: 'BUYBOX_CHANGED', payload: {} })
    expect(other.status).toBe(202)
    const bad = await request(app).post('/api/v1/channels/walmart/webhooks')
      .set('x-webhook-secret', 'test-secret')
      .send({ eventType: 'ORDER_CREATED', payload: {} })
    expect(bad.status).toBe(422)
  })
})

describe('pollWalmartOrders', () => {
  beforeEach(async () => { await resetDb(); await seedSystemActor(); await seedListing() })

  it('sweeps orders and is idempotent with prior webhook ingestion', async () => {
    const stub: WalmartClient = {
      request: async () => ({ list: { elements: { order: [walmartOrderFixture] } } }),
    }
    const first = await pollWalmartOrders(stub)
    expect(first).toEqual({ found: 1, created: 1, failed: 0 })
    const second = await pollWalmartOrders(stub)
    expect(second).toEqual({ found: 1, created: 0, failed: 0 })
    expect(await prisma.order.count()).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/walmart-webhooks.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// src/channels/walmart/webhooks.routes.ts
import { Router } from 'express'
import { ingestWalmartOrder, ChannelError } from './orders.ingest.js'

export const walmartWebhookRouter = Router()

walmartWebhookRouter.post('/', async (req, res) => {
  if (req.get('x-webhook-secret') !== process.env.WALMART_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  const { eventType, payload } = req.body ?? {}
  try {
    if (eventType === 'ORDER_CREATED') {
      const result = await ingestWalmartOrder(payload, 'webhook')
      return res.status(200).json(result)
    }
    return res.status(202).json({ ignored: true })
  } catch (e) {
    if (e instanceof ChannelError) return res.status(422).json({ error: e.code })
    throw e
  }
})
```

```ts
// src/channels/walmart/pollers.ts
import { type WalmartClient, getWalmartClient } from './client.js'
import { ingestWalmartOrder, ChannelError } from './orders.ingest.js'

export async function pollWalmartOrders(client: WalmartClient = getWalmartClient()): Promise<{ found: number; created: number; failed: number }> {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const res = (await client.request('GET', '/v3/orders', { query: { createdStartDate: since, limit: '100' } })) as any
  const orders: unknown[] = res?.list?.elements?.order ?? []
  let created = 0
  let failed = 0
  for (const o of orders) {
    try {
      const r = await ingestWalmartOrder(o, 'poll')
      if (r.created) created++
    } catch (e) {
      failed++
      if (e instanceof ChannelError) console.error(`walmart poll: ${e.code} — ${e.message}`)
      else throw e
    }
  }
  return { found: orders.length, created, failed }
}
```

In `src/app.ts` add:

```ts
import { walmartWebhookRouter } from './channels/walmart/webhooks.routes.js'
// inside buildApp(), after the catalog router:
app.use('/api/v1/channels/walmart/webhooks', walmartWebhookRouter)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/walmart-webhooks.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/channels/walmart/webhooks.routes.ts src/channels/walmart/pollers.ts src/app.ts tests/walmart-webhooks.test.ts
git commit -m "feat(core): walmart webhook endpoint and order polling reconciler"
```

---

### Task 7: Inventory sync — available-to-sell + push

**Files:**
- Create: `src/channels/walmart/inventory.sync.ts`
- Test: `tests/walmart-inventory-sync.test.ts`

**Interfaces:**
- Consumes: `toInventoryPayload` (Task 3), `enqueueJob`/`registerHandler` (Task 4), `WalmartClient` (Task 2), `ChannelListing` (Task 1).
- Produces:
  - `function computeAvailableToSell(onHand: number, reserved: number, bufferPct?: number | null): number` — pure. `buffer = onHand > 0 ? Math.max(1, Math.ceil(onHand * (bufferPct ?? 10) / 100)) : 0`; result `Math.max(0, onHand - reserved - buffer)`. A `bufferPct` of `0` means no buffer (`buffer = 0` — the `?? ` fallback applies only to `null`/`undefined`).
  - `async function pushInventoryForVariant(variantId: string, client?: WalmartClient): Promise<void>` — looks up listing (+ inventory), computes ATS, `PUT /v3/inventory?sku=<walmartSku>` with `toInventoryPayload`, updates `lastPushedQty`/`lastSyncedAt`. No listing or listing not `live`/`submitted` → no-op.
  - `async function enqueueInventoryPush(variantId: string): Promise<void>` — `enqueueJob('walmart_push_inventory', { variantId }, { dedupeKey: 'inv:' + variantId })`. **Call site:** Plan 2's order service mutates stock on place/fulfill/cancel — add a call to `enqueueInventoryPush(line.variantId)` after each stock mutation commit in `orders.service.ts` (guarded: only when a `channelListing` exists for the variant; a cheap lookup inside `enqueueInventoryPush` itself is fine). Ingestion (Task 5) reserves stock too — add the same call there for each line after the transaction.
  - `async function reconcileAllInventory(client?: WalmartClient): Promise<{ pushed: number }>` — pushes every `live` listing (drift-correction sweep).
  - `function registerInventoryHandlers(client?: WalmartClient): void` — registers `walmart_push_inventory` → `pushInventoryForVariant(payload.variantId, client)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/walmart-inventory-sync.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { computeAvailableToSell, pushInventoryForVariant, reconcileAllInventory } from '../src/channels/walmart/inventory.sync.js'
import type { WalmartClient } from '../src/channels/walmart/client.js'

function recordingClient() {
  const calls: Array<{ method: string; path: string; opts?: any }> = []
  const client: WalmartClient = { request: async (method, path, opts) => { calls.push({ method, path, opts }); return {} } }
  return { client, calls }
}

async function seed(onHand: number, reserved: number, bufferPct?: number) {
  const p = await prisma.product.create({ data: { slug: 's', name: 'S', productType: 'own_designed', status: 'published' } })
  const v = await prisma.variant.create({ data: { productId: p.id, sku: 'IB-9', priceCents: 1000 } })
  await prisma.inventory.create({ data: { variantId: v.id, onHand, reserved } })
  await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'IB-9-W', status: 'live', bufferPct } })
  return v
}

describe('computeAvailableToSell', () => {
  it('applies the default 10%-min-1 buffer', () => {
    expect(computeAvailableToSell(10, 0)).toBe(9)   // buffer ceil(1)=1
    expect(computeAvailableToSell(10, 3)).toBe(6)
    expect(computeAvailableToSell(2, 0)).toBe(1)    // min 1 buffer
    expect(computeAvailableToSell(1, 0)).toBe(0)
    expect(computeAvailableToSell(0, 0)).toBe(0)
    expect(computeAvailableToSell(25, 0)).toBe(22)  // ceil(2.5)=3
  })
  it('honors overrides including 0', () => {
    expect(computeAvailableToSell(10, 0, 20)).toBe(8)
    expect(computeAvailableToSell(10, 0, 0)).toBe(10)
    expect(computeAvailableToSell(5, 6)).toBe(0)    // never negative
  })
})

describe('inventory push', () => {
  beforeEach(resetDb)

  it('pushes ATS for a live listing and records last-pushed state', async () => {
    const v = await seed(10, 2)
    const { client, calls } = recordingClient()
    await pushInventoryForVariant(v.id, client)
    expect(calls).toEqual([{ method: 'PUT', path: '/v3/inventory', opts: { query: { sku: 'IB-9-W' }, body: { sku: 'IB-9-W', quantity: { unit: 'EACH', amount: 7 } } } }])
    const listing = await prisma.channelListing.findFirstOrThrow()
    expect(listing.lastPushedQty).toBe(7)
    expect(listing.lastSyncedAt).not.toBeNull()
  })

  it('is a no-op without a pushable listing', async () => {
    const p = await prisma.product.create({ data: { slug: 'x', name: 'X', productType: 'own_designed' } })
    const v = await prisma.variant.create({ data: { productId: p.id, sku: 'IB-X', priceCents: 100 } })
    const { client, calls } = recordingClient()
    await pushInventoryForVariant(v.id, client)
    expect(calls).toEqual([])
  })

  it('reconcileAllInventory sweeps all live listings', async () => {
    await seed(10, 0)
    const { client, calls } = recordingClient()
    const r = await reconcileAllInventory(client)
    expect(r.pushed).toBe(1)
    expect(calls.length).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/walmart-inventory-sync.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/channels/walmart/inventory.sync.ts
import { prisma } from '../../prisma.js'
import { type WalmartClient, getWalmartClient } from './client.js'
import { toInventoryPayload } from './mappers.js'
import { enqueueJob, registerHandler } from './outbox.js'

export function computeAvailableToSell(onHand: number, reserved: number, bufferPct?: number | null): number {
  const pct = bufferPct ?? 10
  const buffer = onHand > 0 && pct > 0 ? Math.max(1, Math.ceil((onHand * pct) / 100)) : onHand > 0 && pct === 0 ? 0 : 0
  return Math.max(0, onHand - reserved - buffer)
}

const PUSHABLE = ['live', 'submitted'] as const

export async function pushInventoryForVariant(variantId: string, client: WalmartClient = getWalmartClient()): Promise<void> {
  const listing = await prisma.channelListing.findUnique({ where: { variantId }, include: { variant: { include: { inventory: true } } } })
  if (!listing || !PUSHABLE.includes(listing.status as any)) return
  const inv = listing.variant.inventory
  const qty = computeAvailableToSell(inv?.onHand ?? 0, inv?.reserved ?? 0, listing.bufferPct)
  await client.request('PUT', '/v3/inventory', { query: { sku: listing.walmartSku }, body: toInventoryPayload(listing.walmartSku, qty) })
  await prisma.channelListing.update({ where: { id: listing.id }, data: { lastPushedQty: qty, lastSyncedAt: new Date() } })
}

export async function enqueueInventoryPush(variantId: string): Promise<void> {
  const listed = await prisma.channelListing.count({ where: { variantId } })
  if (listed === 0) return
  await enqueueJob('walmart_push_inventory', { variantId }, { dedupeKey: `inv:${variantId}` })
}

export async function reconcileAllInventory(client: WalmartClient = getWalmartClient()): Promise<{ pushed: number }> {
  const listings = await prisma.channelListing.findMany({ where: { status: 'live' }, select: { variantId: true } })
  for (const l of listings) await pushInventoryForVariant(l.variantId, client)
  return { pushed: listings.length }
}

export function registerInventoryHandlers(client: WalmartClient = getWalmartClient()): void {
  registerHandler('walmart_push_inventory', (p) => pushInventoryForVariant(p.variantId, client))
}
```

Simplify the buffer line if the reviewer prefers: `const buffer = onHand > 0 && pct > 0 ? Math.max(1, Math.ceil((onHand * pct) / 100)) : 0`.

Then wire the call sites:
- In `src/orders/orders.service.ts`: after the transaction in `placeOrder`, `fulfillOrder`, and `cancelOrder`, add `for (const line of <order lines>) await enqueueInventoryPush(line.variantId)` (import from `../channels/walmart/inventory.sync.js`). The dedupeKey makes bursts collapse; a `done` job does not block a fresh enqueue because dedupe only guards `pending` — **to get that behavior, extend `enqueueJob`'s catch**: on `P2002`, if the existing job with that dedupeKey is NOT `pending`, clear its `dedupeKey` and retry the create once. Add this to `outbox.ts` now, with a test in `tests/walmart-outbox.test.ts`:

```ts
  it('allows re-enqueue after a deduped job completes', async () => {
    registerHandler('t', async () => {})
    await enqueueJob('t', {}, { dedupeKey: 'k2' })
    await processDueJobs()
    expect(await enqueueJob('t', {}, { dedupeKey: 'k2' })).not.toBeNull()
  })
```

```ts
// outbox.ts — replace the catch block in enqueueJob:
  } catch (e: any) {
    if (e?.code !== 'P2002') throw e
    if (!opts.dedupeKey) throw e
    const existing = await prisma.channelJob.findUnique({ where: { dedupeKey: opts.dedupeKey } })
    if (existing && existing.status !== 'pending') {
      await prisma.channelJob.update({ where: { id: existing.id }, data: { dedupeKey: null } })
      return enqueueJob(type, payload, opts)
    }
    return null
  }
```

- In `src/channels/walmart/orders.ingest.ts`: after the transaction + audit, add `for (const l of canonical.lines) await enqueueInventoryPush(byWalmartSku.get(l.walmartSku)!.variantId)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/walmart-inventory-sync.test.ts tests/walmart-outbox.test.ts tests/walmart-orders-ingest.test.ts`
Expected: PASS. Also run Plan 2's order tests to confirm the call-site edits didn't break them: `npx vitest run tests/orders-service.test.ts tests/orders-transitions.test.ts` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/walmart/inventory.sync.ts src/channels/walmart/outbox.ts src/channels/walmart/orders.ingest.ts src/orders/orders.service.ts tests
git commit -m "feat(core): walmart inventory sync with safety buffer and stock-change triggers"
```

---

### Task 8: Listings — item feed submission + status tracking

**Files:**
- Create: `src/channels/walmart/listings.service.ts`
- Test: `tests/walmart-listings.test.ts`

**Interfaces:**
- Consumes: `toItemFeed` (Task 3), `WalmartClient` (Task 2), `ChannelListing`/`ChannelFeed` (Task 1), `prisma`.
- Produces:
  - `async function createListing(variantId: string, walmartSku: string, opts?: { bufferPct?: number; priceOverrideCents?: number }): Promise<{ id: string }>` — variant's product must be `published`, else `ChannelError('not_published')` (import from Task 5). Creates `ChannelListing` in `draft`.
  - `async function submitItemFeed(listingIds: string[], client?: WalmartClient): Promise<{ feedId: string }>` — builds `toItemFeed` from listings' variant+product data (name, description, price = `priceOverrideCents ?? variant.priceCents`, image URLs from `product.images` Json array of `{ url }` or plain strings — handle both), `POST /v3/feeds?feedType=MP_ITEM`, response `{ feedId }`; records `ChannelFeed(type: 'item', status: 'submitted')`; sets listings to `submitted`.
  - `async function checkFeedStatus(feedId: string, client?: WalmartClient): Promise<'submitted' | 'processed' | 'error'>` — `GET /v3/feeds/{feedId}?includeDetails=true`; Walmart `feedStatus` `PROCESSED` → feed `processed` + all its listings `live`; `ERROR` → feed `error` with `errors` = Walmart's `itemDetails`, listings → `rejected`; anything else stays `submitted`. Feed→listing linkage: store the listing ids in the feed's `errors` Json? No — add a `listingIds Json @default("[]")` column to `ChannelFeed` in this task (schema micro-migration `walmart_feed_listing_ids`), written by `submitItemFeed`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/walmart-listings.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createListing, submitItemFeed, checkFeedStatus } from '../src/channels/walmart/listings.service.js'
import type { WalmartClient } from '../src/channels/walmart/client.js'

async function seedVariant(status: 'draft' | 'published' = 'published') {
  const p = await prisma.product.create({ data: { slug: 's' + status, name: 'Castle', description: 'A castle set', status, productType: 'own_designed', images: [{ url: 'https://img/1.jpg' }] } })
  return prisma.variant.create({ data: { productId: p.id, sku: 'IB-C', priceCents: 4999 } })
}

describe('walmart listings', () => {
  beforeEach(resetDb)

  it('creates a draft listing for a published product only', async () => {
    const v = await seedVariant()
    const l = await createListing(v.id, 'IB-C-W')
    expect((await prisma.channelListing.findUniqueOrThrow({ where: { id: l.id } })).status).toBe('draft')
    const vDraft = await seedVariant('draft')
    await expect(createListing(vDraft.id, 'IB-D-W')).rejects.toMatchObject({ code: 'not_published' })
  })

  it('submits an item feed and tracks status to live', async () => {
    const v = await seedVariant()
    const l = await createListing(v.id, 'IB-C-W')
    const calls: any[] = []
    const client: WalmartClient = {
      request: async (method, path) => {
        calls.push({ method, path })
        if (path.startsWith('/v3/feeds') && method === 'POST') return { feedId: 'FEED-1' }
        return { feedStatus: 'PROCESSED' }
      },
    }
    const { feedId } = await submitItemFeed([l.id], client)
    expect(feedId).toBe('FEED-1')
    expect((await prisma.channelListing.findUniqueOrThrow({ where: { id: l.id } })).status).toBe('submitted')
    expect(await checkFeedStatus('FEED-1', client)).toBe('processed')
    expect((await prisma.channelListing.findUniqueOrThrow({ where: { id: l.id } })).status).toBe('live')
    expect((await prisma.channelFeed.findUniqueOrThrow({ where: { feedId: 'FEED-1' } })).status).toBe('processed')
  })

  it('marks listings rejected on feed error and stores walmart errors', async () => {
    const v = await seedVariant()
    const l = await createListing(v.id, 'IB-C-W')
    const client: WalmartClient = {
      request: async (method, path) =>
        method === 'POST' ? { feedId: 'FEED-2' } : { feedStatus: 'ERROR', itemDetails: { itemIngestionStatus: [{ sku: 'IB-C-W', ingestionErrors: { ingestionError: [{ description: 'missing attribute' }] } }] } },
    }
    await submitItemFeed([l.id], client)
    expect(await checkFeedStatus('FEED-2', client)).toBe('error')
    expect((await prisma.channelListing.findUniqueOrThrow({ where: { id: l.id } })).status).toBe('rejected')
    const feed = await prisma.channelFeed.findUniqueOrThrow({ where: { feedId: 'FEED-2' } })
    expect(JSON.stringify(feed.errors)).toContain('missing attribute')
  })
})
```

- [ ] **Step 2: Add `listingIds` to ChannelFeed + migrate**

Add to `ChannelFeed` model: `listingIds Json @default("[]") @map("listing_ids")`.
Run: `npx prisma migrate dev --name walmart_feed_listing_ids`
Then run the test — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/channels/walmart/listings.service.ts
import { prisma } from '../../prisma.js'
import { type WalmartClient, getWalmartClient } from './client.js'
import { toItemFeed } from './mappers.js'
import { ChannelError } from './orders.ingest.js'

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

function imageUrls(images: unknown): string[] {
  if (!Array.isArray(images)) return []
  return images.map((i: any) => (typeof i === 'string' ? i : i?.url)).filter(Boolean)
}

export async function submitItemFeed(listingIds: string[], client: WalmartClient = getWalmartClient()): Promise<{ feedId: string }> {
  const listings = await prisma.channelListing.findMany({
    where: { id: { in: listingIds } },
    include: { variant: { include: { product: true } } },
  })
  const feedBody = toItemFeed(listings.map((l) => ({
    walmartSku: l.walmartSku,
    name: l.variant.product.name,
    description: l.variant.product.description,
    priceCents: l.priceOverrideCents ?? l.variant.priceCents,
    imageUrls: imageUrls(l.variant.product.images),
  })))
  const res = (await client.request('POST', '/v3/feeds', { query: { feedType: 'MP_ITEM' }, body: feedBody })) as { feedId: string }
  await prisma.channelFeed.create({ data: { feedId: res.feedId, type: 'item', listingIds } })
  await prisma.channelListing.updateMany({ where: { id: { in: listingIds } }, data: { status: 'submitted' } })
  return { feedId: res.feedId }
}

export async function checkFeedStatus(feedId: string, client: WalmartClient = getWalmartClient()): Promise<'submitted' | 'processed' | 'error'> {
  const res = (await client.request('GET', `/v3/feeds/${feedId}`, { query: { includeDetails: 'true' } })) as any
  const feed = await prisma.channelFeed.findUniqueOrThrow({ where: { feedId } })
  const ids = (feed.listingIds as string[]) ?? []
  if (res.feedStatus === 'PROCESSED') {
    await prisma.channelFeed.update({ where: { feedId }, data: { status: 'processed' } })
    await prisma.channelListing.updateMany({ where: { id: { in: ids } }, data: { status: 'live' } })
    return 'processed'
  }
  if (res.feedStatus === 'ERROR') {
    await prisma.channelFeed.update({ where: { feedId }, data: { status: 'error', errors: res.itemDetails ?? res } })
    await prisma.channelListing.updateMany({ where: { id: { in: ids } }, data: { status: 'rejected' } })
    return 'error'
  }
  return 'submitted'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/walmart-listings.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add prisma src/channels/walmart/listings.service.ts tests/walmart-listings.test.ts
git commit -m "feat(core): walmart listing lifecycle with MP_ITEM feed submission and status tracking"
```

---

### Task 9: Price push

**Files:**
- Create: `src/channels/walmart/price.sync.ts`
- Test: `tests/walmart-price-sync.test.ts`

**Interfaces:**
- Consumes: `toPricePayload` (Task 3), outbox (Task 4), client (Task 2).
- Produces:
  - `async function pushPriceForVariant(variantId: string, client?: WalmartClient): Promise<void>` — pushable listing (`live`/`submitted`) required, else no-op; price = `priceOverrideCents ?? variant.priceCents`; `PUT /v3/price` with `toPricePayload`; update `lastPushedPriceCents`.
  - `async function enqueuePricePush(variantId: string): Promise<void>` — no-op if unlisted; `enqueueJob('walmart_push_price', { variantId }, { dedupeKey: 'price:' + variantId })`.
  - `function registerPriceHandlers(client?: WalmartClient): void`
  - **Call site:** in `src/catalog/catalog.service.ts`, wherever a variant's `priceCents` is updated (the admin update path), call `enqueuePricePush(variantId)` after the write. If catalog has no variant-price-update path yet, skip the call site and note it in the commit message — the function still gets exercised by the reconcile in Task 12.

- [ ] **Step 1: Write the failing test**

```ts
// tests/walmart-price-sync.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { pushPriceForVariant } from '../src/channels/walmart/price.sync.js'
import type { WalmartClient } from '../src/channels/walmart/client.js'

describe('walmart price push', () => {
  beforeEach(resetDb)

  it('pushes the override price when set, else the catalog price', async () => {
    const p = await prisma.product.create({ data: { slug: 's', name: 'S', productType: 'own_designed', status: 'published' } })
    const v = await prisma.variant.create({ data: { productId: p.id, sku: 'IB-1', priceCents: 4999 } })
    const listing = await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'IB-1-W', status: 'live' } })
    const calls: any[] = []
    const client: WalmartClient = { request: async (m, path, opts) => { calls.push({ m, path, opts }); return {} } }

    await pushPriceForVariant(v.id, client)
    expect(calls[0].opts.body.pricing[0].currentPrice.amount).toBe(49.99)

    await prisma.channelListing.update({ where: { id: listing.id }, data: { priceOverrideCents: 5499 } })
    await pushPriceForVariant(v.id, client)
    expect(calls[1].opts.body.pricing[0].currentPrice.amount).toBe(54.99)
    expect((await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).lastPushedPriceCents).toBe(5499)
  })

  it('no-ops without a pushable listing', async () => {
    const p = await prisma.product.create({ data: { slug: 'x', name: 'X', productType: 'own_designed' } })
    const v = await prisma.variant.create({ data: { productId: p.id, sku: 'IB-2', priceCents: 100 } })
    const calls: any[] = []
    const client: WalmartClient = { request: async (m, path) => { calls.push(path); return {} } }
    await pushPriceForVariant(v.id, client)
    expect(calls).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/walmart-price-sync.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/channels/walmart/price.sync.ts
import { prisma } from '../../prisma.js'
import { type WalmartClient, getWalmartClient } from './client.js'
import { toPricePayload } from './mappers.js'
import { enqueueJob, registerHandler } from './outbox.js'

const PUSHABLE = ['live', 'submitted']

export async function pushPriceForVariant(variantId: string, client: WalmartClient = getWalmartClient()): Promise<void> {
  const listing = await prisma.channelListing.findUnique({ where: { variantId }, include: { variant: true } })
  if (!listing || !PUSHABLE.includes(listing.status)) return
  const priceCents = listing.priceOverrideCents ?? listing.variant.priceCents
  await client.request('PUT', '/v3/price', { body: toPricePayload(listing.walmartSku, priceCents) })
  await prisma.channelListing.update({ where: { id: listing.id }, data: { lastPushedPriceCents: priceCents, lastSyncedAt: new Date() } })
}

export async function enqueuePricePush(variantId: string): Promise<void> {
  if ((await prisma.channelListing.count({ where: { variantId } })) === 0) return
  await enqueueJob('walmart_push_price', { variantId }, { dedupeKey: `price:${variantId}` })
}

export function registerPriceHandlers(client: WalmartClient = getWalmartClient()): void {
  registerHandler('walmart_push_price', (p) => pushPriceForVariant(p.variantId, client))
}
```

Add the catalog call site if a variant-price-update path exists (see Interfaces above).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/walmart-price-sync.test.ts` — PASS. If a catalog call site was added, also run `npx vitest run tests/catalog.test.ts` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/walmart/price.sync.ts tests/walmart-price-sync.test.ts src/catalog
git commit -m "feat(core): walmart price push with per-listing override"
```

---

### Task 10: Order acknowledgement + shipment push + cancels

**Files:**
- Create: `src/channels/walmart/shipping.ts`
- Test: `tests/walmart-shipping.test.ts`

**Interfaces:**
- Consumes: `fulfillOrder`, `cancelOrder`, `OrderError` (Plan 2), `toShipPayload` (Task 3), outbox (Task 4), client (Task 2), `ChannelError` (Task 5).
- Produces:
  - `function registerShippingHandlers(client?: WalmartClient): void` — registers:
    - `walmart_ack_order` → `POST /v3/orders/{externalOrderId}/acknowledge` (empty body).
    - `walmart_ship_order` → payload `{ orderId, carrier, trackingNumber, trackingUrl? }`; loads the order + lines; `POST /v3/orders/{externalOrderId}/shipping` with `toShipPayload` (lineNumbers = `['1','2',...]` by line position — Walmart line numbers are 1-based strings in original order; store nothing extra: map our i-th order line to lineNumber `String(i+1)`; quantityByLine from our line quantities; shipDateIso = now ISO).
  - `async function recordChannelShipment(orderId: string, input: { carrier: string; trackingNumber: string; trackingUrl?: string }): Promise<void>` — order must be `channel: 'walmart'` and `status: 'paid'` else `ChannelError('not_shippable')`; calls Plan 2's `fulfillOrder(orderId)` (decrements stock + audit), then enqueues `walmart_ship_order` (dedupeKey `ship:<orderId>`).
  - `async function cancelChannelOrder(orderId: string): Promise<void>` — seller-initiated cancel: `cancelOrder(orderId)` then enqueue `walmart_cancel_order` (`POST /v3/orders/{externalOrderId}/cancel` with `{ orderCancellation: { orderLines: ... } }` built like ship payload but status `Cancelled`) — register handler too. Walmart-initiated cancels arrive via poller as order status; v1 handles them manually (documented), only seller-initiated is coded.

- [ ] **Step 1: Write the failing test**

```ts
// tests/walmart-shipping.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seedSystemActor } from './helpers/seed.js'
import { ingestWalmartOrder } from '../src/channels/walmart/orders.ingest.js'
import { recordChannelShipment, registerShippingHandlers } from '../src/channels/walmart/shipping.js'
import { processDueJobs, clearHandlers } from '../src/channels/walmart/outbox.js'
import { walmartOrderFixture } from './walmart-mappers.test.js'
import type { WalmartClient } from '../src/channels/walmart/client.js'

async function seedAndIngest() {
  const p = await prisma.product.create({ data: { slug: 'castle', name: 'Castle', productType: 'own_designed', status: 'published' } })
  const v = await prisma.variant.create({ data: { productId: p.id, sku: 'IB-SET-001', priceCents: 4999 } })
  await prisma.inventory.create({ data: { variantId: v.id, onHand: 10 } })
  await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'IB-SET-001-W', status: 'live' } })
  const { orderId } = await ingestWalmartOrder(walmartOrderFixture, 'poll')
  return { orderId: orderId!, variantId: v.id }
}

describe('walmart shipping', () => {
  beforeEach(async () => { await resetDb(); await seedSystemActor(); clearHandlers() })

  it('fulfills the canonical order and pushes ack + shipment', async () => {
    const { orderId, variantId } = await seedAndIngest()
    const calls: any[] = []
    const client: WalmartClient = { request: async (m, path, opts) => { calls.push({ m, path, opts }); return {} } }
    registerShippingHandlers(client)

    await recordChannelShipment(orderId, { carrier: 'USPS', trackingNumber: 'T-1' })
    await processDueJobs()

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('fulfilled')
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { variantId } })
    expect(inv).toMatchObject({ onHand: 8, reserved: 0 })
    const paths = calls.map((c) => c.path)
    expect(paths).toContain('/v3/orders/PO-1001/acknowledge')
    expect(paths).toContain('/v3/orders/PO-1001/shipping')
    const ship = calls.find((c) => c.path.endsWith('/shipping'))
    expect(ship.opts.body.orderShipment.orderLines.orderLine[0].orderLineStatuses.orderLineStatus[0].trackingInfo.trackingNumber).toBe('T-1')
  })

  it('refuses to ship a non-walmart or non-paid order', async () => {
    const { orderId } = await seedAndIngest()
    registerShippingHandlers({ request: async () => ({}) })
    await recordChannelShipment(orderId, { carrier: 'USPS', trackingNumber: 'T-1' })
    await expect(recordChannelShipment(orderId, { carrier: 'USPS', trackingNumber: 'T-2' }))
      .rejects.toMatchObject({ code: 'not_shippable' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/walmart-shipping.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/channels/walmart/shipping.ts
import { prisma } from '../../prisma.js'
import { fulfillOrder, cancelOrder } from '../../orders/orders.service.js'
import { type WalmartClient, getWalmartClient } from './client.js'
import { toShipPayload } from './mappers.js'
import { enqueueJob, registerHandler } from './outbox.js'
import { ChannelError } from './orders.ingest.js'

export async function recordChannelShipment(
  orderId: string,
  input: { carrier: string; trackingNumber: string; trackingUrl?: string },
): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } })
  if (!order || order.channel !== 'walmart' || order.status !== 'paid') {
    throw new ChannelError('not_shippable', `order ${orderId} is not a paid walmart order`)
  }
  await fulfillOrder(orderId)
  await enqueueJob('walmart_ship_order', { orderId, ...input }, { dedupeKey: `ship:${orderId}` })
}

export async function cancelChannelOrder(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } })
  if (!order || order.channel !== 'walmart') throw new ChannelError('not_walmart', `order ${orderId} is not a walmart order`)
  await cancelOrder(orderId)
  await enqueueJob('walmart_cancel_order', { orderId }, { dedupeKey: `cancel:${orderId}` })
}

export function registerShippingHandlers(client: WalmartClient = getWalmartClient()): void {
  registerHandler('walmart_ack_order', async (p) => {
    await client.request('POST', `/v3/orders/${p.externalOrderId}/acknowledge`)
  })
  registerHandler('walmart_ship_order', async (p) => {
    const order = await prisma.order.findUniqueOrThrow({ where: { id: p.orderId }, include: { lines: true } })
    const lineNumbers = order.lines.map((_, i) => String(i + 1))
    const quantityByLine = Object.fromEntries(order.lines.map((l, i) => [String(i + 1), l.quantity]))
    await client.request('POST', `/v3/orders/${order.externalOrderId}/shipping`, {
      body: toShipPayload({
        lineNumbers,
        quantityByLine,
        carrier: p.carrier,
        trackingNumber: p.trackingNumber,
        trackingUrl: p.trackingUrl,
        shipDateIso: new Date().toISOString(),
      }),
    })
  })
  registerHandler('walmart_cancel_order', async (p) => {
    const order = await prisma.order.findUniqueOrThrow({ where: { id: p.orderId }, include: { lines: true } })
    await client.request('POST', `/v3/orders/${order.externalOrderId}/cancel`, {
      body: {
        orderCancellation: {
          orderLines: {
            orderLine: order.lines.map((l, i) => ({
              lineNumber: String(i + 1),
              orderLineStatuses: { orderLineStatus: [{ status: 'Cancelled', cancellationReason: 'SELLER_CANCEL', statusQuantity: { unitOfMeasurement: 'EACH', amount: String(l.quantity) } }] },
            })),
          },
        },
      },
    })
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/walmart-shipping.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/channels/walmart/shipping.ts tests/walmart-shipping.test.ts
git commit -m "feat(core): walmart order ack, shipment push, and seller cancel"
```

---

### Task 11: Returns + refunds

**Files:**
- Create: `src/channels/walmart/returns.service.ts`
- Modify: `src/channels/walmart/pollers.ts` (add `pollWalmartReturns`)
- Test: `tests/walmart-returns.test.ts`

**Interfaces:**
- Consumes: `ChannelEvent` idempotency (Task 1), client (Task 2), `recordAudit`, prisma; order created by Task 5.
- Produces:
  - `async function ingestWalmartReturn(payload: unknown, source: 'webhook' | 'poll'): Promise<{ created: boolean }>` — payload shape (Returns API): `{ returnOrderId: string, customerOrderInfo: { purchaseOrderId? }, purchaseOrderId?, returnLineGroups?, refundedAmount?: { amount } }`; idempotency key `(returnOrderId, 'return_created')`; looks up our order by `externalOrderId = purchaseOrderId` (from either location); records `ChannelEvent` + `recordAudit({ action: 'walmart_return_ingested', target: <orderId or returnOrderId> })`. If Walmart already refunded (`refundedAmount` present) and the order is `fulfilled`, transition it: `markOrderRefunded(orderId)`.
  - `async function markOrderRefunded(orderId: string, actorId?: string): Promise<void>` — `fulfilled → refunded` (uses the `refunded` enum value from Task 1); other statuses → `ChannelError('invalid_transition')`; audit row `walmart_order_refunded`. No inventory change (returned goods are inspected before restock — restocking is a manual admin action, out of v1 scope).
  - `async function issueWalmartRefund(returnOrderId: string, client?: WalmartClient): Promise<void>` — operator-triggered: `POST /v3/returns/{returnOrderId}/refund` with empty body `{}` (full refund of the return lines as Walmart computed them).
  - In `pollers.ts`: `async function pollWalmartReturns(client?: WalmartClient): Promise<{ found: number; created: number }>` — `GET /v3/returns` with `returnCreationStartDate` = 30 days ago; iterate `res.returnOrders ?? []`, `ingestWalmartReturn(r, 'poll')`, count.

- [ ] **Step 1: Write the failing test**

```ts
// tests/walmart-returns.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seedSystemActor } from './helpers/seed.js'
import { ingestWalmartOrder } from '../src/channels/walmart/orders.ingest.js'
import { recordChannelShipment, registerShippingHandlers } from '../src/channels/walmart/shipping.js'
import { ingestWalmartReturn, markOrderRefunded, issueWalmartRefund } from '../src/channels/walmart/returns.service.js'
import { pollWalmartReturns } from '../src/channels/walmart/pollers.js'
import { clearHandlers } from '../src/channels/walmart/outbox.js'
import { walmartOrderFixture } from './walmart-mappers.test.js'
import type { WalmartClient } from '../src/channels/walmart/client.js'

const returnFixture = {
  returnOrderId: 'RO-1',
  customerOrderInfo: { purchaseOrderId: 'PO-1001' },
  refundedAmount: { currency: 'USD', amount: 105.98 },
}

async function seedFulfilledOrder() {
  const p = await prisma.product.create({ data: { slug: 'castle', name: 'Castle', productType: 'own_designed', status: 'published' } })
  const v = await prisma.variant.create({ data: { productId: p.id, sku: 'IB-SET-001', priceCents: 4999 } })
  await prisma.inventory.create({ data: { variantId: v.id, onHand: 10 } })
  await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'IB-SET-001-W', status: 'live' } })
  const { orderId } = await ingestWalmartOrder(walmartOrderFixture, 'poll')
  registerShippingHandlers({ request: async () => ({}) })
  await recordChannelShipment(orderId!, { carrier: 'USPS', trackingNumber: 'T-1' })
  return orderId!
}

describe('walmart returns', () => {
  beforeEach(async () => { await resetDb(); await seedSystemActor(); clearHandlers() })

  it('ingests a refunded return idempotently and marks the order refunded', async () => {
    const orderId = await seedFulfilledOrder()
    const r1 = await ingestWalmartReturn(returnFixture, 'webhook')
    expect(r1.created).toBe(true)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('refunded')
    const r2 = await ingestWalmartReturn(returnFixture, 'poll')
    expect(r2.created).toBe(false)
    expect(await prisma.auditLog.count({ where: { action: 'walmart_order_refunded' } })).toBe(1)
  })

  it('rejects invalid refund transitions', async () => {
    const orderId = await seedFulfilledOrder()
    await markOrderRefunded(orderId).catch(() => {}) // idempotence check below is about status
    await expect(markOrderRefunded(orderId)).rejects.toMatchObject({ code: 'invalid_transition' })
  })

  it('issues a refund via the client and polls returns', async () => {
    await seedFulfilledOrder()
    const calls: any[] = []
    const client: WalmartClient = { request: async (m, path) => { calls.push({ m, path }); return { returnOrders: [returnFixture] } } }
    await issueWalmartRefund('RO-1', client)
    expect(calls[0]).toEqual({ m: 'POST', path: '/v3/returns/RO-1/refund' })
    const polled = await pollWalmartReturns(client)
    expect(polled.found).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/walmart-returns.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/channels/walmart/returns.service.ts
import { prisma } from '../../prisma.js'
import { recordAudit } from '../../audit.js'
import { type WalmartClient, getWalmartClient } from './client.js'
import { ChannelError } from './orders.ingest.js'

async function systemActorId(): Promise<string> {
  return (await prisma.actor.findFirstOrThrow({ where: { name: 'system' } })).id
}

export async function markOrderRefunded(orderId: string, actorId?: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } })
  if (!order) throw new ChannelError('order_not_found', `no order ${orderId}`)
  if (order.status !== 'fulfilled') {
    throw new ChannelError('invalid_transition', `cannot refund a ${order.status} order`)
  }
  await prisma.order.update({ where: { id: orderId }, data: { status: 'refunded' } })
  await recordAudit({
    actorId: actorId ?? (await systemActorId()),
    action: 'walmart_order_refunded',
    target: orderId,
    before: { status: order.status },
    after: { status: 'refunded' },
  })
}

export async function ingestWalmartReturn(payload: unknown, source: 'webhook' | 'poll'): Promise<{ created: boolean }> {
  const p = payload as any
  const returnOrderId: string | undefined = p?.returnOrderId
  if (!returnOrderId) throw new ChannelError('unmappable_return', 'missing returnOrderId')
  const purchaseOrderId: string | undefined = p?.customerOrderInfo?.purchaseOrderId ?? p?.purchaseOrderId

  const existing = await prisma.channelEvent.findUnique({
    where: { externalId_eventType: { externalId: returnOrderId, eventType: 'return_created' } },
  })
  if (existing) return { created: false }

  const order = purchaseOrderId
    ? await prisma.order.findUnique({ where: { externalOrderId: purchaseOrderId } })
    : null

  await prisma.channelEvent.create({ data: { source, externalId: returnOrderId, eventType: 'return_created' } })
  await recordAudit({
    actorId: await systemActorId(),
    action: 'walmart_return_ingested',
    target: order?.id ?? returnOrderId,
    after: { returnOrderId, purchaseOrderId, source },
  })
  if (order && order.status === 'fulfilled' && p?.refundedAmount) {
    await markOrderRefunded(order.id)
  }
  return { created: true }
}

export async function issueWalmartRefund(returnOrderId: string, client: WalmartClient = getWalmartClient()): Promise<void> {
  await client.request('POST', `/v3/returns/${returnOrderId}/refund`, { body: {} })
}
```

Append to `src/channels/walmart/pollers.ts`:

```ts
import { ingestWalmartReturn } from './returns.service.js'

export async function pollWalmartReturns(client: WalmartClient = getWalmartClient()): Promise<{ found: number; created: number }> {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const res = (await client.request('GET', '/v3/returns', { query: { returnCreationStartDate: since, limit: '100' } })) as any
  const returns: unknown[] = res?.returnOrders ?? []
  let created = 0
  for (const r of returns) {
    const result = await ingestWalmartReturn(r, 'poll').catch((e) => { console.error(`walmart returns poll: ${e.message}`); return { created: false } })
    if (result.created) created++
  }
  return { found: returns.length, created }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/walmart-returns.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/channels/walmart/returns.service.ts src/channels/walmart/pollers.ts tests/walmart-returns.test.ts
git commit -m "feat(core): walmart returns ingestion, refund transition, and refund issuance"
```

---

### Task 12: Settlement import + matching

**Files:**
- Create: `src/channels/walmart/settlement.ts`
- Test: `tests/walmart-settlement.test.ts`

**Interfaces:**
- Consumes: `ChannelSettlement` (Task 1), client (Task 2), `toCents` (Task 3).
- Produces:
  - `interface SettlementRow { externalOrderId: string; amountCents: number; feeCents: number; currency: string; raw: Record<string, string> }`
  - `function parseSettlementCsv(csv: string): SettlementRow[]` — pure. Header row + comma-separated lines; required columns `Purchase Order #`, `Amount`, `Commission Amount`, `Currency` (extra columns preserved into `raw`); dollar amounts → cents via `toCents(Number(x))`; rows missing a PO are skipped.
  - `async function importSettlementRows(reportDate: Date, rows: SettlementRow[]): Promise<{ imported: number; matched: number; unmatched: number }>` — for each row, create `ChannelSettlement`; if an order with that `externalOrderId` exists, set `orderId` + `status: 'matched'`, else `unmatched`. Duplicate protection: skip a row if a `ChannelSettlement` with same `externalOrderId` + `reportDate` + `amountCents` already exists.
  - `async function fetchAndImportSettlement(reportDate: Date, client?: WalmartClient): Promise<{ imported: number; matched: number; unmatched: number }>` — `GET /v3/report/reconreport/reconFile` with query `{ reportDate: YYYY-MM-DD }`; if response is a string, treat as CSV; if it's `{ csv: string }` use that. (Actual sandbox response format — possibly zipped — is verified in Task 13; any correction lands here and in the client only.)

- [ ] **Step 1: Write the failing test**

```ts
// tests/walmart-settlement.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { parseSettlementCsv, importSettlementRows } from '../src/channels/walmart/settlement.js'

const csv = [
  'Purchase Order #,Amount,Commission Amount,Currency,Transaction Type',
  'PO-1001,105.98,-15.90,USD,PaymentWithdrawn',
  'PO-9999,49.99,-7.50,USD,PaymentWithdrawn',
  ',0.00,0.00,USD,Adjustment',
].join('\n')

describe('walmart settlement', () => {
  beforeEach(resetDb)

  it('parses csv rows to cents and skips rows without a PO', () => {
    const rows = parseSettlementCsv(csv)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ externalOrderId: 'PO-1001', amountCents: 10598, feeCents: -1590, currency: 'USD' })
    expect(rows[0].raw['Transaction Type']).toBe('PaymentWithdrawn')
  })

  it('imports rows and matches them to orders by external id', async () => {
    await prisma.order.create({
      data: {
        email: 'w@c.l', shipToState: 'MI', status: 'fulfilled', channel: 'walmart', externalOrderId: 'PO-1001',
        subtotalCents: 9998, taxCents: 600, totalCents: 10598, taxRateBps: 0, taxJurisdiction: 'walmart_facilitator',
      },
    })
    const rows = parseSettlementCsv(csv)
    const date = new Date('2026-08-01')
    const r = await importSettlementRows(date, rows)
    expect(r).toEqual({ imported: 2, matched: 1, unmatched: 1 })
    const again = await importSettlementRows(date, rows)
    expect(again.imported).toBe(0) // duplicate rows skipped
    const matched = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-1001' } })
    expect(matched.status).toBe('matched')
    expect(matched.orderId).not.toBeNull()
    const unmatched = await prisma.channelSettlement.findFirstOrThrow({ where: { externalOrderId: 'PO-9999' } })
    expect(unmatched.status).toBe('unmatched') // the review-queue surface
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/walmart-settlement.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/channels/walmart/settlement.ts
import { prisma } from '../../prisma.js'
import { type WalmartClient, getWalmartClient } from './client.js'
import { toCents } from './mappers.js'

export interface SettlementRow {
  externalOrderId: string
  amountCents: number
  feeCents: number
  currency: string
  raw: Record<string, string>
}

export function parseSettlementCsv(csv: string): SettlementRow[] {
  const [headerLine, ...lines] = csv.trim().split(/\r?\n/)
  const headers = headerLine.split(',').map((h) => h.trim())
  const rows: SettlementRow[] = []
  for (const line of lines) {
    const cells = line.split(',')
    const raw = Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? '').trim()]))
    const po = raw['Purchase Order #']
    if (!po) continue
    rows.push({
      externalOrderId: po,
      amountCents: toCents(Number(raw['Amount'] || 0)),
      feeCents: toCents(Number(raw['Commission Amount'] || 0)),
      currency: raw['Currency'] || 'USD',
      raw,
    })
  }
  return rows
}

export async function importSettlementRows(
  reportDate: Date,
  rows: SettlementRow[],
): Promise<{ imported: number; matched: number; unmatched: number }> {
  let imported = 0
  let matched = 0
  let unmatched = 0
  for (const row of rows) {
    const dupe = await prisma.channelSettlement.findFirst({
      where: { externalOrderId: row.externalOrderId, reportDate, amountCents: row.amountCents },
    })
    if (dupe) continue
    const order = await prisma.order.findUnique({ where: { externalOrderId: row.externalOrderId }, select: { id: true } })
    await prisma.channelSettlement.create({
      data: {
        reportDate,
        externalOrderId: row.externalOrderId,
        amountCents: row.amountCents,
        feeCents: row.feeCents,
        currency: row.currency,
        orderId: order?.id,
        status: order ? 'matched' : 'unmatched',
        raw: row.raw,
      },
    })
    imported++
    if (order) matched++
    else unmatched++
  }
  return { imported, matched, unmatched }
}

export async function fetchAndImportSettlement(
  reportDate: Date,
  client: WalmartClient = getWalmartClient(),
): Promise<{ imported: number; matched: number; unmatched: number }> {
  const res = await client.request('GET', '/v3/report/reconreport/reconFile', {
    query: { reportDate: reportDate.toISOString().slice(0, 10) },
  })
  const csv = typeof res === 'string' ? res : (res as any)?.csv
  if (typeof csv !== 'string') throw new Error('walmart settlement: unexpected report response shape')
  return importSettlementRows(reportDate, parseSettlementCsv(csv))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/walmart-settlement.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/channels/walmart/settlement.ts tests/walmart-settlement.test.ts
git commit -m "feat(core): walmart settlement report import with order matching"
```

---

### Task 13: Scheduler wiring, env, docs — and sandbox E2E gate

**Files:**
- Create: `src/channels/walmart/scheduler.ts`
- Modify: `src/server.ts`, `.env.example`, `systems/core/README.md`
- Test: `tests/walmart-scheduler.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `function registerAllWalmartHandlers(client?: WalmartClient): void` — calls `registerInventoryHandlers`, `registerPriceHandlers`, `registerShippingHandlers` with the same client.
  - `function startWalmartScheduler(client?: WalmartClient): void` — registers all handlers, then intervals: `processDueJobs` every 30s; `pollWalmartOrders` every 15min; `pollWalmartReturns` every 30min; `reconcileAllInventory` every 60min; `fetchAndImportSettlement(yesterday)` every 24h. Each interval callback wraps its call in `try/catch` + `console.error` so one failure never kills the timer. Timers stored module-level, `unref()`ed.
  - `function stopWalmartScheduler(): void` — clears all intervals (tests + shutdown).

- [ ] **Step 1: Write the failing test**

```ts
// tests/walmart-scheduler.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { startWalmartScheduler, stopWalmartScheduler, registerAllWalmartHandlers } from '../src/channels/walmart/scheduler.js'
import { clearHandlers, enqueueJob, processDueJobs } from '../src/channels/walmart/outbox.js'
import { resetDb } from './helpers/db.js'
import type { WalmartClient } from '../src/channels/walmart/client.js'

describe('walmart scheduler', () => {
  afterEach(() => { stopWalmartScheduler(); clearHandlers() })

  it('registers handlers for all outbound job types', async () => {
    await resetDb()
    const client: WalmartClient = { request: async () => ({}) }
    registerAllWalmartHandlers(client)
    for (const type of ['walmart_push_inventory', 'walmart_push_price', 'walmart_ack_order', 'walmart_ship_order', 'walmart_cancel_order']) {
      await enqueueJob(type, { variantId: 'missing', orderId: 'missing', externalOrderId: 'PO-X' })
    }
    const r = await processDueJobs()
    // inventory/price on a missing variant no-op (processed); ship/cancel on a missing order fail (retryable) — the point is every type HAS a handler, so nothing fails with "no handler registered"
    const jobs = await (await import('../src/prisma.js')).prisma.channelJob.findMany()
    expect(jobs.every((j) => j.lastError === null || !j.lastError.includes('no handler'))).toBe(true)
    expect(r.processed + r.failed).toBe(5)
  })

  it('start/stop is idempotent and does not throw', () => {
    const client: WalmartClient = { request: async () => ({}) }
    startWalmartScheduler(client)
    startWalmartScheduler(client)
    stopWalmartScheduler()
    stopWalmartScheduler()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/walmart-scheduler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/channels/walmart/scheduler.ts
import { type WalmartClient, getWalmartClient } from './client.js'
import { processDueJobs } from './outbox.js'
import { pollWalmartOrders, pollWalmartReturns } from './pollers.js'
import { reconcileAllInventory, registerInventoryHandlers } from './inventory.sync.js'
import { registerPriceHandlers } from './price.sync.js'
import { registerShippingHandlers } from './shipping.js'
import { fetchAndImportSettlement } from './settlement.js'

let timers: NodeJS.Timeout[] = []

export function registerAllWalmartHandlers(client: WalmartClient = getWalmartClient()): void {
  registerInventoryHandlers(client)
  registerPriceHandlers(client)
  registerShippingHandlers(client)
}

function every(ms: number, fn: () => Promise<unknown>, label: string): NodeJS.Timeout {
  const t = setInterval(() => { fn().catch((e) => console.error(`walmart scheduler ${label}:`, e)) }, ms)
  t.unref()
  return t
}

export function startWalmartScheduler(client: WalmartClient = getWalmartClient()): void {
  if (timers.length > 0) return
  registerAllWalmartHandlers(client)
  timers = [
    every(30_000, () => processDueJobs(), 'jobs'),
    every(15 * 60_000, () => pollWalmartOrders(client), 'orders-poll'),
    every(30 * 60_000, () => pollWalmartReturns(client), 'returns-poll'),
    every(60 * 60_000, () => reconcileAllInventory(client), 'inventory-reconcile'),
    every(24 * 3600_000, () => fetchAndImportSettlement(new Date(Date.now() - 24 * 3600_000), client), 'settlement'),
  ]
}

export function stopWalmartScheduler(): void {
  for (const t of timers) clearInterval(t)
  timers = []
}
```

In `src/server.ts`, after the app starts listening:

```ts
import { startWalmartScheduler } from './channels/walmart/scheduler.js'
if (process.env.WALMART_SYNC_ENABLED === 'true') startWalmartScheduler()
```

In `.env.example` append:

```
# Walmart Marketplace channel (sandbox defaults; production values are secrets)
WALMART_SYNC_ENABLED=false
WALMART_CLIENT_ID=
WALMART_CLIENT_SECRET=
WALMART_API_BASE=https://sandbox.walmartapis.com
WALMART_WEBHOOK_SECRET=
```

In `systems/core/README.md` add a "Walmart channel" section: what the module does, the env vars, how to run a manual poll/reconcile from a Node REPL, and where dead-lettered jobs live (`channel_jobs` with `status = 'dead'` — the operator alert surface until an admin UI exists).

- [ ] **Step 4: Run full suite**

Run: `npx vitest run`
Expected: ALL tests pass (Plan 2 suites + all `walmart-*` suites).

- [ ] **Step 5: Commit**

```bash
git add src/channels/walmart/scheduler.ts src/server.ts .env.example README.md tests/walmart-scheduler.test.ts
git commit -m "feat(core): walmart scheduler wiring, env config, and channel docs"
```

- [ ] **Step 6: Sandbox E2E gate (manual, blocking for launch — not for merge)**

Against the Walmart sandbox with real credentials in `.env` (never committed):
1. `createListing` + `submitItemFeed` for one real variant → feed reaches `PROCESSED`, listing `live`. Correct any item-spec 5.x attribute mismatches in `mappers.ts` `toItemFeed` only.
2. Trigger a sandbox test order (Walmart's [order test flows](https://developer.walmart.com/us-marketplace/docs/test-marketplace-apis)) → poller ingests it → ack job succeeds.
3. `recordChannelShipment` → sandbox order shows shipped.
4. Sandbox return → `pollWalmartReturns` ingests.
5. `fetchAndImportSettlement` → verify the real report response shape; fix `settlement.ts` response handling if it is zipped/differently shaped.
6. Record actual sandbox payloads into the test fixtures (contract-drift check from the spec).

Findings from this gate become ordinary fix commits on the branch. Production cutover (real listings, `WALMART_SYNC_ENABLED=true` in prod) requires Jack + partner sign-off per the spec.

---

## Execution notes

- Task order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13. Tasks 2/3 are independent of each other (both need only Task 1's branch, not its schema) and can run in parallel; Tasks 8/9 both depend on 7's outbox tweak landing first (8 and 9 are mutually independent).
- Every task runs `npx vitest run <its test files>` green before commit; Task 13 runs the full suite.
- All tests stub Walmart HTTP. No test may hit the network.
- Branch: `feat/walmart-channel` off `main` (after Plan 2 has merged); PR review before merge per workspace conventions.
