# Product Image Upload (imgix + S3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins upload, reorder, describe and delete product photos in the console. The files are stored in private S3 buckets and served resized by imgix to the storefront, the console and the Walmart feed.

**Architecture:** An S3 adapter implements core's existing `AssetStoragePort`, and an environment switch picks it at startup. Core's confirm step is hardened to verify the real object. The shared image-URL grammar moves to imgix's parameters in both copies. Abandoned uploads are swept per product on each new upload. The console's Images tab drives the existing two-phase upload: token, then a direct PUT to S3, then confirm.

**Tech Stack:** Node 20, TypeScript, Express 4, Prisma 5, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, `image-size` 2, Vitest, `aws-sdk-client-mock` (core); React 18, Vite, Vitest + Testing Library (admin-ui); storefront TypeScript/Vite.

**Spec:** `docs/superpowers/specs/2026-09-25-product-image-upload-design.md`. Read it before starting. Section references (§) below point into it.

## Global Constraints

- **Core tests use the project's own DB config: do NOT set `DATABASE_URL`.** The `alpinebrick-core-db` container on :5433 must be running (`docker start alpinebrick-core-db`).
- **Never read or print `.env`, `.env.example` or `secrets/`.** No real AWS credentials anywhere in code or tests. Tests never reach AWS.
- **Branching:** `feat/image-upload-core` (Tasks 0–5) cut from `main`; `feat/image-upload-console` (Tasks 6–9) cut from `main` after the core PR merges.
- **Commits:** conventional, the subject names the system (`feat(core):`, `feat(admin-ui):`, `feat(storefront):`), with trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Pushing needs Jack's OK.
- **Accepted image types:** `image/jpeg`, `image/png`, `image/webp`. SVG is removed. `MAX_UPLOAD_BYTES` stays `15 * 1024 * 1024`.
- **Presigned upload expiry:** 15 minutes. **Sweep age:** pending rows older than 24 hours.
- **Image error codes stay lower_snake** (the image routes' existing convention): `upload_too_large` (413), `upload_mismatch` (409), `not_an_image` (422).
- **imgix grammar:** width `w=N`, `format: 'auto'` → `auto=format`, `'webp'` → `fm=webp`, `'jpeg'` → `fm=jpg`. Parameter order: width first, then format.
- **Env keys:** `ASSET_STORAGE` (`s3` or unset), `ASSET_S3_BUCKET`, `ASSET_S3_REGION`, `ASSET_S3_ACCESS_KEY_ID`, `ASSET_S3_SECRET_ACCESS_KEY`, `ASSET_PUBLIC_BASE_URL`; `VITE_ASSET_BASE_URL` for the storefront and admin-ui.
- **Console patterns from PR #35:** errors via `errorText(err)`, in-flight guards on every write button, nothing shown as saved until core confirms, no mock fallback.
- **Before merging either PR:** full suite(s), `npm run build`, and (core) the compiled server booted with `/health` ok.

## File Structure

| File | Responsibility |
|---|---|
| `systems/core/src/assets/image-url.ts` | imgix grammar (Task 1) |
| `systems/storefront/code/src/lib/images.ts` (+ `images.test.ts`, `resolver-parity.test.ts`) | storefront copy of the grammar (Task 1) |
| `systems/core/src/ports/storage/s3.adapter.ts` | **New.** `createS3StoragePort(config, client?)` (Task 2) |
| `systems/core/src/ports/storage/index.ts` | **New.** `createStoragePort(env)`: local or S3, and throws when S3 is half-configured (Task 2) |
| `systems/core/src/app.ts` | uses `createStoragePort()` (Task 2) |
| `systems/core/src/assets/image.service.ts` | SVG removed; confirm hardening; per-product sweep (Tasks 3–4) |
| `systems/core/src/assets/assets.routes.ts` | new status codes (Task 3) |
| `render.yaml` | new `sync: false` keys (Task 2) |
| `docs/status/2026-09-25-image-storage-setup-runbook.md` | **New.** Jack's AWS and imgix setup (Task 5) |
| `systems/admin-ui/src/data/api.js` | image methods, `uploadToStorage` (Task 6) |
| `systems/admin-ui/src/catalog/tabs/ImagesTab.jsx` | live tab (Tasks 7–8) |
| `systems/admin-ui/src/catalog/tabs/imageFiles.js` | **New.** client file checks (Task 7) |

---

## Task 0: Baseline

- [ ] **Step 1:** `docker start alpinebrick-core-db && docker exec alpinebrick-core-db pg_isready -U postgres`. Expected: `accepting connections`.
- [ ] **Step 2:** `git checkout main && git pull --ff-only && git checkout -b feat/image-upload-core`
- [ ] **Step 3:** In `systems/core`, `npx vitest run`; in `systems/storefront/code`, `npx vitest run`; in `systems/admin-ui`, `npx vitest run`. Record the three counts. All should pass.

---

## Task 1: imgix URL grammar (core + storefront)

**Files:**
- Modify: `systems/core/src/assets/image-url.ts`
- Modify: `systems/core/tests/image-url.test.ts:24`
- Modify: `systems/storefront/code/src/lib/images.ts`
- Modify: `systems/storefront/code/src/lib/images.test.ts`
- Modify: `systems/storefront/code/src/lib/resolver-parity.test.ts`

**Interfaces:**
- Produces: `imageUrl(key, { width?, format? })` in both packages, emitting `?w=N` then `auto=format` | `fm=webp` | `fm=jpg`.

- [ ] **Step 1: Update the tests first**

`systems/core/tests/image-url.test.ts`: change the expectation on line 24 to
`'https://cdn.test/products/p1/i1/original.jpg?w=800&fm=webp'`, and add:
```ts
  it('maps formats to imgix parameters', () => {
    process.env.ASSET_PUBLIC_BASE_URL = 'https://cdn.test'
    expect(imageUrl('k.jpg', { format: 'auto' })).toBe('https://cdn.test/k.jpg?auto=format')
    expect(imageUrl('k.jpg', { format: 'webp' })).toBe('https://cdn.test/k.jpg?fm=webp')
    expect(imageUrl('k.jpg', { width: 400, format: 'jpeg' })).toBe('https://cdn.test/k.jpg?w=400&fm=jpg')
  })
```
(If that test file sets `ASSET_PUBLIC_BASE_URL` in a `beforeEach`, reuse it instead of setting it inline.)

`systems/storefront/code/src/lib/images.test.ts`: the "width and format together" case expects `'/products/p1/i1/original.jpg?w=800&fm=webp'`. Add:
```ts
  it('maps formats to imgix parameters', () => {
    expect(imageUrl(KEY, { format: 'auto' })).toBe('/products/p1/i1/original.jpg?auto=format')
    expect(imageUrl(KEY, { width: 600, format: 'jpeg' })).toBe('/products/p1/i1/original.jpg?w=600&fm=jpg')
  })
```
`resolver-parity.test.ts`: replace the `params.set('fmt', opts.format)` assertion with
```ts
    expect(coreSource).toContain(`params.set('w', String(opts.width))`)
    expect(coreSource).toContain(`auto: ['auto', 'format']`)
    expect(coreSource).toContain(`webp: ['fm', 'webp']`)
    expect(coreSource).toContain(`jpeg: ['fm', 'jpg']`)
```
and change the last case's expectation to `.toContain('?w=800&fm=webp')`.

- [ ] **Step 2: Run to see them fail**

In `systems/core`: `npx vitest run tests/image-url.test.ts`. In `systems/storefront/code`: `npx vitest run src/lib/images.test.ts src/lib/resolver-parity.test.ts`. Expected: FAIL (still `fmt=`).

- [ ] **Step 3: Change both copies identically**

In each file, above `imageUrl`:
```ts
/** imgix parameter for each supported format (spec 2026-09-25 §4.3). */
const FORMAT_PARAM: Record<ImageFormat, [string, string]> = {
  auto: ['auto', 'format'],
  webp: ['fm', 'webp'],
  jpeg: ['fm', 'jpg'],
}
```
Replace `if (opts.format) params.set('fmt', opts.format)` with:
```ts
  if (opts.format) {
    const [name, value] = FORMAT_PARAM[opts.format]
    params.set(name, value)
  }
```
In both files' doc comments, replace "Changing CDN provider means changing this grammar…" with "The grammar is imgix's (ADR-0002, decided 2026-09-25). Changing provider means changing it here, in the other copy, and the base-URL environment variable. No database rows change."

- [ ] **Step 4: Run and commit**

Run both test commands from Step 2, then each package's full suite. Expected: PASS. `grep -rn "fmt=" systems/core/src systems/storefront/code/src` shows nothing.
```bash
git add systems/core systems/storefront/code
git commit -m "feat(core,storefront): image URLs use imgix parameters"
```

---

## Task 2: S3 adapter and storage selection

**Files:**
- Create: `systems/core/src/ports/storage/s3.adapter.ts`
- Create: `systems/core/src/ports/storage/index.ts`
- Modify: `systems/core/src/app.ts` (the `createLocalStoragePort(...)` call, around lines 56–62)
- Modify: `systems/core/package.json` (dependencies)
- Modify: `render.yaml` (core-env keys; `VITE_ASSET_BASE_URL` on storefront and admin-ui)
- Test: `systems/core/tests/storage-s3-adapter.test.ts`, `systems/core/tests/storage-selection.test.ts`

**Interfaces:**
- Produces:
  - `createS3StoragePort(config: { bucket: string; region: string; accessKeyId: string; secretAccessKey: string }, client?: S3Client): AssetStoragePort`
  - `createStoragePort(env?: NodeJS.ProcessEnv): AssetStoragePort` (throws `Error` naming missing keys)
  - `UPLOAD_URL_TTL_SECONDS = 900`

- [ ] **Step 1: Add dependencies**

In `systems/core`: `npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner` and `npm install -D aws-sdk-client-mock`. Commit the lockfile with the task.

- [ ] **Step 2: Write the failing adapter test**

```ts
// tests/storage-s3-adapter.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { mockClient } from 'aws-sdk-client-mock'
import { sdkStreamMixin } from '@smithy/util-stream'
import {
  S3Client, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand, NotFound,
} from '@aws-sdk/client-s3'
import { createS3StoragePort, UPLOAD_URL_TTL_SECONDS } from '../src/ports/storage/s3.adapter.js'

// A 1x1 PNG, the same fixture storage-local-adapter.test.ts uses.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const CONFIG = { bucket: 'test-bucket', region: 'us-west-2', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test' }
const body = (buf: Buffer) => sdkStreamMixin(Readable.from([buf]))

const s3 = mockClient(S3Client)
beforeEach(() => s3.reset())

function port() {
  return createS3StoragePort(CONFIG, new S3Client({ region: CONFIG.region, credentials: CONFIG }))
}

describe('S3 storage adapter', () => {
  it('presigns a PUT for exactly the key and content type, expiring in 15 minutes', async () => {
    const before = Date.now()
    const t = await port().createUploadTarget('products/p1/i1/original.png', 'image/png')
    const url = new URL(t.uploadUrl)
    expect(url.hostname).toContain('test-bucket')
    expect(url.pathname).toBe('/products/p1/i1/original.png')
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(UPLOAD_URL_TTL_SECONDS))
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type')
    expect(t.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 899_000)
    expect(UPLOAD_URL_TTL_SECONDS).toBe(900)
  })

  it('stats size and type from HEAD and true dimensions from a ranged GET', async () => {
    s3.on(HeadObjectCommand).resolves({ ContentLength: PNG_1X1.length, ContentType: 'image/png' })
    s3.on(GetObjectCommand).resolves({ Body: body(PNG_1X1) as any })
    const st = await port().stat('products/p1/i1/original.png')
    expect(st).toEqual({ width: 1, height: 1, byteSize: PNG_1X1.length, contentType: 'image/png' })
    const get = s3.commandCalls(GetObjectCommand)[0].args[0].input
    expect(get.Range).toBe('bytes=0-65535')
  })

  it('returns null for a missing object', async () => {
    s3.on(HeadObjectCommand).rejects(new NotFound({ message: 'nf', $metadata: {} }))
    expect(await port().stat('missing')).toBeNull()
  })

  it('reports 0x0 for bytes that are not an image', async () => {
    const junk = Buffer.from('definitely not an image')
    s3.on(HeadObjectCommand).resolves({ ContentLength: junk.length, ContentType: 'image/png' })
    s3.on(GetObjectCommand).resolves({ Body: body(junk) as any })
    expect(await port().stat('k')).toMatchObject({ width: 0, height: 0 })
  })

  it('deletes, and treats an absent object as success', async () => {
    s3.on(DeleteObjectCommand).resolves({})
    await port().delete('k')
    expect(s3.commandCalls(DeleteObjectCommand)[0].args[0].input).toEqual({ Bucket: 'test-bucket', Key: 'k' })
  })

  it('surfaces other delete errors', async () => {
    s3.on(DeleteObjectCommand).rejects(new Error('AccessDenied'))
    await expect(port().delete('k')).rejects.toThrow('AccessDenied')
  })
})
```
If `@smithy/util-stream` is not resolvable as a direct import, add it as a dev dependency (it is already in the tree through the AWS SDK).

- [ ] **Step 3: Run to see it fail.** `npx vitest run tests/storage-s3-adapter.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 4: Implement `src/ports/storage/s3.adapter.ts`**

```ts
import {
  S3Client, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand, PutObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { imageSize } from 'image-size'
import type { AssetStoragePort, StoredObject, UploadTarget } from './storage.port.js'

export const UPLOAD_URL_TTL_SECONDS = 900
const HEADER_BYTES = 65_536

export interface S3StorageConfig {
  bucket: string; region: string; accessKeyId: string; secretAccessKey: string
}

function dimensions(buf: Uint8Array): { width: number; height: number } | null {
  try {
    const d = imageSize(buf)
    return d.width && d.height ? { width: d.width, height: d.height } : null
  } catch {
    return null
  }
}

const isNotFound = (e: any) => e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404

/**
 * Private S3 bucket behind imgix (ADR-0002, decided 2026-09-25).
 *
 * stat() reads size and type from HEAD, then only the first 64 KB to find the
 * true dimensions. It never downloads a whole 15 MB photo unless the header
 * is somehow beyond that, which is the fallback. Bytes image-size cannot parse
 * report 0x0, and confirm rejects that as not_an_image.
 */
export function createS3StoragePort(config: S3StorageConfig, client?: S3Client): AssetStoragePort {
  const s3 = client ?? new S3Client({
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  })
  const Bucket = config.bucket

  async function readBytes(Key: string, Range?: string): Promise<Uint8Array> {
    const res = await s3.send(new GetObjectCommand({ Bucket, Key, ...(Range ? { Range } : {}) }))
    return res.Body ? await (res.Body as any).transformToByteArray() : new Uint8Array()
  }

  return {
    async createUploadTarget(key: string, contentType: string): Promise<UploadTarget> {
      const uploadUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }),
        { expiresIn: UPLOAD_URL_TTL_SECONDS, signableHeaders: new Set(['content-type']) },
      )
      return { uploadUrl, expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000) }
    },

    async stat(key: string): Promise<StoredObject | null> {
      let head
      try {
        head = await s3.send(new HeadObjectCommand({ Bucket, Key: key }))
      } catch (e) {
        if (isNotFound(e)) return null
        throw e
      }
      const byteSize = head.ContentLength ?? 0
      let dims = dimensions(await readBytes(key, `bytes=0-${HEADER_BYTES - 1}`))
      if (!dims && byteSize > HEADER_BYTES) dims = dimensions(await readBytes(key))
      return {
        width: dims?.width ?? 0,
        height: dims?.height ?? 0,
        byteSize,
        contentType: head.ContentType ?? 'application/octet-stream',
      }
    },

    async delete(key: string): Promise<void> {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket, Key: key }))
      } catch (e) {
        if (!isNotFound(e)) throw e
      }
    },
  }
}
```
If the `X-Amz-SignedHeaders` assertion fails because the presigner hoists `content-type` into the query string, keep `signableHeaders` and adjust only the assertion to check that `content-type` is either signed or present as a query parameter. The requirement is that a PUT with a different content type fails the signature. Note in the report which one applies.

- [ ] **Step 5: Run the adapter test.** Expected: PASS.

- [ ] **Step 6: Write the failing selection test**

```ts
// tests/storage-selection.test.ts
import { describe, it, expect } from 'vitest'
import { createStoragePort } from '../src/ports/storage/index.js'

