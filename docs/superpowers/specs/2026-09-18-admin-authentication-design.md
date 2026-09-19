# Admin Authentication — Design

**Status:** DRAFT — awaiting Jack's review.
**Date:** 2026-09-18.
**Owners:** Core Engineer (auth middleware, OIDC, schema), Admin UI (sign-in
screen, credentialed fetch), Engineering Lead (approver).
**Closes:** §9 and open question 1 of the
[Phase B slice design](2026-08-13-catalog-admin-phase-b-slice-design.md), which
recorded authentication as a precondition on deployment.
**Also closes:** open question 2 of that spec (CORS and the admin domain) — see §6.

---

## 1. Why now

`/api/v1/admin/*` is a **write** surface with no authentication of any kind.
`POST /products/:id/status` will unpublish or archive any product, and the image
endpoints under `/api/v1/admin/images` will reorder and delete. Core has no auth
anywhere: the only credential handling in the codebase is
`channels/walmart/client.ts`, which is *outbound* to Walmart.

That was an accepted trade on 2026-08-13 — slice-first, with the cost understood
— and it holds only while nothing is reachable. It is the single item gating
deployment of both admin surfaces.

## 2. Scope

**In:** authentication for human operators and for non-human callers, plus audit
logging on the admin write paths.

**Out, deliberately:**

| Out | Why |
|---|---|
| Role / permission model | Two founders, both full operators. A role model with one role is ceremony. Revisit when someone outside the two gets access. |
| Customer accounts | The storefront has none today. Admin identity and customer identity share nothing but the word "login"; conflating them is how a customer ends up reaching an admin route through a role-check bug. |
| MFA beyond Google's | Sign-in inherits whatever the Google accounts already carry. Building a second factor on top would be weaker and more work. |
| Session-management UI | The `AdminSession` table records `userAgent`/`ip` so this can be built later. It is not needed to deploy. |
| Key-management UI | Keys are issued by script (§8). A console feature for two people is not yet worth building. |

## 3. Decisions taken, and by whom

Ruled by Jack, 2026-09-18, during design:

1. **Humans and service credentials**, not humans alone. This matches
   `ActorType = human | agent`, which the schema has carried since the redesign,
   and the MCP connector named in the 2026-07-08 redesign spec.
2. **Google sign-in (OIDC)** for humans, restricted to an email allowlist. No
   password storage, no reset flow, and therefore **no email provider on the
   critical path**.
3. **Audit logging is in scope** for admin writes. The *actor-identity*
   backfill stays out: the hardcoded `actorId = 'system'` fallback in
   `orders.service.ts` is untouched. Its *transactionality* is now in — see
   decision 6.
4. **The console is served from an unrelated domain**, not a subdomain of
   `alpinebrickexchange.com`. See §6 for what this buys and what it costs.
5. **Server-side sessions with an httpOnly cookie**, over stateless JWTs and over
   verifying Google's ID token per request. Revocation is the reason: it is the
   point of a control added for security, and it must be a row delete rather
   than a denylist that reintroduces the state a JWT was meant to avoid.
6. **The four order audit calls move inside their transactions**, accepting that
   an audit failure now rolls back the order state change. See §7.1.

## 4. Credential model

Three additive schema changes. Nothing existing is altered destructively, and
the seeded `system` actor is unaffected — nullable uniques permit multiple NULLs
in Postgres.

**`Actor` gains:** `email` (nullable, unique), `googleSub` (nullable, unique),
`disabled` (default false).

**`AdminSession`:** `actorId`, `tokenHash` (unique), `expiresAt`, `revokedAt`,
`lastSeenAt`, `userAgent`, `ip`.

**`ApiKey`:** `actorId`, `name`, `prefix` (unique), `keyHash` (unique),
`expiresAt`, `revokedAt`, `lastUsedAt`.

### 4.1 Naming: `AdminSession`, not `Session`

Ruled by Jack, 2026-09-18. The model is `AdminSession`, the table
`admin_sessions`, the cookie `ab_admin_session`.

A generic `Session` would claim the obvious name for admin identity. When
customer accounts arrive the second table has to be `customer_sessions`, leaving
an unprefixed `sessions` that silently means "the admin one" — the kind of
asymmetry that reads as an oversight forever after. Naming it now costs nothing
and the rename later would touch every call site.

### 4.2 Session lifetime: 12 hours, absolute

Ruled by Jack, 2026-09-18. `SESSION_TTL_HOURS` defaults to **12**, with **no
sliding window**.

