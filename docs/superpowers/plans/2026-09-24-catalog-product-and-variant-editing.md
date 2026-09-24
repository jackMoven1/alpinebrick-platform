# Catalog Product and Variant Editing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins can create and edit products and variants, set stock and a per-variant Walmart allocation from the console, with every change audited — so real inventory can be loaded into staging.

**Architecture:** Granular write endpoints in `systems/core` under `/api/v1/admin`, each validating input with pure parsers, writing inside one Prisma transaction together with its `AuditLog` row, and returning the full admin product DTO. Stock and allocation are guarded row updates that keep the invariant `reserved + COALESCE(walmart_allocation, 0) <= on_hand`. The console (`systems/admin-ui`) replaces its `notImplemented` stubs with real calls and turns its read-only tabs into editors.

**Tech Stack:** Node 20, TypeScript, Express 4, Prisma 5 on Postgres 16, Vitest + Supertest (core); React 18, Vite, Vitest + Testing Library (admin-ui).

**Spec:** `docs/superpowers/specs/2026-09-24-catalog-product-and-variant-editing-design.md` — read it before starting. Section references (§) below point into it.

## Global Constraints

- **Test database.** Core tests need Postgres on `localhost:5433` (the `alpinebrick-core-db` container), `DATABASE_URL=postgresql://postgres:test@localhost:5433/core_test` as CI uses. Task 0 restores it. If it cannot be restored, push the branch and read `gh pr checks` — CI is the verifier — and say so in every report; never claim a test passed that you did not see pass.
- **Never read or print `.env`, `.env.example` or `secrets/`.**
- **Branching:** one branch per PR, cut from `main`: `feat/catalog-editing-core` (Tasks 0–9), `feat/catalog-editing-console` (Tasks 10–14). Never commit onto a branch you did not create.
- **Commits:** conventional, subject names the system (`feat(core):`, `feat(admin-ui):`), trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Error envelope:** `{ code, message, fields?, details? }`, UPPER_SNAKE codes (spec §3).
- **Money:** integer cents everywhere in core; the console converts dollars→cents once, on submit.
- **Audit:** every write and its `AuditLog` row in the same `prisma.$transaction` (spec §4.3). Actions: `product.create`, `product.update`, `product.status`, `variant.create`, `variant.update`, `variant.delete`, `variant.stock.set`.
- **Invariant:** `reserved + COALESCE(walmart_allocation, 0) <= on_hand` for every inventory row, preserved by every statement that changes stock.
- **Before merging either PR:** `npx vitest run`, `npm run build`, and (core) boot `node dist/server.js` against the test DB and `curl /health`. A green suite does not prove the app starts.
- **No mock fallback in the console.** A method with no endpoint throws; its control is disabled.

## File Structure

**Core (`systems/core`)**

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` | + `Product.firstPublishedAt`, + `Inventory.walmartAllocation`, − `ChannelListing.bufferPct` |
| `prisma/migrations/20260924120000_catalog_editing/migration.sql` | Spec §7's two added columns (Task 1) |
| `prisma/migrations/20260924120100_drop_listing_buffer_pct/migration.sql` | Spec §7's column drop (Task 2), split so every commit builds |
| `src/inventory/allocation.ts` | **New.** Pure: what each channel can sell |
| `src/admin/admin-errors.ts` | **New.** `AdminError` (moved, gains `fields`/`details`), `mapUniqueViolation` |
| `src/admin/product-input.ts` | **New.** Pure parsers: product, variant, stock bodies |
| `src/admin/admin-product.dto.ts` | **New.** `AdminProductDto`, `loadAdminProduct(id)` |
| `src/admin/admin-catalog.service.ts` | Re-exports `AdminError`; `adminGetProduct` delegates to the DTO module; `setProductStatus` stamps `firstPublishedAt` |
| `src/admin/product-write.service.ts` | **New.** `createProduct`, `updateProduct`, `bulkSetStatus` |
| `src/admin/variant-write.service.ts` | **New.** `createVariant`, `bulkCreateVariants`, `updateVariant`, `deleteVariant` |
| `src/admin/stock.service.ts` | **New.** `setStock`, `getStockHistory` |
| `src/admin/admin-catalog.routes.ts` | New routes; `fail()` emits `fields`/`details`; new codes |
| `src/orders/orders.service.ts` | Storefront reserve excludes allocation; Walmart cancel returns allocation |
| `src/channels/walmart/orders.ingest.ts` | Walmart reserve consumes allocation |
| `src/channels/walmart/inventory.sync.ts` | Push `walmartSellable`; buffer removed |
| `src/channels/walmart/listings.service.ts` | `bufferPct` option removed |
| `src/catalog/catalog.service.ts` | Public `available` = storefront sellable |
| `tests/helpers/db.ts` | + `ensureSystemActor()` |

**Console (`systems/admin-ui`)**

| File | Responsibility |
|---|---|
| `src/data/errors.js` | `AdminApiError` gains `details` |
| `src/data/api.js` | Real write methods |
| `src/data/__fixtures__/*.json` | Responses captured from core (Task 9) |
| `src/lib/money.js` | **New.** dollars↔cents |
| `src/catalog/ProductForm.jsx` | Create with type; routed at `/products/new` |
| `src/catalog/tabs/InfoTab.jsx` | Editable, explicit Save, sectioned |
| `src/catalog/tabs/VariantsTab.jsx` | Live variants table |
| `src/catalog/tabs/StockDialog.jsx` | **New.** Set stock + allocation + history |
| `src/catalog/ProductList.jsx`, `CatalogOverview.jsx`, `App.jsx` | New-product entry, bulk status |

---

## Task 0: Restore the local test database

**Files:** none.

- [ ] **Step 1: Start Docker Desktop and confirm the engine answers**

Run: `docker info --format '{{.ServerVersion}}'`
Expected: a version string. If it fails with the named-pipe error, follow the 2026-08-12 handoff §6 recovery (uncompress Docker's `AppData` folders, move dead socket dirs aside, reboot). If still broken, stop this task, note "CI is the verifier" and continue — every later "run" step then means: commit, push, `gh pr checks <n> --watch`.

- [ ] **Step 2: Start the existing container (never recreate it — it holds data)**

Run: `docker start alpinebrick-core-db && docker exec alpinebrick-core-db pg_isready -U postgres`
Expected: `accepting connections`.

- [ ] **Step 3: Branch and confirm a green baseline**

```bash
cd projects/engineering && git checkout main && git pull --ff-only && git checkout -b feat/catalog-editing-core
cd systems/core && export DATABASE_URL=postgresql://postgres:test@localhost:5433/core_test
npx prisma migrate deploy && npx vitest run
```
Expected: all tests pass. Record the count; later tasks compare against it.

---

## Task 1: Schema migration and first-publish stamp

**Files:**
- Modify: `systems/core/prisma/schema.prisma` (models `Product`, `Inventory`, `ChannelListing`)
- Create: `systems/core/prisma/migrations/20260924120000_catalog_editing/migration.sql`
- Modify: `systems/core/src/admin/admin-catalog.service.ts` (`setProductStatus`)
- Modify: `systems/core/src/channels/walmart/listings.service.ts:12,25`
- Test: `systems/core/tests/catalog-editing-schema.test.ts`

**Interfaces:**
- Produces: `Product.firstPublishedAt: Date | null`; `Inventory.walmartAllocation: number | null`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/catalog-editing-schema.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { setProductStatus } from '../src/admin/admin-catalog.service.js'

let actorId: string
beforeEach(async () => {
  await resetDb()
  actorId = (await prisma.actor.create({ data: { type: 'human', name: 't' } })).id
})
afterAll(() => prisma.$disconnect())

describe('first_published_at', () => {
  it('is null on a new product', async () => {
    const p = await prisma.product.create({ data: { slug: 'a', name: 'A', productType: 'resale' } })
    expect(p.firstPublishedAt).toBeNull()
  })

  it('is stamped on first publish and never cleared or moved', async () => {
    const p = await prisma.product.create({ data: { slug: 'a', name: 'A', productType: 'resale' } })
    await setProductStatus(p.id, 'published', actorId)
    const first = (await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).firstPublishedAt
    expect(first).toBeInstanceOf(Date)
    await setProductStatus(p.id, 'draft', actorId)
    await setProductStatus(p.id, 'published', actorId)
    await setProductStatus(p.id, 'archived', actorId)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).firstPublishedAt).toEqual(first)
  })
})

describe('walmart_allocation', () => {
  async function inv() {
    const p = await prisma.product.create({ data: { slug: 'a', name: 'A', productType: 'resale' } })
    const v = await prisma.variant.create({ data: { productId: p.id, sku: 'A-1', priceCents: 100 } })
    return prisma.inventory.create({ data: { variantId: v.id, onHand: 1 } })
  }
  it('defaults to null (shared)', async () => {
    expect((await inv()).walmartAllocation).toBeNull()
  })
  it('rejects a negative allocation at the database', async () => {
    const i = await inv()
    await expect(prisma.$executeRaw`UPDATE inventory SET walmart_allocation = -1 WHERE id = ${i.id}`).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/catalog-editing-schema.test.ts`
Expected: FAIL — TypeScript/Prisma errors on unknown fields `firstPublishedAt` / `walmartAllocation`.

- [ ] **Step 3: Edit the schema**

In `model Product`, after `collectionPosition`:
```prisma
  // Set on the first transition into `published`, never cleared. Locks the
  // slug: a product that has ever been live may already be linked or indexed.
  firstPublishedAt   DateTime? @map("first_published_at")
```
In `model Inventory`, after `onOrder`:
```prisma
  // Units set aside for Walmart. NULL = shared: both channels sell all of
  // on_hand - reserved. N = split: Walmart sells up to N, the storefront the
  // rest. Consumed by Walmart sales, returned on Walmart cancels. Invariant,
  // kept by every writer: reserved + COALESCE(walmart_allocation, 0) <= on_hand.
  // Spec: docs/superpowers/specs/2026-09-24-catalog-product-and-variant-editing-design.md §5.1
  walmartAllocation Int? @map("walmart_allocation")
```
Leave `ChannelListing.bufferPct` alone here; Task 2 drops it together with the code that reads it, so no commit in between has a broken build.

- [ ] **Step 4: Write the migration by hand**

```sql
-- prisma/migrations/20260924120000_catalog_editing/migration.sql
-- Catalog editing (spec 2026-09-24).
--
-- first_published_at: no backfill. Nothing had been published on any
-- environment when this ran. Where products HAD been published, those rows
-- would read as never-published and keep an editable slug -- a one-time gap.
ALTER TABLE "products" ADD COLUMN "first_published_at" TIMESTAMP(3);

-- walmart_allocation: NULL (shared) for every existing row, the chosen default.
ALTER TABLE "inventory" ADD COLUMN "walmart_allocation" INTEGER;
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_walmart_allocation_nonnegative"
  CHECK ("walmart_allocation" IS NULL OR "walmart_allocation" >= 0);
```
(The spec's third change, dropping `buffer_pct`, is Task 2's migration — same release, split only so every commit builds.)

- [ ] **Step 5: Apply and regenerate**

Run: `npx prisma migrate deploy && npx prisma generate`
Expected: `1 migration applied`.

- [ ] **Step 6: Stamp `firstPublishedAt` in `setProductStatus`**

Replace the update line inside the transaction:
```ts
    await tx.product.update({
      where: { id },
      data: {
        status: target as Status,
        // First publish only. Unpublishing or archiving never clears it, so
        // the slug stays locked (spec §4.1).
        ...(target === 'published' && existing.firstPublishedAt === null
          ? { firstPublishedAt: new Date() }
          : {}),
      },
    })
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS — the whole suite, not just the new file, since the schema changed.

- [ ] **Step 8: Commit**

```bash
git add prisma src/admin/admin-catalog.service.ts tests/catalog-editing-schema.test.ts
git commit -m "feat(core): first_published_at and walmart_allocation columns"
```

---

## Task 2: Allocation rules in every stock path

**Files:**
- Modify: `systems/core/prisma/schema.prisma` (delete `ChannelListing.bufferPct`)
- Create: `systems/core/prisma/migrations/20260924120100_drop_listing_buffer_pct/migration.sql`
- Modify: `systems/core/src/channels/walmart/listings.service.ts:12,25`
- Create: `systems/core/src/inventory/allocation.ts`
- Modify: `systems/core/src/orders/orders.service.ts` (`placeOrder` reserve SQL, `cancelOrder` release SQL)
- Modify: `systems/core/src/channels/walmart/orders.ingest.ts` (reserve SQL, ~line 131)
- Modify: `systems/core/src/channels/walmart/inventory.sync.ts` (replace `computeAvailableToSell`)
- Modify: `systems/core/src/catalog/catalog.service.ts:185` (`getAvailability`)
- Modify: `systems/core/tests/helpers/db.ts`
- Rewrite: `systems/core/tests/walmart-inventory-sync.test.ts` (the `computeAvailableToSell` block and `seed()`)
- Test: `systems/core/tests/allocation.test.ts`, `systems/core/tests/allocation-concurrency.test.ts`

**Interfaces:**
- Produces: `storefrontSellable(onHand: number, reserved: number, allocation: number | null): number`; `walmartSellable(onHand: number, reserved: number, allocation: number | null): number`; `ensureSystemActor(): Promise<void>` in `tests/helpers/db.ts`.
- Removes: `computeAvailableToSell`.

- [ ] **Step 1: Add the test helper**

Append to `tests/helpers/db.ts`:
```ts
// placeOrder / cancelOrder audit as actor 'system'. resetDb deletes every
// actor, so tests that exercise orders must put it back.
export async function ensureSystemActor() {
  await prisma.actor.upsert({
    where: { id: 'system' },
    create: { id: 'system', type: 'agent', name: 'system' },
    update: {},
  })
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/allocation.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb, ensureSystemActor } from './helpers/db.js'
import { storefrontSellable, walmartSellable } from '../src/inventory/allocation.js'
import { placeOrder, cancelOrder } from '../src/orders/orders.service.js'
import { ingestWalmartOrder } from '../src/channels/walmart/orders.ingest.js'
import { getAvailability } from '../src/catalog/catalog.service.js'
import { pushInventoryForVariant } from '../src/channels/walmart/inventory.sync.js'
import { walmartOrderFixture } from './helpers/walmart-fixtures.js'
import type { WalmartClient } from '../src/channels/walmart/client.js'

describe('sellable figures (spec §5.1 table)', () => {
  it('shared: both channels see on_hand - reserved', () => {
    expect(storefrontSellable(5, 2, null)).toBe(3)
    expect(walmartSellable(5, 2, null)).toBe(3)
  })
  it('split: Walmart gets min(N, free), storefront the rest', () => {
    expect(walmartSellable(10, 0, 3)).toBe(3)
    expect(storefrontSellable(10, 0, 3)).toBe(7)
  })
  it('a single collectible: 1 = Walmart only, 0 = storefront only', () => {
    expect([walmartSellable(1, 0, 1), storefrontSellable(1, 0, 1)]).toEqual([1, 0])
    expect([walmartSellable(1, 0, 0), storefrontSellable(1, 0, 0)]).toEqual([0, 1])
  })
  it('never negative', () => {
    expect(storefrontSellable(1, 1, 1)).toBe(0)
    expect(walmartSellable(0, 0, 3)).toBe(0)
  })
})

// The Walmart fixture sells SKU ABE-SET-001-W, quantity 2.
async function makeVariant(onHand: number, walmartAllocation: number | null) {
  const p = await prisma.product.create({ data: { slug: 'castle', name: 'Castle', productType: 'resale', status: 'published' } })
  const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-SET-001', priceCents: 4999 } })
  await prisma.inventory.create({ data: { variantId: v.id, onHand, walmartAllocation } })
  await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-SET-001-W', status: 'live' } })
  return v
}
const inv = (variantId: string) => prisma.inventory.findUniqueOrThrow({ where: { variantId } })
const storefront = (variantId: string, quantity: number) =>
  placeOrder({ email: 'a@example.com', shipToState: 'MI', lines: [{ variantId, quantity }] })

describe('allocation in the stock paths', () => {
  beforeEach(async () => { await resetDb(); await ensureSystemActor() })
  afterAll(() => prisma.$disconnect())

  it('storefront cannot buy units allocated to Walmart', async () => {
    const v = await makeVariant(3, 2)
    await storefront(v.id, 1)
    await expect(storefront(v.id, 1)).rejects.toMatchObject({ code: 'insufficient_stock' })
  })

  it('shared stock lets the storefront take everything', async () => {
    const v = await makeVariant(2, null)
    await storefront(v.id, 2)
    expect((await inv(v.id)).reserved).toBe(2)
  })

  it('a Walmart sale consumes its allocation', async () => {
    const v = await makeVariant(5, 3)
    await ingestWalmartOrder(walmartOrderFixture, 'webhook')
    const i = await inv(v.id)
    expect([i.reserved, i.walmartAllocation]).toEqual([2, 1])
  })

  it('a Walmart order beyond its allocation is refused', async () => {
    await makeVariant(5, 1)
    await expect(ingestWalmartOrder(walmartOrderFixture, 'webhook')).rejects.toMatchObject({ code: 'insufficient_stock' })
  })

  it('shared stock lets Walmart take everything, allocation stays null', async () => {
    const v = await makeVariant(2, null)
    await ingestWalmartOrder(walmartOrderFixture, 'webhook')
    const i = await inv(v.id)
    expect([i.reserved, i.walmartAllocation]).toEqual([2, null])
  })

  it('cancelling a Walmart order returns the units to Walmart', async () => {
    const v = await makeVariant(5, 3)
    const { orderId } = await ingestWalmartOrder(walmartOrderFixture, 'webhook')
    await cancelOrder(orderId!)
    const i = await inv(v.id)
    expect([i.reserved, i.walmartAllocation]).toEqual([0, 3])
  })

  it('cancelling a storefront order does not touch the allocation', async () => {
    const v = await makeVariant(5, 2)
    const o = await storefront(v.id, 2)
    await cancelOrder(o.id)
    expect((await inv(v.id)).walmartAllocation).toBe(2)
  })

  it('public availability excludes Walmart-allocated units', async () => {
    const v = await makeVariant(5, 2)
    const rows = await getAvailability('castle')
    expect(rows?.find((r) => r.variantId === v.id)?.available).toBe(3)
  })

  it('pushes Walmart its sellable figure, with no percentage buffer', async () => {
    const v = await makeVariant(1, null)
    const calls: any[] = []
    const client: WalmartClient = { request: async (method, path, opts) => { calls.push(opts); return {} } }
    await pushInventoryForVariant(v.id, client)
    expect(calls[0].body.quantity.amount).toBe(1) // the old 10%-min-1 buffer sent 0
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/allocation.test.ts`
Expected: FAIL — `Cannot find module '../src/inventory/allocation.js'`.

- [ ] **Step 4: Create `src/inventory/allocation.ts`**

```ts
/**
 * What each channel may sell from one variant's stock (spec §5.1).
 *
 * allocation === null  -> shared: both channels see on_hand - reserved.
 * allocation === N     -> split: Walmart sees min(N, free), the storefront
 *                         the free units that are NOT allocated.
 *
 * These are the READ-side figures. The write-side guards live in the SQL of
 * placeOrder, ingestWalmartOrder and setStock and must agree with them.
 */
