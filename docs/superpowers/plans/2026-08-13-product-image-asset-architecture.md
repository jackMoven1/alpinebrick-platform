# Product Image and Asset Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `Product.images` (a JSON array with no identity) with a real `Image` table holding an immutable storage key, and add a direct-upload ingestion path that works today against local storage and swaps to a CDN when one is chosen.

**Architecture:** The database stores a storage key, never a URL; hosts and transform grammar resolve around it at render time. Storage is reached through an `AssetStoragePort` with a local filesystem adapter, mirroring core's existing `TaxPort` pattern, so no CDN decision is needed to build. The schema change follows expand → migrate → contract: the table lands additively, consumers switch over, and only then is the old column dropped.

**Tech Stack:** TypeScript, Express, Prisma, PostgreSQL, Vitest (core). React 18, Vite, Vitest, Testing Library (storefront).

**Spec:** `docs/superpowers/specs/2026-08-13-product-image-asset-architecture-design.md`

## Global Constraints

- **The database stores a `storageKey`, never a URL.** Key format is exactly `products/{productId}/{imageId}/original.{ext}`.
- **Keys are immutable.** Bytes are never replaced in place. Replacing a photo is a new row plus a new key plus deletion of the old one.
- **Delivery is public, not signed.** Walmart's crawler cannot follow an expiring URL.
- **`position: 0` is the primary image.** It is what the product card renders and what the Walmart feed will send.
- **The position uniqueness constraint MUST be `DEFERRABLE INITIALLY DEFERRED`.** Prisma cannot express this; it is added by hand in migration SQL. Without it, reordering is impossible.
- **Dimensions are read from storage, never accepted from the client.** A client-supplied width that disagrees with the real image reintroduces the layout shift `width`/`height` exist to prevent.
- **Pending images are never returned by the public catalog API.**
- **Money is untouched by this work.** Any price remains an integer count of cents.
- **Core's tests do not run from the repo root** — `systems/core` is not in the npm workspaces and `npm test --workspaces` silently skips it. Always `cd systems/core && npm test`.
- **A green suite does not mean the app compiles.** Vitest never typechecks. Run `npm run build` separately.
- **Core listens on port 4000**, not 3000.
- Branch off `main`: `git checkout -b <type>/<slug> main`. Never commit onto a branch you did not create.
- Every commit gets a `Co-Authored-By:` trailer naming the agent, and a subject naming the system touched.
- **Do not `git push`** — Jack approves pushes.

---

## Task 1: The `Image` table

**Files:**
- Modify: `systems/core/prisma/schema.prisma`
- Create: `systems/core/prisma/migrations/<timestamp>_add_images_table/migration.sql` (generated, then hand-edited)
- Test: `systems/core/tests/images-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ImageStatus` enum (`pending` | `ready`); `Image` model with `id`, `productId`, `storageKey`, `alt`, `position`, `width`, `height`, `contentType`, `byteSize`, `status`, `createdAt`; `Product.images` **retained** as `imagesJson` for now.

**This task is additive on purpose.** `Product.images` is renamed rather than dropped so every task between here and Task 6 leaves a working build.

- [ ] **Step 1: Write the failing test**

Create `systems/core/tests/images-schema.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'

async function makeProduct(slug: string) {
  return prisma.product.create({
    data: { slug, name: slug, productType: 'resale', status: 'published' },
  })
}

describe('Image table', () => {
  beforeAll(async () => { await resetDb() })
  afterAll(async () => { await prisma.$disconnect() })

  it('persists an image with a storage key and dimensions', async () => {
    const p = await makeProduct('img-fixture-1')
    const img = await prisma.image.create({
      data: {
        productId: p.id,
        storageKey: `products/${p.id}/abc/original.jpg`,
        alt: 'Front view',
        position: 0,
        width: 900,
        height: 720,
        contentType: 'image/jpeg',
        byteSize: 12345,
        status: 'ready',
      },
    })
    expect(img.storageKey).toBe(`products/${p.id}/abc/original.jpg`)
    expect(img.width).toBe(900)
    expect(img.status).toBe('ready')
  })

  it('defaults alt to empty and status to pending', async () => {
    const p = await makeProduct('img-fixture-2')
    const img = await prisma.image.create({
      data: {
        productId: p.id, storageKey: `products/${p.id}/d/original.jpg`,
        position: 0, width: 10, height: 10, contentType: 'image/jpeg', byteSize: 1,
      },
    })
    expect(img.alt).toBe('')
    expect(img.status).toBe('pending')
  })

  it('rejects two images sharing a storage key', async () => {
    const p = await makeProduct('img-fixture-3')
    const key = `products/${p.id}/dup/original.jpg`
    const base = { productId: p.id, width: 1, height: 1, contentType: 'image/jpeg', byteSize: 1 }
    await prisma.image.create({ data: { ...base, storageKey: key, position: 0 } })
    await expect(
      prisma.image.create({ data: { ...base, storageKey: key, position: 1 } }),
    ).rejects.toThrow()
  })

  it('rejects two images claiming the same position on one product', async () => {
    const p = await makeProduct('img-fixture-4')
    const base = { productId: p.id, width: 1, height: 1, contentType: 'image/jpeg', byteSize: 1 }
    await prisma.image.create({ data: { ...base, storageKey: `products/${p.id}/a/original.jpg`, position: 0 } })
    await expect(
      prisma.image.create({ data: { ...base, storageKey: `products/${p.id}/b/original.jpg`, position: 0 } }),
    ).rejects.toThrow()
  })

  // The single easiest thing to get wrong in the migration. A non-deferrable
  // unique constraint is checked after EACH statement, so the first UPDATE
  // collides with the row that has not moved yet and reordering is impossible.
  it('allows two images to swap positions inside one transaction', async () => {
    const p = await makeProduct('img-fixture-5')
    const base = { productId: p.id, width: 1, height: 1, contentType: 'image/jpeg', byteSize: 1 }
    const a = await prisma.image.create({ data: { ...base, storageKey: `products/${p.id}/s1/original.jpg`, position: 0 } })
    const b = await prisma.image.create({ data: { ...base, storageKey: `products/${p.id}/s2/original.jpg`, position: 1 } })

    await prisma.$transaction([
      prisma.image.update({ where: { id: a.id }, data: { position: 1 } }),
      prisma.image.update({ where: { id: b.id }, data: { position: 0 } }),
    ])

    expect((await prisma.image.findUniqueOrThrow({ where: { id: a.id } })).position).toBe(1)
    expect((await prisma.image.findUniqueOrThrow({ where: { id: b.id } })).position).toBe(0)
  })

  it('cascade-deletes images when the product is deleted', async () => {
    const p = await makeProduct('img-fixture-6')
    await prisma.image.create({
      data: {
        productId: p.id, storageKey: `products/${p.id}/c/original.jpg`,
        position: 0, width: 1, height: 1, contentType: 'image/jpeg', byteSize: 1,
      },
    })
    await prisma.product.delete({ where: { id: p.id } })
    expect(await prisma.image.count({ where: { productId: p.id } })).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/core && npx vitest run tests/images-schema.test.ts`
Expected: FAIL — `prisma.image` is undefined.

- [ ] **Step 3: Add the model to the schema**

In `systems/core/prisma/schema.prisma`, add the enum beside the others:

```prisma
enum ImageStatus {
  pending
  ready
}
```

Add the model:

```prisma
model Image {
  id          String      @id @default(cuid())
  productId   String      @map("product_id")
  product     Product     @relation(fields: [productId], references: [id], onDelete: Cascade)

  // Immutable. Bytes are never replaced in place — replacing a photo means a
  // new row and a new key, which is what makes derivative URLs safe to cache
  // at the edge indefinitely.
  storageKey  String      @unique @map("storage_key")
  alt         String      @default("")
  position    Int
  width       Int
  height      Int
  contentType String      @map("content_type")
  byteSize    Int         @map("byte_size")
  status      ImageStatus @default(pending)
  createdAt   DateTime    @default(now()) @map("created_at")

  @@unique([productId, position], map: "images_product_id_position_key")
  @@index([productId, position])
  @@map("images")
}
```

In `model Product`, rename the JSON column and add the relation. **Do not delete the JSON column yet** — Task 6 does that, once nothing reads it:

```prisma
  // Superseded by the Image relation. Retained through the migration so each
  // task leaves a working build; dropped in the "contract" step.
  imagesJson  Json        @default("[]") @map("images")
  images      Image[]
```

- [ ] **Step 4: Generate the migration**

Run: `cd systems/core && npx prisma migrate dev --name add_images_table --create-only`

`--create-only` matters: the SQL must be hand-edited before it runs.

- [ ] **Step 5: Make the position constraint deferrable**

Open the generated `migration.sql`. Find the line creating the composite unique index, which will look like:

```sql
CREATE UNIQUE INDEX "images_product_id_position_key" ON "images"("product_id", "position");
```

**Replace it** with a deferrable constraint:

```sql
ALTER TABLE "images"
  ADD CONSTRAINT "images_product_id_position_key"
  UNIQUE ("product_id", "position") DEFERRABLE INITIALLY DEFERRED;
```