The usual case for long sessions is that re-authenticating is disruptive. With
Google SSO it is not: a live Google session makes re-auth a redirect and often
zero clicks. Against that, the cookie is a **full-admin credential with no role
limits**, so a stolen one is worth whatever its remaining lifetime is.

Sliding windows are rejected for the same reason: they let an attacker who keeps
a stolen cookie warm hold it indefinitely, which is precisely what expiry exists
to prevent.

### 4.3 We store hashes, never the credential

A dump of `admin_sessions` yields no usable session, and a dump of `api_keys` yields no
usable key. Key format is `abk_<prefix8>_<secret32>`; the plaintext is displayed
exactly once at creation and is unrecoverable afterwards. The `prefix` exists so
a key can be identified in logs and revoked without ever holding its secret.

### 4.4 SHA-256, not Argon2 — and why that is not a shortcut

Both credentials are 256-bit random tokens, not user-chosen passwords. There is
no dictionary and no rainbow table to defend against, so a deliberately slow KDF
buys no security here while adding latency to **every authenticated request**.
Argon2id would be the right answer for passwords. We do not have any, by
decision 2 in §3.

## 5. Verification and sign-in

One `requireAuth` middleware, two paths, both resolving to the same `req.actor`:

```
Authorization: Bearer abk_…  →  parse prefix → lookup → constant-time compare
session cookie                →  sha256 → lookup AdminSession → check expiry/revocation
neither                       →  401
```

### 5.1 Where the middleware mounts — a trap worth naming

`app.ts` mounts **two** routers under the admin prefix, images first:

```ts
app.use('/api/v1/admin/images', createAssetsRouter(storagePort))
app.use('/api/v1/admin', adminCatalogRouter)
```

Express matches in registration order, so a `requireAuth` attached to the
*second* mount would never run for the image routes — leaving reorder and delete
open while the catalog routes looked protected, and looking correct in review.

`requireAuth` therefore mounts on the `/api/v1/admin` prefix **before either
router**, and the route-coverage test in §9 enumerates both.

### 5.2 OIDC endpoints

| Route | Purpose |
|---|---|
| `GET /api/v1/auth/google/start` | Redirect to Google with `state` + PKCE |
| `GET /api/v1/auth/google/callback` | Exchange code, verify, create session, redirect |
| `POST /api/v1/auth/logout` | Revoke session, clear cookie |
| `GET /api/v1/auth/me` | Current actor — how the console knows it is signed in |

### 5.3 The callback's checks, in order

1. ID token signature verifies against Google's JWKS.
2. **`email_verified === true`.** An unverified email is not evidence of anything.
3. Email appears in `ADMIN_ALLOWED_EMAILS`.
4. Upsert `Actor` **keyed on `sub`, not on email.**

Step 4 is the one worth stating explicitly. Google's `sub` is the stable
identifier; an email address can be reassigned. Allowlisting *by email* while
keying identity *by sub* is the combination that is correct — allowlisting by
sub would be unmanageable, and keying by email would let a reassigned address
inherit an existing actor.

**A failed check creates no `Actor`.** A rejected sign-in leaves nothing behind
to clean up or to mistake for a provisioned account later.

### 5.4 Break-glass — mint on demand, no standing key

**Settled 2026-09-18: Render offers shell access on our plan, confirmed by
Jack. There is therefore no standing break-glass key.**

Google being unavailable, or the allowlist being wrong, would lock both
founders out of their own admin. The question was how to hold a credential for
that case.

The answer is not to hold one. Setting `BREAK_GLASS_KEY_HASH` would require
Render dashboard access — and anyone with Render dashboard access in an
emergency can instead shell into the service and run `create-api-key` (§8) to
mint one on the spot. A standing key would grant **no capability its holder did
not already have**, while leaving a permanent full-admin credential in
existence for the rest of the system's life.

**The break-glass credential is the Render account**, which already exists,
already carries its own MFA, and is already the thing you need in order to
diagnose the outage.

The procedure:

1. Render dashboard → the `core` service → Shell.
2. `npm run create-api-key:prod -- break-glass emergency 1`
   (actor name, key name, expiry in days — one day, not never). The `:prod`
   entry point runs the compiled script under plain `node`; the plain
   `create-api-key` script depends on `tsx`, a devDependency a production
   install omits, so it is not present in the Render shell.
3. Use the printed key as `Authorization: Bearer abk_…`.
4. Revoke it when the incident closes: set `revoked_at` on the row.

**Test this once, before it is needed.** Working out how to mint a key for the
first time during an outage is how break-glass plans fail. That is the whole
reason this is written down rather than assumed.