export function storefrontSellable(onHand: number, reserved: number, allocation: number | null): number {
  return Math.max(0, onHand - reserved - (allocation ?? 0))
}

export function walmartSellable(onHand: number, reserved: number, allocation: number | null): number {
  const free = Math.max(0, onHand - reserved)
  return allocation === null ? free : Math.min(allocation, free)
}
```

- [ ] **Step 5: Storefront reserve — `placeOrder` step 2**

```ts
      const affected = await tx.$executeRaw`
        UPDATE inventory SET reserved = reserved + ${line.quantity}
        WHERE variant_id = ${line.variantId}
          AND on_hand - reserved - COALESCE(walmart_allocation, 0) >= ${line.quantity}`
```
Update the comment above it: units allocated to Walmart are not the storefront's to sell (spec §5.1 rule 1).

- [ ] **Step 6: Walmart reserve — `ingestWalmartOrder`**

```ts
        // A Walmart sale consumes its allocation in the same statement that
        // reserves (spec §5.1 rule 2); shared stock (NULL) stays NULL.
        const affected = await tx.$executeRaw`
          UPDATE inventory
          SET reserved = reserved + ${line.quantity},
              walmart_allocation = CASE WHEN walmart_allocation IS NULL THEN NULL
                                        ELSE walmart_allocation - ${line.quantity} END
          WHERE variant_id = ${listing.variantId}
            AND on_hand - reserved >= ${line.quantity}
            AND (walmart_allocation IS NULL OR walmart_allocation >= ${line.quantity})`
```

- [ ] **Step 7: Walmart cancel returns allocation — `cancelOrder`**

Replace the release statement inside the line loop:
```ts
      // A Walmart unit that did not sell stays Walmart's (spec §5.1 rule 3):
      // reserved - q and allocation + q keeps reserved + allocation constant,
      // so the invariant holds.
      const affected = order.channel === 'walmart'
        ? await tx.$executeRaw`
            UPDATE inventory
            SET reserved = reserved - ${line.quantity},
                walmart_allocation = CASE WHEN walmart_allocation IS NULL THEN NULL
                                          ELSE walmart_allocation + ${line.quantity} END
            WHERE variant_id = ${line.variantId} AND reserved >= ${line.quantity}`
        : await tx.$executeRaw`
            UPDATE inventory SET reserved = reserved - ${line.quantity}
            WHERE variant_id = ${line.variantId} AND reserved >= ${line.quantity}`
```

- [ ] **Step 8: Push the Walmart figure — `inventory.sync.ts`**

Delete `computeAvailableToSell` and its doc comment. Add `import { walmartSellable } from '../../inventory/allocation.js'`. In `pushInventoryForVariant`:
```ts
  const qty = walmartSellable(inv?.onHand ?? 0, inv?.reserved ?? 0, inv?.walmartAllocation ?? null)
```
Add a one-paragraph doc comment above `pushInventoryForVariant`: the percentage buffer was removed 2026-09-24 because it told Walmart 0 for every one-off; split allocation cannot double-sell, and shared stock is a deliberate risk (spec §5.1).

- [ ] **Step 9: Public availability — `catalog.service.ts` `getAvailability`**

```ts
    available: storefrontSellable(v.inventory?.onHand ?? 0, v.inventory?.reserved ?? 0, v.inventory?.walmartAllocation ?? null),
```
with `import { storefrontSellable } from '../inventory/allocation.js'`.

- [ ] **Step 9b: Drop the buffer column and its option**

In `schema.prisma` `model ChannelListing`, delete `bufferPct            Int?                 @map("buffer_pct")`. Create the migration:
```sql
-- prisma/migrations/20260924120100_drop_listing_buffer_pct/migration.sql
-- The percentage buffer is replaced by the per-variant Walmart allocation
-- (spec 2026-09-24 §5.1 rule 5): it told Walmart 0 for every one-off.
-- No listings exist on any environment.
ALTER TABLE "channel_listings" DROP COLUMN "buffer_pct";
```
Run `npx prisma migrate deploy && npx prisma generate`. In `src/channels/walmart/listings.service.ts` change the options type to `opts: { priceOverrideCents?: number } = {}` and the create data to `data: { variantId, walmartSku, priceOverrideCents: opts.priceOverrideCents }`. Run `npx tsc --noEmit` and remove every remaining `bufferPct` reference it reports.

- [ ] **Step 10: Rewrite the buffer tests in `tests/walmart-inventory-sync.test.ts`**

Replace the whole `describe('computeAvailableToSell', …)` block with:
```ts
// The 10%-min-1 buffer was removed 2026-09-24 (spec §5.1 rule 5): it told
// Walmart 0 for every one-off. The figure pushed is walmartSellable, whose
// unit tests live in allocation.test.ts.
```
Change the import list to drop `computeAvailableToSell`. Change `seed` to:
```ts
async function seed(onHand: number, reserved: number, walmartAllocation: number | null = null) {
  const p = await prisma.product.create({ data: { slug: 's', name: 'S', productType: 'own_designed', status: 'published' } })
  const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-9', priceCents: 1000 } })
  await prisma.inventory.create({ data: { variantId: v.id, onHand, reserved, walmartAllocation } })
  await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-9-W', status: 'live' } })
  return v
}
```
In `'pushes ATS for a live listing…'` the expected amount becomes `8` (10 − 2, no buffer) and `lastPushedQty` `8`.

- [ ] **Step 11: Run the whole suite**

Run: `npx vitest run`
Expected: PASS. Any other test whose expected Walmart quantity changed did so **because the buffer is gone** — update each expectation deliberately, and list every such file in the PR description as an intended behaviour change. Do not re-baseline anything else.

- [ ] **Step 12: Write the concurrency test**

```ts
// tests/allocation-concurrency.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb, ensureSystemActor } from './helpers/db.js'
import { placeOrder } from '../src/orders/orders.service.js'
import { ingestWalmartOrder } from '../src/channels/walmart/orders.ingest.js'
import { walmartOrderFixture } from './helpers/walmart-fixtures.js'

// Split stock must be un-oversellable: a storefront checkout and a Walmart
// ingest racing for one variant can each take only their own share.
// Verified non-vacuous by mutation (see PR): dropping
// "- COALESCE(walmart_allocation, 0)" from placeOrder's guard makes this fail.
beforeEach(async () => { await resetDb(); await ensureSystemActor() })
afterAll(() => prisma.$disconnect())

function walmartPo(n: number) {
  return { ...walmartOrderFixture, purchaseOrderId: `PO-RACE-${n}`, customerOrderId: `CO-RACE-${n}` }
}

describe('allocation under concurrency', () => {
  it('storefront never takes Walmart units and neither side oversells', async () => {
    for (let round = 0; round < 10; round++) {
      await resetDb(); await ensureSystemActor()
      const p = await prisma.product.create({ data: { slug: 'r', name: 'R', productType: 'resale', status: 'published' } })
      const v = await prisma.variant.create({ data: { productId: p.id, sku: 'ABE-SET-001', priceCents: 4999 } })
      // 4 on hand: 2 for Walmart (one PO of qty 2), 2 for the storefront.
      await prisma.inventory.create({ data: { variantId: v.id, onHand: 4, walmartAllocation: 2 } })
      await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-SET-001-W', status: 'live' } })

      await Promise.allSettled([
        ...Array.from({ length: 6 }, () =>
          placeOrder({ email: 'r@example.com', shipToState: 'MI', lines: [{ variantId: v.id, quantity: 1 }] })),
        ...Array.from({ length: 3 }, (_, i) => ingestWalmartOrder(walmartPo(round * 10 + i), 'webhook')),
      ])

      const i = await prisma.inventory.findUniqueOrThrow({ where: { variantId: v.id } })
      const storefrontReserved = await prisma.orderLine.aggregate({
        where: { variantId: v.id, order: { channel: 'storefront' } }, _sum: { quantity: true },
      })
      expect(i.reserved + (i.walmartAllocation ?? 0)).toBeLessThanOrEqual(i.onHand)
      expect(storefrontReserved._sum.quantity ?? 0).toBeLessThanOrEqual(2)
      expect(i.walmartAllocation).toBe(0)
      expect(i.reserved).toBe(4)
    }
  })
})
```

- [ ] **Step 13: Run it, then prove it is not vacuous**

Run: `npx vitest run tests/allocation-concurrency.test.ts` — Expected: PASS.
Then temporarily delete `- COALESCE(walmart_allocation, 0)` from the `placeOrder` guard, re-run — Expected: FAIL (storefront reserved > 2). Restore with `git checkout -- src/orders/orders.service.ts` **only if** Step 5's edit was already committed; otherwise re-apply Step 5 exactly. Run 5 times in a row: `for i in 1 2 3 4 5; do npx vitest run tests/allocation-concurrency.test.ts || break; done` — Expected: 5 passes.

- [ ] **Step 14: Commit**

```bash
git add prisma src tests
git commit -m "feat(core): per-variant Walmart allocation in checkout, ingest, cancel, push and availability; drop buffer_pct"
```

---

## Task 3: Errors with fields and details

**Files:**
- Create: `systems/core/src/admin/admin-errors.ts`
- Modify: `systems/core/src/admin/admin-catalog.service.ts` (remove class, re-export)
- Modify: `systems/core/src/admin/admin-catalog.routes.ts` (`STATUS_BY_CODE`, `fail`)
- Test: `systems/core/tests/admin-errors.test.ts`

**Interfaces:**
- Produces: `class AdminError(code: string, message: string, fields?: Record<string,string>, details?: Record<string,unknown>)`; `mapUniqueViolation(e: unknown): unknown`; `fail(res, err)` now serialises `fields` and `details`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/admin-errors.test.ts
import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import { AdminError, mapUniqueViolation } from '../src/admin/admin-errors.js'
import { AdminError as ReExported } from '../src/admin/admin-catalog.service.js'

const p2002 = (target: unknown) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'x', meta: { target } })

describe('AdminError', () => {
  it('carries fields and details', () => {
    const e = new AdminError('VALIDATION_ERROR', 'bad', { name: 'required' }, { onHand: 1 })
    expect([e.code, e.fields, e.details]).toEqual(['VALIDATION_ERROR', { name: 'required' }, { onHand: 1 }])
  })
  it('is the same class through the old import path', () => {
    expect(ReExported).toBe(AdminError)
  })
})

describe('mapUniqueViolation', () => {
  it('maps a slug collision', () => {
    expect(mapUniqueViolation(p2002(['slug']))).toMatchObject({ code: 'SLUG_TAKEN', fields: { slug: 'already in use' } })
  })
  it('maps a sku collision, including by constraint name', () => {
    expect(mapUniqueViolation(p2002('variants_sku_key'))).toMatchObject({ code: 'SKU_TAKEN' })
  })
  it('passes anything else through untouched', () => {
    const other = new Error('x')
    expect(mapUniqueViolation(other)).toBe(other)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/admin-errors.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Create `src/admin/admin-errors.ts`**

```ts
import { Prisma } from '@prisma/client'

/**
 * Admin API error. `fields` maps an input field to a message the console
 * renders beside it; `details` carries structured data a client needs to
 * recover (e.g. current stock on STOCK_CHANGED).
 */
export class AdminError extends Error {
  constructor(
    public code: string,
    message: string,
    public fields?: Record<string, string>,
    public details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AdminError'
  }
}

/**
 * Turn a unique-constraint violation into the matching AdminError. Taken from
 * the constraint itself rather than a read-then-write check, so two concurrent
 * creates cannot both pass (spec §3).
 */
export function mapUniqueViolation(e: unknown): unknown {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    const target = String((e.meta as { target?: unknown } | undefined)?.target ?? '')
    if (target.includes('slug')) {
      return new AdminError('SLUG_TAKEN', 'that slug is already used by another product', { slug: 'already in use' })
    }
    if (target.includes('sku')) {
      return new AdminError('SKU_TAKEN', 'that SKU is already used by another variant', { sku: 'already in use' })
    }
  }
  return e
}
```

- [ ] **Step 4: Re-export from the service**

In `admin-catalog.service.ts` delete the `AdminError` class and add at the top:
```ts
import { AdminError } from './admin-errors.js'
export { AdminError }
```

- [ ] **Step 5: Extend the router's `fail` and status map**

```ts
const STATUS_BY_CODE: Record<string, number> = {
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  INVALID_TRANSITION: 409,
  SLUG_TAKEN: 409,
  SKU_TAKEN: 409,
  SLUG_LOCKED: 409,
  SKU_LOCKED: 409,
  VARIANT_HAS_SALES: 409,
  STOCK_BELOW_RESERVED: 409,
  STOCK_CHANGED: 409,
  ALLOCATION_EXCEEDS_AVAILABLE: 409,
}

