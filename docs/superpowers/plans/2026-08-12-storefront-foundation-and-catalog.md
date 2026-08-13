# Storefront Foundation and Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Alpine Brick Exchange storefront foundation and catalog surface — a TypeScript React app on the design handoff's system, backed by real `systems/core` data.

**Architecture:** Four phases. Phase 1 extends core's catalog API with the fields, filtering, and sorting the design needs. Phase 2 replaces the Sprint-1 JSX storefront with a TypeScript app carrying the design system and shell. Phase 3 builds the catalog pages against the Phase 1 API. Phase 4 adds the static content pages. Each phase ends with working, tested software.

**Tech Stack:** Core — TypeScript, Express, Prisma, PostgreSQL, Vitest. Storefront — React 18, Vite, React Router v7, Tailwind CSS v4, TypeScript, lucide-react, Vitest, React Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-12-storefront-foundation-and-catalog-design.md`

## Global Constraints

- **All money is integer cents.** Never a float, never a dollar amount. Field names end in `Cents`.
- **Category values are lowercase kebab-case slugs** (`architecture`, `limited-edition`). Never display casing.
- **Foreground is `#f0ede8`, not `#ffffff`.** Pure white is reserved for the accent state only.
- **Display type is `Barlow Condensed` weight 900, uppercase, always.** Body is `DM Sans` 400/500/600. Nothing else.
- **Uppercase micro-labels are always letter-spaced** `0.12em`–`0.2em`.
- **`border-radius: 2px` on buttons and inputs only.** Cards, badges, and images are square. **No shadows anywhere.**
- **Never render `#8a8a8a` (`--muted-foreground`) below 12px.** Contrast is ~5.5:1 and fails under that size.
- **No fabricated data.** No invented ratings, review counts, testimonials, or press quotes.
- **The server owns display order; the UI never re-sorts.** Products arrive in the order they should be rendered. Two independent orderings exist — `homePosition` for the home page, `collectionPosition` within a collection — both ascending, unranked last, ties broken by name.
- **Core's tests do not run from the repo root** — `systems/core` is not in the npm workspaces and `npm test --workspaces` silently skips it. Always `cd systems/core && npm test`.
- **A green suite does not mean the app boots.** Vitest resolves TypeScript directly and never touches compiled output. Build and boot separately.
- Branch off `main`: `git checkout -b <type>/<slug> main`. Never commit onto a branch you did not create.
- Every commit gets a `Co-Authored-By:` trailer naming the agent, and a subject naming the system touched (`feat(core):`, `feat(storefront):`).
- **Do not `git push`** — Jack approves pushes.

---

# Phase 0 — Make the design handoff durable

## Task 0: Land the design package in the repo

**Files:**
- Create: `systems/storefront/design/handoff/` (the unpacked design package)
- Modify: `systems/storefront/design/references/README.md`

**Why this is first:** every later task refers to the handoff's reference app for
layout and copy. The package arrived as a zip and was unpacked to a **temporary
scratchpad that is deleted between sessions**. Until it is committed, this plan
cannot be executed by anyone but the session that wrote it.

- [ ] **Step 1: Copy the unpacked handoff into the repo**

Source: the extracted `design_handoff_alpine_brick_storefront/` directory.
Destination: `systems/storefront/design/handoff/`.

Copy all of it: `README.md` (the authoritative visual spec), `CLAUDE.md`,
`theme-tokens.css`, `Alpine Brick.dc.html`, `support.js`, and the whole
`figma-src/` tree.

- [ ] **Step 2: Exclude the reference app's build artifacts**

The reference app is a **reference**, never built or deployed from this
location. Confirm no `node_modules/` or `dist/` was copied:

```bash
find systems/storefront/design/handoff -name node_modules -o -name dist
```

Expected: no output.

- [ ] **Step 3: Note the package in the design README**

Append to `systems/storefront/design/references/README.md`:

```markdown
## The 2026-08-12 design handoff

`../handoff/` holds the full Figma design package for the storefront: the
authoritative visual spec (`handoff/README.md`), a runnable React reference app
(`handoff/figma-src/`), a single-file clickable prototype, and the token block.

**It is a reference, not a codebase.** Do not build or deploy from it. Where the
spec and the reference code disagree, the spec wins on visuals and the code wins
on behaviour — except for the three defects recorded in
`docs/superpowers/specs/2026-08-12-storefront-foundation-and-catalog-design.md`
section 6, which are not to be carried forward at all.
```

- [ ] **Step 4: Commit**

```bash
git add systems/storefront/design
git commit -m "docs(storefront): land the 2026-08-12 design handoff package

Arrived as a zip and was unpacked to a temp directory. Committing it so the
implementation plan is executable outside the session that wrote it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

# Phase 1 — Core catalog API

## Task 1: Product detail columns

**Files:**
- Modify: `systems/core/prisma/schema.prisma`
- Create: `systems/core/prisma/migrations/<timestamp>_add_product_details/migration.sql` (generated)
- Test: `systems/core/tests/product-details-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Difficulty` enum (`beginner` | `intermediate` | `advanced` | `expert`); `Product` columns `pieces: Int?`, `difficulty: Difficulty?`, `ageRecommendation: String?`, `dimensions: String?`, `longDescription: String` (default `""`), `features: Json` (default `[]`), `includes: Json` (default `[]`), `builderNotes: String` (default `""`), `homePosition: Int?`, `collectionPosition: Int?`.

- [ ] **Step 1: Write the failing test**

Create `systems/core/tests/product-details-schema.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'

