# Catalog Admin UI — Design

**Date:** 2026-06-04
**Status:** Approved (Jack, 2026-06-04)
**Owner:** Catalog Engineer (full-stack; charter widened to internal admin tooling)
**Builds on:** `systems/catalog-admin/docs/SPEC.md` (Phase 1 MVP spec), ADR-0001 (v1 catalog read contract)

---

## 1. Goal

Give ImagiBricks staff a web UI to manage a catalog of products. Delivered in two phases:

- **Phase A — Model pages:** clickable, stateful admin pages Jack can run locally and validate, backed by an in-browser mock data layer (no backend required).
- **Phase B — Wired:** a real catalog-admin write API backend, with the frontend's mock data layer swapped for live API calls. Once wired, products published in the admin console appear on the customer storefront.

This design covers the **core catalog-management loop** first: a catalog overview home, product list, create, and a tabbed product detail (Info / Variants / Images / Publish). Audit log, version history, and rollback are specified in the SPEC but deferred to a later pass.

## 2. Hard constraints (Jack, 2026-06-04)

- The Admin UI is a **separate, distinct deliverable** from the customer storefront. **Do not build them in the same package.**
- The Admin UI is accessed on a **different domain** than the storefront.
- The Admin UI will **grow** — more admin functions get added later. It is built as a **console shell** that hosts modules; catalog management is module 1.
- "Match the storefront stack" means **reuse the same libraries and conventions** (React + Vite + Tailwind, plain JS) — NOT share a codebase.

## 3. Package layout

Three independent fronts, separately buildable and deployable, no shared bundles:

| Package | Role | Domain |
| --- | --- | --- |
| `systems/storefront/code` | Customer storefront (exists) | public store |
| `systems/admin-ui/` *(new)* | Staff admin **console** SPA — nav shell + **Catalog** module 1 | internal admin |
| `systems/catalog-admin/code` | Catalog **write API** backend | internal API |

**Sanctioned shared surfaces only:** the Postgres DB (catalog-admin writes what catalog-service reads) and optionally the `@imagibricks/contracts` package. Nothing else couples the apps.

Note: this supersedes the SPEC's assumption (§3.2) that the frontend SPA lives inside the catalog-admin backend service. The frontend is its own package (`systems/admin-ui/`); the backend stays a separate service the console calls.

## 4. Stack

- React 18 + Vite + Tailwind CSS + axios + Vitest, **plain JS (JSX)** — same as the storefront, distinct codebase.
- New dependency, **`admin-ui` only:** `react-router-dom` for client routing.
- Add further libraries (e.g. a table or form helper) only when a feature concretely needs one. No TypeScript, Zustand, Headless UI, or TanStack Table up front (diverges from SPEC §3.1 by design, to match the real storefront).

## 5. Visual design language

Source: `systems/admin-ui/design/references/Model Admin Home Page.webp` (Jack-supplied, 2026-06-04). Adopt its **look & feel** — not its content. The model is a full store-ops dashboard; ImagiBricks adopts the visual language and applies it to catalog-scoped content.

**Design tokens / treatment:**
- **Background:** soft lavender-grey page background; content on white, rounded-corner cards with gentle soft shadows. Light, airy, generous whitespace.
- **Color:** **violet/purple** primary accent (`~#7B5CFA`); **pink/magenta** secondary accent for data contrast; **black** for primary action buttons and the active nav item; green for positive deltas. (Exact hexes to be pinned during build; may be retuned to an ImagiBricks brand palette later — keep them in one Tailwind theme config.)
- **Shape language:** pill-shaped buttons, badges, and nav highlights; large card radii; thin progress bars.
- **Layout grammar:** top bar (logo · section nav · search/notifications/avatar) → page header (title + subtitle, right-aligned controls such as a period dropdown + primary button) → grid of metric/summary cards → wider content rows.
- **Type:** clean geometric sans; bold, oversized numerals for headline figures.

Centralize these as Tailwind theme tokens + a small set of shared UI primitives (Card, Pill/Badge, Button, StatCard, ProgressBar) so the language is consistent and re-themable.

## 6. Phase A — Model pages (no backend)

### 6.1 Console shell
An app shell with a sidebar/top nav listing sections; "Catalog" is the only active section now, with the structure ready to add more later. Top bar shows the mock admin user, search, and notifications affordance (visual only in Phase A). Styling per §5.