function fail(res: Response, err: unknown) {
  if (err instanceof AdminError) {
    return res.status(STATUS_BY_CODE[err.code] ?? 400).json({
      code: err.code,
      message: err.message,
      ...(err.fields ? { fields: err.fields } : {}),
      ...(err.details ? { details: err.details } : {}),
    })
  }
  // (existing unknown-error branch unchanged)
```

- [ ] **Step 6: Run and commit**

Run: `npx vitest run tests/admin-errors.test.ts tests/admin-routes.test.ts tests/admin-catalog-failure.test.ts` — Expected: PASS.
```bash
git add src/admin tests/admin-errors.test.ts
git commit -m "feat(core): admin errors carry fields and details; unique violations map to SLUG_TAKEN/SKU_TAKEN"
```

---

## Task 4: Input parsers

**Files:**
- Create: `systems/core/src/admin/product-input.ts`
- Test: `systems/core/tests/product-input.test.ts`

**Interfaces:**
- Produces:
  - `slugify(input: string): string`
  - `type ProductData = { name?: string; slug?: string; productType?: 'own_designed'|'resale'; releaseType?: 'standard'|'limited_run'|'specialty'; description?: string; longDescription?: string; builderNotes?: string; categories?: string[]; features?: string[]; includes?: string[]; pieces?: number|null; difficulty?: 'beginner'|'intermediate'|'advanced'|'expert'|null; ageRecommendation?: string|null; dimensions?: string|null; homePosition?: number|null; collectionPosition?: number|null }`
  - `parseProductInput(body: unknown, mode: 'create'|'patch'): ProductData` — on create, `name`, `productType` and a derived `slug` are always present.
  - `type VariantData = { sku?: string; priceCents?: number; attributes?: Record<string,string>; onHand?: number }`
  - `parseVariantInput(body: unknown, mode: 'create'|'patch', prefix?: string): VariantData`
  - `type StockData = { onHand?: number; allocationProvided: boolean; walmartAllocation: number|null; expectedOnHand?: number; note?: string }`
  - `parseStockInput(body: unknown): StockData`
  - All throw `AdminError('VALIDATION_ERROR', 'invalid input', fields)`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/product-input.test.ts
import { describe, it, expect } from 'vitest'
import { parseProductInput, parseVariantInput, parseStockInput, slugify } from '../src/admin/product-input.js'

function fieldsOf(fn: () => unknown): Record<string, string> {
  try { fn() } catch (e: any) { expect(e.code).toBe('VALIDATION_ERROR'); return e.fields ?? {} }
  throw new Error('expected a VALIDATION_ERROR')
}

describe('slugify', () => {
  it('lowercases, hyphenates and trims', () => expect(slugify('  Deep Sea — Explorer!! ')).toBe('deep-sea-explorer'))
  it('caps at 80 without a trailing hyphen', () => {
    const s = slugify('a'.repeat(79) + ' b')
    expect(s.length).toBeLessThanOrEqual(80)
    expect(s.endsWith('-')).toBe(false)
  })
})

describe('parseProductInput create', () => {
  it('requires name and productType and derives the slug', () => {
    expect(parseProductInput({ name: 'Castle Set', productType: 'resale' }, 'create'))
      .toEqual({ name: 'Castle Set', productType: 'resale', slug: 'castle-set' })
  })
  it('reports every missing required field at once', () => {
    expect(Object.keys(fieldsOf(() => parseProductInput({}, 'create'))).sort()).toEqual(['name', 'productType'])
  })
  it('rejects a name with no letters or digits', () => {
    expect(fieldsOf(() => parseProductInput({ name: '!!!', productType: 'resale' }, 'create'))).toHaveProperty('name')
  })
})

describe('parseProductInput patch', () => {
  it('accepts a partial body', () => {
    expect(parseProductInput({ pieces: 1200 }, 'patch')).toEqual({ pieces: 1200 })
  })
  it('rejects unknown and read-only keys', () => {
    const f = fieldsOf(() => parseProductInput({ nmae: 'x', status: 'published', firstPublishedAt: null }, 'patch'))
    expect(Object.keys(f).sort()).toEqual(['firstPublishedAt', 'nmae', 'status'])
  })
  it('validates every rule in spec §4.1', () => {
    const f = fieldsOf(() => parseProductInput({
      slug: 'Bad Slug', releaseType: 'x', pieces: 0, difficulty: 'hard', homePosition: 1.5,
      categories: ['OK tag'], features: [''], ageRecommendation: 'x'.repeat(21), description: 'x'.repeat(501),
    }, 'patch'))
    expect(Object.keys(f).sort()).toEqual(
      ['ageRecommendation', 'categories', 'description', 'difficulty', 'features', 'homePosition', 'pieces', 'releaseType', 'slug'])
  })
  it('allows clearing nullable fields', () => {
    expect(parseProductInput({ pieces: null, difficulty: null, dimensions: null }, 'patch'))
      .toEqual({ pieces: null, difficulty: null, dimensions: null })
  })
  it('lowercases and de-duplicates categories, trims list entries', () => {
    expect(parseProductInput({ categories: ['Star-Wars', 'star-wars'], features: [' Lights '] }, 'patch'))
      .toEqual({ categories: ['star-wars'], features: ['Lights'] })
  })
})

describe('parseVariantInput', () => {
  it('upper-cases the SKU and requires sku and price on create', () => {
    expect(parseVariantInput({ sku: 'abe-1001', priceCents: 1999, onHand: 3 }, 'create'))
      .toEqual({ sku: 'ABE-1001', priceCents: 1999, onHand: 3 })
    expect(Object.keys(fieldsOf(() => parseVariantInput({}, 'create'))).sort()).toEqual(['priceCents', 'sku'])
  })
  it('enforces price > 0, USD only, attribute limits, no onHand on patch', () => {
    const f = fieldsOf(() => parseVariantInput({ priceCents: 0, currency: 'EUR', attributes: { '': 'x' }, onHand: 1 }, 'patch'))
    expect(Object.keys(f).sort()).toEqual(['attributes', 'currency', 'onHand', 'priceCents'])
  })
  it('prefixes field names for bulk rows', () => {
    expect(fieldsOf(() => parseVariantInput({ sku: '', priceCents: 1 }, 'create', 'variants.2.'))).toHaveProperty('variants.2.sku')
  })
})

describe('parseStockInput', () => {
  it('distinguishes "not sent" from "shared" for allocation', () => {
    expect(parseStockInput({ onHand: 3 })).toEqual({ onHand: 3, allocationProvided: false, walmartAllocation: null })
    expect(parseStockInput({ walmartAllocation: null })).toEqual({ allocationProvided: true, walmartAllocation: null })
    expect(parseStockInput({ walmartAllocation: 1, expectedOnHand: 1, note: 'lot 7' }))
      .toEqual({ allocationProvided: true, walmartAllocation: 1, expectedOnHand: 1, note: 'lot 7' })
  })
  it('requires at least one of onHand / walmartAllocation, and valid integers', () => {
    expect(fieldsOf(() => parseStockInput({}))).toHaveProperty('onHand')
    expect(Object.keys(fieldsOf(() => parseStockInput({ onHand: -1, walmartAllocation: 1.5, note: 'x'.repeat(501) }))).sort())
      .toEqual(['note', 'onHand', 'walmartAllocation'])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/product-input.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/admin/product-input.ts`**

```ts
import { AdminError } from './admin-errors.js'

type Fields = Record<string, string>
type Obj = Record<string, unknown>

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const SKU_RE = /^[A-Z0-9]+(-[A-Z0-9]+)*$/
const PRODUCT_TYPES = ['own_designed', 'resale'] as const
const RELEASE_TYPES = ['standard', 'limited_run', 'specialty'] as const
const DIFFICULTIES = ['beginner', 'intermediate', 'advanced', 'expert'] as const

export type ProductData = {
  name?: string; slug?: string
  productType?: (typeof PRODUCT_TYPES)[number]; releaseType?: (typeof RELEASE_TYPES)[number]
  description?: string; longDescription?: string; builderNotes?: string
  categories?: string[]; features?: string[]; includes?: string[]
  pieces?: number | null; difficulty?: (typeof DIFFICULTIES)[number] | null
  ageRecommendation?: string | null; dimensions?: string | null
  homePosition?: number | null; collectionPosition?: number | null
}
export type VariantData = { sku?: string; priceCents?: number; attributes?: Record<string, string>; onHand?: number }
export type StockData = {
  onHand?: number; allocationProvided: boolean; walmartAllocation: number | null
  expectedOnHand?: number; note?: string
}

const PRODUCT_KEYS = [
  'name', 'slug', 'productType', 'releaseType', 'description', 'longDescription', 'builderNotes',
  'categories', 'features', 'includes', 'pieces', 'difficulty', 'ageRecommendation', 'dimensions',
  'homePosition', 'collectionPosition',
]

export function slugify(input: string): string {
  return String(input).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 80).replace(/-+$/, '')
}

function asObject(body: unknown): Obj {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AdminError('VALIDATION_ERROR', 'body must be a JSON object')
  }
  return body as Obj
}
function done(fields: Fields) {
  if (Object.keys(fields).length > 0) throw new AdminError('VALIDATION_ERROR', 'invalid input', fields)
}
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

function text(b: Obj, key: string, max: number, out: Obj, f: Fields) {
  if (!(key in b)) return
  const v = b[key]
  if (typeof v !== 'string' || v.length > max) f[key] = `text, at most ${max} characters`
  else out[key] = v
}
function nullableText(b: Obj, key: string, max: number, out: Obj, f: Fields) {
  if (!(key in b)) return
  const v = b[key]
  if (v === null || v === '') { out[key] = null; return }
  if (typeof v !== 'string' || v.trim().length > max) f[key] = `text, at most ${max} characters, or empty`
  else out[key] = v.trim()
}
function nullableInt(b: Obj, key: string, min: number, out: Obj, f: Fields) {
  if (!(key in b)) return
  const v = b[key]
  if (v === null) { out[key] = null; return }
  if (!isInt(v) || v < min) f[key] = `a whole number of at least ${min}, or empty`
  else out[key] = v
}
function oneOf(b: Obj, key: string, allowed: readonly string[], nullable: boolean, out: Obj, f: Fields) {
  if (!(key in b)) return
  const v = b[key]
  if (nullable && v === null) { out[key] = null; return }
  if (typeof v !== 'string' || !allowed.includes(v)) f[key] = `one of: ${allowed.join(', ')}`
  else out[key] = v
}
function list(b: Obj, key: string, maxItems: number, maxLen: number, out: Obj, f: Fields) {
  if (!(key in b)) return
  const v = b[key]
  if (!Array.isArray(v) || v.length > maxItems) { f[key] = `a list of at most ${maxItems} entries`; return }
  const items = v.map((x) => (typeof x === 'string' ? x.trim() : ''))
  if (items.some((x) => x.length < 1 || x.length > maxLen)) { f[key] = `each entry 1–${maxLen} characters`; return }
  out[key] = items
}

export function parseProductInput(body: unknown, mode: 'create' | 'patch'): ProductData {
  const b = asObject(body)
  const f: Fields = {}
  const out: Obj = {}

  for (const k of Object.keys(b)) if (!PRODUCT_KEYS.includes(k)) f[k] = 'unknown or read-only field'

  if ('name' in b || mode === 'create') {
    const v = b.name
    if (typeof v !== 'string' || v.trim().length < 1 || v.trim().length > 200) f.name = 'required, 1–200 characters'
    else out.name = v.trim()
  }
  if ('slug' in b) {
    const v = b.slug
    if (typeof v !== 'string' || v.length > 80 || !SLUG_RE.test(v)) {
      f.slug = 'lowercase letters, numbers and single hyphens, at most 80 characters'
    } else out.slug = v
  }
  if ('productType' in b || mode === 'create') oneOf({ productType: b.productType }, 'productType', PRODUCT_TYPES, false, out, f)
  oneOf(b, 'releaseType', RELEASE_TYPES, false, out, f)
  oneOf(b, 'difficulty', DIFFICULTIES, true, out, f)
  text(b, 'description', 500, out, f)
  text(b, 'longDescription', 10_000, out, f)
  text(b, 'builderNotes', 5_000, out, f)
  nullableText(b, 'ageRecommendation', 20, out, f)
  nullableText(b, 'dimensions', 100, out, f)
  nullableInt(b, 'pieces', 1, out, f)
  nullableInt(b, 'homePosition', 1, out, f)
  nullableInt(b, 'collectionPosition', 1, out, f)
  list(b, 'features', 30, 200, out, f)
  list(b, 'includes', 30, 200, out, f)

  if ('categories' in b) {
    const v = b.categories
    const tags = Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.trim().toLowerCase() : '')) : null
    if (!tags || tags.length > 20 || tags.some((t) => !SLUG_RE.test(t))) {
      f.categories = 'at most 20 tags, each lowercase letters, numbers and hyphens'
    } else out.categories = [...new Set(tags)]
  }

  if (mode === 'create' && out.slug === undefined && typeof out.name === 'string') {
    const derived = slugify(out.name)
    if (!derived) f.name = 'must contain at least one letter or number'
    else out.slug = derived
  }

  done(f)
  return out as ProductData
}

const VARIANT_CREATE_KEYS = ['sku', 'priceCents', 'currency', 'attributes', 'onHand']
const VARIANT_PATCH_KEYS = ['sku', 'priceCents', 'currency', 'attributes']

export function parseVariantInput(body: unknown, mode: 'create' | 'patch', prefix = ''): VariantData {
  const b = asObject(body)
  const f: Fields = {}
  const out: VariantData = {}
  const allowed = mode === 'create' ? VARIANT_CREATE_KEYS : VARIANT_PATCH_KEYS

  for (const k of Object.keys(b)) if (!allowed.includes(k)) f[prefix + k] = 'unknown or read-only field'

  if ('sku' in b || mode === 'create') {
    const v = typeof b.sku === 'string' ? b.sku.trim().toUpperCase() : ''
    if (v.length < 1 || v.length > 64 || !SKU_RE.test(v)) {
      f[prefix + 'sku'] = 'capital letters, numbers and single hyphens, at most 64 characters'
    } else out.sku = v
  }
  if ('priceCents' in b || mode === 'create') {
    const v = b.priceCents
    if (!isInt(v) || v <= 0 || v > 100_000_000) f[prefix + 'priceCents'] = 'a price above $0'
    else out.priceCents = v
  }
  if ('currency' in b && b.currency !== 'USD') f[prefix + 'currency'] = 'USD only'
  if ('attributes' in b) {
    const v = b.attributes
    const ok = typeof v === 'object' && v !== null && !Array.isArray(v)
      && Object.keys(v).length <= 10
      && Object.entries(v as Obj).every(([k, x]) =>
        k.length >= 1 && k.length <= 40 && typeof x === 'string' && x.length >= 1 && x.length <= 100)
    if (!ok) f[prefix + 'attributes'] = 'up to 10 name/value pairs; names 1–40, values 1–100 characters'
    else out.attributes = v as Record<string, string>
  }
  if ('onHand' in b && mode === 'create') {
    if (!isInt(b.onHand) || b.onHand < 0) f[prefix + 'onHand'] = 'a whole number, 0 or more'
    else out.onHand = b.onHand
  }

  done(f)
  return out
}

const STOCK_KEYS = ['onHand', 'walmartAllocation', 'expectedOnHand', 'note']

export function parseStockInput(body: unknown): StockData {
  const b = asObject(body)
  const f: Fields = {}
  const out: StockData = { allocationProvided: false, walmartAllocation: null }

  for (const k of Object.keys(b)) if (!STOCK_KEYS.includes(k)) f[k] = 'unknown field'
  if (!('onHand' in b) && !('walmartAllocation' in b)) f.onHand = 'send onHand, walmartAllocation, or both'

  if ('onHand' in b) {
    if (!isInt(b.onHand) || b.onHand < 0) f.onHand = 'a whole number, 0 or more'
    else out.onHand = b.onHand
  }
  if ('walmartAllocation' in b) {
    out.allocationProvided = true
    const v = b.walmartAllocation
    if (v !== null && (!isInt(v) || v < 0)) f.walmartAllocation = 'a whole number, 0 or more, or null for shared'
    else out.walmartAllocation = v as number | null
  }
  if ('expectedOnHand' in b) {
    if (!isInt(b.expectedOnHand) || b.expectedOnHand < 0) f.expectedOnHand = 'a whole number, 0 or more'
    else out.expectedOnHand = b.expectedOnHand
  }
  if ('note' in b) {
    if (typeof b.note !== 'string' || b.note.length > 500) f.note = 'text, at most 500 characters'
    else out.note = b.note
  }

  done(f)
  return out
}
```

Note `oneOf` for a required `productType` on create: when the key is absent, `{ productType: undefined }` still has the key, so `oneOf` reports it — that is what makes "reports every missing required field at once" pass.

- [ ] **Step 4: Run and commit**

Run: `npx vitest run tests/product-input.test.ts` — Expected: PASS.
```bash
git add src/admin/product-input.ts tests/product-input.test.ts
git commit -m "feat(core): input parsers for product, variant and stock writes"
```

---

## Task 5: Admin product DTO with inventory and locks

**Files:**
- Create: `systems/core/src/admin/admin-product.dto.ts`
- Modify: `systems/core/src/admin/admin-catalog.service.ts` (`adminGetProduct` body; `setProductStatus` return type)
- Test: `systems/core/tests/admin-product-dto.test.ts`

**Interfaces:**
- Produces:
```ts
export interface AdminVariantDto {
  id: string; sku: string; priceCents: number; currency: string
  attributes: Record<string, string>
  inventory: { onHand: number; reserved: number; walmartAllocation: number | null; storefrontAvailable: number; walmartAvailable: number }
  locked: { sku: boolean; delete: boolean }
}
export type AdminProductDto = Omit<ProductDto, 'variants'> & {
  firstPublishedAt: Date | null
  locked: { slug: boolean }
  variants: AdminVariantDto[]
}
export async function loadAdminProduct(id: string): Promise<AdminProductDto | null>
```
- `adminGetProduct(id)` returns `loadAdminProduct(id)`; `setProductStatus` returns `Promise<AdminProductDto>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/admin-product-dto.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb, ensureSystemActor } from './helpers/db.js'
import { loadAdminProduct } from '../src/admin/admin-product.dto.js'

beforeEach(async () => { await resetDb(); await ensureSystemActor() })
afterAll(() => prisma.$disconnect())

async function product(firstPublishedAt: Date | null = null) {
  return prisma.product.create({ data: { slug: 'p', name: 'P', productType: 'resale', firstPublishedAt } })
}
async function variant(productId: string, sku: string, onHand = 5, reserved = 1, walmartAllocation: number | null = 2) {
  const v = await prisma.variant.create({ data: { productId, sku, priceCents: 1000, attributes: { condition: 'sealed' } } })
  await prisma.inventory.create({ data: { variantId: v.id, onHand, reserved, walmartAllocation } })
  return v
}

describe('loadAdminProduct', () => {
  it('returns null for an unknown id', async () => {
    expect(await loadAdminProduct('nope')).toBeNull()
  })

  it('reports inventory for each channel and the attributes', async () => {
    const p = await product()
    await variant(p.id, 'A-1')
    const dto = await loadAdminProduct(p.id)
    expect(dto!.variants[0]).toMatchObject({
      sku: 'A-1', attributes: { condition: 'sealed' },
      inventory: { onHand: 5, reserved: 1, walmartAllocation: 2, storefrontAvailable: 2, walmartAvailable: 2 },
      locked: { sku: false, delete: false },
    })
  })

  it('reports a variant without an inventory row as zero stock', async () => {
    const p = await product()
    await prisma.variant.create({ data: { productId: p.id, sku: 'B-1', priceCents: 100 } })
    expect((await loadAdminProduct(p.id))!.variants[0].inventory)
      .toEqual({ onHand: 0, reserved: 0, walmartAllocation: null, storefrontAvailable: 0, walmartAvailable: 0 })
  })

  it('locks the slug once first published', async () => {
    expect((await loadAdminProduct((await product()).id))!.locked.slug).toBe(false)
    await resetDb()
    expect((await loadAdminProduct((await product(new Date())).id))!.locked.slug).toBe(true)
  })

  it('locks SKU and delete for a sold variant and for a non-retired listing, not for a retired one', async () => {
    const p = await product()
    const sold = await variant(p.id, 'S-1')
    const listed = await variant(p.id, 'L-1')
    const retired = await variant(p.id, 'R-1')
    const order = await prisma.order.create({ data: {
      email: 'a@example.com', shipToState: 'MI', status: 'paid', subtotalCents: 1000, taxCents: 0, totalCents: 1000,
      taxRateBps: 0, taxJurisdiction: 'MI', lines: { create: [{ variantId: sold.id, sku: 'S-1', quantity: 1, unitPriceCents: 1000, lineSubtotalCents: 1000 }] },
    } })
    expect(order.id).toBeTruthy()
    await prisma.channelListing.create({ data: { variantId: listed.id, walmartSku: 'L-1-W', status: 'live' } })
    await prisma.channelListing.create({ data: { variantId: retired.id, walmartSku: 'R-1-W', status: 'retired' } })
    const bySku = Object.fromEntries((await loadAdminProduct(p.id))!.variants.map((v) => [v.sku, v.locked]))
    expect(bySku).toEqual({
      'L-1': { sku: true, delete: true },
      'R-1': { sku: false, delete: false },
      'S-1': { sku: true, delete: true },
    })
  })
})
```

If `prisma.order.create` rejects on a required column this test omits (the Order model may have gained columns), read `model Order` in the schema and add exactly the missing required fields — do not loosen the test otherwise.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/admin-product-dto.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/admin/admin-product.dto.ts`**

```ts
import { prisma } from '../prisma.js'
import type { ProductDto } from '../catalog/catalog.service.js'
import { storefrontSellable, walmartSellable } from '../inventory/allocation.js'

export interface AdminVariantDto {
  id: string; sku: string; priceCents: number; currency: string
  attributes: Record<string, string>
  inventory: { onHand: number; reserved: number; walmartAllocation: number | null; storefrontAvailable: number; walmartAvailable: number }
  locked: { sku: boolean; delete: boolean }
}

export type AdminProductDto = Omit<ProductDto, 'variants'> & {
  firstPublishedAt: Date | null
  locked: { slug: boolean }
  variants: AdminVariantDto[]
}

const asStrings = (j: unknown): string[] => (Array.isArray(j) ? (j as string[]) : [])

/**
 * The admin view of one product, in any status. Every product and variant
 * write returns this, so the console re-renders from the server's truth.
 *
 * A variant is locked (SKU and delete) once it has any order line or any
 * channel listing that is not retired (spec §4.2).
 */
export async function loadAdminProduct(id: string): Promise<AdminProductDto | null> {
  const p = await prisma.product.findUnique({
    where: { id },
    include: {
      images: { where: { status: 'ready' }, orderBy: { position: 'asc' } },
      variants: {
        orderBy: { sku: 'asc' },
        include: { inventory: true, channelListing: true, _count: { select: { orderLines: true } } },
      },
    },
  })
  if (!p) return null

  return {
    id: p.id, slug: p.slug, name: p.name, description: p.description,
    productType: p.productType, releaseType: p.releaseType, status: p.status,
    images: p.images.map((i) => ({ storageKey: i.storageKey, alt: i.alt, width: i.width, height: i.height, position: i.position })),
    categories: asStrings(p.categories),
    pieces: p.pieces ?? null,
    difficulty: p.difficulty ?? null,
    ageRecommendation: p.ageRecommendation ?? null,
    dimensions: p.dimensions ?? null,
    longDescription: p.longDescription ?? '',
    features: asStrings(p.features),
    includes: asStrings(p.includes),
    builderNotes: p.builderNotes ?? '',
    homePosition: p.homePosition ?? null,
    collectionPosition: p.collectionPosition ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    firstPublishedAt: p.firstPublishedAt,
    locked: { slug: p.firstPublishedAt !== null },
    variants: p.variants.map((v) => {
      const onHand = v.inventory?.onHand ?? 0
      const reserved = v.inventory?.reserved ?? 0
      const walmartAllocation = v.inventory?.walmartAllocation ?? null
      const locked = v._count.orderLines > 0 || (v.channelListing !== null && v.channelListing.status !== 'retired')
      return {
        id: v.id, sku: v.sku, priceCents: v.priceCents, currency: v.currency,
        attributes: (v.attributes && typeof v.attributes === 'object' && !Array.isArray(v.attributes)
          ? v.attributes : {}) as Record<string, string>,
        inventory: {
          onHand, reserved, walmartAllocation,
          storefrontAvailable: storefrontSellable(onHand, reserved, walmartAllocation),
          walmartAvailable: walmartSellable(onHand, reserved, walmartAllocation),
        },
        locked: { sku: locked, delete: locked },
      }
    }),
  }
}
```

- [ ] **Step 4: Delegate from the service**

In `admin-catalog.service.ts`: replace the body of `adminGetProduct` with `return loadAdminProduct(id)`, change its return type to `Promise<AdminProductDto | null>`, change `setProductStatus`'s return type to `Promise<AdminProductDto>`, and import `{ loadAdminProduct, type AdminProductDto }` from `./admin-product.dto.js`. Remove the now-unused `ProductDto` import if `tsc` says so.

- [ ] **Step 5: Run and commit**

Run: `npx vitest run tests/admin-product-dto.test.ts tests/admin-catalog-service.test.ts tests/admin-routes.test.ts && npx tsc --noEmit` — Expected: PASS, no type errors.
```bash
git add src/admin tests/admin-product-dto.test.ts
git commit -m "feat(core): admin product DTO reports per-channel stock and SKU/slug locks"
```

---

## Task 6: Product create, update and bulk status

**Files:**
- Create: `systems/core/src/admin/product-write.service.ts`
- Modify: `systems/core/src/admin/admin-catalog.routes.ts`
- Test: `systems/core/tests/product-write.test.ts`

**Interfaces:**
- Consumes: `parseProductInput`, `AdminError`, `mapUniqueViolation`, `loadAdminProduct`, `setProductStatus`, `recordAudit(input, tx)`.
- Produces:
  - `createProduct(body: unknown, actorId: string): Promise<AdminProductDto>`
  - `updateProduct(id: string, body: unknown, actorId: string): Promise<AdminProductDto>`
  - `bulkSetStatus(body: unknown, actorId: string): Promise<{ results: Array<{ id: string; ok: boolean; code?: string; message?: string }> }>`
  - Routes: `POST /products` → 201; `PATCH /products/:id` → 200; `POST /products/bulk-status` → 200.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/product-write.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createSession, SESSION_COOKIE } from '../src/auth/session.service.js'
import { setProductStatus } from '../src/admin/admin-catalog.service.js'
import { getProduct as publicGetProduct } from '../src/catalog/catalog.service.js'

const app = buildApp()
const ORIGIN = 'https://admin-staging.alpinebrickexchange.com'
let cookie: string
let actorId: string

beforeEach(async () => {
  await resetDb()
  process.env.ADMIN_CONSOLE_ORIGIN = ORIGIN
  actorId = (await prisma.actor.create({ data: { type: 'human', name: 'test-admin' } })).id
  cookie = `${SESSION_COOKIE}=${(await createSession(actorId)).token}`
})
afterAll(async () => { delete process.env.ADMIN_CONSOLE_ORIGIN; await prisma.$disconnect() })

const send = (method: 'post' | 'patch', path: string, body: unknown) =>
  request(app)[method](`/api/v1/admin${path}`)
    .set('Cookie', cookie).set('Origin', ORIGIN).set('Content-Type', 'application/json').send(body)

describe('POST /products', () => {
  it('creates a draft with a derived slug and audits it', async () => {
    const res = await send('post', '/products', { name: 'Castle Set', productType: 'resale', status: 'published' })
    expect(res.status).toBe(400) // status is not writable here
    const ok = await send('post', '/products', { name: 'Castle Set', productType: 'resale', pieces: 900 })
    expect(ok.status).toBe(201)
    expect(ok.body).toMatchObject({ slug: 'castle-set', status: 'draft', pieces: 900, locked: { slug: false }, variants: [] })
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'product.create' } })
    expect([audit.actorId, audit.target]).toEqual([actorId, `product:${ok.body.id}`])
  })

  it('returns field errors for bad input', async () => {
    const res = await send('post', '/products', { productType: 'toy' })
    expect(res.status).toBe(400)
    expect(Object.keys(res.body.fields).sort()).toEqual(['name', 'productType'])
  })

  it('reports SLUG_TAKEN from the unique constraint', async () => {
    await send('post', '/products', { name: 'Castle', productType: 'resale' })
    const res = await send('post', '/products', { name: 'Castle', productType: 'resale' })
    expect([res.status, res.body.code]).toEqual([409, 'SLUG_TAKEN'])
  })

  it('is not visible on the public storefront until published', async () => {
    const res = await send('post', '/products', { name: 'Hidden', productType: 'resale' })
    expect(await publicGetProduct(res.body.id)).toBeNull()
  })
})

describe('PATCH /products/:id', () => {
  async function created() {
    return (await send('post', '/products', { name: 'Castle', productType: 'resale' })).body
  }

  it('updates only what was sent and audits only what changed', async () => {
    const p = await created()
    const res = await send('patch', `/products/${p.id}`, { name: 'Castle', pieces: 1200, features: ['Lights'] })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ name: 'Castle', pieces: 1200, features: ['Lights'] })
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'product.update' } })
    expect(audit.before).toEqual({ pieces: null, features: [] })
    expect(audit.after).toEqual({ pieces: 1200, features: ['Lights'] })
  })

  it('writes no audit row for a no-op patch', async () => {
    const p = await created()
    await send('patch', `/products/${p.id}`, { name: 'Castle' })
    expect(await prisma.auditLog.count({ where: { action: 'product.update' } })).toBe(0)
  })

  it('allows a slug change before first publish', async () => {
    const p = await created()
    expect((await send('patch', `/products/${p.id}`, { slug: 'castle-2' })).body.slug).toBe('castle-2')
  })

  it('locks the slug after first publish, even once unpublished', async () => {
    const p = await created()
    await setProductStatus(p.id, 'published', actorId)
    await setProductStatus(p.id, 'draft', actorId)
    const res = await send('patch', `/products/${p.id}`, { slug: 'new-url' })
    expect([res.status, res.body.code]).toEqual([409, 'SLUG_LOCKED'])
    // Sending the unchanged slug is fine.
    expect((await send('patch', `/products/${p.id}`, { slug: 'castle' })).status).toBe(200)
  })

  it('edits a published product live', async () => {
    const p = await created()
    await setProductStatus(p.id, 'published', actorId)
    await send('patch', `/products/${p.id}`, { name: 'Castle Deluxe' })
    expect((await publicGetProduct(p.id))?.name).toBe('Castle Deluxe')
  })

  it('404s an unknown product', async () => {
    expect((await send('patch', '/products/nope', { name: 'x' })).status).toBe(404)
  })
})

describe('POST /products/bulk-status', () => {
  it('reports each product separately and does not roll back the others', async () => {
    const a = (await send('post', '/products', { name: 'A', productType: 'resale' })).body
    const b = (await send('post', '/products', { name: 'B', productType: 'resale' })).body
    await setProductStatus(b.id, 'archived', actorId)
    const res = await send('post', '/products/bulk-status', { ids: [a.id, b.id, 'nope'], status: 'published' })
    expect(res.status).toBe(200)
    expect(res.body.results).toEqual([
      { id: a.id, ok: true },
      { id: b.id, ok: false, code: 'INVALID_TRANSITION', message: expect.any(String) },
      { id: 'nope', ok: false, code: 'NOT_FOUND', message: expect.any(String) },
    ])
    expect((await prisma.product.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('published')
  })

  it('validates the body', async () => {
    expect((await send('post', '/products/bulk-status', { ids: [], status: 'published' })).status).toBe(400)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/product-write.test.ts` — Expected: FAIL (404s — routes do not exist).

- [ ] **Step 3: Implement `src/admin/product-write.service.ts`**

```ts
import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { recordAudit } from '../audit.js'
import { AdminError, mapUniqueViolation } from './admin-errors.js'
import { parseProductInput } from './product-input.js'
import { loadAdminProduct, type AdminProductDto } from './admin-product.dto.js'
import { setProductStatus } from './admin-catalog.service.js'

async function reload(id: string): Promise<AdminProductDto> {
  const p = await loadAdminProduct(id)
  if (!p) throw new AdminError('NOT_FOUND', 'product not found')
  return p
}

/** Always a draft, whatever the body says — publishing is its own act. */
export async function createProduct(body: unknown, actorId: string): Promise<AdminProductDto> {
  const data = parseProductInput(body, 'create')
  let id: string
  try {
    id = await prisma.$transaction(async (tx) => {
      // parseProductInput('create') guarantees name, slug and productType.
      const p = await tx.product.create({ data: { ...data, status: 'draft' } as Prisma.ProductUncheckedCreateInput })
      await recordAudit({ actorId, action: 'product.create', target: `product:${p.id}`, after: data }, tx)
      return p.id
    })
  } catch (e) {
    throw mapUniqueViolation(e)
  }
  return reload(id)
}

/**
 * Partial update. Only fields whose value actually changes are written and
 * audited; a no-op patch writes nothing.
 */
export async function updateProduct(id: string, body: unknown, actorId: string): Promise<AdminProductDto> {
  const data = parseProductInput(body, 'patch')
  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.product.findUnique({ where: { id } })
      if (!existing) throw new AdminError('NOT_FOUND', 'product not found')

      if (data.slug !== undefined && data.slug !== existing.slug && existing.firstPublishedAt !== null) {
        throw new AdminError(
          'SLUG_LOCKED',
          'the slug cannot change once a product has been published: its URL may already be linked or indexed',
          { slug: 'locked after first publish' },
        )
      }

      const before: Record<string, unknown> = {}
      const after: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(data)) {
        const old = (existing as Record<string, unknown>)[k]
        if (JSON.stringify(old ?? null) !== JSON.stringify(v ?? null)) { before[k] = old ?? null; after[k] = v }
      }
      if (Object.keys(after).length === 0) return

      await tx.product.update({ where: { id }, data: after })
      await recordAudit({ actorId, action: 'product.update', target: `product:${id}`, before, after }, tx)
    })
  } catch (e) {
    throw mapUniqueViolation(e)
  }
  return reload(id)
}

/**
 * Each product is its own transaction through setProductStatus, so one
 * refused transition never rolls back the others (spec §3).
 */
export async function bulkSetStatus(body: unknown, actorId: string) {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { ids?: unknown; status?: unknown }
  const ids = b.ids
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || !ids.every((x) => typeof x === 'string')) {
    throw new AdminError('VALIDATION_ERROR', 'invalid input', { ids: 'a list of 1–100 product ids' })
  }
  if (typeof b.status !== 'string') {
    throw new AdminError('VALIDATION_ERROR', 'invalid input', { status: 'required' })
  }
  const results: Array<{ id: string; ok: boolean; code?: string; message?: string }> = []
  for (const id of ids as string[]) {
    try {
      await setProductStatus(id, b.status, actorId)
      results.push({ id, ok: true })
    } catch (e) {
      if (!(e instanceof AdminError)) throw e
      results.push({ id, ok: false, code: e.code, message: e.message })
    }
  }
  return { results }
}
```

- [ ] **Step 4: Add the routes**

In `admin-catalog.routes.ts`, import `{ createProduct, updateProduct, bulkSetStatus }` from `./product-write.service.js` and add **above** the existing `get('/products/:id')`:
```ts
adminCatalogRouter.post('/products', async (req, res) => {
  try { res.status(201).json(await createProduct(req.body, req.actor!.id)) } catch (err) { fail(res, err) }
})

adminCatalogRouter.post('/products/bulk-status', async (req, res) => {
  try { res.json(await bulkSetStatus(req.body, req.actor!.id)) } catch (err) { fail(res, err) }
})

adminCatalogRouter.patch('/products/:id', async (req, res) => {
  try { res.json(await updateProduct(req.params.id, req.body, req.actor!.id)) } catch (err) { fail(res, err) }
})
```

- [ ] **Step 5: Atomicity — a failed audit rolls the change back (spec §8)**

```ts
// tests/admin-write-atomicity.test.ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

vi.mock('../src/audit.js', () => ({
  recordAudit: vi.fn(async () => { throw new Error('audit down') }),
}))

import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createProduct, updateProduct } from '../src/admin/product-write.service.js'

let actorId: string
beforeEach(async () => {
  await resetDb()
  actorId = (await prisma.actor.create({ data: { type: 'human', name: 't' } })).id
})
afterAll(() => prisma.$disconnect())

describe('a write whose audit fails is undone', () => {
  it('create', async () => {
    await expect(createProduct({ name: 'A', productType: 'resale' }, actorId)).rejects.toThrow('audit down')
    expect(await prisma.product.count()).toBe(0)
  })
  it('update', async () => {
    const p = await prisma.product.create({ data: { slug: 'a', name: 'A', productType: 'resale' } })
    await expect(updateProduct(p.id, { name: 'B' }, actorId)).rejects.toThrow('audit down')
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).name).toBe('A')
  })
})
```
Task 7 and Task 8 each append one case to this file for their own writes (a variant create; a stock set leaving `onHand` unchanged), importing their service the same way.

- [ ] **Step 6: Run and commit**

Run: `npx vitest run tests/product-write.test.ts tests/admin-write-atomicity.test.ts tests/admin-routes.test.ts tests/catalog.test.ts` — Expected: PASS.
```bash
git add src/admin tests/product-write.test.ts tests/admin-write-atomicity.test.ts
git commit -m "feat(core): create and edit products, bulk status, with audit and slug lock"
```

---

## Task 7: Variant create, bulk create, edit and delete

**Files:**
- Create: `systems/core/src/admin/variant-write.service.ts`
- Modify: `systems/core/src/admin/admin-catalog.routes.ts`
- Test: `systems/core/tests/variant-write.test.ts`

**Interfaces:**
- Consumes: `parseVariantInput`, `mapUniqueViolation`, `loadAdminProduct`, `recordAudit`.
- Produces:
  - `createVariant(productId: string, body: unknown, actorId: string): Promise<AdminProductDto>`
  - `bulkCreateVariants(productId: string, body: unknown, actorId: string): Promise<AdminProductDto>` — body `{ variants: VariantInput[] }`, 1–50 rows
  - `updateVariant(variantId: string, body: unknown, actorId: string): Promise<AdminProductDto>`
  - `deleteVariant(variantId: string, actorId: string): Promise<AdminProductDto>`
  - Routes: `POST /products/:id/variants` (201), `POST /products/:id/variants/bulk` (201), `PATCH /variants/:id`, `DELETE /variants/:id`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/variant-write.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createSession, SESSION_COOKIE } from '../src/auth/session.service.js'

