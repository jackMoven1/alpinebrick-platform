# Catalog Admin — Phase B Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the admin console to `systems/core` for one complete path — list products including drafts, open one, publish it, and see it appear on the customer storefront.

**Architecture:** Four new admin endpoints in core under `/api/v1/admin/*`, alongside the image endpoints already there. The console's `mockApi` is replaced in the app by a real `api.js` of identical shape; the mock survives as a test double. Everything not backed by a real endpoint is visibly disabled rather than left to fail.

**Tech Stack:** Core — TypeScript, Express, Prisma, PostgreSQL, Vitest, supertest. admin-ui — React 18, Vite 5, Tailwind 3, react-router-dom 6, **plain JSX (no TypeScript)**, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-13-catalog-admin-phase-b-slice-design.md`

## Global Constraints

- **The public catalog routes must not widen.** `/api/v1/catalog/*` stays published-only. The admin surface is separate precisely so the public one never leaks drafts.
- **camelCase everywhere in core.** The console adapts; core does not change to snake_case. Settled by the ADR-0001 amendment and already consumed by the storefront.
- **Error codes on the new admin routes are UPPER_SNAKE** — `NOT_FOUND`, `VALIDATION_ERROR`, `INVALID_TRANSITION` — matching both the catalog routes and the console's existing `AdminApiError`. *(Known wart: `/api/v1/admin/images` uses lower_snake. Do not "fix" it here; that is a separate change with its own tests.)*
- **Money is integer cents.** Never a float, never dollars. The console's mock uses `price` as a number; that is mock-only and is not carried into `api.js`.
- **Unbacked features are DISABLED in the UI**, not merely throwing. Falling back to the mock is forbidden: edits appearing to succeed and vanishing on reload is data loss disguised as success.
- **`mockApi` and `store.js` are not deleted.** Six test files depend on them. The app stops importing them; the tests keep them.
- **admin-ui is plain JSX.** No TypeScript, no new state library, no new UI framework. Match the existing code.
- **Core's tests do not run from the repo root** — always `cd systems/core && npm test`.
- **A green suite does not mean the app compiles.** Run `npm run build` separately.
- **Core listens on 4000.**
- Branch off `main`: `git checkout -b <type>/<slug> main`.
- Every commit gets a `Co-Authored-By:` trailer and a subject naming the system touched.
- **Do not `git push`** — Jack approves pushes.

---

## Task 1: `updatedAt` on the product DTO

**Files:**
- Modify: `systems/core/src/catalog/catalog.service.ts`
- Modify: `contracts/openapi/catalog.yaml`
- Test: `systems/core/tests/catalog-dto.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ProductDto` gains `updatedAt: Date`.

**Why:** the console's product list renders a "last modified" column (`ProductList.jsx:91`). Core has the column in the database but does not expose it. Additive, so `catalog.yaml` goes to **3.1.0**, not 4.0.0.

- [ ] **Step 1: Write the failing test**

Add to `systems/core/tests/catalog-dto.test.ts`, inside the existing `describe('catalog DTO', ...)`:

```ts
  it('exposes updatedAt so an admin list can show last-modified', async () => {
    const p = await getProduct('dto-fixture')
    expect(p?.updatedAt).toBeInstanceOf(Date)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/core && npx vitest run tests/catalog-dto.test.ts`
Expected: FAIL — `expected undefined to be an instance of Date`.

- [ ] **Step 3: Add the field**

In `systems/core/src/catalog/catalog.service.ts`, add to the `ProductDto` interface beside `createdAt`:

```ts
  updatedAt: Date
```

And in `toDto`, beside `createdAt: p.createdAt,`:

```ts
    updatedAt: p.updatedAt,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd systems/core && npx vitest run tests/catalog-dto.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the contract**

In `contracts/openapi/catalog.yaml`, set `info.version` to `3.1.0` and add to the `Product` schema properties, after `createdAt`:

```yaml
        updatedAt:
          type: string
          format: date-time
          description: Last modification time. Additive in 3.1.0 for the admin console's last-modified column.
```

- [ ] **Step 6: Run the full core suite and commit**

Run: `cd systems/core && npm test`
Expected: all pass.

```bash
git add systems/core contracts/openapi/catalog.yaml
git commit -m "feat(core): expose updatedAt on the product DTO

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Admin read service

**Files:**
- Create: `systems/core/src/admin/admin-catalog.service.ts`
- Test: `systems/core/tests/admin-catalog-service.test.ts`

**Interfaces:**
- Consumes: Task 1's `ProductDto`.
- Produces:
  ```ts
  class AdminError extends Error { code: string }
  interface AdminProductSummary {
    id: string; slug: string; name: string; status: string
    categories: string[]; variantCount: number; imageCount: number; updatedAt: Date
  }
  adminListProducts(opts: { status?: string; search?: string; page?: number; pageSize?: number }):
    Promise<{ items: AdminProductSummary[]; total: number; page: number; pageSize: number }>
  adminGetProduct(id: string): Promise<ProductDto | null>
  ```

**The whole point:** these see **every status**, including drafts. The public equivalents hard-code `status: 'published'`.

- [ ] **Step 1: Write the failing test**

Create `systems/core/tests/admin-catalog-service.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { adminListProducts, adminGetProduct, AdminError } from '../src/admin/admin-catalog.service.js'
import { getProduct as publicGetProduct, listProducts as publicListProducts } from '../src/catalog/catalog.service.js'

async function make(slug: string, status: 'draft' | 'published' | 'archived', variants = 1, images = 1) {
  const p = await prisma.product.create({
    data: {
      slug, name: slug, productType: 'resale', status,
      variants: { create: Array.from({ length: variants }, (_, i) => ({ sku: `${slug}-${i}`, priceCents: 1000 })) },
    },
  })
  if (images > 0) {
    await prisma.image.createMany({
      data: Array.from({ length: images }, (_, i) => ({
        productId: p.id, storageKey: `products/${p.id}/i${i}/original.jpg`,
        alt: 'x', position: i, width: 10, height: 10,
        contentType: 'image/jpeg', byteSize: 1, status: 'ready' as const,
      })),
    })
  }
  return p
}

beforeEach(async () => { await resetDb() })
afterAll(async () => { await prisma.$disconnect() })

describe('adminListProducts', () => {
  it('returns products of EVERY status by default', async () => {
    await make('a-draft', 'draft')
    await make('b-published', 'published')
    await make('c-archived', 'archived')
    const r = await adminListProducts({})
    expect(r.items.map(i => i.slug).sort()).toEqual(['a-draft', 'b-published', 'c-archived'])
    expect(r.total).toBe(3)
  })

  // The reason a separate admin surface exists at all.
  it('sees a draft that the public list does not', async () => {
    await make('secret-draft', 'draft')
    const admin = await adminListProducts({})
    const pub = await publicListProducts({})
    expect(admin.items.map(i => i.slug)).toContain('secret-draft')
    expect(pub.items.map(i => i.slug)).not.toContain('secret-draft')
  })

  it('narrows to a single status when asked', async () => {
    await make('a-draft', 'draft')
    await make('b-published', 'published')
    const r = await adminListProducts({ status: 'draft' })
    expect(r.items.map(i => i.slug)).toEqual(['a-draft'])
  })

  it('rejects an unknown status rather than silently returning everything', async () => {
    await expect(adminListProducts({ status: 'bogus' })).rejects.toThrow(AdminError)
  })

  it('counts variants and images per product', async () => {
    await make('counted', 'draft', 3, 2)
    const r = await adminListProducts({})
    expect(r.items[0]).toMatchObject({ variantCount: 3, imageCount: 2 })
  })

  it('searches by name, case-insensitively', async () => {
    await make('dragon-fortress', 'draft')
    await make('coral-reef', 'draft')
    const r = await adminListProducts({ search: 'DRAGON' })
    expect(r.items.map(i => i.slug)).toEqual(['dragon-fortress'])
  })

  it('paginates and reports the full total', async () => {
    for (const s of ['p1', 'p2', 'p3']) await make(s, 'draft')
    const r = await adminListProducts({ page: 2, pageSize: 2 })
    expect(r.items).toHaveLength(1)
    expect(r.total).toBe(3)
  })

  it('exposes updatedAt for the last-modified column', async () => {
    await make('stamped', 'draft')
    const r = await adminListProducts({})
    expect(r.items[0]!.updatedAt).toBeInstanceOf(Date)
  })
})

describe('adminGetProduct', () => {
  it('loads a draft, which the public route refuses', async () => {
    const p = await make('draft-detail', 'draft')
    expect((await adminGetProduct(p.id))?.slug).toBe('draft-detail')
    expect(await publicGetProduct(p.id)).toBeNull()
  })

  it('loads an archived product', async () => {
    const p = await make('archived-detail', 'archived')
    expect((await adminGetProduct(p.id))?.slug).toBe('archived-detail')
  })

  it('returns null for an unknown id', async () => {
    expect(await adminGetProduct('nope')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/core && npx vitest run tests/admin-catalog-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `systems/core/src/admin/admin-catalog.service.ts`:

```ts
import { prisma } from '../prisma.js'
import type { ProductDto } from '../catalog/catalog.service.js'

export class AdminError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'AdminError'
  }
}

export interface AdminProductSummary {
  id: string
  slug: string
  name: string
  status: string
  categories: string[]
  variantCount: number
  imageCount: number
  updatedAt: Date
}

const STATUSES = ['draft', 'published', 'archived'] as const
type Status = (typeof STATUSES)[number]

/**
 * Admin list. Unlike the public list this returns EVERY status by default —
 * an admin console that cannot see drafts is useless. The public routes stay
 * published-only, which is why this is a separate surface rather than a flag.
 */
