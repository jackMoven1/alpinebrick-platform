# ADR-0001 — Catalog API Contract

**Status:** ACCEPTED — both engineers signed off and sign-off conditions 1–6 are met (2026-06-03). Image-CDN and relevance-search remain carved out as future ADRs / Jack spend decisions.
**AMENDED 2026-08-12 - read the amendment at the end of this file before using this contract.**
The v1 surface below was never implemented as written; core became the source of truth.

**Owners:** `catalog-engineer` (primary), `storefront-engineer` (primary), `engineering-lead` (approver).
**Date opened:** 2026-06-03.

## Context
The catalog domain is split across two engineers:
- The **Catalog Engineer** owns the catalog backend — data model, services, read and write/admin APIs, search infrastructure, image-handling backend.
- The **Storefront Engineer** owns the customer-facing UI — catalog browse pages, product-detail pages, search/filter controls, cart, checkout, accounts, site shell.

They meet at the **catalog API contract**: the endpoints the storefront and admin tooling call. That contract is the load-bearing seam — every browse page, every search result, every product image flows through it.

This ADR is where that contract lives. Neither engineer ships features that depend on the contract until this document is filled in and signed off. The storefront never reaches around the API into catalog data directly; the catalog never tries to render UI.

## To be decided
Concretely, the two engineers need to agree on:

**Base & versioning**
- Base URL convention (e.g. `/api/v1/catalog/...`).
- How breaking changes are handled (new versioned path vs. backward-compatible amendments).

**Read endpoints (storefront consumes)**
- List / browse products — with pagination, filtering, sorting, free-text search.
- Get product by id and by slug.
- Get category tree / faceted-navigation structure.
- Faceted-search response shape.
- "Related products" / cross-sell hooks (if any in v1).

**Write endpoints (admin)**
- Create / update / archive product.
- Bulk import.
- Input shape that matches the future Listing Writer agent's output format.

**Response shapes**
- Product (id, slug, name, description format, variants, options, images, prices, metadata).
- Category.
- Image set (URL conventions, sizes/variants, alt text).
- Pagination envelope.
- Error shape (code, message, fields).

**Query semantics**
- Pagination: cursor vs. offset; default page size.
- Filter syntax: query-string params vs. JSON body; facet representation.
- Sort options.
- Search: relevance vs. exact match; partial-match behavior.

**Image URL convention**
- Direct URLs vs. signed URLs.
- Variants/transforms (sizes the storefront actually needs).
- CDN host / origin separation.

**Performance targets**
- Latency budget for listing endpoints.
- Latency budget for product-detail.
- Latency budget for search.

**Auth (referenced, decided elsewhere)**
- Read endpoints: public.
- Write endpoints: admin-only; mechanism out of scope of this ADR.

## Process
1. **Catalog Engineer** drafts initial proposals for response shapes and query semantics based on the product data model (his first deliverable).
2. **Storefront Engineer** overlays rendering requirements and proposes any adjustments based on what each page actually needs.
3. The engineers iterate until the contract matches both the admin workflow and storefront rendering needs.
4. **Storefront Review Checkpoints**:
   - Confirm the product list payload matches the storefront's table/card requirements.
   - Confirm the product-detail payload contains the variants, images, inventory linkage, and publish state the storefront needs.
   - Confirm image URL conventions and reorder semantics are compatible with storefront rendering.
   - Confirm filter/search query syntax and pagination conventions are stable for storefront consumption.
   - Confirm error shapes and status codes are aligned with frontend error handling.
5. **Engineering Lead** reviews the final contract and approves the document.
6. **Jack** is briefed on anything that locks us into paid infrastructure (search engine choice, image CDN).
7. Once signed, both engineers implement against this contract. Changes require either a follow-on ADR or a clearly-marked amendment to this one.

## Approval
- `catalog-engineer` and `storefront-engineer` must both agree before implementation begins.
- `engineering-lead` must sign off by updating the ADR `Status` to `ACCEPTED` and leaving an approval note in the ADR history.

## Decision

These decisions were ruled by the Engineering Lead on 2026-06-03 after the Storefront Engineer's review (REQUEST-CHANGES, 5 blockers). They are binding for the v1 contract; the Catalog Engineer implements against them and both engineers re-sign before the status flips to ACCEPTED.

**Base path & versioning.** All catalog endpoints are served under `/api/v1/catalog/...`. The version lives in the path so future breaking changes ship as an additive `/api/v2/...` rather than a rewrite. The OpenAPI `servers`/paths, the catalog service routes, and the storefront BFF proxy must all use this prefix consistently.

