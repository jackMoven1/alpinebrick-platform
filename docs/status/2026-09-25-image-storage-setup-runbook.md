# Image storage setup runbook — AWS S3 + imgix

Date: 2026-09-25. Design: `.superpowers/sdd/2026-09-25-product-image-upload/spec.md`.

## 1. Who

Jack, signed in as `alpinebrick@gmail.com`, for AWS and imgix. Card details and
secret keys are never pasted into chat or Discord.

## 2. AWS account

Create the AWS account, then set region **us-west-2**.

## 3. Two buckets

Create `alpinebrick-images-staging` and `alpinebrick-images-prod`. When
creating each bucket, choose region **US West (Oregon) us-west-2**.

- Object Ownership: **bucket owner enforced**.
- **Block all public access: ON.**
- Versioning: **off**.
- Default encryption: **SSE-S3**.

## 4. CORS

Bucket → Permissions → CORS. Staging:

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

## 5. IAM policy `alpinebrick-core-images-staging` (and a `-prod` twin)

**This differs from the design spec's §3 policy** (controller ruling R2a,
2026-09-25, which replaces the earlier, now-withdrawn R2): it also grants
`s3:ListBucket` on the bucket, **unconditioned**. Without it, S3 answers a
`HEAD` on a missing object with `403 Forbidden` instead of `404 Not Found`, so
a confirm for a photo that was never actually uploaded would surface as an
error instead of the intended "no object was uploaded for this image"
rejection. The grant is unconditioned rather than scoped to a `products/*`
prefix condition: a `HeadObject` request carries no `s3:prefix` in its request
context, so a prefix-conditioned `ListBucket` most likely never applies to it
and a missing object would still 403. This bucket holds only product images,
and imgix's own policy (§6) already has the same unconditioned `ListBucket`
right, so granting it unconditioned to core adds no new exposure.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::alpinebrick-images-staging/products/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::alpinebrick-images-staging"
    }
  ]
}
```

For the `-prod` twin, swap the bucket name in both `Resource` ARNs above;
leave `products/*` unchanged.

## 6. IAM policy `alpinebrick-imgix-read-staging` (and a `-prod` twin)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:GetObject"], "Resource": "arn:aws:s3:::alpinebrick-images-staging/*" },
    { "Effect": "Allow", "Action": ["s3:ListBucket", "s3:GetBucketLocation"], "Resource": "arn:aws:s3:::alpinebrick-images-staging" }
  ]
}
```

For the `-prod` twin, swap `alpinebrick-images-staging` for
`alpinebrick-images-prod` in both resource ARNs.

## 7. IAM users

Create `alpinebrick-core-staging` and `alpinebrick-imgix-staging`, each with
its matching policy attached (`alpinebrick-core-images-staging` and
`alpinebrick-imgix-read-staging` respectively). Create an access key for each,
using case "Application running outside AWS".

The two key pairs go to two different places, and never cross:

- **`alpinebrick-core-staging`'s** key pair goes into **Render** (§9).
- **`alpinebrick-imgix-staging`'s** key pair goes into **imgix's S3 source**
  (§8).

The imgix user's keys are never pasted into Render, and the core user's keys
are never pasted into imgix.

Repeat with `-prod` users and policies when the production Blueprint is
created (out of scope for this pass; see spec §7 step 5's follow-on).

## 8. imgix

Create the imgix account and choose the **Starter** plan. Create an
**Amazon S3** source named `alpinebrick-staging`. imgix's S3 source form asks
for:

- Bucket: `alpinebrick-images-staging`
- Access Key ID: the `alpinebrick-imgix-staging` IAM user's access key ID
- Secret Access Key: that same user's secret access key
- Path prefix: leave blank
- Domain: `alpinebrick-staging.imgix.net`

There is no region field to fill in — imgix discovers the bucket's region
itself via `GetBucketLocation` (granted in §6).

Set **Default Cache TTL** to the maximum offered. Leave custom domains alone
for now (deferred per spec §3).

## 9. Render

Staging `core-env`, set by hand on the group page — the Blueprint does not
create `sync: false` keys inside env groups:

- `ASSET_STORAGE=s3`
- `ASSET_S3_BUCKET=alpinebrick-images-staging`
- `ASSET_S3_REGION=us-west-2`
- `ASSET_S3_ACCESS_KEY_ID` and `ASSET_S3_SECRET_ACCESS_KEY` — the core IAM
  user's key, pasted by Jack.
- `ASSET_PUBLIC_BASE_URL=https://alpinebrick-staging.imgix.net`

Storefront and admin-ui — this is **not** a `core-env` key: set
`VITE_ASSET_BASE_URL=https://alpinebrick-staging.imgix.net` on **each static
site's own Environment page** individually (storefront, admin-ui), since it's
a build-time value baked in at each site's own build.

Save with "Save, rebuild, and deploy".

## 10. Verify

- `api-staging` `/health` returns ok, and the deploy log shows no
  `ASSET_STORAGE=s3 but missing` error.
- **Confirm-without-upload check (exercises the core user's `ListBucket`
  grant from §5):** request an upload token for a product
  (`POST /api/v1/admin/images/upload-token`), then immediately call
  `POST /api/v1/admin/images/:id/confirm` **without** uploading anything to
  the presigned URL. Expect a `409` with `code: "object_missing"` ("no object
  was uploaded for this image") — not a `500` or an `AccessDenied`. A
  `500`/`AccessDenied` here means the core user's `ListBucket` grant is
  missing or misconfigured.
- The admin console's Images tab uploads. **This check needs the console PR
  (Tasks 6–8) deployed first** — it isn't available from PR 1 (core) alone.
- `https://alpinebrick-staging.imgix.net/<key>?w=400` returns an image.
- The raw S3 object URL returns 403. That's correct: the bucket is private.

## Placeholders only

No real access keys, secret keys, or account credentials appear in this
document, in any commit, or in chat/Discord — only placeholder names like
"the core IAM user's key" above. Jack pastes the real values directly into
Render's console.
