# AlpineBrick Admin Console (admin-ui)

Internal staff admin console. **Separate from the storefront** (different package, different domain — never co-bundled). Catalog management is module 1.

## Phase A (current): model pages, no backend
All data is in-memory and resets on reload (`src/data/mockApi.js`). Use this to validate the catalog-management flow.

## Run
```
npm install
npm run dev      # http://localhost:5174
npm test         # unit + integration tests (vitest)
```

## Phase B (next)
Replace `src/data/mockApi.js` with `src/data/adminApi.js` (axios → catalog-admin `/api/admin`). The function surface is identical, so pages are untouched. See `docs/superpowers/specs/2026-06-04-catalog-admin-ui-design.md`.

## Phase A known limitations / Phase B tech debt

Surfaced during code review; recorded here so they survive into the Phase B backend work.

- `store.bulkCreateVariants` is not atomic — a duplicate SKU mid-batch leaves earlier variants committed. Phase B backend needs a transaction.
- `store.updateVariant` has no field whitelist (can patch `id`/`product_id`); harmless in Phase A mock, tighten in Phase B.
- `store.reorderImages` silently drops image IDs not present in the passed order list; add a guard in Phase B.
- `useAutoSave` inner `setTimeout(idle, 1500)` isn't cleared on unmount (possible set-state-after-unmount); track + clear in a cleanup before Phase B.
- `useAutoSave` uses one shared debounce across InfoTab fields; rapid edits across fields can drop the last keystroke of an earlier field until the next save cycle.
- `ImagesTab` never calls `URL.revokeObjectURL` (object-URL retained until unload); add revocation when real upload replaces the mock in Phase B.
- Test note: `catalog.test.jsx` uses `getAllByPlaceholderText('Price')[0]` because the single-add and bulk forms both render a "Price" input (plan's exact `getByPlaceholderText` would match two).
- `useAutoSave` has no try/catch around the debounced `saveFn`; a thrown save (e.g. Phase B network error) leaves the "Saving…" indicator stuck. Add error handling in Phase B.
- `ProductList.bulkPublish` and the tabs' post-mutation `refresh()` calls are not awaited / not wrapped in try/catch; Phase B network errors would fail silently. Add error handling + await before Phase B.
- `ImagesTab` reorder/alt/delete handlers call `refresh()` without await; rapid clicks can read stale `product.images`. Await refresh in Phase B.