const FULL = {
  ASSET_STORAGE: 's3', ASSET_S3_BUCKET: 'b', ASSET_S3_REGION: 'us-west-2',
  ASSET_S3_ACCESS_KEY_ID: 'a', ASSET_S3_SECRET_ACCESS_KEY: 's',
}

describe('createStoragePort', () => {
  it('uses local storage when ASSET_STORAGE is unset', () => {
    expect(() => createStoragePort({})).not.toThrow()
  })
  it('builds an S3 port when fully configured', () => {
    const p = createStoragePort(FULL)
    expect(typeof p.createUploadTarget).toBe('function')
  })
  it('refuses to start half-configured, naming every missing key', () => {
    const { ASSET_S3_BUCKET, ASSET_S3_SECRET_ACCESS_KEY, ...partial } = FULL
    expect(() => createStoragePort(partial)).toThrow(/ASSET_S3_BUCKET.*ASSET_S3_SECRET_ACCESS_KEY/)
  })
  it('rejects an unknown ASSET_STORAGE value', () => {
    expect(() => createStoragePort({ ASSET_STORAGE: 'r2' })).toThrow(/ASSET_STORAGE/)
  })
})
```
Run it and see it FAIL (module not found).

- [ ] **Step 7: Implement `src/ports/storage/index.ts` and wire `app.ts`**

```ts
import type { AssetStoragePort } from './storage.port.js'
import { createLocalStoragePort } from './local.adapter.js'
import { createS3StoragePort } from './s3.adapter.js'