const app = buildApp()
const ORIGIN = 'https://admin-staging.alpinebrickexchange.com'
let cookie: string
let productId: string

beforeEach(async () => {
  await resetDb()
  process.env.ADMIN_CONSOLE_ORIGIN = ORIGIN
  const actor = await prisma.actor.create({ data: { type: 'human', name: 'test-admin' } })
  cookie = `${SESSION_COOKIE}=${(await createSession(actor.id)).token}`
  productId = (await prisma.product.create({ data: { slug: 'p', name: 'P', productType: 'resale' } })).id
})
afterAll(async () => { delete process.env.ADMIN_CONSOLE_ORIGIN; await prisma.$disconnect() })

const send = (method: 'post' | 'patch' | 'delete', path: string, body: unknown = {}) =>
  request(app)[method](`/api/v1/admin${path}`)
    .set('Cookie', cookie).set('Origin', ORIGIN).set('Content-Type', 'application/json').send(body)

async function addVariant(sku = 'ABE-1', onHand?: number) {
  return send('post', `/products/${productId}/variants`, { sku, priceCents: 1999, ...(onHand !== undefined ? { onHand } : {}) })
}

describe('create', () => {
  it('adds a variant with an inventory row and starting stock', async () => {
    const res = await addVariant('abe-1', 3)
    expect(res.status).toBe(201)
    expect(res.body.variants[0]).toMatchObject({ sku: 'ABE-1', priceCents: 1999, inventory: { onHand: 3, walmartAllocation: null } })
    expect(await prisma.auditLog.count({ where: { action: 'variant.create' } })).toBe(1)
  })
  it('defaults stock to 0', async () => {
    expect((await addVariant()).body.variants[0].inventory.onHand).toBe(0)
  })
  it('reports SKU_TAKEN across products', async () => {
    await addVariant('ABE-1')
    const other = (await prisma.product.create({ data: { slug: 'q', name: 'Q', productType: 'resale' } })).id
    const res = await send('post', `/products/${other}/variants`, { sku: 'ABE-1', priceCents: 1 })
    expect([res.status, res.body.code]).toEqual([409, 'SKU_TAKEN'])
  })
  it('404s an unknown product', async () => {
    expect((await send('post', '/products/nope/variants', { sku: 'X-1', priceCents: 1 })).status).toBe(404)
  })
})

describe('bulk create', () => {
  it('creates all rows in one go', async () => {
    const res = await send('post', `/products/${productId}/variants/bulk`, {
      variants: [{ sku: 'B-S', priceCents: 100, attributes: { size: 'S' } }, { sku: 'B-M', priceCents: 100, attributes: { size: 'M' } }],
    })
    expect(res.status).toBe(201)
    expect(res.body.variants.map((v: any) => v.sku)).toEqual(['B-M', 'B-S'])
  })
  it('creates nothing when any row is invalid', async () => {
    const res = await send('post', `/products/${productId}/variants/bulk`, {
      variants: [{ sku: 'B-S', priceCents: 100 }, { sku: 'B-M', priceCents: 0 }],
    })
    expect(res.status).toBe(400)
    expect(res.body.fields).toHaveProperty(['variants.1.priceCents'])
    expect(await prisma.variant.count()).toBe(0)
  })
  it('rejects duplicate SKUs inside the batch', async () => {
    const res = await send('post', `/products/${productId}/variants/bulk`, {
      variants: [{ sku: 'B-S', priceCents: 1 }, { sku: 'b-s', priceCents: 1 }],
    })
    expect(res.status).toBe(400)
    expect(await prisma.variant.count()).toBe(0)
  })
})

