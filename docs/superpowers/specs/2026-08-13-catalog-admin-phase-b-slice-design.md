# Catalog Admin — Phase B Vertical Slice — Design

**Status:** DRAFT — awaiting Jack's review.
**Date:** 2026-08-13.
**Owners:** Catalog Engineer (core write API), Admin UI (console wiring),
Engineering Lead (approver).
**Amends:** [2026-06-04 Catalog Admin UI design](2026-06-04-catalog-admin-ui-design.md) —
see §3, which supersedes its choice of backend service.

---

## 1. Where this sits

The 2026-06-04 design, approved by Jack, split catalog admin into two phases:

- **Phase A — model pages** on an in-browser mock, runnable with no backend.
  **Done.** `systems/admin-ui` is a working console shell with a catalog module,
  shared UI primitives, and six test files.
- **Phase B — wired.** A real write API, with the mock data layer replaced by
  live calls. **Not started.**

This spec covers a **vertical slice of Phase B**, not all of it.

### 1.1 Why a slice, and how much is actually missing

`mockApi` exposes **16 methods**. Core backs four:

| | Methods | State |
|---|---|---|
| Exact match | `reorderImages`, `updateImageAlt`, `deleteImage` | Built 2026-08-13 |
| Different shape | `addImage` | Core's is two-phase token→confirm |
| Partial | `listProducts`, `getProduct` | Read-only **and published-only** |
| Missing entirely | `getOverviewStats`, `createProduct`, `updateProduct`, `archiveProduct`, `setProductStatus`, `bulkSetStatus`, `createVariant`, `updateVariant`, `deleteVariant`, `bulkCreateVariants` | Nothing exists |

**Core has no product or variant write API at all.** Phase B is therefore
roughly 85% backend construction and 15% wiring — not the client swap the
original design implies.

Building all thirteen missing endpoints before anything has crossed the seam
would mean thirteen endpoints designed against assumptions. The slice proves
the seam first.

## 2. Scope

