# ADR-0002 — Image CDN / Asset Delivery

**Status:** PARTIALLY ACCEPTED (2026-08-13) — transforms, URL convention and
ingestion are **decided and built**. **CDN host and spend remain OPEN and are
Jack's.** See "Decided — 2026-08-13" at the end of this file; the text below is
the original 2026-06-03 carve-out, kept for context.
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

> **Superseded 2026-08-13.** The change was NOT additive: `url` was *replaced*
> by `storageKey`, which is breaking and did require a contract version bump
> (2.0.0 → 3.0.0) and an ADR-0001 amendment. Signed URLs were not chosen, so
> that half of the note never applied.

## Next step
Open for scoping when image volume or quality requirements justify the spend. Until then, v1 serves plain `{ url, alt }`. No work scheduled.

> **Superseded 2026-08-13.** This work was scoped and built without waiting on
> the spend decision — see "Decided" below. The API no longer serves
> `{ url, alt }`.

---

## Decided — 2026-08-13

Design: `docs/superpowers/specs/2026-08-13-product-image-asset-architecture-design.md`.
Plan: `docs/superpowers/plans/2026-08-13-product-image-asset-architecture.md`.

- **Transforms: on the fly at the edge.** One stored object per image; sizes are
  requested by URL parameter. Adding a new size later costs nothing and needs no
  backfill.
- **URL convention: the database stores an immutable storage key**,
  `products/{productId}/{imageId}/original.{ext}`, never a URL. Bytes are never
  replaced in place — replacing a photo is a new row and a new key — so
  derivative URLs are safe to cache at the edge indefinitely.
- **Delivery is public, not signed.** Walmart's crawler cannot follow an
  expiring URL, so signed delivery would break that channel. The question this
  ADR raised — whether signed URLs would need an ADR-0001 amendment — therefore
  does not arise.
- **Ingestion: direct upload against a short-lived target minted by core.**
  Bytes never pass through core. A row is `pending` until core has verified the
  object exists and read its **true dimensions from storage** rather than
  trusting the client. Pending rows are never returned publicly.

### What was built

`AssetStoragePort` (`systems/core/src/ports/storage/storage.port.ts`) with a
local filesystem adapter, mirroring the existing `TaxPort` pattern. The
`images` table replaces `Product.images`; admin endpoints live at
`/api/v1/admin/images`.

## Still open — Jack's

- **CDN / origin host** and **cost model & spend approval.**

The architecture requires only three things of a provider: object storage with
signed uploads, transforms addressed by URL, and edge caching. Because storage
is reached through `AssetStoragePort`, **choosing a provider means writing one
adapter and changing two resolver functions plus one environment variable** —
not changing the catalog, the schema, or any stored data.

Cost *shapes* differ across candidates (per image stored, per delivery, per
transform, per GB egress) and should be checked against current published
pricing at decision time rather than recalled.

## Known limitations, accepted

- **Images hang off `Product`, not `Variant`.** A specific SKU cannot carry its
  own imagery. Correct for LEGO sets, where a variant is typically a single SKU
  rather than a colourway; it would need a nullable `variantId` if that changes.
- **An asset cannot be shared between products.** Each `Image` row belongs to
  exactly one product. Reuse would need an `Asset` table plus a join, which is
  an extra hop on every read for a case nothing needs yet.
- **`sweepPendingImages` exists but nothing calls it.** Core has no scheduler,
  so abandoned uploads accumulate as invisible pending rows. Harmless at current
  volume — they are excluded from every public response — but it is a job
  waiting to be wired, not a finished feature.