describe('update and delete', () => {
  async function sell(variantId: string) {
    await prisma.order.create({ data: {
      email: 'a@example.com', shipToState: 'MI', status: 'paid', subtotalCents: 1999, taxCents: 0, totalCents: 1999,
      taxRateBps: 0, taxJurisdiction: 'MI',
      lines: { create: [{ variantId, sku: 'ABE-1', quantity: 1, unitPriceCents: 1999, lineSubtotalCents: 1999 }] },
    } })
  }

  it('edits price and attributes and audits the change', async () => {
    const v = (await addVariant()).body.variants[0]
    const res = await send('patch', `/variants/${v.id}`, { priceCents: 2499, attributes: { condition: 'sealed' } })
    expect(res.body.variants[0]).toMatchObject({ priceCents: 2499, attributes: { condition: 'sealed' } })
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'variant.update' } })
    expect(a.before).toEqual({ priceCents: 1999, attributes: {} })
  })

  it('renames an unsold SKU but refuses once sold', async () => {
    const v = (await addVariant()).body.variants[0]
    expect((await send('patch', `/variants/${v.id}`, { sku: 'ABE-2' })).body.variants[0].sku).toBe('ABE-2')
    await sell(v.id)
    const res = await send('patch', `/variants/${v.id}`, { sku: 'ABE-3' })
    expect([res.status, res.body.code]).toEqual([409, 'SKU_LOCKED'])
    // price is still editable on a sold variant
    expect((await send('patch', `/variants/${v.id}`, { priceCents: 100 })).status).toBe(200)
  })

  it('refuses a SKU change while a live Walmart listing exists, allows it once retired', async () => {
    const v = (await addVariant()).body.variants[0]
    const l = await prisma.channelListing.create({ data: { variantId: v.id, walmartSku: 'ABE-1-W', status: 'live' } })
    expect((await send('patch', `/variants/${v.id}`, { sku: 'ABE-9' })).body.code).toBe('SKU_LOCKED')
    await prisma.channelListing.update({ where: { id: l.id }, data: { status: 'retired' } })
    expect((await send('patch', `/variants/${v.id}`, { sku: 'ABE-9' })).status).toBe(200)
  })

  it('deletes an unsold variant, with its inventory, and audits it', async () => {
    const v = (await addVariant('ABE-1', 2)).body.variants[0]
    const res = await send('delete', `/variants/${v.id}`)
    expect([res.status, res.body.variants]).toEqual([200, []])
    expect(await prisma.inventory.count()).toBe(0)
    expect(await prisma.auditLog.count({ where: { action: 'variant.delete' } })).toBe(1)
  })

  it('refuses to delete a sold variant or one with a live listing', async () => {
    const sold = (await addVariant('ABE-1')).body.variants[0]
    await sell(sold.id)
    expect((await send('delete', `/variants/${sold.id}`)).body.code).toBe('VARIANT_HAS_SALES')
    const listed = (await addVariant('ABE-2')).body.variants.find((x: any) => x.sku === 'ABE-2')
    await prisma.channelListing.create({ data: { variantId: listed.id, walmartSku: 'ABE-2-W', status: 'submitted' } })
    expect((await send('delete', `/variants/${listed.id}`)).body.code).toBe('VARIANT_HAS_SALES')
    expect(await prisma.channelListing.count()).toBe(1)
  })

  it('404s an unknown variant', async () => {
    expect((await send('patch', '/variants/nope', { priceCents: 1 })).status).toBe(404)
    expect((await send('delete', '/variants/nope')).status).toBe(404)
  })
})
```

(Same caveat as Task 5 on `prisma.order.create` required columns.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/variant-write.test.ts` — Expected: FAIL (404s).

- [ ] **Step 3: Implement `src/admin/variant-write.service.ts`**

```ts
import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { recordAudit } from '../audit.js'
import { AdminError, mapUniqueViolation } from './admin-errors.js'
import { parseVariantInput, type VariantData } from './product-input.js'
import { loadAdminProduct, type AdminProductDto } from './admin-product.dto.js'

async function reload(productId: string): Promise<AdminProductDto> {
  const p = await loadAdminProduct(productId)
  if (!p) throw new AdminError('NOT_FOUND', 'product not found')
  return p
}

async function insert(tx: Prisma.TransactionClient, productId: string, v: VariantData, actorId: string) {
  const created = await tx.variant.create({
    data: {
      productId, sku: v.sku!, priceCents: v.priceCents!, attributes: v.attributes ?? {},
      inventory: { create: { onHand: v.onHand ?? 0 } },
    },
  })
  await recordAudit({
    actorId, action: 'variant.create', target: `variant:${created.id}`,
    after: { productId, sku: created.sku, priceCents: created.priceCents, attributes: v.attributes ?? {}, onHand: v.onHand ?? 0 },
  }, tx)
}

async function requireProduct(tx: Prisma.TransactionClient, productId: string) {
  if (!(await tx.product.findUnique({ where: { id: productId }, select: { id: true } }))) {
    throw new AdminError('NOT_FOUND', 'product not found')
  }
}

export async function createVariant(productId: string, body: unknown, actorId: string): Promise<AdminProductDto> {
  const v = parseVariantInput(body, 'create')
  try {
    await prisma.$transaction(async (tx) => {
      await requireProduct(tx, productId)
      await insert(tx, productId, v, actorId)
    })
  } catch (e) { throw mapUniqueViolation(e) }
  return reload(productId)
}

/** All-or-nothing: one bad row and nothing is created (spec §3). */
export async function bulkCreateVariants(productId: string, body: unknown, actorId: string): Promise<AdminProductDto> {
  const rows = (typeof body === 'object' && body !== null ? (body as { variants?: unknown }).variants : undefined)
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 50) {
    throw new AdminError('VALIDATION_ERROR', 'invalid input', { variants: 'a list of 1–50 variants' })
  }
  const fields: Record<string, string> = {}
  const parsed: VariantData[] = []
  rows.forEach((row, i) => {
    try { parsed.push(parseVariantInput(row, 'create', `variants.${i}.`)) } catch (e) {
      if (!(e instanceof AdminError) || !e.fields) throw e
      Object.assign(fields, e.fields)
    }
  })
  const seen = new Map<string, number>()
  parsed.forEach((v, i) => {
    if (seen.has(v.sku!)) fields[`variants.${i}.sku`] = `duplicates row ${seen.get(v.sku!)! + 1}`
    else seen.set(v.sku!, i)
  })
  if (Object.keys(fields).length > 0) throw new AdminError('VALIDATION_ERROR', 'invalid input', fields)

  try {
    await prisma.$transaction(async (tx) => {
      await requireProduct(tx, productId)
      for (const v of parsed) await insert(tx, productId, v, actorId)
    })
  } catch (e) { throw mapUniqueViolation(e) }
  return reload(productId)
}

async function loadForLock(tx: Prisma.TransactionClient, variantId: string) {
  const v = await tx.variant.findUnique({
    where: { id: variantId },
    include: { channelListing: true, _count: { select: { orderLines: true } } },
  })
  if (!v) throw new AdminError('NOT_FOUND', 'variant not found')
  const locked = v._count.orderLines > 0 || (v.channelListing !== null && v.channelListing.status !== 'retired')
  return { v, locked }
}

export async function updateVariant(variantId: string, body: unknown, actorId: string): Promise<AdminProductDto> {
  const data = parseVariantInput(body, 'patch')
  let productId = ''
  try {
    await prisma.$transaction(async (tx) => {
      const { v, locked } = await loadForLock(tx, variantId)
      productId = v.productId
      if (data.sku !== undefined && data.sku !== v.sku && locked) {
        throw new AdminError(
          'SKU_LOCKED',
          'the SKU cannot change once the variant has sold or has a Walmart listing',
          { sku: 'locked after sale or listing' },
        )
      }
      const before: Record<string, unknown> = {}
      const after: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(data)) {
        const old = (v as Record<string, unknown>)[k]
        if (JSON.stringify(old ?? null) !== JSON.stringify(val ?? null)) { before[k] = old ?? null; after[k] = val }
      }
      if (Object.keys(after).length === 0) return
      await tx.variant.update({ where: { id: variantId }, data: after })
      await recordAudit({ actorId, action: 'variant.update', target: `variant:${variantId}`, before, after }, tx)
    })
  } catch (e) { throw mapUniqueViolation(e) }
  return reload(productId)
}

/**
 * Refused once sold or listed. The listing FK cascades, so without this check
 * a delete would silently erase the record of a listing that may still be
 * live on Walmart (spec §4.2).
 */
export async function deleteVariant(variantId: string, actorId: string): Promise<AdminProductDto> {
  let productId = ''
  await prisma.$transaction(async (tx) => {
    const { v, locked } = await loadForLock(tx, variantId)
    productId = v.productId
    if (locked) {
      throw new AdminError('VARIANT_HAS_SALES', 'this variant has sold or is listed on Walmart; archive the product instead of deleting it')
    }
    await tx.variant.delete({ where: { id: variantId } })
    await recordAudit({
      actorId, action: 'variant.delete', target: `variant:${variantId}`,
      before: { productId: v.productId, sku: v.sku, priceCents: v.priceCents },
    }, tx)
  })
  return reload(productId)
}
```

- [ ] **Step 4: Add the routes**

Import the four functions and add:
```ts
adminCatalogRouter.post('/products/:id/variants/bulk', async (req, res) => {
  try { res.status(201).json(await bulkCreateVariants(req.params.id, req.body, req.actor!.id)) } catch (err) { fail(res, err) }
})
adminCatalogRouter.post('/products/:id/variants', async (req, res) => {
  try { res.status(201).json(await createVariant(req.params.id, req.body, req.actor!.id)) } catch (err) { fail(res, err) }
})
adminCatalogRouter.patch('/variants/:id', async (req, res) => {
  try { res.json(await updateVariant(req.params.id, req.body, req.actor!.id)) } catch (err) { fail(res, err) }
})
adminCatalogRouter.delete('/variants/:id', async (req, res) => {
  try { res.json(await deleteVariant(req.params.id, req.actor!.id)) } catch (err) { fail(res, err) }
})
```

- [ ] **Step 5: Run and commit**

Run: `npx vitest run tests/variant-write.test.ts` — Expected: PASS.
```bash
git add src/admin tests/variant-write.test.ts
git commit -m "feat(core): variant create, bulk create, edit and delete with SKU and delete locks"
```

---

## Task 8: Stock and allocation writes, stock history

**Files:**
- Create: `systems/core/src/admin/stock.service.ts`
- Modify: `systems/core/src/admin/admin-catalog.routes.ts`
- Test: `systems/core/tests/stock-write.test.ts`, `systems/core/tests/stock-concurrency.test.ts`

**Interfaces:**
- Consumes: `parseStockInput`, `loadAdminProduct`, `enqueueInventoryPush(variantId)` from `src/channels/walmart/inventory.sync.ts`, `recordAudit`.
- Produces:
  - `setStock(variantId: string, body: unknown, actorId: string): Promise<AdminProductDto>`
  - `getStockHistory(variantId: string, limit?: number): Promise<Array<{ at: Date; actor: string; before: unknown; after: unknown; note: string | null }>>`
  - Routes: `PUT /variants/:id/stock`, `GET /variants/:id/stock-history?limit=`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/stock-write.test.ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createSession, SESSION_COOKIE } from '../src/auth/session.service.js'
import * as sync from '../src/channels/walmart/inventory.sync.js'

const app = buildApp()
const ORIGIN = 'https://admin-staging.alpinebrickexchange.com'
let cookie: string
let variantId: string

beforeEach(async () => {
  await resetDb()
  vi.restoreAllMocks()
  process.env.ADMIN_CONSOLE_ORIGIN = ORIGIN
  const actor = await prisma.actor.create({ data: { type: 'human', name: 'Jack', email: 'jack@example.com' } })
  cookie = `${SESSION_COOKIE}=${(await createSession(actor.id)).token}`
  const p = await prisma.product.create({ data: { slug: 'p', name: 'P', productType: 'resale' } })
  variantId = (await prisma.variant.create({ data: { productId: p.id, sku: 'A-1', priceCents: 100 } })).id
  await prisma.inventory.create({ data: { variantId, onHand: 5, reserved: 2 } })
})
afterAll(async () => { delete process.env.ADMIN_CONSOLE_ORIGIN; await prisma.$disconnect() })

const put = (body: unknown) => request(app).put(`/api/v1/admin/variants/${variantId}/stock`)
  .set('Cookie', cookie).set('Origin', ORIGIN).set('Content-Type', 'application/json').send(body)
const inv = () => prisma.inventory.findUniqueOrThrow({ where: { variantId } })

describe('PUT /variants/:id/stock', () => {
  it('sets an absolute on-hand and audits it with the note', async () => {
    const res = await put({ onHand: 9, expectedOnHand: 5, note: 'recount' })
    expect(res.status).toBe(200)
    expect(res.body.variants[0].inventory).toMatchObject({ onHand: 9, reserved: 2 })
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'variant.stock.set' } })
    expect(a.before).toEqual({ onHand: 5, reserved: 2, walmartAllocation: null })
    expect(a.after).toEqual({ onHand: 9, reserved: 2, walmartAllocation: null, note: 'recount' })
  })

  it('refuses to go below reserved, naming the reserved count', async () => {
    const res = await put({ onHand: 1 })
    expect([res.status, res.body.code]).toEqual([409, 'STOCK_BELOW_RESERVED'])
    expect(res.body.message).toContain('2')
    expect((await inv()).onHand).toBe(5)
  })

  it('refuses a stale expectedOnHand and returns the current figures', async () => {
    const res = await put({ onHand: 9, expectedOnHand: 4 })
    expect([res.status, res.body.code]).toEqual([409, 'STOCK_CHANGED'])
    expect(res.body.details).toEqual({ onHand: 5, reserved: 2, walmartAllocation: null })
  })

  it('sets allocation, including back to shared', async () => {
    expect((await put({ walmartAllocation: 3 })).body.variants[0].inventory)
      .toMatchObject({ walmartAllocation: 3, storefrontAvailable: 0, walmartAvailable: 3 })
    expect((await put({ walmartAllocation: null })).body.variants[0].inventory.walmartAllocation).toBeNull()
  })

  it('refuses reserved + allocation above on-hand, whether from allocation or from on-hand', async () => {
    expect((await put({ walmartAllocation: 4 })).body.code).toBe('ALLOCATION_EXCEEDS_AVAILABLE')
    await put({ walmartAllocation: 3 })
    expect((await put({ onHand: 4 })).body.code).toBe('ALLOCATION_EXCEEDS_AVAILABLE')
    expect((await put({ onHand: 4, walmartAllocation: 2 })).status).toBe(200)
  })

  it('queues the Walmart push after commit, and a failing push does not fail the change', async () => {
    const spy = vi.spyOn(sync, 'enqueueInventoryPush').mockRejectedValue(new Error('outbox down'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await put({ onHand: 7 })
    expect(res.status).toBe(200)
    expect(spy).toHaveBeenCalledWith(variantId)
    expect(err).toHaveBeenCalled()
    expect((await inv()).onHand).toBe(7)
  })

  it('creates a missing inventory row rather than failing', async () => {
    await prisma.inventory.deleteMany()
    expect((await put({ onHand: 1 })).body.variants[0].inventory.onHand).toBe(1)
  })

  it('404s an unknown variant and 400s a bad body', async () => {
    expect((await request(app).put('/api/v1/admin/variants/nope/stock').set('Cookie', cookie).set('Origin', ORIGIN)
      .set('Content-Type', 'application/json').send({ onHand: 1 })).status).toBe(404)
    expect((await put({})).status).toBe(400)
  })
})

describe('GET /variants/:id/stock-history', () => {
  it('lists recent changes newest first, with who and the note', async () => {
    await put({ onHand: 6, note: 'first' })
    await put({ onHand: 7, note: 'second' })
    const res = await request(app).get(`/api/v1/admin/variants/${variantId}/stock-history?limit=10`).set('Cookie', cookie)
    expect(res.status).toBe(200)
    expect(res.body.map((h: any) => [h.note, h.actor])).toEqual([['second', 'jack@example.com'], ['first', 'jack@example.com']])
  })
})
```

`vi.spyOn` on an ES module namespace export works only if `stock.service.ts` calls it through the module object at call time. Import it in the service as `import * as inventorySync from '../channels/walmart/inventory.sync.js'` and call `inventorySync.enqueueInventoryPush(variantId)`. If Vitest still reports the namespace as non-configurable, replace the spy with `vi.mock('../src/channels/walmart/inventory.sync.js', async (orig) => ({ ...(await orig()), enqueueInventoryPush: vi.fn() }))` at the top of the test file and assert on that mock instead.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/stock-write.test.ts` — Expected: FAIL (404s).

- [ ] **Step 3: Implement `src/admin/stock.service.ts`**

```ts
import { prisma } from '../prisma.js'
import { recordAudit } from '../audit.js'
import * as inventorySync from '../channels/walmart/inventory.sync.js'
import { AdminError } from './admin-errors.js'
import { parseStockInput } from './product-input.js'
import { loadAdminProduct, type AdminProductDto } from './admin-product.dto.js'

type Row = { on_hand: number; reserved: number; walmart_allocation: number | null }

/**
 * Absolute stock and/or Walmart allocation (spec §5, §5.1).
 *
 * The row is locked (SELECT ... FOR UPDATE) before anything is decided, so a
 * checkout or Walmart ingest racing this change waits for it and then
 * re-evaluates its own guard against the new figures. The UPDATE repeats the
 * invariant in its WHERE clause as a second line of defence. Remove the lock
 * and tests/stock-concurrency.test.ts fails.
 */
export async function setStock(variantId: string, body: unknown, actorId: string): Promise<AdminProductDto> {
  const input = parseStockInput(body)

  const productId = await prisma.$transaction(async (tx) => {
    const variant = await tx.variant.findUnique({ where: { id: variantId }, select: { productId: true } })
    if (!variant) throw new AdminError('NOT_FOUND', 'variant not found')
    await tx.inventory.upsert({ where: { variantId }, create: { variantId }, update: {} })

    const [cur] = await tx.$queryRaw<Row[]>`
      SELECT on_hand, reserved, walmart_allocation FROM inventory WHERE variant_id = ${variantId} FOR UPDATE`
    const before = { onHand: cur.on_hand, reserved: cur.reserved, walmartAllocation: cur.walmart_allocation }

    if (input.expectedOnHand !== undefined && cur.on_hand !== input.expectedOnHand) {
      throw new AdminError('STOCK_CHANGED', `stock changed to ${cur.on_hand} since you opened this`, undefined, before)
    }
    const onHand = input.onHand ?? cur.on_hand
    const allocation = input.allocationProvided ? input.walmartAllocation : cur.walmart_allocation
    if (onHand < cur.reserved) {
      throw new AdminError('STOCK_BELOW_RESERVED',
        `on hand cannot go below the ${cur.reserved} reserved by open orders`, { onHand: `at least ${cur.reserved}` }, before)
    }
    if (cur.reserved + (allocation ?? 0) > onHand) {
      throw new AdminError('ALLOCATION_EXCEEDS_AVAILABLE',
        `reserved (${cur.reserved}) plus Walmart allocation (${allocation}) cannot exceed on hand (${onHand}); lower the allocation too`,
        { walmartAllocation: `at most ${onHand - cur.reserved}` }, before)
    }

    const affected = await tx.$executeRaw`
      UPDATE inventory SET on_hand = ${onHand}, walmart_allocation = ${allocation}::int
      WHERE variant_id = ${variantId} AND reserved + COALESCE(${allocation}::int, 0) <= ${onHand}`
    if (affected !== 1) throw new Error(`stock update for ${variantId} matched ${affected} rows under lock`)

    await recordAudit({
      actorId, action: 'variant.stock.set', target: `variant:${variantId}`,
      before, after: { onHand, reserved: cur.reserved, walmartAllocation: allocation, note: input.note ?? null },
    }, tx)
    return variant.productId
  })

  // After commit, like orders.service's enqueueInventoryPushesAfterCommit: a
  // failure is logged, never surfaced as a failed stock change. The hourly
  // reconcile catches up.
  try {
    await inventorySync.enqueueInventoryPush(variantId)
  } catch (e) {
    console.error(`stock: post-commit inventory push enqueue failed (variant ${variantId}):`, e)
  }

  const p = await loadAdminProduct(productId)
  if (!p) throw new AdminError('NOT_FOUND', 'product not found')
  return p
}

export async function getStockHistory(variantId: string, limit = 10) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new AdminError('VALIDATION_ERROR', 'invalid input', { limit: 'a whole number from 1 to 50' })
  }
  if (!(await prisma.variant.findUnique({ where: { id: variantId }, select: { id: true } }))) {
    throw new AdminError('NOT_FOUND', 'variant not found')
  }
  const rows = await prisma.auditLog.findMany({
    where: { action: 'variant.stock.set', target: `variant:${variantId}` },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { actor: true },
  })
  return rows.map((r) => ({
    at: r.createdAt,
    actor: r.actor.email ?? r.actor.name,
    before: r.before,
    after: r.after,
    note: ((r.after as { note?: string | null } | null)?.note) ?? null,
  }))
}
```

