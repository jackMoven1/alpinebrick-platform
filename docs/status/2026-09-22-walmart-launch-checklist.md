# Walmart channel — launch checklist (2026-09-22)

Branch `feat/walmart-5-13` is **merge-ready, not launch-ready.** Nothing in the
Walmart channel runs until the `core-worker` service is provisioned **and**
`WALMART_SYNC_ENABLED=true` is set on it: `src/worker.ts` `main()` is the only
caller of `startWalmartScheduler` (`src/channels/walmart/scheduler.ts`), and
`server.ts` never starts it. `core-worker` is commented out in `render.yaml`.

Paths below are relative to `systems/core/` unless stated. Line numbers are at
the final-fix-wave commits and will drift; the function name is the stable
anchor.

## 1. Sandbox gate (plan Task 13, Step 6) — unverified external shapes

Each item is a shape the code assumes about Walmart and has never been checked
against a real response. **The tests for these use fixtures that carry the
same assumption as the code, so green tests do not verify any of them.**
Capture a real sandbox response for each and correct the code to it.

| # | Assumption | Where | What to capture |
|---|---|---|---|
| 1.1 | Settlement report wire format is CSV (a bare string or `{ csv }`). The one documentation page fetched shows **JSON**, paginated: `{ reportData: [...], nextOffset, totalRecords, description }`. If JSON, the whole parsing layer is replaced, and paging via `nextOffset` has to be added. | `fetchAndImportSettlement` (`src/channels/walmart/settlement.ts:582`), `parseSettlementCsv` (`:107`) | Raw response of `GET /v3/report/reconreport/reconFile?reportDate=…` for a day with activity, including a multi-page report. |
| 1.2 | **BLOCKER.** Finding B4, cross-call re-stamping: an order's `Sale` rows arriving across more than one import call leave earlier rows with stale `discrepancyCents`. Deliberately deferred until 1.1 and 1.3 are known. | The `BLOCKER FOR PRODUCTION LAUNCH` comment above `importSettlementRowsAttempt` (`settlement.ts:425`, function at `:443`) | Whether one PO's rows can span report days/pages. Then build the two-phase insert-then-re-stamp. `WALMART_SETTLEMENT_ENABLED` stays off until this is done. |
| 1.3 | Commission rows and the `Amount Type` enumeration: only `"Product Price"` is documented. Commission may arrive as negative lines on `Sale` rows ("Commission on Product" — unconfirmed recollection), which would show every order as short by its own commission. | `parseSettlementCsv` (`settlement.ts:119`, `:124`); the "LABELLED, UNVERIFIED ASSUMPTIONS" block at the end of `settlement.ts` | The full set of `Amount Type` values in a real report, and which `Transaction Type` rows carry commission. |
| 1.4 | Webhook envelope. The code expects `{ eventType: 'ORDER_CREATED', payload }`. The final reviewer **recalled, unverified**, `{ source: { eventType: 'PO_CREATED' }, payload }`. If the reviewer is right, every real order webhook is 202'd as ignored. The poller still catches orders, up to 15 min late. | `webhooks.routes.ts:38-40` | One real order-created webhook delivery body, headers included. |
| 1.5 | Returns fields. The code reads `customerOrderInfo.purchaseOrderId` (falling back to `purchaseOrderId`) and `refundedAmount.amount`. The reviewer **recalled, unverified**, `customerOrderId`, `returnOrderLines[].purchaseOrderId` and `totalRefundAmount.currencyAmount`. If the reviewer is right, no return ever links to its order and no refund is ever recognised. | `ingestWalmartReturn` (`src/channels/walmart/returns.service.ts:193`, `:197`) | One real `GET /v3/returns` element with a refund issued. |
| 1.6 | Per-unit charges: PRODUCT charge amount and tax are treated as **per unit** and multiplied by quantity. The same rule is applied to SHIPPING and to every other charge type when reconstructing gross. | `toCanonicalOrder` (`src/channels/walmart/mappers.ts:59-60`); `reconstructOrderGrossCents` (`settlement.ts:192`, doc at `:173`) | A real order with quantity ≥ 2 and a shipping charge. Check whether amounts are per unit or per line. |
| 1.7 | Feed item-details paging: the feed status is fetched with `includeDetails=true` and no `limit`/`offset`, so a feed with more items than Walmart's default page size silently reports only the first page. | `checkFeedStatus` (`src/channels/walmart/listings.service.ts:247`) | The status response for a feed larger than one page, and its paging fields. |
| 1.8 | Walmart line numbers are derived **by position** (i-th stored line → `lineNumber` `i+1`). Lines are now read in ingest order (final fix B2), but that is still a proxy. The real fix is to store Walmart's `lineNumber` on `OrderLine` at ingest and send it back. | `registerShippingHandlers` ship/cancel handlers and `LINES_IN_INGEST_ORDER` (`src/channels/walmart/shipping.ts`); ingest `lines.create` (`src/channels/walmart/orders.ingest.ts`) | A real multi-line PO. Check whether Walmart `lineNumber`s are always 1..n in array order. Then add the column. |
| 1.9 | A replayed ship job may 4xx. The `walmart_ship_order` handler is not idempotent against Walmart: a job re-run after a lost `done` write re-POSTs the shipment. The test only proves that stock does not move again. If Walmart rejects the re-post with a 4xx, the job retries and then dead-letters. | `registerShippingHandlers` → `'walmart_ship_order'` (`shipping.ts:131`) | Sandbox response to POSTing the same shipment twice. If it is a 4xx, treat "already shipped" as success. |

