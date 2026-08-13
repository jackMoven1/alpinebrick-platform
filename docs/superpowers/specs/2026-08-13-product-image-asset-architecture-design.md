# Product Image and Asset Architecture — Design

**Status:** DRAFT — awaiting Jack's review.
**Date:** 2026-08-13.
**Owners:** Catalog Engineer (core changes), Storefront Engineer (consumer),
Engineering Lead (approver).
**Settles:** three of the five open items in
[ADR-0002](../../adr/0002-image-cdn-asset-delivery.md). The provider choice and
the spend approval remain **open and Jack's alone**.

---

## 1. Why this exists

ADR-0002 deliberately deferred image delivery so v1 could ship without paying
for a CDN. The catalog shipped with `Product.images` as a JSON array of
`{url, alt}`, which was the right call at the time and is now the constraint.

Three incompatible image models exist in the repository today:

| Where | Model | State |
|---|---|---|
| `systems/core` | `Product.images` — JSON array of `{url, alt}`. No identity, no order column, unvalidated by Postgres | **Shipped** |
| `systems/admin-ui` | Image entities with `id`, `url`, `alt_text`; reorder, edit-alt, delete | React prototype on an **in-memory mock**, never wired to core |
| `systems/catalog-admin/docs/SPEC.md` | An `images` table with `id`, `product_id`, `url`, `alt_text`, `display_order` | **Unbuilt.** The service is a 400-byte health-check stub |

The admin prototype cannot be wired to core as things stand: it reorders and
edits images by **id**, and core's array entries have no identity. That gap is
the practical reason to act now, ahead of any CDN spend.

**`catalog-admin/docs/SPEC.md` is stale in a second way.** It is written against
`catalog-service:4001`, `inventory-service:4003` and raw `pg` — all pre-redesign
mocks — and states "No external services Phase 1: local file storage only; no
S3." Anyone picking up catalog admin work should treat that document as
superseded on storage, and this one as authoritative.

## 2. Scope

**In:** the image data model, the storage-key convention, URL resolution, the
ingestion contract, and the migration off the JSON column. AlpineBrick only.

**Out, each its own decision:** variant-level images, asset reuse across
products, video, non-product marketing assets, and the wider catalog-admin
rebuild (product CRUD, publish workflow, audit trail, version rollback).

**Deliberately not decided here:** the CDN provider and the monthly spend. The
architecture requires only three capabilities of a provider — object storage
with signed uploads, on-the-fly transforms addressed by URL, and edge caching —
and is otherwise provider-neutral.

---

## 3. The central decision: store a key, never a URL

Core stores whole paths today (`/img/placeholder/skyline-1.svg`). A URL welds
each row to one host, one directory layout and one environment.

**The database stores a storage key.** The host, the transform grammar and the
environment resolve *around* it at render time:

```
products/{productId}/{imageId}/original.{ext}
```

The key is derived from identifiers the database already owns, so it is
deterministic and collision-free without a separate naming scheme.

Consequences worth stating plainly:

- Changing CDN provider touches configuration and two resolver files. **No rows
  change.**
- Staging and production can serve the same rows from different hosts.
- A row's identity is independent of how many derivative sizes exist.

## 4. Keys are immutable

An image's bytes are **never replaced in place**. Replacing a photograph means
a new row, a new key, and deletion of the old one.

This buys a large and cheap property: because a given key's bytes can never
change, **derivative URLs can be cached at the edge indefinitely**. The
alternative — mutable keys plus cache-busting query parameters — is where stale
image bugs live, and they are miserable to diagnose because they reproduce only
for users whose edge node holds the old object.

The cost is that "replace this photo" is a delete-plus-create in the admin UI
rather than an update. That is the correct trade.

## 5. Data model

A real table, replacing the JSON column.

```prisma
model Image {
  id          String   @id @default(cuid())
  productId   String   @map("product_id")
  product     Product  @relation(fields: [productId], references: [id], onDelete: Cascade)

  storageKey  String   @unique @map("storage_key")
  alt         String   @default("")
  position    Int
  width       Int
  height      Int
  contentType String   @map("content_type")
  byteSize    Int      @map("byte_size")
  status      ImageStatus @default(pending)
  createdAt   DateTime @default(now()) @map("created_at")

  @@unique([productId, position])
  @@index([productId, position])
  @@map("images")
}

enum ImageStatus {
  pending
  ready
}
```