- [ ] **Step 4: Add the routes**

```ts
adminCatalogRouter.put('/variants/:id/stock', async (req, res) => {
  try { res.json(await setStock(req.params.id, req.body, req.actor!.id)) } catch (err) { fail(res, err) }
})
adminCatalogRouter.get('/variants/:id/stock-history', async (req, res) => {
  try { res.json(await getStockHistory(req.params.id, intParam(req.query.limit) ?? 10)) } catch (err) { fail(res, err) }
})
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/stock-write.test.ts` — Expected: PASS.

- [ ] **Step 6: Write the concurrency test**

```ts
// tests/stock-concurrency.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb, ensureSystemActor } from './helpers/db.js'
import { placeOrder } from '../src/orders/orders.service.js'
import { setStock } from '../src/admin/stock.service.js'

// A stock set racing checkouts must never leave reserved above on-hand.
// Verified non-vacuous by mutation (see PR): remove "FOR UPDATE" from
// setStock's SELECT and the guard from its UPDATE, and this fails.
beforeEach(async () => { await resetDb(); await ensureSystemActor() })
afterAll(() => prisma.$disconnect())

describe('setStock under concurrency', () => {
  it('never lets reserved exceed on-hand', async () => {
    for (let round = 0; round < 20; round++) {
      await resetDb(); await ensureSystemActor()
      const p = await prisma.product.create({ data: { slug: 'c', name: 'C', productType: 'resale', status: 'published' } })
      const v = await prisma.variant.create({ data: { productId: p.id, sku: 'C-1', priceCents: 100 } })
      await prisma.inventory.create({ data: { variantId: v.id, onHand: 10 } })

      await Promise.allSettled([
        ...Array.from({ length: 8 }, () =>
          placeOrder({ email: 'c@example.com', shipToState: 'MI', lines: [{ variantId: v.id, quantity: 1 }] })),
        setStock(v.id, { onHand: 4 }, 'system'),
      ])

      const i = await prisma.inventory.findUniqueOrThrow({ where: { variantId: v.id } })
      expect(i.reserved).toBeLessThanOrEqual(i.onHand)
    }
  })
})
```

- [ ] **Step 7: Run it and prove it is not vacuous**

Run: `npx vitest run tests/stock-concurrency.test.ts` — Expected: PASS.
Mutate: remove ` FOR UPDATE` from the SELECT **and** `AND reserved + COALESCE(${allocation}::int, 0) <= ${onHand}` from the UPDATE; run — Expected: FAIL (`reserved` > `onHand` in some round). If it does not fail within 3 runs, raise rounds to 50 and orders to 12 until the mutant fails reliably; keep those numbers. Restore the code exactly; run 5 consecutive times — Expected: 5 passes. Record the mutation result for the PR description.

- [ ] **Step 8: Commit**

```bash
git add src/admin tests/stock-write.test.ts tests/stock-concurrency.test.ts
git commit -m "feat(core): set stock and Walmart allocation with row lock, audit and post-commit push; stock history"
```

---

## Task 9: Core verification, fixture capture, PR

**Files:**
- Create: `systems/core/tests/capture-admin-fixtures.test.ts`
- Create: `systems/admin-ui/src/data/__fixtures__/product.json`, `product-with-stock.json`, `bulk-status.json`, `stock-changed.json`, `stock-history.json`

**Interfaces:**
- Produces: JSON fixtures of real core responses, used by Tasks 10–13.

- [ ] **Step 1: Write the capture script as a skipped-by-default test**

```ts
// tests/capture-admin-fixtures.test.ts
// Writes real admin API responses to systems/admin-ui/src/data/__fixtures__/
// so console tests run against core's actual shapes (the lesson of PR #32).
// Skipped unless CAPTURE_ADMIN_FIXTURES=1. Re-run whenever a response shape changes.
import { describe, it, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createSession, SESSION_COOKIE } from '../src/auth/session.service.js'

const OUT = resolve(__dirname, '../../admin-ui/src/data/__fixtures__')
const ORIGIN = 'https://admin-staging.alpinebrickexchange.com'
const run = process.env.CAPTURE_ADMIN_FIXTURES === '1'

describe.runIf(run)('capture admin fixtures', () => {
  const app = buildApp()
  let cookie = ''
  beforeAll(async () => {
    await resetDb()
    process.env.ADMIN_CONSOLE_ORIGIN = ORIGIN
    const a = await prisma.actor.create({ data: { type: 'human', name: 'Jack', email: 'jack@example.com' } })
    cookie = `${SESSION_COOKIE}=${(await createSession(a.id)).token}`
    mkdirSync(OUT, { recursive: true })
  })
  afterAll(() => prisma.$disconnect())

  const send = (m: 'post' | 'patch' | 'put' | 'get', path: string, body?: unknown) => {
    const r = request(app)[m](`/api/v1/admin${path}`).set('Cookie', cookie).set('Origin', ORIGIN)
    return body === undefined ? r : r.set('Content-Type', 'application/json').send(body)
  }
  const save = (name: string, body: unknown) => writeFileSync(`${OUT}/${name}.json`, JSON.stringify(body, null, 2) + '\n')

  it('captures', async () => {
    const p = (await send('post', '/products', { name: 'Castle Set', productType: 'resale', pieces: 900, features: ['Opening gate'] })).body
    save('product', p)
    const withStock = (await send('post', `/products/${p.id}/variants`, { sku: 'ABE-1001', priceCents: 18900, onHand: 3, attributes: { condition: 'sealed' } })).body
    const v = withStock.variants[0]
    save('product-with-stock', (await send('put', `/variants/${v.id}/stock`, { walmartAllocation: 1, note: 'one for Walmart' })).body)
    save('stock-changed', (await send('put', `/variants/${v.id}/stock`, { onHand: 5, expectedOnHand: 99 })).body)
    save('stock-history', (await send('get', `/variants/${v.id}/stock-history`)).body)
    save('bulk-status', (await send('post', '/products/bulk-status', { ids: [p.id, 'missing-id'], status: 'published' })).body)
  })
})
```

- [ ] **Step 2: Capture**

Run: `CAPTURE_ADMIN_FIXTURES=1 npx vitest run tests/capture-admin-fixtures.test.ts`
Expected: 5 JSON files in `systems/admin-ui/src/data/__fixtures__/`. Open each; confirm `stock-changed.json` has `code: "STOCK_CHANGED"` and a `details` object, and `bulk-status.json` has one `ok: true` and one `NOT_FOUND`.

- [ ] **Step 3: Full verification**

```bash
npx vitest run && npx tsc --noEmit && npm run build
PORT=4099 node dist/server.js & sleep 3; curl -s localhost:4099/health; kill %1
```
Expected: all tests pass (count = Task 0 baseline + the new files), no type errors, build clean, `{"status":"ok"}`.