describe('product detail columns', () => {
  beforeAll(async () => { await resetDb() })
  afterAll(async () => { await prisma.$disconnect() })

  it('persists and returns every detail field', async () => {
    const p = await prisma.product.create({
      data: {
        slug: 'detail-fixture', name: 'Detail Fixture',
        productType: 'own_designed', status: 'published',
        pieces: 2847,
        difficulty: 'expert',
        ageRecommendation: '16+',
        dimensions: '68 x 32 x 48 cm',
        longDescription: 'A long form description.',
        features: ['Opening doors', 'Poseable bridge'],
        includes: ['6 minifigures', 'Display nameplate'],
        builderNotes: 'The bridge took weeks.',
      },
    })
    const found = await prisma.product.findUniqueOrThrow({ where: { id: p.id } })
    expect(found.pieces).toBe(2847)
    expect(found.difficulty).toBe('expert')
    expect(found.ageRecommendation).toBe('16+')
    expect(found.dimensions).toBe('68 x 32 x 48 cm')
    expect(found.longDescription).toBe('A long form description.')
    expect(found.features).toEqual(['Opening doors', 'Poseable bridge'])
    expect(found.includes).toEqual(['6 minifigures', 'Display nameplate'])
    expect(found.builderNotes).toBe('The bridge took weeks.')
  })

  // Unranked products must sort LAST, so the column is nullable rather than
  // defaulted to 0 — a 0 default would promote every new product to the top.

  it('persists both display positions independently', async () => {
    const p = await prisma.product.create({
      data: {
        slug: 'position-fixture', name: 'Position Fixture',
        productType: 'resale', status: 'published',
        homePosition: 3, collectionPosition: 17,
      },
    })
    expect(p.homePosition).toBe(3)
    expect(p.collectionPosition).toBe(17)
  })

  it('defaults every detail field so existing rows stay valid', async () => {
    const p = await prisma.product.create({
      data: { slug: 'bare-fixture', name: 'Bare', productType: 'resale', status: 'published' },
    })
    expect(p.pieces).toBeNull()
    expect(p.difficulty).toBeNull()
    expect(p.ageRecommendation).toBeNull()
    expect(p.dimensions).toBeNull()
    expect(p.longDescription).toBe('')
    expect(p.features).toEqual([])
    expect(p.includes).toEqual([])
    expect(p.builderNotes).toBe('')
    expect(p.homePosition).toBeNull()
    expect(p.collectionPosition).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/core && npx vitest run tests/product-details-schema.test.ts`
Expected: FAIL — `Unknown argument 'pieces'`.

- [ ] **Step 3: Add the enum and columns to the schema**

In `systems/core/prisma/schema.prisma`, add the enum next to the other enums:

```prisma
enum Difficulty {
  beginner
  intermediate
  advanced
  expert
}
```

Add to `model Product`, after `categories`:

```prisma
  pieces            Int?
  difficulty        Difficulty?
  ageRecommendation String?     @map("age_recommendation")
  dimensions        String?
  longDescription   String      @default("") @map("long_description")
  features          Json        @default("[]")
  includes          Json        @default("[]")
  builderNotes      String      @default("") @map("builder_notes")
  homePosition       Int?       @map("home_position")
  collectionPosition Int?       @map("collection_position")
```

And add these indexes inside `model Product`, beside the existing `@@map`.
Every home-page and collection-page query orders by one of these columns:

```prisma
  @@index([homePosition])
  @@index([collectionPosition])
```

- [ ] **Step 4: Generate the migration**

Run: `cd systems/core && npx prisma migrate dev --name add_product_details`

Then confirm the new migration's timestamp directory sorts **after** `20260812194903_add_walmart_channel`. If it does not, the database was not at `main`'s migration state — reset and regenerate rather than renaming by hand.

Run: `ls prisma/migrations`

- [ ] **Step 5: Run test to verify it passes**

Run: `cd systems/core && npx vitest run tests/product-details-schema.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add systems/core/prisma systems/core/tests/product-details-schema.test.ts
git commit -m "feat(core): product detail columns for the storefront catalog

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: DTO exposes images, categories, and details

**Files:**
- Modify: `systems/core/src/catalog/catalog.service.ts`
- Test: `systems/core/tests/catalog-dto.test.ts`

**Interfaces:**
- Consumes: Task 1's columns.
- Produces: `ProductImage` = `{ url: string; alt: string }`. `ProductDto` gains `images: ProductImage[]`, `categories: string[]`, `pieces: number | null`, `difficulty: string | null`, `ageRecommendation: string | null`, `dimensions: string | null`, `longDescription: string`, `features: string[]`, `includes: string[]`, `builderNotes: string`. Exported helpers `toImages(v: unknown): ProductImage[]` and `toStringArray(v: unknown): string[]`.

- [ ] **Step 1: Write the failing test**

Create `systems/core/tests/catalog-dto.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { getProduct, toImages, toStringArray } from '../src/catalog/catalog.service.js'
import { resetDb } from './helpers/db.js'

describe('catalog DTO', () => {
  beforeAll(async () => {
    await resetDb()
    await prisma.product.create({
      data: {
        slug: 'dto-fixture', name: 'DTO Fixture', productType: 'own_designed',
        status: 'published', pieces: 100, difficulty: 'beginner',
        images: [{ url: '/img/a.jpg', alt: 'Front view' }],
        categories: ['architecture'],
        features: ['One'], includes: ['Two'],
      },
    })
  })
  afterAll(async () => { await prisma.$disconnect() })

  it('returns images and categories instead of dropping them', async () => {
    const p = await getProduct('dto-fixture')
    expect(p?.images).toEqual([{ url: '/img/a.jpg', alt: 'Front view' }])
    expect(p?.categories).toEqual(['architecture'])
    expect(p?.pieces).toBe(100)
    expect(p?.difficulty).toBe('beginner')
    expect(p?.features).toEqual(['One'])
    expect(p?.includes).toEqual(['Two'])
  })

  // Json columns are unvalidated at the database boundary. A corrupt value
  // must render as empty, never propagate to the client or crash the grid.
  it('coerces malformed images to an empty array', () => {
    expect(toImages(null)).toEqual([])
    expect(toImages('not-an-array')).toEqual([])
    expect(toImages([{ url: 'x' }])).toEqual([])          // missing alt
    expect(toImages([{ url: 1, alt: 2 }])).toEqual([])      // wrong types
    expect(toImages([{ url: 'a', alt: 'b' }, 'junk'])).toEqual([{ url: 'a', alt: 'b' }])
  })

  it('coerces malformed string arrays to an empty array', () => {
    expect(toStringArray(null)).toEqual([])
    expect(toStringArray({})).toEqual([])
    expect(toStringArray(['a', 2, 'b'])).toEqual(['a', 'b'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/core && npx vitest run tests/catalog-dto.test.ts`
Expected: FAIL — `toImages is not a function`.

- [ ] **Step 3: Implement**

In `systems/core/src/catalog/catalog.service.ts`, replace the `ProductDto` interface and `toDto` function:

```ts
export interface ProductImage { url: string; alt: string }

export interface ProductDto {
  id: string; slug: string; name: string; description: string
  productType: string; releaseType: string; status: string
  images: ProductImage[]
  categories: string[]
  pieces: number | null
  difficulty: string | null
  ageRecommendation: string | null
  dimensions: string | null
  longDescription: string
  features: string[]
  includes: string[]
  builderNotes: string
  createdAt: Date
  variants: { id: string; sku: string; priceCents: number; currency: string }[]
}

// `images` and `categories` are Json columns, so Postgres enforces nothing about
// their shape. Validate on read and drop anything malformed: a corrupt row must
// render without images rather than crash the grid.
export function toImages(v: unknown): ProductImage[] {
  if (!Array.isArray(v)) return []
  return v.filter(
    (i): i is ProductImage =>
      typeof i === 'object' && i !== null &&
      typeof (i as any).url === 'string' && typeof (i as any).alt === 'string',
  )
}

export function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((s): s is string => typeof s === 'string')
}

function toDto(p: any): ProductDto {
  return {
    id: p.id, slug: p.slug, name: p.name, description: p.description,
    productType: p.productType, releaseType: p.releaseType, status: p.status,
    images: toImages(p.images),
    categories: toStringArray(p.categories),
    pieces: p.pieces ?? null,
    difficulty: p.difficulty ?? null,
    ageRecommendation: p.ageRecommendation ?? null,
    dimensions: p.dimensions ?? null,
    longDescription: p.longDescription ?? '',
    features: toStringArray(p.features),
    includes: toStringArray(p.includes),
    builderNotes: p.builderNotes ?? '',
    createdAt: p.createdAt,
    variants: p.variants.map((v: any) => ({
      id: v.id, sku: v.sku, priceCents: v.priceCents, currency: v.currency,
    })),
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd systems/core && npx vitest run tests/catalog-dto.test.ts tests/catalog.test.ts`
Expected: PASS. If `catalog.test.ts` fails on the changed DTO shape, update its assertions — the new fields are intended.

- [ ] **Step 5: Commit**

```bash
git add systems/core/src/catalog/catalog.service.ts systems/core/tests
git commit -m "feat(core): expose images, categories and detail fields in the catalog DTO

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Category filter and frozen sort enum

**Files:**
- Modify: `systems/core/src/catalog/catalog.service.ts`
- Test: `systems/core/tests/catalog-filter-sort.test.ts`

**Interfaces:**
- Consumes: Task 2's `ProductDto`.
- Produces: `CatalogSort` = `'name_asc' | 'price_asc' | 'price_desc' | 'newest' | 'home_display' | 'collection_display'`; exported `VALID_SORTS: readonly CatalogSort[]`; `CatalogValidationError` (has `.field: string`); `listProducts(opts: { page?, pageSize?, search?, category?, sort?, status? })` returning `{ items: ProductDto[]; total: number; page: number; pageSize: number }`.

**On the two display sorts:** merchandised order is a business decision, so the
server returns products already ordered and the client never re-sorts. Two
independent orderings exist because a product's place on the home page is not
its place inside a collection. Both are ascending with **unranked products
last** and **ties broken by name** — without the tiebreak, two products sharing
a position return in arbitrary order and pagination becomes unstable.

**Why raw SQL:** ADR-0001 defines `price_asc`/`price_desc` as ordering by a product's **cheapest variant**, with variantless products last. Prisma cannot `orderBy` a related-record aggregate other than `_count`. Sorting in JavaScript after fetching would break pagination — you would sort only the current page. One raw query produces the ordered, paginated ID list; Prisma hydrates it.

- [ ] **Step 1: Write the failing test**

Create `systems/core/tests/catalog-filter-sort.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { listProducts, CatalogValidationError } from '../src/catalog/catalog.service.js'
import { resetDb } from './helpers/db.js'

async function make(
  slug: string, name: string, cats: string[], prices: number[],
  positions: { home?: number | null; collection?: number | null } = {},
) {
  return prisma.product.create({
    data: {
      slug, name, productType: 'resale', status: 'published', categories: cats,
      homePosition: positions.home ?? null,
      collectionPosition: positions.collection ?? null,
      variants: { create: prices.map((p, i) => ({ sku: `${slug}-${i}`, priceCents: p })) },
    },
  })
}

describe('catalog filtering and sorting', () => {
  beforeAll(async () => {
    await resetDb()
    // Home and collection positions are deliberately in DIFFERENT orders so the
    // tests prove the two sorts are independent rather than coincidentally equal.
    await make('alpha',   'Alpha Set',   ['architecture'],          [5000, 3000], { home: 2, collection: 30 })
    await make('bravo',   'Bravo Set',   ['fantasy'],               [1000],       { home: 1, collection: 40 })
    await make('charlie', 'Charlie Set', ['architecture', 'space'], [9000],       { home: 3, collection: 10 })
    await make('delta',   'Delta Set',   [],                        [],           { home: null, collection: 20 })
    await make('echo',    'Echo Set',    ['fantasy'],               [2000],       { home: 2, collection: null })
  })
  afterAll(async () => { await prisma.$disconnect() })

  it('filters to products containing the category', async () => {
    const r = await listProducts({ category: 'architecture' })
    expect(r.items.map(i => i.slug).sort()).toEqual(['alpha', 'charlie'])
    expect(r.total).toBe(2)
  })

  it('matches a category anywhere in the array, not just first', async () => {
    const r = await listProducts({ category: 'space' })
    expect(r.items.map(i => i.slug)).toEqual(['charlie'])
  })

  it('returns nothing for an unknown category rather than everything', async () => {
    const r = await listProducts({ category: 'nonexistent' })
    expect(r.items).toEqual([])
    expect(r.total).toBe(0)
  })

  // ADR-0001: sort by the product's CHEAPEST variant. Alpha's cheapest is 3000,
  // so it must precede Charlie at 9000 despite also having a 5000 variant.
  it('sorts ascending by cheapest variant, variantless last', async () => {
    const r = await listProducts({ sort: 'price_asc' })
    expect(r.items.map(i => i.slug)).toEqual(['bravo', 'echo', 'alpha', 'charlie', 'delta'])
  })

  it('sorts descending by cheapest variant, variantless last', async () => {
    const r = await listProducts({ sort: 'price_desc' })
    expect(r.items.map(i => i.slug)).toEqual(['charlie', 'alpha', 'echo', 'bravo', 'delta'])
  })

  it('sorts by name ascending by default', async () => {
    const r = await listProducts({})
    expect(r.items.map(i => i.slug)).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo'])
  })

  it('paginates against the full filtered set, not the page', async () => {
    const r = await listProducts({ sort: 'price_asc', page: 2, pageSize: 2 })
    expect(r.items.map(i => i.slug)).toEqual(['alpha', 'charlie'])
    expect(r.total).toBe(5)
    expect(r.page).toBe(2)
    expect(r.pageSize).toBe(2)
  })

  it('orders by home position, unranked last, ties broken by name', async () => {
    const r = await listProducts({ sort: 'home_display' })
    // bravo=1, alpha=2, echo=2 (tie -> name), charlie=3, delta=null -> last
    expect(r.items.map(i => i.slug)).toEqual(['bravo', 'alpha', 'echo', 'charlie', 'delta'])
  })

  it('orders by collection position, unranked last', async () => {
    const r = await listProducts({ sort: 'collection_display' })
    // charlie=10, delta=20, alpha=30, bravo=40, echo=null -> last
    expect(r.items.map(i => i.slug)).toEqual(['charlie', 'delta', 'alpha', 'bravo', 'echo'])
  })

  // The whole point of two columns: the same catalogue orders differently
  // depending on where it is being shown.
  it('gives home and collection genuinely different orders', async () => {
    const home = await listProducts({ sort: 'home_display' })
    const coll = await listProducts({ sort: 'collection_display' })
    expect(home.items.map(i => i.slug)).not.toEqual(coll.items.map(i => i.slug))
  })

  it('applies the collection display order within a filtered category', async () => {
    const r = await listProducts({ category: 'architecture', sort: 'collection_display' })
    // charlie=10 before alpha=30
    expect(r.items.map(i => i.slug)).toEqual(['charlie', 'alpha'])
  })

  it('paginates stably under a display sort', async () => {
    const p1 = await listProducts({ sort: 'home_display', page: 1, pageSize: 2 })
    const p2 = await listProducts({ sort: 'home_display', page: 2, pageSize: 2 })
    expect(p1.items.map(i => i.slug)).toEqual(['bravo', 'alpha'])
    expect(p2.items.map(i => i.slug)).toEqual(['echo', 'charlie'])
  })

  it('combines search with category', async () => {
    const r = await listProducts({ category: 'architecture', search: 'charlie' })
    expect(r.items.map(i => i.slug)).toEqual(['charlie'])
  })

  // A silently ignored bad parameter returns plausible wrong results, which is
  // harder to notice than an error.
  it('rejects an unknown sort instead of falling back', async () => {
    await expect(listProducts({ sort: 'cheapest' as any })).rejects.toThrow(CatalogValidationError)
  })

  it('rejects a non-positive page', async () => {
    await expect(listProducts({ page: 0 })).rejects.toThrow(CatalogValidationError)
  })

  it('rejects a pageSize above 100', async () => {
    await expect(listProducts({ pageSize: 101 })).rejects.toThrow(CatalogValidationError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/core && npx vitest run tests/catalog-filter-sort.test.ts`
Expected: FAIL — `CatalogValidationError is not exported`.

- [ ] **Step 3: Implement**

In `systems/core/src/catalog/catalog.service.ts`, add the import at the top and replace `listProducts`:

```ts
import { Prisma } from '@prisma/client'

export type CatalogSort =
  | 'name_asc' | 'price_asc' | 'price_desc' | 'newest'
  | 'home_display' | 'collection_display'

export const VALID_SORTS: readonly CatalogSort[] = [
  'name_asc', 'price_asc', 'price_desc', 'newest',
  'home_display', 'collection_display',
]

export class CatalogValidationError extends Error {
  constructor(public field: string, message: string) {
    super(message)
    this.name = 'CatalogValidationError'
  }
}

export async function listProducts(opts: {
  page?: number; pageSize?: number; search?: string
  category?: string; sort?: CatalogSort
  status?: 'published' | 'draft' | 'archived'
}) {
  const page = opts.page ?? 1
  const pageSize = opts.pageSize ?? 20
  const sort = opts.sort ?? 'name_asc'

  if (!Number.isInteger(page) || page < 1) {
    throw new CatalogValidationError('page', 'page must be an integer >= 1')
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new CatalogValidationError('pageSize', 'pageSize must be an integer between 1 and 100')
  }
  if (!VALID_SORTS.includes(sort)) {
    throw new CatalogValidationError('sort', `sort must be one of: ${VALID_SORTS.join(', ')}`)
  }

  const status = opts.status ?? 'published'

  // Built as fragments so every value stays a bound parameter.
  const conds: Prisma.Sql[] = [Prisma.sql`p.status = ${status}::"ProductStatus"`]
  if (opts.search) {
    conds.push(Prisma.sql`p.name ILIKE ${'%' + opts.search + '%'}`)
  }
  if (opts.category) {
    conds.push(Prisma.sql`p.categories @> ${JSON.stringify([opts.category])}::jsonb`)
  }
  const where = Prisma.join(conds, ' AND ')

  // MIN over the join gives the cheapest variant. NULLS LAST puts variantless
  // products at the end for both directions, per ADR-0001.
  //
  // The two display sorts read merchandised position columns. NULLS LAST keeps
  // unranked products at the end rather than the top, and every branch ends
  // with `p.name ASC` so ties are deterministic — without it, two products
  // sharing a position can swap between pages and pagination becomes unstable.
  const orderBy =
    sort === 'price_asc' ? Prisma.sql`MIN(v.price_cents) ASC NULLS LAST, p.name ASC`
    : sort === 'price_desc' ? Prisma.sql`MIN(v.price_cents) DESC NULLS LAST, p.name ASC`
    : sort === 'newest' ? Prisma.sql`p.created_at DESC, p.name ASC`
    : sort === 'home_display' ? Prisma.sql`p.home_position ASC NULLS LAST, p.name ASC`
    : sort === 'collection_display' ? Prisma.sql`p.collection_position ASC NULLS LAST, p.name ASC`
    : Prisma.sql`p.name ASC`

  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT p.id
    FROM products p
    LEFT JOIN variants v ON v.product_id = p.id
    WHERE ${where}
    GROUP BY p.id, p.name, p.created_at, p.home_position, p.collection_position
    ORDER BY ${orderBy}
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
  `)

  const countRows = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
    SELECT COUNT(*)::bigint AS count FROM products p WHERE ${where}
  `)
  const total = Number(countRows[0]?.count ?? 0n)

  const ids = rows.map(r => r.id)
  if (ids.length === 0) return { items: [], total, page, pageSize }

  // findMany does not preserve the ordered ID list, so re-order explicitly.
  const products = await prisma.product.findMany({
    where: { id: { in: ids } },
    include: { variants: true },
  })
  const byId = new Map(products.map(p => [p.id, p]))
  const items = ids.map(id => byId.get(id)).filter(Boolean).map(toDto)

  return { items, total, page, pageSize }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd systems/core && npx vitest run tests/catalog-filter-sort.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Run the full core suite for regressions**

Run: `cd systems/core && npm test`
Expected: all prior tests still pass. `listProducts` now throws on invalid input where it previously clamped, so fix any caller or test relying on clamping.

- [ ] **Step 6: Commit**

```bash
git add systems/core/src/catalog/catalog.service.ts systems/core/tests/catalog-filter-sort.test.ts
git commit -m "feat(core): category filter and frozen sort enum on the catalog list

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Structured error envelope on catalog routes

**Files:**
- Modify: `systems/core/src/catalog/catalog.routes.ts`
- Test: `systems/core/tests/catalog-routes.test.ts`

**Interfaces:**
- Consumes: Task 3's `CatalogValidationError`, `CatalogSort`.
- Produces: catalog routes returning `{ code, message, fields? }` on error, with `code` in `NOT_FOUND` | `VALIDATION_ERROR` | `INTERNAL`. Query params: `page`, `pageSize`, `search`, `category`, `sort`.

**Note:** the orders routes keep their existing `{ error }` shape. Aligning them is a separate change, deliberately out of scope.

- [ ] **Step 1: Write the failing test**

Create `systems/core/tests/catalog-routes.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'

const app = buildApp()

describe('catalog routes', () => {
  beforeAll(async () => {
    await resetDb()
    await prisma.product.create({
      data: {
        slug: 'route-fixture', name: 'Route Fixture', productType: 'resale',
        status: 'published', categories: ['space'],
        images: [{ url: '/img/r.jpg', alt: 'Route fixture' }],
        variants: { create: [{ sku: 'RF-1', priceCents: 2500 }] },
      },
    })
  })
  afterAll(async () => { await prisma.$disconnect() })

  it('passes category and sort through to the service', async () => {
    const res = await request(app).get('/api/v1/catalog/products?category=space&sort=price_asc')
    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].slug).toBe('route-fixture')
    expect(res.body.items[0].images).toEqual([{ url: '/img/r.jpg', alt: 'Route fixture' }])
    expect(res.body.pageSize).toBe(20)
  })

  it('returns VALIDATION_ERROR with the offending field for a bad sort', async () => {
    const res = await request(app).get('/api/v1/catalog/products?sort=cheapest')
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_ERROR')
    expect(typeof res.body.message).toBe('string')
    expect(res.body.fields).toHaveProperty('sort')
  })

  it('returns VALIDATION_ERROR for a non-numeric page', async () => {
    const res = await request(app).get('/api/v1/catalog/products?page=abc')
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_ERROR')
    expect(res.body.fields).toHaveProperty('page')
  })

  it('returns NOT_FOUND with the structured envelope', async () => {
    const res = await request(app).get('/api/v1/catalog/products/does-not-exist')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) })
  })

  it('returns NOT_FOUND for availability on a missing product', async () => {
    const res = await request(app).get('/api/v1/catalog/products/nope/availability')
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/core && npx vitest run tests/catalog-routes.test.ts`
Expected: FAIL — 404 body is `{ error: 'not_found' }`, and `sort=cheapest` returns 200.

If `supertest` is missing, install it: `cd systems/core && npm install -D supertest @types/supertest`

- [ ] **Step 3: Implement**

Replace `systems/core/src/catalog/catalog.routes.ts` entirely:

```ts
import { Router } from 'express'
import {
  listProducts, getProduct, getAvailability,
  CatalogValidationError, VALID_SORTS, type CatalogSort,
} from './catalog.service.js'

// Returns undefined when absent, null when present-but-invalid, so the caller
// can tell "not supplied" from "supplied as garbage" and reject the latter.
function intParam(v: unknown): number | undefined | null {
  if (v === undefined) return undefined
  if (typeof v !== 'string') return null
  const n = Number(v)
  return Number.isInteger(n) ? n : null
}

function notFound(res: any) {
  return res.status(404).json({ code: 'NOT_FOUND', message: 'Product not found.' })
}

function validationError(res: any, field: string, message: string) {
  return res.status(400).json({ code: 'VALIDATION_ERROR', message, fields: { [field]: message } })
}

export const catalogRouter = Router()

catalogRouter.get('/products', async (req, res) => {
  const page = intParam(req.query.page)
  if (page === null) return validationError(res, 'page', 'page must be an integer >= 1')
  const pageSize = intParam(req.query.pageSize)
  if (pageSize === null) return validationError(res, 'pageSize', 'pageSize must be an integer between 1 and 100')

  const rawSort = req.query.sort
  if (rawSort !== undefined && (typeof rawSort !== 'string' || !VALID_SORTS.includes(rawSort as CatalogSort))) {
    return validationError(res, 'sort', `sort must be one of: ${VALID_SORTS.join(', ')}`)
  }

  try {
    const result = await listProducts({
      page, pageSize,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      category: typeof req.query.category === 'string' ? req.query.category : undefined,
      sort: rawSort as CatalogSort | undefined,
    })
    res.json(result)
  } catch (err) {
    if (err instanceof CatalogValidationError) {
      return validationError(res, err.field, err.message)
    }
    throw err
  }
})

catalogRouter.get('/products/:idOrSlug', async (req, res) => {
  const p = await getProduct(req.params.idOrSlug)
  if (!p) return notFound(res)
  res.json(p)
})

catalogRouter.get('/products/:idOrSlug/availability', async (req, res) => {
  const a = await getAvailability(req.params.idOrSlug)
  if (!a) return notFound(res)
  res.json(a)
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd systems/core && npx vitest run tests/catalog-routes.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add systems/core/src/catalog systems/core/tests/catalog-routes.test.ts systems/core/package.json
git commit -m "feat(core): structured error envelope and new query params on catalog routes

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Seed data, contract, and ADR amendment

**Files:**
- Modify: `systems/core/prisma/seed.ts`
- Modify: `contracts/openapi/catalog.yaml`
- Modify: `docs/adr/0001-catalog-api-contract.md`
- Test: `systems/core/tests/seed.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: seeded catalog of 8 published products covering categories `architecture`, `fantasy`, `space`, `ocean`, `nature`, with at least one `releaseType: limited_run`, each with 1+ variants and 1+ images.

- [ ] **Step 1: Write the failing test**

Replace the body of `systems/core/tests/seed.test.ts` with:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { seed } from '../prisma/seed.js'
import { resetDb } from './helpers/db.js'

const REQUIRED_CATEGORIES = ['architecture', 'fantasy', 'space', 'ocean', 'nature']

describe('seed', () => {
  beforeAll(async () => { await resetDb(); await seed() })
  afterAll(async () => { await prisma.$disconnect() })

  it('seeds at least 8 published products', async () => {
    const n = await prisma.product.count({ where: { status: 'published' } })
    expect(n).toBeGreaterThanOrEqual(8)
  })

  it('covers every category collection', async () => {
    const all = await prisma.product.findMany()
    const seen = new Set(all.flatMap(p => p.categories as string[]))
    for (const c of REQUIRED_CATEGORIES) expect(seen).toContain(c)
  })

  it('uses lowercase kebab-case category slugs only', async () => {
    const all = await prisma.product.findMany()
    for (const c of all.flatMap(p => p.categories as string[])) {
      expect(c).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    }
  })

  it('includes a limited run so the Limited badge has a source', async () => {
    const n = await prisma.product.count({ where: { releaseType: 'limited_run' } })
    expect(n).toBeGreaterThanOrEqual(1)
  })

  it('gives every product at least one variant and one image with alt text', async () => {
    const all = await prisma.product.findMany({ include: { variants: true } })
    for (const p of all) {
      expect(p.variants.length).toBeGreaterThanOrEqual(1)
      const imgs = p.images as { url: string; alt: string }[]
      expect(imgs.length).toBeGreaterThanOrEqual(1)
      for (const i of imgs) {
        expect(typeof i.url).toBe('string')
        expect(i.alt.length).toBeGreaterThan(0)
      }
    }
  })

  it('assigns every product both display positions', async () => {
    const all = await prisma.product.findMany()
    for (const p of all) {
      expect(p.homePosition).not.toBeNull()
      expect(p.collectionPosition).not.toBeNull()
    }
  })

  it('makes home positions unique so the order is unambiguous', async () => {
    const all = await prisma.product.findMany()
    const positions = all.map(p => p.homePosition)
    expect(new Set(positions).size).toBe(positions.length)
  })

  // Two columns are pointless if the seed sets them identically — the fixture
  // must be able to demonstrate that the orderings differ.
  it('does not order the home page and collections identically', async () => {
    const all = await prisma.product.findMany()
    const byHome = [...all].sort((a, b) => a.homePosition! - b.homePosition!).map(p => p.slug)
    const byColl = [...all].sort((a, b) => a.collectionPosition! - b.collectionPosition!).map(p => p.slug)
    expect(byHome).not.toEqual(byColl)
  })

  it('is idempotent', async () => {
    const before = await prisma.product.count()
    await seed()
    expect(await prisma.product.count()).toBe(before)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/core && npx vitest run tests/seed.test.ts`
Expected: FAIL — only 2 products seeded.

- [ ] **Step 3: Expand the seed**

Rewrite `systems/core/prisma/seed.ts`. Write 8 entries following this shape — the first is given in full; author the remaining 7 covering `fantasy`, `space`, `ocean`, `nature`, and a second `architecture`, varying `difficulty` and `pieces`.

Three constraints the seed tests enforce:

- **At least one product has `releaseType: 'limited_run'`**, so the `Limited` badge has a real source. Give those products the additional category `'limited-edition'` — the `limited-edition` collection resolves through a category, not a `releaseType` filter, which core does not have.
- **`homePosition` is unique across all 8** — `1` through `8`.
- **`collectionPosition` is a genuinely different sequence**, not a copy of `homePosition`. Assigning the two in the same order makes the second column dead weight and the test asserting they differ will fail.

```ts
import { prisma } from '../src/prisma.js'

// Development fixture data. This is NOT the real catalog and must never be
// presented as such. Images are neutral placeholders — see spec section 8.2.
const PRODUCTS = [
  {
    slug: 'millennium-city-skyline',
    name: 'Millennium City Skyline',
    productType: 'own_designed' as const,
    releaseType: 'standard' as const,
    status: 'published' as const,
    categories: ['architecture'],
    images: [
      { url: '/img/placeholder/skyline-1.svg', alt: 'Placeholder image for Millennium City Skyline' },
      { url: '/img/placeholder/skyline-2.svg', alt: 'Placeholder alternate view of Millennium City Skyline' },
    ],
    description: 'A sprawling metropolis skyline with towers, bridges and hidden details.',
    longDescription: 'A large architectural build capturing a modern city in brick detail, from street-level shopfronts to rooftop gardens.',
    pieces: 2847,
    difficulty: 'expert' as const,
    ageRecommendation: '16+',
    dimensions: '68 x 32 x 48 cm (assembled)',
    features: [
      'Detailed street-level shopfronts with opening doors',
      'Poseable suspension bridge',
      'Modular base design',
    ],
    includes: ['Display nameplate', 'Illustrated builder guide', 'City district map print'],
    builderNotes: 'The bridge suspension took several prototypes before the tension held without non-standard parts.',
    // Merchandised order. homePosition and collectionPosition are deliberately
    // NOT the same sequence — see the seed test that asserts they differ.
    homePosition: 1,
    collectionPosition: 4,
    variants: [{ sku: 'ABE-1001', priceCents: 18900, onHand: 12 }],
  },
  // ... 7 more, same shape
]

export async function seed(): Promise<void> {
  await prisma.actor.upsert({
    where: { id: 'system' }, update: {},
    create: { id: 'system', type: 'human', name: 'system' },
  })
  for (const p of PRODUCTS) {
    const { variants, ...fields } = p
    await prisma.product.upsert({
      where: { slug: p.slug },
      update: {},
      create: {
        ...fields,
        variants: {
          create: variants.map(v => ({
            sku: v.sku, priceCents: v.priceCents,
            inventory: { create: { onHand: v.onHand } },
          })),
        },
      },
    })
  }
}

if (process.argv[1]?.endsWith('seed.ts')) {
  seed().then(() => prisma.$disconnect())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd systems/core && npx vitest run tests/seed.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Rewrite the contract to describe core as built**

In `contracts/openapi/catalog.yaml`, change:
- `limit` parameter → `pageSize`, default `20`, max `100`.
- `ProductListEnvelope` required `[items, total, page, pageSize]`; drop `limit`.
- All `Product` and `ProductVariant` field names to camelCase: `productType`, `releaseType`, `longDescription`, `ageRecommendation`, `builderNotes`, `createdAt`, `updatedAt`, `priceCents`.
- `ProductVariant.price` (float) → `priceCents`, `type: integer`, described as an integer count of cents.
- Add `Product` fields: `pieces` (integer, nullable), `difficulty` (enum beginner/intermediate/advanced/expert, nullable), `ageRecommendation`, `dimensions`, `longDescription`, `features` (array of string), `includes` (array of string), `builderNotes`, `homePosition` (integer, nullable), `collectionPosition` (integer, nullable).
- Widen the `sort` enum to six values: `[name_asc, price_asc, price_desc, newest, home_display, collection_display]`, default `name_asc`. Document that the two `*_display` values order by the corresponding position column ascending, place unranked products last, and break ties by name.
- Remove `published` from both the parameter list and the `Product` schema; core exposes `status` instead.
- `ProductAvailability` → array of `{ variantId, sku, available }`.
- Update `info.description` to state that the surface follows `systems/core` per the ADR-0001 amendment of 2026-08-12.

- [ ] **Step 6: Amend ADR-0001**

Append to `docs/adr/0001-catalog-api-contract.md`:

```markdown
---

## Amendment — 2026-08-12: core becomes the source of truth

**Status:** ACCEPTED — ruled by Jack, 2026-08-12.

The v1 surface frozen above was never implemented as written. `systems/core`
shipped a different API: `pageSize` rather than `limit`, camelCase rather than
snake_case, integer cents rather than float dollars, and no `category`, `sort`
or `published` parameters. The storefront's `catalogService.js` was written
faithfully to this document, which is exactly why it did not work against core.

**Resolution: core wins on shape; this contract wins on features.**

Core keeps camelCase, `pageSize`, and integer cents. Core gains the `category`
filter, the `sort` enum, `images` as `{url, alt}`, and the
`{code, message, fields?}` error envelope. `contracts/openapi/catalog.yaml` is
rewritten to describe core as built.

**The sort enum widens from four values to six.** `home_display` and
`collection_display` are added for merchandised display order (see below). The
four original values keep their exact semantics, so this is additive.

### Merchandised display order

Two nullable integer columns, `homePosition` and `collectionPosition`, carry the
order in which products should be shown. The server returns products already
ordered; **the storefront never re-sorts what it receives**, because a client
that re-sorts disagrees with the server as soon as pagination is involved.

There are two orderings because a product's place on the home page is not its
place inside a collection. Both sort ascending, place unranked products **last**
(`NULLS LAST`), and break ties on `name` so pagination is stable.

Nullable rather than defaulted to `0`: a new product is unmerchandised, and a
`0` default would silently promote it to the top of the home page.

**Accepted limitation.** `categories` is an array, so a product in several
collections carries one `collectionPosition` and holds the same rank in each.
Per-collection ranking would need a `(productId, collectionSlug, position)` join
table. Not built — nothing needs it yet.

**Why not the reverse.** Core is running, tested and merged. This contract's
only consumer was a storefront replaced in the same change, so conforming core
to the document would have churned tested code to satisfy a specification with
no other reader.

**Integer cents is not revisitable.** This document typed price as
`number, format: float`. Floating-point dollars accumulate representation error
and the repository's money convention forbids estimated figures. Every price in
this system is an integer count of cents.

**Still carved out and still undecided:** the image CDN (ADR-0002, DRAFT) and
relevance search (ADR-0003, DRAFT). `{url, alt}` remains forward-compatible with
adding `width`, `height` and `srcset` variants.
```

- [ ] **Step 7: Verify the whole of core, then build and boot it**

Run: `cd systems/core && npm test`
Expected: all tests pass.

Run: `cd systems/core && npx tsc --noEmit && npm run build`
Expected: clean.

Run: `cd systems/core && node dist/server.js` then in another shell
`curl "http://localhost:4000/api/v1/catalog/products?sort=price_asc&pageSize=3"`
Expected: JSON with `items`, `total`, `page`, `pageSize`, and `images` populated. **A green suite does not prove this** — it is a separate check.

- [ ] **Step 8: Commit**

```bash
git add systems/core/prisma/seed.ts systems/core/tests/seed.test.ts contracts/openapi/catalog.yaml docs/adr/0001-catalog-api-contract.md
git commit -m "feat(core): expand catalog seed; align contract and ADR-0001 with core

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

# Phase 2 — Storefront foundation

## Task 6: Scaffold the TypeScript app and design tokens

**Files:**
- Delete: `systems/storefront/code/src/App.jsx`, `App.test.jsx`, `main.jsx`, `components/ProductCard.jsx`, `components/ProductList.jsx`, `components/SearchBar.jsx`, `services/catalogService.js`, `src/index.js`, `src/server.js`, `src/public/index.html`, `src/styles/index.css`, `tailwind.config.js`, `postcss.config.js`
- Create: `systems/storefront/code/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/design-system/tokens.css`, `src/styles/globals.css`, `vitest.config.ts`, `src/test/setup.ts`
- Test: `systems/storefront/code/src/design-system/tokens.test.ts`

**Interfaces:**
- Produces: a Vite + React 18 + TS + Tailwind v4 app; `globals.css` importing `tokens.css` and mapping tokens to Tailwind's semantic scale so `bg-background`, `text-foreground`, `border-border` resolve.

- [ ] **Step 1: Remove the Sprint-1 app**

The Express proxy and JSX components target `catalog-service:4001`, an in-memory mock. Git history preserves them.

```bash
cd systems/storefront/code
git rm src/App.jsx src/App.test.jsx src/main.jsx src/index.js src/server.js \
       src/components/ProductCard.jsx src/components/ProductList.jsx src/components/SearchBar.jsx \
       src/services/catalogService.js src/public/index.html src/styles/index.css \
       tailwind.config.js postcss.config.js
```

- [ ] **Step 2: Write package.json, tsconfig.json, vite.config.ts**

`package.json`:

```json
{
  "name": "alpinebrick-storefront",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router": "^7.1.1",
    "lucide-react": "^0.469.0",
    "@fontsource/barlow-condensed": "^5.1.0",
    "@fontsource/dm-sans": "^5.1.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.18",
    "@types/react-dom": "^18.3.5",
    "@vitejs/plugin-react": "^4.3.4",
    "@tailwindcss/vite": "^4.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "~5.7.2",
    "vite": "^6.0.7",
    "vitest": "^2.1.8",
    "jsdom": "^25.0.1",
    "@testing-library/react": "^16.1.0",
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/user-event": "^14.5.2"
  }
}
```

`vite.config.ts` — the proxy sends API calls to core in development:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // core listens on 4000 (src/server.ts: PORT ?? 4000), NOT 3000.
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
  },
})
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test/setup.ts'] },
})
```

`src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest'
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["vitest/globals"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write the token files**

`src/design-system/tokens.css` — copy the token block from the handoff's `theme-tokens.css` verbatim (the `:root, .dark` block with all `--background`, `--foreground`, `--card`, `--primary`, `--muted-foreground`, `--border`, `--ring`, `--radius`, and difficulty-scale values).

`src/styles/globals.css`:

```css
@import "tailwindcss";
@import "@fontsource/barlow-condensed/900.css";
@import "@fontsource/dm-sans/400.css";
@import "@fontsource/dm-sans/500.css";
@import "@fontsource/dm-sans/600.css";
@import "../design-system/tokens.css";

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-ring: var(--ring);
  --radius-md: var(--radius);
  --font-display: var(--font-display);
  --font-sans: var(--font-sans);
}

body {
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
}
```

`src/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { router } from './routes'
import './styles/globals.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode><RouterProvider router={router} /></StrictMode>,
)
```

`index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Alpine Brick Exchange</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Create the placeholder product images**

Task 5's seed points at `/img/placeholder/*.svg`. Those files are served from
the storefront's `public/` directory and must exist, or every product card
renders a broken image.

Create `public/img/placeholder/` containing one SVG per seeded image. Each is a
flat `#242424` field (the `--muted` token) with a centred `#8a8a8a` label naming
the set — **visibly a placeholder, never photographic**. Real product
photography is the largest open gap in this build and nothing should be mistaken
for it.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 720" width="900" height="720" role="img">
  <rect width="900" height="720" fill="#242424"/>
  <text x="450" y="360" fill="#8a8a8a" font-family="sans-serif" font-size="28"
        letter-spacing="4" text-anchor="middle" dominant-baseline="middle">
    PLACEHOLDER — SKYLINE
  </text>
</svg>
```

The `alt` text lives in the seed data, not here, so these carry `role="img"`
without a `<title>`.

- [ ] **Step 5: Write the token guard test**

Create `src/design-system/tokens.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const tokens = readFileSync(join(__dirname, 'tokens.css'), 'utf8')

describe('design tokens', () => {
  it('defines the identity-carrying values exactly', () => {
    expect(tokens).toContain('--background: #0f0f0f')
    expect(tokens).toContain('--foreground: #f0ede8')
    expect(tokens).toContain('--card: #181818')
    expect(tokens).toContain('--primary: #ffd100')
    expect(tokens).toContain('--muted-foreground: #8a8a8a')
    expect(tokens).toContain('--radius: 0.125rem')
  })

  // Pure white is reserved for the accent state. If --foreground ever becomes
  // #ffffff the whole palette reads wrong.
  it('never sets foreground to pure white', () => {
    expect(tokens).not.toMatch(/--foreground:\s*#fff/i)
  })

  it('keeps a focus ring token for keyboard accessibility', () => {
    expect(tokens).toMatch(/--ring:/)
  })
})
```

- [ ] **Step 6: Install and run**

Run: `cd systems/storefront/code && npm install && npx vitest run`
Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add systems/storefront/code
git commit -m "feat(storefront): replace Sprint-1 JSX app with TypeScript scaffold and design tokens

The removed app targeted catalog-service:4001, an in-memory mock, and could
not work against systems/core. History preserves it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: API client

**Files:**
- Create: `src/lib/api/types.ts`, `src/lib/api/client.ts`, `src/lib/api/catalog.ts`
- Test: `src/lib/api/client.test.ts`, `src/lib/api/catalog.test.ts`

**Interfaces:**
- Consumes: Phase 1's API.
- Produces: `ApiError` (fields `code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'INTERNAL'`, `message: string`, `fields?: Record<string, string>`); `Product`, `ProductImage`, `Variant`, `ProductListPage` types; `getProducts(opts): Promise<ProductListPage>`, `getProduct(idOrSlug): Promise<Product>`, `getAvailability(idOrSlug): Promise<Availability[]>`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/api/client.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { apiFetch, ApiError } from './client'

function mockResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body } as Response
}

afterEach(() => { vi.unstubAllGlobals() })

describe('apiFetch', () => {
  it('returns the parsed body on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse(200, { items: [] })))
    await expect(apiFetch('/api/v1/catalog/products')).resolves.toEqual({ items: [] })
  })

  it('throws ApiError carrying the server code and fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      mockResponse(400, { code: 'VALIDATION_ERROR', message: 'bad sort', fields: { sort: 'bad sort' } })))
    await expect(apiFetch('/x')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR', message: 'bad sort', fields: { sort: 'bad sort' },
    })
  })

  // A network failure has no envelope. Synthesising INTERNAL keeps every
  // failure branchable on `.code` so the UI never sees an untyped error.
  it('synthesises INTERNAL when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const err = await apiFetch('/x').catch(e => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe('INTERNAL')
  })

  it('synthesises INTERNAL when an error body is not valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 500, json: async () => { throw new Error('not json') },
    } as unknown as Response)))
    const err = await apiFetch('/x').catch(e => e)
    expect(err.code).toBe('INTERNAL')
  })
})
```

Create `src/lib/api/catalog.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { getProducts } from './catalog'

afterEach(() => { vi.unstubAllGlobals() })

function capture(body: unknown) {
  const spy = vi.fn(async () => ({ ok: true, status: 200, json: async () => body } as Response))
  vi.stubGlobal('fetch', spy)
  return spy
}

describe('getProducts', () => {
  it('sends only the parameters that were supplied', async () => {
    const spy = capture({ items: [], total: 0, page: 1, pageSize: 20 })
    await getProducts({ category: 'space', sort: 'price_asc' })
    const url = String(spy.mock.calls[0][0])
    expect(url).toContain('category=space')
    expect(url).toContain('sort=price_asc')
    expect(url).not.toContain('search=')
  })

  it('derives totalPages from the envelope', async () => {
    capture({ items: [], total: 45, page: 1, pageSize: 20 })
    const r = await getProducts({})
    expect(r.totalPages).toBe(3)
  })

  it('reports zero pages when pageSize is zero rather than dividing by it', async () => {
    capture({ items: [], total: 0, page: 1, pageSize: 0 })
    expect((await getProducts({})).totalPages).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd systems/storefront/code && npx vitest run src/lib/api`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/lib/api/types.ts`:

```ts
export interface ProductImage { url: string; alt: string }

export interface Variant {
  id: string; sku: string; priceCents: number; currency: string
}

export type Difficulty = 'beginner' | 'intermediate' | 'advanced' | 'expert'

export interface Product {
  id: string; slug: string; name: string; description: string
  productType: 'own_designed' | 'resale'
  releaseType: 'standard' | 'limited_run' | 'specialty'
  status: string
  images: ProductImage[]
  categories: string[]
  pieces: number | null
  difficulty: Difficulty | null
  ageRecommendation: string | null
  dimensions: string | null
  longDescription: string
  features: string[]
  includes: string[]
  builderNotes: string
  homePosition: number | null
  collectionPosition: number | null
  createdAt: string
  variants: Variant[]
}

export interface ProductListPage {
  items: Product[]; total: number; page: number; pageSize: number; totalPages: number
}

export interface Availability { variantId: string; sku: string; available: number }
```

`src/lib/api/client.ts`:

```ts
export type ApiErrorCode = 'NOT_FOUND' | 'VALIDATION_ERROR' | 'INTERNAL'

export class ApiError extends Error {
  constructor(
    public code: ApiErrorCode,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

const GENERIC = 'Something went wrong. Please try again.'

// Every failure leaves here as an ApiError with a usable `code`, including
// network and parse failures which carry no server envelope of their own.
export async function apiFetch<T>(url: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } })
  } catch {
    throw new ApiError('INTERNAL', GENERIC)
  }

  if (!res.ok) {
    try {
      const body = await res.json()
      throw new ApiError(body?.code ?? 'INTERNAL', body?.message ?? GENERIC, body?.fields)
    } catch (e) {
      if (e instanceof ApiError) throw e
      throw new ApiError('INTERNAL', GENERIC)
    }
  }

  try {
    return (await res.json()) as T
  } catch {
    throw new ApiError('INTERNAL', GENERIC)
  }
}
```

`src/lib/api/catalog.ts`:

```ts
import { apiFetch } from './client'
import type { Availability, Product, ProductListPage } from './types'

const BASE = '/api/v1/catalog'

// Mirrors core's enum exactly. The two *_display values return products in
// merchandised order — the UI renders the array as received and never re-sorts.
export type CatalogSort =
  | 'name_asc' | 'price_asc' | 'price_desc' | 'newest'
  | 'home_display' | 'collection_display'

export interface GetProductsOptions {
  page?: number; pageSize?: number; search?: string
  category?: string; sort?: CatalogSort
}

export async function getProducts(opts: GetProductsOptions): Promise<ProductListPage> {
  const params = new URLSearchParams()
  if (opts.page) params.set('page', String(opts.page))
  if (opts.pageSize) params.set('pageSize', String(opts.pageSize))
  if (opts.search) params.set('search', opts.search)
  if (opts.category) params.set('category', opts.category)
  if (opts.sort) params.set('sort', opts.sort)

  const qs = params.toString()
  const body = await apiFetch<Omit<ProductListPage, 'totalPages'>>(
    `${BASE}/products${qs ? `?${qs}` : ''}`,
  )
  return {
    ...body,
    totalPages: body.pageSize > 0 ? Math.ceil(body.total / body.pageSize) : 0,
  }
}

export function getProduct(idOrSlug: string): Promise<Product> {
  return apiFetch<Product>(`${BASE}/products/${encodeURIComponent(idOrSlug)}`)
}

export function getAvailability(idOrSlug: string): Promise<Availability[]> {
  return apiFetch<Availability[]>(`${BASE}/products/${encodeURIComponent(idOrSlug)}/availability`)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd systems/storefront/code && npx vitest run src/lib/api`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add systems/storefront/code/src/lib/api
git commit -m "feat(storefront): typed core API client with normalised errors

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: Money formatting, badge derivation, and the collection registry

**Files:**
- Create: `src/lib/money.ts`, `src/lib/badge.ts`, `src/lib/collections.ts`
- Test: `src/lib/money.test.ts`, `src/lib/badge.test.ts`, `src/lib/collections.test.ts`

**Interfaces:**
- Consumes: Task 7's `Product`.
- Produces: `formatCents(cents: number): string`; `minPriceCents(p: Product): number | null`; `deriveBadge(p: Product, now?: Date): 'Limited' | 'New' | null`; `COLLECTIONS: Collection[]` and `findCollection(slug: string): Collection | undefined`, where `Collection = { slug, title, blurb, query: GetProductsOptions }`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/money.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { formatCents, minPriceCents } from './money'
import type { Product } from './api/types'

const base = { variants: [] } as unknown as Product

describe('formatCents', () => {
  it('formats whole dollars', () => { expect(formatCents(18900)).toBe('$189.00') })
  it('keeps both decimal places', () => { expect(formatCents(9)).toBe('$0.09') })
  it('groups thousands', () => { expect(formatCents(123456)).toBe('$1,234.56') })
  it('formats zero', () => { expect(formatCents(0)).toBe('$0.00') })
})

describe('minPriceCents', () => {
  it('returns the cheapest variant price', () => {
    const p = { ...base, variants: [
      { id: '1', sku: 'a', priceCents: 5000, currency: 'USD' },
      { id: '2', sku: 'b', priceCents: 3000, currency: 'USD' },
    ] } as Product
    expect(minPriceCents(p)).toBe(3000)
  })

  it('returns null when there are no variants', () => {
    expect(minPriceCents(base)).toBeNull()
  })
})
```

Create `src/lib/badge.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { deriveBadge } from './badge'
import type { Product } from './api/types'

function make(releaseType: string, createdAt: string) {
  return { releaseType, createdAt } as unknown as Product
}
const NOW = new Date('2026-08-12T00:00:00Z')

describe('deriveBadge', () => {
  it('labels a limited run', () => {
    expect(deriveBadge(make('limited_run', '2020-01-01T00:00:00Z'), NOW)).toBe('Limited')
  })

  it('labels a recent standard product New', () => {
    expect(deriveBadge(make('standard', '2026-08-01T00:00:00Z'), NOW)).toBe('New')
  })

  it('returns null for an older standard product', () => {
    expect(deriveBadge(make('standard', '2025-01-01T00:00:00Z'), NOW)).toBeNull()
  })

  // Limited outranks New so a product cannot claim two badges at once.
  it('prefers Limited over New when both apply', () => {
    expect(deriveBadge(make('limited_run', '2026-08-11T00:00:00Z'), NOW)).toBe('Limited')
  })
})
```

Create `src/lib/collections.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { COLLECTIONS, findCollection } from './collections'

describe('collection registry', () => {
  it('defines all seven collections', () => {
    expect(COLLECTIONS.map(c => c.slug).sort()).toEqual([
      'architecture', 'fantasy', 'limited-edition', 'nature',
      'new-arrivals', 'ocean', 'space',
    ])
  })

  it('maps a category collection to a category query in collection display order', () => {
    expect(findCollection('architecture')?.query)
      .toEqual({ category: 'architecture', sort: 'collection_display' })
  })

  it('maps limited-edition through a category, not a releaseType filter', () => {
    expect(findCollection('limited-edition')?.query)
      .toEqual({ category: 'limited-edition', sort: 'collection_display' })
  })

  // "Recently added" is intrinsically chronological — hand-merchandising it
  // would mean re-ranking on every new product.
  it('maps new-arrivals to the newest sort, not a display order', () => {
    expect(findCollection('new-arrivals')?.query).toEqual({ sort: 'newest' })
  })

  it('never uses home_display for a collection', () => {
    for (const c of COLLECTIONS) expect(c.query.sort).not.toBe('home_display')
  })

  // An unknown slug must 404 rather than render an empty grid, which would tell
  // a customer the collection exists but is empty.
  it('returns undefined for an unknown slug', () => {
    expect(findCollection('nope')).toBeUndefined()
  })

  it('gives every collection a title and blurb', () => {
    for (const c of COLLECTIONS) {
      expect(c.title.length).toBeGreaterThan(0)
      expect(c.blurb.length).toBeGreaterThan(0)
    }
  })

  it('uses lowercase kebab-case slugs', () => {
    for (const c of COLLECTIONS) expect(c.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd systems/storefront/code && npx vitest run src/lib`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/lib/money.ts`:

```ts
import type { Product } from './api/types'

const FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD',
  minimumFractionDigits: 2, maximumFractionDigits: 2,
})

// Cents in, display string out. This is the only place cents become dollars.
export function formatCents(cents: number): string {
  return FORMATTER.format(cents / 100)
}

export function minPriceCents(p: Product): number | null {
  if (!p.variants || p.variants.length === 0) return null
  return Math.min(...p.variants.map(v => v.priceCents))
}
```

`src/lib/badge.ts`:

```ts
import type { Product } from './api/types'

export type Badge = 'Limited' | 'New'

const NEW_WINDOW_DAYS = 30

// Derived, never stored: a stored badge duplicates releaseType and createdAt
// and drifts from them. Limited outranks New so only one badge ever shows.
export function deriveBadge(p: Product, now: Date = new Date()): Badge | null {
  if (p.releaseType === 'limited_run') return 'Limited'
  const created = new Date(p.createdAt).getTime()
  if (Number.isNaN(created)) return null
  const ageDays = (now.getTime() - created) / 86_400_000
  return ageDays <= NEW_WINDOW_DAYS ? 'New' : null
}
```

`src/lib/collections.ts`:

```ts
import type { GetProductsOptions } from './api/catalog'

export interface Collection {
  slug: string
  title: string
  blurb: string
  query: GetProductsOptions
}

// Collections are saved queries, not a database table.
//
// Every curated collection sorts by collection_display so merchandised order is
// server-side. new-arrivals is the one exception: "recently added" is
// intrinsically chronological, and hand-ranking it would mean re-merchandising
// on every new product.
export const COLLECTIONS: Collection[] = [
  { slug: 'architecture', title: 'Architecture', blurb: 'Skylines, landmarks and structures built brick by brick.', query: { category: 'architecture', sort: 'collection_display' } },
  { slug: 'fantasy', title: 'Fantasy', blurb: 'Castles, dragons and the worlds that hold them.', query: { category: 'fantasy', sort: 'collection_display' } },
  { slug: 'space', title: 'Space', blurb: 'Orbiters, landers and deep-space exploration builds.', query: { category: 'space', sort: 'collection_display' } },
  { slug: 'ocean', title: 'Ocean', blurb: 'Submersibles, reefs and everything beneath the surface.', query: { category: 'ocean', sort: 'collection_display' } },
  { slug: 'nature', title: 'Nature', blurb: 'Botanicals, landscapes and wildlife in brick form.', query: { category: 'nature', sort: 'collection_display' } },
  { slug: 'limited-edition', title: 'Limited Edition', blurb: 'Short runs. Once they are gone, they are gone.', query: { category: 'limited-edition', sort: 'collection_display' } },
  { slug: 'new-arrivals', title: 'New Arrivals', blurb: 'The most recent additions to the catalogue.', query: { sort: 'newest' } },
]

export function findCollection(slug: string): Collection | undefined {
  return COLLECTIONS.find(c => c.slug === slug)
}
```

**Why `limited-edition` goes through a category:** core has no `releaseType` filter parameter, and adding one would duplicate a distinction the category already expresses. Task 5's seed gives every `limited_run` product the additional category `'limited-edition'`. If that seeding step was skipped, this collection returns empty — check the seed before debugging the registry.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd systems/storefront/code && npx vitest run src/lib`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add systems/storefront/code/src/lib
git commit -m "feat(storefront): money formatting, badge derivation and collection registry

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: Design-system primitives

**Files:**
- Create: `src/design-system/primitives/Button.tsx`, `Eyebrow.tsx`, `Badge.tsx`, `Card.tsx`, `Input.tsx`, `Accordion.tsx`, `Tabs.tsx`, `index.ts`
- Test: `src/design-system/primitives/primitives.test.tsx`

**Interfaces:**
- Produces: `Button({ variant?: 'primary' | 'secondary', ...ButtonHTMLAttributes })`; `Eyebrow({ children, as? })`; `Badge({ children, tone?: 'primary' | 'accent' })`; `Card({ children, className? })`; `Input({ label: string, id: string, error?: string, ...InputHTMLAttributes })`; `Accordion({ items: { id, question, answer }[] })`; `Tabs({ tabs: { id, label, content }[] })`.

- [ ] **Step 1: Write the failing test**

Create `src/design-system/primitives/primitives.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button, Eyebrow, Input, Accordion, Tabs } from './index'

describe('Button', () => {
  it('renders a real button element', () => {
    render(<Button>Add to cart</Button>)
    expect(screen.getByRole('button', { name: 'Add to cart' })).toBeInTheDocument()
  })

  it('carries a visible focus ring class for keyboard users', () => {
    render(<Button>Go</Button>)
    expect(screen.getByRole('button').className).toMatch(/focus-visible:ring/)
  })
})

describe('Eyebrow', () => {
  // The single most identity-defining rule in the design system.
  it('is uppercase and letter-spaced', () => {
    render(<Eyebrow>Architecture</Eyebrow>)
    const el = screen.getByText('Architecture')
    expect(el.className).toMatch(/uppercase/)
    expect(el.className).toMatch(/tracking-/)
  })

  // muted-foreground is ~5.5:1 and fails below 12px.
  it('never renders below 12px', () => {
    render(<Eyebrow>Space</Eyebrow>)
    expect(screen.getByText('Space').className).not.toMatch(/text-\[(\d|10|11)px\]/)
  })
})

describe('Input', () => {
  it('binds its label to the control', () => {
    render(<Input id="email" label="Email address" />)
    expect(screen.getByLabelText('Email address')).toBeInTheDocument()
  })

  it('announces an error and links it to the input', () => {
    render(<Input id="email" label="Email address" error="Enter a valid email" />)
    const input = screen.getByLabelText('Email address')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Enter a valid email')).toBeInTheDocument()
    expect(input.getAttribute('aria-describedby')).toContain('email-error')
  })
})

describe('Accordion', () => {
  const items = [
    { id: 'a', question: 'How long is shipping?', answer: 'Two to five days.' },
    { id: 'b', question: 'Do you ship abroad?', answer: 'Not yet.' },
  ]

  it('exposes each item as an expandable button', () => {
    render(<Accordion items={items} />)
    expect(screen.getByRole('button', { name: 'How long is shipping?' }))
      .toHaveAttribute('aria-expanded', 'false')
  })

  it('expands on click and reveals the answer', async () => {
    render(<Accordion items={items} />)
    await userEvent.click(screen.getByRole('button', { name: 'How long is shipping?' }))
    expect(screen.getByRole('button', { name: 'How long is shipping?' }))
      .toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Two to five days.')).toBeVisible()
  })
})

describe('Tabs', () => {
  const tabs = [
    { id: 'desc', label: 'Description', content: <p>Long description</p> },
    { id: 'spec', label: 'Specifications', content: <p>Spec sheet</p> },
  ]

  it('uses tab roles with correct selected state', () => {
    render(<Tabs tabs={tabs} />)
    expect(screen.getByRole('tab', { name: 'Description' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Specifications' })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Long description')
  })

  it('switches panel on click', async () => {
    render(<Tabs tabs={tabs} />)
    await userEvent.click(screen.getByRole('tab', { name: 'Specifications' }))
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Spec sheet')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/storefront/code && npx vitest run src/design-system/primitives`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the primitives**

`src/design-system/primitives/Button.tsx`:

```tsx
import type { ButtonHTMLAttributes } from 'react'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary'
}

// radius-md is 2px per the tokens. Buttons and inputs are the only rounded
// surfaces in the system, and nothing carries a shadow.
export function Button({ variant = 'primary', className = '', ...rest }: Props) {
  const base =
    'inline-flex items-center justify-center px-6 py-3 text-xs font-semibold uppercase ' +
    'tracking-[0.16em] rounded-md transition-colors outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
    'focus-visible:ring-offset-background disabled:opacity-50 disabled:cursor-not-allowed'
  const tone =
    variant === 'primary'
      ? 'bg-primary text-primary-foreground hover:bg-primary/90'
      : 'bg-secondary text-secondary-foreground border border-border hover:bg-muted'
  return <button className={`${base} ${tone} ${className}`} {...rest} />
}
```

`src/design-system/primitives/Eyebrow.tsx`:

```tsx
import type { ReactNode } from 'react'

// Uppercase micro-labels are ALWAYS letter-spaced — the single most
// identity-defining rule. text-xs is 12px, the floor for muted-foreground.
export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground ${className}`}>
      {children}
    </span>
  )
}
```

`src/design-system/primitives/Badge.tsx`:

```tsx
import type { ReactNode } from 'react'

// Square by design — badges never get a radius.
export function Badge({ children, tone = 'primary' }: { children: ReactNode; tone?: 'primary' | 'accent' }) {
  const cls = tone === 'primary'
    ? 'bg-primary text-primary-foreground'
    : 'bg-accent text-accent-foreground'
  return (
    <span className={`inline-block px-2.5 py-1 text-xs font-bold uppercase tracking-[0.14em] ${cls}`}>
      {children}
    </span>
  )
}
```

`src/design-system/primitives/Card.tsx`:

```tsx
import type { ReactNode } from 'react'

// Depth comes from the #181818 surface against #0f0f0f with a hairline border.
// No shadows anywhere in this system.
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`bg-card border border-border ${className}`}>{children}</div>
}
```

`src/design-system/primitives/Input.tsx`:

```tsx
import type { InputHTMLAttributes } from 'react'

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  id: string
  label: string
  error?: string
}

export function Input({ id, label, error, className = '', ...rest }: Props) {
  const errorId = `${id}-error`
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-xs font-semibold uppercase tracking-[0.16em] text-foreground">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? errorId : undefined}
        className={
          'bg-[var(--input-background)] text-foreground px-4 py-2.5 text-sm rounded-md ' +
          'border border-border outline-none transition-colors ' +
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-primary ' +
          `${error ? 'border-destructive' : ''} ${className}`
        }
        {...rest}
      />
      {error && <p id={errorId} role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
```

`src/design-system/primitives/Accordion.tsx`:

```tsx
import { useState, type ReactNode } from 'react'

export interface AccordionItem { id: string; question: string; answer: ReactNode }

export function Accordion({ items }: { items: AccordionItem[] }) {
  const [openId, setOpenId] = useState<string | null>(null)
  return (
    <div className="border-t border-border">
      {items.map(item => {
        const open = openId === item.id
        return (
          <div key={item.id} className="border-b border-border">
            <h3>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={`${item.id}-panel`}
                id={`${item.id}-trigger`}
                onClick={() => setOpenId(open ? null : item.id)}
                className="w-full text-left py-5 flex justify-between items-center gap-4 text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {item.question}
                <span aria-hidden className="text-primary text-lg leading-none">{open ? '−' : '+'}</span>
              </button>
            </h3>
            <div
              id={`${item.id}-panel`}
              role="region"
              aria-labelledby={`${item.id}-trigger`}
              hidden={!open}
              className="pb-5 text-sm text-muted-foreground leading-relaxed"
            >
              {item.answer}
            </div>
          </div>
        )
      })}
    </div>
  )
}
```

`src/design-system/primitives/Tabs.tsx`:

```tsx
import { useState, type ReactNode } from 'react'

export interface Tab { id: string; label: string; content: ReactNode }

export function Tabs({ tabs }: { tabs: Tab[] }) {
  const [active, setActive] = useState(tabs[0]?.id)
  return (
    <div>
      <div role="tablist" className="flex gap-8 border-b border-border">
        {tabs.map(t => (
          <button
            key={t.id}
            role="tab"
            id={`${t.id}-tab`}
            aria-selected={active === t.id}
            aria-controls={`${t.id}-panel`}
            tabIndex={active === t.id ? 0 : -1}
            onClick={() => setActive(t.id)}
            className={
              'py-4 text-xs font-semibold uppercase tracking-[0.16em] transition-colors outline-none ' +
              'focus-visible:ring-2 focus-visible:ring-ring ' +
              (active === t.id
                ? 'text-foreground border-b-2 border-primary'
                : 'text-muted-foreground hover:text-foreground')
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map(t => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${t.id}-panel`}
          aria-labelledby={`${t.id}-tab`}
          hidden={active !== t.id}
          tabIndex={0}
          className="py-8 text-sm text-muted-foreground leading-relaxed"
        >
          {t.content}
        </div>
      ))}
    </div>
  )
}
```

`src/design-system/primitives/index.ts`:

```ts
export { Button } from './Button'
export { Eyebrow } from './Eyebrow'
export { Badge } from './Badge'
export { Card } from './Card'
export { Input } from './Input'
export { Accordion, type AccordionItem } from './Accordion'
export { Tabs, type Tab } from './Tabs'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd systems/storefront/code && npx vitest run src/design-system`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add systems/storefront/code/src/design-system
git commit -m "feat(storefront): accessible design-system primitives

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: Shell, cart context, and routing

**Files:**
- Create: `src/lib/cart/CartContext.tsx`, `src/app/Root.tsx`, `src/app/Logo.tsx`, `src/routes.ts`, `src/pages/NotFound.tsx`
- Test: `src/lib/cart/CartContext.test.tsx`, `src/app/Root.test.tsx`

**Interfaces:**
- Consumes: Tasks 7–9.
- Produces: `CartProvider`, `useCart()` returning `{ items: CartLine[]; count: number; subtotalCents: number; addItem(line: Omit<CartLine,'quantity'>, qty?: number): void; setQuantity(variantId, qty): void; removeItem(variantId): void }` where `CartLine = { variantId, productId, productSlug, name, priceCents, image, quantity }`. `router` with every route from the spec.

- [ ] **Step 1: Write the failing cart test**

Create `src/lib/cart/CartContext.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { CartProvider, useCart } from './CartContext'

const wrapper = ({ children }: { children: React.ReactNode }) => <CartProvider>{children}</CartProvider>

const LINE_A = { variantId: 'v1', productId: 'p1', productSlug: 'a', name: 'Set A', priceCents: 5000, image: '/a.jpg' }
const LINE_B = { variantId: 'v2', productId: 'p1', productSlug: 'a', name: 'Set A', priceCents: 7000, image: '/a.jpg' }

describe('cart', () => {
  it('adds a line and counts it', () => {
    const { result } = renderHook(() => useCart(), { wrapper })
    act(() => result.current.addItem(LINE_A))
    expect(result.current.count).toBe(1)
    expect(result.current.subtotalCents).toBe(5000)
  })

  // The reference implementation keyed on product id, which would collapse two
  // variants of one product into a single line at the wrong price.
  it('keeps two variants of the same product as separate lines', () => {
    const { result } = renderHook(() => useCart(), { wrapper })
    act(() => { result.current.addItem(LINE_A); result.current.addItem(LINE_B) })
    expect(result.current.items).toHaveLength(2)
    expect(result.current.subtotalCents).toBe(12000)
  })

  it('increments quantity when the same variant is added twice', () => {
    const { result } = renderHook(() => useCart(), { wrapper })
    act(() => { result.current.addItem(LINE_A); result.current.addItem(LINE_A) })
    expect(result.current.items).toHaveLength(1)
    expect(result.current.count).toBe(2)
    expect(result.current.subtotalCents).toBe(10000)
  })

  it('removes a line when quantity is set to zero', () => {
    const { result } = renderHook(() => useCart(), { wrapper })
    act(() => result.current.addItem(LINE_A))
    act(() => result.current.setQuantity('v1', 0))
    expect(result.current.items).toHaveLength(0)
  })

  it('removes a line explicitly', () => {
    const { result } = renderHook(() => useCart(), { wrapper })
    act(() => { result.current.addItem(LINE_A); result.current.addItem(LINE_B) })
    act(() => result.current.removeItem('v1'))
    expect(result.current.items.map(i => i.variantId)).toEqual(['v2'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/storefront/code && npx vitest run src/lib/cart`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the cart**

`src/lib/cart/CartContext.tsx`:

```tsx
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

export interface CartLine {
  variantId: string
  productId: string
  productSlug: string
  name: string
  priceCents: number
  image: string
  quantity: number
}

interface CartValue {
  items: CartLine[]
  count: number
  subtotalCents: number
  addItem: (line: Omit<CartLine, 'quantity'>, qty?: number) => void
  setQuantity: (variantId: string, qty: number) => void
  removeItem: (variantId: string) => void
}

const CartContext = createContext<CartValue | null>(null)

// Line identity is the VARIANT, not the product. Core's order API takes
// variantId, and two variants of one product have different prices.
// In-memory only — persistence is sub-project C.
export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartLine[]>([])

  function addItem(line: Omit<CartLine, 'quantity'>, qty = 1) {
    setItems(prev => {
      const found = prev.find(i => i.variantId === line.variantId)
      if (found) {
        return prev.map(i => i.variantId === line.variantId ? { ...i, quantity: i.quantity + qty } : i)
      }
      return [...prev, { ...line, quantity: qty }]
    })
  }

  function setQuantity(variantId: string, qty: number) {
    setItems(prev =>
      qty <= 0 ? prev.filter(i => i.variantId !== variantId)
               : prev.map(i => i.variantId === variantId ? { ...i, quantity: qty } : i))
  }

  function removeItem(variantId: string) {
    setItems(prev => prev.filter(i => i.variantId !== variantId))
  }

  const value = useMemo<CartValue>(() => ({
    items,
    count: items.reduce((n, i) => n + i.quantity, 0),
    subtotalCents: items.reduce((n, i) => n + i.priceCents * i.quantity, 0),
    addItem, setQuantity, removeItem,
  }), [items])

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart(): CartValue {
  const ctx = useContext(CartContext)
  if (!ctx) throw new Error('useCart must be used inside a CartProvider')
  return ctx
}
```

- [ ] **Step 4: Write the shell test**

Create `src/app/Root.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import Root from './Root'

function renderShell() {
  const router = createMemoryRouter(
    [{ path: '/', Component: Root, children: [{ index: true, Component: () => <h1>Home</h1> }] }],
    { initialEntries: ['/'] },
  )
  return render(<RouterProvider router={router} />)
}

describe('Root shell', () => {
  it('renders navigation and footer landmarks', () => {
    renderShell()
    expect(screen.getByRole('navigation')).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
    expect(screen.getByRole('main')).toBeInTheDocument()
  })

  it('renders the routed child', () => {
    renderShell()
    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument()
  })

  it('offers a skip link as the first focusable element', () => {
    renderShell()
    expect(screen.getByRole('link', { name: /skip to main content/i })).toBeInTheDocument()
  })

  it('labels the cart control for screen readers', () => {
    renderShell()
    expect(screen.getByRole('link', { name: /cart/i })).toBeInTheDocument()
  })
})
```

- [ ] **Step 5: Implement the shell and routes**

Create `src/app/Logo.tsx` with the `AlpineBrickLogo` SVG from the reference `Root.tsx` (four `#FFD100` studs on a `#111111` rounded square, `aria-hidden`).

Create `src/app/Root.tsx` porting the reference's `Nav`, `Footer`, and `ScrollToTop`, with these required changes:

- Wrap in `CartProvider` from `src/lib/cart/CartContext`.
- `<main id="main" role="main" className="pt-16">` preceded by a skip link:
  `<a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-primary focus:text-primary-foreground focus:px-4 focus:py-2">Skip to main content</a>`
- **Every `text-[10px]` becomes `text-xs`** (12px). The reference uses 10px with `text-muted-foreground` in four places; that fails the contrast rule.
- Footer legal line reads: `© 2026 Alpine Brick Exchange. All rights reserved. Not affiliated with the LEGO Group.`
- Footer "Shop" column links only to real routes. Drop the reference's `Gift Cards` and duplicate `Art Series` entries — they point nowhere.
- Privacy / Terms / Cookies are `<Link>`s to `/support` until those pages exist, not `href="#"`.

Create `src/pages/NotFound.tsx`: an `Eyebrow` reading `404`, a display heading `Page not found`, and a `Link` back to `/`.

Create `src/routes.ts` with the full route table from the spec — index, `product/:id`, `collections`, `collections/:slug`, `checkout`, the six `support/*` routes, and the five company routes — plus `{ path: '*', Component: NotFound }`.

Import pages as they are created in Phases 3 and 4; until then, point unbuilt routes at `NotFound`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd systems/storefront/code && npx vitest run`
Expected: PASS, all suites.

- [ ] **Step 7: Verify no 10px muted text survived**

Run: `grep -rn "text-\[10px\]" src/`
Expected: no matches.

- [ ] **Step 8: Commit**

```bash
git add systems/storefront/code/src
git commit -m "feat(storefront): app shell, variant-keyed cart and routing

Cart keys on variant rather than product; the reference implementation would
have collapsed two variants of one product into a single mispriced line.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

# Phase 3 — Catalog pages

## Task 11: Product card and grid

**Files:**
- Create: `src/components/ProductCard.tsx`, `src/components/ProductGrid.tsx`
- Test: `src/components/ProductCard.test.tsx`

**Interfaces:**
- Consumes: Tasks 7–9 (`Product`, `formatCents`, `minPriceCents`, `deriveBadge`, `Badge`, `Eyebrow`, `Card`).
- Produces: `ProductCard({ product }: { product: Product })`; `ProductGrid({ products, emptyMessage? })`.

- [ ] **Step 1: Write the failing test**

Create `src/components/ProductCard.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { ProductCard } from './ProductCard'
import type { Product } from '../lib/api/types'

function make(over: Partial<Product> = {}): Product {
  return {
    id: 'p1', slug: 'dragon-fortress', name: 'Dragon Fortress',
    description: 'Ancient stone walls.', productType: 'resale',
    releaseType: 'standard', status: 'published',
    images: [{ url: '/img/df.jpg', alt: 'Dragon Fortress front view' }],
    categories: ['fantasy'], pieces: 3156, difficulty: 'advanced',
    ageRecommendation: '14+', dimensions: '40 x 30 cm', longDescription: '',
    features: [], includes: [], builderNotes: '',
    homePosition: 1, collectionPosition: 1,
    createdAt: '2020-01-01T00:00:00Z',
    variants: [{ id: 'v1', sku: 'DF-1', priceCents: 24900, currency: 'USD' }],
    ...over,
  }
}

const wrap = (p: Product) => render(<MemoryRouter><ProductCard product={p} /></MemoryRouter>)

describe('ProductCard', () => {
  it('shows the name, formatted price and piece count', () => {
    wrap(make())
    expect(screen.getByText('Dragon Fortress')).toBeInTheDocument()
    expect(screen.getByText('$249.00')).toBeInTheDocument()
    expect(screen.getByText(/3,156 pieces/)).toBeInTheDocument()
  })

  it('links to the product detail route by slug', () => {
    wrap(make())
    expect(screen.getByRole('link', { name: /Dragon Fortress/ }))
      .toHaveAttribute('href', '/product/dragon-fortress')
  })

  it('uses the image alt text from the API', () => {
    wrap(make())
    expect(screen.getByAltText('Dragon Fortress front view')).toBeInTheDocument()
  })

  it('renders the Limited badge for a limited run', () => {
    wrap(make({ releaseType: 'limited_run' }))
    expect(screen.getByText('Limited')).toBeInTheDocument()
  })

  it('renders no badge for an older standard product', () => {
    wrap(make())
    expect(screen.queryByText('Limited')).not.toBeInTheDocument()
    expect(screen.queryByText('New')).not.toBeInTheDocument()
  })

  it('omits the piece count rather than printing null', () => {
    wrap(make({ pieces: null }))
    expect(screen.queryByText(/pieces/)).not.toBeInTheDocument()
  })

  it('survives a product with no images', () => {
    wrap(make({ images: [] }))
    expect(screen.getByText('Dragon Fortress')).toBeInTheDocument()
  })

  it('shows no price when the product has no variants', () => {
    wrap(make({ variants: [] }))
    expect(screen.queryByText(/^\$/)).not.toBeInTheDocument()
  })

  // Never invent review data.
  it('renders no rating or review count', () => {
    wrap(make())
    expect(screen.queryByText(/review/i)).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/storefront/code && npx vitest run src/components`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/components/ProductCard.tsx`:

```tsx
import { Link } from 'react-router'
import { Badge, Card, Eyebrow } from '../design-system/primitives'
import { deriveBadge } from '../lib/badge'
import { formatCents, minPriceCents } from '../lib/money'
import type { Product } from '../lib/api/types'

export function ProductCard({ product }: { product: Product }) {
  const price = minPriceCents(product)
  const badge = deriveBadge(product)
  const image = product.images[0]
  const category = product.categories[0]

  return (
    <Card className="group relative">
      {badge && (
        <div className="absolute top-3 left-3 z-10">
          <Badge tone={badge === 'Limited' ? 'primary' : 'accent'}>{badge}</Badge>
        </div>
      )}
      <Link to={`/product/${product.slug}`} className="block outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <div className="aspect-[5/4] bg-muted overflow-hidden">
          {image && (
            <img
              src={image.url}
              alt={image.alt}
              loading="lazy"
              className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
          )}
        </div>
        <div className="p-5">
          {category && <Eyebrow className="mb-1.5">{category}</Eyebrow>}
          <h3
            className="text-lg font-black uppercase tracking-[0.06em] text-foreground group-hover:text-primary transition-colors"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            {product.name}
          </h3>
          <div className="mt-3 flex items-end justify-between gap-4">
            {price !== null && (
              <span className="text-base font-semibold text-foreground">{formatCents(price)}</span>
            )}
            {product.pieces !== null && (
              <span className="text-xs text-muted-foreground">
                {product.pieces.toLocaleString()} pieces
              </span>
            )}
          </div>
        </div>
      </Link>
    </Card>
  )
}
```

`src/components/ProductGrid.tsx`:

```tsx
import { ProductCard } from './ProductCard'
import type { Product } from '../lib/api/types'

export function ProductGrid({
  products,
  emptyMessage = 'No sets here yet — check back soon',
}: { products: Product[]; emptyMessage?: string }) {
  if (products.length === 0) {
    return (
      <p className="py-24 text-center text-xs uppercase tracking-[0.18em] text-muted-foreground">
        {emptyMessage}
      </p>
    )
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
      {products.map(p => <ProductCard key={p.id} product={p} />)}
    </div>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd systems/storefront/code && npx vitest run src/components`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add systems/storefront/code/src/components
git commit -m "feat(storefront): product card and grid

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 12: Home page with route loader

**Files:**
- Create: `src/pages/Home.tsx`
- Modify: `src/routes.ts`
- Test: `src/pages/Home.test.tsx`

**Interfaces:**
- Consumes: Tasks 7, 8, 11.
- Produces: `Home` component and `homeLoader({ request }): Promise<{ page: ProductListPage; category: string | null; search: string | null }>`.

- [ ] **Step 1: Write the failing test**

Create `src/pages/Home.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import Home, { homeLoader } from './Home'
import type { Product } from '../lib/api/types'

vi.mock('../lib/api/catalog', () => ({ getProducts: vi.fn() }))
import { getProducts } from '../lib/api/catalog'

function product(id: string, name: string, slug: string): Product {
  return {
    id, slug, name, description: '', productType: 'resale', releaseType: 'standard',
    status: 'published', images: [{ url: '/i.jpg', alt: `${name} view` }],
    categories: ['space'], pieces: 100, difficulty: null, ageRecommendation: null,
    dimensions: null, longDescription: '', features: [], includes: [], builderNotes: '',
    homePosition: null, collectionPosition: null,
    createdAt: '2020-01-01T00:00:00Z',
    variants: [{ id: `${id}v`, sku: `${id}-1`, priceCents: 1000, currency: 'USD' }],
  }
}

function renderAt(path: string) {
  const router = createMemoryRouter(
    [{ path: '/', Component: Home, loader: homeLoader }],
    { initialEntries: [path] },
  )
  return render(<RouterProvider router={router} />)
}

afterEach(() => vi.clearAllMocks())

describe('Home', () => {
  it('renders the products the loader fetched', async () => {
    vi.mocked(getProducts).mockResolvedValue({
      items: [product('1', 'Orbiter', 'orbiter')], total: 1, page: 1, pageSize: 20, totalPages: 1,
    })
    renderAt('/')
    expect(await screen.findByText('Orbiter')).toBeInTheDocument()
  })

  it('passes the category query parameter through to the API', async () => {
    vi.mocked(getProducts).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 })
    renderAt('/?category=space')
    await screen.findByText(/no sets/i)
    expect(vi.mocked(getProducts).mock.calls[0][0]).toMatchObject({ category: 'space' })
  })

  it('requests the home display order', async () => {
    vi.mocked(getProducts).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 })
    renderAt('/')
    await screen.findByText(/no sets/i)
    expect(vi.mocked(getProducts).mock.calls[0][0]).toMatchObject({ sort: 'home_display' })
  })

  // The server decides the order. If the page ever re-sorts, page 2 will be
  // sorted independently of page 1 and the sequence breaks.
  it('renders products in the exact order the API returned them', async () => {
    const items = [
      product('1', 'Zulu Set', 'zulu'),
      product('2', 'Alpha Set', 'alpha'),
      product('3', 'Mike Set', 'mike'),
    ]
    vi.mocked(getProducts).mockResolvedValue({ items, total: 3, page: 1, pageSize: 20, totalPages: 1 })
    renderAt('/')
    await screen.findByText('Zulu Set')
    const rendered = screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)
    expect(rendered).toEqual(['Zulu Set', 'Alpha Set', 'Mike Set'])
  })

  it('passes the search query parameter through as q', async () => {
    vi.mocked(getProducts).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 })
    renderAt('/?q=dragon')
    await screen.findByText(/no sets/i)
    expect(vi.mocked(getProducts).mock.calls[0][0]).toMatchObject({ search: 'dragon' })
  })

  it('shows an empty state rather than a blank page', async () => {
    vi.mocked(getProducts).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 })
    renderAt('/')
    expect(await screen.findByText(/no sets/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/storefront/code && npx vitest run src/pages/Home.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/pages/Home.tsx`. Structure, top to bottom:

1. **Hero** — an `Eyebrow` reading `Alpine Brick Exchange`, a display `h1` in `font-display` weight 900 uppercase, a short body paragraph in `text-muted-foreground`, and a `Button` linking to `/collections`.
2. **Category filter row** — one control per entry in `COLLECTIONS` that has a `category` query, plus an "All" control. Each is a `Link` to `/?category=<slug>`, styled as an uppercase letter-spaced micro-label, with the active one taking `text-foreground border-b-2 border-primary`.
3. **`ProductGrid`** with the loader's items.

```tsx
import { useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { getProducts } from '../lib/api/catalog'
import type { ProductListPage } from '../lib/api/types'
import { ProductGrid } from '../components/ProductGrid'

interface HomeData { page: ProductListPage; category: string | null; search: string | null }

export async function homeLoader({ request }: LoaderFunctionArgs): Promise<HomeData> {
  const url = new URL(request.url)
  const category = url.searchParams.get('category')
  const search = url.searchParams.get('q')
  const page = await getProducts({
    category: category ?? undefined,
    search: search ?? undefined,
    // The home page shows products in merchandised home order. Rendering the
    // array as received is the point — never re-sort it here.
    sort: 'home_display',
    pageSize: 24,
  })
  return { page, category, search }
}

export default function Home() {
  const { page } = useLoaderData() as HomeData
  // ... hero, filter row, then:
  return <ProductGrid products={page.items} emptyMessage="No sets in this category yet — check back soon" />
}
```

Wire `homeLoader` into the index route in `src/routes.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd systems/storefront/code && npx vitest run src/pages/Home.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add systems/storefront/code/src/pages/Home.tsx systems/storefront/code/src/routes.ts systems/storefront/code/src/pages/Home.test.tsx
git commit -m "feat(storefront): home page with server-owned filtering

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 13: Product detail page

**Files:**
- Create: `src/pages/ProductDetail.tsx`
- Modify: `src/routes.ts`
- Test: `src/pages/ProductDetail.test.tsx`

**Interfaces:**
- Consumes: Tasks 7–10.
- Produces: `ProductDetail` component and `productLoader({ params })` returning `{ product: Product; availability: Availability[] }`.

- [ ] **Step 1: Write the failing test**

Create `src/pages/ProductDetail.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import ProductDetail, { productLoader } from './ProductDetail'
import { CartProvider } from '../lib/cart/CartContext'
import type { Product } from '../lib/api/types'

vi.mock('../lib/api/catalog', () => ({ getProduct: vi.fn(), getAvailability: vi.fn() }))
import { getProduct, getAvailability } from '../lib/api/catalog'

const PRODUCT: Product = {
  id: 'p1', slug: 'dragon-fortress', name: 'Dragon Fortress',
  description: 'Ancient stone walls.', productType: 'resale', releaseType: 'limited_run',
  status: 'published', images: [
    { url: '/a.jpg', alt: 'Dragon Fortress front' },
    { url: '/b.jpg', alt: 'Dragon Fortress rear' },
  ],
  categories: ['fantasy'], pieces: 3156, difficulty: 'advanced',
  ageRecommendation: '14+', dimensions: '40 x 30 cm',
  longDescription: 'A long description of the fortress.',
  features: ['Seven secret passages'], includes: ['4 minifigures'],
  builderNotes: 'The gatehouse was rebuilt twice.',
  homePosition: 1, collectionPosition: 1,
  createdAt: '2020-01-01T00:00:00Z',
  variants: [{ id: 'v1', sku: 'DF-1', priceCents: 24900, currency: 'USD' }],
}

function renderPage() {
  const router = createMemoryRouter(
    [{ path: '/product/:id', Component: ProductDetail, loader: productLoader }],
    { initialEntries: ['/product/dragon-fortress'] },
  )
  return render(<CartProvider><RouterProvider router={router} /></CartProvider>)
}

afterEach(() => vi.clearAllMocks())

describe('ProductDetail', () => {
  it('renders name, price and specifications', async () => {
    vi.mocked(getProduct).mockResolvedValue(PRODUCT)
    vi.mocked(getAvailability).mockResolvedValue([{ variantId: 'v1', sku: 'DF-1', available: 5 }])
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Dragon Fortress' })).toBeInTheDocument()
    expect(screen.getByText('$249.00')).toBeInTheDocument()
    expect(screen.getByText(/3,156/)).toBeInTheDocument()
    expect(screen.getByText('14+')).toBeInTheDocument()
  })

  it('shows the primary image with its alt text', async () => {
    vi.mocked(getProduct).mockResolvedValue(PRODUCT)
    vi.mocked(getAvailability).mockResolvedValue([])
    renderPage()
    expect(await screen.findByAltText('Dragon Fortress front')).toBeInTheDocument()
  })

  it('adds to cart and confirms', async () => {
    vi.mocked(getProduct).mockResolvedValue(PRODUCT)
    vi.mocked(getAvailability).mockResolvedValue([{ variantId: 'v1', sku: 'DF-1', available: 5 }])
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: /add to cart/i }))
    expect(await screen.findByText(/added/i)).toBeInTheDocument()
  })

  it('disables add to cart when nothing is available', async () => {
    vi.mocked(getProduct).mockResolvedValue(PRODUCT)
    vi.mocked(getAvailability).mockResolvedValue([{ variantId: 'v1', sku: 'DF-1', available: 0 }])
    renderPage()
    expect(await screen.findByRole('button', { name: /out of stock/i })).toBeDisabled()
  })

  it('exposes description and specification tabs', async () => {
    vi.mocked(getProduct).mockResolvedValue(PRODUCT)
    vi.mocked(getAvailability).mockResolvedValue([])
    renderPage()
    expect(await screen.findByRole('tab', { name: /description/i })).toBeInTheDocument()
    expect(screen.getAllByRole('tab').length).toBeGreaterThanOrEqual(2)
  })

  it('renders no rating or review count', async () => {
    vi.mocked(getProduct).mockResolvedValue(PRODUCT)
    vi.mocked(getAvailability).mockResolvedValue([])
    renderPage()
    await screen.findByRole('heading', { name: 'Dragon Fortress' })
    expect(screen.queryByText(/review/i)).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/storefront/code && npx vitest run src/pages/ProductDetail.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/pages/ProductDetail.tsx`:

- `productLoader({ params })` calls `getProduct(params.id!)` and `getAvailability(params.id!)` with `Promise.all`. `getAvailability` failure must not block the page — catch it and fall back to `[]`.
- Layout: two columns on `lg`. Left is the image gallery — primary image plus thumbnail strip; clicking a thumbnail swaps the primary. Each thumbnail is a `button` with `aria-label={`View ${img.alt}`}`.
- Right column: `Eyebrow` with the first category, display `h1`, `Badge` when `deriveBadge` returns one, price via `formatCents(minPriceCents(product))`, a spec list (`pieces` with `toLocaleString()`, `difficulty`, `ageRecommendation`, `dimensions`, SKU as set number) rendered as a `<dl>`, each rendered **only when non-null**.
- Add-to-cart `Button`: label `Add to cart`, or `Out of stock` and `disabled` when the selected variant's availability is `0`. On click, call `addItem({ variantId, productId: product.id, productSlug: product.slug, name: product.name, priceCents, image: product.images[0]?.url ?? '' })` and set a local `added` state for 2 seconds, rendering `Added ✓` in `text-accent` — **the one place pure white is correct**.
- Below: `Tabs` with `Description` (`longDescription` plus `features` as a list), `Specifications` (the `<dl>`), and `Builder notes` (`builderNotes`) — each tab included only when its content is non-empty.

Wire `productLoader` into the `product/:id` route.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd systems/storefront/code && npx vitest run src/pages/ProductDetail.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add systems/storefront/code/src/pages/ProductDetail.tsx systems/storefront/code/src/pages/ProductDetail.test.tsx systems/storefront/code/src/routes.ts
git commit -m "feat(storefront): product detail page

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 14: Collections index and detail

**Files:**
- Create: `src/pages/Collections.tsx`, `src/pages/CollectionDetail.tsx`
- Modify: `src/routes.ts`
- Test: `src/pages/Collections.test.tsx`, `src/pages/CollectionDetail.test.tsx`

**Interfaces:**
- Consumes: Task 8's `COLLECTIONS` / `findCollection`, Task 11's `ProductGrid`.
- Produces: `Collections`; `CollectionDetail` and `collectionLoader({ params })` returning `{ collection: Collection; page: ProductListPage }`, throwing a 404 `Response` for an unknown slug.

- [ ] **Step 1: Write the failing tests**

Create `src/pages/Collections.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import Collections from './Collections'
import { COLLECTIONS } from '../lib/collections'

describe('Collections index', () => {
  it('lists every collection with a link', () => {
    render(<MemoryRouter><Collections /></MemoryRouter>)
    for (const c of COLLECTIONS) {
      expect(screen.getByRole('link', { name: new RegExp(c.title, 'i') }))
        .toHaveAttribute('href', `/collections/${c.slug}`)
    }
  })

  it('shows each collection blurb', () => {
    render(<MemoryRouter><Collections /></MemoryRouter>)
    for (const c of COLLECTIONS) expect(screen.getByText(c.blurb)).toBeInTheDocument()
  })
})
```

Create `src/pages/CollectionDetail.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import CollectionDetail, { collectionLoader } from './CollectionDetail'

vi.mock('../lib/api/catalog', () => ({ getProducts: vi.fn() }))
import { getProducts } from '../lib/api/catalog'

function renderAt(slug: string) {
  const router = createMemoryRouter(
    [{
      path: '/collections/:slug', Component: CollectionDetail, loader: collectionLoader,
      errorElement: <p>Collection not found</p>,
    }],
    { initialEntries: [`/collections/${slug}`] },
  )
  return render(<RouterProvider router={router} />)
}

afterEach(() => vi.clearAllMocks())

describe('CollectionDetail', () => {
  it('renders the collection title and its products', async () => {
    vi.mocked(getProducts).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 24, totalPages: 0 })
    renderAt('architecture')
    expect(await screen.findByRole('heading', { name: /architecture/i })).toBeInTheDocument()
  })

  it('queries the API with the collection query', async () => {
    vi.mocked(getProducts).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 24, totalPages: 0 })
    renderAt('space')
    await screen.findByRole('heading', { name: /space/i })
    expect(vi.mocked(getProducts).mock.calls[0][0])
      .toMatchObject({ category: 'space', sort: 'collection_display' })
  })

  // Collections use their own ordering, independent of the home page's.
  it('never requests the home display order', async () => {
    vi.mocked(getProducts).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 24, totalPages: 0 })
    renderAt('fantasy')
    await screen.findByRole('heading', { name: /fantasy/i })
    expect(vi.mocked(getProducts).mock.calls[0][0].sort).not.toBe('home_display')
  })

  // An empty grid would claim the collection exists but is empty.
  it('404s an unknown slug instead of rendering an empty grid', async () => {
    renderAt('not-a-collection')
    expect(await screen.findByText('Collection not found')).toBeInTheDocument()
    expect(getProducts).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd systems/storefront/code && npx vitest run src/pages/Collection`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/pages/Collections.tsx` — a page heading plus a responsive grid of `Card`s, one per `COLLECTIONS` entry, each wrapping a `Link` to `/collections/<slug>` with the title in `font-display` and the blurb in `text-muted-foreground`.

`src/pages/CollectionDetail.tsx`:

```tsx
import { useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { findCollection, type Collection } from '../lib/collections'
import { getProducts } from '../lib/api/catalog'
import type { ProductListPage } from '../lib/api/types'
import { ProductGrid } from '../components/ProductGrid'
import { Eyebrow } from '../design-system/primitives'

interface Data { collection: Collection; page: ProductListPage }

export async function collectionLoader({ params }: LoaderFunctionArgs): Promise<Data> {
  const collection = findCollection(params.slug ?? '')
  // Throw before fetching: an unknown slug is a 404, not an empty collection.
  if (!collection) throw new Response('Not found', { status: 404 })
  const page = await getProducts({ ...collection.query, pageSize: 24 })
  return { collection, page }
}

export default function CollectionDetail() {
  const { collection, page } = useLoaderData() as Data
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-16">
      <Eyebrow className="mb-3">Collection</Eyebrow>
      <h1 className="text-4xl font-black uppercase tracking-[0.06em] text-foreground"
          style={{ fontFamily: 'var(--font-display)' }}>
        {collection.title}
      </h1>
      <p className="mt-4 mb-12 max-w-2xl text-sm text-muted-foreground leading-relaxed">
        {collection.blurb}
      </p>
      <ProductGrid products={page.items} />
    </div>
  )
}
```

Wire both routes, giving `collections/:slug` an `errorElement` that renders the `NotFound` page.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd systems/storefront/code && npx vitest run src/pages`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add systems/storefront/code/src/pages systems/storefront/code/src/routes.ts
git commit -m "feat(storefront): collections index and detail

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

# Phase 4 — Content pages and verification

## Task 15: The eleven static content pages

**Files:**
- Create: `src/content/company.ts`, `src/content/support.ts`
- Create: `src/pages/company/About.tsx`, `Designers.tsx`, `Careers.tsx`, `Press.tsx`, `Community.tsx`
- Create: `src/pages/support/Support.tsx`, `FAQ.tsx`, `Shipping.tsx`, `Returns.tsx`
- Create: `src/components/PageHeader.tsx`
- Modify: `src/routes.ts`
- Test: `src/pages/content-pages.test.tsx`

**Interfaces:**
- Consumes: Task 9's primitives.
- Produces: `PageHeader({ eyebrow, title, intro? })`; content modules exporting typed page copy.

**Copy rule:** every page carries real Alpine Brick copy. **No fabricated press quotes, customer testimonials, named employees, or specific job openings.** Where the design shows such content and none exists, the section states plainly that there is nothing yet — a Press page with "No press coverage yet — media enquiries welcome at alpinebrick@gmail.com" is honest; three invented publication quotes are not.

- [ ] **Step 1: Write the failing test**

Create `src/pages/content-pages.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import About from './company/About'
import Designers from './company/Designers'
import Careers from './company/Careers'
import Press from './company/Press'
import Community from './company/Community'
import Support from './support/Support'
import FAQ from './support/FAQ'
import Shipping from './support/Shipping'
import Returns from './support/Returns'

const PAGES: [string, React.ComponentType][] = [
  ['About', About], ['Designers', Designers], ['Careers', Careers],
  ['Press', Press], ['Community', Community], ['Support', Support],
  ['FAQ', FAQ], ['Shipping', Shipping], ['Returns', Returns],
]

describe.each(PAGES)('%s page', (_name, Page) => {
  it('renders exactly one level-1 heading', () => {
    render(<MemoryRouter><Page /></MemoryRouter>)
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  it('renders no placeholder text', () => {
    render(<MemoryRouter><Page /></MemoryRouter>)
    expect(document.body.textContent).not.toMatch(/lorem ipsum|TODO|TBD|placeholder/i)
  })
})

describe('FAQ', () => {
  it('renders questions as expandable buttons', () => {
    render(<MemoryRouter><FAQ /></MemoryRouter>)
    const first = screen.getAllByRole('button')[0]
    expect(first).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('Press', () => {
  it('states there is no coverage rather than inventing quotes', () => {
    render(<MemoryRouter><Press /></MemoryRouter>)
    expect(screen.getByText(/no press coverage yet/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd systems/storefront/code && npx vitest run src/pages/content-pages.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/components/PageHeader.tsx`:

```tsx
export function PageHeader({ eyebrow, title, intro }: { eyebrow: string; title: string; intro?: string }) {
  return (
    <header className="max-w-3xl">
      <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
        {eyebrow}
      </span>
      <h1 className="text-4xl sm:text-5xl font-black uppercase tracking-[0.05em] text-foreground"
          style={{ fontFamily: 'var(--font-display)' }}>
        {title}
      </h1>
      {intro && <p className="mt-5 text-sm text-muted-foreground leading-relaxed">{intro}</p>}
    </header>
  )
}
```

Write `src/content/company.ts` and `src/content/support.ts` as typed copy modules, then a thin component per page that renders `PageHeader` plus its sections. Content requirements:

- **About** — Alpine Brick Exchange trading since 2021; custom-designed sets and collectible previously-sold sets; not affiliated with the LEGO Group.
- **Designers** — explains that designers earn a share of revenue on every sale of their design. **Name no designers**; none are contracted.
- **Careers** — states there are no open roles and invites speculative approaches to alpinebrick@gmail.com. **Invent no job listings.**
- **Press** — must contain the string `No press coverage yet`, plus a media-enquiry address.
- **Community** — describes the intent to host LEGO events. **Link to no external social accounts** — the `tubsofficial.com` properties are parked and their administration is unresolved.
- **Support** — hub linking to FAQ, Shipping, Returns, Track order, Contact.
- **FAQ** — an `Accordion` of 8–10 genuine questions covering ordering, shipping timeframes, returns, set condition for collectibles, and LEGO Group non-affiliation.
- **Shipping** — states shipping policy generically. **Quote no specific rates or delivery windows** — those are sub-project C and are not decided.
- **Returns** — states a returns process generically, with the same caveat.

Wire all nine routes. `support/track-order` and `support/contact` remain pointed at `NotFound` — they are sub-project D.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd systems/storefront/code && npx vitest run`
Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add systems/storefront/code/src
git commit -m "feat(storefront): company and support content pages

Copy states plainly where nothing exists yet rather than inventing press
quotes, job openings, named designers or shipping rates.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 16: End-to-end verification and documentation

**Files:**
- Modify: `systems/storefront/README.md`, `systems/storefront/code/README.md`
- Delete: `systems/storefront/code/Dockerfile` if it references the removed Express server

- [ ] **Step 1: Verify core in full**

```bash
cd systems/core
npm test
npx tsc --noEmit
npm run build
```

Expected: all tests pass, no type errors, clean build. Record the test count.

- [ ] **Step 2: Verify the storefront in full**

```bash
cd systems/storefront/code
npx vitest run
npx tsc --noEmit
npm run build
```

Expected: all tests pass, no type errors, `dist/` produced.

- [ ] **Step 3: Boot both and click through**

A green suite does not mean either app boots — this step is separate on purpose.

```bash
cd systems/core && npm run seed && node dist/server.js
```

In a second shell:

```bash
cd systems/storefront/code && npm run preview
```

Visit the preview URL and confirm, by eye:
- Home renders seeded products with images, prices and piece counts.
- **Home products appear in `homePosition` order.** Check against the seed by eye, then change one product's `homePosition` in the database, reload, and confirm it moves.
- **A collection page orders by `collectionPosition`, and that order differs from the home page's.** If the two look identical, either the seed set both columns the same way or a loader is requesting the wrong sort.
- A category filter link narrows the grid.
- A product card links to a detail page that renders specs and tabs.
- Add to cart increments the nav badge; adding two different variants creates two lines.
- `/collections` lists seven collections; each detail page loads.
- `/collections/not-real` renders the 404 page, not an empty grid.
- Every content page renders.
- **Tab through the home page**: focus is visible on every interactive element.

- [ ] **Step 4: Rewrite the storefront READMEs**

`systems/storefront/code/README.md` must replace the stale architecture entirely. The old one documents an Express proxy to `catalog-service:4001` through `affiliate-service:4004` — all removed mocks. State: the app talks to `systems/core` at `/api/v1/catalog` via the Vite dev proxy; Tailwind v4 is configured in `src/styles/globals.css`, not `tailwind.config.js`; run with **core on port 4000** and `npm run dev` on 5173.

`systems/storefront/README.md` — update the status table: Sprint 1 complete, cart/checkout deferred to sub-project C, tracking and contact to D. Remove the service-dependency list naming the four mock services.

Delete `Dockerfile` if it builds the removed Express server.

- [ ] **Step 5: Commit**

```bash
git add systems/storefront
git commit -m "docs(storefront): document the core-backed architecture

Replaces the stale Sprint-1 README describing proxies to the removed
in-memory mock services.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Report to Jack and request approval to push**

Report: test counts for both systems, the boot check result, and anything deferred. **Do not push** — Jack approves pushes.

---

## Open items carried out of this plan

These are recorded in the spec and remain unresolved. None block the plan; all block anything customer-facing.

1. **Real product photography.** Everything ships with neutral placeholders.
2. **Whether the seven collections match real merchandising.** The slugs come from the design.
3. **Whether the static page copy says what Jack wants.** Needs a marketing review.
4. **ADR-0002 (image CDN) remains DRAFT** and is Jack's spend decision.
