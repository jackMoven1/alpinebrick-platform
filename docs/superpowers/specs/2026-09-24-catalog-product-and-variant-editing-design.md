# Catalog Admin — Product and Variant Editing — Design

**Status:** Approved in conversation by Jack, 2026-09-24 (sections 1–5). Awaiting
review of this written form.
**Date:** 2026-09-24.
**Completes:** Phase B of the [2026-06-04 catalog admin design](2026-06-04-catalog-admin-ui-design.md),
following the [2026-08-13 Phase B slice](2026-08-13-catalog-admin-phase-b-slice-design.md).
Everything that slice established — the write API lives in core (§3), the status
transition model (§6), unbacked features disabled rather than faked (§8.1), the
mock as a test double only (§8.2), camelCase (§8.3) — stands unchanged.

---

## 1. Why now

Staging went live on 2026-09-24. The admin console signs in and lists products,
but core has **no product or variant write API**, and staging's database is
empty. The console therefore cannot put a single product on the storefront.
This design closes that gap so real inventory can be loaded into staging.

**Success criterion:** in the staging console, create a product, add variants
with stock, publish it, see it on `staging.alpinebrickexchange.com`, change its
stock, and find every one of those changes in the audit log.

## 2. Decisions taken in conversation (Jack, 2026-09-24)

| Question | Ruling |
|---|---|
| Can admins set stock? | **Yes** — edit on-hand per variant, every change recorded, never below reserved |
| Which product fields? | **Every field in the schema**, not an essentials subset |
| API shape | **Granular endpoints** (approach A), not a whole-product save (B) or a generic CRUD layer (C) |

Approach B was rejected because a variant missing from a stale payload would read
as "delete it" — silent loss of a variant that may already have sold — and
because stock would travel inside product saves and race checkout. C was rejected
because validation, the transition model, audit and the reserved floor would all
be bolted around a generic layer rather than built in.

## 3. API surface

All routes are under `/api/v1/admin` and inherit its existing guards:
`requireAuth`, `requireOrigin`, and the JSON content-type check for writes.

| Method and path | Does | Console method it backs |
|---|---|---|
| `POST /products` | Create a product — **always `draft`** | `createProduct` |
| `PATCH /products/:id` | Partial update of product fields | `updateProduct` |
| `POST /products/:id/variants` | Add one variant, optional starting stock | `createVariant` |
| `POST /products/:id/variants/bulk` | Add several variants, **all-or-nothing** in one transaction | `bulkCreateVariants` |
| `PATCH /variants/:id` | Edit SKU, price or attributes | `updateVariant` |
| `DELETE /variants/:id` | Remove a variant — only if never sold (§4.2) | `deleteVariant` |
| `PUT /variants/:id/stock` | Set on-hand to an absolute value (§5) | new |
| `GET /variants/:id/stock-history` | Recent stock changes, from the audit log (§5) | new |
| `POST /products/bulk-status` | Status change for many products, each validated by the §6 transition model of the slice spec | `bulkSetStatus` |

**Responses.** Every product or variant write returns the **full admin product
DTO** — the shape `GET /api/v1/admin/products/:id` already returns — extended
with per-variant `inventory: { onHand, reserved, available }` and per-variant
`locked: { sku: boolean, delete: boolean }`, plus product-level
`locked: { slug: boolean }` and `firstPublishedAt`. The console re-renders from
the response; it never patches local state optimistically.

`POST /products/bulk-status` returns `{ results: [{ id, ok, code?, message? }] }`
— one entry per requested id, so a partial failure is reported per product.
Each product's transition is its own transaction; one failure does not roll back
the others.

**Errors.** Same envelope as the slice: `{ code, message }`, UPPER_SNAKE codes.

| Code | HTTP | When |
|---|---|---|
| `NOT_FOUND` | 404 | Unknown product or variant id |
| `VALIDATION_ERROR` | 400 | Bad input. Carries `fields: { <field>: <message> }` |
| `INVALID_TRANSITION` | 409 | Existing — status rule refused |
| `SLUG_TAKEN` | 409 | Slug already used by another product |
| `SKU_TAKEN` | 409 | SKU already used by another variant |
| `SLUG_LOCKED` | 409 | Slug change on a product that has ever been published |
| `SKU_LOCKED` | 409 | SKU change on a variant with an order line or a non-retired listing |
| `VARIANT_HAS_SALES` | 409 | Delete of such a variant |
| `STOCK_BELOW_RESERVED` | 409 | Stock set below `reserved`. Message states the reserved count |
| `STOCK_CHANGED` | 409 | `expectedOnHand` no longer matches. Body carries current `onHand` and `reserved` |

`SKU_TAKEN` and `SLUG_TAKEN` are produced from the unique-constraint violation
(Prisma `P2002`), not from a read-then-write check, so two concurrent creates
cannot both pass.

**Out of scope, deliberately:**