const S3_KEYS = ['ASSET_S3_BUCKET', 'ASSET_S3_REGION', 'ASSET_S3_ACCESS_KEY_ID', 'ASSET_S3_SECRET_ACCESS_KEY'] as const

/**
 * Picks the storage adapter at startup. S3 with any setting missing throws,
 * naming each key: a deploy that meant to use S3 must never silently write
 * to a filesystem Render wipes on the next deploy.
 */
export function createStoragePort(env: NodeJS.ProcessEnv = process.env): AssetStoragePort {
  const kind = env.ASSET_STORAGE
  if (!kind) {
    return createLocalStoragePort(
      env.ASSET_STORAGE_DIR ?? './var/assets',
      env.ASSET_PUBLIC_BASE_URL ?? 'http://localhost:4000/assets',
    )
  }
  if (kind !== 's3') throw new Error(`ASSET_STORAGE must be "s3" or unset, got "${kind}"`)
  const missing = S3_KEYS.filter((k) => !env[k])
  if (missing.length) throw new Error(`ASSET_STORAGE=s3 but missing: ${missing.join(', ')}`)
  return createS3StoragePort({
    bucket: env.ASSET_S3_BUCKET!, region: env.ASSET_S3_REGION!,
    accessKeyId: env.ASSET_S3_ACCESS_KEY_ID!, secretAccessKey: env.ASSET_S3_SECRET_ACCESS_KEY!,
  })
}
```
In `app.ts`, replace the `createLocalStoragePort(...)` block and its "until a CDN provider is chosen" comment with `const storagePort = createStoragePort()`, and swap the import. Run `tests/storage-selection.test.ts`. Expected: PASS.

- [ ] **Step 8: `render.yaml`**

In `envVarGroups.core-env`, next to `ASSET_PUBLIC_BASE_URL`, add `sync: false` keys `ASSET_STORAGE`, `ASSET_S3_BUCKET`, `ASSET_S3_REGION`, and extend the "Secrets are NEVER declared here" comment list with `ASSET_S3_ACCESS_KEY_ID, ASSET_S3_SECRET_ACCESS_KEY`. Replace the `ASSET_PUBLIC_BASE_URL` comment that says image upload does not work with: "imgix source domain for this environment (e.g. https://alpinebrick-staging.imgix.net). See docs/status/2026-09-25-image-storage-setup-runbook.md". Add `- key: VITE_ASSET_BASE_URL` / `sync: false` to the `envVars` of both `storefront` and `admin-ui`, with a one-line comment: the imgix domain, baked in at build time. Validate the YAML parses (e.g. `node -e "require('yaml').parse(require('fs').readFileSync('render.yaml','utf8'))"` with `yaml` available, or `npx -y yaml valid < render.yaml`).

- [ ] **Step 9: Full suite, types, commit**

`npx vitest run && npx tsc --noEmit`. Expected: PASS.
```bash
git add systems/core render.yaml
git commit -m "feat(core): S3 storage adapter selected by ASSET_STORAGE; refuse a half-configured start"
```

---

## Task 3: Stricter confirm, SVG removed

**Files:**
- Modify: `systems/core/src/assets/image.service.ts` (`EXT_BY_CONTENT_TYPE`, `confirmUpload`)
- Modify: `systems/core/src/assets/assets.routes.ts` (`STATUS_BY_CODE`)
- Modify: `systems/core/tests/image-service.test.ts`
- Test: `systems/core/tests/image-confirm-hardening.test.ts`

**Interfaces:**
- Consumes: `AssetStoragePort` (Task 2 is unrelated; the tests use a fake port).
- Produces: `confirmUpload(port, imageId, actorId)` now throws `ImageError` with `upload_too_large` | `upload_mismatch` | `not_an_image`, after deleting the object and the row. It returns the row unchanged when already `ready`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/image-confirm-hardening.test.ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import type { AssetStoragePort, StoredObject } from '../src/ports/storage/storage.port.js'
import { requestUpload, confirmUpload, MAX_UPLOAD_BYTES, ImageError } from '../src/assets/image.service.js'

function port(obj: StoredObject | null): AssetStoragePort & { delete: ReturnType<typeof vi.fn> } {
  return {
    createUploadTarget: vi.fn(async (key: string) => ({ uploadUrl: `https://u.test/${key}`, expiresAt: new Date(Date.now() + 60_000) })),
    stat: vi.fn(async () => obj),
    delete: vi.fn(async () => {}),
  } as any
}