Field notes, because several are load-bearing:

- **`position`** replaces array order. **`position: 0` is the primary image** —
  what the product card renders and what the Walmart feed sends. "Which image
  is primary" becomes a query rather than a convention.

  **The uniqueness constraint must be `DEFERRABLE INITIALLY DEFERRED`, and
  Prisma cannot express that** — it is added by hand in the migration SQL:

  ```sql
  ALTER TABLE "images"
    ADD CONSTRAINT "images_product_id_position_key"
    UNIQUE ("product_id", "position") DEFERRABLE INITIALLY DEFERRED;
  ```

  Without this, reordering is impossible. Swapping images at positions 0 and 1
  means two `UPDATE`s, and Postgres checks a non-deferrable unique constraint
  after **each statement** — so the first update collides with the row that has
  not moved yet. Deferring the check to commit lets the pair swap atomically.
  The alternative, renumbering through a temporary negative offset, works but
  hides a real constraint behind a trick.
- **`width` / `height`** are stored so the storefront can emit `<img width
  height>` and reserve layout space before the bytes arrive. Without them every
  product card reflows as images load — a real Core Web Vitals cost on a
  commerce site, and not something the CDN can fix.
- **`alt` defaults to empty rather than being required.** Decorative images
  legitimately have empty alt text, and a NOT NULL constraint would only teach
  people to type a space. Empty alt instead becomes a **publish-time warning**
  in the admin, alongside the existing "no images" warning.
- **`status`** exists solely to make failed uploads safe — see §7.
- **`storageKey` is unique** so the same object can never be claimed by two
  rows, which would make deletion unsafe.

## 6. URL resolution

One function, with this signature:

```ts
imageUrl(storageKey: string, opts: { width: number; format?: 'auto' | 'webp' | 'jpeg' }): string
```

It reads the CDN base URL from configuration and composes the provider's
transform grammar.

**It is implemented twice, deliberately** — once in `core` (for the Walmart item
feed) and once in the storefront (for `srcset`) — each with tests pinning the
grammar against known inputs.

The alternative, having core return fully-resolved URLs, was rejected: it bakes
provider grammar into every API response, and therefore into anything that
caches those responses. The API returns `storageKey`. Changing provider is two
small files and one environment variable.

**Duplication is the point here, not an oversight.** It is two tested functions
against one shared, documented grammar.

## 7. Ingestion

Bytes never pass through core.

1. **Request.** Admin calls `POST /api/v1/admin/images/upload-token` with
   `productId`, `contentType` and `byteSize`. Core validates the product exists,
   the type is allowed and the size is under the ceiling; creates an `Image` row
   with `status: pending`; and returns a short-lived signed upload URL plus the
   storage key.
2. **Upload.** Admin `PUT`s the bytes directly to the provider.
3. **Confirm.** Admin calls `POST /api/v1/admin/images/{id}/confirm`. Core
   verifies the object exists, reads its true dimensions and byte size from the
   provider rather than trusting the client, writes them, and sets
   `status: ready`.

**Why `pending` matters:** an upload that fails between steps 2 and 3 would
otherwise leave a product pointing at bytes that do not exist. Pending rows are
never returned by the public catalog API and are swept after 24 hours.

Dimensions are read from the provider, not accepted from the caller, because a
client-supplied width that disagrees with the actual image reintroduces the
layout shift `width`/`height` exist to prevent.

## 8. Delivery, and two consumers with different needs

**Delivery is public, not signed.** This follows from the consumers:

- **Storefront** — `srcset` across several widths, `format: auto` so modern
  browsers get modern formats, lazy loading below the fold.
- **Walmart** — one stable, public, high-resolution URL for the `position: 0`
  image. A marketplace crawler cannot follow an expiring signed URL, so signed
  delivery would break the channel.

Note that `systems/core/src/channels/walmart/mappers.ts` **does not reference
images at all today**. The item feed will need the primary image URL when it is
completed; this design is what makes that a one-line lookup.

