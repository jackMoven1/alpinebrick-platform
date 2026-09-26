# Image storage setup runbook — AWS S3 + imgix

Date: 2026-09-25. Design: `.superpowers/sdd/2026-09-25-product-image-upload/spec.md`.

Card details and secret keys are never pasted into chat or Discord.

## 1. Who

Jack, signed in as `alpinebrick@gmail.com`, for AWS and imgix. Card details and
secret keys are never pasted into chat or Discord.

## 2. AWS account

Create the AWS account, then set region **us-west-2**.

## 3. Two buckets

Create `alpinebrick-images-staging` and `alpinebrick-images-prod`.

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

**This differs from the design spec's §3 policy** (controller ruling R2,
2026-09-25): it also grants `s3:ListBucket`, scoped by condition to the
`products/*` prefix. Without it, S3 answers a `HEAD` on a missing object with
`403 Forbidden` instead of `404 Not Found`, so a confirm for a photo that was
never actually uploaded would surface as an error instead of the intended
"no object was uploaded for this image" rejection.

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
      "Resource": "arn:aws:s3:::alpinebrick-images-staging",
      "Condition": { "StringLike": { "s3:prefix": ["products/*"] } }
    }
  ]
}
```

For the `-prod` twin, swap `alpinebrick-images-staging` for
`alpinebrick-images-prod` in both the resource ARN and the `s3:prefix`
resource above (the prefix condition itself, `products/*`, is unchanged).

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
using case "Application running outside AWS". Never paste the resulting
secret access key into chat or Discord — Jack pastes it directly into Render
(§9).

Repeat with `-prod` users and policies when the production Blueprint is
created (out of scope for this pass; see spec §7 step 5's follow-on).

## 8. imgix

Create the imgix account and choose the **Starter** plan. Create an
**Amazon S3** source named `alpinebrick-staging`:

- Bucket: `alpinebrick-images-staging`
- Access key: the `alpinebrick-imgix-staging` IAM user's key
- Domain: `alpinebrick-staging.imgix.net`

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

Storefront and admin-ui:

- `VITE_ASSET_BASE_URL=https://alpinebrick-staging.imgix.net`

Save with "Save, rebuild, and deploy".

## 10. Verify

- `api-staging` `/health` returns ok, and the deploy log shows no
  `ASSET_STORAGE=s3 but missing` error.
- The admin console's Images tab uploads.
- `https://alpinebrick-staging.imgix.net/<key>?w=400` returns an image.
- The raw S3 object URL returns 403. That's correct: the bucket is private.

## Placeholders only

No real access keys, secret keys, or account credentials appear in this
document, in any commit, or in chat/Discord — only placeholder names like
"the core IAM user's key" above. Jack pastes the real values directly into
Render's console.