### 6.2 Routes & pages (Catalog module)
- **`/` (or `/catalog`) — Catalog Overview home:** dashboard in the model's visual style, populated only with catalog data we can actually compute: total products, published vs draft (and archived) counts, recently modified products, and attention lists (products missing images / missing variants). No revenue/orders/shipping/customers widgets — those are out of catalog scope. Cards link into the relevant filtered product list.
- **`/products` — ProductList:** table with columns name, variant count, status pill (Draft/Published/Archived), last modified, row actions. Search box, category + status filters, sortable columns, pagination (20/page default). Multi-select with bulk publish/unpublish.
- **`/products/new` — ProductForm (create):** fields name, description, categories, auto-generated slug (editable), metadata. Inline validation; submit disabled until valid; duplicate-slug error surfaced.
- **`/products/:id` — ProductDetail (tabbed):**
  - **Info** — editable fields with debounced auto-save indicator ("Saving…" → "Saved").
  - **Variants** — VariantTable (SKU, price, attributes JSON, actions) with add/edit/delete; BulkVariantForm to generate N variants from a template (e.g. S/M/L/XL at a price), with preview-and-confirm.
  - **Images** — drag-drop gallery, reorder (updates display order), per-image alt text, delete. Phase A uploads are mocked via browser object URLs.
  - **Publish** — state selector (Draft/Published/Archived), publish/unpublish actions, validation warnings (no variants / no images / no description) that warn but don't block.

### 6.3 Components
ConsoleShell/Nav, CatalogOverview (+ StatCard widgets), ProductList, ProductDetail, ProductForm, VariantTable, BulkVariantForm, ImageGallery, PublishPanel, plus shared UI primitives (§5) and Toast notifications, confirm modals, loading/empty states. Component breakdown follows SPEC §3.1.

### 6.4 Mock data layer
A single module `mockApi.js` exposing the same function surface the real API client will expose (overview-stats/list/get/create/update/publish/variants/images). It is **stateful in-session**: seeded with a few sample products, and create/edit/variant/publish operations mutate an in-memory store so the UI reflects changes during a session. This makes Phase A a functional prototype, not static screens. All async to mirror real latency.

### 6.5 Deferred from this slice
Audit tab, version history, rollback (SPEC §2.5). Real authentication — Phase 1 uses a mock single-admin user throughout.

### 6.6 How Jack validates
`npm install` then `npm run dev` in `systems/admin-ui/`, open the local Vite URL, click through the full overview → create → variants → images → publish loop.

## 7. Phase B — Wire to backend

### 7.1 Backend (catalog-admin write API)
Build per SPEC §3.2–3.3:
- Express app: routes (products, variants, images, publishing) → controllers → models, on the shared `pg` pool / shared DB (`db.js` shared with catalog-service).
- DB migrations: create `images`, `audit_logs`, `versions`; `ALTER` products/variants per SPEC §3.3 (`created_by`, `updated_by`, `archived_at`, `published_at`).
- Mock auth middleware (`req.user = {id:'admin-1', role:'admin'}`), global error handler returning `{error, code, status}`, request logging.
- Image upload via multer to a local Docker volume (`/data/images/...`); served as static files. Image CDN remains deferred per ADR-0002.
- Zod request validation; parameterized queries.

### 7.2 Contract & review
- A short catalog-admin API contract note (ADR) documenting the `/api/admin/...` shapes.
- Light storefront review focused on published-state visibility through catalog-service (per SPEC §4.2). Heavier than necessary for purely internal shapes, but the published→storefront seam matters.

### 7.3 Frontend swap
Replace `mockApi.js` with `adminApi.js` (axios, base `/api/admin`, configurable env var, retry on transient 5xx). Because all data access is isolated behind that one module with a stable function surface, **no page or component rewrites** are needed — Phase A components carry straight into Phase B.

### 7.4 Payoff seam
catalog-admin writes to the same Postgres DB that catalog-service reads. Publishing a product in the console makes it appear on the storefront — satisfying SPEC success criterion #7 and giving Jack a real catalog to manage.

## 8. Out of scope (Phase 1)

Audit/version/rollback UI, real auth, S3/third-party storage, get-by-slug, variant option-axis model, faceted categories, related products, real inventory-quantity linkage (catalog↔inventory is a separate unwritten ADR). Revenue/orders/shipping/customers dashboards (OMS/analytics territory). Image CDN (ADR-0002) and dedicated search backend (ADR-0003) remain parked.

## 9. Risks / notes

- **Mock-to-real drift:** mitigated by making `mockApi.js` and `adminApi.js` share an identical function surface; the contract note pins the shapes.
- **react-router-dom** is new to the repo but scoped to admin-ui only; boring, standard choice.
- The model pages are throwaway only in their *data layer* — the UI components are the real Phase B deliverable, so Phase A is not wasted work.
- **Design-language source is a fitness-store dashboard;** adopt visual treatment only, keep content catalog-scoped. Colors may be retuned to an ImagiBricks brand palette — keep them centralized in Tailwind theme config.