- **Deleting products.** Archiving is the removal path (slice spec §6).
- **Designer attribution.** `designer_id` is decided in principle (single
  nullable FK, immutable) but is not in the schema and no designers exist.
  `own_designed` products are created without one. Its own follow-up.
- **Image upload.** ADR-0002. The Images tab stays disabled.
- **On-order / purchase orders.** Read-only here; a later operations build.
- **Slug redirects.** Not built; see §4.1 for why the lock makes them unnecessary now.

## 4. Data rules

### 4.1 Products

- **Required at create:** `name` and `productType` (`own_designed` | `resale`).
  `slug` is derived from the name when omitted (existing `slugify` behaviour).
  Status is always `draft` regardless of input.
- **Slug:** `^[a-z0-9]+(-[a-z0-9]+)*$`, at most 80 characters, unique.
- **Slug locks once the product has ever been published.** The storefront URL is
  `/products/<slug>`; changing it breaks links and search results. "Ever" is
  recorded by a new nullable column `first_published_at`, set on the first
  transition into `published` and **never cleared** — unpublishing or archiving
  does not unlock the slug. To move a live product's URL, archive it and create a
  new one.
- **Field validation:**

| Field | Rule |
|---|---|
| `name` | 1–200 characters, trimmed |
| `description` | ≤ 500 characters |
| `longDescription` | ≤ 10 000 characters |
| `releaseType` | `standard` \| `limited_run` \| `specialty` |
| `categories` | array of ≤ 20 lowercase slug-style tags, de-duplicated |
| `pieces` | integer ≥ 1, or null |
| `difficulty` | `beginner` \| `intermediate` \| `advanced` \| `expert`, or null |
| `ageRecommendation` | ≤ 20 characters, or null |
| `dimensions` | ≤ 100 characters, or null |
| `features`, `includes` | arrays of ≤ 30 strings, each 1–200 characters |
| `builderNotes` | ≤ 5 000 characters |
| `homePosition`, `collectionPosition` | integer ≥ 1, or null (null sorts last) |
| `productType` | editable, same enum as create |

  Unknown keys in a `PATCH` body are rejected (`VALIDATION_ERROR`), so a typo
  cannot silently do nothing. `status`, `id`, `createdAt`, `updatedAt` and
  `firstPublishedAt` are not writable through `PATCH` — status changes go through
  the status endpoints.
- **Editing a published product is allowed and immediate.** There is no draft
  copy of a live product. The audit row's before/after makes every edit
  traceable.

### 4.2 Variants

- **SKU:** `^[A-Z0-9]+(-[A-Z0-9]+)*$`, at most 64 characters, unique across all
  variants. Input is upper-cased before validation.
- **SKU locks** once the variant has **any order line** or **any channel listing
  whose status is not `retired`**. Order lines snapshot their own `sku`, but
  Walmart and reconciliation key on SKU, and a renamed SKU after sale confuses
  both.
- **Price:** integer `priceCents` > 0. The console converts dollars to cents once,
  on submit. Past orders keep their snapshotted `unitPriceCents`.
- **Currency:** `USD` only; any other value is `VALIDATION_ERROR`.
- **Attributes:** flat object of ≤ 10 string keys (1–40 chars) to string values
  (1–100 chars).
- **Delete is refused** (`VARIANT_HAS_SALES`) when the variant has any order line
  (the FK is already `onDelete: Restrict`) or any non-retired channel listing
  (whose FK is `onDelete: Cascade`, so without this check a delete would silently
  erase the record of a listing that may still be live on Walmart). The message
  says: archive the product instead.
- **Every new variant gets an `Inventory` row**, `onHand` = the optional starting
  quantity (integer ≥ 0) or 0.

### 4.3 Every write

Validation, the change, and its `AuditLog` row happen in **one transaction**. If
the audit write fails, the change rolls back. Actions:

`product.create` · `product.update` · `product.status` (existing) ·
`variant.create` · `variant.update` · `variant.delete` · `variant.stock.set`

`product.update` and `variant.update` record only the fields that changed, before
and after.

## 5. Stock

`PUT /api/v1/admin/variants/:id/stock` — body
`{ onHand: number, expectedOnHand?: number, note?: string }`.

- **Absolute, not relative.** `onHand` is the physical count on the shelf.
  Integer ≥ 0. `note` ≤ 500 characters.
- **Never below reserved.** One guarded statement:
  `UPDATE inventory SET on_hand = $n WHERE variant_id = $v AND reserved <= $n
  [AND on_hand = $expected]`. Zero rows affected is then disambiguated by
  re-reading the row: `reserved > n` → `STOCK_BELOW_RESERVED`; `on_hand ≠
  expected` → `STOCK_CHANGED`.
- **Stale-screen protection.** The console always sends `expectedOnHand` — the
  value it displayed. On `STOCK_CHANGED` it shows *"stock changed to X since you
  opened this — set it to N anyway?"*; confirming resends with the new
  `expectedOnHand`. Omitting `expectedOnHand` skips the check (API callers only).
