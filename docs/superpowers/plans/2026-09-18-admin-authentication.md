# Admin Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put authentication and audit logging in front of `/api/v1/admin/*`, so the admin surfaces can be deployed.

**Architecture:** One `requireAuth` middleware mounted on the `/api/v1/admin` prefix ahead of both admin routers, resolving either a session cookie or an `Authorization: Bearer` API key to a single `req.actor`. Humans sign in through Google OIDC behind an email allowlist; services present API keys. Credentials are stored only as SHA-256 hashes. Admin writes record an `AuditLog` row inside the same transaction as the change.

**Tech Stack:** TypeScript (strict, ESM), Express 4, Prisma 5 + PostgreSQL, Vitest + supertest. New dependencies: `cookie-parser`, `google-auth-library`.

**Spec:** `docs/superpowers/specs/2026-09-18-admin-authentication-design.md`

## Global Constraints

- **ESM imports carry `.js` extensions** — `import { prisma } from '../prisma.js'`. TypeScript source, JS extension. Every existing file does this; copying a Node-style extensionless import will fail at runtime while passing tests.
- **Error codes on `/api/v1/admin/*` are `UPPER_SNAKE`** (`NOT_FOUND`, `VALIDATION_ERROR`, `INVALID_TRANSITION`). `/api/v1/admin/images` uses `lower_snake` — a known inconsistency, **deliberately not changed here**.
- **API responses are camelCase.** Core does not adapt to the console; the console adapts to core.
- **Money is integer cents.** Not touched by this plan, but do not introduce floats anywhere.
- **Never log, print, or return credential plaintext** except the single creation-time print in Task 11.
- **Prisma columns/tables use `@map`/`@@map` to snake_case.** `tokenHash` → `token_hash`, `AdminSession` → `admin_sessions`.
- **Branch off `main`:** `git checkout -b feat/admin-auth main`. Never commit onto a branch you did not create.
- **Commit trailer:** every commit ends with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Conventional commits:** `feat(core):`, `fix(core):`, `test(core):`, `feat(admin-ui):`.
- **Session TTL default is 12 hours, absolute, no sliding window.** (Spec §4.2)
- **Cookie name is `ab_admin_session`. The model is `AdminSession`, the table `admin_sessions`.** (Spec §4.1)
- **`npm run typecheck` must pass.** A green vitest run does not mean the app compiles — vitest resolves TypeScript directly and never touches compiled output.

## Preconditions — all resolved

1. **Dependencies installed 2026-09-18** with Jack's approval:
   `cookie-parser@^1.4.7`, `google-auth-library@^11.1.0`,
   `@types/cookie-parser@^1.4.10`. Task 7 step 1 is therefore already done —
   skip it.
2. **Break-glass settled (spec §5.4):** Render offers shell access on our plan,
   confirmed by Jack 2026-09-18. **There is no standing key.** Task 11 builds
   the issuance script only.
3. **Local Postgres is available** — container `alpinebrick-core-db` on :5433.
   Start it with `docker start alpinebrick-core-db`. Do **not** use the root
   `docker-compose.yaml`; CLAUDE.md flags it as a pre-redesign mock.
   If Docker Desktop will not start, CI (`.github/workflows/ci.yml`) runs
   `postgres:16` as a service and is the verification of record.

**Baseline before Task 1:** core is at **172 tests across 27 files**, `tsc
--noEmit` clean, `npm run build` clean. Any drop is a regression you caused.

---

### Task 1: Schema — `AdminSession`, `ApiKey`, `Actor` columns

**Files:**
- Modify: `systems/core/prisma/schema.prisma`
- Create: `systems/core/prisma/migrations/<timestamp>_add_admin_auth/migration.sql`
- Modify: `systems/core/tests/helpers/db.ts`
- Test: `systems/core/tests/auth-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `AdminSession` and `ApiKey`; `Actor.email`, `Actor.googleSub`, `Actor.disabled`.

- [ ] **Step 1: Write the failing test**

```ts
// systems/core/tests/auth-schema.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'

beforeEach(resetDb)
afterAll(() => prisma.$disconnect())

