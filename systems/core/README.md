# AlpineBrick Core

Modular-monolith core (TypeScript + Express + Prisma/Postgres). Phase 1 substrate:
canonical schema (catalog + audit slice), seed, and the read-only catalog API at
`/api/v1/catalog`.

## Dev
1. `docker run -d --name alpinebrick-core-db -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:15`
2. `cp .env.example .env`
3. `npm install && npx prisma migrate dev && npm run seed`
4. `npm run dev` → http://localhost:4000/health

## Supersedes
`systems/catalog-service` (read-only Postgres API) is replaced by this module's
catalog API. Do not add features to `catalog-service`; it will be removed once the
storefront (Plan 5) points at `/api/v1/catalog` here.

## Image storage

Images are rows in the `images` table holding an **immutable storage key**,
never a URL: `products/{productId}/{imageId}/original.{ext}`. Keys are relative
and never start with a slash. Bytes are never replaced in place — replacing a
photo is a new row and a new key — which is what makes derivative URLs safe to
cache at the edge indefinitely.

Bytes are reached through `AssetStoragePort` (`src/ports/storage/`). The local
filesystem adapter is used until a CDN provider is chosen (ADR-0002); swapping
provider means writing one adapter and changing `imageUrl` plus two env vars.
**No database rows change.**

Uploads are two-phase:

1. `POST /api/v1/admin/images/upload-token` reserves a **pending** row and
   returns a short-lived upload target.
2. The client PUTs bytes directly to storage — they never pass through core.
3. `POST /api/v1/admin/images/:id/confirm` verifies the object exists and reads
   its **true dimensions from storage**, then marks the row `ready`.

Confirming without uploading returns **409 `object_missing`**. Pending rows are
never returned by the public catalog API, so a failed upload cannot surface a
broken product page.

`sweepPendingImages` removes abandoned pending rows, but **nothing calls it** —
core's only scheduler (`src/worker.ts`, see "Walmart channel" below) is
Walmart-specific and does not sweep images. It is a job waiting to be wired,
not a finished feature.

**These admin endpoints have no authentication.** Neither does the rest of core,
but this is the first endpoint that causes arbitrary bytes to be written, so it
must not reach a public network before auth exists.

`imageUrl` in `src/assets/image-url.ts` is **deliberately duplicated** in the
storefront (`src/lib/images.ts`); the two packages cannot import each other.
A parity test in the storefront fails if the grammars drift.

## Walmart channel

`src/channels/walmart/` is the Walmart Marketplace integration: the API
client, listings, inventory/price sync, order ingest, webhooks, pollers,
shipping, returns, and settlement import. None of it runs on its own —
`src/channels/walmart/scheduler.ts` registers every outbound job handler
(`registerAllWalmartHandlers`) and starts the recurring jobs
(`startWalmartScheduler`), and `src/worker.ts` is the only thing that calls
`startWalmartScheduler`. **`server.ts` (the web process) never does** — the
scheduler runs in its own process (`node dist/worker.js`, Render service
`core-worker`) so that scaling the web process doesn't also scale how many
copies are polling Walmart and draining the outbox.

### Env vars

Add these to `.env` (see `.env.example` for the full list — not reproduced
here since it's off-limits to automated edits in this repo; ask Jack to add
them, see "Env vars for `.env.example`" below):

| Var | Purpose | Default |
|---|---|---|
| `WALMART_SYNC_ENABLED` | `true` to start the scheduler in `src/worker.ts`. Unset or anything else: the worker logs that sync is disabled and exits 0. | unset |
| `WALMART_SETTLEMENT_ENABLED` | `true` to also register the 24h settlement-import interval. See "Settlement is unverified" below before flipping this anywhere real. | unset (off) |
| `WALMART_CLIENT_ID` | Walmart API client ID (secret). | — |
| `WALMART_CLIENT_SECRET` | Walmart API client secret (secret). | — |
| `WALMART_API_BASE` | Walmart API base URL. | `https://sandbox.walmartapis.com` |
| `WALMART_WEBHOOK_SECRET` | Verifies the `x-webhook-secret` header on inbound Walmart webhooks (`webhooks.routes.ts`). | — |

### Running the worker locally

