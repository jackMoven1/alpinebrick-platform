# Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the TypeScript core app (Node + Express + Prisma/Postgres) with the Phase 1 catalog+audit slice of the canonical schema, migrate catalog-service's data in, and expose a read-only catalog API — the substrate every later Phase 1 plan builds on.

**Architecture:** A new modular-monolith core at `systems/core`. Postgres via Prisma (typed schema + migrations). Express HTTP layer with a thin service layer per module. Cross-cutting `Actor`/`AuditLog` substrate is created here so later plans can record every mutation. This plan is deliberately read-only on the catalog; write paths arrive in later plans.

> **Deferred to the storefront-cutover plan (Plan 5)** — decided 2026-07-08. `systems/core` is intentionally NOT yet added to the monorepo root `package.json` workspaces / `pnpm-workspace.yaml` / `docker-compose.yaml`, so root `npm test --workspaces` skips it (run `cd systems/core && npm test` in the interim). Wiring it into root tooling requires a root `npm install` that would churn the root lockfile and could ripple into the old services this redesign retires, so it belongs with the cutover when those services are removed. **Cutover plan must:** add `systems/core` to root workspaces + `pnpm-workspace.yaml`, add a `core`/`core-db` docker-compose service, then reinstall.

**Tech Stack:** TypeScript, Node 20+, Express 4, Prisma 5 (PostgreSQL), Vitest + supertest.

## Global Constraints

- **Language/runtime:** TypeScript, Node 20+, ES modules (`"type": "module"`).
- **DB:** PostgreSQL via Prisma; every schema change is a Prisma migration (never hand-edit the DB).
- **Money is integer minor units (cents), never floats.** All price/amount fields are `Int` cents.
- **Timestamps are UTC** `DateTime` (`@default(now())` / `@updatedAt`).
- **Catalog API base path is `/api/v1/catalog`** (fixes the order→catalog path mismatch in the old stubs).
- **Every mutating back-office operation records an `Actor` + `AuditLog` row** (built here; enforced in later plans). Read endpoints do not audit.
- **Enums:** `ProductType {own_designed, resale}`, `ReleaseType {standard, limited_run, specialty}`, `ProductStatus {draft, published, archived}`, `ActorType {human, agent}`.
- **Storefront catalog reads return only `published` products by default.**

---

## File Structure

```
systems/core/
  package.json              # deps, scripts (dev, build, test, prisma)
  tsconfig.json
  vitest.config.ts
  .env.example              # DATABASE_URL template
  prisma/
    schema.prisma           # datasource, generator, Phase-1 models
    seed.ts                 # migrate catalog data + seed a system Actor
  src/
    prisma.ts               # PrismaClient singleton
    app.ts                  # buildApp(): Express app (exported for tests)
    server.ts               # starts app.listen()
    audit.ts                # recordAudit() helper
    catalog/
      catalog.service.ts    # listProducts / getProduct / getAvailability
      catalog.routes.ts     # Express router mounted at /api/v1/catalog
  tests/
    helpers/db.ts           # reset tables between tests
    health.test.ts
    audit.test.ts
    catalog.test.ts
```