Leave the `storage_key` unique index and the `(product_id, position)` non-unique index alone.

- [ ] **Step 6: Add the backfill to the same migration**

Existing rows carry images in the JSON column. Without this, Task 6 drops that
column and the data is gone. Append to the end of `migration.sql`:

```sql
-- Backfill existing JSON images into rows. WITH ORDINALITY gives the array
-- index, which becomes position, so display order is preserved exactly.
--
-- width/height are 900x720 because that is the real viewBox of every
-- placeholder SVG currently in the catalogue. THIS IS ONLY TRUE WHILE THE
-- CATALOGUE IS PLACEHOLDERS -- if real photography was loaded before this
-- migration runs, these constants are wrong and each object must be probed
-- for its true dimensions instead.
INSERT INTO "images" (
  "id", "product_id", "storage_key", "alt", "position",
  "width", "height", "content_type", "byte_size", "status", "created_at"
)
SELECT
  gen_random_uuid()::text,
  p."id",
  img.value ->> 'url',
  COALESCE(img.value ->> 'alt', ''),
  (img.ordinality - 1)::int,
  900,
  720,
  'image/svg+xml',
  0,
  'ready'::"ImageStatus",
  NOW()
FROM "products" p
CROSS JOIN LATERAL jsonb_array_elements(p."images"::jsonb) WITH ORDINALITY AS img(value, ordinality)
WHERE jsonb_typeof(p."images"::jsonb) = 'array'
  AND img.value ->> 'url' IS NOT NULL;
```

- [ ] **Step 7: Apply the migration**

Run: `cd systems/core && npx prisma migrate dev`
Expected: applies cleanly, Prisma Client regenerates.

- [ ] **Step 8: Verify the backfill preserved order and alt text**

Run against the dev database, which was seeded before this migration:

```bash
cd systems/core && npx prisma studio
```

Or check directly:

```bash
docker exec alpinebrick-core-db psql -U postgres -d alpinebrick_core -c \
  "SELECT p.slug, i.position, i.alt, i.storage_key FROM images i JOIN products p ON p.id = i.product_id ORDER BY p.slug, i.position LIMIT 10;"
```

Expected: every previously-seeded image appears, `position` starts at 0 per
product with no gaps, and alt text is intact. **If the table is empty, the
`WITH ORDINALITY` join silently matched nothing** — check that
`products.images` really holds a JSON array before moving on.

- [ ] **Step 9: Run tests to verify they pass**

Run: `cd systems/core && npx vitest run tests/images-schema.test.ts`
Expected: PASS, 6 tests. If the swap test fails with a unique-constraint violation, Step 5 was not applied — fix the migration rather than the test.

- [ ] **Step 10: Update the test helper**

`tests/helpers/db.ts` deletes rows in dependency order. Add images before variants:

```ts
  await prisma.image.deleteMany()
```

Place it immediately before `await prisma.variant.deleteMany()`.

- [ ] **Step 11: Run the full core suite**

Run: `cd systems/core && npm test`
Expected: all previously passing tests still pass. `Product.imagesJson` is renamed, so any test or source referencing `product.images` as JSON must be updated to `imagesJson` — expect `catalog.service.ts`, `catalog-dto.test.ts` and `seed.ts` to need it.

- [ ] **Step 12: Commit**

```bash
git add systems/core/prisma systems/core/tests systems/core/src
git commit -m "feat(core): add the Image table with a deferrable position constraint

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Storage port and local adapter

**Files:**
- Create: `systems/core/src/ports/storage/storage.port.ts`
- Create: `systems/core/src/ports/storage/local.adapter.ts`
- Test: `systems/core/tests/storage-local-adapter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  interface StoredObject { width: number; height: number; byteSize: number; contentType: string }
  interface UploadTarget { uploadUrl: string; expiresAt: Date }
  interface AssetStoragePort {
    createUploadTarget(key: string, contentType: string): Promise<UploadTarget>
    stat(key: string): Promise<StoredObject | null>
    delete(key: string): Promise<void>
  }
  createLocalStoragePort(rootDir: string, publicBaseUrl: string): AssetStoragePort
  ```

**Why a port.** The CDN provider is undecided and is a spend commitment. This mirrors `src/ports/tax/tax.port.ts` + `flat-rate.adapter.ts`, which core already uses for exactly this reason. A CDN adapter implementing the same three methods drops in later with no change above it.

- [ ] **Step 1: Install the dimension reader**

Run: `cd systems/core && npm install image-size`

`image-size` is pure JS with no native dependencies and reads JPEG, PNG, WEBP and SVG headers. `sharp` would also work but pulls a large native binary for a job that is header parsing.

- [ ] **Step 2: Write the failing test**

Create `systems/core/tests/storage-local-adapter.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createLocalStoragePort } from '../src/ports/storage/local.adapter.js'

// A 1x1 red PNG, base64. Small enough to inline, real enough for a header read.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let root: string

beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'abx-assets-')) })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

