# AlpineBrick Core

Modular-monolith core (TypeScript + Express + Prisma/Postgres). Phase 1 substrate:
canonical schema (catalog + audit slice), seed, and the read-only catalog API at
`/api/v1/catalog`.

## Dev
1. `docker run -d --name alpinebrick-core-db -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:15`
2. `cp .env.example .env`
3. `npm install && npx prisma migrate dev && npm run seed`
4. `npm run dev` → http://localhost:4000/health

## Supersedes
`systems/catalog-service` (read-only Postgres API) is replaced by this module's
catalog API. Do not add features to `catalog-service`; it will be removed once the
storefront (Plan 5) points at `/api/v1/catalog` here.

## Image storage

Images are rows in the `images` table holding an **immutable storage key**,
never a URL: `products/{productId}/{imageId}/original.{ext}`. Keys are relative
and never start with a slash. Bytes are never replaced in place — replacing a
photo is a new row and a new key — which is what makes derivative URLs safe to
cache at the edge indefinitely.

Bytes are reached through `AssetStoragePort` (`src/ports/storage/`). The local
filesystem adapter is used until a CDN provider is chosen (ADR-0002); swapping
provider means writing one adapter and changing `imageUrl` plus two env vars.
**No database rows change.**

Uploads are two-phase:

1. `POST /api/v1/admin/images/upload-token` reserves a **pending** row and
   returns a short-lived upload target.
2. The client PUTs bytes directly to storage — they never pass through core.
3. `POST /api/v1/admin/images/:id/confirm` verifies the object exists and reads
   its **true dimensions from storage**, then marks the row `ready`.

Confirming without uploading returns **409 `object_missing`**. Pending rows are
never returned by the public catalog API, so a failed upload cannot surface a
broken product page.

`sweepPendingImages` removes abandoned pending rows, but **nothing calls it** —
core has no scheduler. It is a job waiting to be wired, not a finished feature.

**These admin endpoints have no authentication.** Neither does the rest of core,
but this is the first endpoint that causes arbitrary bytes to be written, so it
must not reach a public network before auth exists.

`imageUrl` in `src/assets/image-url.ts` is **deliberately duplicated** in the
storefront (`src/lib/images.ts`); the two packages cannot import each other.
A parity test in the storefront fails if the grammars drift.