let actorId: string
let productId: string
beforeEach(async () => {
  await resetDb()
  actorId = (await prisma.actor.create({ data: { type: 'human', name: 't' } })).id
  productId = (await prisma.product.create({ data: { slug: 'p', name: 'P', productType: 'resale' } })).id
})
afterAll(() => prisma.$disconnect())

async function pending(byteSize = 5000, contentType = 'image/jpeg') {
  return requestUpload(port(null), { productId, contentType, byteSize }, actorId)
}

describe.each([
  ['upload_too_large', { width: 10, height: 10, byteSize: MAX_UPLOAD_BYTES + 1, contentType: 'image/jpeg' }, MAX_UPLOAD_BYTES + 1],
  ['upload_mismatch', { width: 10, height: 10, byteSize: 9999, contentType: 'image/jpeg' }, 5000],
  ['upload_mismatch', { width: 10, height: 10, byteSize: 5000, contentType: 'image/png' }, 5000],
  ['not_an_image', { width: 0, height: 0, byteSize: 5000, contentType: 'image/jpeg' }, 5000],
] as const)('confirm rejects %s', (code, obj, declared) => {
  it('deletes the object and the row, audits the rejection, and throws', async () => {
    const r = await pending(Math.min(declared, MAX_UPLOAD_BYTES))
    if (declared > MAX_UPLOAD_BYTES) {
      await prisma.image.update({ where: { id: r.imageId }, data: { byteSize: declared } })
    }
    const p = port(obj)
    await expect(confirmUpload(p, r.imageId, actorId)).rejects.toMatchObject({ code })
    expect(p.delete).toHaveBeenCalledWith(r.storageKey)
    expect(await prisma.image.findUnique({ where: { id: r.imageId } })).toBeNull()
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'image.upload.reject' } })
    expect(audit.after).toMatchObject({ code })
  })
})

describe('confirm', () => {
  it('is a no-op for an image that is already ready', async () => {
    const r = await pending()
    const ok = port({ width: 800, height: 600, byteSize: 5000, contentType: 'image/jpeg' })
    await confirmUpload(ok, r.imageId, actorId)
    const again = await confirmUpload(ok, r.imageId, actorId)
    expect(again.width).toBe(800)
    expect(await prisma.auditLog.count({ where: { action: 'image.upload.confirm' } })).toBe(1)
  })

  it('refuses SVG at upload-token time', async () => {
    await expect(pending(100, 'image/svg+xml')).rejects.toMatchObject({ code: 'unsupported_content_type' })
    expect(await prisma.image.count()).toBe(0)
  })
})
```
In `tests/image-service.test.ts`, make sure no existing case uploads `image/svg+xml` as a *valid* type; change any that does to `image/png`.

- [ ] **Step 2: Run to see it fail.** `npx vitest run tests/image-confirm-hardening.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

In `image.service.ts`, delete the `'image/svg+xml': 'svg'` entry and add a comment above the map: "SVG is not accepted: an SVG served publicly can carry script, and product photos never need it (spec 2026-09-25 §4.2)."

Rewrite `confirmUpload`:
```ts
export async function confirmUpload(port: AssetStoragePort, imageId: string, actorId: string): Promise<ImageDto> {
  const row = await prisma.image.findUnique({ where: { id: imageId } })
  if (!row) throw new ImageError('image_not_found', 'image not found')
  // A retried click after success must not re-verify or re-audit.
  if (row.status === 'ready') return toDto(row)

  // Storage I/O first, outside any transaction (as before).
  const stat = await port.stat(row.storageKey)
  if (!stat) throw new ImageError('object_missing', 'no object was uploaded for this image')

  // The signed URL let the browser put ANY bytes at this key. Verify them.
  const rejection =
    stat.byteSize > MAX_UPLOAD_BYTES ? { code: 'upload_too_large', message: `file exceeds ${MAX_UPLOAD_BYTES} bytes` }
    : stat.byteSize !== row.byteSize || stat.contentType !== row.contentType
      ? { code: 'upload_mismatch', message: 'the uploaded file does not match what was declared; please upload it again' }
    : stat.width === 0 || stat.height === 0 ? { code: 'not_an_image', message: 'the uploaded file is not a readable JPEG, PNG or WebP image' }
    : null

  if (rejection) {
    await port.delete(row.storageKey)
    await prisma.$transaction(async (tx) => {
      await tx.image.delete({ where: { id: imageId } })
      await recordAudit({
        actorId, action: 'image.upload.reject', target: `image:${imageId}`,
        before: { status: row.status, byteSize: row.byteSize, contentType: row.contentType },
        after: { code: rejection.code, byteSize: stat.byteSize, contentType: stat.contentType, width: stat.width, height: stat.height },
      }, tx)
    })
    throw new ImageError(rejection.code, rejection.message)
  }

  // (existing transaction: update to ready + image.upload.confirm audit, unchanged)
```
Keep the existing success transaction below exactly as it is.

In `assets.routes.ts`, add `upload_too_large: 413`, `upload_mismatch: 409` and `not_an_image: 422` to `STATUS_BY_CODE`.

- [ ] **Step 4: Run and commit**

`npx vitest run tests/image-confirm-hardening.test.ts tests/image-service.test.ts tests/assets-routes.test.ts`. Expected: PASS. Then the full suite and `npx tsc --noEmit`.
```bash
git add systems/core
git commit -m "feat(core): confirm verifies the uploaded object and rejects mismatches; SVG no longer accepted"
```

---

## Task 4: Per-product sweep of abandoned uploads

**Files:**
- Modify: `systems/core/src/assets/image.service.ts` (`sweepPendingImages`, `requestUpload`)
- Modify: `systems/core/tests/image-service.test.ts` (sweep describe)

**Interfaces:**
- Produces: `sweepPendingImages(port, olderThan: Date, productId?: string): Promise<number>`; `PENDING_TTL_MS = 24 * 3600 * 1000`.

- [ ] **Step 1: Write the failing tests** (append to the `sweepPendingImages` describe)

```ts
  it('scopes the sweep to one product when asked', async () => {
    const a = await makeProduct('a'); const b = await makeProduct('b')
    const port = fakePort()
    const ra = await requestUpload(port, { productId: a.id, contentType: 'image/jpeg', byteSize: 1 }, actorId)
    const rb = await requestUpload(port, { productId: b.id, contentType: 'image/jpeg', byteSize: 1 }, actorId)
    await prisma.image.updateMany({ data: { createdAt: new Date(Date.now() - 48 * 3600 * 1000) } })
    expect(await sweepPendingImages(fakePort(), new Date(Date.now() - 24 * 3600 * 1000), a.id)).toBe(1)
    expect(await prisma.image.findUnique({ where: { id: ra.imageId } })).toBeNull()
    expect(await prisma.image.findUnique({ where: { id: rb.imageId } })).not.toBeNull()
  })

  it('keeps sweeping when one object delete fails', async () => {
    const p = await makeProduct()
    const port = fakePort()
    await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 }, actorId)
    await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 }, actorId)
    await prisma.image.updateMany({ data: { createdAt: new Date(Date.now() - 48 * 3600 * 1000) } })
    const flaky = fakePort()
    ;(flaky.delete as any).mockRejectedValueOnce(new Error('S3 down'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await sweepPendingImages(flaky, new Date(Date.now() - 24 * 3600 * 1000), p.id)).toBe(2)
    expect(await prisma.image.count({ where: { status: 'pending' } })).toBe(0)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('requestUpload sweeps that product\'s stale pending uploads first', async () => {
    const p = await makeProduct()
    const port = fakePort()
    const old = await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 }, actorId)
    await prisma.image.update({ where: { id: old.imageId }, data: { createdAt: new Date(Date.now() - 48 * 3600 * 1000) } })
    await requestUpload(port, { productId: p.id, contentType: 'image/jpeg', byteSize: 1 }, actorId)
    expect(await prisma.image.findUnique({ where: { id: old.imageId } })).toBeNull()
    expect(port.delete).toHaveBeenCalledWith(old.storageKey)
  })
```