- [ ] **Step 4: Commit, push, PR (after Jack's OK to push)**

```bash
git add tests/capture-admin-fixtures.test.ts ../admin-ui/src/data/__fixtures__
git commit -m "test(core): capture admin API fixtures for the console"
git push -u origin feat/catalog-editing-core
gh pr create --base main --title "feat(core): catalog editing API and per-variant Walmart allocation"
```
PR body must list: the endpoints; the migration (and that it drops `buffer_pct`); every existing test whose expectation changed because the buffer was removed; both mutation checks and their results. Watch `gh pr checks <n> --watch`. Merge only when green and Jack approves.

---

## Task 10: Console data layer

**Files:**
- Branch: `git checkout main && git pull --ff-only && git checkout -b feat/catalog-editing-console` (after the core PR is merged)
- Modify: `systems/admin-ui/src/data/errors.js`, `systems/admin-ui/src/data/api.js`
- Create: `systems/admin-ui/src/lib/money.js`
- Test: `systems/admin-ui/src/data/api.write.test.js`, `systems/admin-ui/src/lib/money.test.js`

**Interfaces:**
- Produces (all return the admin product DTO unless noted):
  - `api.createProduct(input)`, `api.updateProduct(id, patch)`
  - `api.bulkSetStatus(ids, status)` → `{ results }`
  - `api.createVariant(productId, input)`, `api.bulkCreateVariants(productId, variants)`
  - `api.updateVariant(variantId, patch)`, `api.deleteVariant(variantId)`
  - `api.setStock(variantId, { onHand?, walmartAllocation?, expectedOnHand?, note? })`
  - `api.getStockHistory(variantId, limit = 10)` → history array
  - `AdminApiError(message, code, fields, details)` — `err.details` set when present
  - `dollarsToCents(text: string): number | null`, `formatCents(cents: number): string`

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/money.test.js
import { describe, it, expect } from 'vitest'
import { dollarsToCents, formatCents } from './money.js'

describe('money', () => {
  it('parses dollars exactly, without float drift', () => {
    expect(dollarsToCents('189')).toBe(18900)
    expect(dollarsToCents('19.99')).toBe(1999)
    expect(dollarsToCents('0.29')).toBe(29)
    expect(dollarsToCents('$1,234.5')).toBe(123450)
  })
  it('rejects anything that is not a price', () => {
    expect(dollarsToCents('')).toBeNull()
    expect(dollarsToCents('1.234')).toBeNull()
    expect(dollarsToCents('abc')).toBeNull()
  })
  it('formats cents as USD', () => expect(formatCents(18900)).toBe('$189.00'))
})
```

```js
// src/data/api.write.test.js
import { describe, it, expect, vi, afterEach } from 'vitest'
import api from './api.js'
import product from './__fixtures__/product.json'
import stockChanged from './__fixtures__/stock-changed.json'

function spyFetch(status, body) {
  const spy = vi.fn(async () => ({ ok: status < 400, status, json: async () => body }))
  vi.stubGlobal('fetch', spy)
  return spy
}
afterEach(() => vi.unstubAllGlobals())

const call = (spy) => ({ url: String(spy.mock.calls[0][0]), init: spy.mock.calls[0][1] })

describe('write methods hit core, never the mock', () => {
  it.each([
    ['createProduct', () => api.createProduct({ name: 'X', productType: 'resale' }), 'POST', '/api/v1/admin/products'],
    ['updateProduct', () => api.updateProduct('p1', { name: 'Y' }), 'PATCH', '/api/v1/admin/products/p1'],
    ['bulkSetStatus', () => api.bulkSetStatus(['a'], 'published'), 'POST', '/api/v1/admin/products/bulk-status'],
    ['createVariant', () => api.createVariant('p1', { sku: 'A', priceCents: 1 }), 'POST', '/api/v1/admin/products/p1/variants'],
    ['bulkCreateVariants', () => api.bulkCreateVariants('p1', [{ sku: 'A', priceCents: 1 }]), 'POST', '/api/v1/admin/products/p1/variants/bulk'],
    ['updateVariant', () => api.updateVariant('v1', { priceCents: 2 }), 'PATCH', '/api/v1/admin/variants/v1'],
    ['deleteVariant', () => api.deleteVariant('v1'), 'DELETE', '/api/v1/admin/variants/v1'],
    ['setStock', () => api.setStock('v1', { onHand: 3 }), 'PUT', '/api/v1/admin/variants/v1/stock'],
    ['getStockHistory', () => api.getStockHistory('v1'), 'GET', '/api/v1/admin/variants/v1/stock-history?limit=10'],
  ])('%s', async (_name, invoke, method, path) => {
    const spy = spyFetch(200, product)
    await invoke()
    const { url, init } = call(spy)
    expect(url.endsWith(path)).toBe(true)
    expect(init.method ?? 'GET').toBe(method)
    expect(init.credentials).toBe('include')
  })

  it('wraps bulk variants in { variants }', async () => {
    const spy = spyFetch(201, product)
    await api.bulkCreateVariants('p1', [{ sku: 'A', priceCents: 1 }])
    expect(JSON.parse(call(spy).init.body)).toEqual({ variants: [{ sku: 'A', priceCents: 1 }] })
  })
})

describe('errors keep details', () => {
  it('exposes code, fields and details from core', async () => {
    spyFetch(409, stockChanged)
    await expect(api.setStock('v1', { onHand: 5, expectedOnHand: 99 }))
      .rejects.toMatchObject({ code: 'STOCK_CHANGED', details: stockChanged.details })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd systems/admin-ui && npx vitest run src/lib/money.test.js src/data/api.write.test.js` — Expected: FAIL.

- [ ] **Step 3: Implement `src/lib/money.js`**

```js
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** "19.99" -> 1999. String arithmetic, so 0.29 never becomes 28. null if not a price. */
export function dollarsToCents(text) {
  const s = String(text ?? '').trim().replace(/[$,\s]/g, '')
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s)
  if (!m) return null
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
}

export function formatCents(cents) {
  return USD.format((cents ?? 0) / 100)
}
```

- [ ] **Step 4: `AdminApiError` gains `details`**

```js
export class AdminApiError extends Error {
  constructor(message, code = 'INTERNAL', fields = undefined, details = undefined) {
    super(message)
    this.name = 'AdminApiError'
    this.code = code
    if (fields) this.fields = fields
    if (details) this.details = details
  }
}
```
In `api.js` `call()`, change the throw to `throw new AdminApiError(body?.message || GENERIC, body?.code || 'INTERNAL', body?.fields, body?.details)`.

- [ ] **Step 5: Replace the write stubs in `api.js`**

Update the comment block above `notImplemented` to say only the four image methods remain unbacked (ADR-0002). Replace the stub lines with:
```js
  async createProduct(input) {
    return call('/products', { method: 'POST', body: JSON.stringify(input) })
  },
  async updateProduct(id, patch) {
    return call(`/products/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })
  },
  async bulkSetStatus(ids, status) {
    return call('/products/bulk-status', { method: 'POST', body: JSON.stringify({ ids, status }) })
  },
  async createVariant(productId, input) {
    return call(`/products/${encodeURIComponent(productId)}/variants`, { method: 'POST', body: JSON.stringify(input) })
  },
  async bulkCreateVariants(productId, variants) {
    return call(`/products/${encodeURIComponent(productId)}/variants/bulk`, { method: 'POST', body: JSON.stringify({ variants }) })
  },
  async updateVariant(variantId, patch) {
    return call(`/variants/${encodeURIComponent(variantId)}`, { method: 'PATCH', body: JSON.stringify(patch) })
  },
  async deleteVariant(variantId) {
    return call(`/variants/${encodeURIComponent(variantId)}`, { method: 'DELETE', body: '{}' })
  },
  async setStock(variantId, input) {
    return call(`/variants/${encodeURIComponent(variantId)}/stock`, { method: 'PUT', body: JSON.stringify(input) })
  },
  async getStockHistory(variantId, limit = 10) {
    return call(`/variants/${encodeURIComponent(variantId)}/stock-history?limit=${limit}`)
  },

  addImage: notImplemented('addImage'),
  reorderImages: notImplemented('reorderImages'),
  updateImageAlt: notImplemented('updateImageAlt'),
  deleteImage: notImplemented('deleteImage'),
```
`deleteVariant` sends `'{}'` because core's `requireJsonContentType` applies to every non-GET admin request, and the header is sent on every call already.

- [ ] **Step 6: Run and commit**

Run: `npx vitest run` — Expected: PASS (existing tests included; if an existing `api.test.js` case asserted that a now-implemented method throws `NOT_IMPLEMENTED`, change it to assert one of the four image methods instead).
```bash
git add src
git commit -m "feat(admin-ui): wire product, variant and stock writes to core"
```

---

## Task 11: New product

**Files:**
- Modify: `systems/admin-ui/src/catalog/ProductForm.jsx`, `systems/admin-ui/src/App.jsx`, `systems/admin-ui/src/catalog/ProductList.jsx`, `systems/admin-ui/src/catalog/CatalogOverview.jsx`
- Test: `systems/admin-ui/src/catalog/product-form.test.jsx`

**Interfaces:**
- Consumes: `api.createProduct`, fixture `product.json`.
- Produces: route `/products/new` → `ProductForm`, registered **before** `products/:id`.

- [ ] **Step 1: Write the failing test**

```jsx
// src/catalog/product-form.test.jsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ToastProvider } from '../ui/toast.jsx'
import ProductForm from './ProductForm.jsx'
import product from '../data/__fixtures__/product.json'
import { AdminApiError } from '../data/errors.js'

vi.mock('../data/api.js', () => ({ default: { createProduct: vi.fn() } }))
import api from '../data/api.js'
afterEach(() => vi.clearAllMocks())

function renderForm() {
  return render(
    <ToastProvider><MemoryRouter initialEntries={['/products/new']}>
      <Routes>
        <Route path="/products/new" element={<ProductForm />} />
        <Route path="/products/:id" element={<p>detail page</p>} />
      </Routes>
    </MemoryRouter></ToastProvider>,
  )
}

describe('ProductForm', () => {
  it('requires a type before creating', async () => {
    renderForm()
    await userEvent.type(screen.getByLabelText('Name'), 'Castle Set')
    expect(screen.getByRole('button', { name: /create product/i })).toBeDisabled()
    await userEvent.click(screen.getByLabelText(/resale/i))
    expect(screen.getByRole('button', { name: /create product/i })).toBeEnabled()
  })

  it('creates and opens the new draft', async () => {
    vi.mocked(api.createProduct).mockResolvedValue(product)
    renderForm()
    await userEvent.type(screen.getByLabelText('Name'), 'Castle Set')
    await userEvent.click(screen.getByLabelText(/resale/i))
    await userEvent.click(screen.getByRole('button', { name: /create product/i }))
    expect(api.createProduct).toHaveBeenCalledWith(expect.objectContaining({ name: 'Castle Set', productType: 'resale' }))
    expect(await screen.findByText('detail page')).toBeInTheDocument()
  })

  it('shows field errors from core', async () => {
    vi.mocked(api.createProduct).mockRejectedValue(new AdminApiError('taken', 'SLUG_TAKEN', { slug: 'already in use' }))
    renderForm()
    await userEvent.type(screen.getByLabelText('Name'), 'Castle Set')
    await userEvent.click(screen.getByLabelText(/resale/i))
    await userEvent.click(screen.getByRole('button', { name: /create product/i }))
    expect(await screen.findByText('already in use')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/catalog/product-form.test.jsx` — Expected: FAIL (no type control; `getByLabelText('Name')` also fails until labels are linked).

- [ ] **Step 3: Rewrite `ProductForm.jsx`**

```jsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../data/api.js'
import { slugify } from '../lib/slug.js'
import Card from '../ui/Card.jsx'
import Button from '../ui/Button.jsx'
import { useToast } from '../ui/toast.jsx'

const TYPES = [
  { value: 'resale', label: 'Resale / collectible', hint: 'A set we bought to sell on' },
  { value: 'own_designed', label: 'Own design', hint: 'Designed for Alpine Brick' },
]

export default function ProductForm() {
  const nav = useNavigate()
  const toast = useToast()
  const [form, setForm] = useState({ name: '', productType: '', description: '', slug: '' })
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const previewSlug = form.slug || slugify(form.name)
  const valid = form.name.trim().length > 0 && form.productType !== ''

  const submit = async (e) => {
    e.preventDefault()
    if (!valid) return
    setSaving(true)
    try {
      const p = await api.createProduct({
        name: form.name.trim(),
        productType: form.productType,
        description: form.description,
        ...(form.slug ? { slug: form.slug } : {}),
      })
      toast.push('Draft created')
      nav(`/products/${p.id}`)
    } catch (err) {
      setErrors(err.fields || { name: err.message })
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-3xl font-bold">New product</h1>
      <p className="text-gray-500">Starts as a draft. Nothing reaches the storefront until you publish.</p>
      <Card className="mt-4">
        <form onSubmit={submit} className="space-y-4">
          <label className="block" htmlFor="pf-name">
            <span className="text-sm font-semibold">Name</span>
            <input id="pf-name" value={form.name} onChange={(e) => set('name', e.target.value)}
              className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2" />
            {errors.name && <span className="text-xs text-accent">{errors.name}</span>}
          </label>
          <label className="block" htmlFor="pf-slug">
            <span className="text-sm font-semibold">URL slug <span className="text-gray-400">(optional)</span></span>
            <input id="pf-slug" value={form.slug} placeholder={previewSlug} onChange={(e) => set('slug', e.target.value)}
              className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 font-mono text-sm" />
            <span className="mt-1 block text-xs text-gray-400">/products/{previewSlug || '…'} — locks once published</span>
            {errors.slug && <span className="text-xs text-accent">{errors.slug}</span>}
          </label>
          <fieldset>
            <legend className="text-sm font-semibold">Type</legend>
            <div className="mt-1 flex gap-4">
              {TYPES.map((t) => (
                <label key={t.value} className="flex items-start gap-2 text-sm">
                  <input type="radio" name="productType" value={t.value} checked={form.productType === t.value}
                    onChange={() => set('productType', t.value)} aria-label={t.label} />
                  <span>{t.label}<span className="block text-xs text-gray-400">{t.hint}</span></span>
                </label>
              ))}
            </div>
            {errors.productType && <span className="text-xs text-accent">{errors.productType}</span>}
          </fieldset>
          <label className="block" htmlFor="pf-desc">
            <span className="text-sm font-semibold">Short description</span>
            <textarea id="pf-desc" value={form.description} onChange={(e) => set('description', e.target.value)}
              rows={3} maxLength={500} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2" />
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={!valid || saving}>{saving ? 'Creating…' : 'Create product'}</Button>
            <Button type="button" variant="ghost" onClick={() => nav('/products')}>Cancel</Button>
          </div>
        </form>
      </Card>
    </div>
  )
}
```

- [ ] **Step 4: Route and entry points**

`App.jsx`: import `ProductForm` is already there; replace the "Product creation is not in the Phase B slice" comment with
```jsx
          <Route path="products/new" element={<ProductForm />} />
```
placed **before** `products/:id`.
`ProductList.jsx`: replace the `Creating products is not in this phase.` span with
```jsx
        <Link to="/products/new"><Button>+ New product</Button></Link>
```
`CatalogOverview.jsx` already links `/products/new`; no change. Update the existing `catalog.test.jsx` case asserting `/not in this phase/i` on the list to assert the `+ New product` link instead.

- [ ] **Step 5: Run and commit**

Run: `npx vitest run` — Expected: PASS.
```bash
git add src
git commit -m "feat(admin-ui): create products as drafts, with type and slug preview"
```

---

## Task 12: Editable Info tab

**Files:**
- Rewrite: `systems/admin-ui/src/catalog/tabs/InfoTab.jsx`
- Test: `systems/admin-ui/src/catalog/info-tab.test.jsx`

**Interfaces:**
- Consumes: `api.updateProduct(id, patch)`; props `{ product, onUpdated }`; fixture `product.json`.
- Produces: `diffPatch(product, form)` exported from `InfoTab.jsx` — returns only the fields whose value changed, typed for core.

- [ ] **Step 1: Write the failing test**

```jsx
// src/catalog/info-tab.test.jsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../ui/toast.jsx'
import InfoTab, { diffPatch, toForm } from './tabs/InfoTab.jsx'
import product from '../data/__fixtures__/product.json'
import { AdminApiError } from '../data/errors.js'

vi.mock('../data/api.js', () => ({ default: { updateProduct: vi.fn() } }))
import api from '../data/api.js'
afterEach(() => vi.clearAllMocks())

const renderTab = (p = product, onUpdated = vi.fn()) =>
  render(<ToastProvider><InfoTab product={p} onUpdated={onUpdated} /></ToastProvider>)

describe('diffPatch', () => {
  it('sends only changed fields, typed for core', () => {
    const form = { ...toForm(product), pieces: '1200', features: 'Opening gate\nLights', categories: 'castle, Medieval', difficulty: '' }
    expect(diffPatch(product, form)).toEqual({ pieces: 1200, features: ['Opening gate', 'Lights'], categories: ['castle', 'medieval'] })
  })
  it('is empty when nothing changed', () => expect(diffPatch(product, toForm(product))).toEqual({}))
})

describe('InfoTab', () => {
  it('saves explicitly, never on keystroke', async () => {
    vi.mocked(api.updateProduct).mockResolvedValue({ ...product, name: 'Castle Deluxe' })
    const onUpdated = vi.fn()
    renderTab(product, onUpdated)
    const save = screen.getByRole('button', { name: /save changes/i })
    expect(save).toBeDisabled()
    await userEvent.clear(screen.getByLabelText('Name'))
    await userEvent.type(screen.getByLabelText('Name'), 'Castle Deluxe')
    expect(api.updateProduct).not.toHaveBeenCalled()
    expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument()
    await userEvent.click(save)
    expect(api.updateProduct).toHaveBeenCalledWith(product.id, { name: 'Castle Deluxe' })
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ name: 'Castle Deluxe' }))
  })

  it('shows the slug as locked once published', () => {
    renderTab({ ...product, locked: { slug: true } })
    expect(screen.getByLabelText('URL slug')).toHaveAttribute('readonly')
    expect(screen.getByText(/locked because this product has been published/i)).toBeInTheDocument()
  })

  it('renders field errors from core beside the field', async () => {
    vi.mocked(api.updateProduct).mockRejectedValue(new AdminApiError('invalid input', 'VALIDATION_ERROR', { pieces: 'a whole number of at least 1, or empty' }))
    renderTab()
    await userEvent.clear(screen.getByLabelText('Pieces'))
    await userEvent.type(screen.getByLabelText('Pieces'), '0')
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }))
    expect(await screen.findByText('a whole number of at least 1, or empty')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/catalog/info-tab.test.jsx` — Expected: FAIL (`diffPatch` not exported).

- [ ] **Step 3: Rewrite `tabs/InfoTab.jsx`**

```jsx
import { useEffect, useMemo, useState } from 'react'
import api from '../../data/api.js'
import Button from '../../ui/Button.jsx'
import { useToast } from '../../ui/toast.jsx'

/**
 * Explicit Save, never auto-save: on a published product every keystroke
 * would otherwise go straight to the live storefront (spec §6).
 */
const lines = (arr) => (arr || []).join('\n')
const csv = (arr) => (arr || []).join(', ')

export function toForm(p) {
  return {
    name: p.name, slug: p.slug, productType: p.productType, releaseType: p.releaseType,
    categories: csv(p.categories), description: p.description ?? '', longDescription: p.longDescription ?? '',
    pieces: p.pieces ?? '', difficulty: p.difficulty ?? '', ageRecommendation: p.ageRecommendation ?? '',
    dimensions: p.dimensions ?? '', features: lines(p.features), includes: lines(p.includes),
    builderNotes: p.builderNotes ?? '', homePosition: p.homePosition ?? '', collectionPosition: p.collectionPosition ?? '',
  }
}

const intOrNull = (v) => (String(v).trim() === '' ? null : Number(v))
const textOrNull = (v) => (String(v).trim() === '' ? null : String(v).trim())
const splitLines = (v) => String(v).split('\n').map((s) => s.trim()).filter(Boolean)
const splitCsv = (v) => [...new Set(String(v).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))]

const CONVERT = {
  pieces: intOrNull, homePosition: intOrNull, collectionPosition: intOrNull,
  difficulty: textOrNull, ageRecommendation: textOrNull, dimensions: textOrNull,
  features: splitLines, includes: splitLines, categories: splitCsv,
  name: (v) => String(v).trim(),
}

export function diffPatch(product, form) {
  const base = toForm(product)
  const patch = {}
  for (const k of Object.keys(form)) {
    const conv = CONVERT[k] ?? ((v) => v)
    const next = conv(form[k])
    const prev = conv(base[k])
    if (JSON.stringify(next) !== JSON.stringify(prev)) patch[k] = next
  }
  return patch
}

function Field({ id, label, error, hint, children }) {
  return (
    <label className="block" htmlFor={id}>
      <span className="text-sm font-semibold">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-400">{hint}</span>}
      {error && <span className="block text-xs text-accent">{error}</span>}
    </label>
  )
}

const input = 'mt-1 w-full rounded-xl border border-gray-200 px-3 py-2'

export default function InfoTab({ product, onUpdated }) {
  const toast = useToast()
  const [form, setForm] = useState(() => toForm(product))
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  useEffect(() => { setForm(toForm(product)); setErrors({}) }, [product])
  const patch = useMemo(() => diffPatch(product, form), [product, form])
  const dirty = Object.keys(patch).length > 0

  useEffect(() => {
    if (!dirty) return undefined
    const warn = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const f = (id, label, extra = {}) => ({ id: `info-${id}`, label, error: errors[id], ...extra })

  const save = async () => {
    setSaving(true); setErrors({})
    try {
      onUpdated(await api.updateProduct(product.id, patch))
      toast.push(product.status === 'published' ? 'Saved — live on the storefront now' : 'Saved')
    } catch (err) {
      setErrors(err.fields || { name: err.message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="font-bold">Basics</h3>
        <Field {...f('name', 'Name')}><input id="info-name" value={form.name} onChange={set('name')} className={input} /></Field>
        <Field {...f('slug', 'URL slug', { hint: product.locked?.slug ? 'Locked because this product has been published — its URL may already be linked.' : `/products/${form.slug}` })}>
          <input id="info-slug" value={form.slug} onChange={set('slug')} readOnly={product.locked?.slug}
            className={`${input} font-mono text-sm read-only:bg-gray-50 read-only:text-gray-500`} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field {...f('productType', 'Type')}>
            <select id="info-productType" value={form.productType} onChange={set('productType')} className={input}>
              <option value="resale">Resale / collectible</option><option value="own_designed">Own design</option>
            </select>
          </Field>
          <Field {...f('releaseType', 'Release type')}>
            <select id="info-releaseType" value={form.releaseType} onChange={set('releaseType')} className={input}>
              <option value="standard">Standard</option><option value="limited_run">Limited run</option><option value="specialty">Specialty</option>
            </select>
          </Field>
        </div>
        <Field {...f('categories', 'Categories', { hint: 'Comma-separated tags, e.g. castle, star-wars' })}>
          <input id="info-categories" value={form.categories} onChange={set('categories')} className={input} />
        </Field>
      </section>

      <section className="space-y-3">
        <h3 className="font-bold">Description</h3>
        <Field {...f('description', 'Short description')}><textarea id="info-description" rows={3} maxLength={500} value={form.description} onChange={set('description')} className={input} /></Field>
        <Field {...f('longDescription', 'Long description')}><textarea id="info-longDescription" rows={6} value={form.longDescription} onChange={set('longDescription')} className={input} /></Field>
      </section>

      <section className="grid grid-cols-2 gap-3">
        <h3 className="col-span-2 font-bold">Build details</h3>
        <Field {...f('pieces', 'Pieces')}><input id="info-pieces" inputMode="numeric" value={form.pieces} onChange={set('pieces')} className={input} /></Field>
        <Field {...f('difficulty', 'Difficulty')}>
          <select id="info-difficulty" value={form.difficulty} onChange={set('difficulty')} className={input}>
            <option value="">—</option><option value="beginner">Beginner</option><option value="intermediate">Intermediate</option>
            <option value="advanced">Advanced</option><option value="expert">Expert</option>
          </select>
        </Field>
        <Field {...f('ageRecommendation', 'Age')}><input id="info-ageRecommendation" value={form.ageRecommendation} onChange={set('ageRecommendation')} className={input} /></Field>
        <Field {...f('dimensions', 'Dimensions')}><input id="info-dimensions" value={form.dimensions} onChange={set('dimensions')} className={input} /></Field>
      </section>

      <section className="space-y-3">
        <h3 className="font-bold">Contents</h3>
        <Field {...f('features', 'Features', { hint: 'One per line' })}><textarea id="info-features" rows={4} value={form.features} onChange={set('features')} className={input} /></Field>
        <Field {...f('includes', "What's included", { hint: 'One per line' })}><textarea id="info-includes" rows={3} value={form.includes} onChange={set('includes')} className={input} /></Field>
        <Field {...f('builderNotes', 'Builder notes')}><textarea id="info-builderNotes" rows={3} value={form.builderNotes} onChange={set('builderNotes')} className={input} /></Field>
      </section>

      <section className="grid grid-cols-2 gap-3">
        <h3 className="col-span-2 font-bold">Merchandising</h3>
        <Field {...f('homePosition', 'Home page position', { hint: 'Blank sorts last' })}><input id="info-homePosition" inputMode="numeric" value={form.homePosition} onChange={set('homePosition')} className={input} /></Field>
        <Field {...f('collectionPosition', 'Collection position', { hint: 'Blank sorts last' })}><input id="info-collectionPosition" inputMode="numeric" value={form.collectionPosition} onChange={set('collectionPosition')} className={input} /></Field>
      </section>

      <div className="sticky bottom-0 flex items-center gap-3 border-t border-gray-100 bg-white py-3">
        <Button onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
        {dirty && <span className="text-sm text-gray-500">Unsaved changes{product.status === 'published' ? ' — saving updates the live storefront' : ''}</span>}
        {dirty && <Button variant="ghost" onClick={() => setForm(toForm(product))}>Discard</Button>}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run and commit**

Run: `npx vitest run` — Expected: PASS. If `catalog.test.jsx` asserts the old "Editing is not in this phase" banner, change that assertion to the Save button being disabled until an edit.
```bash
git add src
git commit -m "feat(admin-ui): editable product info with explicit save and slug lock"
```

---

## Task 13: Live variants and the stock dialog

**Files:**
- Rewrite: `systems/admin-ui/src/catalog/tabs/VariantsTab.jsx`
- Create: `systems/admin-ui/src/catalog/tabs/StockDialog.jsx`
- Modify: `systems/admin-ui/src/catalog/tabs/BulkVariantForm.jsx` (price becomes dollars text; emits core rows)
- Test: `systems/admin-ui/src/catalog/variants-tab.test.jsx`

**Interfaces:**
- Consumes: `api.createVariant`, `api.bulkCreateVariants`, `api.updateVariant`, `api.deleteVariant`, `api.setStock`, `api.getStockHistory`; `dollarsToCents`, `formatCents`; `Modal` from `src/ui/Modal.jsx`; fixtures `product-with-stock.json`, `stock-changed.json`, `stock-history.json`.
- Produces: `StockDialog({ variant, onClose, onSaved })`; `previewSplit(onHand, reserved, allocation)` exported from `StockDialog.jsx`.

- [ ] **Step 1: Read `src/ui/Modal.jsx`** and use its actual props in Step 4 (the code below assumes `<Modal open title onClose>{children}</Modal>`; adapt the three call sites if it differs).

- [ ] **Step 2: Write the failing tests**

```jsx
// src/catalog/variants-tab.test.jsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../ui/toast.jsx'
import VariantsTab from './tabs/VariantsTab.jsx'
import { previewSplit } from './tabs/StockDialog.jsx'
import withStock from '../data/__fixtures__/product-with-stock.json'
import stockChanged from '../data/__fixtures__/stock-changed.json'
import history from '../data/__fixtures__/stock-history.json'
import { AdminApiError } from '../data/errors.js'

vi.mock('../data/api.js', () => ({ default: {
  createVariant: vi.fn(), bulkCreateVariants: vi.fn(), updateVariant: vi.fn(),
  deleteVariant: vi.fn(), setStock: vi.fn(), getStockHistory: vi.fn(),
} }))
import api from '../data/api.js'
afterEach(() => vi.clearAllMocks())

const v = withStock.variants[0]
const renderTab = (p = withStock, onUpdated = vi.fn()) =>
  render(<ToastProvider><VariantsTab product={p} onUpdated={onUpdated} /></ToastProvider>)

describe('previewSplit', () => {
  it('matches core for shared and split stock', () => {
    expect(previewSplit(5, 2, null)).toEqual({ storefront: 3, walmart: 3, shared: true })
    expect(previewSplit(1, 0, 1)).toEqual({ storefront: 0, walmart: 1, shared: false })
  })
})

describe('VariantsTab', () => {
  it('shows stock per channel from core', () => {
    renderTab()
    const row = screen.getByRole('row', { name: new RegExp(v.sku) })
    expect(within(row).getByText(String(v.inventory.onHand))).toBeInTheDocument()
    expect(within(row).getByText(`Walmart ${v.inventory.walmartAllocation}`)).toBeInTheDocument()
  })

  it('adds a variant, converting dollars to cents once', async () => {
    vi.mocked(api.createVariant).mockResolvedValue(withStock)
    renderTab({ ...withStock, variants: [] })
    await userEvent.type(screen.getByPlaceholderText('SKU'), 'abe-2')
    await userEvent.type(screen.getByPlaceholderText('Price $'), '19.99')
    await userEvent.type(screen.getByPlaceholderText('Qty'), '2')
    await userEvent.click(screen.getByRole('button', { name: /add variant/i }))
    expect(api.createVariant).toHaveBeenCalledWith(withStock.id, { sku: 'abe-2', priceCents: 1999, onHand: 2 })
  })

  it('renders SKU and delete as locked with a reason', () => {
    renderTab({ ...withStock, variants: [{ ...v, locked: { sku: true, delete: true } }] })
    expect(screen.getByRole('button', { name: /delete/i })).toBeDisabled()
    expect(screen.getByTitle(/sold or listed on walmart/i)).toBeInTheDocument()
  })

  it('sets stock and allocation from the dialog', async () => {
    vi.mocked(api.getStockHistory).mockResolvedValue(history)
    vi.mocked(api.setStock).mockResolvedValue(withStock)
    renderTab()
    await userEvent.click(screen.getByRole('button', { name: /set stock/i }))
    const onHand = screen.getByLabelText('On hand')
    await userEvent.clear(onHand); await userEvent.type(onHand, '4')
    await userEvent.click(screen.getByLabelText(/split/i))
    const alloc = screen.getByLabelText('Walmart allocation')
    await userEvent.clear(alloc); await userEvent.type(alloc, '1')
    await userEvent.click(screen.getByRole('button', { name: /save stock/i }))
    expect(api.setStock).toHaveBeenCalledWith(v.id, expect.objectContaining({
      onHand: 4, walmartAllocation: 1, expectedOnHand: v.inventory.onHand,
    }))
  })

  it('warns about double sales when choosing shared', async () => {
    vi.mocked(api.getStockHistory).mockResolvedValue([])
    renderTab()
    await userEvent.click(screen.getByRole('button', { name: /set stock/i }))
    await userEvent.click(screen.getByLabelText(/shared/i))
    expect(screen.getByText(/can sell twice/i)).toBeInTheDocument()
  })

  it('offers to overwrite when stock changed underneath', async () => {
    vi.mocked(api.getStockHistory).mockResolvedValue([])
    vi.mocked(api.setStock)
      .mockRejectedValueOnce(new AdminApiError(stockChanged.message, stockChanged.code, undefined, stockChanged.details))
      .mockResolvedValueOnce(withStock)
    renderTab()
    await userEvent.click(screen.getByRole('button', { name: /set stock/i }))
    await userEvent.click(screen.getByRole('button', { name: /save stock/i }))
    const confirm = await screen.findByRole('button', { name: /set it anyway/i })
    await userEvent.click(confirm)
    expect(vi.mocked(api.setStock).mock.calls[1][1].expectedOnHand).toBe(stockChanged.details.onHand)
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/catalog/variants-tab.test.jsx` — Expected: FAIL.

- [ ] **Step 4: Create `tabs/StockDialog.jsx`**

```jsx
import { useEffect, useState } from 'react'
import api from '../../data/api.js'
import Modal from '../../ui/Modal.jsx'
import Button from '../../ui/Button.jsx'

/** Mirrors core's src/inventory/allocation.ts — keep the two in step. */
export function previewSplit(onHand, reserved, allocation) {
  const free = Math.max(0, onHand - reserved)
  return allocation === null
    ? { storefront: free, walmart: free, shared: true }
    : { storefront: Math.max(0, free - allocation), walmart: Math.min(allocation, free), shared: false }
}

export default function StockDialog({ variant, onClose, onSaved }) {
  const inv = variant.inventory
  const [onHand, setOnHand] = useState(String(inv.onHand))
  const [mode, setMode] = useState(inv.walmartAllocation === null ? 'shared' : 'split')
  const [allocation, setAllocation] = useState(String(inv.walmartAllocation ?? 0))
  const [note, setNote] = useState('')
  const [expected, setExpected] = useState(inv.onHand)
  const [conflict, setConflict] = useState(null)
  const [error, setError] = useState(null)
  const [history, setHistory] = useState([])

  useEffect(() => { api.getStockHistory(variant.id).then(setHistory).catch(() => setHistory([])) }, [variant.id])

  const n = Number(onHand)
  const a = mode === 'shared' ? null : Number(allocation)
  const split = previewSplit(Number.isFinite(n) ? n : 0, inv.reserved, Number.isFinite(a) ? a : 0)

  const save = async (expectedOnHand = expected) => {
    setError(null)
    try {
      onSaved(await api.setStock(variant.id, { onHand: n, walmartAllocation: a, expectedOnHand, ...(note ? { note } : {}) }))
      onClose()
    } catch (err) {
      if (err.code === 'STOCK_CHANGED') { setConflict(err.details); return }
      setError(err.message)
    }
  }

  return (
    <Modal open title={`Stock — ${variant.sku}`} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <label className="block" htmlFor="sd-onhand">
          <span className="font-semibold">On hand</span>
          <input id="sd-onhand" inputMode="numeric" value={onHand} onChange={(e) => setOnHand(e.target.value)}
            className="mt-1 w-32 rounded-lg border border-gray-200 px-2 py-1" />
          <span className="ml-2 text-gray-500">{inv.reserved} reserved by open orders</span>
        </label>

        <fieldset>
          <legend className="font-semibold">Walmart</legend>
          <label className="mr-4"><input type="radio" checked={mode === 'shared'} onChange={() => setMode('shared')} aria-label="Shared — both channels sell everything" /> Shared</label>
          <label><input type="radio" checked={mode === 'split'} onChange={() => setMode('split')} aria-label="Split — set aside units for Walmart" /> Split</label>
          {mode === 'split' && (
            <label className="mt-2 block" htmlFor="sd-alloc">
              <span>Walmart allocation</span>
              <input id="sd-alloc" inputMode="numeric" value={allocation} onChange={(e) => setAllocation(e.target.value)}
                className="ml-2 w-20 rounded-lg border border-gray-200 px-2 py-1" />
            </label>
          )}
          {mode === 'shared' && (
            <p className="mt-2 rounded-lg bg-accent-soft px-3 py-2 text-accent">
              A one-off can sell twice: once here and once on Walmart before Walmart hears it is gone.
              Someone must watch for Walmart orders that fail to import and cancel them on Walmart.
            </p>
          )}
        </fieldset>

        <p className="text-gray-600">Storefront can sell <b>{split.storefront}</b> · Walmart can sell <b>{split.walmart}</b></p>

        <label className="block" htmlFor="sd-note">
          <span className="font-semibold">Note</span> <span className="text-gray-400">(optional)</span>
          <input id="sd-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1" />
        </label>

        {error && <p className="text-accent">{error}</p>}
        {conflict ? (
          <div className="rounded-lg bg-gray-100 p-3">
            <p>Stock changed to <b>{conflict.onHand}</b> since you opened this. Set it to {onHand} anyway?</p>
            <Button className="mt-2" onClick={() => { setExpected(conflict.onHand); setConflict(null); save(conflict.onHand) }}>Set it anyway</Button>
          </div>
        ) : (
          <Button onClick={() => save()}>Save stock</Button>
        )}

        {history.length > 0 && (
          <div>
            <h4 className="font-semibold">Recent changes</h4>
            <ul className="mt-1 space-y-1 text-xs text-gray-500">
              {history.map((h, i) => (
                <li key={i}>
                  {new Date(h.at).toLocaleString()} · {h.actor} · {h.before?.onHand}→{h.after?.onHand}
                  {h.after?.walmartAllocation !== h.before?.walmartAllocation && ` · Walmart ${h.before?.walmartAllocation ?? 'shared'}→${h.after?.walmartAllocation ?? 'shared'}`}
                  {h.note && ` · ${h.note}`}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  )
}
```

- [ ] **Step 5: Rewrite `tabs/VariantsTab.jsx`**

```jsx
import { useState } from 'react'
import api from '../../data/api.js'
import { dollarsToCents, formatCents } from '../../lib/money.js'
import { useToast } from '../../ui/toast.jsx'
import BulkVariantForm from './BulkVariantForm.jsx'
import StockDialog from './StockDialog.jsx'

const LOCK_REASON = 'Locked: this variant has sold or is listed on Walmart'

function VariantRow({ v, onUpdated, onSetStock }) {
  const toast = useToast()
  const [sku, setSku] = useState(v.sku)
  const [price, setPrice] = useState((v.priceCents / 100).toFixed(2))
  const [error, setError] = useState(null)
  const cents = dollarsToCents(price)
  const dirty = sku !== v.sku || cents !== v.priceCents

  const save = async () => {
    setError(null)
    const patch = {}
    if (sku !== v.sku) patch.sku = sku
    if (cents !== v.priceCents) patch.priceCents = cents
    try { onUpdated(await api.updateVariant(v.id, patch)); toast.push('Variant saved') } catch (e) { setError(Object.values(e.fields ?? {})[0] ?? e.message) }
  }
  const remove = async () => {
    if (!window.confirm(`Delete ${v.sku}? This cannot be undone.`)) return
    try { onUpdated(await api.deleteVariant(v.id)) } catch (e) { setError(e.message) }
  }
  const inv = v.inventory
  const walmart = inv.walmartAllocation === null ? 'Shared' : `Walmart ${inv.walmartAllocation}`

  return (
    <tr className="border-t border-gray-100 align-top">
      <td className="py-2">
        <input aria-label={`SKU ${v.sku}`} value={sku} onChange={(e) => setSku(e.target.value)} readOnly={v.locked.sku}
          title={v.locked.sku ? LOCK_REASON : undefined}
          className="w-32 rounded-lg border border-gray-200 px-2 py-1 font-mono read-only:bg-gray-50" />
        {error && <span className="block text-xs text-accent">{error}</span>}
      </td>
      <td><input aria-label={`Price ${v.sku}`} value={price} onChange={(e) => setPrice(e.target.value)} className="w-24 rounded-lg border border-gray-200 px-2 py-1" /></td>
      <td>{inv.onHand}</td>
      <td className="text-gray-500">{inv.reserved}</td>
      <td className="text-gray-500">{walmart}</td>
      <td>{inv.storefrontAvailable}</td>
      <td>{inv.walmartAvailable}</td>
      <td className="space-x-2 text-right whitespace-nowrap">
        {dirty && <button onClick={save} disabled={cents === null} className="text-xs font-semibold text-brand-dark">Save</button>}
        <button onClick={() => onSetStock(v)} className="text-xs font-semibold">Set stock</button>
        <button onClick={remove} disabled={v.locked.delete} title={v.locked.delete ? LOCK_REASON : undefined}
          className="text-xs text-accent disabled:text-gray-300">Delete</button>
      </td>
    </tr>
  )
}

export default function VariantsTab({ product, onUpdated }) {
  const [draft, setDraft] = useState({ sku: '', price: '', qty: '' })
  const [error, setError] = useState(null)
  // Held here, not in the row, so the dialog never renders inside a <tr>.
  const [stockFor, setStockFor] = useState(null)
  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }))
  const cents = dollarsToCents(draft.price)

  const add = async () => {
    setError(null)
    try {
      onUpdated(await api.createVariant(product.id, {
        sku: draft.sku, priceCents: cents, ...(draft.qty !== '' ? { onHand: Number(draft.qty) } : {}),
      }))
      setDraft({ sku: '', price: '', qty: '' })
    } catch (e) { setError(Object.values(e.fields ?? {})[0] ?? e.message) }
  }
  const bulk = async (rows) => {
    setError(null)
    try { onUpdated(await api.bulkCreateVariants(product.id, rows)) } catch (e) { setError(Object.values(e.fields ?? {})[0] ?? e.message) }
  }

  return (
    <div className="space-y-4">
      <table className="w-full text-sm">
        <thead className="text-left text-gray-500">
          <tr><th className="py-2">SKU</th><th>Price</th><th>On hand</th><th>Reserved</th><th>Walmart</th><th>Store can sell</th><th>Walmart can sell</th><th></th></tr>
        </thead>
        <tbody>
          {product.variants.map((v) => (
            <VariantRow key={`${v.id}:${v.sku}:${v.priceCents}`} v={v} onUpdated={onUpdated} onSetStock={setStockFor} />
          ))}
          {product.variants.length === 0 && <tr><td colSpan={8} className="py-4 text-gray-400">No variants yet.</td></tr>}
        </tbody>
      </table>

      <div className="flex items-end gap-2">
        <input placeholder="SKU" value={draft.sku} onChange={set('sku')} className="rounded-lg border border-gray-200 px-2 py-1 text-sm" />
        <input placeholder="Price $" value={draft.price} onChange={set('price')} className="w-24 rounded-lg border border-gray-200 px-2 py-1 text-sm" />
        <input placeholder="Qty" inputMode="numeric" value={draft.qty} onChange={set('qty')} className="w-16 rounded-lg border border-gray-200 px-2 py-1 text-sm" />
        <button onClick={add} disabled={!draft.sku.trim() || cents === null}
          className="rounded-pill bg-ink px-4 py-2 text-sm text-white disabled:bg-gray-200 disabled:text-gray-500">Add variant</button>
      </div>
      {error && <p className="text-sm text-accent">{error}</p>}

      <BulkVariantForm onCreate={bulk} />
      <p className="text-xs text-gray-400">Prices are in US dollars.</p>

      {stockFor && (
        <StockDialog
          variant={product.variants.find((x) => x.id === stockFor.id) ?? stockFor}
          onClose={() => setStockFor(null)}
          onSaved={onUpdated}
        />
      )}
    </div>
  )
}
```

Change the import line to `import { dollarsToCents } from '../../lib/money.js'` — `formatCents` is not used in this file.

- [ ] **Step 6: `BulkVariantForm` emits core rows**

Change its submit to build core rows and call `onCreate(rows)`:
```jsx
  const cents = dollarsToCents(tpl.price)
  const preview = generateVariants({ ...tpl, price: 0, values: tpl.values.split(',') })
  // ...
  onClick={() => onCreate(preview.map((v) => ({ sku: v.sku, priceCents: cents, attributes: v.attributes ?? { [tpl.attribute_key]: v.value } })))}
  disabled={disabled || preview.length === 0 || !tpl.sku_prefix.trim() || cents === null}
```
Import `dollarsToCents` from `../../lib/money.js`; change the price input's placeholder to `Price $` and drop `type="number"`. Read `src/lib/variants.js` `generateVariants` first and use the exact property names it returns for the attribute value; its existing tests must still pass.

- [ ] **Step 7: Run and commit**

Run: `npx vitest run` — Expected: PASS.
```bash
git add src
git commit -m "feat(admin-ui): live variants with per-channel stock, set-stock dialog and Walmart allocation"
```

---

## Task 14: Bulk status, console verification, PR and staging end-to-end

**Files:**
- Modify: `systems/admin-ui/src/catalog/ProductList.jsx` (`bulkPublish`, the three bulk buttons)
- Test: `systems/admin-ui/src/catalog/bulk-status.test.jsx`

**Interfaces:**
- Consumes: `api.bulkSetStatus(ids, status)`, fixture `bulk-status.json`.

- [ ] **Step 1: Write the failing test**

```jsx
// src/catalog/bulk-status.test.jsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../ui/toast.jsx'
import ProductList from './ProductList.jsx'
import result from '../data/__fixtures__/bulk-status.json'

vi.mock('../data/api.js', () => ({ default: { listProducts: vi.fn(), bulkSetStatus: vi.fn() } }))
import api from '../data/api.js'
afterEach(() => vi.clearAllMocks())

const items = result.results.map((r, i) => ({ id: r.id, slug: `s${i}`, name: `Product ${i}`, status: 'draft', categories: [], variantCount: 1, imageCount: 0, updatedAt: '2026-09-24T00:00:00.000Z' }))

describe('bulk status', () => {
  it('publishes the selection and lists per-product failures', async () => {
    vi.mocked(api.listProducts).mockResolvedValue({ items, total: items.length, page: 1, pageSize: 20 })
    vi.mocked(api.bulkSetStatus).mockResolvedValue(result)
    render(<ToastProvider><MemoryRouter><ProductList /></MemoryRouter></ToastProvider>)
    for (const box of await screen.findAllByRole('checkbox')) await userEvent.click(box)
    await userEvent.click(screen.getByRole('button', { name: /publish \(2\)/i }))
    expect(api.bulkSetStatus).toHaveBeenCalledWith(items.map((i) => i.id), 'published')
    const failed = result.results.find((r) => !r.ok)
    expect(await screen.findByText(new RegExp(failed.message))).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/catalog/bulk-status.test.jsx` — Expected: FAIL (buttons disabled).

- [ ] **Step 3: Enable bulk actions in `ProductList.jsx`**

Add `const [failures, setFailures] = useState([])`. Replace `bulkPublish` and its comment with:
```jsx
  // Each product is its own transaction in core; report failures per product.
  const bulkSet = async (newStatus) => {
    const { results } = await api.bulkSetStatus([...selected], newStatus)
    const failed = results.filter((r) => !r.ok)
    const okCount = results.length - failed.length
    if (okCount > 0) toast.push(`${okCount} product(s) ${newStatus}`)
    setFailures(failed.map((r) => ({ ...r, name: data.items.find((i) => i.id === r.id)?.name ?? r.id })))
    setSelected(new Set())
    load()
  }
```
Replace the bulk button group with:
```jsx
          <div className="ml-auto flex gap-2">
            <Button variant="brand" onClick={() => bulkSet('published')}>Publish ({selected.size})</Button>
            <Button variant="ghost" onClick={() => bulkSet('draft')}>Unpublish</Button>
            <Button variant="danger" onClick={() => bulkSet('archived')}>Archive</Button>
          </div>
```
Below the filter row, render failures:
```jsx
      {failures.length > 0 && (
        <ul className="mt-3 rounded-xl bg-accent-soft px-4 py-3 text-sm text-accent">
          {failures.map((f) => <li key={f.id}>{f.name}: {f.message}</li>)}
        </ul>
      )}
```

- [ ] **Step 4: Full console verification**

Run: `npx vitest run && npm run build` — Expected: all pass, build clean. Record the count.

- [ ] **Step 5: Commit, push, PR (after Jack's OK)**

```bash
git add src
git commit -m "feat(admin-ui): bulk publish, unpublish and archive with per-product results"
git push -u origin feat/catalog-editing-console
gh pr create --base main --title "feat(admin-ui): product, variant and stock editing"
```
Watch `gh pr checks <n> --watch`; merge when green and approved; then `git push origin main:staging` (fast-forward) with Jack's OK.

- [ ] **Step 6: Staging end-to-end (spec §1 success criterion)**

After Render deploys both (confirm the new `index-*.js` bundle hash on `admin-staging` and `/health` on `api-staging`), in the signed-in browser:
1. Products → **+ New product** → "Staging Test Castle", Resale → Create. Expect the draft to open.
2. Info → set pieces 900, a feature line → Save changes. Reload; values persist.
3. Variants → add `STG-TEST-1`, $189.00, qty 1 → it appears with on hand 1, Shared.
4. Set stock → Split, allocation 1 → preview shows Storefront 0 · Walmart 1 → Save. Row shows `Walmart 1`, store can sell 0.
5. Set stock → Shared → warning appears → Save.
6. Publish → open `https://staging.alpinebrickexchange.com` and find the product; its availability shows 1.
7. `curl -s https://api-staging.alpinebrickexchange.com/api/v1/catalog/products` lists it.
8. Try renaming the slug in Info → field is locked with the reason.
9. Stock dialog → Recent changes lists steps 4 and 5 with Jack's email.

Report each step's observed result. Leave or archive the test product as Jack prefers — ask; do not delete.