There is deliberately **no bypass branch in the code**. A key minted this way
flows through the ordinary API-key path — the most dangerous piece of an auth
system being also the least exercised is how bypasses survive review.

## 6. The console's origin, and what it costs

The console is served from a domain unrelated to `alpinebrickexchange.com`.

**What it buys:** the public storefront at `www.alpinebrickexchange.com` is a
React app facing the internet. On a *subdomain* console, storefront and console
would share a registrable domain, so an XSS in the storefront could reach the
admin API with cookies attached. An unrelated domain removes that path entirely.

**What it costs:** the session cookie must be `SameSite=None; Secure`, so the
cookie is sent on cross-site requests and the attribute contributes nothing to
CSRF defence. Three layers replace it:

1. **CORS allowlist** — the exact origin from `ADMIN_CONSOLE_ORIGIN`, with
   `Access-Control-Allow-Credentials: true`. Never `*`, which the CORS spec
   forbids alongside credentials in any case.
2. **Server-side `Origin` validation on every non-GET/HEAD request**, rejecting
   with 403 when absent or not allowlisted. **This is the load-bearing layer**,
   because unlike CORS it does not depend on a browser choosing to enforce
   anything, and it still holds if the CORS configuration drifts.
3. **Admin writes require `Content-Type: application/json`.** A cross-site HTML
   form can only produce `urlencoded`, `multipart` or `text/plain`; none are
   accepted, and anything else forces a preflight.

Bearer-key requests are exempt from layer 2 — they are not browser-driven and
carry no `Origin`. Their protection is possession of the key.

### 6.1 The hostname — verified

`onrender.com` **is** on the Public Suffix List, confirmed against the live list
on 2026-09-18 (16,481 entries, private section):

```
// Render : https://render.com
// Submitted by Anurag Goel <dev@render.com>
onrender.com
app.render.com
```

So `alpinebrick-admin.onrender.com` is its own registrable domain, is unrelated
to `alpinebrickexchange.com` for every same-site computation, and costs nothing.
**This is the hostname.**

If the PSL entry were ever withdrawn, every Render customer's app would share a
registrable domain with the console and the isolation this section exists to buy
would silently vanish. That is unlikely and outside our control; buying a domain
is the fallback.

## 7. Audit

Vocabulary: `product.status`, `image.upload.request`, `image.upload.confirm`,
`image.reorder`, `image.delete`, `auth.login`, `auth.logout`, `apikey.create`,
`apikey.revoke`.

`recordAudit` already exists and is tested. One change beyond wiring:

**`recordAudit` must accept an optional transaction client.** It currently calls
`prisma.auditLog.create` directly, so the audit write sits outside the
operation's transaction — a crash between the two leaves a status change with no
record of who made it. Threading `tx` makes them atomic. This is the difference
between an audit log that can be relied on and one that is usually right.

Done on 2026-09-18: `recordAudit(input, db = prisma)` taking
`Pick<Prisma.TransactionClient, 'auditLog'>`. Backward compatible — every
existing call site keeps working unchanged.

### 7.1 The live defect in orders, and what fixing it costs

Reading the code to write this spec turned up that the problem is **already
live**, and worse than "the audit write is not transactional". In
`orders.service.ts` the four `recordAudit` calls sit **after** their
`$transaction` blocks close — lines **133, 159, 177 and 200**, against
transactions opening at 75, 152, 164 and 182 (`placeOrder`'s closes at 131, its
audit call is at 133):

```ts
const updated = await prisma.$transaction(async (tx) => { … })
await recordAudit({ actorId, action: 'order.paid', … })   // outside
```

So today, in production order code:

- the transaction commits and the process dies before `recordAudit` → an order
  is paid, fulfilled or cancelled with **nobody attached to it**;
- `recordAudit` throws → the state change has **already committed**, but the
  caller receives an error and will reasonably believe it did not.

**Decision 6: move all four calls inside their transactions and pass `tx`.**

The cost is real and worth stating plainly: an audit-write failure will then
**roll back the order state change**. Fulfilment can fail because logging
failed.

That sounds worse than it is. **`audit_log` lives in the same Postgres as
`orders`** — there is no plausible failure where the audit table is unwritable
but the order table is fine. The failure modes are correlated, so the apparent
trade between revenue and logging is largely illusory. Against that, an order
that silently transitions with no record of who moved it is exactly what this
table exists to prevent.

## 8. Issuing API keys

