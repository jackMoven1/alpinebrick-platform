# ADR-0001 — Catalog API Contract

**Status:** DRAFT — to be co-authored by the Catalog Engineer and Storefront Engineer; approved by the Engineering Lead before either side builds against it.
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
*To be filled in by the Catalog and Storefront engineers.*

## Consequences
*To be filled in once the decision is recorded.*

---

## ADR conventions for this repo
- ADRs live in `engineering/docs/adr/` numbered sequentially: `0001-`, `0002-`, ...
- Status values: `DRAFT`, `PROPOSED`, `ACCEPTED`, `SUPERSEDED`, `DEPRECATED`.
- Each ADR names primary owners (which engineer agents) and an approver.
- Superseding ADRs link back to what they replace.