export async function adminListProducts(opts: {
  status?: string; search?: string; page?: number; pageSize?: number
}) {
  const page = opts.page ?? 1
  const pageSize = opts.pageSize ?? 20
  if (!Number.isInteger(page) || page < 1) {
    throw new AdminError('VALIDATION_ERROR', 'page must be an integer >= 1')
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new AdminError('VALIDATION_ERROR', 'pageSize must be an integer between 1 and 100')
  }
  if (opts.status !== undefined && !STATUSES.includes(opts.status as Status)) {
    throw new AdminError('VALIDATION_ERROR', `status must be one of: ${STATUSES.join(', ')}`)
  }

  const where: any = {}
  if (opts.status) where.status = opts.status as Status
  if (opts.search) where.name = { contains: opts.search, mode: 'insensitive' }

  const [rows, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        _count: { select: { variants: true, images: true } },
      },
    }),
    prisma.product.count({ where }),
  ])

  const items: AdminProductSummary[] = rows.map(r => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    status: r.status,
    categories: Array.isArray(r.categories) ? (r.categories as string[]) : [],
    variantCount: r._count.variants,
    imageCount: r._count.images,
    updatedAt: r.updatedAt,
  }))

  return { items, total, page, pageSize }
}

/** Admin detail. Loads a product in ANY status, including drafts. */
export async function adminGetProduct(id: string): Promise<ProductDto | null> {
  const p = await prisma.product.findUnique({
    where: { id },
    include: {
      variants: true,
      images: { where: { status: 'ready' }, orderBy: { position: 'asc' } },
    },
  })
  if (!p) return null
  return {
    id: p.id, slug: p.slug, name: p.name, description: p.description,
    productType: p.productType, releaseType: p.releaseType, status: p.status,
    images: p.images.map(i => ({
      storageKey: i.storageKey, alt: i.alt, width: i.width, height: i.height, position: i.position,
    })),
    categories: Array.isArray(p.categories) ? (p.categories as string[]) : [],
    pieces: p.pieces ?? null,
    difficulty: p.difficulty ?? null,
    ageRecommendation: p.ageRecommendation ?? null,
    dimensions: p.dimensions ?? null,
    longDescription: p.longDescription ?? '',
    features: Array.isArray(p.features) ? (p.features as string[]) : [],
    includes: Array.isArray(p.includes) ? (p.includes as string[]) : [],
    builderNotes: p.builderNotes ?? '',
    homePosition: p.homePosition ?? null,
    collectionPosition: p.collectionPosition ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    variants: p.variants.map(v => ({
      id: v.id, sku: v.sku, priceCents: v.priceCents, currency: v.currency,
    })),
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd systems/core && npx vitest run tests/admin-catalog-service.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add systems/core/src/admin systems/core/tests/admin-catalog-service.test.ts
git commit -m "feat(core): admin catalog reads that can see drafts

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Status transitions

**Files:**
- Modify: `systems/core/src/admin/admin-catalog.service.ts`
- Test: `systems/core/tests/admin-status.test.ts`

**Interfaces:**
- Consumes: Task 2's `AdminError`, `adminGetProduct`.
- Produces: `setProductStatus(id: string, target: string): Promise<ProductDto>`, plus exported `ALLOWED_TRANSITIONS: Record<string, string[]>`.

**The transition table**, from the spec:

| From → To | Allowed |
|---|---|
| `draft` → `published` | Yes |
| `published` → `draft` | Yes (unpublish) |
| `draft` / `published` → `archived` | Yes |
| `archived` → `draft` | Yes (restore) |
| `archived` → `published` | **No** — restore to draft first |
| any → same | **No** |

- [ ] **Step 1: Write the failing test**

Create `systems/core/tests/admin-status.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { setProductStatus, AdminError } from '../src/admin/admin-catalog.service.js'
import { getProduct as publicGetProduct } from '../src/catalog/catalog.service.js'

async function make(status: 'draft' | 'published' | 'archived') {
  return prisma.product.create({
    data: { slug: `s-${status}-${Date.now()}`, name: 'S', productType: 'resale', status },
  })
}

beforeEach(async () => { await resetDb() })
afterAll(async () => { await prisma.$disconnect() })

describe('setProductStatus', () => {
  it('publishes a draft', async () => {
    const p = await make('draft')
    const r = await setProductStatus(p.id, 'published')
    expect(r.status).toBe('published')
  })

  // The success criterion for the whole slice, at the service level.
  it('makes a published product visible to the PUBLIC route', async () => {
    const p = await make('draft')
    expect(await publicGetProduct(p.id)).toBeNull()
    await setProductStatus(p.id, 'published')
    expect((await publicGetProduct(p.id))?.id).toBe(p.id)
  })

  it('unpublishes back to draft, hiding it from the public route again', async () => {
    const p = await make('published')
    await setProductStatus(p.id, 'draft')
    expect(await publicGetProduct(p.id)).toBeNull()
  })

  it('archives from draft and from published', async () => {
    const a = await make('draft')
    const b = await make('published')
    expect((await setProductStatus(a.id, 'archived')).status).toBe('archived')
    expect((await setProductStatus(b.id, 'archived')).status).toBe('archived')
  })

  it('restores an archived product to draft', async () => {
    const p = await make('archived')
    expect((await setProductStatus(p.id, 'draft')).status).toBe('draft')
  })

  // Republishing something withdrawn should be considered, not one click.
  it('refuses to publish straight from archived', async () => {
    const p = await make('archived')
    await expect(setProductStatus(p.id, 'published')).rejects.toThrow(AdminError)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('archived')
  })

  it('refuses a no-op transition', async () => {
    const p = await make('draft')
    await expect(setProductStatus(p.id, 'draft')).rejects.toThrow(AdminError)
  })

  it('rejects an unknown target status', async () => {
    const p = await make('draft')
    await expect(setProductStatus(p.id, 'bogus')).rejects.toThrow(AdminError)
  })

  it('rejects an unknown product', async () => {
    await expect(setProductStatus('nope', 'published')).rejects.toThrow(AdminError)
  })

  it('moves updatedAt forward', async () => {
    const p = await make('draft')
    const before = p.updatedAt.getTime()
    await new Promise(r => setTimeout(r, 5))
    const r = await setProductStatus(p.id, 'published')
    expect(r.updatedAt.getTime()).toBeGreaterThan(before)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/core && npx vitest run tests/admin-status.test.ts`
Expected: FAIL — `setProductStatus` is not exported.

- [ ] **Step 3: Implement**

Append to `systems/core/src/admin/admin-catalog.service.ts`:

```ts
/**
 * Legal status moves.
 *
 * archived -> published is deliberately absent: republishing something that was
 * withdrawn should be a considered act, so it must pass back through draft.
 * A move to the status a product already has is also rejected — a no-op
 * transition is a client bug worth surfacing rather than absorbing.
 */
export const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ['published', 'archived'],
  published: ['draft', 'archived'],
  archived: ['draft'],
}

export async function setProductStatus(id: string, target: string): Promise<ProductDto> {
  if (!STATUSES.includes(target as Status)) {
    throw new AdminError('VALIDATION_ERROR', `status must be one of: ${STATUSES.join(', ')}`)
  }

  const existing = await prisma.product.findUnique({ where: { id } })
  if (!existing) throw new AdminError('NOT_FOUND', 'product not found')

  const allowed = ALLOWED_TRANSITIONS[existing.status] ?? []
  if (!allowed.includes(target)) {
    throw new AdminError(
      'INVALID_TRANSITION',
      `cannot move from ${existing.status} to ${target}; allowed: ${allowed.join(', ') || 'none'}`,
    )
  }

  await prisma.product.update({ where: { id }, data: { status: target as Status } })

  // Re-read through adminGetProduct so the response shape is identical to the
  // detail endpoint's; the console replaces its loaded product with this.
  const updated = await adminGetProduct(id)
  if (!updated) throw new AdminError('NOT_FOUND', 'product not found')
  return updated
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd systems/core && npx vitest run tests/admin-status.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add systems/core/src/admin systems/core/tests/admin-status.test.ts
git commit -m "feat(core): validated product status transitions

archived -> published is blocked deliberately; restoring something withdrawn
passes back through draft so it gets a second look before facing customers.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Overview counts

**Files:**
- Modify: `systems/core/src/admin/admin-catalog.service.ts`
- Test: `systems/core/tests/admin-overview.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface AdminOverview {
    totalProducts: number; published: number; draft: number; archived: number
    recentlyModified: AdminProductSummary[]
    missingVariants: AdminProductSummary[]
  }
  getOverview(): Promise<AdminOverview>
  ```

**`missingImages` is deliberately absent.** Every product currently has placeholder images, so the check would report "nothing needs attention" while in fact every product is missing real photography — technically correct and practically a lie. See spec §7.

- [ ] **Step 1: Write the failing test**

Create `systems/core/tests/admin-overview.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { getOverview } from '../src/admin/admin-catalog.service.js'

async function make(slug: string, status: 'draft' | 'published' | 'archived', variants = 1) {
  return prisma.product.create({
    data: {
      slug, name: slug, productType: 'resale', status,
      variants: { create: Array.from({ length: variants }, (_, i) => ({ sku: `${slug}-${i}`, priceCents: 100 })) },
    },
  })
}

beforeEach(async () => { await resetDb() })
afterAll(async () => { await prisma.$disconnect() })

describe('getOverview', () => {
  it('counts products by status', async () => {
    await make('d1', 'draft'); await make('d2', 'draft')
    await make('p1', 'published')
    await make('a1', 'archived')
    const o = await getOverview()
    expect(o).toMatchObject({ totalProducts: 4, draft: 2, published: 1, archived: 1 })
  })

  it('returns zeroes on an empty catalogue rather than throwing', async () => {
    const o = await getOverview()
    expect(o).toMatchObject({ totalProducts: 0, draft: 0, published: 0, archived: 0 })
    expect(o.recentlyModified).toEqual([])
  })

  it('lists the five most recently modified, newest first', async () => {
    for (const s of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
      await make(s, 'draft')
      await new Promise(r => setTimeout(r, 3))
    }
    const o = await getOverview()
    expect(o.recentlyModified).toHaveLength(5)
    expect(o.recentlyModified[0]!.slug).toBe('p6')
  })

  it('flags products with no variants, which cannot be sold', async () => {
    await make('sellable', 'draft', 1)
    await make('unsellable', 'draft', 0)
    const o = await getOverview()
    expect(o.missingVariants.map(p => p.slug)).toEqual(['unsellable'])
  })

  it('does not flag archived products as missing variants', async () => {
    await make('archived-empty', 'archived', 0)
    const o = await getOverview()
    expect(o.missingVariants).toEqual([])
  })

  // Every product has placeholder images, so this check would report all-clear
  // while every product is in fact missing real photography.
  it('does NOT report missingImages', async () => {
    const o = await getOverview()
    expect(o).not.toHaveProperty('missingImages')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/core && npx vitest run tests/admin-overview.test.ts`
Expected: FAIL — `getOverview` is not exported.

- [ ] **Step 3: Implement**

Append to `systems/core/src/admin/admin-catalog.service.ts`:

```ts
export interface AdminOverview {
  totalProducts: number
  published: number
  draft: number
  archived: number
  recentlyModified: AdminProductSummary[]
  missingVariants: AdminProductSummary[]
}

function toSummary(r: any): AdminProductSummary {
  return {
    id: r.id, slug: r.slug, name: r.name, status: r.status,
    categories: Array.isArray(r.categories) ? (r.categories as string[]) : [],
    variantCount: r._count.variants,
    imageCount: r._count.images,
    updatedAt: r.updatedAt,
  }
}

/**
 * Console home counts.
 *
 * There is deliberately NO missingImages field. Every product currently has
 * placeholder images, so the check would render an all-clear while every
 * product is missing real photography. It cannot be written honestly until
 * placeholder and real can be told apart.
 */
export async function getOverview(): Promise<AdminOverview> {
  const counts = await prisma.product.groupBy({ by: ['status'], _count: { _all: true } })
  const byStatus = Object.fromEntries(counts.map(c => [c.status, c._count._all]))

  const include = { _count: { select: { variants: true, images: true } } }

  const [recent, noVariants] = await Promise.all([
    prisma.product.findMany({ orderBy: { updatedAt: 'desc' }, take: 5, include }),
    prisma.product.findMany({
      where: { status: { not: 'archived' }, variants: { none: {} } },
      orderBy: { updatedAt: 'desc' },
      include,
    }),
  ])

  return {
    totalProducts: counts.reduce((n, c) => n + c._count._all, 0),
    published: byStatus.published ?? 0,
    draft: byStatus.draft ?? 0,
    archived: byStatus.archived ?? 0,
    recentlyModified: recent.map(toSummary),
    missingVariants: noVariants.map(toSummary),
  }
}
```

Then refactor `adminListProducts` to build its items with `toSummary(r)` instead of the inline object, so there is one definition of a summary.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd systems/core && npx vitest run tests/admin-overview.test.ts tests/admin-catalog-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add systems/core/src/admin systems/core/tests/admin-overview.test.ts
git commit -m "feat(core): admin overview counts, without missingImages

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Admin routes

**Files:**
- Create: `systems/core/src/admin/admin-catalog.routes.ts`
- Modify: `systems/core/src/app.ts`
- Test: `systems/core/tests/admin-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces: `adminCatalogRouter` mounted at `/api/v1/admin`, exposing `GET /products`, `GET /products/:id`, `POST /products/:id/status`, `GET /overview`, with `{ code, message }` errors.

- [ ] **Step 1: Write the failing test**

Create `systems/core/tests/admin-routes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'

const app = buildApp()

async function make(slug: string, status: 'draft' | 'published' | 'archived') {
  return prisma.product.create({
    data: {
      slug, name: slug, productType: 'resale', status,
      variants: { create: [{ sku: `${slug}-1`, priceCents: 1000 }] },
    },
  })
}

beforeEach(async () => { await resetDb() })
afterAll(async () => { await prisma.$disconnect() })

describe('admin catalog routes', () => {
  it('lists every status', async () => {
    await make('d', 'draft'); await make('p', 'published')
    const res = await request(app).get('/api/v1/admin/products')
    expect(res.status).toBe(200)
    expect(res.body.items.map((i: any) => i.slug).sort()).toEqual(['d', 'p'])
    expect(res.body.items[0]).toHaveProperty('variantCount')
    expect(res.body.items[0]).toHaveProperty('updatedAt')
  })

  it('filters by status', async () => {
    await make('d', 'draft'); await make('p', 'published')
    const res = await request(app).get('/api/v1/admin/products?status=draft')
    expect(res.body.items.map((i: any) => i.slug)).toEqual(['d'])
  })

  it('rejects a bad status with a structured error', async () => {
    const res = await request(app).get('/api/v1/admin/products?status=bogus')
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_ERROR')
    expect(typeof res.body.message).toBe('string')
  })

  it('loads a draft by id', async () => {
    const p = await make('draft-detail', 'draft')
    const res = await request(app).get(`/api/v1/admin/products/${p.id}`)
    expect(res.status).toBe(200)
    expect(res.body.slug).toBe('draft-detail')
  })

  it('404s an unknown product', async () => {
    const res = await request(app).get('/api/v1/admin/products/nope')
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })

  it('publishes a draft', async () => {
    const p = await make('to-publish', 'draft')
    const res = await request(app)
      .post(`/api/v1/admin/products/${p.id}/status`).send({ status: 'published' })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('published')
  })

  it('409s an illegal transition', async () => {
    const p = await make('arch', 'archived')
    const res = await request(app)
      .post(`/api/v1/admin/products/${p.id}/status`).send({ status: 'published' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('INVALID_TRANSITION')
  })

  it('400s a missing status in the body', async () => {
    const p = await make('nobody', 'draft')
    const res = await request(app).post(`/api/v1/admin/products/${p.id}/status`).send({})
    expect(res.status).toBe(400)
  })

  it('returns overview counts', async () => {
    await make('d', 'draft'); await make('p', 'published')
    const res = await request(app).get('/api/v1/admin/overview')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ totalProducts: 2, draft: 1, published: 1 })
    expect(res.body).not.toHaveProperty('missingImages')
  })

  // The regression that would leak unpublished products to customers.
  it('does not widen the PUBLIC catalog route', async () => {
    await make('still-secret', 'draft')
    const res = await request(app).get('/api/v1/catalog/products')
    expect(res.body.items.map((i: any) => i.slug)).not.toContain('still-secret')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/core && npx vitest run tests/admin-routes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the router**

Create `systems/core/src/admin/admin-catalog.routes.ts`:

```ts
import { Router, type Response } from 'express'
import {
  adminListProducts, adminGetProduct, setProductStatus, getOverview, AdminError,
} from './admin-catalog.service.js'

// Error codes here are UPPER_SNAKE, matching the catalog routes and the
// console's existing AdminApiError. (/api/v1/admin/images uses lower_snake —
// a known inconsistency, deliberately not changed here.)
const STATUS_BY_CODE: Record<string, number> = {
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  INVALID_TRANSITION: 409,
}

function fail(res: Response, err: unknown) {
  if (err instanceof AdminError) {
    return res.status(STATUS_BY_CODE[err.code] ?? 400).json({ code: err.code, message: err.message })
  }
  throw err
}

function intParam(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined
  const n = Number(v)
  return Number.isInteger(n) ? n : undefined
}

export const adminCatalogRouter = Router()

adminCatalogRouter.get('/products', async (req, res) => {
  try {
    res.json(await adminListProducts({
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      page: intParam(req.query.page),
      pageSize: intParam(req.query.pageSize),
    }))
  } catch (err) { fail(res, err) }
})

adminCatalogRouter.get('/products/:id', async (req, res) => {
  const p = await adminGetProduct(req.params.id)
  if (!p) return res.status(404).json({ code: 'NOT_FOUND', message: 'product not found' })
  res.json(p)
})

adminCatalogRouter.post('/products/:id/status', async (req, res) => {
  const { status } = req.body ?? {}
  if (typeof status !== 'string') {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'status is required' })
  }
  try {
    res.json(await setProductStatus(req.params.id, status))
  } catch (err) { fail(res, err) }
})

adminCatalogRouter.get('/overview', async (_req, res) => {
  res.json(await getOverview())
})
```

- [ ] **Step 4: Mount it**

In `systems/core/src/app.ts`, add the import:

```ts
import { adminCatalogRouter } from './admin/admin-catalog.routes.js'
```

And mount it beside the images router:

```ts
  app.use('/api/v1/admin', adminCatalogRouter)
```

- [ ] **Step 5: Run tests, then the whole suite**

Run: `cd systems/core && npx vitest run tests/admin-routes.test.ts`
Expected: PASS, 10 tests.

Run: `cd systems/core && npm test && npx tsc --noEmit && npm run build`
Expected: all pass, no type errors, clean build.

- [ ] **Step 6: Commit**

```bash
git add systems/core/src systems/core/tests/admin-routes.test.ts
git commit -m "feat(core): admin catalog routes

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: The console's real API client

**Files:**
- Create: `systems/admin-ui/src/data/api.js`
- Create: `systems/admin-ui/src/data/api.test.js`
- Modify: `systems/admin-ui/vite.config.js`

**Interfaces:**
- Consumes: Task 5's endpoints.
- Produces: a default-exported `api` object with **the same 16 method names as `mockApi`**. Five call core; eleven throw `NotImplementedInSlice`.

**Naming:** core speaks camelCase and the console's mock speaks snake_case. `api.js` returns **camelCase**; the four components that render those fields are updated in Task 7. Core does not change.

- [ ] **Step 1: Add the dev proxy**

In `systems/admin-ui/vite.config.js`, add a `server` block so `/api` reaches core:

```js
  server: {
    port: 5174,
    // Core listens on 4000. Port 5174 keeps the console clear of the
    // storefront's 5173 so both can run at once.
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
  },
```

- [ ] **Step 2: Write the failing test**

Create `systems/admin-ui/src/data/api.test.js`:

```js
import { describe, it, expect, vi, afterEach } from 'vitest'
import api from './api.js'
import { AdminApiError } from './errors.js'

function mockFetch(status, body) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status < 400, status, json: async () => body,
  })))
}

afterEach(() => vi.unstubAllGlobals())

describe('listProducts', () => {
  it('sends only the parameters supplied', async () => {
    const spy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [], total: 0, page: 1, pageSize: 20 }) }))
    vi.stubGlobal('fetch', spy)
    await api.listProducts({ status: 'draft', page: 2 })
    const url = String(spy.mock.calls[0][0])
    expect(url).toContain('status=draft')
    expect(url).toContain('page=2')
    expect(url).not.toContain('search=')
  })

  it('returns the envelope unchanged', async () => {
    mockFetch(200, { items: [{ id: 'p1', slug: 's', name: 'N', status: 'draft', categories: [], variantCount: 1, imageCount: 0, updatedAt: '2026-08-13T00:00:00Z' }], total: 1, page: 1, pageSize: 20 })
    const r = await api.listProducts({})
    expect(r.total).toBe(1)
    expect(r.items[0].variantCount).toBe(1)
  })
})

describe('error handling', () => {
  it('throws AdminApiError carrying the server code', async () => {
    mockFetch(400, { code: 'VALIDATION_ERROR', message: 'bad status' })
    await expect(api.listProducts({})).rejects.toMatchObject({
      name: 'AdminApiError', code: 'VALIDATION_ERROR', message: 'bad status',
    })
  })

  it('surfaces an illegal transition as INVALID_TRANSITION', async () => {
    mockFetch(409, { code: 'INVALID_TRANSITION', message: 'cannot move from archived to published' })
    const err = await api.setProductStatus('p1', 'published').catch(e => e)
    expect(err).toBeInstanceOf(AdminApiError)
    expect(err.code).toBe('INVALID_TRANSITION')
  })

  // A network failure has no envelope; it must still be branchable on .code.
  it('synthesises INTERNAL when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const err = await api.getOverviewStats().catch(e => e)
    expect(err.code).toBe('INTERNAL')
  })
})

describe('unimplemented methods', () => {
  it('exposes every method mockApi does', async () => {
    const expected = [
      'getOverviewStats', 'listProducts', 'getProduct', 'createProduct', 'updateProduct',
      'archiveProduct', 'setProductStatus', 'bulkSetStatus', 'createVariant', 'updateVariant',
      'deleteVariant', 'bulkCreateVariants', 'addImage', 'reorderImages', 'updateImageAlt', 'deleteImage',
    ]
    for (const m of expected) expect(typeof api[m]).toBe('function')
  })

  // Falling back to the mock would show edits succeeding and losing them on
  // reload. Throwing is the safe failure.
  it('throws rather than silently succeeding', async () => {
    await expect(api.createProduct({ name: 'x' })).rejects.toThrow(/not implemented/i)
    await expect(api.createVariant('p1', {})).rejects.toThrow(/not implemented/i)
    await expect(api.updateProduct('p1', {})).rejects.toThrow(/not implemented/i)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd systems/admin-ui && npx vitest run src/data/api.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `systems/admin-ui/src/data/api.js`:

```js
import { AdminApiError } from './errors.js'

// NOTE the argument order. The console's AdminApiError is
// (message, code, fields) — message FIRST. Core's AdminError is
// (code, message) — code first. They are different classes in different
// packages and the orders are opposite, which is easy to get backwards and
// produces an error whose code reads like a sentence.
const BASE = '/api/v1/admin'
const GENERIC = 'Something went wrong. Please try again.'

/**
 * Every failure leaves here as an AdminApiError with a usable `code`, so the
 * console can branch on it. Network and parse failures carry no server
 * envelope, so they are given INTERNAL.
 */
async function call(path, options = {}) {
  let res
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      ...options,
    })
  } catch {
    throw new AdminApiError(GENERIC, 'INTERNAL')
  }

  if (!res.ok) {
    let body
    try { body = await res.json() } catch { throw new AdminApiError(GENERIC, 'INTERNAL') }
    throw new AdminApiError(body?.message || GENERIC, body?.code || 'INTERNAL', body?.fields)
  }

  if (res.status === 204) return null
  try { return await res.json() } catch { throw new AdminApiError(GENERIC, 'INTERNAL') }
}

/**
 * Phase B slice: five methods are live, eleven are not.
 *
 * These MUST throw rather than fall back to the mock. A mock fallback would
 * show an edit succeeding and lose it on reload — data loss disguised as
 * success. The UI also disables the affected controls (see the catalog
 * components), so this throw is a backstop, not the user-facing message.
 */
function notImplemented(name) {
  return async () => {
    throw new AdminApiError(
      `${name} is not implemented in the Phase B slice`,
      'NOT_IMPLEMENTED',
    )
  }
}

export const api = {
  async getOverviewStats() {
    return call('/overview')
  },

  async listProducts(opts = {}) {
    const params = new URLSearchParams()
    if (opts.status) params.set('status', opts.status)
    if (opts.search) params.set('search', opts.search)
    if (opts.page) params.set('page', String(opts.page))
    if (opts.limit) params.set('pageSize', String(opts.limit))
    const qs = params.toString()
    return call(`/products${qs ? `?${qs}` : ''}`)
  },

  async getProduct(id) {
    return call(`/products/${encodeURIComponent(id)}`)
  },

  async setProductStatus(id, status) {
    return call(`/products/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    })
  },

  async archiveProduct(id) {
    return api.setProductStatus(id, 'archived')
  },

  createProduct: notImplemented('createProduct'),
  updateProduct: notImplemented('updateProduct'),
  bulkSetStatus: notImplemented('bulkSetStatus'),
  createVariant: notImplemented('createVariant'),
  updateVariant: notImplemented('updateVariant'),
  deleteVariant: notImplemented('deleteVariant'),
  bulkCreateVariants: notImplemented('bulkCreateVariants'),
  addImage: notImplemented('addImage'),
  reorderImages: notImplemented('reorderImages'),
  updateImageAlt: notImplemented('updateImageAlt'),
  deleteImage: notImplemented('deleteImage'),
}

export default api
```

Note `listProducts` maps the console's `limit` option onto core's `pageSize` — the console calls it `limit` (`ProductList.jsx:21`) and core calls it `pageSize`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd systems/admin-ui && npx vitest run src/data/api.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add systems/admin-ui/src/data/api.js systems/admin-ui/src/data/api.test.js systems/admin-ui/vite.config.js
git commit -m "feat(admin-ui): real core API client alongside the mock

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Wire the console and disable what is not backed

**Files:**
- Modify: `systems/admin-ui/src/catalog/CatalogOverview.jsx`
- Modify: `systems/admin-ui/src/catalog/ProductList.jsx`
- Modify: `systems/admin-ui/src/catalog/ProductDetail.jsx`
- Modify: `systems/admin-ui/src/catalog/tabs/PublishTab.jsx`
- Modify: `systems/admin-ui/src/catalog/tabs/InfoTab.jsx`
- Modify: `systems/admin-ui/src/catalog/tabs/VariantsTab.jsx`
- Modify: `systems/admin-ui/src/catalog/tabs/ImagesTab.jsx`
- Modify: `systems/admin-ui/src/catalog/ProductForm.jsx`
- Test: `systems/admin-ui/src/catalog/slice.test.jsx`

**Interfaces:**
- Consumes: Task 6's `api`.

**The existing `catalog.test.jsx` keeps importing `mockApi` and must keep passing.** It tests component behaviour against a double; that coverage is not thrown away.

- [ ] **Step 1: Write the failing test**

Create `systems/admin-ui/src/catalog/slice.test.jsx`:

```jsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import PublishTab from './tabs/PublishTab.jsx'
import VariantsTab from './tabs/VariantsTab.jsx'
import ImagesTab from './tabs/ImagesTab.jsx'
import InfoTab from './tabs/InfoTab.jsx'

vi.mock('../data/api.js', () => ({
  default: { setProductStatus: vi.fn(async () => ({ id: 'p1', status: 'published' })) },
}))
import api from '../data/api.js'

const product = {
  id: 'p1', name: 'P', slug: 'p', description: 'd', status: 'draft',
  categories: [], variants: [{ id: 'v1', sku: 'S', priceCents: 100 }], images: [],
}

afterEach(() => vi.clearAllMocks())

const wrap = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>)

describe('PublishTab — the live path', () => {
  it('publishes through the real api', async () => {
    wrap(<PublishTab product={product} onUpdated={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /publish/i }))
    expect(api.setProductStatus).toHaveBeenCalledWith('p1', 'published')
  })
})

// Unbacked features must be visibly unavailable BEFORE effort is invested,
// not throw after a form is filled in.
describe('unbacked tabs are disabled', () => {
  it('VariantsTab explains it is unavailable and offers no enabled control', () => {
    wrap(<VariantsTab product={product} onUpdated={() => {}} />)
    expect(screen.getByText(/not in this phase/i)).toBeInTheDocument()
    for (const b of screen.queryAllByRole('button')) expect(b).toBeDisabled()
  })

  it('ImagesTab explains it is unavailable and offers no enabled control', () => {
    wrap(<ImagesTab product={product} onUpdated={() => {}} />)
    expect(screen.getByText(/not in this phase/i)).toBeInTheDocument()
    for (const b of screen.queryAllByRole('button')) expect(b).toBeDisabled()
  })

  it('InfoTab renders its fields read-only', () => {
    wrap(<InfoTab product={product} onUpdated={() => {}} />)
    expect(screen.getByText(/not in this phase/i)).toBeInTheDocument()
    for (const f of screen.queryAllByRole('textbox')) expect(f).toHaveAttribute('readonly')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/admin-ui && npx vitest run src/catalog/slice.test.jsx`
Expected: FAIL — components still import `mockApi`, and no "not in this phase" text exists.

- [ ] **Step 3: Switch the four live components to `api`**

In each of `CatalogOverview.jsx`, `ProductList.jsx`, `ProductDetail.jsx` and `tabs/PublishTab.jsx`, change the import:

```js
import api from '../data/api.js'      // CatalogOverview, ProductList, ProductDetail
import api from '../../data/api.js'   // PublishTab
```

and replace every `mockApi.` with `api.`.

- [ ] **Step 4: Update the two snake_case fields the list renders**

In `ProductList.jsx`, core returns camelCase:

```jsx
                <td className="p-3">{p.variantCount}</td>
```

```jsx
                <td className="p-3 text-gray-500">{new Date(p.updatedAt).toLocaleDateString()}</td>
```

- [ ] **Step 5: Disable the bulk status control**

`bulkSetStatus` is not backed. `ProductList.jsx:31` is the handler that calls it
— find the control(s) wired to that handler, add `disabled` to each, and put a
note beside them:

```jsx
      <span className="text-xs text-gray-500">Bulk status changes are not in this phase.</span>
```

Leave the handler itself in place. It becomes live again when `bulkSetStatus`
is implemented, and deleting it would mean rebuilding the selection wiring.

- [ ] **Step 6: Disable the three unbacked tabs**

In `tabs/VariantsTab.jsx`, `tabs/ImagesTab.jsx` and `tabs/InfoTab.jsx`, remove the `mockApi` import and its calls, and render the existing content with every control disabled, preceded by:

```jsx
      <div className="rounded-xl bg-gray-100 px-4 py-3 text-sm text-gray-600">
        Editing is not in this phase — this view is read-only.
      </div>
```

For `VariantsTab` and `ImagesTab`, add `disabled` to every `<button>` and `<input>`. For `InfoTab`, add `readOnly` to every text field and drop the auto-save call.

- [ ] **Step 7: Hide product creation**

`createProduct` is not backed. In `ProductList.jsx`, remove the link or button that routes to `ProductForm`. Leave `ProductForm.jsx` on disk and unrouted — it is Phase B work, not dead code.

- [ ] **Step 8: Run the whole console suite**

Run: `cd systems/admin-ui && npx vitest run`
Expected: all pass, **including the existing `catalog.test.jsx` against `mockApi`**. If it fails because a component no longer imports `mockApi`, update that test to import `api` and mock it — do not delete the assertions.

- [ ] **Step 9: Build and commit**

Run: `cd systems/admin-ui && npm run build`
Expected: clean.

```bash
git add systems/admin-ui/src
git commit -m "feat(admin-ui): wire list, detail, overview and publish to core

Unbacked features are disabled with a visible note rather than left to throw:
a mock fallback would show edits succeeding and lose them on reload.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: End-to-end verification and docs

**Files:**
- Modify: `systems/admin-ui/README.md`
- Modify: `docs/superpowers/specs/2026-06-04-catalog-admin-ui-design.md`

- [ ] **Step 1: Verify both systems**

```bash
cd systems/core && npm test && npx tsc --noEmit && npm run build
cd ../admin-ui && npx vitest run && npm run build
cd ../storefront/code && npx vitest run && npm run build
```

Expected: all green. The storefront is included because Task 1 changed a shared DTO.

- [ ] **Step 2: Prove the success criterion by hand**

This is the whole point of the slice. Start core and both frontends:

```bash
cd systems/core && npm run seed && node dist/server.js
```

```bash
cd systems/admin-ui && npm run dev          # :5174
cd systems/storefront/code && npm run dev   # :5173
```

Then, in order:

1. Create a draft directly, since product creation is not in this slice:
   ```bash
   docker exec alpinebrick-core-db psql -U postgres -d alpinebrick_core -c \
     "INSERT INTO products (id, slug, name, description, product_type, release_type, status, categories, created_at, updated_at, long_description, features, includes, builder_notes) VALUES ('slice-demo','slice-demo','Slice Demo','','resale','standard','draft','[]'::jsonb, NOW(), NOW(), '', '[]'::jsonb, '[]'::jsonb, '');"
   ```
2. Open the console at `http://localhost:5174`. **The draft appears in the product list.**
3. Confirm the storefront at `http://localhost:5173` does **not** show it.
4. Open the product in the console and click **Publish**.
5. Refresh the storefront. **The product is there.**
6. Click **Set to draft** in the console, refresh the storefront: it is gone again.
7. Archive it, then confirm **Publish is refused** with a clear message rather than silently failing.

Record the outcome. If step 5 fails, stop — the slice has not achieved its purpose and the cause matters more than the remaining steps.

- [ ] **Step 3: Check the client's fixtures against core's real responses**

Task 6's tests stub `fetch` with hand-written bodies. That is fine for logic but
proves nothing about whether the shapes match reality. With core running,
capture a real response and compare it field-for-field:

```bash
curl -s "http://localhost:4000/api/v1/admin/products?pageSize=1" | python -m json.tool
curl -s "http://localhost:4000/api/v1/admin/overview" | python -m json.tool
```

Confirm against `src/data/api.test.js`:

- the list envelope is `{ items, total, page, pageSize }`;
- a list item carries `variantCount`, `imageCount`, `updatedAt` — **camelCase,
  not snake_case**;
- the overview carries `totalProducts`, `published`, `draft`, `archived`,
  `recentlyModified`, `missingVariants` and **no `missingImages`**.

If any field name differs, fix the test fixture to match core — core is the
source of truth. A fixture that disagrees with the server is worse than no
fixture, because it passes while the app breaks.

- [ ] **Step 4: Confirm the disabled surfaces read as staged, not broken**

In the console, open the Variants, Images and Info tabs. Each should show its read-only note and no enabled control. Confirm there is no route to product creation.

- [ ] **Step 5: Update the console README**

Add to `systems/admin-ui/README.md`:

```markdown
## Wired to core (Phase B slice)

The console calls `systems/core` at `/api/v1/admin/*` through the Vite dev
proxy. Core must be running on **4000**; the console runs on **5174** so it
does not collide with the storefront on 5173.

**Five of sixteen data methods are live:** overview, product list, product
detail, and status changes (publish / unpublish / archive). Everything else —
product creation, editing, variants, images, bulk actions — is **visibly
disabled** in the UI and throws `NOT_IMPLEMENTED` in `src/data/api.js` as a
backstop.

`mockApi`/`store.js` are retained as a **test double**, not an app dependency.
Do not reintroduce a runtime fallback to the mock: an edit that appears to
succeed and vanishes on reload is data loss disguised as success.

**There is no authentication.** These are write endpoints. Do not expose core
or this console on a reachable network until auth exists.
```

- [ ] **Step 6: Mark the superseded section of the June design**

In `docs/superpowers/specs/2026-06-04-catalog-admin-ui-design.md`, add a note under the package-layout table:

```markdown
> **Superseded 2026-08-13 (§3 of the Phase B slice design).** The write API
> lives in `systems/core`, not `systems/catalog-admin`. Core is now the only
> backend of record, `catalog-admin` remains a stub, and the image admin
> endpoints already live in core — splitting would give two services writing
> one schema. Everything else in this design stands.
```

- [ ] **Step 7: Commit and report**

```bash
git add systems/admin-ui/README.md docs/superpowers/specs/2026-06-04-catalog-admin-ui-design.md
git commit -m "docs(admin-ui): record the wired slice and supersede the June backend choice

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Report test counts for all three systems and the outcome of the publish-to-storefront walkthrough. **Do not push** — Jack approves pushes.

---

## Carried out of this plan

1. **Authentication.** These are write endpoints with none, on top of image
   endpoints with none. Acceptable locally, not acceptable anywhere reachable.
   Needs its own spec, and it gates deployment of both admin surfaces.
2. **CORS and the admin domain.** The June design puts the console on its own
   domain. A dev proxy defers this until there is somewhere to deploy.
3. **The remaining eleven methods** — product create/edit, variant CRUD, bulk
   status, and the image upload rework. They now have a proven route, error
   envelope and DTO pattern to follow.
4. **Two error-code conventions in core.** `/api/v1/admin/images` uses
   lower_snake; everything else uses UPPER_SNAKE. Worth unifying, with tests,
   as its own change.
5. **`published_at` / `archived_at`.** The console's mock tracks them; core has
   no such columns and nothing in this slice renders them. Add them when
   something actually needs the timestamp.
6. **Audit log, version history, rollback.** Deferred by the June design and
   still deferred. Re-justify before inheriting them.