- **History is the audit log.** `variant.stock.set` with before/after
  `{ onHand, reserved }` and the `note`. A new read endpoint,
  `GET /api/v1/admin/variants/:id/stock-history?limit=10`, returns the most
  recent entries (actor email, time, before, after, note) for the console.
- **Walmart stays in step.** After commit, call the existing
  `enqueueInventoryPush(variantId)`, wrapped exactly like
  `enqueueInventoryPushesAfterCommit` in `orders.service.ts`: a failure is
  logged, never surfaced as a failed stock change. It is a no-op for variants
  without a listing — all of them today.
- **The console shows** on hand, reserved and available (`onHand − reserved`) per
  variant. Only on hand is editable.

## 6. Console changes

No new pages; the Phase A screens are wired and extended.

- **New product** (`ProductForm`): adds required **type**. On save, navigates to
  the new draft. "+ New product" is enabled on Overview and the Products list.
- **Info tab: editable with an explicit Save.** Not the Phase A `useAutoSave` —
  on a published product every keystroke would hit the live storefront. A dirty
  indicator shows unsaved changes; leaving with unsaved edits asks first.
  Sections: *Basics* (name, slug, type, release type, categories) · *Description*
  (short, long) · *Build details* (pieces, difficulty, age, dimensions) ·
  *Contents* (features, includes, builder notes) · *Merchandising* (home and
  collection position). The slug field shows locked, with the reason, when
  `locked.slug`. Field errors from `fields` render inline.
- **Variants tab: live.** Table of SKU, price, attributes, on hand, reserved,
  available, delete. Inline row edit with per-row save. SKU and delete render
  locked, with the reason, from `locked`. "Add variant" and the existing
  `BulkVariantForm` work, each with an optional starting quantity. **Set stock**
  opens a dialog: new count, optional note, the `STOCK_CHANGED` confirmation, and
  the last ten history entries.
- **Publish tab and Products list:** bulk publish / unpublish / archive enabled,
  with per-product failures listed from `results`.
- **Images tab:** unchanged — disabled, "not in this phase".
- **No mock fallback.** `api.js` gains the new methods; each calls core. Anything
  not built stays visibly disabled (slice §8.1).

## 7. Schema change

One migration: `products.first_published_at TIMESTAMP(3) NULL`.

- Set in the same transaction as the first `→ published` transition, only when
  currently null.
- No backfill. On staging nothing has been published. Were this applied where
  products had been published, those rows would read as never-published and
  their slugs would stay editable — acceptable as a one-time gap, and noted in
  the migration comment.

Nothing else changes in the schema: every product field, `Inventory` and
`AuditLog` already exist.

## 8. Testing

**Core**, against the real test database, following existing test patterns:

- Every endpoint: success; each `VALIDATION_ERROR` with its `fields`;
  `SLUG_TAKEN` / `SKU_TAKEN`; unknown ids → 404; unknown `PATCH` keys rejected.
- Locks, both directions: slug editable before first publish, locked after —
  and still locked after unpublish; SKU editable with no sales, locked with an
  order line, locked with a live listing, **editable again with only a retired
  listing**; delete refused in the same two cases.
- Stock: below-reserved refused with the reserved count; stale `expectedOnHand`
  → `STOCK_CHANGED` with current values; audit row written;
  `enqueueInventoryPush` called after commit, and a thrown push does not fail
  the request.
- **Concurrency:** a stock set racing `placeOrder` reservations on one variant
  never leaves `reserved > onHand`. Run repeatedly; **verified non-vacuous by
  mutation** — temporarily drop the `reserved <= $n` guard, confirm the test
  fails, restore (the PR #19 procedure).
- Atomicity: a forced audit failure rolls back the change.
- Bulk variants: one invalid row → nothing created.
- **Regression:** the public catalog still returns published products only.

**Console:** a test per wired screen, stubbed with **responses captured from a
running core** (the lesson of PR #32, where the mock hid a field core omits);
the dirty-state Save, lock rendering, and the `STOCK_CHANGED` dialog. Existing
tests keep running against `mockApi`.

**Before any merge:** CI green, `npm run build`, and **the compiled server
booted** — a green suite does not prove the app starts.

## 9. Rollout

1. PRs per plan task, each through CI.
2. Merge to `main`, fast-forward `staging`; Render auto-deploys and runs the
   migration in `preDeployCommand`.
3. End-to-end on staging per the §1 success criterion.
4. Production is out of scope.

After this lands, staging is ready for real inventory. Product photography still
waits for ADR-0002.

## 10. Risks

| Risk | Mitigation |
|---|---|
| An edit to a published product goes live by mistake | Explicit Save, never auto-save; audit before/after |
| Stock overwrite erases a concurrent sale's movement | `expectedOnHand` check; guarded single-statement update |
| Stock set below what orders reserved | `reserved <= n` guard in the same statement |
| Deleting a variant erases a live Walmart listing record | Delete refused while any non-retired listing exists |
| Console tests pass against a mock that differs from core | Fixtures captured from a running core |
| A later refactor widens the public catalog to drafts | Explicit regression test |
