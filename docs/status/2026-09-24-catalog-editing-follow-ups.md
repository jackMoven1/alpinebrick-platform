# Catalog editing — follow-ups (2026-09-24)

**Source:** the per-task and whole-branch reviews of catalog product and variant
editing ([PR #34](https://github.com/jackMoven1/alpinebrick-platform/pull/34) core,
[PR #35](https://github.com/jackMoven1/alpinebrick-platform/pull/35) console).
Spec: `docs/superpowers/specs/2026-09-24-catalog-product-and-variant-editing-design.md`.

Every item here was raised by a reviewer, judged real, and deliberately deferred.
None blocked either merge; both whole-branch reviews triaged them as safe to
follow. Items fixed before merge are not listed.

Staging was verified end to end on 2026-09-24 (9/9 walkthrough steps). The test
product "Staging Test Castle" (`STG-TEST-1`) is still on staging, kept for Jack.

---

## 1. Decisions that need Jack, or a small build

| # | Item | Why it matters | Suggested fix |
|---|---|---|---|
| 1.1 | **A deliberate Walmart-allocation change is not stale-checked.** `PUT /variants/:id/stock` guards on-hand with `expectedOnHand`, but nothing guards the allocation. If a Walmart order lands while the dialog is open and the admin then changes the allocation, the admin's number wins. | Walmart sales change the allocation, not on-hand. The console no longer sends an unchanged allocation, so only a deliberate change is exposed. | Add `expectedWalmartAllocation` to the stock body and return `STOCK_CHANGED` on mismatch. **Build before the first Walmart listing.** |
| 1.2 | **Walmart cancel after a shared→split switch returns units to Walmart.** An order ingested while a variant was shared, then cancelled after the admin set an allocation, adds its quantity to the allocation (spec §5.1 rule 3, read literally). | Walmart gains units the admin gave the storefront. The invariant still holds; the split is visible and fixable in the stock dialog. | Record on each Walmart order line whether it consumed allocation, and return only what it took. |
| 1.3 | **Price ceiling of $1,000,000** (`priceCents <= 100_000_000`), added beyond spec §4.2 to catch dollars typed as cents ×100. | A genuine product above $1M would be refused. | Lift the constant in `systems/core/src/admin/product-input.ts` if ever needed. |
| 1.4 | **Drop `channel_listings.buffer_pct` one release after the code change in production.** Staging took both together safely (no listings). | Render runs `migrate deploy` while the old instance still serves; old code reading the column would fail during the switch. | Split the column drop into a later production release. |
| 1.5 | **No alert on a failed Walmart ingest** (`insufficient_stock`). With shared stock, that is how a double sale surfaces. | Until it exists, someone must watch for Walmart orders that fail to import. Already on the Walmart launch checklist. | Alert on failed ingests. |

## 2. Core — correctness and robustness

- **Slug lock can race a concurrent publish.** `updateProduct` reads `firstPublishedAt` without a row lock. Add `firstPublishedAt: null` to the update's `where` when the slug changes, or `SELECT … FOR UPDATE`. (`src/admin/product-write.service.ts`)
- **Variant lock-check vs write races.** A concurrent order line makes delete fail with a raw P2003 (500, not `VARIANT_HAS_SALES`); a concurrent listing would be cascaded away. Lock the variant row first. (`src/admin/variant-write.service.ts`)
- **Oversized integers become a 500.** Values like `99999999999` pass as integers but overflow Postgres INT. Cap pieces, positions and stock in the parsers. (`src/admin/product-input.ts`)
- **Bulk status accepts a bogus status and unknown keys.** It returns 200 with a per-row `VALIDATION_ERROR` instead of one 400. Validate the body up front. (`src/admin/product-write.service.ts` `bulkSetStatus`)
- **A non-`AdminError` mid-bulk loses partial results.** Earlier rows are committed and audited, but the response is a 500. Return per-row results for everything attempted.
- **Bulk variant DB collision isn't row-indexed.** A P2002 on row N reports `fields.sku`, not `variants.N.sku`. Untested.
- **A non-object bulk variant row** returns "body must be a JSON object" with no row index.
- **Attribute key order causes spurious `variant.update` audits.** `JSON.stringify` compares by key order, and jsonb reorders keys. Compare with sorted keys.
- **`?limit` on stock history is inconsistent.** `abc` or `1.5` silently falls back to 10, while `100` returns 400.
- **Inventory upsert may not be a native `ON CONFLICT`.** A rare 500 is possible on legacy variants that have no inventory row. New variants always get one.
- **A no-op stock set still audits and pushes** when called directly (the console no longer sends one).
- **Categories 20-tag cap applies before de-duplication.** The spec is ambiguous; it can only over-refuse.
- **Free-text fields (`description`, `longDescription`, `builderNotes`) aren't trimmed.** Consistent with the spec as written.

## 3. Console

- **Unsaved-edit guard covers tab switches and closing the browser only.** The "← Products" link and the sidebar navigate away silently, and unsaved variant-row edits aren't guarded. The app doesn't use a data router, so `useBlocker` isn't available; confirm on the Back link. (`src/catalog/ProductDetail.jsx`)
- **Stock history load failures look like "no history".** Show "couldn't load history". (`src/catalog/tabs/StockDialog.jsx`)
- **After `STOCK_CHANGED` the preview keeps the old reserved count.** Use `conflict.reserved`. The "Set it to N anyway?" prompt also shows the box value when on-hand wasn't edited.
- **Add-variant and bulk inputs rely on placeholders.** They have no labels (ruling R1 consistency), and hints aren't linked with `aria-describedby`.
- **Spec §6 gaps:** the bulk form has no starting quantity, and single "Add variant" has no attributes input.
- **Cosmetic:** a case-only SKU edit toasts "Variant saved" and stays dirty; the bulk attribute name isn't trimmed; the toast reads "N product(s) draft"; selections persist across pages, so failures for off-page products are listed by id.

## 4. Tests

- **`act(...)` warnings** in console tests (about 350 stderr lines). Noise only, from `userEvent` without `setup()` and state updates landing after the last assertion. Fix repo-wide.
- **Untested behaviour:**
  - Walmart cancel on shared stock (allocation stays NULL)
  - `getAvailability` on shared stock
  - PATCH slug collision → `SLUG_TAKEN`
  - retired-listing delete path
  - invalid stock input blocks the request
  - delete confirmation
  - an unchanged variant row shows no Save
  - locked SKU input is read-only (only the title is asserted)
  - Info / New product failures with no field attached
- **Concurrency coverage:** the allocation mutation check covers only the storefront guard (ingest's allocation guard is tested single-threaded), and `stock-concurrency` never asserts that `setStock` succeeds when unmutated.
- **Fixtures predate `walmartListing`.** Re-capture with `CAPTURE_ADMIN_FIXTURES=1 npx vitest run tests/capture-admin-fixtures.test.ts` (systems/core) and make the "not listed" test use an explicit `null`.
- **Cosmetic:** the `walmart-inventory-sync` test is still named "pushes ATS…"; `schema.prisma` needs `prisma format`; the stock-history `after` object duplicates the top-level `note` (genuine core output).