## 9. Contract impact

**This is a breaking change to the catalog API.** `images[].url` becomes
`images[].storageKey`, and `width`, `height` and `position` are added.

- `contracts/openapi/catalog.yaml` goes to **3.0.0**. Replacing a field is not
  additive, and ADR-0002's note that image changes would be additive applies
  only to *extending* `{url, alt}`, not to replacing `url`.
- **ADR-0001 gains a second amendment** recording the shape change.
- **ADR-0002 moves from DRAFT to partially ACCEPTED**: transforms, URL
  convention and ingestion are decided here; CDN host and spend stay open.

`url` is **not** retained alongside `storageKey` for compatibility. The only
consumer is our own storefront, and carrying both fields invites the wrong one
being used and quietly reintroduces the hard-coded host.

**ADR-0002 asked whether signed URLs would need an ADR-0001 amendment. They
would have — and we chose public delivery, so that particular concern does not
arise.**

## 10. Migration

A single migration:

1. Create `images` and the `ImageStatus` enum.
2. Backfill from `Product.images`: `position` = array index, `storageKey` = the
   existing path, `alt` = existing alt, `status` = `ready`, and
   **`width` = 900, `height` = 720**, which is the actual `viewBox` of every
   placeholder SVG in `public/img/placeholder/`. The values are real, not
   invented, so `width`/`height` stay non-nullable and the storefront can rely
   on them from day one.
3. Drop `Product.images`.

No dual-read period and no special case: the 12 placeholder SVGs migrate as
ordinary rows.

**This backfill is only correct while the catalogue is placeholders.** If real
photography lands before this migration runs, the constant is wrong and the
backfill needs a probe step to read each object's true dimensions. That is a
sequencing hazard, not a design one — see §13.

## 11. What this unblocks

The `admin-ui` catalog prototype currently reorders, re-alts and deletes images
by id against a mock. Those operations become implementable against core for the
first time. Wiring the prototype to core is **not** in this spec's scope, but
this is the change that makes it possible.

## 12. Testing

| Layer | What is verified |
|---|---|
| Schema | Cascade delete removes images with the product; two images cannot share a `position`; `storageKey` uniqueness holds |
| Reordering | Swapping two adjacent images inside one transaction **succeeds** — this fails outright if the unique constraint was created non-deferrable, which is the single easiest thing to get wrong in the migration |
| Migration | Backfill preserves order and alt text for every existing row |
| Ingestion | A token reserves a pending row; an unconfirmed row is not returned publicly; confirm writes provider-read dimensions, not client-supplied ones; the sweeper removes stale pending rows |
| Resolver | Both implementations produce identical URLs for the same key and options — a test that fails if the two copies drift |
| Catalog API | Products return `storageKey`, `width`, `height`, ordered by `position`; pending images are excluded |

The resolver drift test is the one that earns its keep: two copies of a function
is a deliberate trade, and this is what stops it becoming a silent bug.

## 13. Open questions

1. **CDN provider and monthly spend — Jack's, and the reason ADR-0002 exists.**
   The architecture needs only signed uploads, URL-addressed transforms and edge
   caching. Cost *shapes* differ across candidates (per image stored, per
   delivery, per transform, per GB egress) and should be checked against current
   published pricing at decision time rather than from memory.
2. **Sequencing against real photography.** The backfill hard-codes 900×720
   because that is genuinely every placeholder's size. If real photographs are
   loaded into `Product.images` **before** this migration runs, that constant
   becomes a lie and the backfill must instead probe each object for its true
   dimensions. Whoever runs the migration should check the catalogue first.
3. **Maximum upload size and accepted formats.** The old catalog-admin spec said
   5 MB and 20 images per product, JPG/PNG/WEBP. Those numbers predate the
   redesign and should be reconfirmed against what Walmart requires for its item
   feed, which is stricter on resolution than a storefront needs.
4. **Whether real product photography exists yet.** It does not, as of today.
   Nothing here is blocked by that — but the ingestion pipeline has no content to
   ingest, so building it before there are photographs would be speculative.