Responsibilities: `prisma.ts` owns the DB client; `app.ts` wires routes (no `listen`, so tests import it); `audit.ts` is the sole writer of `AuditLog`; `catalog/*` is the only catalog code. Files that change together (a module's service + routes) live together.

---

## Task 1: Scaffold the core app

**Files:**
- Create: `systems/core/package.json`, `systems/core/tsconfig.json`, `systems/core/vitest.config.ts`, `systems/core/.env.example`
- Create: `systems/core/src/app.ts`, `systems/core/src/server.ts`
- Test: `systems/core/tests/health.test.ts`

**Interfaces:**
- Produces: `buildApp(): express.Express` (from `src/app.ts`) — used by every later test and by `server.ts`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@imagibrick/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "vitest run",
    "prisma:migrate": "prisma migrate dev",
    "prisma:deploy": "prisma migrate deploy",
    "prisma:generate": "prisma generate",
    "seed": "tsx prisma/seed.ts"
  },
  "dependencies": {
    "@prisma/client": "^5.18.0",
    "express": "^4.19.2"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.14.0",
    "@types/supertest": "^6.0.2",
    "prisma": "^5.18.0",
    "supertest": "^7.0.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src", "prisma", "tests"]
}
```

- [ ] **Step 3: Create `.env.example` and a local `.env`**

```
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/imagibrick_core?schema=public"
PORT=4000
```

Copy it: `cp systems/core/.env.example systems/core/.env`. Then start a Postgres for dev on port 5433:

Run: `docker run -d --name imagibrick-core-db -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:15`
Expected: prints a container id; `docker ps` shows `imagibrick-core-db` up.

- [ ] **Step 4: Install deps**

Run: `cd systems/core && npm install`
Expected: `node_modules` created, no error.

- [ ] **Step 5: Write the failing test**

`systems/core/tests/health.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { buildApp } from '../src/app.js'