**Pagination.** `GET /api/v1/catalog/products` uses offset pagination with query params `page` (default `1`) and `limit` (default `24`, max `100`). The response is an envelope — **not** a bare array:

```json
{ "items": [ /* Product[] */ ], "total": 0, "page": 1, "limit": 24 }
```

`total` is the full unpaginated count (server-side `COUNT(*)`). The storefront stops slicing the catalog client-side and trusts this envelope. Detail endpoints return a single object (no envelope).

**Filter / sort / search.** These params on `GET /api/v1/catalog/products` are frozen and documented in OpenAPI:
- `published` (boolean) — defaults to published-only when omitted.
- `category` (string) — single value, exact match against the product's category list.
- `search` (string) — **substring** match (case-insensitive) across `name` + `description`. v1 is explicitly substring, *not* relevance-ranked.
- `sort` (enum) — `name_asc` (default), `price_asc`, `price_desc`, `newest`. Set is frozen for v1.

**Response field naming.** All JSON fields are `snake_case` across every endpoint (e.g. `product_id`, `available_quantity`, `inventory_item_id`, `created_at`). The availability endpoint's `productId` is renamed to `product_id`.

**Images.** `Product.images` is an array of objects, not bare strings:

```json
{ "url": "https://…", "alt": "human-authored alt text" }
```

`alt` is required (WCAG 2.1 AA). Array order is display order; **the first element is the primary image**. `url` is a plain absolute-or-relative URL for v1. The shape is forward-compatible — `width`/`height`/`variants` may be added later without breaking consumers. Seed data must carry real `alt` text.

**Errors.** One error shape across all endpoints:

```json
{ "code": "NOT_FOUND", "message": "human-readable", "fields": { } }
```

`code` is a stable machine-readable token (`NOT_FOUND`, `VALIDATION_ERROR`, `INTERNAL`, …); `fields` is optional per-field validation detail. OpenAPI enumerates non-2xx responses per endpoint: `404` on by-id and availability routes, `400` for bad pagination/sort params, `500` generic.

**Availability typing.** `available_quantity` is typed `integer | null`. It returns `null` until the catalog↔inventory integration lands (a separate ADR); the storefront treats `null` as "unknown — render as available" for v1. The contract must not type it as a plain `integer` while the service returns `null`.

### Deferred to a later ADR / version (noted so the v1 boundary is on the record)
- Get-product-by-slug (by-id works for v1; slug field is stable for SEO URLs in v1.1).
- Variant option/axis model for the product-detail selection UI (`attributes` map suffices for v1 rendering).
- Faceted category tree / facet counts; multi-select category filtering.
- Related-products / cross-sell hooks.
- Durable `metadata` key schema — `metadata` stays free-form; consumers must treat unknown keys as optional.

### Escalated to Jack (paid-infra commitments — NOT decided in this ADR)
- **Image CDN / transform service** — logged as [ADR-0002](0002-image-cdn-asset-delivery.md) (DRAFT, deferred). The `{ url, alt }` shape stays CDN-agnostic so this can be chosen later without a contract break.
- **Relevance search engine** — logged as [ADR-0003](0003-catalog-search-backend.md) (DRAFT, deferred). v1 search is substring-match; a relevance backend is a future Jack spend decision.

## Approval history
- **2026-06-03 — Storefront Engineer:** REQUEST-CHANGES. Five blockers (base-path drift, no pagination envelope, undocumented query syntax, bare image strings, no error contract) plus non-blocking recommendations.
- **2026-06-03 — Engineering Lead:** NOT-YET-APPROVED → returned for one focused revision pass with the rulings above. Status set to PROPOSED. Final ACCEPTED is withheld until the sign-off checklist is met.
- **2026-06-03 — Catalog Engineer:** conformed `contracts/openapi/catalog.yaml` and the catalog service to the rulings (base path, pagination envelope, frozen filters + sort, snake_case, `{url,alt}` images, `{code,message,fields}` errors, `available_quantity: integer|null`). Real jest suite added (14 passing). Conditions 1–3 met.
- **2026-06-03 — Storefront Engineer:** re-sign **APPROVE**. All five original blockers resolved; BFF proxy → `/api/v1/catalog`, client consumes the `{items,total,page,limit}` envelope (client-side slicing removed), images render `{url,alt}`, error codes distinguish empty-state vs retry. Storefront builds clean. Condition 4 met.
- **2026-06-03 — Engineering Lead:** **ACCEPTED.** Conditions 1–6 satisfied; both engineers' verdicts are APPROVE. CDN and relevance-search remain explicitly out of v1 scope (future ADRs / Jack decisions), per condition 5.