describe('admin auth schema', () => {
  it('stores an admin session against an actor', async () => {
    const actor = await prisma.actor.create({ data: { type: 'human', name: 'jack' } })
    const s = await prisma.adminSession.create({
      data: {
        actorId: actor.id,
        tokenHash: 'hash-1',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    })
    expect(s.revokedAt).toBeNull()
    expect(s.actorId).toBe(actor.id)
  })

  it('rejects a duplicate session token hash', async () => {
    const actor = await prisma.actor.create({ data: { type: 'human', name: 'jack' } })
    const data = { actorId: actor.id, tokenHash: 'dupe', expiresAt: new Date(Date.now() + 1000) }
    await prisma.adminSession.create({ data })
    await expect(prisma.adminSession.create({ data })).rejects.toThrow()
  })

  it('stores an api key with a unique prefix and hash', async () => {
    const actor = await prisma.actor.create({ data: { type: 'agent', name: 'mcp-connector' } })
    const k = await prisma.apiKey.create({
      data: { actorId: actor.id, name: 'mcp', prefix: 'abcd1234', keyHash: 'kh-1' },
    })
    expect(k.revokedAt).toBeNull()
    expect(k.expiresAt).toBeNull()
  })

  // Nullable uniques must permit multiple NULLs, or the seeded 'system' actor
  // (which has no email and no googleSub) blocks every later actor.
  it('allows many actors with no email and no googleSub', async () => {
    await prisma.actor.create({ data: { type: 'human', name: 'a' } })
    await prisma.actor.create({ data: { type: 'human', name: 'b' } })
    const n = await prisma.actor.count()
    expect(n).toBe(2)
  })

  it('enforces a unique googleSub when present', async () => {
    await prisma.actor.create({ data: { type: 'human', name: 'a', googleSub: 'sub-1' } })
    await expect(
      prisma.actor.create({ data: { type: 'human', name: 'b', googleSub: 'sub-1' } }),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd systems/core && npx vitest run tests/auth-schema.test.ts`
Expected: FAIL — `prisma.adminSession` is undefined.

- [ ] **Step 3: Add the models to the schema**

Append to `systems/core/prisma/schema.prisma`:

```prisma
model AdminSession {
  id         String    @id @default(cuid())
  actorId    String    @map("actor_id")
  actor      Actor     @relation(fields: [actorId], references: [id])
  tokenHash  String    @unique @map("token_hash")
  expiresAt  DateTime  @map("expires_at")
  revokedAt  DateTime? @map("revoked_at")
  lastSeenAt DateTime? @map("last_seen_at")
  userAgent  String?   @map("user_agent")
  ip         String?
  createdAt  DateTime  @default(now()) @map("created_at")

  @@index([actorId])
  @@index([expiresAt])
  @@map("admin_sessions")
}

model ApiKey {
  id         String    @id @default(cuid())
  actorId    String    @map("actor_id")
  actor      Actor     @relation(fields: [actorId], references: [id])
  name       String
  prefix     String    @unique
  keyHash    String    @unique @map("key_hash")
  expiresAt  DateTime? @map("expires_at")
  revokedAt  DateTime? @map("revoked_at")
  lastUsedAt DateTime? @map("last_used_at")
  createdAt  DateTime  @default(now()) @map("created_at")

  @@index([actorId])
  @@map("api_keys")
}
```

And extend the existing `Actor` model — add these four lines inside it:

```prisma
  email     String?        @unique
  googleSub String?        @unique @map("google_sub")
  disabled  Boolean        @default(false)
  sessions  AdminSession[]
  apiKeys   ApiKey[]
```

- [ ] **Step 4: Generate the migration**

Run: `cd systems/core && npx prisma migrate dev --name add_admin_auth --create-only`

These changes are purely additive, so Prisma should not prompt for data loss. **If it prompts and hangs, there is no TTY** — hand-write `migration.sql` instead and apply it with `npx prisma migrate deploy`.

**Check the generated timestamp.** A migration whose name sorts before one it depends on breaks every fresh database. This has bitten this repo before (`add_walmart_channel` vs `add_orders`). The new migration must sort *last*.

- [ ] **Step 5: Apply and regenerate**

Run: `cd systems/core && npx prisma migrate deploy && npx prisma generate`

- [ ] **Step 6: Extend `resetDb`**

In `systems/core/tests/helpers/db.ts`, add these two lines **before** `await prisma.actor.deleteMany()`:

```ts
  await prisma.adminSession.deleteMany()
  await prisma.apiKey.deleteMany()
```

Order matters — both reference `actors`, so they must be cleared first or every test file fails on a foreign-key violation.

- [ ] **Step 7: Run the tests and the typecheck**

Run: `cd systems/core && npx vitest run tests/auth-schema.test.ts && npm run typecheck`
Expected: 5 passing, tsc clean.

- [ ] **Step 8: Run the whole suite**

Run: `cd systems/core && npx vitest run`
Expected: all previously-passing tests still pass. `resetDb` is used by nearly every file, so a mistake in step 6 shows up here.

- [ ] **Step 9: Commit**

```bash
git add systems/core/prisma systems/core/tests/helpers/db.ts systems/core/tests/auth-schema.test.ts
git commit -m "feat(core): schema for admin sessions and api keys

Additive only. Actor gains nullable unique email and googleSub plus a
disabled flag; the seeded 'system' actor has neither, and Postgres permits
multiple NULLs in a unique column, so it is unaffected.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Token primitives

**Files:**
- Create: `systems/core/src/auth/tokens.ts`
- Test: `systems/core/tests/auth-tokens.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `generateSessionToken(): string` · `hashToken(token: string): string` · `generateApiKey(): { plaintext: string; prefix: string; keyHash: string }` · `parseApiKey(header: string | undefined): { prefix: string; plaintext: string } | null` · `hashesEqual(a: string, b: string): boolean` · `API_KEY_PREFIX: 'abk'`

- [ ] **Step 1: Write the failing test**

```ts
// systems/core/tests/auth-tokens.test.ts
import { describe, it, expect } from 'vitest'
import {
  generateSessionToken, hashToken, generateApiKey, parseApiKey, hashesEqual, API_KEY_PREFIX,
} from '../src/auth/tokens.js'

describe('token primitives', () => {
  it('generates distinct high-entropy session tokens', () => {
    const a = generateSessionToken()
    const b = generateSessionToken()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(43)   // 32 bytes base64url
    expect(a).not.toMatch(/[+/=]/)                // base64url, safe in a cookie
  })

  it('hashes deterministically and irreversibly', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'))
    expect(hashToken('abc')).not.toBe(hashToken('abd'))
    expect(hashToken('abc')).toHaveLength(64)     // sha256 hex
    expect(hashToken('abc')).not.toContain('abc')
  })

  it('mints an api key whose stored hash is of the FULL plaintext', () => {
    const k = generateApiKey()
    expect(k.plaintext.startsWith(`${API_KEY_PREFIX}_`)).toBe(true)
    expect(k.plaintext.split('_')).toHaveLength(3)
    expect(k.prefix).toHaveLength(8)
    expect(k.keyHash).toBe(hashToken(k.plaintext))
    // The prefix is an identifier, not a secret, and must not be the hash input.
    expect(k.keyHash).not.toBe(hashToken(k.prefix))
  })

  it('parses a well-formed bearer header', () => {
    const k = generateApiKey()
    const parsed = parseApiKey(`Bearer ${k.plaintext}`)
    expect(parsed).toEqual({ prefix: k.prefix, plaintext: k.plaintext })
  })

  it('rejects malformed headers rather than guessing', () => {
    expect(parseApiKey(undefined)).toBeNull()
    expect(parseApiKey('')).toBeNull()
    expect(parseApiKey('Basic abc')).toBeNull()
    expect(parseApiKey('Bearer notakey')).toBeNull()
    expect(parseApiKey('Bearer xxx_abcd1234_secret')).toBeNull()  // wrong prefix
    expect(parseApiKey('Bearer abk__secret')).toBeNull()          // empty prefix
    expect(parseApiKey('Bearer abk_abcd1234_')).toBeNull()        // empty secret
  })

  it('compares equal-length hashes without leaking length mismatches', () => {
    expect(hashesEqual('a'.repeat(64), 'a'.repeat(64))).toBe(true)
    expect(hashesEqual('a'.repeat(64), 'b'.repeat(64))).toBe(false)
    expect(hashesEqual('short', 'a'.repeat(64))).toBe(false)      // must not throw
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd systems/core && npx vitest run tests/auth-tokens.test.ts`
Expected: FAIL — cannot resolve `../src/auth/tokens.js`.

- [ ] **Step 3: Implement**

```ts
// systems/core/src/auth/tokens.ts
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'

export const API_KEY_PREFIX = 'abk'

/** 32 random bytes, base64url so it is safe in a cookie without escaping. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * SHA-256, not Argon2. These are 256-bit random tokens, not user-chosen
 * passwords: there is no dictionary to attack, so a slow KDF buys nothing and
 * costs latency on every authenticated request. See spec §4.4.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export interface GeneratedApiKey {
  plaintext: string
  prefix: string
  keyHash: string
}

/**
 * Format: `abk_<prefix8>_<secret43>`. The prefix is an identifier, stored in
 * clear so a key can be named in logs and revoked; the hash covers the WHOLE
 * plaintext, so knowing a prefix reveals nothing.
 */
export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBytes(6).toString('base64url').slice(0, 8)
  const secret = randomBytes(32).toString('base64url')
  const plaintext = `${API_KEY_PREFIX}_${prefix}_${secret}`
  return { plaintext, prefix, keyHash: hashToken(plaintext) }
}

export function parseApiKey(header: string | undefined): { prefix: string; plaintext: string } | null {
  if (!header) return null
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim())
  if (!m) return null
  const plaintext = m[1]
  const parts = plaintext.split('_')
  if (parts.length !== 3) return null
  const [scheme, prefix, secret] = parts
  if (scheme !== API_KEY_PREFIX || !prefix || !secret) return null
  return { prefix, plaintext }
}

/** Constant-time for equal-length inputs; length mismatch is not secret. */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd systems/core && npx vitest run tests/auth-tokens.test.ts && npm run typecheck`
Expected: 6 passing, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add systems/core/src/auth/tokens.ts systems/core/tests/auth-tokens.test.ts
git commit -m "feat(core): credential token primitives

SHA-256 rather than Argon2: these are 256-bit random tokens, not passwords.
The api key hash covers the full plaintext, never the prefix, so the prefix
can be stored in clear for identification and revocation.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Session service

**Files:**
- Create: `systems/core/src/auth/session.service.ts`
- Test: `systems/core/tests/auth-session.test.ts`

**Interfaces:**
- Consumes: `generateSessionToken`, `hashToken` from `../auth/tokens.js`.
- Produces: `SESSION_COOKIE: 'ab_admin_session'` · `sessionTtlMs(): number` · `createSession(actorId: string, meta?: { userAgent?: string; ip?: string }): Promise<{ token: string; expiresAt: Date }>` · `resolveSession(token: string): Promise<AuthActor | null>` · `revokeSession(token: string): Promise<void>` · `interface AuthActor { id: string; type: 'human' | 'agent'; name: string }`

- [ ] **Step 1: Write the failing test**

```ts
// systems/core/tests/auth-session.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createSession, resolveSession, revokeSession, sessionTtlMs } from '../src/auth/session.service.js'
import { hashToken } from '../src/auth/tokens.js'

beforeEach(resetDb)
afterAll(() => prisma.$disconnect())

const mkActor = () => prisma.actor.create({ data: { type: 'human', name: 'jack' } })

describe('session service', () => {
  it('creates a session and resolves it back to its actor', async () => {
    const actor = await mkActor()
    const { token } = await createSession(actor.id)
    const resolved = await resolveSession(token)
    expect(resolved).toEqual({ id: actor.id, type: 'human', name: 'jack' })
  })

  // The row must never hold anything that could be replayed as a credential.
  it('stores only the hash, never the token', async () => {
    const actor = await mkActor()
    const { token } = await createSession(actor.id)
    const rows = await prisma.adminSession.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0].tokenHash).toBe(hashToken(token))
    expect(JSON.stringify(rows[0])).not.toContain(token)
  })

  it('refuses an expired session', async () => {
    const actor = await mkActor()
    const { token } = await createSession(actor.id)
    await prisma.adminSession.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } })
    expect(await resolveSession(token)).toBeNull()
  })

  it('refuses a revoked session', async () => {
    const actor = await mkActor()
    const { token } = await createSession(actor.id)
    await revokeSession(token)
    expect(await resolveSession(token)).toBeNull()
  })

  it('refuses a session whose actor is disabled', async () => {
    const actor = await mkActor()
    const { token } = await createSession(actor.id)
    await prisma.actor.update({ where: { id: actor.id }, data: { disabled: true } })
    expect(await resolveSession(token)).toBeNull()
  })

  it('refuses an unknown token', async () => {
    expect(await resolveSession('nonsense')).toBeNull()
  })

  it('defaults to a 12 hour ttl and ignores rubbish config', async () => {
    delete process.env.SESSION_TTL_HOURS
    expect(sessionTtlMs()).toBe(12 * 3600_000)
    process.env.SESSION_TTL_HOURS = '1'
    expect(sessionTtlMs()).toBe(3600_000)
    process.env.SESSION_TTL_HOURS = 'banana'
    expect(sessionTtlMs()).toBe(12 * 3600_000)
    process.env.SESSION_TTL_HOURS = '-5'
    expect(sessionTtlMs()).toBe(12 * 3600_000)
    delete process.env.SESSION_TTL_HOURS
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd systems/core && npx vitest run tests/auth-session.test.ts`
Expected: FAIL — cannot resolve `../src/auth/session.service.js`.

- [ ] **Step 3: Implement**

```ts
// systems/core/src/auth/session.service.ts
import { prisma } from '../prisma.js'
import { generateSessionToken, hashToken } from './tokens.js'

export const SESSION_COOKIE = 'ab_admin_session'

export interface AuthActor {
  id: string
  type: 'human' | 'agent'
  name: string
}

/**
 * 12 hours, absolute, no sliding window (spec §4.2). Anything unparseable or
 * non-positive falls back to the default rather than producing a session that
 * never expires or expires instantly.
 */
export function sessionTtlMs(): number {
  const raw = Number(process.env.SESSION_TTL_HOURS)
  const hours = Number.isFinite(raw) && raw > 0 ? raw : 12
  return hours * 3600_000
}

export async function createSession(
  actorId: string,
  meta: { userAgent?: string; ip?: string } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken()
  const expiresAt = new Date(Date.now() + sessionTtlMs())
  await prisma.adminSession.create({
    data: {
      actorId,
      tokenHash: hashToken(token),
      expiresAt,
      userAgent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
    },
  })
  return { token, expiresAt }
}

export async function resolveSession(token: string): Promise<AuthActor | null> {
  if (!token) return null
  const row = await prisma.adminSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { actor: true },
  })
  if (!row) return null
  if (row.revokedAt) return null
  if (row.expiresAt.getTime() <= Date.now()) return null
  if (row.actor.disabled) return null

  // Best effort: a failed touch must not fail the request.
  void prisma.adminSession
    .update({ where: { id: row.id }, data: { lastSeenAt: new Date() } })
    .catch(() => undefined)

  return { id: row.actor.id, type: row.actor.type, name: row.actor.name }
}

export async function revokeSession(token: string): Promise<void> {
  if (!token) return
  await prisma.adminSession.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  })
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd systems/core && npx vitest run tests/auth-session.test.ts && npm run typecheck`
Expected: 7 passing, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add systems/core/src/auth/session.service.ts systems/core/tests/auth-session.test.ts
git commit -m "feat(core): admin session service

12h absolute expiry, no sliding window: with Google SSO re-auth is a redirect
and often zero clicks, so the usual convenience argument for long sessions
does not apply to a full-admin credential.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: API key service

**Files:**
- Create: `systems/core/src/auth/apikey.service.ts`
- Test: `systems/core/tests/auth-apikey.test.ts`

**Interfaces:**
- Consumes: `generateApiKey`, `parseApiKey`, `hashToken`, `hashesEqual` from `./tokens.js`; `AuthActor` from `./session.service.js`.
- Produces: `createApiKey(opts: { actorName: string; keyName: string; expiresAt?: Date | null }): Promise<{ plaintext: string; id: string; actorId: string }>` · `resolveApiKey(header: string | undefined): Promise<AuthActor | null>`

- [ ] **Step 1: Write the failing test**

```ts
// systems/core/tests/auth-apikey.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createApiKey, resolveApiKey } from '../src/auth/apikey.service.js'

beforeEach(resetDb)
afterAll(() => prisma.$disconnect())

describe('api key service', () => {
  it('mints a key that resolves to a new agent actor', async () => {
    const { plaintext, actorId } = await createApiKey({ actorName: 'mcp-connector', keyName: 'mcp' })
    const resolved = await resolveApiKey(`Bearer ${plaintext}`)
    expect(resolved).toEqual({ id: actorId, type: 'agent', name: 'mcp-connector' })
  })

  it('stores only the hash, never the plaintext', async () => {
    const { plaintext } = await createApiKey({ actorName: 'a', keyName: 'k' })
    const rows = await prisma.apiKey.findMany()
    expect(JSON.stringify(rows)).not.toContain(plaintext.split('_')[2])
  })

  it('refuses a revoked key', async () => {
    const { plaintext, id } = await createApiKey({ actorName: 'a', keyName: 'k' })
    await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } })
    expect(await resolveApiKey(`Bearer ${plaintext}`)).toBeNull()
  })

  it('refuses an expired key', async () => {
    const { plaintext, id } = await createApiKey({ actorName: 'a', keyName: 'k' })
    await prisma.apiKey.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect(await resolveApiKey(`Bearer ${plaintext}`)).toBeNull()
  })

  it('refuses a key whose actor is disabled', async () => {
    const { plaintext, actorId } = await createApiKey({ actorName: 'a', keyName: 'k' })
    await prisma.actor.update({ where: { id: actorId }, data: { disabled: true } })
    expect(await resolveApiKey(`Bearer ${plaintext}`)).toBeNull()
  })

  it('refuses an unknown prefix and a tampered secret', async () => {
    const { plaintext } = await createApiKey({ actorName: 'a', keyName: 'k' })
    expect(await resolveApiKey('Bearer abk_zzzzzzzz_whatever')).toBeNull()
    // Right prefix, wrong secret -- the case a prefix-only lookup would pass.
    const [scheme, prefix] = plaintext.split('_')
    expect(await resolveApiKey(`Bearer ${scheme}_${prefix}_wrongsecret`)).toBeNull()
  })

  it('refuses a missing or malformed header', async () => {
    expect(await resolveApiKey(undefined)).toBeNull()
    expect(await resolveApiKey('Bearer junk')).toBeNull()
  })

  it('records last use', async () => {
    const { plaintext, id } = await createApiKey({ actorName: 'a', keyName: 'k' })
    expect((await prisma.apiKey.findUnique({ where: { id } }))!.lastUsedAt).toBeNull()
    await resolveApiKey(`Bearer ${plaintext}`)
    // Written best-effort and not awaited by the caller, so settle first.
    await new Promise(r => setTimeout(r, 50))
    expect((await prisma.apiKey.findUnique({ where: { id } }))!.lastUsedAt).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd systems/core && npx vitest run tests/auth-apikey.test.ts`
Expected: FAIL — cannot resolve `../src/auth/apikey.service.js`.

- [ ] **Step 3: Implement**

```ts
// systems/core/src/auth/apikey.service.ts
import { prisma } from '../prisma.js'
import { generateApiKey, parseApiKey, hashToken, hashesEqual } from './tokens.js'
import type { AuthActor } from './session.service.js'

export async function createApiKey(opts: {
  actorName: string
  keyName: string
  expiresAt?: Date | null
}): Promise<{ plaintext: string; id: string; actorId: string }> {
  const { plaintext, prefix, keyHash } = generateApiKey()
  const actor = await prisma.actor.create({ data: { type: 'agent', name: opts.actorName } })
  const row = await prisma.apiKey.create({
    data: {
      actorId: actor.id,
      name: opts.keyName,
      prefix,
      keyHash,
      expiresAt: opts.expiresAt ?? null,
    },
  })
  return { plaintext, id: row.id, actorId: actor.id }
}

export async function resolveApiKey(header: string | undefined): Promise<AuthActor | null> {
  const parsed = parseApiKey(header)
  if (!parsed) return null

  const row = await prisma.apiKey.findUnique({
    where: { prefix: parsed.prefix },
    include: { actor: true },
  })
  if (!row) return null

  // The prefix only narrows the lookup. The secret is what authenticates, and
  // it is compared in constant time against the stored hash.
  if (!hashesEqual(row.keyHash, hashToken(parsed.plaintext))) return null

  if (row.revokedAt) return null
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null
  if (row.actor.disabled) return null

  void prisma.apiKey
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined)

  return { id: row.actor.id, type: row.actor.type, name: row.actor.name }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd systems/core && npx vitest run tests/auth-apikey.test.ts && npm run typecheck`
Expected: 8 passing, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add systems/core/src/auth/apikey.service.ts systems/core/tests/auth-apikey.test.ts
git commit -m "feat(core): api key service

The prefix narrows the lookup; the secret authenticates, compared in constant
time against the stored hash. A right-prefix/wrong-secret key is rejected --
the case a prefix-only lookup would wave through.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `requireAuth` middleware and mounting

**Files:**
- Create: `systems/core/src/auth/require-auth.ts`
- Modify: `systems/core/src/app.ts`
- Test: `systems/core/tests/auth-route-coverage.test.ts`

**Interfaces:**
- Consumes: `resolveSession`, `SESSION_COOKIE`, `AuthActor` from `./session.service.js`; `resolveApiKey` from `./apikey.service.js`.
- Produces: `requireAuth: RequestHandler`; `req.actor?: AuthActor` on every `/api/v1/admin/*` request.

**This is the task the spec calls out as a trap (§5.1).** `app.ts` mounts `/api/v1/admin/images` *before* `/api/v1/admin`, and Express matches in registration order. `requireAuth` must be attached to the prefix **ahead of both routers**, or image reorder and delete stay wide open while the catalog routes look protected.

- [ ] **Step 1: Write the failing test**

```ts
// systems/core/tests/auth-route-coverage.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createSession } from '../src/auth/session.service.js'
import { SESSION_COOKIE } from '../src/auth/session.service.js'

const app = buildApp()

beforeEach(resetDb)
afterAll(() => prisma.$disconnect())

/**
 * Enumerated from the mounted router rather than hand-listed. The realistic
 * failure is not a broken check -- it is an endpoint added later by someone who
 * did not think about auth. Built this way, that fails here on the commit that
 * introduces it.
 */
function mountedAdminRoutes(): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = []
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) {
          out.push({ method: m, path: prefix + layer.route.path })
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        const src = layer.regexp?.source ?? ''
        const seg = src
          .replace('^\\/', '/').replace('\\/?(?=\\/|$)', '')
          .replace(/\\\//g, '/').replace(/\$$/, '')
        walk(layer.handle.stack, prefix + (seg === '/' ? '' : seg))
      }
    }
  }
  walk((app as any)._router.stack, '')
  return out.filter(r => r.path.startsWith('/api/v1/admin'))
}

describe('admin route auth coverage', () => {
  it('finds both admin routers mounted', () => {
    const routes = mountedAdminRoutes()
    expect(routes.length).toBeGreaterThan(0)
    // Guards the trap in spec 5.1: images mounts FIRST and must be covered.
    expect(routes.some(r => r.path.startsWith('/api/v1/admin/images'))).toBe(true)
    expect(routes.some(r => r.path.startsWith('/api/v1/admin/products'))).toBe(true)
  })

  it('every mounted admin route rejects an unauthenticated request', async () => {
    const routes = mountedAdminRoutes()
    const failures: string[] = []
    for (const r of routes) {
      const path = r.path.replace(/:[A-Za-z]+/g, 'x')
      const res = await (request(app) as any)[r.method](path).send({})
      if (res.status !== 401) failures.push(`${r.method.toUpperCase()} ${path} -> ${res.status}`)
    }
    expect(failures).toEqual([])
  })

  it('accepts a valid session cookie', async () => {
    const actor = await prisma.actor.create({ data: { type: 'human', name: 'jack' } })
    const { token } = await createSession(actor.id)
    const res = await request(app)
      .get('/api/v1/admin/products')
      .set('Cookie', `${SESSION_COOKIE}=${token}`)
    expect(res.status).toBe(200)
  })

  // The regression that would take the storefront down.
  it('leaves the public catalog routes unauthenticated', async () => {
    const res = await request(app).get('/api/v1/catalog/products')
    expect(res.status).toBe(200)
  })

  it('leaves health unauthenticated', async () => {
    expect((await request(app).get('/health')).status).toBe(200)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd systems/core && npx vitest run tests/auth-route-coverage.test.ts`
Expected: FAIL — every admin route returns 200, not 401.

- [ ] **Step 3a: Extract the cookie reader into its own module**

Task 8 needs this too. Defining it twice would be verbatim duplication of
credential-parsing logic — the kind most likely to drift apart.

```ts
// systems/core/src/auth/cookies.ts

/**
 * Reads one cookie from a raw Cookie header without cookie-parser, so this
 * works in tests that mount a router standalone rather than building the app.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}
```

- [ ] **Step 3b: Implement the middleware**

```ts
// systems/core/src/auth/require-auth.ts
import type { RequestHandler } from 'express'
import { resolveSession, SESSION_COOKIE, type AuthActor } from './session.service.js'
import { resolveApiKey } from './apikey.service.js'
import { readCookie } from './cookies.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: AuthActor
    }
  }
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  const auth = req.headers.authorization
  const actor = auth
    ? await resolveApiKey(auth)
    : await resolveSession(readCookie(req.headers.cookie, SESSION_COOKIE) ?? '')

  if (!actor) {
    res.status(401).json({ code: 'UNAUTHENTICATED', message: 'authentication required' })
    return
  }
  req.actor = actor
  next()
}
```

- [ ] **Step 4: Mount it ahead of both admin routers**

In `systems/core/src/app.ts`, replace the two admin mounts with:

```ts
  // MUST come before both admin routers. Express matches in registration
  // order, and /api/v1/admin/images is registered first -- attaching auth to
  // the catalog router alone would leave image reorder and delete open while
  // looking correct in review. See spec 5.1.
  app.use('/api/v1/admin', requireAuth)
  app.use('/api/v1/admin/images', createAssetsRouter(storagePort))
  app.use('/api/v1/admin', adminCatalogRouter)
```

And add the import at the top:

```ts
import { requireAuth } from './auth/require-auth.js'
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `cd systems/core && npx vitest run tests/auth-route-coverage.test.ts && npm run typecheck`
Expected: 5 passing, tsc clean.

- [ ] **Step 6: Fix the now-failing existing admin tests**

`tests/admin-routes.test.ts` and `tests/assets-routes.test.ts` call admin endpoints over HTTP with no credentials and will now get 401.

**Only those two.** `admin-status.test.ts`, `admin-overview.test.ts` and
`admin-catalog-service.test.ts` call the services directly and never construct
a request, so auth does not touch them. Do not add cookies there.

Add this helper to each and attach the cookie to every admin request:

```ts
import { createSession, SESSION_COOKIE } from '../src/auth/session.service.js'

async function authCookie(): Promise<string> {
  const actor = await prisma.actor.create({ data: { type: 'human', name: 'test-admin' } })
  const { token } = await createSession(actor.id)
  return `${SESSION_COOKIE}=${token}`
}
```

Then: `await request(app).get('/api/v1/admin/products').set('Cookie', await authCookie())`

**Do not weaken the middleware to keep these green.** Their failing is the middleware working.

- [ ] **Step 7: Run the whole suite**

Run: `cd systems/core && npx vitest run && npm run typecheck`
Expected: everything passes.

- [ ] **Step 8: Commit**

```bash
git add systems/core/src/auth/require-auth.ts systems/core/src/auth/cookies.ts systems/core/src/app.ts systems/core/tests
git commit -m "feat(core): require authentication on every admin route

Mounted on the /api/v1/admin prefix ahead of BOTH admin routers. Express
matches in registration order and /api/v1/admin/images registers first, so
auth attached to the catalog router alone would have left image reorder and
delete open while looking correct in review.

The coverage test enumerates routes from the mounted router rather than a
hand-written list, so an endpoint added later without auth fails on the commit
that introduces it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Origin validation (CSRF layer 2)

**Files:**
- Create: `systems/core/src/auth/require-origin.ts`
- Modify: `systems/core/src/app.ts`
- Test: `systems/core/tests/auth-origin.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `allowedOrigins(): string[]` · `requireOrigin: RequestHandler`

The console sits on an unrelated domain, so the cookie is `SameSite=None` and contributes nothing to CSRF defence (spec §6). This is the load-bearing replacement: it is server-side and does not depend on a browser choosing to enforce CORS.

- [ ] **Step 1: Write the failing test**

```ts
// systems/core/tests/auth-origin.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createSession, SESSION_COOKIE } from '../src/auth/session.service.js'
import { createApiKey } from '../src/auth/apikey.service.js'

const app = buildApp()
const ORIGIN = 'https://alpinebrick-admin.onrender.com'

beforeEach(async () => {
  await resetDb()
  process.env.ADMIN_CONSOLE_ORIGIN = ORIGIN
})
afterAll(async () => {
  delete process.env.ADMIN_CONSOLE_ORIGIN
  await prisma.$disconnect()
})

async function cookie(): Promise<string> {
  const actor = await prisma.actor.create({ data: { type: 'human', name: 'jack' } })
  const { token } = await createSession(actor.id)
  return `${SESSION_COOKIE}=${token}`
}

describe('origin validation', () => {
  it('allows a cookie POST from the allowlisted origin', async () => {
    const res = await request(app)
      .post('/api/v1/admin/products/nope/status')
      .set('Cookie', await cookie()).set('Origin', ORIGIN)
      .send({ status: 'published' })
    expect(res.status).not.toBe(403)   // 404 for the missing product is fine
  })

  it('rejects a cookie POST from another origin', async () => {
    const res = await request(app)
      .post('/api/v1/admin/products/nope/status')
      .set('Cookie', await cookie()).set('Origin', 'https://evil.example')
      .send({ status: 'published' })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('FORBIDDEN_ORIGIN')
  })

  it('rejects a cookie POST with no Origin at all', async () => {
    const res = await request(app)
      .post('/api/v1/admin/products/nope/status')
      .set('Cookie', await cookie())
      .send({ status: 'published' })
    expect(res.status).toBe(403)
  })

  // Not browser-driven, carries no Origin, protected by possession of the key.
  it('allows a bearer POST with no Origin', async () => {
    const { plaintext } = await createApiKey({ actorName: 'svc', keyName: 'k' })
    const res = await request(app)
      .post('/api/v1/admin/products/nope/status')
      .set('Authorization', `Bearer ${plaintext}`)
      .send({ status: 'published' })
    expect(res.status).not.toBe(403)
  })

  it('does not gate GET requests', async () => {
    const res = await request(app).get('/api/v1/admin/products').set('Cookie', await cookie())
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd systems/core && npx vitest run tests/auth-origin.test.ts`
Expected: FAIL — the cross-origin POST is not rejected.

- [ ] **Step 3: Implement**

```ts
// systems/core/src/auth/require-origin.ts
import type { RequestHandler } from 'express'

export function allowedOrigins(): string[] {
  return (process.env.ADMIN_CONSOLE_ORIGIN ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * The console is on an unrelated domain, so the session cookie is
 * SameSite=None and the attribute itself defends nothing. This check is
 * server-side and therefore holds even if the CORS configuration drifts or a
 * client declines to enforce it.
 *
 * Bearer requests are exempt: they are not browser-driven, carry no Origin,
 * and are protected by possession of the key.
 */
export const requireOrigin: RequestHandler = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next()
  if (req.headers.authorization) return next()

  const origin = req.headers.origin
  const allowed = allowedOrigins()
  if (typeof origin === 'string' && allowed.includes(origin)) return next()

  res.status(403).json({ code: 'FORBIDDEN_ORIGIN', message: 'origin not allowed' })
}
```

- [ ] **Step 4: Mount it immediately after `requireAuth`**

In `systems/core/src/app.ts`:

```ts
import { requireOrigin } from './auth/require-origin.js'
// …
  app.use('/api/v1/admin', requireAuth)
  app.use('/api/v1/admin', requireOrigin)
```

- [ ] **Step 5: Run tests and typecheck**

Run: `cd systems/core && npx vitest run tests/auth-origin.test.ts && npm run typecheck`
Expected: 5 passing, tsc clean.

- [ ] **Step 6: Fix the existing admin tests again**

The POST-based tests in `tests/admin-status.test.ts` and `tests/assets-routes.test.ts` now need `.set('Origin', process.env.ADMIN_CONSOLE_ORIGIN!)` with the env var set in `beforeEach`, **or** switch those tests to a bearer key. Prefer setting the Origin — it exercises the browser path the console actually uses.

- [ ] **Step 7: Run the whole suite and commit**

```bash
cd systems/core && npx vitest run && npm run typecheck
git add systems/core/src/auth/require-origin.ts systems/core/src/app.ts systems/core/tests
git commit -m "feat(core): server-side origin validation on admin writes

The console lives on an unrelated domain, so the session cookie is
SameSite=None and the attribute defends nothing. This check does not depend on
the browser enforcing CORS, so it still holds if the CORS config drifts.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Google OIDC port and adapter

**Blocked on `npm install` approval.** See Preconditions.

**Files:**
- Create: `systems/core/src/ports/oidc/oidc.port.ts`
- Create: `systems/core/src/ports/oidc/google.adapter.ts`
- Create: `systems/core/src/ports/oidc/fake.adapter.ts`
- Test: `systems/core/tests/oidc-fake-adapter.test.ts`

This mirrors `src/ports/storage/` and `src/ports/tax/` exactly — the pattern this codebase already uses to keep a vendor behind an interface and out of the tests.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface GoogleIdentity { sub: string; email: string; emailVerified: boolean; name?: string }`
  - `interface OidcPort { authUrl(opts: { state: string; codeChallenge: string }): string; exchange(opts: { code: string; codeVerifier: string }): Promise<GoogleIdentity> }`
  - `createGoogleOidcPort(): OidcPort` · `createFakeOidcPort(identity: GoogleIdentity): OidcPort`

- [x] **Step 1: Install the dependencies** — **already done 2026-09-18.**

`cookie-parser@^1.4.7`, `google-auth-library@^11.1.0`,
`@types/cookie-parser@^1.4.10` are in `systems/core/package.json`. Verify with
`npm ls cookie-parser google-auth-library` rather than reinstalling.

- [ ] **Step 2: Write the port and the fake**

```ts
// systems/core/src/ports/oidc/oidc.port.ts
export interface GoogleIdentity {
  sub: string
  email: string
  emailVerified: boolean
  name?: string
}

export interface OidcPort {
  authUrl(opts: { state: string; codeChallenge: string }): string
  exchange(opts: { code: string; codeVerifier: string }): Promise<GoogleIdentity>
}
```

```ts
// systems/core/src/ports/oidc/fake.adapter.ts
import type { OidcPort, GoogleIdentity } from './oidc.port.js'

/** Test double. Never registered by app.ts. */
export function createFakeOidcPort(identity: GoogleIdentity): OidcPort {
  return {
    authUrl: ({ state }) => `https://accounts.example/fake?state=${encodeURIComponent(state)}`,
    exchange: async ({ code }) => {
      if (code === 'bad-code') throw new Error('invalid_grant')
      return identity
    },
  }
}
```

- [ ] **Step 3: Write the Google adapter**

```ts
// systems/core/src/ports/oidc/google.adapter.ts
import { OAuth2Client } from 'google-auth-library'
import type { OidcPort, GoogleIdentity } from './oidc.port.js'

export function createGoogleOidcPort(): OidcPort {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? ''
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri })

  return {
    authUrl: ({ state, codeChallenge }) =>
      client.generateAuthUrl({
        scope: ['openid', 'email', 'profile'],
        state,
        code_challenge_method: 'S256' as any,
        code_challenge: codeChallenge,
        prompt: 'select_account',
      }),

    exchange: async ({ code, codeVerifier }): Promise<GoogleIdentity> => {
      const { tokens } = await client.getToken({ code, codeVerifier })
      if (!tokens.id_token) throw new Error('no id_token in token response')
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId })
      const p = ticket.getPayload()
      if (!p?.sub || !p.email) throw new Error('id_token missing sub or email')
      return {
        sub: p.sub,
        email: p.email,
        emailVerified: p.email_verified === true,
        name: p.name,
      }
    },
  }
}
```

- [ ] **Step 4: Test the fake, and that the real adapter constructs**

```ts
// systems/core/tests/oidc-fake-adapter.test.ts
import { describe, it, expect } from 'vitest'
import { createFakeOidcPort } from '../src/ports/oidc/fake.adapter.js'
import { createGoogleOidcPort } from '../src/ports/oidc/google.adapter.js'

