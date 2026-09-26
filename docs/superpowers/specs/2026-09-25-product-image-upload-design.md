# Product Image Upload — imgix + S3 — Design

**Status:** Approved in conversation by Jack, 2026-09-25 (sections 1–4). Awaiting
review of this written form.
**Date:** 2026-09-25.
**Closes:** ADR-0002's last open item, the CDN / origin host and spend. The
rest of ADR-0002 (on-the-fly transforms, immutable storage keys, public
delivery, direct upload against a server-minted target) was decided and built
on 2026-08-13 and stands unchanged. See
`docs/superpowers/specs/2026-08-13-product-image-asset-architecture-design.md`.

---

## 1. Why now

Staging is live, and the console now creates products, variants and stock
(PRs #34/#35). It cannot add photos: the only storage adapter writes to the
local filesystem, nothing in core serves those files, and Render's filesystem
is wiped on every deploy. Product photography is the last gap before real
inventory can be loaded.

**Success criterion:** in the staging console, upload a real photo to
"Staging Test Castle", see it resized on `staging.alpinebrickexchange.com`,
reorder, edit its alt text, delete it, and confirm the object is gone from
the bucket.

## 2. Decisions taken in conversation (Jack, 2026-09-25)

| Question | Ruling |
|---|---|
| Provider | **imgix (Starter, $25/mo) in front of AWS S3.** Prices read from the providers' pricing pages on 2026-09-24; AWS figures from secondary sources |
| Photo formats | **JPEG, PNG, WebP.** Photos come from a camera or a computer, so no HEIC |
| Account owner | **`alpinebrick@gmail.com`** for both AWS and imgix |

Why imgix + S3 (the research is in the session record; summarised here):

- **The upload flow stays as built.** It is already a presigned PUT, which S3
  supports natively. Cloudinary and Cloudflare Images need a multipart POST
  rewrite.
- **No DNS risk.** DNS for `alpinebrickexchange.com` is at name.com, with the
  live Shopify store on the apex and `www`. Cloudflare's URL resizing needs the
  zone on Cloudflare. imgix serves from `*.imgix.net`, or later from one CNAME.
- **Originals stay in our own bucket**, so changing delivery provider later is
  a re-point, not a data migration.
- Runner-up: S3 + CloudFront with a self-built resizer. It is cheaper, but it
  means building and maintaining a resize service.

**SVG is removed** from accepted uploads (§4.2). This is not a Jack ruling
but a security default. An SVG served publicly can carry script, and product
photos never need it.

## 3. Storage and accounts

- **Two private S3 buckets** in `us-west-2` (Oregon):
  `alpinebrick-images-staging` and `alpinebrick-images-prod`. S3 "Block all
  public access" is **on**, so originals are never directly readable.
- **Bucket CORS:** allow `PUT` from the admin console origin(s) only
  (`https://admin-staging.alpinebrickexchange.com`; later
  `https://admin.alpinebrickexchange.com`), with header `content-type`.
- **Two IAM users per bucket:**
  - **core:** `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on
    `arn:aws:s3:::<bucket>/products/*`, and nothing else. It needs
    `GetObject` for the confirm read and `PutObject` so presigned PUTs work.
  - **imgix:** `s3:GetObject` on `arn:aws:s3:::<bucket>/*` and
    `s3:ListBucket` on the bucket, read-only, as imgix's S3 source requires.
- **imgix:** one account on Starter, with **two S3 sources**, one per bucket.
  Each serves on an imgix subdomain, e.g. `alpinebrick-staging.imgix.net`.
  Source settings: default cache TTL long, since keys are immutable.
  A custom domain (`images.alpinebrickexchange.com`, one CNAME at name.com) is
  **deferred**. It is not needed to ship and it keeps the Shopify records
  untouched.
- **Environment (Render):**

| Where | Key | Value (staging) |
|---|---|---|
| core-env | `ASSET_STORAGE` | `s3` |
| core-env | `ASSET_S3_BUCKET` | `alpinebrick-images-staging` |
| core-env | `ASSET_S3_REGION` | `us-west-2` |
| core-env | `ASSET_S3_ACCESS_KEY_ID` | core IAM user, **secret, pasted by Jack** |
| core-env | `ASSET_S3_SECRET_ACCESS_KEY` | core IAM user, **secret, pasted by Jack** |
| core-env | `ASSET_PUBLIC_BASE_URL` | `https://alpinebrick-staging.imgix.net` |
| storefront | `VITE_ASSET_BASE_URL` | `https://alpinebrick-staging.imgix.net` |
| admin-ui | `VITE_ASSET_BASE_URL` | `https://alpinebrick-staging.imgix.net` |

  The two `VITE_` values are build-time, so both static sites rebuild. They
  are added to `render.yaml` as `sync: false`. The Render lesson of 2026-09-24
  applies: `sync: false` keys inside an env group are **not** created by the
  Blueprint, so core's keys are set by hand on the group page.
- **Local development and CI** keep the local-filesystem adapter
  (`ASSET_STORAGE` unset). Tests never reach AWS.

## 4. Core

### 4.1 S3 adapter

`systems/core/src/ports/storage/s3.adapter.ts` implements the existing
`AssetStoragePort` with `@aws-sdk/client-s3` and
`@aws-sdk/s3-request-presigner`.

- `createUploadTarget(key, contentType)`: a presigned `PutObject` URL for
  exactly that key, with `ContentType` signed, **expiring in 15 minutes**.
  Returns `{ uploadUrl, expiresAt }`.
- `stat(key)`:
  - `HeadObject` gives `ContentLength` and `ContentType`; `NotFound` returns
    `null`.
  - Then a ranged `GetObject` (`bytes=0-65535`) is fed to `image-size`, the
    same library the local adapter uses.
  - If dimensions can't be read from 64 KB, one full `GetObject` is the
    fallback (bounded by the 15 MB cap).
  - Anything `image-size` cannot parse returns `width: 0, height: 0`, which
    confirm rejects.
- `delete(key)`: `DeleteObject`. Absent is success. Any other error surfaces.

**Selection.** `createStoragePort()` in `src/ports/storage/index.ts` returns
S3 when `ASSET_STORAGE === 's3'`, else local. With `s3` set and any of the
bucket, region, access key or secret missing, it **throws at startup**, naming
the missing keys. No silent fallback to local disk. `app.ts` uses it in place
of `createLocalStoragePort`.

### 4.2 Stricter confirm

`confirmUpload` keeps its shape (storage I/O before the transaction; row update
and audit inside it) and adds checks. With the real object in hand it
rejects when:

| Check | Error code | HTTP |
|---|---|---|
| object missing | `object_missing` (existing) | 409 |
| `stat.byteSize > MAX_UPLOAD_BYTES` (15 MB) | `upload_too_large` | 413 |
| `stat.byteSize !== row.byteSize` (declared) | `upload_mismatch` | 409 |
| `stat.contentType !== row.contentType` | `upload_mismatch` | 409 |
| width or height is 0 (not a readable image) | `not_an_image` | 422 |

On any rejection, confirm **deletes the object and the pending row**. The
client starts again with a new upload slot. Rejections are audited as
`image.upload.reject`, with the code and the observed values. Confirming an image that is
already `ready` returns it unchanged and writes no audit (idempotent retry).

**Accepted types:** `image/jpeg`, `image/png`, `image/webp`. SVG is removed
from `EXT_BY_CONTENT_TYPE`. Any existing SVG rows are untouched; only new
uploads are affected.

### 4.3 URL grammar → imgix

Both copies change together: `systems/core/src/assets/image-url.ts` (Walmart
feed) and `systems/storefront/code/src/lib/images.ts` (srcset). The existing
`resolver-parity.test.ts` keeps them identical.

| Option | Before | After (imgix) |
|---|---|---|
| width | `?w=600` | `?w=600` |
| `format: 'auto'` | `?fmt=auto` | `?auto=format` |
| `format: 'webp'` | `?fmt=webp` | `?fm=webp` |
| `format: 'jpeg'` | `?fmt=jpeg` | `?fm=jpg` |

The console's `src/lib/imageUrl.js` already emits only `?w=`, so it needs no
grammar change, only the base URL.

### 4.4 Abandoned uploads

`requestUpload` first calls `sweepPendingImages` scoped to **that product**
for pending rows older than 24 hours. It deletes the object, then the row,
and a failed object delete is logged and skipped. `sweepPendingImages` gains an
optional `productId` filter. This needs no scheduler; the sweep runs on
real activity.

### 4.5 No migration

`images` already stores `storageKey`, `contentType`, `byteSize`, `width`,
`height` and `status`.

## 5. Console — Images tab

`systems/admin-ui/src/catalog/tabs/ImagesTab.jsx` goes live, replacing the
"not in this phase" banner.

- **Upload:** "Add photos" button plus a drop area; multiple files.
  - **Client checks first:** type ∈ JPEG/PNG/WebP and size ≤ 15 MB. A failing
    file is named with its reason and never sent.
  - **Per file:** `POST /admin/images/upload-token` → `PUT` to `uploadUrl` with
    the file's `Content-Type` → `POST /admin/images/:id/confirm`, with a
    progress bar and a stage label.
  - **One file failing** shows core's message and a **Retry** (which requests
    a new slot) without stopping the others.
  - **Confirmed photos appear** with the true width and height from the
    response.
- **Order:** position 0 is the **main** photo, used on product cards and the
  Walmart feed, and it is badged "Main". ← → buttons call
  `PUT /admin/images/reorder` with the new order, and the list re-renders from
  the response. No drag-and-drop in this build.
- **Alt text:** a field under each photo with its own **Save** (never
  auto-save, as with the Info tab). Photos with empty alt show an "Add a
  description" hint.
- **Delete:** confirm dialog, then `DELETE /admin/images/:id`. Remaining photos
  close the gap.
- **Patterns carried over from PR #35:** core's message first via
  `errorText`, in-flight guards on every button, nothing shown as saved until
  core confirms, no mock fallback.
- `api.js` gains `requestImageUpload`, `uploadToStorage`, `confirmImage`,
  `reorderImages`, `updateImageAlt`, `deleteImage`, replacing the last four
  `notImplemented` stubs. **The image routes use lower_snake codes**
  (`product_not_found`, `file_too_large`, …), a known inconsistency noted in
  `admin-catalog.routes.ts`. `errorText` shows `message` regardless, so no
  mapping is needed.
- **The Publish tab's "No images" warning** now reflects real photos. No
  change is needed; it already reads `product.images`.

## 6. Testing

**Core**, following the existing patterns:

- S3 adapter against a mocked client (`aws-sdk-client-mock`): presigned URL
  carries the key, content type and a 15-minute expiry; `stat` issues HEAD
  then a ranged GET and returns true dimensions for fixture JPEG/PNG/WebP
  bytes; `NotFound` → `null`; delete of an absent object succeeds.
- `createStoragePort`: local by default; S3 with all keys; **throws** naming
  each missing key when `s3` is half-configured.
- Confirm: each rejection row of §4.2, asserting the object is deleted, the
  row is gone, and a reject audit is written. Double confirm is a no-op. SVG is
  refused at upload-token.
- Sweep: only that product's pending rows older than 24 h are removed; a failed
  object delete does not stop the sweep.
- Resolver grammar: updated unit tests on both sides, plus the parity test.

**Console:** fixtures captured from a running core (the PR #32 lesson). Tests
cover:

- the client file checks
- one of three uploads failing while the others succeed
- Retry
- reorder sends the right order
- alt text save
- delete confirm
- in-flight guards
- the Main badge

**Before merging:** CI green, `npm run build`, compiled core booted.

**Staging end to end (§1)** is the real proof that S3, imgix and the CORS
rule line up. Mocks cannot show that.

## 7. Rollout

Core refuses to start with S3 half-configured, so the order matters:

1. **PR 1: core** (adapter, confirm hardening, grammar, sweep). Merged and
   deployed with `ASSET_STORAGE` unset. Staging behaviour is unchanged.
2. **Jack: account setup** from the runbook written with PR 1. That covers the
   AWS account, two buckets with CORS, IAM users and keys, and the imgix account
   with two sources. The agent can guide in the browser; card details and
   secrets are Jack's alone.
3. **Render values** (§3). Core switches to S3; storefront and console
   rebuild with the imgix base.
4. **PR 2: console** Images tab.
5. **Staging end to end** on "Staging Test Castle".

Production gets its own bucket, IAM user and imgix source when the production
Blueprint is created.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Presigned URL used to upload something other than what was declared | Confirm re-reads the real object; mismatches are deleted and rejected |
| Bucket made public by mistake | Block Public Access on; imgix reads with its own credentials |
| S3 half-configured on a deploy | Core fails at startup naming the missing keys, loud rather than silently local |
| The two URL resolvers drift | Existing parity test, updated to imgix |
| CORS rule wrong, so browser uploads fail | Caught by the staging end to end; the rule is in the runbook verbatim |
| Abandoned uploads accumulate cost | Per-product sweep on each new upload |
| Leaving imgix later | Originals stay in S3; only the two resolvers and one base URL change |
| Cost growth | Starter covers the stated 1× and likely 10× scale; imgix usage is visible in its dashboard |