- [ ] **Step 2: Run to see them fail.** Expected: FAIL (third argument ignored; no sweep in `requestUpload`).

- [ ] **Step 3: Implement**

```ts
export const PENDING_TTL_MS = 24 * 3600 * 1000

export async function sweepPendingImages(port: AssetStoragePort, olderThan: Date, productId?: string): Promise<number> {
  const stale = await prisma.image.findMany({
    where: { status: 'pending', createdAt: { lt: olderThan }, ...(productId ? { productId } : {}) },
  })
  for (const row of stale) {
    // Row first, so a failed object delete leaves an orphaned object (harmless,
    // unreferenced) rather than a row pointing at nothing.
    await prisma.image.delete({ where: { id: row.id } })
    try {
      await port.delete(row.storageKey)
    } catch (e) {
      console.error(`images: sweep could not delete object ${row.storageKey}:`, e)
    }
  }
  return stale.length
}
```
At the top of `requestUpload`, after the input validation and the product lookup (so an invalid request sweeps nothing), add:
```ts
  // No scheduler in core: abandoned uploads are cleared on real activity (spec §4.4).
  await sweepPendingImages(port, new Date(Date.now() - PENDING_TTL_MS), input.productId)
```
Update the ADR-0002 "Known limitations" bullet about `sweepPendingImages` having no caller: it now runs per product on each upload request.

- [ ] **Step 4: Image ids in the admin product view**

The console's reorder, alt and delete calls need each image's `id`, and `loadAdminProduct` (`systems/core/src/admin/admin-product.dto.ts`, `images.map`) omits it. In `tests/admin-product-dto.test.ts`, add a test that creates a `ready` image row for a product (`prisma.image.create({ data: { productId, storageKey: 'products/x/y/original.png', position: 0, width: 1, height: 1, contentType: 'image/png', byteSize: 1, status: 'ready' } })`) and asserts `loadAdminProduct(id).images[0].id` equals the row id. Watch it fail, then add `id: i.id` to the admin mapping only. The public `ProductDto` is unchanged: the storefront never needs image ids. Since the admin DTO type is `Omit<ProductDto, 'variants'> & …`, override its `images` element type to include `id: string`.

- [ ] **Step 5: Run and commit**

`npx vitest run tests/image-service.test.ts tests/admin-product-dto.test.ts`, then the full suite and `npx tsc --noEmit`. Expected: PASS.
```bash
git add systems/core docs/adr/0002-image-cdn-asset-delivery.md
git commit -m "feat(core): sweep abandoned uploads per product; admin product view carries image ids"
```

---

## Task 5: Core verification, fixtures, setup runbook

**Files:**
- Modify: `systems/core/tests/capture-admin-fixtures.test.ts` (add image fixtures)
- Create: `systems/admin-ui/src/data/__fixtures__/image-upload-token.json`, `image-confirmed.json`, `image-rejected.json`
- Create: `docs/status/2026-09-25-image-storage-setup-runbook.md`
- Modify: `docs/adr/0002-image-cdn-asset-delivery.md` (status: ACCEPTED; decision recorded)

- [ ] **Step 1: Extend the fixture capture**

Inside the existing `it('captures', …)` in `capture-admin-fixtures.test.ts`, after the product is created, add the following. It runs with the local adapter, so the object is written straight to the local storage dir the app uses.
```ts
    const tok = (await send('post', '/images/upload-token', { productId: p.id, contentType: 'image/png', byteSize: PNG_1X1.length })).body
    save('image-upload-token', tok)
    const dir = process.env.ASSET_STORAGE_DIR ?? './var/assets'
    mkdirSync(dirname(resolve(dir, tok.storageKey)), { recursive: true })
    writeFileSync(resolve(dir, tok.storageKey), PNG_1X1)
    save('image-confirmed', (await send('post', `/images/${tok.imageId}/confirm`, {})).body)
    const bad = (await send('post', '/images/upload-token', { productId: p.id, contentType: 'image/png', byteSize: 999 })).body
    mkdirSync(dirname(resolve(dir, bad.storageKey)), { recursive: true })
    writeFileSync(resolve(dir, bad.storageKey), PNG_1X1)
    save('image-rejected', (await send('post', `/images/${bad.imageId}/confirm`, {})).body)
```
Add the `PNG_1X1` constant (same base64 as `storage-local-adapter.test.ts`) and `dirname` / `mkdirSync` imports. Note that the image routes are mounted at `/api/v1/admin/images`, so the `send` helper's `/api/v1/admin` prefix plus `/images/...` is correct. Run `CAPTURE_ADMIN_FIXTURES=1 npx vitest run tests/capture-admin-fixtures.test.ts`. Check that `image-rejected.json` has `code: "upload_mismatch"` and `image-confirmed.json` has `width: 1, height: 1`. Delete the files the capture wrote under the local storage dir afterwards.

- [ ] **Step 2: Write the setup runbook** `docs/status/2026-09-25-image-storage-setup-runbook.md`

It must contain, verbatim and complete:
1. **Who:** Jack, signed in as `alpinebrick@gmail.com`, for AWS and imgix. Card details and secret keys are never pasted into chat or Discord.
2. **AWS account** creation, then region **us-west-2**.
3. **Two buckets:** `alpinebrick-images-staging` and `alpinebrick-images-prod`. Object Ownership: bucket owner enforced. **Block all public access: ON.** Versioning off, default encryption SSE-S3.
4. **CORS** (bucket → Permissions → CORS), staging:
```json
[
  {
    "AllowedOrigins": ["https://admin-staging.alpinebrickexchange.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3000
  }
]
```
   For prod, the same rule with `https://admin.alpinebrickexchange.com`.