const identity = { sub: 's-1', email: 'jack@example.com', emailVerified: true, name: 'Jack' }

describe('oidc port', () => {
  it('fake round-trips an identity and carries state into the url', async () => {
    const port = createFakeOidcPort(identity)
    expect(port.authUrl({ state: 'st 1', codeChallenge: 'cc' })).toContain('state=st%201')
    expect(await port.exchange({ code: 'ok', codeVerifier: 'v' })).toEqual(identity)
  })

  it('fake rejects a bad code', async () => {
    const port = createFakeOidcPort(identity)
    await expect(port.exchange({ code: 'bad-code', codeVerifier: 'v' })).rejects.toThrow()
  })

  // Construction must not require live credentials, or importing app.ts in a
  // test would need a Google client.
  it('the real adapter constructs with no environment set', () => {
    expect(() => createGoogleOidcPort()).not.toThrow()
  })
})
```

- [ ] **Step 5: Run and commit**

```bash
cd systems/core && npx vitest run tests/oidc-fake-adapter.test.ts && npm run typecheck
git add systems/core/src/ports/oidc systems/core/tests/oidc-fake-adapter.test.ts systems/core/package.json systems/core/package-lock.json
git commit -m "feat(core): google oidc behind a port

Mirrors ports/storage and ports/tax: the vendor stays behind an interface so
the auth route tests need no network and no Google credentials.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Auth routes