### Conditions for final sign-off (flips Status → ACCEPTED)
1. This Decision section is reflected in `contracts/openapi/catalog.yaml` as the single, internally consistent source of truth.
2. OpenAPI: `servers` + all paths under `/api/v1/catalog`; `/products` documents `page`/`limit`/`published`/`category`/`search`/`sort` and returns the `{ items, total, page, limit }` envelope; `Product.images` is `{ url, alt }`; an `Error` schema exists and every endpoint enumerates non-2xx; `available_quantity` is `integer | null`; all fields snake_case.
3. Catalog service implementation conforms to the spec (server-side pagination with real `total`, `sort` honored, `{ code, message, fields }` error bodies, seed data carries `alt`), or any gap is tracked with a referenced follow-up.
4. Storefront BFF proxy updated to `/api/v1/catalog`; storefront no longer slices the catalog client-side (Storefront Engineer confirms).
5. CDN and relevance-search remain explicitly carved out as future ADRs (not silently assumed).
6. Both engineers re-sign: Storefront Engineer's five blockers each resolved or deferred-by-agreement; Catalog Engineer confirms feasibility; verdicts flip to APPROVE.

## Consequences
- Path versioning (`/api/v1/...`) is adopted from day one, making future breaking changes additive rather than a migration — cheap insurance while there is a single consumer.
- The storefront's client-side full-catalog fetch-and-slice is retired in favor of a server-truthful pagination envelope, removing a known scaling cliff before it ships.
- Authoring `alt` text becomes part of catalog data entry from v1, so the storefront is accessible at launch rather than backfilled later.
- The v1 surface is deliberately narrow: slug lookup, variant axes, faceted navigation, related products, a CDN, and relevance search are all explicitly out of scope and tracked for future ADRs, so silence is not read as a commitment.
- Two spend decisions (image CDN, search engine) are surfaced to Jack early and decoupled from launch, so neither blocks the v1 build.

---

## ADR conventions for this repo
- ADRs live in `engineering/docs/adr/` numbered sequentially: `0001-`, `0002-`, ...
- Status values: `DRAFT`, `PROPOSED`, `ACCEPTED`, `SUPERSEDED`, `DEPRECATED`.
- Each ADR names primary owners (which engineer agents) and an approver.
- Superseding ADRs link back to what they replace.

---

## Amendment — 2026-08-12: core becomes the source of truth

**Status:** ACCEPTED — ruled by Jack, 2026-08-12.
**Contract version:** `contracts/openapi/catalog.yaml` moves to 2.0.0.

The v1 surface frozen above was never implemented as written. `systems/core`
shipped a different API: `pageSize` rather than `limit`, camelCase rather than
snake_case, integer cents rather than float dollars, and no `category`, `sort`
or `published` parameters. The storefront's `catalogService.js` was written
faithfully to this document, which is exactly why it did not work against core.

**Resolution: core wins on shape; this contract wins on features.**

Core keeps camelCase, `pageSize`, and integer cents. Core gains the `category`
filter, the `sort` enum, `images` as `{url, alt}`, and the
`{code, message, fields?}` error envelope. `contracts/openapi/catalog.yaml` is
rewritten to describe core as built.

**Why not the reverse.** Core is running, tested and merged. This contract's
only consumer was a storefront replaced in the same change, so conforming core
to the document would have churned tested code to satisfy a specification with
no other reader.

**Integer cents is not revisitable.** This document typed price as
`number, format: float`. Floating-point dollars accumulate representation error
and the repository money convention forbids estimated figures. Every price in
this system is an integer count of cents.

### The sort enum widens from four values to six

`home_display` and `collection_display` are added for merchandised display
order. The four original values keep their exact semantics, so this is
additive.

### Merchandised display order

Two nullable integer columns, `homePosition` and `collectionPosition`, carry the
order in which products should be shown. The server returns products already
ordered; **the storefront never re-sorts what it receives**, because a client
that re-sorts disagrees with the server as soon as pagination is involved —
page 2 would be sorted independently of page 1.

There are two orderings because a product place on the home page is not its
place inside a collection. Both sort ascending, place unranked products **last**
(`NULLS LAST`), and break ties on `name` so pagination is stable.

Nullable rather than defaulted to `0`: a new product is unmerchandised, and a
`0` default would silently promote it to the top of the home page.

**Accepted limitation.** `categories` is an array, so a product in several
collections carries one `collectionPosition` and holds the same rank in each.
Per-collection ranking would need a `(productId, collectionSlug, position)`
join table. Not built — nothing needs it yet.

### Still carved out and still undecided

The image CDN (ADR-0002, DRAFT) and relevance search (ADR-0003, DRAFT), both
Jack spend decisions. `{url, alt}` remains forward-compatible with adding
`width`, `height` and `srcset` variants.