5. **IAM policy `alpinebrick-core-images-staging`** (and a `-prod` twin with the bucket name swapped):
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
    "Resource": "arn:aws:s3:::alpinebrick-images-staging/products/*"
  }]
}
```
6. **IAM policy `alpinebrick-imgix-read-staging`** (and a `-prod` twin):
```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:GetObject"], "Resource": "arn:aws:s3:::alpinebrick-images-staging/*" },
    { "Effect": "Allow", "Action": ["s3:ListBucket", "s3:GetBucketLocation"], "Resource": "arn:aws:s3:::alpinebrick-images-staging" }
  ]
}
```
7. **IAM users** `alpinebrick-core-staging` and `alpinebrick-imgix-staging`, each with its policy attached. Create an access key for each (use case: "Application running outside AWS").
8. **imgix:** create the account and choose **Starter**. Create an **Amazon S3** source named `alpinebrick-staging`: bucket `alpinebrick-images-staging`, the imgix user's key, domain `alpinebrick-staging.imgix.net`. Set Default Cache TTL to the maximum offered. Leave custom domains alone for now.
9. **Render** (staging `core-env`, set by hand on the group page, because the Blueprint does not create `sync: false` keys in groups):
   - `ASSET_STORAGE=s3`, `ASSET_S3_BUCKET=alpinebrick-images-staging`, `ASSET_S3_REGION=us-west-2`
   - `ASSET_S3_ACCESS_KEY_ID` and `ASSET_S3_SECRET_ACCESS_KEY` (core user, pasted by Jack)
   - `ASSET_PUBLIC_BASE_URL=https://alpinebrick-staging.imgix.net`
   - storefront and admin-ui: `VITE_ASSET_BASE_URL=https://alpinebrick-staging.imgix.net`

   Save with "Save, rebuild, and deploy".
10. **Verify:**
    - `api-staging` `/health` returns ok, and the deploy log shows no `ASSET_STORAGE=s3 but missing` error.
    - The admin console's Images tab uploads.
    - `https://alpinebrick-staging.imgix.net/<key>?w=400` returns an image.
    - The raw S3 object URL returns 403. That's correct: the bucket is private.

Also update ADR-0002: Status → **ACCEPTED (2026-09-25)**. Add a short "Decided — 2026-09-25" section: imgix Starter in front of private S3 (us-west-2), owned by `alpinebrick@gmail.com`, per the 2026-09-25 spec. Remove "CDN / origin host" from "Still open".

- [ ] **Step 3: Full verification**

In `systems/core`: `npx vitest run && npx tsc --noEmit && npm run build`, then `PORT=4099 node dist/server.js & sleep 3; curl -s localhost:4099/health; kill %1`. Expected: all pass, `{"status":"ok"}`, and the process stopped (check that port 4099 is free). In `systems/storefront/code`: `npx vitest run && npm run build`.

- [ ] **Step 4: Commit (push and PR only after Jack's OK)**
```bash
git add systems/core/tests/capture-admin-fixtures.test.ts systems/admin-ui/src/data/__fixtures__ docs
git commit -m "docs: image storage setup runbook; ADR-0002 accepted; capture image fixtures"
```

---

## Task 6: Console image API methods

**Files:**
- Branch: `git checkout main && git pull --ff-only && git checkout -b feat/image-upload-console` (after the core PR merges)
- Modify: `systems/admin-ui/src/data/api.js`
- Test: `systems/admin-ui/src/data/api.images.test.js`

**Interfaces:**
- Produces:
  - `api.requestImageUpload(productId, file)` → `{ imageId, storageKey, uploadUrl, expiresAt }` (sends `{ productId, contentType: file.type, byteSize: file.size }`)
  - `api.uploadToStorage(uploadUrl, file, onProgress?)` → `Promise<void>`. Uses XHR PUT with `Content-Type: file.type`, **without** credentials. It rejects with `AdminApiError('The upload to storage failed. Please try again.', 'UPLOAD_FAILED')` on a non-2xx or network error, and calls `onProgress(fraction 0..1)`.
  - `api.confirmImage(imageId)` → image DTO
  - `api.reorderImages(productId, orderedIds)` → `{ ok: true }`
  - `api.updateImageAlt(imageId, alt)` → image DTO
  - `api.deleteImage(imageId)` → `null`
  - The four `notImplemented` stubs and the `notImplemented` helper are removed.

- [ ] **Step 1: Write the failing tests**

```js
// src/data/api.images.test.js
import { describe, it, expect, vi, afterEach } from 'vitest'
import api from './api.js'
import token from './__fixtures__/image-upload-token.json'
import confirmed from './__fixtures__/image-confirmed.json'
import rejected from './__fixtures__/image-rejected.json'

function spyFetch(status, body) {
  const spy = vi.fn(async () => ({ ok: status < 400, status, json: async () => body }))
  vi.stubGlobal('fetch', spy)
  return spy
}
afterEach(() => vi.unstubAllGlobals())
const call = (spy) => ({ url: String(spy.mock.calls[0][0]), init: spy.mock.calls[0][1] })

describe('image methods hit core', () => {
  it('requests an upload slot with the file type and size', async () => {
    const spy = spyFetch(201, token)
    const file = new File([new Uint8Array(70)], 'a.png', { type: 'image/png' })
    expect(await api.requestImageUpload('p1', file)).toEqual(token)
    const { url, init } = call(spy)
    expect(url.endsWith('/api/v1/admin/images/upload-token')).toBe(true)
    expect(JSON.parse(init.body)).toEqual({ productId: 'p1', contentType: 'image/png', byteSize: 70 })
  })
  it.each([
    ['confirmImage', () => api.confirmImage('i1'), 'POST', '/images/i1/confirm'],
    ['reorderImages', () => api.reorderImages('p1', ['a', 'b']), 'PUT', '/images/reorder'],
    ['updateImageAlt', () => api.updateImageAlt('i1', 'Front'), 'PATCH', '/images/i1'],
    ['deleteImage', () => api.deleteImage('i1'), 'DELETE', '/images/i1'],
  ])('%s', async (_n, invoke, method, path) => {
    const spy = spyFetch(200, confirmed)
    await invoke()
    const { url, init } = call(spy)
    expect(url.endsWith(`/api/v1/admin${path}`)).toBe(true)
    expect(init.method).toBe(method)
  })
  it('surfaces core\'s lower_snake image error with its message', async () => {
    spyFetch(409, rejected)
    await expect(api.confirmImage('i1')).rejects.toMatchObject({ code: rejected.code, message: rejected.message })
  })
})

describe('uploadToStorage', () => {
  function fakeXhr(status) {
    const x = {
      upload: {}, headers: {}, withCredentials: undefined,
      open: vi.fn(), setRequestHeader: vi.fn((k, v) => { x.headers[k] = v }),
      send: vi.fn(() => { x.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 }); x.status = status; x.onload() }),
    }
    vi.stubGlobal('XMLHttpRequest', vi.fn(() => x))
    return x
  }
  it('PUTs the file with its content type, no credentials, reporting progress', async () => {
    const x = fakeXhr(200)
    const progress = vi.fn()
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' })
    await api.uploadToStorage('https://s3.test/k?sig', file, progress)
    expect(x.open).toHaveBeenCalledWith('PUT', 'https://s3.test/k?sig')
    expect(x.headers['Content-Type']).toBe('image/jpeg')
    expect(x.withCredentials).toBe(false)
    expect(progress).toHaveBeenCalledWith(0.5)
  })
  it('rejects on a non-2xx from storage', async () => {
    fakeXhr(403)
    await expect(api.uploadToStorage('u', new File(['x'], 'a.jpg', { type: 'image/jpeg' })))
      .rejects.toMatchObject({ code: 'UPLOAD_FAILED' })
  })
})
```
If a retargeted test in `api.test.js` asserts that the image methods throw `NOT_IMPLEMENTED`, delete that case. No unimplemented methods remain.

- [ ] **Step 2: Run to see it fail.** `npx vitest run src/data/api.images.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement in `api.js`**

Remove `notImplemented` and its comment block. Replace the four stub lines with:
```js
  async requestImageUpload(productId, file) {
    return call('/images/upload-token', {
      method: 'POST',
      body: JSON.stringify({ productId, contentType: file.type, byteSize: file.size }),
    })
  },

  /**
   * Direct PUT to the presigned S3 URL. XHR rather than fetch, for upload
   * progress. No cookies: this goes to S3, not core.
   */
  uploadToStorage(uploadUrl, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('PUT', uploadUrl)
      xhr.withCredentials = false
      xhr.setRequestHeader('Content-Type', file.type)
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total) }
      const failed = () => reject(new AdminApiError('The upload to storage failed. Please try again.', 'UPLOAD_FAILED'))
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : failed())
      xhr.onerror = failed
      xhr.send(file)
    })
  },

  async confirmImage(imageId) {
    return call(`/images/${encodeURIComponent(imageId)}/confirm`, { method: 'POST', body: '{}' })
  },
  async reorderImages(productId, orderedIds) {
    return call('/images/reorder', { method: 'PUT', body: JSON.stringify({ productId, orderedIds }) })
  },
  async updateImageAlt(imageId, alt) {
    return call(`/images/${encodeURIComponent(imageId)}`, { method: 'PATCH', body: JSON.stringify({ alt }) })
  },
  async deleteImage(imageId) {
    return call(`/images/${encodeURIComponent(imageId)}`, { method: 'DELETE', body: '{}' })
  },