**Files:**
- Create: `systems/core/src/auth/auth.routes.ts`
- Modify: `systems/core/src/app.ts`
- Test: `systems/core/tests/auth-routes.test.ts`

**Interfaces:**
- Consumes: `OidcPort` from `../ports/oidc/oidc.port.js`; `createSession`, `revokeSession`, `SESSION_COOKIE`, `sessionTtlMs`; `requireAuth`.
- Produces: `createAuthRouter(oidc: OidcPort): Router` mounted at `/api/v1/auth`.

The OAuth `state` and PKCE verifier are carried in a short-lived httpOnly cookie (`ab_oauth_tx`, 10 minutes) rather than a database table — there is nothing to reconcile and nothing to sweep.

- [ ] **Step 1: Write the failing test**

```ts
// systems/core/tests/auth-routes.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createAuthRouter } from '../src/auth/auth.routes.js'
import { createFakeOidcPort } from '../src/ports/oidc/fake.adapter.js'
import { SESSION_COOKIE } from '../src/auth/session.service.js'

const IDENTITY = { sub: 'google-sub-1', email: 'jack@example.com', emailVerified: true, name: 'Jack' }

function appWith(identity = IDENTITY) {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/auth', createAuthRouter(createFakeOidcPort(identity)))
  return app
}

beforeEach(async () => {
  await resetDb()
  process.env.ADMIN_ALLOWED_EMAILS = 'jack@example.com'
  process.env.ADMIN_CONSOLE_ORIGIN = 'https://console.example'
})
afterAll(async () => {
  delete process.env.ADMIN_ALLOWED_EMAILS
  delete process.env.ADMIN_CONSOLE_ORIGIN
  await prisma.$disconnect()
})

/** Drives start -> callback, carrying the transaction cookie across. */
async function signIn(app: express.Express, code = 'ok') {
  const start = await request(app).get('/api/v1/auth/google/start')
  const txCookie = (start.headers['set-cookie'] as unknown as string[])[0].split(';')[0]
  const url = new URL(start.headers.location)
  const state = url.searchParams.get('state')!
  return request(app)
    .get(`/api/v1/auth/google/callback?code=${code}&state=${encodeURIComponent(state)}`)
    .set('Cookie', txCookie)
}

describe('auth routes', () => {
  it('redirects to the provider and sets a transaction cookie', async () => {
    const res = await request(appWith()).get('/api/v1/auth/google/start')
    expect(res.status).toBe(302)
    expect(res.headers.location).toContain('state=')
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toContain('ab_oauth_tx')
  })

  it('signs in an allowlisted, verified email', async () => {
    const app = appWith()
    const res = await signIn(app)
    expect(res.status).toBe(302)
    const setCookie = (res.headers['set-cookie'] as unknown as string[]).join(';')
    expect(setCookie).toContain(SESSION_COOKIE)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=None')
    expect(setCookie).toContain('Secure')

    const actor = await prisma.actor.findFirst({ where: { googleSub: 'google-sub-1' } })
    expect(actor?.email).toBe('jack@example.com')
    expect(await prisma.adminSession.count()).toBe(1)
  })

  it('refuses an unverified email and creates no actor', async () => {
    const app = appWith({ ...IDENTITY, emailVerified: false })
    const res = await signIn(app)
    expect(res.status).toBe(403)
    expect(await prisma.actor.count()).toBe(0)
    expect(await prisma.adminSession.count()).toBe(0)
  })

  it('refuses an email off the allowlist and creates no actor', async () => {
    const app = appWith({ ...IDENTITY, email: 'stranger@example.com' })
    const res = await signIn(app)
    expect(res.status).toBe(403)
    expect(await prisma.actor.count()).toBe(0)
  })

  it('refuses a mismatched state', async () => {
    const app = appWith()
    const start = await request(app).get('/api/v1/auth/google/start')
    const txCookie = (start.headers['set-cookie'] as unknown as string[])[0].split(';')[0]
    const res = await request(app)
      .get('/api/v1/auth/google/callback?code=ok&state=tampered')
      .set('Cookie', txCookie)
    expect(res.status).toBe(400)
    expect(await prisma.adminSession.count()).toBe(0)
  })

  // The identity key is sub, not email: an email can be reassigned.
  it('keys the actor on sub, so a changed email updates rather than duplicates', async () => {
    await signIn(appWith())
    process.env.ADMIN_ALLOWED_EMAILS = 'jack@example.com,jack2@example.com'
    await signIn(appWith({ ...IDENTITY, email: 'jack2@example.com' }))
    expect(await prisma.actor.count()).toBe(1)
    const actor = await prisma.actor.findFirst()
    expect(actor?.email).toBe('jack2@example.com')
  })

  it('logout revokes the session', async () => {
    const app = appWith()
    const res = await signIn(app)
    const session = (res.headers['set-cookie'] as unknown as string[])
      .find(c => c.startsWith(SESSION_COOKIE))!.split(';')[0]
    await request(app).post('/api/v1/auth/logout').set('Cookie', session).expect(204)
    const row = await prisma.adminSession.findFirst()
    expect(row?.revokedAt).not.toBeNull()
  })

  it('me returns the signed-in actor and 401 without a session', async () => {
    const app = appWith()
    const res = await signIn(app)
    const session = (res.headers['set-cookie'] as unknown as string[])
      .find(c => c.startsWith(SESSION_COOKIE))!.split(';')[0]
    const me = await request(app).get('/api/v1/auth/me').set('Cookie', session)
    expect(me.status).toBe(200)
    expect(me.body.name).toBe('Jack')
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd systems/core && npx vitest run tests/auth-routes.test.ts`
Expected: FAIL — cannot resolve `../src/auth/auth.routes.js`.

