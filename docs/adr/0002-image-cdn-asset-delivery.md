# ADR-0002 — Image CDN / Asset Delivery

**Status:** DRAFT — deferred decision, not yet scheduled. Logged 2026-06-03 as a carve-out from [ADR-0001](0001-catalog-api-contract.md).
**Owners:** `catalog-engineer` (primary), `storefront-engineer` (consumer), `engineering-lead` (approver).
**Decision maker:** **Jack** — this locks the platform into paid infrastructure (per ADR-0001 Process step 6).

## Why this is deferred (not decided)
The v1 catalog contract (ADR-0001, ACCEPTED) deliberately did **not** pick an image-delivery mechanism. Product images are typed as `{ url, alt }` with `url` a plain absolute-or-relative URL, and that shape is **forward-compatible**: `width`, `height`, and `variants` can be added later without a breaking contract change. This let v1 ship without committing to (or paying for) a CDN.

## What still needs deciding
- **CDN / origin host:** where image bytes are served from (e.g. Cloudflare, CloudFront, Cloudinary, imgix, bunny.net, or self-hosted object storage + CDN).
- **Transforms / responsive variants:** do we generate sizes (thumb / card / detail / zoom) for `srcset`, on-the-fly or pre-baked? The storefront flagged it wants `srcset` eventually.
- **URL convention:** direct URLs vs. signed URLs; how `variants` would be represented in the `Image` schema.
- **Upload / ingestion path:** how the catalog-admin authoring flow gets images into the store.
- **Cost model & spend approval:** monthly ceiling, who owns the account — **Jack's call.**

## Impact on the contract when decided
Extending `Image` with `width`/`height`/`variants` is additive and does not require an ADR-0001 version bump. Choosing signed URLs *would* affect caching/consumption and should be noted as an ADR-0001 amendment.

## Next step
Open for scoping when image volume or quality requirements justify the spend. Until then, v1 serves plain `{ url, alt }`. No work scheduled.