## 2. Operational gaps before launch

- **No feed-status poll.** `checkFeedStatus` (`listings.service.ts:243`) has no caller, so listings stay `submitted` and never become `live`. `reconcileAllInventory` (`src/channels/walmart/inventory.sync.ts:80`) covers only `status: 'live'` (`:83`), so submitted listings also miss the hourly drift correction. Add a scheduler interval.
- **`enqueuePricePush` has no production caller** (`src/channels/walmart/price.sync.ts:48`). Price changes never reach Walmart after the listing feed.
- **No route or CLI** for `createListing` (`listings.service.ts:9`), `submitItemFeed` (`:66`), `recordChannelShipment` (`shipping.ts:64`), `cancelChannelOrder` (`:93`) or `issueWalmartRefund` (`returns.service.ts:254`). Today they can only be called from a REPL.
- **Retry budget.** `MAX_ATTEMPTS = 5` with `2 ** attempts` minute backoff (`src/channels/walmart/outbox.ts:153`, `:194`) dead-letters ack, ship and cancel jobs about 30 minutes into a Walmart outage (2+4+8+16 min). There is no revival path except `enqueueIdempotentJob` being called again for the same key, which nothing does after ingest. Needs per-type budgets and capped backoff. Dead-letters are now `console.error`'d (final fix A3), but there is still no alert.
- **Order poller:**
  - It does not page. It fetches `limit: '100'` and nothing after (`pollWalmartOrders`, `src/channels/walmart/pollers.ts:29`).
  - It ignores order and line status. Every PO is ingested as `status: 'paid'` (`orders.ingest.ts:142`), so a cancelled PO ingests as paid and reserves stock.
  - Walmart-initiated cancels of an already-ingested order are unhandled (`shipping.ts` file header).
- **Settlement transaction timeout.** `importSettlementRowsAttempt`'s `prisma.$transaction` (`settlement.ts:456`) uses Prisma's default 5 s interactive timeout, with roughly 4 round trips per row. A real-size report will time out and roll back. Set `timeout` explicitly or batch.
- **Settlement schedule.** The 24 h interval (`scheduler.ts:136`) restarts on every deploy or restart and never runs at startup, so frequent deploys mean it may never fire. It needs a persisted last-run or a fixed time of day.
- **Worker exits 0 when disabled** (`worker.ts` `main()`). Render restarts an exited worker, so a `core-worker` without `WALMART_SYNC_ENABLED=true` crash-loops. This is documented in the worker header, the README and `render.yaml` (final fix B6). Behaviour is unchanged.
- **Migration `20260922160000_settlement_reconciliation_fixes`** adds `transaction_type` and `net_cents` as `NOT NULL` with no default. That is safe only while `channel_settlements` is empty. Consider squashing the settlement migrations (`20260922150606` … `20260922180000`) before the first deploy.

## 3. Decisions for Jack

1. **Provision `core-worker`.** It is a paid Render service and is commented out in `render.yaml`. Provision it only with `WALMART_SYNC_ENABLED=true` (see §2).
2. **Set a price floor above $0.** `resolveListingPriceCents` (`src/channels/walmart/pricing.ts:31`) enforces only `> 0`, by design until a floor is chosen.
3. **Provide Walmart sandbox credentials.** The whole of §1 is blocked on them.
4. **Add these lines to `.env.example`** (automated edits to that file are off-limits; from `.superpowers/sdd/2026-08-03-walmart-marketplace-integration/task-13-report.md`):

```
# Walmart Marketplace channel (sandbox defaults; production values are secrets)
WALMART_SYNC_ENABLED=false
WALMART_SETTLEMENT_ENABLED=false
WALMART_CLIENT_ID=
WALMART_CLIENT_SECRET=
WALMART_API_BASE=https://sandbox.walmartapis.com
WALMART_WEBHOOK_SECRET=
```