`src/scripts/create-api-key.ts` — takes an actor name and optional expiry,
creates the `Actor` (type `agent`) and `ApiKey` rows, and prints the plaintext
once to stdout. No UI, by §2. Lives under `src/` (not a top-level `scripts/`
directory) so the existing `tsconfig.build.json`/Dockerfile build the compiled
script into `dist/scripts/` with no separate build config.

## 9. Testing

| Layer | Verified |
|---|---|
| **Route coverage** | **Every mounted admin route returns 401 without credentials**, table-driven from the router stack |
| Sessions | Expired → 401; revoked → 401 |
| API keys | Revoked → 401; expired → 401; unknown prefix → 401 |
| Callback | `email_verified: false` rejected, **no Actor created**; email off allowlist rejected, **no Actor created** |
| CSRF | Cookie POST with absent or non-allowlisted `Origin` → 403; bearer request with no `Origin` → allowed |
| Audit | Row carries the correct `actorId`, `before` and `after` on a status change |
| **Public routes** | **`/api/v1/catalog/*` still returns 200 unauthenticated** |

Two of these carry most of the weight.

**The route-coverage test is table-driven from the mounted router deliberately.**
The realistic failure is not a broken check — it is an endpoint added next
quarter by someone who did not think about auth. Enumerating the router means
that fails the suite on the commit that introduces it, rather than in production.

**The public-route regression mirrors the Phase B slice's.** Adding auth must not
creep onto the catalog routes and take the storefront down, and that is exactly
the kind of breakage a later refactor introduces by accident.

## 10. Configuration

Render env groups, separate per environment (ADR-0004):

`GOOGLE_CLIENT_ID` · `GOOGLE_CLIENT_SECRET` · `ADMIN_ALLOWED_EMAILS` ·
`ADMIN_CONSOLE_ORIGIN` · `SESSION_TTL_HOURS` (default **12**)

There is no `BREAK_GLASS_KEY_HASH` — see §5.4.

Staging uses its own Google OAuth client. **Production credentials are connected
only with Jack's explicit approval**, per the standing rule.

## 11. admin-ui changes

- `credentials: 'include'` on every fetch in `src/data/api.js`.
- A sign-in screen.
- 401 → redirect to `/api/v1/auth/google/start`.
- No change to the 16-method API shape, so no component churn.

## 12. Risks

| Risk | Mitigation |
|---|---|
| An admin route ships without auth | Route-coverage test enumerates the router, so it fails on introduction |
| Auth creeps onto the public catalog routes | Explicit regression test |
| The PSL entry for `onrender.com` is withdrawn, silently removing the console's isolation | Verified present 2026-09-18 (§6.1); outside our control, fallback is buying a domain |
| Both founders locked out of admin | Mint a key over Render shell (§5.4). Tested once before it is needed, because an untested break-glass procedure is not one |
| Audit gaps on crash | `recordAudit` made transactional (§7), order call sites moved inside their transactions (§7.1) |
| An audit-write failure blocks order fulfilment | Accepted (§7.1). `audit_log` and `orders` share a database, so the failure modes are correlated and the trade is largely illusory |
| CORS drift silently disables CSRF defence | Layer 2 is server-side and independent of CORS |

## 13. Open questions

**None remain.** Every question raised during design has been ruled on.

| Settled | Where | Date |
|---|---|---|
| Humans + service credentials | §3.1 | 2026-09-18 |
| Google OIDC, email allowlist | §3.2 | 2026-09-18 |
| `AdminSession` naming | §4.1 | 2026-09-18 |
| Session lifetime — 12h absolute | §4.2 | 2026-09-18 |
| Console on an unrelated domain | §3.4, §6 | 2026-09-18 |
| Hostname — `alpinebrick-admin.onrender.com` | §6.1 | 2026-09-18 |
| Order audit transactionality | §7.1 | 2026-09-18 |
| No standing break-glass key | §5.4 | 2026-09-18 |

**Customer accounts**, when the storefront grows them, get their own spec and
their own tables. This is a decision, not an open question — recorded so it is
deliberate rather than inherited.

**Two items are out of this spec's scope and must not be forgotten:**

1. **CORS response headers.** This spec specifies Origin *validation* (§6).
   Emitting `Access-Control-Allow-Origin` / `Access-Control-Allow-Credentials`
   and handling preflight is not specified, because nothing is deployed
   cross-origin yet. **It must land before the console is deployed**, or the
   console cannot call core at all.
2. **Expired-session sweeping.** Sessions are rejected on read but never
   deleted. Harmless at two operators; it wants a scheduled job, alongside
   `sweepPendingImages`, which also has no scheduler.