- [ ] **Step 3: Implement**

```ts
// systems/core/src/auth/auth.routes.ts
import { Router } from 'express'
import { randomBytes, createHash } from 'node:crypto'
import type { OidcPort } from '../ports/oidc/oidc.port.js'
import { prisma } from '../prisma.js'
import { createSession, revokeSession, sessionTtlMs, SESSION_COOKIE } from './session.service.js'
import { requireAuth } from './require-auth.js'
import { readCookie } from './cookies.js'
import { recordAudit } from '../audit.js'

const TX_COOKIE = 'ab_oauth_tx'
const TX_TTL_MS = 10 * 60_000

function allowedEmails(): string[] {
  return (process.env.ADMIN_ALLOWED_EMAILS ?? '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
}

function consoleOrigin(): string {
  return (process.env.ADMIN_CONSOLE_ORIGIN ?? '').split(',')[0].trim()
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function createAuthRouter(oidc: OidcPort): Router {
  const router = Router()

  router.get('/google/start', (req, res) => {
    const state = randomBytes(16).toString('base64url')
    const codeVerifier = randomBytes(32).toString('base64url')
    const tx = Buffer.from(JSON.stringify({ state, codeVerifier })).toString('base64url')

    // Header set directly rather than res.cookie(), so this router works when
    // a test mounts it standalone without the full app's middleware.
    res.setHeader('Set-Cookie',
      `${TX_COOKIE}=${tx}; HttpOnly; Secure; SameSite=None; Path=/api/v1/auth; Max-Age=${TX_TTL_MS / 1000}`)
    res.redirect(302, oidc.authUrl({ state, codeChallenge: s256(codeVerifier) }))
  })

  router.get('/google/callback', async (req, res) => {
    const raw = readCookie(req.headers.cookie, TX_COOKIE)
    if (!raw) return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'missing oauth transaction' })

    let tx: { state: string; codeVerifier: string }
    try {
      tx = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    } catch {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'bad oauth transaction' })
    }

    const { code, state } = req.query
    if (typeof code !== 'string' || typeof state !== 'string' || state !== tx.state) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'state mismatch' })
    }

    let identity
    try {
      identity = await oidc.exchange({ code, codeVerifier: tx.codeVerifier })
    } catch {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'code exchange failed' })
    }

    // Order matters, and a failure creates NO actor. See spec 5.3.
    if (!identity.emailVerified) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'email not verified' })
    }
    if (!allowedEmails().includes(identity.email.toLowerCase())) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'email not permitted' })
    }

    // Keyed on sub -- the stable identifier. An email can be reassigned.
    const actor = await prisma.actor.upsert({
      where: { googleSub: identity.sub },
      update: { email: identity.email, name: identity.name ?? identity.email },
      create: {
        type: 'human',
        name: identity.name ?? identity.email,
        email: identity.email,
        googleSub: identity.sub,
      },
    })
    if (actor.disabled) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'actor disabled' })
    }

    const { token } = await createSession(actor.id, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    })
    await recordAudit({ actorId: actor.id, action: 'auth.login', target: `actor:${actor.id}` })

    res.setHeader('Set-Cookie',
      `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${sessionTtlMs() / 1000}`)
    res.redirect(302, consoleOrigin() || '/')
  })

  router.post('/logout', async (req, res) => {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE)
    if (token) await revokeSession(token)
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0`)
    res.status(204).end()
  })

  router.get('/me', requireAuth, (req, res) => {
    res.json(req.actor)
  })

  return router
}
```

- [ ] **Step 4: Mount in `app.ts`**

```ts
import { createAuthRouter } from './auth/auth.routes.js'
import { createGoogleOidcPort } from './ports/oidc/google.adapter.js'
// …
  app.use('/api/v1/auth', createAuthRouter(createGoogleOidcPort()))
