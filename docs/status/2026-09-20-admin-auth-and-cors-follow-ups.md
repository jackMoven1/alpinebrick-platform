# Admin Auth and CORS — Follow-Ups

**Date:** 2026-09-20.
**Source:** the deferred-minor triage from the admin-authentication branch
([PR #27](https://github.com/jackMoven1/alpinebrick-platform/pull/27), 12 tasks,
24 reviews) and the CORS branch
([PR #28](https://github.com/jackMoven1/alpinebrick-platform/pull/28)).

Every item below was raised by a reviewer, judged real, and deliberately
deferred rather than dropped. Nothing here blocked either merge.

**Verified against the tree at `feat/cors` on 2026-09-20**, not transcribed from
the working notes — several items recorded as open during the branch were
closed by its final fix wave and are listed under *Already closed* so they are
not re-reported.

---

## 1. Security and correctness

### 1.1 Two sign-in rejection paths are completely silent

`systems/core/src/auth/auth.routes.ts:108,111`

An **unverified email** and an **off-allowlist email** both return 403 and
record *nothing* — no `AuditLog` row and no log line. Only the disabled-actor
case is audited (`:155`).

Skipping the database row is correct: `AuditLog.actorId` is `NOT NULL` and
FK-enforced, and the `'system'` sentinel actor is created by `npm run seed`
rather than by a migration, so it is not guaranteed to exist in a given
environment. But the spec's "a failed check creates no `Actor`" rule constrains
*where* the record can go; it does not require silence.

An off-allowlist sign-in attempt against an admin console is the single most
security-relevant event this flow can produce.

**Fix:** one scrubbed `console.warn` at each rejection (reason only, no raw
email), plus a data migration that creates the sentinel actor so the rows can be
written properly later. That migration would also fix
`systems/core/src/orders/orders.service.ts`'s existing dependence on a seeded
row.

### 1.2 `GET /api/v1/orders/:id` has no ownership check

`systems/core/src/orders/orders.routes.ts:20`

Any caller can fetch any order. Ids are cuids so they are not enumerable, but
there is no authorization on the route at all. Pre-existing, and outside the
scope of both branches — it came up twice and was correctly left alone both
times. It deserves its own decision rather than another deferral.

### 1.3 The OAuth transaction cookie is unsigned and never cleared

`systems/core/src/auth/auth.routes.ts`

`state` and `codeVerifier` ride a base64url JSON cookie with no HMAC, and the
callback compares `req.query.state` against that same cookie. Anyone able to
write a cookie on the API's domain — an XSS on `www.alpinebrickexchange.com`,
which shares a registrable domain with `api.alpinebrickexchange.com` — could
substitute their own transaction and have the victim's browser mint a session
for *their* Google identity.

Blast radius is bounded hard by `ADMIN_ALLOWED_EMAILS`: the forged identity must
already be an allowlisted admin. Worth doing as defence in depth, not urgent.

Separately, the cookie is never cleared, so the verifier is time-bounded (10
minutes) rather than single-use. Replay is currently blocked only by Google's
authorization codes being single-use; the application contributes nothing.

**Note:** clearing it is exactly the edit that would silently drop the session
cookie, because `res.setHeader` replaces rather than appends. There is a comment
at the call site saying so — pass an array.

### 1.4 `express.json()` mounts ahead of every CORS handler

`systems/core/src/app.ts:16`

A malformed or oversized (>100 kb) JSON body is rejected by the body parser
before any CORS middleware runs, so the 400/413 leaves without
`Access-Control-Allow-Origin` and the console sees an opaque CORS failure
instead of the real status. Narrow, browser-only, and not a one-line fix.

### 1.5 `/api/v1/orders` has no CORS handler

`systems/core/src/app.ts:25`

Deliberate and commented: nothing calls it cross-origin yet. It will block
checkout the moment the storefront is wired to it, and needs the catalog-shaped
treatment — `allowedStorefrontOrigins`, `credentials: false`.

---

## 2. Operational

### 2.1 Every admin console request is preflighted

`systems/admin-ui/src/data/api.js:27`

The console sends `content-type` and `accept` on **every** call, including GETs.
`content-type` is not a CORS-safelisted header, so every request costs a
preflight round trip. `Access-Control-Max-Age: 600` reduces the frequency; it
does not eliminate it.

**Fix:** send those headers only on requests that have a body. That removes
preflight for reads entirely.

### 2.2 `reorderImages` does N sequential round trips inside a transaction

`systems/core/src/assets/image.service.ts`

Was a batched `$transaction([...])`; became a loop of awaited updates so the
audit write could be folded in. Correct, but it now runs against Prisma's 5s
default interactive-transaction timeout. Fine at single-digit image counts; add
an explicit `timeout` option or a comment noting the bound.

### 2.3 `STOREFRONT_ORIGIN` covers `www.` only

`render.yaml`

Correct today — the apex still resolves to Shopify until Phase 5. At cutover, an
apex-served storefront would get no `Allow-Origin` on any catalog call. Noted
beside the key.

---

## 3. Input handling

### 3.1 `create-api-key` accepts hex day counts

`systems/core/src/scripts/create-api-key.ts`

`Number('0x10')` is `16`, which passes `Number.isSafeInteger`, `> 0` and
`<= 3650`, so `0x10` is silently accepted as **16 days**. Not a `Date`-overflow
risk and well under the cap — just not decimal-CLI behaviour for a day count.

### 3.2 `create-api-key` has no operator identity

`systems/core/src/scripts/create-api-key.ts`

It takes `<actor-name> <key-name> [expires-days]`. The resulting
`apikey.create` audit row is attributed to the key's own new agent actor, so it
reads as "the agent minted itself" and cannot answer *which human* ran it —
during an incident, which is the only time this script runs.

**Fix:** add an operator argument and attribute the audit row to it.

---

## 4. Test coverage

None of these are failures; each is a guard that does not exist.

| Gap | Where |
|---|---|
| `createSession`'s `meta.userAgent` / `meta.ip` passthrough is untested | `tests/auth-session.test.ts` |
| No tests for a missing tx cookie, a malformed tx cookie, or `actor.disabled` → 403 | `tests/auth-routes.test.ts` |
| The lowercase-email persistence fix has no red/green test — existing fixtures are already lowercase, so they cannot distinguish it | `tests/auth-routes.test.ts` |
| `isEmailConflict`'s string-shaped `target` branch is unexercised; only the array shape was observed from Prisma | `src/auth/auth.routes.ts` |
| `scrubError`'s throwing-getter guard rests on reasoning, not a red/green cycle | `src/auth/scrub.ts` |
| No origin test hits the `/admin/images` router specifically; none covers HEAD/OPTIONS exemption, DELETE/PUT, or a duplicate `Origin` header | `tests/auth-origin.test.ts` |
| No assertion that `Access-Control-Max-Age` is *absent* for an unlisted origin | `tests/cors.test.ts` |
| `ProductList.jsx`'s `load()` has no `.catch` at all — inconsistent with the catch-and-render pattern in its siblings | `systems/admin-ui/src/catalog/ProductList.jsx:20` |

### 4.1 The route-coverage test assumes public by default

`systems/core/tests/auth-route-coverage.test.ts:34`

It enumerates the live Express router — the most valuable test on the branch —
but then filters to `/api/v1/admin`. A future admin router mounted at any other
prefix is discovered and then silently discarded, so the test passes while that
router is wide open.

**Fix, when a second admin prefix appears:** assert over *all* discovered routes
against an allowlist of *public* prefixes, inverting the default from "assume
public" to "assume protected".

---

## 5. Consistency

- `tokens.ts` — `replace(/_/g,'').slice()` has no floor check. An improbable
  (~1e-9) underscore-heavy draw yields a shorter secret; no test asserts the
  secret's length. The better long-term shape is `parseApiKey` splitting on the
  first two underscores, making the format independent of the secret alphabet.
- `require-auth.ts` branches exclusively on the `Authorization` header, so any
  such header suppresses the cookie path entirely. Fails closed and is correct,
  but would surprise anyone behind a proxy that injects one.
- `session.service.ts` — `if (!token) return null` is redundant with the hash
  lookup. Harmless, arguably clearer.
- `auth.routes.ts` — the `disabled` 403 fires *after* the upsert has already
  overwritten `email`/`name` from the Google payload. No actor is created, so
  the spec rule holds, but a rejected sign-in still writes.
- `schema.prisma` — irregular column alignment on the `Actor` additions.
  `npx prisma format` on any future schema touch.
- `google-auth-library` can embed decoded JWT claims in some error messages.
  Claims, not secrets, and `scrubError` narrows to `message`/`code`/`status`
  anyway — worth knowing if error logging is widened.
- `tests/create-api-key.test.ts` — a comment explaining the large-finite-integer
  case sits above the boundary-accept test rather than above the three reject
  tests it describes.
- `systems/storefront/code/tsconfig.tsbuildinfo` is version-controlled and
  churns on every build.

---

## Already closed

Listed so they are not re-reported. All verified against the tree on 2026-09-20.

| Item | Resolution |
|---|---|
| `scrubError` exported from a route module | Moved to `src/auth/scrub.ts` |
| `createApiKey`'s two non-atomic writes | Now in one `$transaction` with the audit row |
| `GET /products/:id` and `GET /overview` unguarded | Both wrapped; Node 20 would have exited the container |
| Stale `THESE HAVE NO AUTHENTICATION` comments | Replaced with PRECONDITION blocks in both routers |
| `sessionTtlMs()` unbounded | Capped at one year, validated at the input layer |
| Unused `cookie-parser` | Removed |
| `EMAIL_ALREADY_LINKED` test writing to stderr | Spied and asserted on the scrubbed shape |
| FK-dependency undocumented in the orders atomicity test | Comment added |
| `res.setHeader('Set-Cookie')` replace-not-append hazard | Comment added at the call site |
| No global error handler leaking stack traces | Not a leak — `Dockerfile:30` sets `NODE_ENV=production` |
| Spec §6's third CSRF layer missing | `requireJsonContentType` implemented and tested |
| Storefront hardcoded a relative API base | Reads `VITE_API_BASE_URL` via `lib/apiBase.ts` |