```

- [ ] **Step 4: Run and commit.** Run the console suite. Expected: PASS.
```bash
git add systems/admin-ui/src
git commit -m "feat(admin-ui): image upload, confirm, reorder, alt and delete wired to core"
```

---

## Task 7: Images tab — upload

**Files:**
- Create: `systems/admin-ui/src/catalog/tabs/imageFiles.js`
- Rewrite: `systems/admin-ui/src/catalog/tabs/ImagesTab.jsx` (the upload part; Task 8 adds the per-photo controls)
- Test: `systems/admin-ui/src/catalog/images-upload.test.jsx`

**Interfaces:**
- Consumes: Task 6 methods; `api.getProduct(id)`; `errorText(err)`; props `{ product, onUpdated }`.
- Produces: `checkImageFile(file) → null | string` (a reason); `ACCEPTED_TYPES`; `MAX_IMAGE_BYTES = 15 * 1024 * 1024`.

- [ ] **Step 1: Write the failing tests**

```jsx
// src/catalog/images-upload.test.jsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../ui/toast.jsx'
import ImagesTab from './tabs/ImagesTab.jsx'
import { checkImageFile, MAX_IMAGE_BYTES } from './tabs/imageFiles.js'
import product from '../data/__fixtures__/product.json'
import token from '../data/__fixtures__/image-upload-token.json'
import confirmed from '../data/__fixtures__/image-confirmed.json'
import { AdminApiError } from '../data/errors.js'

vi.mock('../data/api.js', () => ({ default: {
  requestImageUpload: vi.fn(), uploadToStorage: vi.fn(), confirmImage: vi.fn(), getProduct: vi.fn(),
  reorderImages: vi.fn(), updateImageAlt: vi.fn(), deleteImage: vi.fn(),
} }))
import api from '../data/api.js'
afterEach(() => vi.clearAllMocks())

const png = (name, size = 10) => new File([new Uint8Array(size)], name, { type: 'image/png' })
const renderTab = (onUpdated = vi.fn()) =>
  render(<ToastProvider><ImagesTab product={{ ...product, images: [] }} onUpdated={onUpdated} /></ToastProvider>)

describe('checkImageFile', () => {
  it('accepts JPEG/PNG/WebP up to 15 MB and names the reason otherwise', () => {
    expect(checkImageFile(png('a.png'))).toBeNull()
    expect(checkImageFile(new File(['x'], 'a.svg', { type: 'image/svg+xml' }))).toMatch(/JPEG, PNG or WebP/)
    expect(checkImageFile(png('big.png', MAX_IMAGE_BYTES + 1))).toMatch(/15 MB/)
  })
})

describe('ImagesTab upload', () => {
  it('runs token → PUT → confirm per file and refreshes the product', async () => {
    vi.mocked(api.requestImageUpload).mockResolvedValue(token)
    vi.mocked(api.uploadToStorage).mockResolvedValue()
    vi.mocked(api.confirmImage).mockResolvedValue(confirmed)
    vi.mocked(api.getProduct).mockResolvedValue({ ...product, images: [confirmed] })
    const onUpdated = vi.fn()
    renderTab(onUpdated)
    await userEvent.upload(screen.getByLabelText('Add photos'), [png('a.png')])
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ images: [confirmed] })))
    expect(api.uploadToStorage).toHaveBeenCalledWith(token.uploadUrl, expect.any(File), expect.any(Function))
    expect(api.confirmImage).toHaveBeenCalledWith(token.imageId)
  })

  it('never sends a file that fails the client check', async () => {
    renderTab()
    await userEvent.upload(screen.getByLabelText('Add photos'), [new File(['x'], 'logo.svg', { type: 'image/svg+xml' })], { applyAccept: false })
    expect(await screen.findByText(/logo\.svg/)).toBeInTheDocument()
    expect(api.requestImageUpload).not.toHaveBeenCalled()
  })

  it('one failing file shows core\'s message and Retry; the others finish', async () => {
    vi.mocked(api.requestImageUpload).mockResolvedValue(token)
    vi.mocked(api.uploadToStorage).mockResolvedValue()
    vi.mocked(api.confirmImage)
      .mockRejectedValueOnce(new AdminApiError('the uploaded file does not match what was declared; please upload it again', 'upload_mismatch'))
      .mockResolvedValue(confirmed)
    vi.mocked(api.getProduct).mockResolvedValue({ ...product, images: [confirmed] })
    renderTab()
    await userEvent.upload(screen.getByLabelText('Add photos'), [png('bad.png'), png('good.png')])
    expect(await screen.findByText(/does not match what was declared/)).toBeInTheDocument()
    expect(api.confirmImage).toHaveBeenCalledTimes(2)
    await userEvent.click(screen.getByRole('button', { name: /retry bad\.png/i }))
    await waitFor(() => expect(api.requestImageUpload).toHaveBeenCalledTimes(3))
  })
})
```

- [ ] **Step 2: Run to see it fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

`tabs/imageFiles.js`:
```js
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024