describe('local storage adapter', () => {
  it('creates an upload target that expires in the future', async () => {
    const port = createLocalStoragePort(root, 'http://localhost:4000/assets')
    const target = await port.createUploadTarget('products/p1/i1/original.png', 'image/png')
    expect(target.uploadUrl).toContain('products/p1/i1/original.png')
    expect(target.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('stats a stored object and reads its REAL dimensions', async () => {
    const port = createLocalStoragePort(root, 'http://localhost:4000/assets')
    const key = 'products/p2/i2/original.png'
    const path = join(root, key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, PNG_1X1)

    const stat = await port.stat(key)
    expect(stat).not.toBeNull()
    expect(stat!.width).toBe(1)
    expect(stat!.height).toBe(1)
    expect(stat!.contentType).toBe('image/png')
    expect(stat!.byteSize).toBe(PNG_1X1.byteLength)
  })

  // Confirm must be able to tell "uploaded" from "never arrived".
  it('returns null for a key that was never uploaded', async () => {
    const port = createLocalStoragePort(root, 'http://localhost:4000/assets')
    expect(await port.stat('products/p3/nope/original.png')).toBeNull()
  })

  it('deletes an object', async () => {
    const port = createLocalStoragePort(root, 'http://localhost:4000/assets')
    const key = 'products/p4/i4/original.png'
    const path = join(root, key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, PNG_1X1)
    await port.delete(key)
    expect(await port.stat(key)).toBeNull()
  })

  // Keys come from the database, but a traversal would still be catastrophic.
  it('refuses a key that escapes the storage root', async () => {
    const port = createLocalStoragePort(root, 'http://localhost:4000/assets')
    await expect(port.stat('../../etc/passwd')).rejects.toThrow(/invalid key/i)
  })

  it('deleting a key that does not exist is not an error', async () => {
    const port = createLocalStoragePort(root, 'http://localhost:4000/assets')
    await expect(port.delete('products/p5/gone/original.png')).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd systems/core && npx vitest run tests/storage-local-adapter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the port**

Create `systems/core/src/ports/storage/storage.port.ts`:

```ts
export interface StoredObject {
  width: number
  height: number
  byteSize: number
  contentType: string
}

export interface UploadTarget {
  uploadUrl: string
  expiresAt: Date
}

/**
 * Where image bytes live. Implemented today by the local filesystem adapter;
 * a CDN adapter implements the same three methods when a provider is chosen.
 * Nothing above this interface knows which is in use.
 */
export interface AssetStoragePort {
  /** A short-lived destination the client PUTs bytes to directly. */
  createUploadTarget(key: string, contentType: string): Promise<UploadTarget>
  /** Real metadata read from the stored object, or null if it is not there. */
  stat(key: string): Promise<StoredObject | null>
  /** Removes the object. Absent objects are not an error. */
  delete(key: string): Promise<void>
}
```

- [ ] **Step 5: Write the local adapter**

Create `systems/core/src/ports/storage/local.adapter.ts`:

```ts
import { readFile, stat as fsStat, unlink } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import imageSize from 'image-size'
import type { AssetStoragePort, StoredObject, UploadTarget } from './storage.port.js'

const UPLOAD_WINDOW_MS = 15 * 60 * 1000

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', svg: 'image/svg+xml',
}

export function createLocalStoragePort(
  rootDir: string,
  publicBaseUrl: string,
): AssetStoragePort {
  // Keys originate in the database, but a traversal here would write outside
  // the storage root, so resolve and check rather than trusting the caller.
  function pathFor(key: string): string {
    const full = resolve(rootDir, key)
    const rootResolved = resolve(rootDir)
    if (full !== rootResolved && !full.startsWith(rootResolved + sep)) {
      throw new Error(`invalid key: ${key}`)
    }
    return full
  }

  return {
    async createUploadTarget(key: string): Promise<UploadTarget> {
      pathFor(key)
      return {
        uploadUrl: `${publicBaseUrl}/${key}`,
        expiresAt: new Date(Date.now() + UPLOAD_WINDOW_MS),
      }
    },

    async stat(key: string): Promise<StoredObject | null> {
      const path = pathFor(key)
      let byteSize: number
      try {
        byteSize = (await fsStat(path)).size
      } catch {
        return null
      }
      const buf = await readFile(path)
      const dims = imageSize(buf)
      const ext = key.split('.').pop()?.toLowerCase() ?? ''
      return {
        width: dims.width ?? 0,
        height: dims.height ?? 0,
        byteSize,
        contentType: CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream',
      }
    },

    async delete(key: string): Promise<void> {
      try {
        await unlink(pathFor(key))
      } catch (err: any) {
        // Absent is the desired end state, so treat it as success. Anything
        // else (permissions, traversal) must still surface.
        if (err?.code !== 'ENOENT') throw err
      }
    },
  }
}
```

Note `join` is imported for symmetry with future adapters but unused here; remove it if `noUnusedLocals` complains.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd systems/core && npx vitest run tests/storage-local-adapter.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add systems/core/src/ports/storage systems/core/tests/storage-local-adapter.test.ts systems/core/package.json systems/core/package-lock.json
git commit -m "feat(core): AssetStoragePort with a local filesystem adapter

Mirrors the existing TaxPort pattern so the CDN provider decision, which is
a spend commitment, does not block building the ingestion path.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Image service

**Files:**
- Create: `systems/core/src/assets/image.service.ts`
- Test: `systems/core/tests/image-service.test.ts`

**Interfaces:**
- Consumes: Task 1's `Image` model; Task 2's `AssetStoragePort`.
- Produces:
  ```ts
  class ImageError extends Error { code: string }
  buildStorageKey(productId: string, imageId: string, contentType: string): string
  requestUpload(port, input: { productId: string; contentType: string; byteSize: number }):
    Promise<{ imageId: string; storageKey: string; uploadUrl: string; expiresAt: Date }>
  confirmUpload(port, imageId: string): Promise<ImageDto>
  reorderImages(productId: string, orderedIds: string[]): Promise<void>
  deleteImage(port, imageId: string): Promise<void>
  sweepPendingImages(port, olderThan: Date): Promise<number>
  listReadyImages(productId: string): Promise<ImageDto[]>
  ```
  where `ImageDto = { id, storageKey, alt, position, width, height }`.

- [ ] **Step 1: Write the failing test**

Create `systems/core/tests/image-service.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import type { AssetStoragePort, StoredObject } from '../src/ports/storage/storage.port.js'
import {
  buildStorageKey, requestUpload, confirmUpload, reorderImages,
  deleteImage, sweepPendingImages, listReadyImages, ImageError,
} from '../src/assets/image.service.js'

function fakePort(objects: Record<string, StoredObject> = {}): AssetStoragePort {
  return {
    createUploadTarget: vi.fn(async (key: string) => ({
      uploadUrl: `https://upload.test/${key}`,
      expiresAt: new Date(Date.now() + 60_000),
    })),
    stat: vi.fn(async (key: string) => objects[key] ?? null),
    delete: vi.fn(async () => {}),
  }
}

const OBJ: StoredObject = { width: 1600, height: 1200, byteSize: 5000, contentType: 'image/jpeg' }

async function makeProduct(slug = 'svc-product') {
  return prisma.product.create({
    data: { slug, name: slug, productType: 'resale', status: 'published' },
  })
}

beforeEach(async () => { await resetDb() })
afterAll(async () => { await prisma.$disconnect() })

describe('buildStorageKey', () => {
  it('uses the documented format and maps the content type to an extension', () => {
    expect(buildStorageKey('p1', 'i1', 'image/jpeg')).toBe('products/p1/i1/original.jpg')
    expect(buildStorageKey('p1', 'i1', 'image/png')).toBe('products/p1/i1/original.png')
    expect(buildStorageKey('p1', 'i1', 'image/webp')).toBe('products/p1/i1/original.webp')
  })

  it('rejects a content type that is not an accepted image format', () => {
    expect(() => buildStorageKey('p1', 'i1', 'application/pdf')).toThrow(ImageError)
  })
})

describe('requestUpload', () => {
  it('reserves a pending row and returns an upload target', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const r = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 5000 })

    expect(r.storageKey).toBe(`products/${p.id}/${r.imageId}/original.jpg`)
    expect(r.uploadUrl).toContain(r.storageKey)

    const row = await prisma.image.findUniqueOrThrow({ where: { id: r.imageId } })
    expect(row.status).toBe('pending')
  })

  it('appends at the end of the existing positions', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const a = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 })
    const b = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 })
    const rowA = await prisma.image.findUniqueOrThrow({ where: { id: a.imageId } })
    const rowB = await prisma.image.findUniqueOrThrow({ where: { id: b.imageId } })
    expect(rowA.position).toBe(0)
    expect(rowB.position).toBe(1)
  })

  it('rejects an unknown product', async () => {
    await expect(
      requestUpload(fakePort(), { productId: 'nope', contentType: 'image/jpeg', byteSize: 1 }),
    ).rejects.toThrow(ImageError)
  })

  it('rejects a file over the size ceiling', async () => {
    const p = await makeProduct()
    await expect(
      requestUpload(fakePort(), { productId: p.id, contentType: 'image/jpeg', byteSize: 50_000_000 }),
    ).rejects.toThrow(ImageError)
  })
})

describe('confirmUpload', () => {
  it('reads dimensions FROM STORAGE and marks the row ready', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const r = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 5000 })
    const withObject = fakePort({ [r.storageKey]: OBJ })

    const dto = await confirmUpload(withObject, r.imageId)
    expect(dto.width).toBe(1600)
    expect(dto.height).toBe(1200)

    const row = await prisma.image.findUniqueOrThrow({ where: { id: r.imageId } })
    expect(row.status).toBe('ready')
    expect(row.byteSize).toBe(5000)
  })

  // The whole reason `pending` exists.
  it('refuses to confirm when the bytes never arrived', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const r = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 5000 })
    await expect(confirmUpload(port, r.imageId)).rejects.toThrow(ImageError)
    const row = await prisma.image.findUniqueOrThrow({ where: { id: r.imageId } })
    expect(row.status).toBe('pending')
  })
})

describe('listReadyImages', () => {
  it('returns ready images in position order and excludes pending ones', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const a = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 })
    const b = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 })
    await confirmUpload(fakePort({ [a.storageKey]: OBJ }), a.imageId)
    await confirmUpload(fakePort({ [b.storageKey]: OBJ }), b.imageId)
    await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 }) // left pending

    const list = await listReadyImages(p.id)
    expect(list.map(i => i.id)).toEqual([a.imageId, b.imageId])
  })
})

describe('reorderImages', () => {
  it('swaps two images', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const a = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 })
    const b = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 })
    await confirmUpload(fakePort({ [a.storageKey]: OBJ }), a.imageId)
    await confirmUpload(fakePort({ [b.storageKey]: OBJ }), b.imageId)

    await reorderImages(p.id, [b.imageId, a.imageId])

    const list = await listReadyImages(p.id)
    expect(list.map(i => i.id)).toEqual([b.imageId, a.imageId])
  })

  it('rejects an ordering that omits an image', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const a = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 })
    await confirmUpload(fakePort({ [a.storageKey]: OBJ }), a.imageId)
    await expect(reorderImages(p.id, [])).rejects.toThrow(ImageError)
  })
})

describe('deleteImage', () => {
  it('removes the row, deletes the object, and closes the position gap', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const a = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 })
    const b = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 })
    await confirmUpload(fakePort({ [a.storageKey]: OBJ }), a.imageId)
    await confirmUpload(fakePort({ [b.storageKey]: OBJ }), b.imageId)

    const delPort = fakePort()
    await deleteImage(delPort, a.imageId)

    expect(delPort.delete).toHaveBeenCalledWith(a.storageKey)
    const list = await listReadyImages(p.id)
    expect(list.map(i => i.id)).toEqual([b.imageId])
    expect(list[0]!.position).toBe(0)
  })
})

describe('sweepPendingImages', () => {
  it('removes stale pending rows and leaves ready ones alone', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const stale = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 })
    const good = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 })
    await confirmUpload(fakePort({ [good.storageKey]: OBJ }), good.imageId)

    // Age the pending row behind the service's back.
    await prisma.image.update({
      where: { id: stale.imageId },
      data: { createdAt: new Date(Date.now() - 48 * 3600 * 1000) },
    })

    const removed = await sweepPendingImages(fakePort(), new Date(Date.now() - 24 * 3600 * 1000))
    expect(removed).toBe(1)
    expect(await prisma.image.findUnique({ where: { id: stale.imageId } })).toBeNull()
    expect(await prisma.image.findUnique({ where: { id: good.imageId } })).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/core && npx vitest run tests/image-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `systems/core/src/assets/image.service.ts`:

```ts
import { prisma } from '../prisma.js'
import type { AssetStoragePort } from '../ports/storage/storage.port.js'

export class ImageError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'ImageError'
  }
}

export interface ImageDto {
  id: string
  storageKey: string
  alt: string
  position: number
  width: number
  height: number
}

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024

/** products/{productId}/{imageId}/original.{ext} — the documented key format. */
export function buildStorageKey(productId: string, imageId: string, contentType: string): string {
  const ext = EXT_BY_CONTENT_TYPE[contentType]
  if (!ext) {
    throw new ImageError('unsupported_content_type', `unsupported content type: ${contentType}`)
  }
  return `products/${productId}/${imageId}/original.${ext}`
}

function toDto(row: {
  id: string; storageKey: string; alt: string; position: number; width: number; height: number
}): ImageDto {
  return {
    id: row.id, storageKey: row.storageKey, alt: row.alt,
    position: row.position, width: row.width, height: row.height,
  }
}

export async function requestUpload(
  port: AssetStoragePort,
  input: { productId: string; contentType: string; byteSize: number },
): Promise<{ imageId: string; storageKey: string; uploadUrl: string; expiresAt: Date }> {
  if (!Number.isInteger(input.byteSize) || input.byteSize < 1) {
    throw new ImageError('invalid_byte_size', 'byteSize must be a positive integer')
  }
  if (input.byteSize > MAX_UPLOAD_BYTES) {
    throw new ImageError('file_too_large', `file exceeds ${MAX_UPLOAD_BYTES} bytes`)
  }

  const product = await prisma.product.findUnique({ where: { id: input.productId } })
  if (!product) throw new ImageError('product_not_found', 'product not found')

  // Validates the content type before any row is written.
  const ext = EXT_BY_CONTENT_TYPE[input.contentType]
  if (!ext) {
    throw new ImageError('unsupported_content_type', `unsupported content type: ${input.contentType}`)
  }

  const last = await prisma.image.findFirst({
    where: { productId: input.productId },
    orderBy: { position: 'desc' },
  })
  const position = last ? last.position + 1 : 0

  // The key embeds the row id, so the row must exist first. A placeholder key
  // keyed on position would collide after a delete; using the id cannot.
  const created = await prisma.image.create({
    data: {
      productId: input.productId,
      storageKey: `pending:${input.productId}:${position}:${Date.now()}`,
      position,
      width: 0,
      height: 0,
      contentType: input.contentType,
      byteSize: input.byteSize,
      status: 'pending',
    },
  })

  const storageKey = buildStorageKey(input.productId, created.id, input.contentType)
  await prisma.image.update({ where: { id: created.id }, data: { storageKey } })

  const target = await port.createUploadTarget(storageKey, input.contentType)
  return {
    imageId: created.id,
    storageKey,
    uploadUrl: target.uploadUrl,
    expiresAt: target.expiresAt,
  }
}

export async function confirmUpload(port: AssetStoragePort, imageId: string): Promise<ImageDto> {
  const row = await prisma.image.findUnique({ where: { id: imageId } })
  if (!row) throw new ImageError('image_not_found', 'image not found')

  // Read the truth from storage. A client-supplied width that disagrees with
  // the real image reintroduces the layout shift width/height exist to prevent.
  const stat = await port.stat(row.storageKey)
  if (!stat) throw new ImageError('object_missing', 'no object was uploaded for this image')

  const updated = await prisma.image.update({
    where: { id: imageId },
    data: {
      width: stat.width,
      height: stat.height,
      byteSize: stat.byteSize,
      status: 'ready',
    },
  })
  return toDto(updated)
}

export async function listReadyImages(productId: string): Promise<ImageDto[]> {
  const rows = await prisma.image.findMany({
    where: { productId, status: 'ready' },
    orderBy: { position: 'asc' },
  })
  return rows.map(toDto)
}

export async function reorderImages(productId: string, orderedIds: string[]): Promise<void> {
  const rows = await prisma.image.findMany({ where: { productId } })
  const known = new Set(rows.map(r => r.id))
  if (orderedIds.length !== rows.length || orderedIds.some(id => !known.has(id))) {
    throw new ImageError('invalid_order', 'ordering must list every image of the product exactly once')
  }
  // One transaction: the position constraint is DEFERRABLE INITIALLY DEFERRED,
  // so intermediate collisions are legal and only the committed state is checked.
  await prisma.$transaction(
    orderedIds.map((id, position) => prisma.image.update({ where: { id }, data: { position } })),
  )
}

export async function deleteImage(port: AssetStoragePort, imageId: string): Promise<void> {
  const row = await prisma.image.findUnique({ where: { id: imageId } })
  if (!row) throw new ImageError('image_not_found', 'image not found')

  const remaining = await prisma.image.findMany({
    where: { productId: row.productId, id: { not: imageId } },
    orderBy: { position: 'asc' },
  })

  await prisma.$transaction([
    prisma.image.delete({ where: { id: imageId } }),
    ...remaining.map((r, position) => prisma.image.update({ where: { id: r.id }, data: { position } })),
  ])

  // Storage last: an orphaned object is recoverable, a row pointing at bytes
  // that no longer exist is a broken product page.
  await port.delete(row.storageKey)
}

export async function sweepPendingImages(port: AssetStoragePort, olderThan: Date): Promise<number> {
  const stale = await prisma.image.findMany({
    where: { status: 'pending', createdAt: { lt: olderThan } },
  })
  for (const row of stale) {
    await prisma.image.delete({ where: { id: row.id } })
    await port.delete(row.storageKey)
  }
  return stale.length
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd systems/core && npx vitest run tests/image-service.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add systems/core/src/assets systems/core/tests/image-service.test.ts
git commit -m "feat(core): image service with pending-then-confirm ingestion

Dimensions are read from storage rather than accepted from the client, and a
pending row is never publicly visible, so an upload that dies mid-flight
cannot leave a product pointing at bytes that do not exist.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Admin routes

**Files:**
- Create: `systems/core/src/assets/assets.routes.ts`
- Modify: `systems/core/src/app.ts`
- Test: `systems/core/tests/assets-routes.test.ts`

**Interfaces:**
- Consumes: Task 3's service; Task 2's `createLocalStoragePort`.
- Produces: `createAssetsRouter(port: AssetStoragePort): Router` mounted at `/api/v1/admin/images`, with the error envelope `{ code, message }` matching the catalog routes.

**Note on auth.** There is none yet, matching the rest of core. These endpoints must not be exposed publicly before auth exists — recorded in the plan's closing section rather than silently assumed.

- [ ] **Step 1: Write the failing test**

Create `systems/core/tests/assets-routes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createAssetsRouter } from '../src/assets/assets.routes.js'
import type { AssetStoragePort, StoredObject } from '../src/ports/storage/storage.port.js'

const OBJ: StoredObject = { width: 1600, height: 1200, byteSize: 5000, contentType: 'image/jpeg' }
const uploaded: Record<string, StoredObject> = {}

const port: AssetStoragePort = {
  createUploadTarget: vi.fn(async (key: string) => ({
    uploadUrl: `https://upload.test/${key}`,
    expiresAt: new Date(Date.now() + 60_000),
  })),
  stat: vi.fn(async (key: string) => uploaded[key] ?? null),
  delete: vi.fn(async () => {}),
}

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/admin/images', createAssetsRouter(port))
  return app
}

const app = buildApp()

beforeEach(async () => {
  await resetDb()
  for (const k of Object.keys(uploaded)) delete uploaded[k]
})
afterAll(async () => { await prisma.$disconnect() })

async function makeProduct() {
  return prisma.product.create({
    data: { slug: 'routes-product', name: 'Routes', productType: 'resale', status: 'published' },
  })
}