```

Mount it **before** the admin mounts, and note `/api/v1/auth` is deliberately *not* behind `requireAuth` — except `/me`, which applies it per-route.

- [ ] **Step 5: Run tests, whole suite, typecheck**

Run: `cd systems/core && npx vitest run && npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add systems/core/src/auth/auth.routes.ts systems/core/src/app.ts systems/core/tests/auth-routes.test.ts
git commit -m "feat(core): google sign-in routes

Checks run in order and a failure creates NO actor: signature, then
email_verified, then the allowlist. Identity is keyed on sub rather than email
because an email can be reassigned -- allowlisting by email while keying by sub
is the combination that is correct.

State and PKCE verifier ride a 10-minute httpOnly cookie rather than a table,
so there is nothing to reconcile or sweep.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Audit on admin writes

**Files:**
- Modify: `systems/core/src/admin/admin-catalog.service.ts`
- Modify: `systems/core/src/admin/admin-catalog.routes.ts`
- Modify: `systems/core/src/assets/image.service.ts`
- Modify: `systems/core/src/assets/assets.routes.ts`
- Test: `systems/core/tests/admin-audit.test.ts`

**Interfaces:**
- Consumes: `req.actor` from Task 5; `recordAudit(input, db?)` — the optional transaction client already landed in commit `27a3b00`.
- Produces: `setProductStatus(id: string, target: string, actorId: string)` — **signature change, third parameter required**.

- [ ] **Step 1: Write the failing test**