/** Mirrors core's accepted types and ceiling (image.service.ts). null = OK. */
export function checkImageFile(file) {
  if (!ACCEPTED_TYPES.includes(file.type)) return `${file.name}: only JPEG, PNG or WebP photos can be uploaded`
  if (file.size > MAX_IMAGE_BYTES) return `${file.name}: larger than 15 MB`
  return null
}
```
`ImagesTab.jsx` (upload section; keep the existing grid for Task 8):
- Remove the "not in this phase" banner and the disabled button.
- Render a visible `<label htmlFor="images-add">Add photos</label>` and `<input id="images-add" type="file" multiple accept="image/jpeg,image/png,image/webp" />`, plus a drop area that feeds the same handler (`onDragOver` preventDefault, `onDrop` → `e.dataTransfer.files`).
- State `uploads: [{ id, file, stage: 'waiting'|'uploading'|'confirming'|'done'|'error', progress, error }]`. For each selected file: if `checkImageFile(file)` returns a reason, add an `error` entry with that reason and no network call. Otherwise run the pipeline:
```js
async function runUpload(u) {
  update(u.id, { stage: 'uploading', progress: 0, error: null })
  try {
    const t = await api.requestImageUpload(product.id, u.file)
    await api.uploadToStorage(t.uploadUrl, u.file, (p) => update(u.id, { progress: p }))
    update(u.id, { stage: 'confirming' })
    await api.confirmImage(t.imageId)
    update(u.id, { stage: 'done' })
    onUpdated(await api.getProduct(product.id))
  } catch (err) {
    update(u.id, { stage: 'error', error: errorText(err) })
  }
}
```
  Files run concurrently (`Promise.allSettled` over the valid ones), so one failure never stops the rest.
- Each upload row shows the file name, a progress bar (`src/ui/ProgressBar.jsx`), the stage, and on error the message plus `<button aria-label={`Retry ${u.file.name}`}>Retry</button>`, which calls `runUpload(u)` again for a fresh slot. `done` rows disappear once the product refresh shows the photo.
- **Pre-check rejections** get a "Dismiss" button, not Retry.

- [ ] **Step 4: Run, build, commit.** Run the console suite and `npm run build`. Expected: PASS.
```bash
git add systems/admin-ui/src
git commit -m "feat(admin-ui): upload product photos straight to storage with per-file progress and retry"
```

---

## Task 8: Images tab — order, alt text, delete

**Files:**
- Modify: `systems/admin-ui/src/catalog/tabs/ImagesTab.jsx` (the photo grid)
- Test: `systems/admin-ui/src/catalog/images-manage.test.jsx`

**Interfaces:**
- Consumes: `api.reorderImages(productId, orderedIds)`, `api.updateImageAlt(imageId, alt)`, `api.deleteImage(imageId)`, `api.getProduct(id)`.
- Note: `product.images` from the admin API carries `id, storageKey, alt, width, height, position`. Task 4 added `id`, and the Task 5 fixtures include it.

- [ ] **Step 1: Write the failing tests**

```jsx
// src/catalog/images-manage.test.jsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../ui/toast.jsx'
import ImagesTab from './tabs/ImagesTab.jsx'
import product from '../data/__fixtures__/product.json'

vi.mock('../data/api.js', () => ({ default: {
  requestImageUpload: vi.fn(), uploadToStorage: vi.fn(), confirmImage: vi.fn(), getProduct: vi.fn(),
  reorderImages: vi.fn(), updateImageAlt: vi.fn(), deleteImage: vi.fn(),
} }))
import api from '../data/api.js'
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks() })

const img = (id, position, alt = '') => ({ id, storageKey: `products/p/${id}/original.png`, alt, width: 800, height: 600, position })
const withImages = { ...product, images: [img('a', 0, 'Front'), img('b', 1)] }
const renderTab = (p = withImages, onUpdated = vi.fn()) =>
  render(<ToastProvider><ImagesTab product={p} onUpdated={onUpdated} /></ToastProvider>)

describe('ImagesTab manage', () => {
  it('badges the first photo as Main', () => {
    renderTab()
    expect(within(screen.getByTestId('image-a')).getByText('Main')).toBeInTheDocument()
    expect(within(screen.getByTestId('image-b')).queryByText('Main')).toBeNull()
  })

  it('moves a photo left and saves the new order', async () => {
    vi.mocked(api.reorderImages).mockResolvedValue({ ok: true })
    vi.mocked(api.getProduct).mockResolvedValue(withImages)
    renderTab()
    await userEvent.click(within(screen.getByTestId('image-b')).getByRole('button', { name: /move left/i }))
    expect(api.reorderImages).toHaveBeenCalledWith(product.id, ['b', 'a'])
  })

  it('saves alt text explicitly and prompts when empty', async () => {
    vi.mocked(api.updateImageAlt).mockResolvedValue(img('b', 1, 'Side view'))
    vi.mocked(api.getProduct).mockResolvedValue(withImages)
    renderTab()
    const card = screen.getByTestId('image-b')
    expect(within(card).getByText(/add a description/i)).toBeInTheDocument()
    await userEvent.type(within(card).getByLabelText('Description'), 'Side view')
    expect(api.updateImageAlt).not.toHaveBeenCalled()
    await userEvent.click(within(card).getByRole('button', { name: /save/i }))
    expect(api.updateImageAlt).toHaveBeenCalledWith('b', 'Side view')
  })

  it('deletes only after confirmation', async () => {
    vi.mocked(api.deleteImage).mockResolvedValue(null)
    vi.mocked(api.getProduct).mockResolvedValue({ ...product, images: [img('a', 0, 'Front')] })
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    renderTab()
    const del = within(screen.getByTestId('image-b')).getByRole('button', { name: /delete/i })
    await userEvent.click(del)
    expect(api.deleteImage).not.toHaveBeenCalled()
    await userEvent.click(del)
    await waitFor(() => expect(api.deleteImage).toHaveBeenCalledWith('b'))
  })

  it('disables a photo\'s buttons while its request is in flight', async () => {
    let release
    vi.mocked(api.reorderImages).mockReturnValue(new Promise((r) => { release = r }))
    vi.mocked(api.getProduct).mockResolvedValue(withImages)
    renderTab()
    const left = within(screen.getByTestId('image-b')).getByRole('button', { name: /move left/i })
    await userEvent.click(left)
    expect(left).toBeDisabled()
    release({ ok: true })
  })
})
```

- [ ] **Step 2: Run to see it fail.** Expected: FAIL.

- [ ] **Step 3: Implement the grid**

Photos are sorted by `position`. Each card (`data-testid={`image-${img.id}`}`) shows:
- the thumbnail, `imageUrlFromKey(img.storageKey, 400)`, with `width` and `height`
- a "Main" badge when it is first
- ← / → buttons (`aria-label="Move left"` / `"Move right"`). The first card's left and the last card's right are disabled. A click calls `api.reorderImages(product.id, newIds)`, then `onUpdated(await api.getProduct(product.id))`.
- a "Description" input (`<label htmlFor>` text exactly "Description", per R1), with its own **Save**, enabled only when changed. It calls `api.updateImageAlt` and refreshes the product. When the saved alt is empty, show the hint "Add a description — used by screen readers and search engines." outside the label.
- **Delete:** `window.confirm('Delete this photo? This cannot be undone.')`, then `api.deleteImage` and a product refresh.

A `busy` flag per card disables all of that card's buttons in flight and resets in `finally`. Errors show `errorText(err)` on that card.

- [ ] **Step 4: Run, build, commit.** Run the console suite and `npm run build`.
```bash
git add systems/admin-ui/src
git commit -m "feat(admin-ui): reorder photos, edit descriptions and delete, with the main photo badged"
```

---

## Task 9: Console verification, PR, staging end to end

- [ ] **Step 1:** In `systems/admin-ui`: `npx vitest run && npm run build`. Expected: all pass.
- [ ] **Step 2:** Commit anything outstanding. **Stop here.** The push, PR, merge and staging deploy are done by the controller after Jack's OK, and only once Jack's account setup (runbook) and the Render values are in place.
- [ ] **Step 3 (controller, with Jack): staging end to end** on "Staging Test Castle". Step 4 of the Images tab is the one that shows the direct upload, S3 and CORS all line up.
  1. Open the Images tab. The "Add photos" control is visible.
  2. Upload one real JPEG under 15 MB. The progress bar completes, and the photo appears badged Main.
  3. Open `https://staging.alpinebrickexchange.com/product/staging-test-castle`. The photo shows, loaded from `alpinebrick-staging.imgix.net` with `?w=`.
  4. Upload a second photo and move it left. It becomes Main, and the storefront card follows after a reload.
  5. Add a description and Save. Reload; it persists.
  6. Delete a photo and confirm. It's gone from the console, and `GET` on its imgix URL now returns an error (after cache expiry, or check the S3 console for the missing object).
  7. The raw S3 URL for a remaining object returns 403 (private bucket).
  8. Upload a `.svg`. The console refuses it before sending.