describe('asset admin routes', () => {
  it('issues an upload token', async () => {
    const p = await makeProduct()
    const res = await request(app)
      .post('/api/v1/admin/images/upload-token')
      .send({ productId: p.id, contentType: 'image/jpeg', byteSize: 5000 })
    expect(res.status).toBe(201)
    expect(res.body.storageKey).toBe(`products/${p.id}/${res.body.imageId}/original.jpg`)
    expect(res.body.uploadUrl).toContain(res.body.storageKey)
  })

  it('rejects an unsupported content type with a structured error', async () => {
    const p = await makeProduct()
    const res = await request(app)
      .post('/api/v1/admin/images/upload-token')
      .send({ productId: p.id, contentType: 'application/pdf', byteSize: 100 })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('unsupported_content_type')
    expect(typeof res.body.message).toBe('string')
  })

  it('404s an unknown product', async () => {
    const res = await request(app)
      .post('/api/v1/admin/images/upload-token')
      .send({ productId: 'nope', contentType: 'image/jpeg', byteSize: 100 })
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('product_not_found')
  })

  it('confirms an upload once the bytes exist', async () => {
    const p = await makeProduct()
    const token = await request(app)
      .post('/api/v1/admin/images/upload-token')
      .send({ productId: p.id, contentType: 'image/jpeg', byteSize: 5000 })
    uploaded[token.body.storageKey] = OBJ

    const res = await request(app).post(`/api/v1/admin/images/${token.body.imageId}/confirm`).send({})
    expect(res.status).toBe(200)
    expect(res.body.width).toBe(1600)
    expect(res.body.height).toBe(1200)
  })

  it('refuses to confirm when nothing was uploaded', async () => {
    const p = await makeProduct()
    const token = await request(app)
      .post('/api/v1/admin/images/upload-token')
      .send({ productId: p.id, contentType: 'image/jpeg', byteSize: 5000 })
    const res = await request(app).post(`/api/v1/admin/images/${token.body.imageId}/confirm`).send({})
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('object_missing')
  })

  it('reorders images', async () => {
    const p = await makeProduct()
    const ids: string[] = []
    for (let i = 0; i < 2; i++) {
      const t = await request(app)
        .post('/api/v1/admin/images/upload-token')
        .send({ productId: p.id, contentType: 'image/jpeg', byteSize: 100 })
      uploaded[t.body.storageKey] = OBJ
      await request(app).post(`/api/v1/admin/images/${t.body.imageId}/confirm`).send({})
      ids.push(t.body.imageId)
    }

    const res = await request(app)
      .put(`/api/v1/admin/images/reorder`)
      .send({ productId: p.id, orderedIds: [ids[1], ids[0]] })
    expect(res.status).toBe(200)

    const rows = await prisma.image.findMany({ where: { productId: p.id }, orderBy: { position: 'asc' } })
    expect(rows.map(r => r.id)).toEqual([ids[1], ids[0]])
  })

  it('updates alt text', async () => {
    const p = await makeProduct()
    const t = await request(app)
      .post('/api/v1/admin/images/upload-token')
      .send({ productId: p.id, contentType: 'image/jpeg', byteSize: 100 })
    uploaded[t.body.storageKey] = OBJ
    await request(app).post(`/api/v1/admin/images/${t.body.imageId}/confirm`).send({})

    const res = await request(app)
      .patch(`/api/v1/admin/images/${t.body.imageId}`)
      .send({ alt: 'Front three-quarter view' })
    expect(res.status).toBe(200)
    expect(res.body.alt).toBe('Front three-quarter view')
  })

  it('deletes an image', async () => {
    const p = await makeProduct()
    const t = await request(app)
      .post('/api/v1/admin/images/upload-token')
      .send({ productId: p.id, contentType: 'image/jpeg', byteSize: 100 })
    uploaded[t.body.storageKey] = OBJ
    await request(app).post(`/api/v1/admin/images/${t.body.imageId}/confirm`).send({})

    const res = await request(app).delete(`/api/v1/admin/images/${t.body.imageId}`)
    expect(res.status).toBe(204)
    expect(await prisma.image.count({ where: { productId: p.id } })).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/core && npx vitest run tests/assets-routes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the router**

Create `systems/core/src/assets/assets.routes.ts`:

```ts
import { Router, type Response } from 'express'
import type { AssetStoragePort } from '../ports/storage/storage.port.js'
import {
  requestUpload, confirmUpload, reorderImages, deleteImage, ImageError,
} from './image.service.js'
import { prisma } from '../prisma.js'

// Maps a service error code to the HTTP status that describes it.
const STATUS_BY_CODE: Record<string, number> = {
  product_not_found: 404,
  image_not_found: 404,
  object_missing: 409,
  unsupported_content_type: 400,
  file_too_large: 413,
  invalid_byte_size: 400,
  invalid_order: 400,
}

function fail(res: Response, err: unknown) {
  if (err instanceof ImageError) {
    return res.status(STATUS_BY_CODE[err.code] ?? 400).json({ code: err.code, message: err.message })
  }
  throw err
}

export function createAssetsRouter(port: AssetStoragePort): Router {
  const router = Router()

  router.post('/upload-token', async (req, res) => {
    const { productId, contentType, byteSize } = req.body ?? {}
    if (typeof productId !== 'string' || typeof contentType !== 'string' || typeof byteSize !== 'number') {
      return res.status(400).json({ code: 'invalid_body', message: 'productId, contentType and byteSize are required' })
    }
    try {
      const result = await requestUpload(port, { productId, contentType, byteSize })
      res.status(201).json(result)
    } catch (err) { fail(res, err) }
  })

  router.post('/:id/confirm', async (req, res) => {
    try {
      res.json(await confirmUpload(port, req.params.id))
    } catch (err) { fail(res, err) }
  })

  router.put('/reorder', async (req, res) => {
    const { productId, orderedIds } = req.body ?? {}
    if (typeof productId !== 'string' || !Array.isArray(orderedIds)) {
      return res.status(400).json({ code: 'invalid_body', message: 'productId and orderedIds are required' })
    }
    try {
      await reorderImages(productId, orderedIds)
      res.json({ ok: true })
    } catch (err) { fail(res, err) }
  })

  router.patch('/:id', async (req, res) => {
    const { alt } = req.body ?? {}
    if (typeof alt !== 'string') {
      return res.status(400).json({ code: 'invalid_body', message: 'alt must be a string' })
    }
    const existing = await prisma.image.findUnique({ where: { id: req.params.id } })
    if (!existing) return res.status(404).json({ code: 'image_not_found', message: 'image not found' })
    const updated = await prisma.image.update({ where: { id: req.params.id }, data: { alt } })
    res.json({
      id: updated.id, storageKey: updated.storageKey, alt: updated.alt,
      position: updated.position, width: updated.width, height: updated.height,
    })
  })

  router.delete('/:id', async (req, res) => {
    try {
      await deleteImage(port, req.params.id)
      res.status(204).end()
    } catch (err) { fail(res, err) }
  })

  return router
}
```

- [ ] **Step 4: Mount it**

In `systems/core/src/app.ts`, add the import and the mount:

```ts
import { createAssetsRouter } from './assets/assets.routes.js'
import { createLocalStoragePort } from './ports/storage/local.adapter.js'
```

Inside `buildApp()`, before the `return`:

```ts
  // Local filesystem storage until a CDN provider is chosen. Swapping the
  // adapter is the only change required here.
  const storagePort = createLocalStoragePort(
    process.env.ASSET_STORAGE_DIR ?? './var/assets',
    process.env.ASSET_PUBLIC_BASE_URL ?? 'http://localhost:4000/assets',
  )
  app.use('/api/v1/admin/images', createAssetsRouter(storagePort))
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd systems/core && npx vitest run tests/assets-routes.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add systems/core/src/assets systems/core/src/app.ts systems/core/tests/assets-routes.test.ts
git commit -m "feat(core): admin image endpoints for upload, confirm, reorder, alt and delete

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Catalog DTO reads from the Image relation

**Files:**
- Modify: `systems/core/src/catalog/catalog.service.ts`
- Modify: `systems/core/prisma/seed.ts`
- Test: `systems/core/tests/catalog-dto.test.ts` (modify), `systems/core/tests/seed.test.ts` (modify)

**Interfaces:**
- Consumes: Task 1's `Image` model.
- Produces: `ProductDto.images` becomes `{ storageKey: string; alt: string; width: number; height: number; position: number }[]`, sourced from the relation, ordered by `position`, **excluding pending rows**. `toImages`/`toStringArray` for the images JSON is removed; `toStringArray` stays for `categories`, `features` and `includes`.

- [ ] **Step 1: Write the failing test**

Replace the images assertions in `systems/core/tests/catalog-dto.test.ts` and add these cases:

```ts
  it('returns images from the relation, ordered by position', async () => {
    const p = await prisma.product.findUniqueOrThrow({ where: { slug: 'dto-fixture' } })
    await prisma.image.createMany({
      data: [
        { productId: p.id, storageKey: `products/${p.id}/b/original.jpg`, alt: 'Second', position: 1, width: 800, height: 600, contentType: 'image/jpeg', byteSize: 10, status: 'ready' },
        { productId: p.id, storageKey: `products/${p.id}/a/original.jpg`, alt: 'First', position: 0, width: 900, height: 720, contentType: 'image/jpeg', byteSize: 10, status: 'ready' },
      ],
    })
    const dto = await getProduct('dto-fixture')
    expect(dto?.images.map(i => i.alt)).toEqual(['First', 'Second'])
    expect(dto?.images[0]).toMatchObject({ position: 0, width: 900, height: 720 })
    expect(dto?.images[0]!.storageKey).toBe(`products/${p.id}/a/original.jpg`)
  })

  // A half-uploaded image must never reach a customer.
  it('excludes pending images', async () => {
    const p = await prisma.product.findUniqueOrThrow({ where: { slug: 'dto-fixture' } })
    await prisma.image.create({
      data: {
        productId: p.id, storageKey: `products/${p.id}/pending/original.jpg`,
        alt: 'Not ready', position: 9, width: 1, height: 1,
        contentType: 'image/jpeg', byteSize: 1, status: 'pending',
      },
    })
    const dto = await getProduct('dto-fixture')
    expect(dto?.images.some(i => i.alt === 'Not ready')).toBe(false)
  })

  it('returns no url field — the client resolves URLs from the key', async () => {
    const dto = await getProduct('dto-fixture')
    for (const img of dto?.images ?? []) {
      expect((img as Record<string, unknown>).url).toBeUndefined()
    }
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/core && npx vitest run tests/catalog-dto.test.ts`
Expected: FAIL — DTO still returns JSON-derived `{url, alt}`.

- [ ] **Step 3: Update the DTO**

In `systems/core/src/catalog/catalog.service.ts`:

Replace the `ProductImage` interface and delete `toImages`:

```ts
export interface ProductImage {
  storageKey: string
  alt: string
  width: number
  height: number
  position: number
}
```

In `toDto`, replace the images line:

```ts
    images: (p.images ?? []).map((i: any) => ({
      storageKey: i.storageKey, alt: i.alt,
      width: i.width, height: i.height, position: i.position,
    })),
```

Every query that returns products must include ready images in order. In
`listProducts`, `getProduct` and `getAvailability`, change each
`include: { variants: true }` to:

```ts
    include: {
      variants: true,
      images: { where: { status: 'ready' }, orderBy: { position: 'asc' } },
    },
```

- [ ] **Step 4: Update the seed to write Image rows**

In `systems/core/prisma/seed.ts`, each product currently carries an `images` array of `{url, alt}`. Change the shape to carry keys, and create rows.

Replace each product's `images` entry, for example:

```ts
    images: [
      { key: 'products/seed/millennium-city-skyline/1/original.svg', alt: 'Placeholder image for Millennium City Skyline' },
      { key: 'products/seed/millennium-city-skyline/2/original.svg', alt: 'Placeholder alternate view of Millennium City Skyline' },
    ],
```

And in the `seed()` loop, after the product upsert, create the rows:

```ts
    const saved = await prisma.product.findUniqueOrThrow({ where: { slug: p.slug } })
    if ((await prisma.image.count({ where: { productId: saved.id } })) === 0) {
      await prisma.image.createMany({
        data: p.images.map((img, position) => ({
          productId: saved.id,
          storageKey: img.key,
          alt: img.alt,
          position,
          // The real viewBox of every placeholder SVG.
          width: 900,
          height: 720,
          contentType: 'image/svg+xml',
          byteSize: 512,
          status: 'ready' as const,
        })),
      })
    }
```

Remove `images` from the object spread passed to `prisma.product.upsert` so it no longer writes the JSON column.

- [ ] **Step 5: Update the seed test**

In `systems/core/tests/seed.test.ts`, replace the images assertion:

```ts
  it('gives every product at least one image row with alt text', async () => {
    const all = await prisma.product.findMany({ include: { images: true, variants: true } })
    for (const p of all) {
      expect(p.variants.length).toBeGreaterThanOrEqual(1)
      expect(p.images.length).toBeGreaterThanOrEqual(1)
      for (const i of p.images) {
        expect(i.alt.length).toBeGreaterThan(0)
        expect(i.width).toBeGreaterThan(0)
        expect(i.height).toBeGreaterThan(0)
      }
    }
  })

  it('numbers image positions from zero with no gaps', async () => {
    const all = await prisma.product.findMany({ include: { images: { orderBy: { position: 'asc' } } } })
    for (const p of all) {
      expect(p.images.map(i => i.position)).toEqual(p.images.map((_, idx) => idx))
    }
  })
```

- [ ] **Step 6: Run the full core suite**

Run: `cd systems/core && npm test`
Expected: all pass. `catalog-routes.test.ts` asserts an images payload — update its expectation to the key shape.

- [ ] **Step 7: Commit**

```bash
git add systems/core/src systems/core/prisma systems/core/tests
git commit -m "feat(core): serve product images from the Image relation

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Drop the JSON column

**Files:**
- Modify: `systems/core/prisma/schema.prisma`
- Create: `systems/core/prisma/migrations/<timestamp>_drop_product_images_json/migration.sql`
- Test: `systems/core/tests/images-schema.test.ts` (modify)

**Interfaces:**
- Consumes: Task 5 — nothing reads `imagesJson` any more.
- Produces: `Product.imagesJson` removed.

**This is the contract step of expand → migrate → contract.** Run it only after Task 5 is green, and confirm nothing references `imagesJson` first.

- [ ] **Step 1: Confirm nothing reads the column**

Run: `cd systems/core && grep -rn "imagesJson" src prisma tests`
Expected: no matches outside `schema.prisma`. If anything else matches, stop and fix it before dropping the column.

- [ ] **Step 2: Write the failing test**

Add to `systems/core/tests/images-schema.test.ts`:

```ts
  it('no longer exposes the legacy images JSON column', async () => {
    const rows = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'products' AND column_name = 'images'
    `
    expect(rows).toEqual([])
  })
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd systems/core && npx vitest run tests/images-schema.test.ts`
Expected: FAIL — the column still exists.

- [ ] **Step 4: Remove the field and migrate**

Delete this line from `model Product` in `schema.prisma`:

```prisma
  imagesJson  Json        @default("[]") @map("images")
```

Run: `cd systems/core && npx prisma migrate dev --name drop_product_images_json`

- [ ] **Step 5: Run the full suite**

Run: `cd systems/core && npm test`
Expected: all pass.

- [ ] **Step 6: Verify a fresh database still migrates**

The migration ordering bug that broke `main` was invisible on an already-migrated database. Prove this chain applies from empty:

```bash
cd systems/core
npx prisma migrate reset --force --skip-seed
npx prisma migrate deploy
npm run seed
npm test
```

Expected: every migration applies in order, seed succeeds, tests pass.

- [ ] **Step 7: Commit**

```bash
git add systems/core/prisma systems/core/tests
git commit -m "feat(core): drop the legacy Product.images JSON column

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Core URL resolver

**Files:**
- Create: `systems/core/src/assets/image-url.ts`
- Test: `systems/core/tests/image-url.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `imageUrl(storageKey: string, opts?: { width?: number; format?: 'auto' | 'webp' | 'jpeg' }): string`, reading the base from `ASSET_PUBLIC_BASE_URL`.

**This function is deliberately duplicated** in core and the storefront (Task 8). Core needs it for the Walmart item feed; the storefront needs it for `srcset`. Task 9 adds a test that fails if the two copies drift.

- [ ] **Step 1: Write the failing test**

Create `systems/core/tests/image-url.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { imageUrl } from '../src/assets/image-url.js'

const KEY = 'products/p1/i1/original.jpg'
let saved: string | undefined

beforeEach(() => { saved = process.env.ASSET_PUBLIC_BASE_URL; process.env.ASSET_PUBLIC_BASE_URL = 'https://cdn.test' })
afterEach(() => { process.env.ASSET_PUBLIC_BASE_URL = saved })

describe('imageUrl', () => {
  it('returns the original when no options are given', () => {
    expect(imageUrl(KEY)).toBe('https://cdn.test/products/p1/i1/original.jpg')
  })

  it('adds a width parameter', () => {
    expect(imageUrl(KEY, { width: 800 })).toBe('https://cdn.test/products/p1/i1/original.jpg?w=800')
  })

  it('adds width and format together', () => {
    expect(imageUrl(KEY, { width: 800, format: 'webp' }))
      .toBe('https://cdn.test/products/p1/i1/original.jpg?w=800&fmt=webp')
  })

  it('does not double a slash when the base has a trailing one', () => {
    process.env.ASSET_PUBLIC_BASE_URL = 'https://cdn.test/'
    expect(imageUrl(KEY)).toBe('https://cdn.test/products/p1/i1/original.jpg')
  })

  it('rejects a non-positive width rather than emitting a nonsense URL', () => {
    expect(() => imageUrl(KEY, { width: 0 })).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/core && npx vitest run tests/image-url.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `systems/core/src/assets/image-url.ts`:

```ts
export type ImageFormat = 'auto' | 'webp' | 'jpeg'

export interface ImageUrlOptions {
  width?: number
  format?: ImageFormat
}

/**
 * Composes a delivery URL from an immutable storage key.
 *
 * THIS FUNCTION IS DUPLICATED in the storefront
 * (systems/storefront/code/src/lib/images.ts) and the two must produce
 * identical output. Core needs it for the Walmart item feed; the storefront
 * needs it for srcset. A drift test pins them together.
 *
 * Changing CDN provider means changing this grammar in both places and the
 * ASSET_PUBLIC_BASE_URL environment variable. No database rows change.
 */
export function imageUrl(storageKey: string, opts: ImageUrlOptions = {}): string {
  const base = (process.env.ASSET_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '')
  const params = new URLSearchParams()

  if (opts.width !== undefined) {
    if (!Number.isInteger(opts.width) || opts.width < 1) {
      throw new Error(`imageUrl: width must be a positive integer, got ${opts.width}`)
    }
    params.set('w', String(opts.width))
  }
  if (opts.format) params.set('fmt', opts.format)

  const qs = params.toString()
  return `${base}/${storageKey}${qs ? `?${qs}` : ''}`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd systems/core && npx vitest run tests/image-url.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add systems/core/src/assets/image-url.ts systems/core/tests/image-url.test.ts
git commit -m "feat(core): image URL resolver keyed on the storage key

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: Contract and ADR updates

**Files:**
- Modify: `contracts/openapi/catalog.yaml`
- Modify: `docs/adr/0001-catalog-api-contract.md`
- Modify: `docs/adr/0002-image-cdn-asset-delivery.md`

- [ ] **Step 1: Update the contract to 3.0.0**

In `contracts/openapi/catalog.yaml`:

- Set `info.version` to `3.0.0`.
- Replace the `Image` schema entirely:

```yaml
    Image:
      type: object
      required: [storageKey, alt, width, height, position]
      properties:
        storageKey:
          type: string
          description: >-
            Immutable storage key, format products/{productId}/{imageId}/original.{ext}.
            NOT a URL. Consumers compose a delivery URL from this key, so the
            CDN host and transform grammar can change without touching data.
        alt:
          type: string
          description: Human-authored alternative text (WCAG 2.1 AA). May be empty for decorative images.
        width:
          type: integer
          description: Intrinsic pixel width, read from storage at upload. Lets clients reserve layout space.
        height:
          type: integer
          description: Intrinsic pixel height, read from storage at upload.
        position:
          type: integer
          description: Display order. position 0 is the primary image.
```

- In `info.description`, add: *"Images are returned as immutable storage keys, never URLs. Only images in the `ready` state are returned; a partially uploaded image is never visible."*

- [ ] **Step 2: Append the second ADR-0001 amendment**

Append to `docs/adr/0001-catalog-api-contract.md`:

```markdown
---

## Amendment — 2026-08-13: images become storage keys

**Status:** ACCEPTED. **Contract version:** `catalog.yaml` moves to 3.0.0.

`images[].url` is replaced by `images[].storageKey`, and `width`, `height` and
`position` are added. **This is a breaking change**, not the additive extension
ADR-0002 anticipated — that note covered *extending* `{url, alt}`, not
replacing `url`.

A URL welds a row to one host, one directory layout and one environment. A key
is an identifier; the host and transform grammar resolve around it at render
time, so changing CDN provider touches configuration and two resolver functions
and **no database rows**.

`url` is deliberately **not** retained alongside `storageKey`. The only consumer
is our own storefront, and carrying both invites the wrong one being used and
quietly reintroduces a hard-coded host.

Design: `docs/superpowers/specs/2026-08-13-product-image-asset-architecture-design.md`.
```

- [ ] **Step 3: Update ADR-0002**

Change the status line of `docs/adr/0002-image-cdn-asset-delivery.md` to:

```markdown
**Status:** PARTIALLY ACCEPTED (2026-08-13) — transforms, URL convention and
ingestion are decided. **CDN host and spend remain OPEN and are Jack's.**
```

Append:

```markdown
---

## Decided — 2026-08-13

Design: `docs/superpowers/specs/2026-08-13-product-image-asset-architecture-design.md`.

- **Transforms:** resolved **on the fly at the edge**. One stored object per
  image; sizes are requested by URL parameter. Adding a size later needs no
  backfill.
- **URL convention:** the database stores an **immutable storage key**,
  `products/{productId}/{imageId}/original.{ext}`, never a URL. Bytes are never
  replaced in place, so derivative URLs are safe to cache at the edge
  indefinitely.
- **Delivery is public, not signed.** Walmart's crawler cannot follow an
  expiring URL, so signed delivery would break that channel. The question this
  ADR raised about signed URLs needing an ADR-0001 amendment therefore does not
  arise.
- **Ingestion:** direct upload against a short-lived target minted by core.
  Bytes never pass through core. A row is `pending` until core has verified the
  object exists and read its true dimensions from storage.

## Still open

- **CDN / origin host** and **cost model & spend approval** — Jack's.
  The architecture requires only signed uploads, URL-addressed transforms and
  edge caching. It is reached through `AssetStoragePort`, so choosing a provider
  means writing one adapter, not changing the catalog.
```

- [ ] **Step 4: Commit**

```bash
git add contracts/openapi/catalog.yaml docs/adr
git commit -m "docs(catalog): contract 3.0.0 and ADR amendments for storage keys

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: Storefront types and resolver

**Files:**
- Modify: `systems/storefront/code/src/lib/api/types.ts`
- Create: `systems/storefront/code/src/lib/images.ts`
- Test: `systems/storefront/code/src/lib/images.test.ts`

**Interfaces:**
- Consumes: Task 7's grammar.
- Produces: `ProductImage = { storageKey: string; alt: string; width: number; height: number; position: number }`; `imageUrl(storageKey, opts?)`; `imageSrcSet(storageKey, widths: number[]): string`.

- [ ] **Step 1: Write the failing test**

Create `systems/storefront/code/src/lib/images.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { imageUrl, imageSrcSet, CARD_WIDTHS, DETAIL_WIDTHS } from './images'

const KEY = 'products/p1/i1/original.jpg'

describe('imageUrl', () => {
  it('returns the original when no options are given', () => {
    expect(imageUrl(KEY)).toBe('/assets/products/p1/i1/original.jpg')
  })

  it('adds a width parameter', () => {
    expect(imageUrl(KEY, { width: 800 })).toBe('/assets/products/p1/i1/original.jpg?w=800')
  })

  it('adds width and format together, in that order', () => {
    expect(imageUrl(KEY, { width: 800, format: 'webp' }))
      .toBe('/assets/products/p1/i1/original.jpg?w=800&fmt=webp')
  })

  it('rejects a non-positive width rather than emitting a nonsense URL', () => {
    expect(() => imageUrl(KEY, { width: 0 })).toThrow()
  })
})

describe('imageSrcSet', () => {
  it('emits one candidate per width with its descriptor', () => {
    expect(imageSrcSet(KEY, [400, 800])).toBe(
      '/assets/products/p1/i1/original.jpg?w=400 400w, /assets/products/p1/i1/original.jpg?w=800 800w',
    )
  })

  it('exposes ascending width ladders for cards and detail', () => {
    expect([...CARD_WIDTHS].sort((a, b) => a - b)).toEqual([...CARD_WIDTHS])
    expect([...DETAIL_WIDTHS].sort((a, b) => a - b)).toEqual([...DETAIL_WIDTHS])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/storefront/code && npx vitest run src/lib/images.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `systems/storefront/code/src/lib/images.ts`:

```ts
export type ImageFormat = 'auto' | 'webp' | 'jpeg'

export interface ImageUrlOptions {
  width?: number
  format?: ImageFormat
}

/** Ascending ladders. Keep sorted — imageSrcSet emits them in order. */
export const CARD_WIDTHS = [400, 600, 900] as const
export const DETAIL_WIDTHS = [600, 900, 1400, 2000] as const

const BASE = (import.meta.env.VITE_ASSET_BASE_URL ?? '/assets').replace(/\/+$/, '')

/**
 * Composes a delivery URL from an immutable storage key.
 *
 * THIS FUNCTION IS DUPLICATED in core (systems/core/src/assets/image-url.ts)
 * and the two must produce identical output — core needs it for the Walmart
 * item feed, this copy serves srcset. A drift test pins them together.
 */
export function imageUrl(storageKey: string, opts: ImageUrlOptions = {}): string {
  const params = new URLSearchParams()

  if (opts.width !== undefined) {
    if (!Number.isInteger(opts.width) || opts.width < 1) {
      throw new Error(`imageUrl: width must be a positive integer, got ${opts.width}`)
    }
    params.set('w', String(opts.width))
  }
  if (opts.format) params.set('fmt', opts.format)

  const qs = params.toString()
  return `${BASE}/${storageKey}${qs ? `?${qs}` : ''}`
}

export function imageSrcSet(storageKey: string, widths: readonly number[]): string {
  return widths.map(w => `${imageUrl(storageKey, { width: w })} ${w}w`).join(', ')
}
```

- [ ] **Step 4: Update the API types**

In `systems/storefront/code/src/lib/api/types.ts`, replace `ProductImage`:

```ts
export interface ProductImage {
  storageKey: string
  alt: string
  width: number
  height: number
  position: number
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd systems/storefront/code && npx vitest run src/lib/images.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add systems/storefront/code/src/lib
git commit -m "feat(storefront): image URL resolver and srcset helper

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: Storefront components consume keys

**Files:**
- Modify: `systems/storefront/code/src/components/ProductCard.tsx`
- Modify: `systems/storefront/code/src/pages/ProductDetail.tsx`
- Test: `systems/storefront/code/src/components/ProductCard.test.tsx` (modify), `systems/storefront/code/src/pages/catalog-pages.test.tsx` (modify)
- Create: `systems/storefront/code/src/lib/resolver-parity.test.ts`

- [ ] **Step 1: Write the drift test**

This is the test that makes duplicating the resolver safe. Create
`systems/storefront/code/src/lib/resolver-parity.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { imageUrl } from './images'

const here = dirname(fileURLToPath(import.meta.url))
const CORE_RESOLVER = join(here, '../../../../core/src/assets/image-url.ts')

/**
 * The resolver exists in two places by design. This test reads core's copy and
 * checks the grammar has not drifted from this one. It is a source-level check
 * because the two live in separate packages that cannot import each other.
 */
describe('resolver parity with core', () => {
  const coreSource = readFileSync(CORE_RESOLVER, 'utf8')

  it('core uses the same query parameter names', () => {
    expect(coreSource).toContain(`params.set('w', String(opts.width))`)
    expect(coreSource).toContain(`params.set('fmt', opts.format)`)
  })

  it('core strips trailing slashes from the base as this copy does', () => {
    expect(coreSource).toMatch(/replace\(\/\\\/\+\$\/, ''\)/)
  })

  it('this copy produces the documented shape', () => {
    expect(imageUrl('products/p/i/original.jpg', { width: 800, format: 'webp' }))
      .toContain('?w=800&fmt=webp')
  })
})
```

- [ ] **Step 2: Run it to verify it passes**

Run: `cd systems/storefront/code && npx vitest run src/lib/resolver-parity.test.ts`
Expected: PASS, 3 tests. If it fails, the two resolvers have already drifted — fix the source, not the test.

- [ ] **Step 3: Update the ProductCard test fixture and assertions**

In `src/components/ProductCard.test.tsx`, change the fixture's images:

```ts
    images: [{ storageKey: 'products/p1/i1/original.jpg', alt: 'Dragon Fortress front view', width: 900, height: 720, position: 0 }],
```

Replace the image assertion and add a dimensions test:

```ts
  it('uses the image alt text supplied by the API', () => {
    wrap(make())
    expect(screen.getByAltText('Dragon Fortress front view')).toBeInTheDocument()
  })

  it('resolves the src from the storage key', () => {
    wrap(make())
    expect(screen.getByAltText('Dragon Fortress front view'))
      .toHaveAttribute('src', expect.stringContaining('products/p1/i1/original.jpg'))
  })

  // Without intrinsic dimensions every card reflows as images load.
  it('reserves layout space with width and height attributes', () => {
    wrap(make())
    const img = screen.getByAltText('Dragon Fortress front view')
    expect(img).toHaveAttribute('width', '900')
    expect(img).toHaveAttribute('height', '720')
  })

  it('emits a srcset so the browser can pick a size', () => {
    wrap(make())
    expect(screen.getByAltText('Dragon Fortress front view')).toHaveAttribute('srcset')
  })
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd systems/storefront/code && npx vitest run src/components/ProductCard.test.tsx`
Expected: FAIL — `image.url` is undefined.

- [ ] **Step 5: Update ProductCard**

In `src/components/ProductCard.tsx`, add the import:

```tsx
import { imageUrl, imageSrcSet, CARD_WIDTHS } from '../lib/images'
```

Replace the `<img>`:

```tsx
            <img
              src={imageUrl(image.storageKey, { width: 900 })}
              srcSet={imageSrcSet(image.storageKey, CARD_WIDTHS)}
              sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
              alt={image.alt}
              width={image.width}
              height={image.height}
              loading="lazy"
              className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
```

- [ ] **Step 6: Update ProductDetail**

In `src/pages/ProductDetail.tsx`, add the import:

```tsx
import { imageUrl, imageSrcSet, DETAIL_WIDTHS } from '../lib/images'
```

Replace the main gallery image:

```tsx
            {image && (
              <img
                src={imageUrl(image.storageKey, { width: 1400 })}
                srcSet={imageSrcSet(image.storageKey, DETAIL_WIDTHS)}
                sizes="(min-width: 1024px) 50vw, 100vw"
                alt={image.alt}
                width={image.width}
                height={image.height}
                className="w-full h-full object-cover"
              />
            )}
```

Replace the thumbnail image (note the empty alt — the button already carries the label):

```tsx
                  <img
                    src={imageUrl(img.storageKey, { width: 200 })}
                    alt=""
                    width={img.width}
                    height={img.height}
                    className="w-full h-full object-cover"
                  />
```

The thumbnail button keeps `aria-label={`View ${img.alt}`}`, and the gallery
key changes from `img.url` to `img.storageKey`.

- [ ] **Step 7: Update the catalog page test fixtures**

In `src/pages/catalog-pages.test.tsx`, change the fixture images:

```ts
    images: [
      { storageKey: 'products/p1/a/original.jpg', alt: 'Dragon Fortress front', width: 1600, height: 1200, position: 0 },
      { storageKey: 'products/p1/b/original.jpg', alt: 'Dragon Fortress rear', width: 1600, height: 1200, position: 1 },
    ],
```

- [ ] **Step 8: Run the full storefront suite, typecheck and build**

```bash
cd systems/storefront/code
npx vitest run
npx tsc --noEmit
npm run build
```

Expected: all tests pass, no type errors, clean build. The build step is separate on purpose — vitest never typechecks.

- [ ] **Step 9: Commit**

```bash
git add systems/storefront/code/src
git commit -m "feat(storefront): render images from storage keys with srcset

Intrinsic width and height are now emitted on every product image so cards
reserve layout space instead of reflowing as images load.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 11: End-to-end verification and docs

**Files:**
- Modify: `systems/storefront/code/README.md`
- Modify: `systems/core/README.md`
- Modify: `systems/core/.env.example`

- [ ] **Step 1: Add the storage environment variables**

Append to `systems/core/.env.example`:

```
# Where image bytes live until a CDN provider is chosen (ADR-0002).
ASSET_STORAGE_DIR=./var/assets
ASSET_PUBLIC_BASE_URL=http://localhost:4000/assets
```

- [ ] **Step 2: Verify both systems in full**

```bash
cd systems/core && npm test && npx tsc --noEmit && npm run build
cd ../storefront/code && npx vitest run && npx tsc --noEmit && npm run build
```

Expected: all green.

- [ ] **Step 3: Boot and click through**

```bash
cd systems/core && npm run seed && node dist/server.js
```

In a second shell, `cd systems/storefront/code && npm run dev`, then confirm by eye:

- The home page renders product images from seeded keys.
- A product card's `<img>` carries `srcset`, `width` and `height` — check in devtools, because a missing `width` is invisible until the page reflows.
- The product detail gallery renders and thumbnails switch the main image.
- `curl "http://localhost:4000/api/v1/catalog/products?pageSize=1"` returns `images[].storageKey` and **no** `url` field.

- [ ] **Step 4: Exercise the ingestion path by hand**

```bash
curl -X POST http://localhost:4000/api/v1/admin/images/upload-token \
  -H 'content-type: application/json' \
  -d '{"productId":"<a real product id>","contentType":"image/png","byteSize":1234}'
```

Expected: 201 with `imageId`, `storageKey` and `uploadUrl`. Then confirm without uploading anything:

```bash
curl -X POST http://localhost:4000/api/v1/admin/images/<imageId>/confirm
```

Expected: **409 `object_missing`**. That failure is the point — it proves a row cannot go `ready` without bytes behind it.

- [ ] **Step 5: Update the READMEs**

In `systems/storefront/code/README.md`, replace the "Product photography is placeholder" bullet with:

```markdown
- **Images are storage keys, not URLs.** The API returns
  `images[].storageKey`; `src/lib/images.ts` composes delivery URLs from it.
  That resolver is **duplicated in core** for the Walmart feed, and
  `src/lib/resolver-parity.test.ts` fails if the two grammars drift.
- **Always render `width` and `height`** on product images. They come from the
  API and stop cards reflowing as images load.
- Product photography is still placeholder art in `public/img/placeholder/`.
```

In `systems/core/README.md`, add a section:

```markdown
## Image storage

Images are rows in the `images` table holding an **immutable storage key**,
never a URL. Bytes are reached through `AssetStoragePort`; the local filesystem
adapter is used until a CDN provider is chosen (ADR-0002).

Uploads are two-phase: `POST /api/v1/admin/images/upload-token` reserves a
**pending** row, the client PUTs bytes directly to storage, then
`POST /api/v1/admin/images/:id/confirm` verifies the object and reads its true
dimensions. Pending rows are never returned by the public catalog API.

**These admin endpoints have no authentication.** They must not be exposed
publicly before auth exists.
```

- [ ] **Step 6: Commit**

```bash
git add systems/core systems/storefront/code/README.md
git commit -m "docs: record the image storage architecture and env vars

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Report and request approval to push**

Report test counts for both systems, the boot check result, and the 409 confirmation. **Do not push** — Jack approves pushes.

---

## Carried out of this plan

1. **CDN provider and spend — Jack's.** Choosing one means writing a second
   `AssetStoragePort` adapter and changing two resolver functions plus one
   environment variable. Nothing else.
2. **The admin endpoints have no auth.** Neither does the rest of core, so this
   is not a regression, but image upload is the first endpoint that writes
   arbitrary bytes and it should not reach a public network first.
3. **`sweepPendingImages` is implemented and tested but nothing calls it.**
   There is no scheduler in core. Abandoned uploads therefore accumulate as
   invisible pending rows until something invokes it. That is harmless at
   current volume — pending rows are excluded from every public response — but
   it is a job waiting to be wired, not a finished feature. Core has no cron
   story at all yet, which is why this plan does not invent one.
4. **The Walmart item feed still sends no images.** Task 7's resolver is what it
   will use; wiring it is part of the Walmart work, not this plan.
5. **`admin-ui` is still on its mock.** The `Image` table finally makes its
   reorder/alt/delete operations implementable against core, but wiring it up is
   a separate piece.
6. **Real product photography still does not exist.** The pipeline built here
   has nothing to ingest yet.