**In:** four core endpoints and the console wired to them for real.

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/admin/products` | Admin list — **all statuses**, including drafts |
| `GET /api/v1/admin/products/:id` | Admin detail — loads a draft |
| `POST /api/v1/admin/products/:id/status` | Publish / unpublish / archive |
| `GET /api/v1/admin/overview` | Console home counts — see §7 |

**Out, deliberately:** product creation and editing, variant CRUD, bulk
operations, the image-upload rework, audit log, version history and rollback.
The last three were already deferred by the 2026-06-04 design and stay deferred.

## 3. The write API lives in core — amending the 2026-06-04 design

**Ruled by Jack, 2026-08-13.**

That design put the write API in `systems/catalog-admin/code`, with "the
Postgres DB" as a sanctioned shared surface between it and the read path. That
was reasonable in June and is not now:

- **`systems/core` is the only backend of record.** `catalog-service`,
  `order-service` and the rest are pre-redesign in-memory mocks.
- **`catalog-admin` is a 400-byte health-check stub.** There is nothing to
  preserve.
- **Image admin endpoints already live in core** at `/api/v1/admin/images`,
  built 2026-08-13.

Following the old design literally would put **product writes and image writes
in two different services writing the same tables**, and make the console call
two backends to complete one workflow. Two writers of one schema is the coupling
that was tolerable when the alternative was a mock, and is a liability now that
a real backend exists.

Everything else in the 2026-06-04 design stands: `admin-ui` remains a separate
package on a separate domain, a console shell hosting modules, same libraries as
the storefront but not a shared codebase.

## 4. The success criterion

**Publish a draft in the console, refresh the storefront, and the product
appears.**

One path, exercising admin reads, a write, the status model and the public
catalog — across two frontends and one backend. If that works, the remaining
ten endpoints are pattern-following rather than discovery. If it does not, we
learn it against four endpoints instead of seventeen.

## 5. Admin reads need their own endpoints

`listProducts` and `getProduct` in `catalog.service.ts` hard-code
`status: 'published'`. An admin console that cannot see drafts is useless.

Relaxing the public routes is not an option — it would leak unpublished products
to customers, which is the exact thing `ProductStatus` exists to prevent. So
`/api/v1/admin/products` is a **separate surface** with a `status` query
parameter defaulting to *all statuses*.

The public and admin read paths share the DTO shape so the console and the
storefront see the same product, and diverge only on which rows they may see.

## 6. Status transitions are a model, not a boolean

`ProductStatus` is already `draft | published | archived`.

`POST /api/v1/admin/products/:id/status` takes a target status and validates the
transition rather than accepting any assignment:

| From → To | Allowed |
|---|---|
| `draft` → `published` | Yes |
| `published` → `draft` | Yes — unpublish |
| `draft` or `published` → `archived` | Yes |
| `archived` → `draft` | Yes — restore |
| `archived` → `published` | **No.** Restore to draft first, then publish |
| Any → same status | **No.** A no-op transition is a client bug worth surfacing |

`archived` → `published` is blocked deliberately: republishing something that
was withdrawn should be a considered act, not one click. Restoring to draft
forces a look at the product before it faces customers again.

**Archiving is not deletion.** An archived product keeps its order history,
which is why the enum exists rather than a `deletedAt` column.

## 7. The overview endpoint, and the field that is not in it

The console home is the first screen a user sees. Leaving it on mock data while
the product list beside it shows real data is worse than either — someone reads
a number and acts on fiction.

So the test applied to each field the mock returns was: **can this be stated
truthfully today?**

| Field | In the slice | Why |
|---|---|---|
| `totalProducts`, `published`, `draft`, `archived` | Yes | A `GROUP BY status`. Mechanically correct, no product judgment. |
| `recentlyModified` | Yes | `ORDER BY updatedAt DESC LIMIT 5`. Mechanical. |
| `missingVariants` | Yes | Zero variants means unsellable. Unambiguous. |
| `missingImages` | **No** | See below. |

**`missingImages` is dropped because it would be technically correct and
practically a lie.** Every seeded product has images — placeholders — so the
panel would render a reassuring empty state meaning "nothing needs attention."
In fact *every* product is missing real photography. The check cannot be written
honestly until there is a way to distinguish placeholder from real, which is a
data-quality rule deserving its own thought.

**The UI omits that panel rather than rendering it empty.** An empty panel reads
as "all clear"; an absent one reads as "not built yet", which is the truth.

## 8. Wiring the console

`admin-ui` gains `src/data/api.js` exposing **the same 16-method shape as
`mockApi`**, so no component changes to accommodate the swap.

**Five methods call core**, served by the four endpoints — `archiveProduct` and
`setProductStatus` both resolve to the status endpoint:

`getOverviewStats` · `listProducts` · `getProduct` · `setProductStatus` ·
`archiveProduct`

**Eleven throw `NotImplementedInSlice`.** Three of those —
`reorderImages`, `updateImageAlt`, `deleteImage` — **do have working core
endpoints already**, and are still left unwired here on purpose. Their entry
point does not: `addImage` needs the two-phase token→confirm rework, and an
Images tab where you can reorder and delete but never add is a worse experience
than one that is honestly switched off. Wiring them is a small follow-up once
upload lands.

### 8.1 Unbacked features are disabled, not merely throwing

Throwing alone is poor: the user learns a feature is unsupported only *after*
filling in a form. Falling back to the mock would be far worse — someone adds
three variants, sees them appear, reloads, and they are gone. **Data loss
disguised as success is the one failure mode a partial system must not have.**

So the UI **disables** what is not backed, with a short visible note, before any
effort is invested:

- Variants tab: disabled with "not in this phase".
- Images tab: disabled with "not in this phase" — see §8 on why, given three of
  its four operations already have working endpoints.
- Product creation: hidden.
- Bulk status actions: disabled.
- Publish/unpublish on product detail: **enabled** — it is the slice.

The throw stays underneath as a developer-facing backstop against a component
calling an unwired method by accident. The disabled control is the user-facing
truth; the throw is the guarantee.

### 8.2 The mock becomes a test double

`store.js` and `mockApi.js` are **not deleted**. Six existing test files depend
on them, and deleting would destroy real coverage. The *app* stops importing
them; the *tests* keep them.

A runtime toggle between mock and live was rejected: two code paths, and a mock
that silently drifts from the API it stands in for.

### 8.3 Field naming: camelCase, and the console adapts

`mockApi` speaks snake_case (`variant_count`, `image_count`, `updated_at`).
Core speaks camelCase, settled by the ADR-0001 amendment and already consumed by
the storefront.

**Core does not change.** Adapting it to snake_case would break a working
storefront to suit a mock. `api.js` returns camelCase and the four affected
components are updated.

### 8.4 Transport

Vite dev proxy to core on **4000**, matching the storefront's arrangement.

**CORS is deliberately not solved here.** The 2026-06-04 design puts the console
on a different domain, which will require it — but a dev proxy defers that until
there is somewhere to deploy.

## 9. Authentication is absent, and it gates deployment

This slice adds a **write** API with no authentication, on top of image
endpoints that already have none. Core has no auth of any kind.

That is acceptable for local and staging. It is **not** acceptable for anything
reachable: without it, anyone who can reach core can unpublish or archive the
entire catalogue.

**This is a precondition on deployment, not a footnote.** Jack chose slice-first
over auth-first on 2026-08-13, with that trade understood. Auth needs its own
spec before either `/api/v1/admin/*` surface is exposed.

## 10. Testing

| Layer | What is verified |
|---|---|
| Admin read routes | Drafts and archived products are returned; the `status` filter narrows correctly |
| Public read routes | **Still return published only** — the regression that would leak drafts to customers |
| Status transitions | Each allowed transition succeeds; `archived`→`published` and same-status are rejected with a structured error |
| Overview | Counts match fixture data; `missingImages` is absent from the response |
| `api.js` | Tested against fixtures captured from core's **actual** responses, not hand-written ideals |
| Existing console tests | Still pass against `mockApi` as a double |

The public-route regression test matters most. The whole reason for a separate
admin surface is that the public one must not widen, and that is exactly the
kind of change a later refactor makes by accident.

## 11. Risks

| Risk | Mitigation |
|---|---|
| A later change relaxes the public read filter | Explicit regression test asserting drafts are not returned publicly |
| The disabled UI reads as broken rather than staged | Short visible note on each disabled control |
| `api.js` drifts from core's real responses | Fixtures captured from a running core, not written by hand |
| Slice proves the seam but the remaining ten endpoints diverge | They follow the same route, error-envelope and DTO patterns established here |

## 12. Open questions

1. **Auth** — needs its own spec, and gates deployment of both admin surfaces.
2. **CORS and the admin domain** — required before the console is deployed
   anywhere, deferred while a dev proxy suffices.
3. **What "missing images" should mean** once real photography exists. Until
   then the check cannot be written honestly.
4. **Whether audit and version history are still wanted.** Both are in the
   original SPEC and both were deferred in June. Nothing since has needed them,
   and they should be re-justified rather than inherited.