describe('health', () => {
  it('GET /health returns ok', async () => {
    const res = await request(buildApp()).get('/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd systems/core && npm test -- health`
Expected: FAIL — cannot resolve `../src/app.js` (module does not exist yet).

- [ ] **Step 7: Create `src/app.ts` and `src/server.ts`**

`src/app.ts`:

```ts
import express, { type Express } from 'express'

export function buildApp(): Express {
  const app = express()
  app.use(express.json())
  app.get('/health', (_req, res) => res.json({ status: 'ok' }))
  return app
}
```

`src/server.ts`:

```ts
import { buildApp } from './app.js'

const port = Number(process.env.PORT ?? 4000)
buildApp().listen(port, () => console.log(`core listening on :${port}`))
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd systems/core && npm test -- health`
Expected: PASS (1 test).

- [ ] **Step 9: Commit**

```bash
git add systems/core/package.json systems/core/tsconfig.json systems/core/vitest.config.ts systems/core/.env.example systems/core/src/app.ts systems/core/src/server.ts systems/core/tests/health.test.ts
git commit -m "feat(core): scaffold TypeScript Express app with health check"
```

> Note: create `systems/core/vitest.config.ts` in Step 1's batch:
> ```ts
> import { defineConfig } from 'vitest/config'
> export default defineConfig({ test: { environment: 'node', include: ['tests/**/*.test.ts'] } })
> ```

---

## Task 2: Prisma + canonical schema (catalog + audit slice)

**Files:**
- Create: `systems/core/prisma/schema.prisma`, `systems/core/src/prisma.ts`
- Test: `systems/core/tests/helpers/db.ts`, extend `catalog.test.ts` later

**Interfaces:**
- Produces: `prisma` (from `src/prisma.ts`) — the shared `PrismaClient`; models `Product`, `Variant`, `Inventory`, `Actor`, `AuditLog`.
- Produces: `resetDb()` (from `tests/helpers/db.ts`) — truncates all tables; used by later test files.

- [ ] **Step 1: Write `prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum ProductType { own_designed resale }
enum ReleaseType { standard limited_run specialty }
enum ProductStatus { draft published archived }
enum ActorType { human agent }

model Product {
  id          String        @id @default(cuid())
  slug        String        @unique
  name        String
  description String        @default("")
  productType ProductType   @map("product_type")
  releaseType ReleaseType   @default(standard) @map("release_type")
  status      ProductStatus @default(draft)
  images      Json          @default("[]")
  categories  Json          @default("[]")
  createdAt   DateTime      @default(now()) @map("created_at")
  updatedAt   DateTime      @updatedAt @map("updated_at")
  variants    Variant[]
  @@map("products")
}

model Variant {
  id         String     @id @default(cuid())
  productId  String     @map("product_id")
  product    Product    @relation(fields: [productId], references: [id], onDelete: Cascade)
  sku        String     @unique
  priceCents Int        @map("price_cents")
  currency   String     @default("USD")
  attributes Json       @default("{}")
  inventory  Inventory?
  @@map("variants")
}

model Inventory {
  id        String  @id @default(cuid())
  variantId String  @unique @map("variant_id")
  variant   Variant @relation(fields: [variantId], references: [id], onDelete: Cascade)
  onHand    Int     @default(0) @map("on_hand")
  reserved  Int     @default(0)
  @@map("inventory")
}

model Actor {
  id        String     @id @default(cuid())
  type      ActorType
  name      String
  createdAt DateTime   @default(now()) @map("created_at")
  auditLogs AuditLog[]
  @@map("actors")
}

model AuditLog {
  id        String   @id @default(cuid())
  actorId   String   @map("actor_id")
  actor     Actor    @relation(fields: [actorId], references: [id])
  action    String
  target    String
  before    Json?
  after     Json?
  createdAt DateTime @default(now()) @map("created_at")
  @@map("audit_log")
}
```

- [ ] **Step 2: Generate the client and run the first migration**

Run: `cd systems/core && npx prisma migrate dev --name init_catalog_audit`
Expected: creates `prisma/migrations/*_init_catalog_audit/`, applies it to the dev DB, prints "Your database is now in sync", generates the client.

- [ ] **Step 3: Create the Prisma singleton `src/prisma.ts`**

```ts
import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()
```

- [ ] **Step 4: Create the test DB reset helper `tests/helpers/db.ts`**

```ts
import { prisma } from '../../src/prisma.js'

export async function resetDb() {
  // Order matters: children before parents.
  await prisma.auditLog.deleteMany()
  await prisma.inventory.deleteMany()
  await prisma.variant.deleteMany()
  await prisma.product.deleteMany()
  await prisma.actor.deleteMany()
}
```

- [ ] **Step 5: Write a failing schema smoke test**

`systems/core/tests/schema.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'

beforeEach(resetDb)
afterAll(() => prisma.$disconnect())

describe('schema', () => {
  it('creates a product with a variant and inventory', async () => {
    const p = await prisma.product.create({
      data: {
        slug: 'test-set', name: 'Test Set', productType: 'own_designed', status: 'published',
        variants: { create: { sku: 'TS-1', priceCents: 1999, inventory: { create: { onHand: 5 } } } },
      },
      include: { variants: { include: { inventory: true } } },
    })
    expect(p.variants[0].sku).toBe('TS-1')
    expect(p.variants[0].inventory?.onHand).toBe(5)
  })
})
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd systems/core && npm test -- schema`
Expected: PASS (the migration from Step 2 already created the tables).

- [ ] **Step 7: Commit**

```bash
git add systems/core/prisma systems/core/src/prisma.ts systems/core/tests/helpers/db.ts systems/core/tests/schema.test.ts
git commit -m "feat(core): add Prisma canonical schema (catalog + audit) and migration"
```

---

## Task 3: Audit helper

**Files:**
- Create: `systems/core/src/audit.ts`
- Test: `systems/core/tests/audit.test.ts`

**Interfaces:**
- Produces: `recordAudit(input: { actorId: string; action: string; target: string; before?: unknown; after?: unknown }): Promise<{ id: string }>` — the single writer of `AuditLog`, used by every later plan's mutations.

- [ ] **Step 1: Write the failing test**

`systems/core/tests/audit.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { recordAudit } from '../src/audit.js'

beforeEach(resetDb)
afterAll(() => prisma.$disconnect())

describe('recordAudit', () => {
  it('writes an audit row linked to an actor', async () => {
    const actor = await prisma.actor.create({ data: { type: 'agent', name: 'catalog-agent' } })
    const entry = await recordAudit({
      actorId: actor.id, action: 'product.publish', target: 'product:123',
      before: { status: 'draft' }, after: { status: 'published' },
    })
    const row = await prisma.auditLog.findUnique({ where: { id: entry.id } })
    expect(row?.action).toBe('product.publish')
    expect(row?.actorId).toBe(actor.id)
    expect((row?.after as any).status).toBe('published')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/core && npm test -- audit`
Expected: FAIL — cannot resolve `../src/audit.js`.

- [ ] **Step 3: Implement `src/audit.ts`**

```ts
import { prisma } from './prisma.js'
import type { Prisma } from '@prisma/client'

export async function recordAudit(input: {
  actorId: string
  action: string
  target: string
  before?: unknown
  after?: unknown
}): Promise<{ id: string }> {
  const { id } = await prisma.auditLog.create({
    data: {
      actorId: input.actorId,
      action: input.action,
      target: input.target,
      before: (input.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (input.after ?? undefined) as Prisma.InputJsonValue | undefined,
    },
    select: { id: true },
  })
  return { id }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd systems/core && npm test -- audit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add systems/core/src/audit.ts systems/core/tests/audit.test.ts
git commit -m "feat(core): add recordAudit helper (append-only AuditLog writer)"
```

---

## Task 4: Seed — migrate catalog data + a system Actor

**Files:**
- Create: `systems/core/prisma/seed.ts`
- Test: `systems/core/tests/seed.test.ts`

**Interfaces:**
- Produces: `seed(): Promise<void>` (from `prisma/seed.ts`) — idempotent seed of the two catalog products (one `own_designed`, one `resale`), their variants + inventory, and a `system` human Actor.

- [ ] **Step 1: Write the failing test**

`systems/core/tests/seed.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'

beforeEach(resetDb)
afterAll(() => prisma.$disconnect())

describe('seed', () => {
  it('creates both product lines with inventory and a system actor', async () => {
    await seed()
    const products = await prisma.product.findMany({ include: { variants: { include: { inventory: true } } } })
    expect(products).toHaveLength(2)
    expect(products.map(p => p.productType).sort()).toEqual(['own_designed', 'resale'])
    expect(products.every(p => p.variants.every(v => v.inventory && v.inventory.onHand > 0))).toBe(true)
    const actor = await prisma.actor.findFirst({ where: { name: 'system' } })
    expect(actor?.type).toBe('human')
  })

  it('is idempotent (running twice does not duplicate)', async () => {
    await seed(); await seed()
    expect(await prisma.product.count()).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/core && npm test -- seed`
Expected: FAIL — cannot resolve `../prisma/seed.js`.

- [ ] **Step 3: Implement `prisma/seed.ts`**

```ts
import { prisma } from '../src/prisma.js'

const PRODUCTS = [
  {
    slug: 'brick-builder-set', name: 'Brick Builder Set', productType: 'own_designed' as const,
    releaseType: 'standard' as const, status: 'published' as const,
    variant: { sku: 'BBS-STD', priceCents: 4999, onHand: 25 },
  },
  {
    slug: 'castle-mega-pack', name: 'Castle Mega Pack (Limited)', productType: 'resale' as const,
    releaseType: 'limited_run' as const, status: 'published' as const,
    variant: { sku: 'CMP-LTD', priceCents: 12999, onHand: 8 },
  },
]

export async function seed(): Promise<void> {
  await prisma.actor.upsert({
    where: { id: 'system' }, update: {},
    create: { id: 'system', type: 'human', name: 'system' },
  })
  for (const p of PRODUCTS) {
    await prisma.product.upsert({
      where: { slug: p.slug },
      update: {},
      create: {
        slug: p.slug, name: p.name, productType: p.productType,
        releaseType: p.releaseType, status: p.status,
        variants: {
          create: {
            sku: p.variant.sku, priceCents: p.variant.priceCents,
            inventory: { create: { onHand: p.variant.onHand } },
          },
        },
      },
    })
  }
}

// Allow `npm run seed` to execute it directly.
if (process.argv[1]?.endsWith('seed.ts')) {
  seed().then(() => prisma.$disconnect())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd systems/core && npm test -- seed`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add systems/core/prisma/seed.ts systems/core/tests/seed.test.ts
git commit -m "feat(core): seed both product lines (own_designed + resale) with inventory"
```

---

## Task 5: Catalog read API

**Files:**
- Create: `systems/core/src/catalog/catalog.service.ts`, `systems/core/src/catalog/catalog.routes.ts`
- Modify: `systems/core/src/app.ts` (mount the router)
- Test: `systems/core/tests/catalog.test.ts`

**Interfaces:**
- Consumes: `prisma` (Task 2), `seed()` (Task 4).
- Produces: `listProducts`, `getProduct`, `getAvailability` (from `catalog.service.ts`) and a router mounted at `/api/v1/catalog`.

Service contracts:
- `listProducts(opts: { page?: number; pageSize?: number; search?: string; status?: 'published'|'draft'|'archived' }): Promise<{ items: ProductDto[]; total: number; page: number; pageSize: number }>` — defaults `page=1, pageSize=20, status='published'`.
- `getProduct(idOrSlug: string): Promise<ProductDto | null>`
- `getAvailability(idOrSlug: string): Promise<{ variantId: string; sku: string; available: number }[] | null>` where `available = onHand - reserved`.

- [ ] **Step 1: Write the failing test**

`systems/core/tests/catalog.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { buildApp } from '../src/app.js'

const app = buildApp()
beforeEach(async () => { await resetDb(); await seed() })
afterAll(() => prisma.$disconnect())

describe('catalog API', () => {
  it('lists only published products with total', async () => {
    const res = await request(app).get('/api/v1/catalog/products')
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(2)
    expect(res.body.items).toHaveLength(2)
  })

  it('gets a product by slug', async () => {
    const res = await request(app).get('/api/v1/catalog/products/brick-builder-set')
    expect(res.status).toBe(200)
    expect(res.body.productType).toBe('own_designed')
  })

  it('returns 404 for an unknown product', async () => {
    const res = await request(app).get('/api/v1/catalog/products/nope')
    expect(res.status).toBe(404)
  })

  it('reports availability as onHand minus reserved', async () => {
    const res = await request(app).get('/api/v1/catalog/products/castle-mega-pack/availability')
    expect(res.status).toBe(200)
    expect(res.body[0].available).toBe(8)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/core && npm test -- catalog`
Expected: FAIL — 404s / cannot resolve catalog service (routes not mounted).

- [ ] **Step 3: Implement `src/catalog/catalog.service.ts`**

```ts
import { prisma } from '../prisma.js'

export interface ProductDto {
  id: string; slug: string; name: string; description: string
  productType: string; releaseType: string; status: string
  variants: { id: string; sku: string; priceCents: number; currency: string }[]
}

function toDto(p: any): ProductDto {
  return {
    id: p.id, slug: p.slug, name: p.name, description: p.description,
    productType: p.productType, releaseType: p.releaseType, status: p.status,
    variants: p.variants.map((v: any) => ({ id: v.id, sku: v.sku, priceCents: v.priceCents, currency: v.currency })),
  }
}

export async function listProducts(opts: {
  page?: number; pageSize?: number; search?: string
  status?: 'published' | 'draft' | 'archived'
}) {
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20))
  const where: any = { status: opts.status ?? 'published' }
  if (opts.search) where.name = { contains: opts.search, mode: 'insensitive' }
  const [rows, total] = await Promise.all([
    prisma.product.findMany({ where, include: { variants: true }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.product.count({ where }),
  ])
  return { items: rows.map(toDto), total, page, pageSize }
}

export async function getProduct(idOrSlug: string): Promise<ProductDto | null> {
  const p = await prisma.product.findFirst({
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    include: { variants: true },
  })
  return p ? toDto(p) : null
}

export async function getAvailability(idOrSlug: string) {
  const p = await prisma.product.findFirst({
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    include: { variants: { include: { inventory: true } } },
  })
  if (!p) return null
  return p.variants.map(v => ({
    variantId: v.id, sku: v.sku,
    available: (v.inventory?.onHand ?? 0) - (v.inventory?.reserved ?? 0),
  }))
}
```

- [ ] **Step 4: Implement `src/catalog/catalog.routes.ts`**

```ts
import { Router } from 'express'
import { listProducts, getProduct, getAvailability } from './catalog.service.js'

export const catalogRouter = Router()

catalogRouter.get('/products', async (req, res) => {
  const result = await listProducts({
    page: req.query.page ? Number(req.query.page) : undefined,
    pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
    search: typeof req.query.search === 'string' ? req.query.search : undefined,
  })
  res.json(result)
})

catalogRouter.get('/products/:idOrSlug', async (req, res) => {
  const p = await getProduct(req.params.idOrSlug)
  if (!p) return res.status(404).json({ error: 'not_found' })
  res.json(p)
})

catalogRouter.get('/products/:idOrSlug/availability', async (req, res) => {
  const a = await getAvailability(req.params.idOrSlug)
  if (!a) return res.status(404).json({ error: 'not_found' })
  res.json(a)
})
```

- [ ] **Step 5: Mount the router in `src/app.ts`**

Modify `src/app.ts` to add the import and `app.use`:

```ts
import express, { type Express } from 'express'
import { catalogRouter } from './catalog/catalog.routes.js'

export function buildApp(): Express {
  const app = express()
  app.use(express.json())
  app.get('/health', (_req, res) => res.json({ status: 'ok' }))
  app.use('/api/v1/catalog', catalogRouter)
  return app
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd systems/core && npm test -- catalog`
Expected: PASS (4 tests).

- [ ] **Step 7: Run the full suite**

Run: `cd systems/core && npm test`
Expected: PASS — health, schema, audit, seed, catalog all green.

- [ ] **Step 8: Commit**

```bash
git add systems/core/src/catalog systems/core/src/app.ts systems/core/tests/catalog.test.ts
git commit -m "feat(core): read-only catalog API at /api/v1/catalog (list, detail, availability)"
```

---

## Task 6: Retire the old catalog-service stub (cutover marker)

**Files:**
- Modify: `systems/core/README.md` (create), documenting that `systems/catalog-service` is superseded.

**Interfaces:** none (documentation + de-risking migration drift, per the spec's "cut over per-module" risk).

- [ ] **Step 1: Create `systems/core/README.md`**

```markdown
# ImagiBrick Core

Modular-monolith core (TypeScript + Express + Prisma/Postgres). Phase 1 substrate:
canonical schema (catalog + audit slice), seed, and the read-only catalog API at
`/api/v1/catalog`.

## Dev
1. `docker run -d --name imagibrick-core-db -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:15`
2. `cp .env.example .env`
3. `npm install && npx prisma migrate dev && npm run seed`
4. `npm run dev` → http://localhost:4000/health

## Supersedes
`systems/catalog-service` (read-only Postgres API) is replaced by this module's
catalog API. Do not add features to `catalog-service`; it will be removed once the
storefront (Plan 5) points at `/api/v1/catalog` here.
```

- [ ] **Step 2: Commit**

```bash
git add systems/core/README.md
git commit -m "docs(core): mark catalog-service as superseded by core catalog API"
```

---

## Self-Review

**Spec coverage (Foundation slice of Phase 1):**
- Canonical schema (catalog+audit subset), Postgres persistence → Tasks 2. ✅
- Actor + AuditLog substrate → Tasks 2 (models) + 3 (writer). ✅
- Migrate catalog-service data → Task 4 (seed with both product lines). ✅
- Catalog read API + fix `/api/v1/catalog` path → Task 5. ✅
- Product type (`own_designed`/`resale`) + `release_type` + scarcity via inventory → Tasks 2/4/5. ✅
- Money as integer cents → schema `priceCents Int`. ✅
- Retire stubs / cutover discipline → Task 6. ✅
- *Out of this plan (later Phase 1 plans):* orders, tax, payments, customer/auth, referral capture, storefront UI, fulfillment. Correct per decomposition.

**Placeholder scan:** none — every step has runnable code/commands.

**Type consistency:** `buildApp`, `prisma`, `recordAudit(input)`, `resetDb`, `seed`, `listProducts/getProduct/getAvailability` signatures are defined once and reused verbatim across tasks/tests. `available = onHand - reserved` used consistently in schema intent, service, and test.