```ts
// systems/core/tests/admin-audit.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createSession, SESSION_COOKIE } from '../src/auth/session.service.js'

const app = buildApp()
const ORIGIN = 'https://console.example'

beforeEach(async () => {
  await resetDb()
  process.env.ADMIN_CONSOLE_ORIGIN = ORIGIN
})
afterAll(async () => {
  delete process.env.ADMIN_CONSOLE_ORIGIN
  await prisma.$disconnect()
})

describe('admin writes are audited', () => {
  it('records the acting actor and the status transition', async () => {
    const actor = await prisma.actor.create({ data: { type: 'human', name: 'jack' } })
    const { token } = await createSession(actor.id)
    const p = await prisma.product.create({
      data: { slug: 'a', name: 'A', productType: 'resale', status: 'draft' },
    })

    await request(app)
      .post(`/api/v1/admin/products/${p.id}/status`)
      .set('Cookie', `${SESSION_COOKIE}=${token}`).set('Origin', ORIGIN)
      .send({ status: 'published' })
      .expect(200)

    const rows = await prisma.auditLog.findMany({ where: { action: 'product.status' } })
    expect(rows).toHaveLength(1)
    expect(rows[0].actorId).toBe(actor.id)
    expect(rows[0].target).toBe(`product:${p.id}`)
    expect((rows[0].before as any).status).toBe('draft')
    expect((rows[0].after as any).status).toBe('published')
  })

  // The change and its audit row must land together or not at all.
  it('writes no audit row when the transition is rejected', async () => {
    const actor = await prisma.actor.create({ data: { type: 'human', name: 'jack' } })
    const { token } = await createSession(actor.id)
    const p = await prisma.product.create({
      data: { slug: 'b', name: 'B', productType: 'resale', status: 'archived' },
    })

    await request(app)
      .post(`/api/v1/admin/products/${p.id}/status`)
      .set('Cookie', `${SESSION_COOKIE}=${token}`).set('Origin', ORIGIN)
      .send({ status: 'published' })
      .expect(409)

    expect(await prisma.auditLog.count()).toBe(0)
    expect((await prisma.product.findUnique({ where: { id: p.id } }))!.status).toBe('archived')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd systems/core && npx vitest run tests/admin-audit.test.ts`
Expected: FAIL — no audit rows are written.

- [ ] **Step 3: Thread the actor through `setProductStatus`**

In `systems/core/src/admin/admin-catalog.service.ts`, change the signature and wrap the update:

```ts
import { recordAudit } from '../audit.js'

export async function setProductStatus(
  id: string,
  target: string,
  actorId: string,
): Promise<ProductDto> {
  if (!STATUSES.includes(target as any)) {
    throw new AdminError('VALIDATION_ERROR', `unknown status: ${target}`)
  }
  return prisma.$transaction(async (tx) => {
    const current = await tx.product.findUnique({ where: { id } })
    if (!current) throw new AdminError('NOT_FOUND', 'product not found')
    if (!ALLOWED_TRANSITIONS[current.status]?.includes(target)) {
      throw new AdminError('INVALID_TRANSITION', `cannot move ${current.status} to ${target}`)
    }
    const updated = await tx.product.update({
      where: { id },
      data: { status: target as any },
      include: { variants: true, images: { where: { status: 'ready' }, orderBy: { position: 'asc' } } },
    })
    // Inside the transaction: the change and its record commit together.
    await recordAudit({
      actorId,
      action: 'product.status',
      target: `product:${id}`,
      before: { status: current.status },
      after: { status: target },
    }, tx)
    return toDto(updated)
  })
}
```

Keep the existing `toDto` / `ALLOWED_TRANSITIONS` / `STATUSES` definitions — only the function body above changes.

- [ ] **Step 4: Pass the actor from the route**

In `systems/core/src/admin/admin-catalog.routes.ts`:

```ts
    res.json(await setProductStatus(req.params.id, status, req.actor!.id))
```

`req.actor` is guaranteed by `requireAuth`, which is mounted ahead of this router.

- [ ] **Step 4b: Update the 12 direct callers in `admin-status.test.ts`**

`tests/admin-status.test.ts` calls `setProductStatus` **directly**, not over
HTTP, at 12 sites — all with two arguments. They will not compile.

Add an actor to the existing `beforeEach` and pass its id:

```ts
let actorId: string

beforeEach(async () => {
  await resetDb()
  const actor = await prisma.actor.create({ data: { type: 'human', name: 'test-admin' } })
  actorId = actor.id
})
```

Then every call becomes `setProductStatus(p.id, 'published', actorId)`.

**Do not make `actorId` optional to avoid this edit.** An optional actor on an
audited write is exactly how `actorId = 'system'` became the permanent answer
in `orders.service.ts`. The spec requires every admin write be attributable.

- [ ] **Step 5: Do the same for the image operations**

In `systems/core/src/assets/assets.routes.ts`, pass `req.actor!.id` into `requestUpload`, `confirmUpload`, `reorderImages` and `deleteImage`; in `image.service.ts` add an `actorId: string` parameter to each and call `recordAudit` with actions `image.upload.request`, `image.upload.confirm`, `image.reorder`, `image.delete`, passing `tx` wherever the function already opens a transaction.

- [ ] **Step 6: Run everything and commit**

```bash
cd systems/core && npx vitest run && npm run typecheck
git add systems/core/src systems/core/tests/admin-audit.test.ts
git commit -m "feat(core): audit every admin write

recordAudit runs inside the same transaction as the change, so a rejected
transition leaves no audit row and a committed one always has exactly one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Move the order audit calls inside their transactions

**Files:**
- Modify: `systems/core/src/orders/orders.service.ts`
- Test: `systems/core/tests/orders-audit-atomicity.test.ts`

Spec §7.1, decision 6. The four calls are at lines **133, 159, 177, 200**, against transactions opening at **75, 152, 164, 182** — all four currently sit after their transaction closes.

**Interfaces:**
- Consumes: `recordAudit(input, db?)`.
- Produces: no signature changes.

- [ ] **Step 1: Write the failing test**

```ts
// systems/core/tests/orders-audit-atomicity.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { markOrderPaid, fulfillOrder, OrderError } from '../src/orders/orders.service.js'

beforeEach(resetDb)
afterAll(() => prisma.$disconnect())

async function seedPendingOrder() {
  const actor = await prisma.actor.create({ data: { id: 'system', type: 'human', name: 'system' } })
  const product = await prisma.product.create({
    data: {
      slug: 'x', name: 'X', productType: 'resale', status: 'published',
      variants: { create: [{ sku: 'X-1', priceCents: 1000 }] },
    },
    include: { variants: true },
  })
  const order = await prisma.order.create({
    data: {
      status: 'pending', channel: 'storefront', subtotalCents: 1000, totalCents: 1000,
      lines: { create: [{ variantId: product.variants[0].id, quantity: 1, unitPriceCents: 1000 }] },
    },
  })
  return { order, actor }
}

describe('order audit atomicity', () => {
  it('writes exactly one audit row on a successful transition', async () => {
    const { order } = await seedPendingOrder()
    await markOrderPaid(order.id, 'system')
    const rows = await prisma.auditLog.findMany({ where: { action: 'order.paid' } })
    expect(rows).toHaveLength(1)
    expect(rows[0].target).toBe(`order:${order.id}`)
  })

  // A rejected transition must leave nothing behind.
  it('writes no audit row when the transition is rejected', async () => {
    const { order } = await seedPendingOrder()
    await expect(fulfillOrder(order.id, 'system')).rejects.toBeInstanceOf(OrderError)
    expect(await prisma.auditLog.count()).toBe(0)
  })
})
```

- [ ] **Step 2: Run it and confirm the second test fails**

Run: `cd systems/core && npx vitest run tests/orders-audit-atomicity.test.ts`
Expected: the rejection test may already pass (the throw short-circuits), the first must pass. **Both must pass after step 3** — the point of step 3 is the crash window, which no test can reach directly.

- [ ] **Step 3: Move each call inside its transaction**

For each of `placeOrder`, `markOrderPaid`, `fulfillOrder`, `cancelOrder`: move the `await recordAudit({…})` line to the last statement **inside** the `prisma.$transaction(async (tx) => { … })` callback, and pass `tx` as the second argument. For example, `markOrderPaid` becomes:

```ts
export async function markOrderPaid(orderId: string, actorId = 'system'): Promise<OrderDto> {
  const updated = await prisma.$transaction(async (tx) => {
    const order = await loadOrderForUpdate(tx, orderId)
    if (order.status !== 'pending') {
      throw new OrderError('invalid_transition', `cannot mark ${order.status} order as paid`)
    }
    const next = await tx.order.update({
      where: { id: orderId }, data: { status: 'paid' }, include: { lines: true },
    })
    await recordAudit({
      actorId, action: 'order.paid', target: `order:${orderId}`,
      before: { status: 'pending' }, after: { status: 'paid' },
    }, tx)
    return next
  })
  return toDto(updated)
}
```

- [ ] **Step 4: Run the order suites**

Run: `cd systems/core && npx vitest run tests/orders-audit-atomicity.test.ts tests/orders-api.test.ts tests/orders-service.test.ts tests/orders-transitions.test.ts tests/orders-concurrency.test.ts`
Expected: all pass.

- [ ] **Step 5: Run everything, then commit**

```bash
cd systems/core && npx vitest run && npm run typecheck
git add systems/core/src/orders/orders.service.ts systems/core/tests/orders-audit-atomicity.test.ts
git commit -m "fix(core): order audit rows commit with the transition