1. Bring up the core Postgres container and migrate/seed as in "Dev" above.
2. Dev mode: `WALMART_SYNC_ENABLED=true npm run worker` (runs `src/worker.ts`
   directly via `tsx`).
3. Built mode: `npm run build && WALMART_SYNC_ENABLED=true npm run start:worker`
   (runs `dist/worker.js`).
4. `Ctrl+C` (SIGINT) or a `SIGTERM` stops the scheduler's intervals and
   disconnects Prisma before the process exits.

Leaving `WALMART_SYNC_ENABLED` unset is deliberate and safe: the worker logs
that sync is disabled and exits 0 immediately, so an accidental deploy
without the flag never starts polling Walmart.

### What the scheduler runs

Once started, `startWalmartScheduler` registers:

- `processDueJobs` (drains the `channel_jobs` outbox) — every 30s
- `pollWalmartOrders` — every 15 minutes
- `pollWalmartReturns` — every 30 minutes
- `reconcileAllInventory` — every 60 minutes
- `fetchAndImportSettlement(yesterday)` — every 24h, **only when
  `WALMART_SETTLEMENT_ENABLED=true`**

Every interval catches its own error (`console.error`, tagged with the job's
label) so one job failing never stops the others, and skips a tick if the
previous run of the *same* job hasn't finished yet — an outbox drain that
takes longer than 30s never runs two overlapping copies of itself.

### Manual poll / reconcile from a Node REPL

From `systems/core`, with `.env` pointing at a Walmart sandbox config:

```
npx tsx -e "
import { pollWalmartOrders } from './src/channels/walmart/pollers.js'
console.log(await pollWalmartOrders())
"
```

Swap in `pollWalmartReturns()`, `reconcileAllInventory()`, or
`fetchAndImportSettlement(new Date('2026-09-01'))` (all from
`src/channels/walmart/`) the same way for a one-off manual run of any of the
scheduler's jobs without starting the worker process.

### Operator alert surface: dead-lettered jobs

There is no admin UI for this yet. A job that has failed
`processDueJobs`'s max-attempts (5) sits in `channel_jobs` with
`status = 'dead'`, and its last failure is in `last_error`. Until an admin UI
exists, that's the surface to check:

```sql
select id, type, payload, attempts, last_error, updated_at
from channel_jobs
where status = 'dead'
order by updated_at desc;
```

### Settlement reconciliation is UNVERIFIED and disabled by default

`fetchAndImportSettlement` / `settlement.ts` were built entirely from
Walmart's published documentation — never against a real settlement report,
sandbox or production. Two things gate turning `WALMART_SETTLEMENT_ENABLED`
on anywhere real:

1. The manual sandbox end-to-end check (Task 13 brief, Step 6) — confirming
   the report's actual wire format (documentation shows JSON; the current
   code assumes CSV) and fixing whatever it gets wrong.
2. A known, deliberately deferred defect (finding B4 — see the
   `BLOCKER FOR PRODUCTION LAUNCH` comment near `settlement.ts:425`): a
   settlement group spanning more than one import call is never re-stamped,
   so its rows' `discrepancyCents` can go stale and self-contradictory.

Until both are resolved, leave `WALMART_SETTLEMENT_ENABLED` unset (or
`false`) everywhere — the scheduler simply never registers that interval,
and nothing about settlement runs.

### Returns arrive only via the poller

`pollWalmartReturns` (every 30 minutes) is currently the *only* path that
ingests a Walmart return. The webhook route
(`src/channels/walmart/webhooks.routes.ts`) responds `202 { ignored: true }`
to every event type other than `ORDER_CREATED` — a return-notification
webhook is accepted and dropped, not ingested. A return can take up to 30
minutes to show up in `Order`/`ChannelEvent`.

### Env vars for `.env.example`

`.env.example` is off-limits to automated edits in this repo. Add these
lines yourself:

```
# Walmart Marketplace channel (sandbox defaults; production values are secrets)
WALMART_SYNC_ENABLED=false
WALMART_SETTLEMENT_ENABLED=false
WALMART_CLIENT_ID=
WALMART_CLIENT_SECRET=
WALMART_API_BASE=https://sandbox.walmartapis.com
WALMART_WEBHOOK_SECRET=
```