All four recordAudit calls sat after their transaction closed, so an order
could commit with nobody attached to it, and an audit throw left a committed
change the caller believed had failed.

An audit failure now rolls back the transition. Accepted: audit_log and orders
share a database, so the failure modes are correlated and the apparent trade
between revenue and logging is largely illusory.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Key issuance script

**Settled (spec §5.4): there is no standing break-glass key.** Render offers
shell access, so a key can be minted on demand during an incident by the same
person who would have had to set the env var anyway. Build the script only.

**Files:**
- Create: `systems/core/scripts/create-api-key.ts`
- Modify: `systems/core/package.json` (one script entry)
- Test: `systems/core/tests/create-api-key.test.ts`

**Interfaces:**
- Consumes: `createApiKey` from `../src/auth/apikey.service.js`.
- Produces: `npm run create-api-key -- <actor-name> <key-name> [expires-days]`

- [ ] **Step 1: Write the script**

```ts
// systems/core/scripts/create-api-key.ts
import { createApiKey } from '../src/auth/apikey.service.js'
import { prisma } from '../src/prisma.js'

async function main() {
  const [actorName, keyName, expiresDays] = process.argv.slice(2)
  if (!actorName || !keyName) {
    console.error('usage: npm run create-api-key -- <actor-name> <key-name> [expires-days]')
    process.exit(1)
  }
  const expiresAt = expiresDays
    ? new Date(Date.now() + Number(expiresDays) * 86_400_000)
    : null

  const { plaintext, id } = await createApiKey({ actorName, keyName, expiresAt })

  console.log('')
  console.log('  API key created. This is the ONLY time the secret is shown.')
  console.log(`  id:      ${id}`)
  console.log(`  actor:   ${actorName}`)
  console.log(`  expires: ${expiresAt ? expiresAt.toISOString() : 'never'}`)
  console.log('')
  console.log(`  ${plaintext}`)
  console.log('')
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
```

- [ ] **Step 2: Add the npm script**

In `systems/core/package.json`, add to `scripts`:

```json
    "create-api-key": "tsx scripts/create-api-key.ts"
```

- [ ] **Step 3: Write the test**

```ts
// systems/core/tests/create-api-key.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createApiKey, resolveApiKey } from '../src/auth/apikey.service.js'

beforeEach(resetDb)
afterAll(() => prisma.$disconnect())

describe('key issuance', () => {
  it('mints a key that authenticates', async () => {
    const { plaintext } = await createApiKey({ actorName: 'break-glass', keyName: 'emergency' })
    expect(await resolveApiKey(`Bearer ${plaintext}`)).toMatchObject({ name: 'break-glass' })
  })

  // The break-glass procedure passes 1 day. A permanent emergency credential
  // is the thing spec 5.4 exists to avoid.
  it('honours a short expiry', async () => {
    const { plaintext, id } = await createApiKey({
      actorName: 'break-glass', keyName: 'emergency',
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    expect(await resolveApiKey(`Bearer ${plaintext}`)).not.toBeNull()
    await prisma.apiKey.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1) } })
    expect(await resolveApiKey(`Bearer ${plaintext}`)).toBeNull()
  })
})
```

- [ ] **Step 4: Run and typecheck**

Run: `cd systems/core && npx vitest run tests/create-api-key.test.ts && npm run typecheck`
Expected: 2 passing, tsc clean.

- [ ] **Step 5: Rehearse the break-glass procedure once**

Not optional, and not something to discover during an outage. Against the local
database, run exactly what the runbook says:

```bash
cd systems/core && npm run create-api-key -- break-glass emergency 1
```

Confirm the printed key authenticates:

```bash
curl -s -o /dev/null -w '%{http_code}
'   -H "Authorization: Bearer <printed-key>"   http://localhost:4000/api/v1/admin/products
```

Expected: `200`. Then revoke it and confirm it stops working — expected `401`.

- [ ] **Step 6: Commit**

```bash
git add systems/core/scripts systems/core/package.json systems/core/tests/create-api-key.test.ts
git commit -m "feat(core): api key issuance script

Prints the plaintext exactly once. No key-management UI and no standing
break-glass key: Render shell access means a key can be minted during an
incident by whoever would have had to set the env var anyway, so a permanent
credential would grant no capability its holder did not already have.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Wire the console

**Files:**
- Modify: `systems/admin-ui/src/data/api.js`
- Create: `systems/admin-ui/src/pages/SignIn.jsx`
- Modify: `systems/admin-ui/src/App.jsx`
- Test: `systems/admin-ui/src/data/api.test.js`

**Interfaces:**
- Consumes: core's `/api/v1/auth/*` and the 401 envelope `{ code: 'UNAUTHENTICATED' }`.
- Produces: no change to the 16-method API shape, so no component churn.

- [ ] **Step 1: Write the failing test**

```js
// systems/admin-ui/src/data/api.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { listProducts } from './api.js'

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.unstubAllGlobals(); window.location.assign.mockRestore?.() })

describe('api client', () => {
  it('sends credentials on every request', async () => {
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ items: [], total: 0 }) })
    await listProducts({})
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('redirects to sign-in on 401 instead of surfacing an error', async () => {
    const assign = vi.fn()
    delete window.location
    window.location = { assign, href: '' }
    fetch.mockResolvedValue({
      ok: false, status: 401,
      json: async () => ({ code: 'UNAUTHENTICATED', message: 'authentication required' }),
    })
    await listProducts({}).catch(() => {})
    expect(assign).toHaveBeenCalledWith(expect.stringContaining('/api/v1/auth/google/start'))
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd systems/admin-ui && npx vitest run src/data/api.test.js`
Expected: FAIL — `credentials` is absent.

- [ ] **Step 3: Add credentials and the 401 redirect**

In `systems/admin-ui/src/data/api.js`, in the shared request helper:

```js
    res = await fetch(`${BASE}${path}`, {
      credentials: 'include',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      ...init,
    })

    if (res.status === 401) {
      // Not an error the UI should render -- the session is gone or was never
      // there, and the only useful response is to sign in again.
      window.location.assign('/api/v1/auth/google/start')
      throw new AdminApiError('authentication required', 'UNAUTHENTICATED')
    }
```

- [ ] **Step 4: Add the sign-in screen**

```jsx
// systems/admin-ui/src/pages/SignIn.jsx
export default function SignIn() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 p-8 text-center">
        <h1 className="text-xl font-semibold text-slate-900">Alpine Brick Admin</h1>
        <p className="mt-2 text-sm text-slate-500">Access is limited to approved accounts.</p>
        <a
          href="/api/v1/auth/google/start"
          className="mt-6 inline-block w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white"
        >
          Sign in with Google
        </a>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Route it**

In `systems/admin-ui/src/App.jsx`, add `<Route path="/signin" element={<SignIn />} />` outside the authenticated layout.

- [ ] **Step 6: Run tests, build, commit**

```bash
cd systems/admin-ui && npx vitest run && npm run build
git add systems/admin-ui/src
git commit -m "feat(admin-ui): credentialed requests and Google sign-in

A 401 redirects to sign-in rather than rendering an error: the session is gone
or was never there, and signing in is the only useful response.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verification before opening the PR

- [ ] `cd systems/core && npx vitest run && npm run typecheck && npm run build`
- [ ] `cd systems/admin-ui && npx vitest run && npm run build`
- [ ] `cd systems/storefront/code && npx vitest run && npm run build` — confirms the public catalog routes were not disturbed
- [ ] Fresh-database check: `npx prisma migrate reset --force && npx prisma migrate deploy` — catches a migration that sorts before its dependency
- [ ] Push and read CI. **If the local Postgres on :5433 is unavailable, CI is the verification of record** — `.github/workflows/ci.yml` runs `postgres:16` as a service.

## Self-review notes

Spec coverage checked section by section: §4 → Tasks 1–4 · §5 → Tasks 5, 8, 11 (§5.4 is a runbook step, Task 11 step 5) · §6 → Task 6 · §7 → Tasks 9, 10 · §8 → Task 11 · §9 → tests throughout, with the route-coverage and public-route regressions both in Task 5 · §10 → Tasks 6, 8 · §11 → Task 12.

Two spec items are **not** implemented here and are recorded rather than dropped:

1. **CORS response headers.** Origin *validation* is Task 6; emitting `Access-Control-Allow-Origin` / `Allow-Credentials` and handling preflight is not, because nothing is deployed cross-origin yet and the console still runs behind a Vite dev proxy. It must land before the console is deployed. **Not a gap in the plan — a gap in the plan's scope, stated so it is not forgotten.**
2. **`SESSION_TTL_HOURS` sweeping.** Expired sessions are rejected on read but never deleted. Harmless at two operators; worth a scheduled job alongside `sweepPendingImages`, which also has no scheduler.
