# Catalog Admin UI — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a clickable, in-session-stateful admin console SPA (`systems/admin-ui/`) for catalog management — overview, product list, create, and tabbed product detail — backed by a mock data layer, so Jack can run it locally and validate the full manage-a-catalog flow before any backend exists.

**Architecture:** A new, standalone Vite + React (plain JSX) package, separate from the storefront (different package, different domain — never co-bundled). All data access goes through a single `mockApi` service object whose function surface is the seam we keep stable for Phase B (swap `mockApi` → `adminApi` with no component rewrites). Business logic (slug, bulk-variant generation, filter/sort/paginate, store mutations) lives in small pure modules with unit tests; React components consume them.

**Tech Stack:** React 18, Vite 5, Tailwind CSS 3, react-router-dom 6, Vitest + @testing-library/react + jsdom. Plain JavaScript/JSX (no TypeScript), matching the storefront's conventions.

**Design source:** `systems/admin-ui/design/references/Model Admin Home Page.webp` — adopt look & feel only (violet/pink accents, black pill primary actions, soft lavender background, white rounded cards). Content stays catalog-scoped. See spec `docs/superpowers/specs/2026-06-04-catalog-admin-ui-design.md` §5.

---

## Data shapes (used throughout)

These mirror the catalog-service DB + catalog-admin SPEC so Phase B is a drop-in.

```js
// Product (full)
{
  id: 'prod-001',
  name: 'Classic Brick Set',
  slug: 'classic-brick-set',
  description: 'A timeless building set.',
  categories: ['sets', 'classic'],
  metadata: { brand: 'ImagiBricks', weight: '1.2kg' },
  status: 'draft',            // 'draft' | 'published' | 'archived'
  published_at: null,         // ISO string | null
  archived_at: null,          // ISO string | null
  created_at: '2026-06-01T10:00:00.000Z',
  updated_at: '2026-06-01T10:00:00.000Z',
  created_by: 'admin-1',
  updated_by: 'admin-1',
  variants: [ /* Variant */ ],
  images: [ /* Image */ ],
}

// Variant
{ id: 'var-001', product_id: 'prod-001', sku: 'CBS-RED-S', price: 29.99,
  inventory_item_id: null, attributes: { color: 'red', size: 'S' } }

// Image
{ id: 'img-001', product_id: 'prod-001', url: 'https://…', alt_text: 'Front view', display_order: 0 }
```

> **Note on `status`:** the design uses a single `status` enum ('draft'|'published'|'archived') in the UI/mock layer. Phase B's DB uses a `published` boolean + `archived_at`; the Phase B `adminApi` adapter will map between them. Keep `status` as the UI contract.

## The seam: `mockApi` function surface (stable for Phase B)

Every component imports ONLY from `src/data/mockApi.js`. Phase B replaces the module body; the signatures below do not change.

```js
getOverviewStats()                         // → { totalProducts, published, draft, archived, recentlyModified:[ProductSummary], missingImages:[ProductSummary], missingVariants:[ProductSummary] }
listProducts({ page, limit, search, category, status, sort }) // → { items:[ProductSummary], total, page, limit }
getProduct(id)                             // → Product (full) | throws AdminApiError code NOT_FOUND
createProduct({ name, description, categories, slug, metadata }) // → Product | throws VALIDATION_ERROR
updateProduct(id, patch)                   // → Product
archiveProduct(id)                         // → Product (status='archived')
setProductStatus(id, status)               // → Product   ('draft'|'published'|'archived')
bulkSetStatus(ids, status)                 // → { updated: number }
createVariant(productId, { sku, price, attributes, inventory_item_id }) // → Variant | throws VALIDATION_ERROR (dup SKU)
updateVariant(productId, variantId, patch) // → Variant
deleteVariant(productId, variantId)        // → { success: true }
bulkCreateVariants(productId, { sku_prefix, price, attribute_key, values }) // → { created:[Variant] }
addImage(productId, { url, alt_text })     // → Image (Phase A: url is an object URL)
reorderImages(productId, orderedIds)       // → { images:[Image] }
updateImageAlt(productId, imageId, alt_text) // → Image
deleteImage(productId, imageId)            // → { success: true }
```

`ProductSummary` = `{ id, name, status, variant_count, image_count, updated_at, categories }`.

All functions are `async` (return Promises) and resolve after a tiny simulated delay so loading states are real. Errors throw an `AdminApiError` with a `.code` (`NOT_FOUND` | `VALIDATION_ERROR` | `INTERNAL`) and optional `.fields`, mirroring the storefront's `toCatalogError` pattern.

## File structure

```
systems/admin-ui/
├─ package.json
├─ vite.config.js
├─ tailwind.config.js
├─ postcss.config.js
├─ index.html
├─ README.md
├─ .gitignore
└─ src/
   ├─ main.jsx                      # React + router entry
   ├─ App.jsx                       # <Routes> inside <ConsoleShell>
   ├─ setupTests.js                 # jest-dom
   ├─ styles/index.css              # tailwind directives
   ├─ lib/
   │  ├─ slug.js                    # slugify + ensureUniqueSlug
   │  ├─ slug.test.js
   │  ├─ variants.js                # generateVariants(template)
   │  ├─ variants.test.js
   │  ├─ query.js                   # applyQuery(items, opts) → {items,total,page,limit}
   │  └─ query.test.js
   ├─ data/
   │  ├─ seed.js                    # seed products
   │  ├─ store.js                   # in-memory CRUD store (stateful)
   │  ├─ store.test.js
   │  ├─ errors.js                  # AdminApiError
   │  └─ mockApi.js                 # the seam (wraps store, async)
   ├─ ui/
   │  ├─ Button.jsx
   │  ├─ Pill.jsx
   │  ├─ Card.jsx
   │  ├─ StatCard.jsx
   │  ├─ ProgressBar.jsx
   │  ├─ Modal.jsx
   │  ├─ toast.jsx                  # ToastProvider + useToast
   │  └─ ui.test.jsx
   ├─ shell/
   │  ├─ ConsoleShell.jsx
   │  └─ Nav.jsx
   └─ catalog/
      ├─ CatalogOverview.jsx
      ├─ ProductList.jsx
      ├─ ProductForm.jsx
      ├─ ProductDetail.jsx
      ├─ useAutoSave.js
      ├─ tabs/
      │  ├─ InfoTab.jsx
      │  ├─ VariantsTab.jsx
      │  ├─ BulkVariantForm.jsx
      │  ├─ ImagesTab.jsx
      │  └─ PublishTab.jsx
      └─ catalog.test.jsx
```

---

## Task 1: Scaffold the `admin-ui` package

**Files:**
- Create: `systems/admin-ui/package.json`, `vite.config.js`, `tailwind.config.js`, `postcss.config.js`, `index.html`, `.gitignore`, `src/main.jsx`, `src/App.jsx`, `src/styles/index.css`, `src/setupTests.js`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "admin-ui",
  "version": "0.1.0",
  "private": true,
  "description": "ImagiBricks internal admin console (Catalog module 1). Separate from the storefront.",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.22.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.2.0",
    "vite": "^5.0.0",
    "tailwindcss": "^3.3.0",
    "postcss": "^8.4.32",
    "autoprefixer": "^10.4.16",
    "vitest": "^1.4.0",
    "jsdom": "^24.0.0",
    "@testing-library/react": "^14.0.0",
    "@testing-library/jest-dom": "^6.0.0",
    "@testing-library/user-event": "^14.5.0"
  }
}
```

- [ ] **Step 2: Create `vite.config.js`** (port 5174 so it can run alongside the storefront's 5173)

```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 5174 },
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/setupTests.js',
    include: ['src/**/*.{test,spec}.{js,jsx}'],
  },
})
```

- [ ] **Step 3: Create `tailwind.config.js`** with the design tokens from spec §5

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: '#7B5CFA', soft: '#EDE9FE', dark: '#5B3FE0' },
        accent: { DEFAULT: '#F25FB0', soft: '#FCE7F3' },
        ink: '#111114',
        canvas: '#ECEAF3',
      },
      borderRadius: { card: '1.25rem', pill: '999px' },
      boxShadow: { card: '0 8px 24px -12px rgba(17,17,20,0.12)' },
    },
  },
  plugins: [],
}
```

- [ ] **Step 4: Create `postcss.config.js`**

```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } }
```

- [ ] **Step 5: Create `src/styles/index.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

body { @apply bg-canvas text-ink antialiased; }
```

- [ ] **Step 6: Create `index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ImagiBricks Admin</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

- [ ] **Step 7: Create `.gitignore`**

```
node_modules
dist
*.local
```

- [ ] **Step 8: Create `src/setupTests.js`**

```js
import '@testing-library/jest-dom'
```

- [ ] **Step 9: Create a minimal `src/App.jsx` and `src/main.jsx` so the app boots**

`src/main.jsx`:
```jsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import './styles/index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)
```

`src/App.jsx` (placeholder; replaced in Task 6):
```jsx
export default function App() {
  return <div className="p-8 text-2xl font-bold">ImagiBricks Admin — booting…</div>
}
```

- [ ] **Step 10: Install and verify it boots**

Run: `npm install` (in `systems/admin-ui/`)
Run: `npm run dev`
Expected: Vite serves on `http://localhost:5174` showing "ImagiBricks Admin — booting…". Stop the server (Ctrl-C).

- [ ] **Step 11: Commit**

```bash
git add systems/admin-ui
git commit -m "feat(admin-ui): scaffold Vite+React+Tailwind console package"
```

---

## Task 2: `lib/slug.js` — slug generation (TDD)

**Files:**
- Create: `systems/admin-ui/src/lib/slug.js`, `src/lib/slug.test.js`

- [ ] **Step 1: Write the failing test** (`src/lib/slug.test.js`)

```js
import { describe, it, expect } from 'vitest'
import { slugify, ensureUniqueSlug } from './slug.js'

describe('slugify', () => {
  it('lowercases, trims, and hyphenates', () => {
    expect(slugify('  Classic Brick Set ')).toBe('classic-brick-set')
  })
  it('strips non-alphanumerics and collapses separators', () => {
    expect(slugify('Red & Blue!! 100pc')).toBe('red-blue-100pc')
  })
  it('returns empty string for empty input', () => {
    expect(slugify('')).toBe('')
  })
})

describe('ensureUniqueSlug', () => {
  it('returns the base slug when unused', () => {
    expect(ensureUniqueSlug('abc', [])).toBe('abc')
  })
  it('suffixes -2, -3 when taken', () => {
    expect(ensureUniqueSlug('abc', ['abc'])).toBe('abc-2')
    expect(ensureUniqueSlug('abc', ['abc', 'abc-2'])).toBe('abc-3')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/slug.test.js`
Expected: FAIL — cannot find module './slug.js' / exports undefined.

- [ ] **Step 3: Write `src/lib/slug.js`**

```js
export function slugify(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function ensureUniqueSlug(base, existingSlugs) {
  const taken = new Set(existingSlugs)
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/slug.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add systems/admin-ui/src/lib/slug.js systems/admin-ui/src/lib/slug.test.js
git commit -m "feat(admin-ui): slug generation + uniqueness helper"
```

---

## Task 3: `lib/variants.js` — bulk variant generation (TDD)

**Files:**
- Create: `systems/admin-ui/src/lib/variants.js`, `src/lib/variants.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest'
import { generateVariants } from './variants.js'

describe('generateVariants', () => {
  it('creates one variant per value with prefixed SKU and shared price', () => {
    const out = generateVariants({ sku_prefix: 'CBS-', price: 29.99, attribute_key: 'size', values: ['S', 'M', 'L'] })
    expect(out).toEqual([
      { sku: 'CBS-S', price: 29.99, attributes: { size: 'S' } },
      { sku: 'CBS-M', price: 29.99, attributes: { size: 'M' } },
      { sku: 'CBS-L', price: 29.99, attributes: { size: 'L' } },
    ])
  })
  it('uppercases value in SKU and trims whitespace values', () => {
    const out = generateVariants({ sku_prefix: 'X-', price: 1, attribute_key: 'color', values: [' red '] })
    expect(out[0].sku).toBe('X-RED')
    expect(out[0].attributes).toEqual({ color: 'red' })
  })
  it('skips empty values', () => {
    const out = generateVariants({ sku_prefix: 'X-', price: 1, attribute_key: 'size', values: ['S', '', '  '] })
    expect(out).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/variants.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/lib/variants.js`**

```js
export function generateVariants({ sku_prefix, price, attribute_key, values }) {
  return (values || [])
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0)
    .map((v) => ({
      sku: `${sku_prefix}${v.toUpperCase()}`,
      price: Number(price),
      attributes: { [attribute_key]: v },
    }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/variants.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add systems/admin-ui/src/lib/variants.js systems/admin-ui/src/lib/variants.test.js
git commit -m "feat(admin-ui): bulk variant generation helper"
```

---

## Task 4: `lib/query.js` — filter/sort/paginate (TDD)

**Files:**
- Create: `systems/admin-ui/src/lib/query.js`, `src/lib/query.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest'
import { applyQuery } from './query.js'

const rows = [
  { id: 'a', name: 'Alpha', status: 'published', categories: ['x'], updated_at: '2026-01-03' },
  { id: 'b', name: 'Bravo', status: 'draft',     categories: ['y'], updated_at: '2026-01-02' },
  { id: 'c', name: 'Charlie', status: 'published', categories: ['x'], updated_at: '2026-01-01' },
]

describe('applyQuery', () => {
  it('returns all rows with envelope when no opts', () => {
    const r = applyQuery(rows, {})
    expect(r.total).toBe(3)
    expect(r.items).toHaveLength(3)
    expect(r.page).toBe(1)
  })
  it('filters by case-insensitive name search', () => {
    expect(applyQuery(rows, { search: 'brav' }).items.map(i => i.id)).toEqual(['b'])
  })
  it('filters by status and category', () => {
    expect(applyQuery(rows, { status: 'published' }).total).toBe(2)
    expect(applyQuery(rows, { category: 'y' }).items.map(i => i.id)).toEqual(['b'])
  })
  it('sorts by name_desc and updated_desc', () => {
    expect(applyQuery(rows, { sort: 'name_desc' }).items.map(i => i.id)).toEqual(['c', 'b', 'a'])
    expect(applyQuery(rows, { sort: 'updated_desc' }).items.map(i => i.id)).toEqual(['a', 'b', 'c'])
  })
  it('paginates and reports true total', () => {
    const r = applyQuery(rows, { page: 2, limit: 2, sort: 'name_asc' })
    expect(r.total).toBe(3)
    expect(r.items.map(i => i.id)).toEqual(['c'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/query.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/lib/query.js`**

```js
const SORTERS = {
  name_asc: (a, b) => a.name.localeCompare(b.name),
  name_desc: (a, b) => b.name.localeCompare(a.name),
  updated_desc: (a, b) => String(b.updated_at).localeCompare(String(a.updated_at)),
  updated_asc: (a, b) => String(a.updated_at).localeCompare(String(b.updated_at)),
}

export function applyQuery(items, opts = {}) {
  const { search = '', category = '', status = '', sort = 'name_asc', page = 1, limit = 20 } = opts
  let rows = [...items]
  if (search) {
    const q = search.toLowerCase()
    rows = rows.filter((r) => r.name.toLowerCase().includes(q))
  }
  if (status) rows = rows.filter((r) => r.status === status)
  if (category) rows = rows.filter((r) => (r.categories || []).includes(category))
  rows.sort(SORTERS[sort] || SORTERS.name_asc)
  const total = rows.length
  const start = (page - 1) * limit
  return { items: rows.slice(start, start + limit), total, page, limit }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/query.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add systems/admin-ui/src/lib/query.js systems/admin-ui/src/lib/query.test.js
git commit -m "feat(admin-ui): filter/sort/paginate query helper"
```

---

## Task 5: Data layer — `errors.js`, `seed.js`, `store.js` (TDD), `mockApi.js`

**Files:**
- Create: `src/data/errors.js`, `src/data/seed.js`, `src/data/store.js`, `src/data/store.test.js`, `src/data/mockApi.js`

- [ ] **Step 1: Create `src/data/errors.js`**

```js
export class AdminApiError extends Error {
  constructor(message, code = 'INTERNAL', fields = undefined) {
    super(message)
    this.name = 'AdminApiError'
    this.code = code
    if (fields) this.fields = fields
  }
}
```

- [ ] **Step 2: Create `src/data/seed.js`** (two seed products; deterministic IDs/dates)

```js
export function makeSeed() {
  return [
    {
      id: 'prod-001', name: 'Classic Brick Set', slug: 'classic-brick-set',
      description: 'A timeless 500-piece building set.', categories: ['sets', 'classic'],
      metadata: { brand: 'ImagiBricks', weight: '1.2kg' },
      status: 'published', published_at: '2026-05-20T12:00:00.000Z', archived_at: null,
      created_at: '2026-05-01T10:00:00.000Z', updated_at: '2026-05-20T12:00:00.000Z',
      created_by: 'admin-1', updated_by: 'admin-1',
      variants: [
        { id: 'var-001', product_id: 'prod-001', sku: 'CBS-STD', price: 49.99, inventory_item_id: null, attributes: {} },
      ],
      images: [
        { id: 'img-001', product_id: 'prod-001', url: 'https://placehold.co/600x400/7B5CFA/fff?text=Classic', alt_text: 'Classic Brick Set box', display_order: 0 },
      ],
    },
    {
      id: 'prod-002', name: 'Space Rover Kit', slug: 'space-rover-kit',
      description: '', categories: ['vehicles'],
      metadata: { brand: 'ImagiBricks' },
      status: 'draft', published_at: null, archived_at: null,
      created_at: '2026-05-28T09:00:00.000Z', updated_at: '2026-05-28T09:00:00.000Z',
      created_by: 'admin-1', updated_by: 'admin-1',
      variants: [],
      images: [],
    },
  ]
}
```

- [ ] **Step 3: Write the failing test** (`src/data/store.test.js`)

```js
import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from './store.js'

let store
beforeEach(() => { store = createStore() })

describe('store products', () => {
  it('seeds two products', () => {
    expect(store.listAll()).toHaveLength(2)
  })
  it('creates a product with generated id, slug, draft status, summary counts', () => {
    const p = store.create({ name: 'New Thing', description: 'd', categories: [], metadata: {} })
    expect(p.id).toMatch(/^prod-/)
    expect(p.slug).toBe('new-thing')
    expect(p.status).toBe('draft')
    expect(store.get(p.id).name).toBe('New Thing')
  })
  it('rejects create without a name (VALIDATION_ERROR)', () => {
    expect(() => store.create({ name: '' })).toThrowError(/name/i)
  })
  it('ensures unique slug on create', () => {
    const a = store.create({ name: 'Dup' })
    const b = store.create({ name: 'Dup' })
    expect(b.slug).toBe(`${a.slug}-2`)
  })
  it('updates fields and bumps updated_at', () => {
    const before = store.get('prod-002').updated_at
    const p = store.update('prod-002', { description: 'now has text' }, '2026-06-04T00:00:00.000Z')
    expect(p.description).toBe('now has text')
    expect(p.updated_at).not.toBe(before)
  })
  it('archive sets status archived and archived_at', () => {
    const p = store.setStatus('prod-001', 'archived', '2026-06-04T00:00:00.000Z')
    expect(p.status).toBe('archived')
    expect(p.archived_at).toBe('2026-06-04T00:00:00.000Z')
  })
  it('publish sets published_at', () => {
    const p = store.setStatus('prod-002', 'published', '2026-06-04T00:00:00.000Z')
    expect(p.status).toBe('published')
    expect(p.published_at).toBe('2026-06-04T00:00:00.000Z')
  })
})

describe('store variants', () => {
  it('adds a variant and rejects duplicate SKU', () => {
    const v = store.addVariant('prod-002', { sku: 'SR-A', price: 9.99, attributes: {} })
    expect(v.id).toMatch(/^var-/)
    expect(() => store.addVariant('prod-002', { sku: 'SR-A', price: 1 })).toThrowError(/sku/i)
  })
  it('deletes a variant', () => {
    store.addVariant('prod-002', { sku: 'SR-B', price: 1 })
    const v = store.addVariant('prod-002', { sku: 'SR-C', price: 1 })
    store.deleteVariant('prod-002', v.id)
    expect(store.get('prod-002').variants.some(x => x.id === v.id)).toBe(false)
  })
})

describe('store images', () => {
  it('adds image with incrementing display_order and reorders', () => {
    const i1 = store.addImage('prod-002', { url: 'u1', alt_text: 'a' })
    const i2 = store.addImage('prod-002', { url: 'u2', alt_text: 'b' })
    expect(i1.display_order).toBe(0)
    expect(i2.display_order).toBe(1)
    store.reorderImages('prod-002', [i2.id, i1.id])
    const imgs = store.get('prod-002').images
    expect(imgs.find(x => x.id === i2.id).display_order).toBe(0)
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run src/data/store.test.js`
Expected: FAIL — module not found.

- [ ] **Step 5: Write `src/data/store.js`**

```js
import { makeSeed } from './seed.js'
import { slugify, ensureUniqueSlug } from '../lib/slug.js'
import { AdminApiError } from './errors.js'

export function createStore() {
  let products = makeSeed()
  let seq = { prod: 100, var: 100, img: 100 }
  const nextId = (kind) => `${kind}-${String(++seq[kind]).padStart(3, '0')}`
  const now = () => new Date().toISOString() // overridable via explicit arg in mutators for tests

  const find = (id) => products.find((p) => p.id === id)
  const require = (id) => {
    const p = find(id)
    if (!p) throw new AdminApiError(`Product ${id} not found`, 'NOT_FOUND')
    return p
  }

  return {
    listAll: () => products.map((p) => ({ ...p })),
    get: (id) => {
      const p = require(id)
      return JSON.parse(JSON.stringify(p))
    },
    create: (input, ts) => {
      const name = (input?.name || '').trim()
      if (!name) throw new AdminApiError('Name is required', 'VALIDATION_ERROR', { name: 'required' })
      const base = slugify(input.slug || name)
      const slug = ensureUniqueSlug(base, products.map((p) => p.slug))
      const stamp = ts || now()
      const p = {
        id: nextId('prod'), name, slug,
        description: input.description || '', categories: input.categories || [],
        metadata: input.metadata || {}, status: 'draft',
        published_at: null, archived_at: null,
        created_at: stamp, updated_at: stamp, created_by: 'admin-1', updated_by: 'admin-1',
        variants: [], images: [],
      }
      products.push(p)
      return JSON.parse(JSON.stringify(p))
    },
    update: (id, patch, ts) => {
      const p = require(id)
      const allowed = ['name', 'description', 'categories', 'metadata', 'slug']
      for (const k of allowed) if (k in patch) p[k] = patch[k]
      p.updated_at = ts || now()
      p.updated_by = 'admin-1'
      return JSON.parse(JSON.stringify(p))
    },
    setStatus: (id, status, ts) => {
      const p = require(id)
      if (!['draft', 'published', 'archived'].includes(status))
        throw new AdminApiError('Invalid status', 'VALIDATION_ERROR')
      p.status = status
      const stamp = ts || now()
      if (status === 'published') p.published_at = stamp
      if (status === 'archived') p.archived_at = stamp
      p.updated_at = stamp
      return JSON.parse(JSON.stringify(p))
    },
    addVariant: (productId, input) => {
      const p = require(productId)
      const sku = (input?.sku || '').trim()
      if (!sku) throw new AdminApiError('SKU is required', 'VALIDATION_ERROR', { sku: 'required' })
      if (p.variants.some((v) => v.sku === sku))
        throw new AdminApiError(`SKU ${sku} already exists`, 'VALIDATION_ERROR', { sku: 'duplicate' })
      const v = { id: nextId('var'), product_id: productId, sku, price: Number(input.price) || 0,
        inventory_item_id: input.inventory_item_id || null, attributes: input.attributes || {} }
      p.variants.push(v)
      return { ...v }
    },
    updateVariant: (productId, variantId, patch) => {
      const p = require(productId)
      const v = p.variants.find((x) => x.id === variantId)
      if (!v) throw new AdminApiError('Variant not found', 'NOT_FOUND')
      if (patch.sku && patch.sku !== v.sku && p.variants.some((x) => x.sku === patch.sku))
        throw new AdminApiError(`SKU ${patch.sku} already exists`, 'VALIDATION_ERROR', { sku: 'duplicate' })
      Object.assign(v, { ...patch, price: patch.price != null ? Number(patch.price) : v.price })
      return { ...v }
    },
    deleteVariant: (productId, variantId) => {
      const p = require(productId)
      p.variants = p.variants.filter((v) => v.id !== variantId)
      return { success: true }
    },
    addImage: (productId, input) => {
      const p = require(productId)
      const img = { id: nextId('img'), product_id: productId, url: input.url,
        alt_text: input.alt_text || '', display_order: p.images.length }
      p.images.push(img)
      return { ...img }
    },
    reorderImages: (productId, orderedIds) => {
      const p = require(productId)
      const byId = new Map(p.images.map((i) => [i.id, i]))
      p.images = orderedIds.map((id, idx) => ({ ...byId.get(id), display_order: idx }))
      return { images: p.images.map((i) => ({ ...i })) }
    },
    updateImageAlt: (productId, imageId, alt_text) => {
      const p = require(productId)
      const img = p.images.find((i) => i.id === imageId)
      if (!img) throw new AdminApiError('Image not found', 'NOT_FOUND')
      img.alt_text = alt_text
      return { ...img }
    },
    deleteImage: (productId, imageId) => {
      const p = require(productId)
      p.images = p.images.filter((i) => i.id !== imageId)
      return { success: true }
    },
  }
}
```

> Note: tests pass an explicit `ts` to make `updated_at`/`published_at` deterministic; the live UI calls without `ts` and uses `now()`. This avoids relying on a fake clock.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/data/store.test.js`
Expected: PASS (all describe blocks green).

- [ ] **Step 7: Write `src/data/mockApi.js`** (the seam — wraps a single shared store instance, async, summary mapping)

```js
import { createStore } from './store.js'
import { applyQuery } from '../lib/query.js'
import { generateVariants } from '../lib/variants.js'

const store = createStore() // single in-session instance

const delay = (ms = 120) => new Promise((r) => setTimeout(r, ms))
const summarize = (p) => ({
  id: p.id, name: p.name, status: p.status, categories: p.categories,
  variant_count: p.variants.length, image_count: p.images.length, updated_at: p.updated_at,
})

export const mockApi = {
  async getOverviewStats() {
    await delay()
    const all = store.listAll()
    const summaries = all.map(summarize)
    return {
      totalProducts: all.length,
      published: all.filter((p) => p.status === 'published').length,
      draft: all.filter((p) => p.status === 'draft').length,
      archived: all.filter((p) => p.status === 'archived').length,
      recentlyModified: [...summaries].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 5),
      missingImages: summaries.filter((p) => p.image_count === 0 && p.status !== 'archived'),
      missingVariants: summaries.filter((p) => p.variant_count === 0 && p.status !== 'archived'),
    }
  },
  async listProducts(opts = {}) {
    await delay()
    return applyQuery(store.listAll().map(summarize), opts)
  },
  async getProduct(id) { await delay(); return store.get(id) },
  async createProduct(input) { await delay(); return store.create(input) },
  async updateProduct(id, patch) { await delay(); return store.update(id, patch) },
  async archiveProduct(id) { await delay(); return store.setStatus(id, 'archived') },
  async setProductStatus(id, status) { await delay(); return store.setStatus(id, status) },
  async bulkSetStatus(ids, status) {
    await delay()
    ids.forEach((id) => store.setStatus(id, status))
    return { updated: ids.length }
  },
  async createVariant(productId, input) { await delay(); return store.addVariant(productId, input) },
  async updateVariant(productId, variantId, patch) { await delay(); return store.updateVariant(productId, variantId, patch) },
  async deleteVariant(productId, variantId) { await delay(); return store.deleteVariant(productId, variantId) },
  async bulkCreateVariants(productId, template) {
    await delay()
    const created = generateVariants(template).map((v) => store.addVariant(productId, v))
    return { created }
  },
  async addImage(productId, input) { await delay(); return store.addImage(productId, input) },
  async reorderImages(productId, orderedIds) { await delay(); return store.reorderImages(productId, orderedIds) },
  async updateImageAlt(productId, imageId, alt_text) { await delay(); return store.updateImageAlt(productId, imageId, alt_text) },
  async deleteImage(productId, imageId) { await delay(); return store.deleteImage(productId, imageId) },
}

export default mockApi
```

- [ ] **Step 8: Commit**

```bash
git add systems/admin-ui/src/data
git commit -m "feat(admin-ui): in-session mock data layer (store + mockApi seam)"
```

---

## Task 6: Shared UI primitives + router shell

**Files:**
- Create: `src/ui/Button.jsx`, `Pill.jsx`, `Card.jsx`, `StatCard.jsx`, `ProgressBar.jsx`, `Modal.jsx`, `toast.jsx`, `ui.test.jsx`; `src/shell/ConsoleShell.jsx`, `src/shell/Nav.jsx`; rewrite `src/App.jsx`

- [ ] **Step 1: Create the primitives**

`src/ui/Button.jsx`:
```jsx
export default function Button({ variant = 'primary', className = '', ...props }) {
  const base = 'inline-flex items-center gap-2 rounded-pill px-4 py-2 text-sm font-semibold transition disabled:opacity-50'
  const variants = {
    primary: 'bg-ink text-white hover:bg-black',
    brand: 'bg-brand text-white hover:bg-brand-dark',
    ghost: 'bg-white text-ink shadow-card hover:bg-gray-50',
    danger: 'bg-accent text-white hover:opacity-90',
  }
  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />
}
```

`src/ui/Pill.jsx`:
```jsx
const TONES = {
  draft: 'bg-gray-100 text-gray-600',
  published: 'bg-brand-soft text-brand-dark',
  archived: 'bg-gray-200 text-gray-500',
  neutral: 'bg-gray-100 text-gray-700',
}
export default function Pill({ tone = 'neutral', children }) {
  return <span className={`inline-block rounded-pill px-2.5 py-0.5 text-xs font-semibold ${TONES[tone] || TONES.neutral}`}>{children}</span>
}
```

`src/ui/Card.jsx`:
```jsx
export default function Card({ className = '', children }) {
  return <div className={`rounded-card bg-white shadow-card p-5 ${className}`}>{children}</div>
}
```

`src/ui/StatCard.jsx`:
```jsx
import Card from './Card.jsx'
export default function StatCard({ label, value, hint }) {
  return (
    <Card>
      <p className="text-sm text-gray-500">{label}</p>
      <p className="mt-2 text-3xl font-bold">{value}</p>
      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
    </Card>
  )
}
```

`src/ui/ProgressBar.jsx`:
```jsx
export default function ProgressBar({ value = 0 }) {
  return (
    <div className="h-2 w-full rounded-pill bg-gray-100">
      <div className="h-2 rounded-pill bg-brand" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  )
}
```

`src/ui/Modal.jsx`:
```jsx
export default function Modal({ open, title, children, onClose, onConfirm, confirmLabel = 'Confirm', danger }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-card bg-white p-6 shadow-card">
        <h2 className="text-lg font-bold">{title}</h2>
        <div className="mt-3 text-sm text-gray-600">{children}</div>
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-pill px-4 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-100">Cancel</button>
          <button onClick={onConfirm} className={`rounded-pill px-4 py-2 text-sm font-semibold text-white ${danger ? 'bg-accent' : 'bg-ink'}`}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
```

`src/ui/toast.jsx`:
```jsx
import { createContext, useContext, useState, useCallback } from 'react'

const ToastCtx = createContext(null)
export function useToast() { return useContext(ToastCtx) }

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const push = useCallback((message, tone = 'success') => {
    const id = Math.random().toString(36).slice(2)
    setToasts((t) => [...t, { id, message, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2500)
  }, [])
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={`rounded-card px-4 py-2 text-sm text-white shadow-card ${t.tone === 'error' ? 'bg-accent' : 'bg-ink'}`}>{t.message}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}
```

- [ ] **Step 2: Create `src/shell/Nav.jsx`**

```jsx
import { NavLink } from 'react-router-dom'

const sections = [
  { to: '/', label: 'Overview', end: true },
  { to: '/products', label: 'Products' },
]

export default function Nav() {
  return (
    <nav className="flex items-center gap-1">
      {sections.map((s) => (
        <NavLink key={s.to} to={s.to} end={s.end}
          className={({ isActive }) =>
            `rounded-pill px-4 py-2 text-sm font-semibold ${isActive ? 'bg-ink text-white' : 'text-gray-600 hover:bg-white'}`}>
          {s.label}
        </NavLink>
      ))}
    </nav>
  )
}
```

- [ ] **Step 3: Create `src/shell/ConsoleShell.jsx`**

```jsx
import { Outlet } from 'react-router-dom'
import Nav from './Nav.jsx'

export default function ConsoleShell() {
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between px-8 py-4">
        <div className="flex items-center gap-6">
          <div className="flex h-9 w-9 items-center justify-center rounded-card bg-brand text-white font-bold">IB</div>
          <Nav />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">admin-1</span>
          <div className="h-9 w-9 rounded-pill bg-brand-soft" aria-label="admin avatar" />
        </div>
      </header>
      <main className="px-8 pb-12">
        <Outlet />
      </main>
    </div>
  )
}
```

- [ ] **Step 4: Rewrite `src/App.jsx` with routes**

```jsx
import { Routes, Route } from 'react-router-dom'
import { ToastProvider } from './ui/toast.jsx'
import ConsoleShell from './shell/ConsoleShell.jsx'
import CatalogOverview from './catalog/CatalogOverview.jsx'
import ProductList from './catalog/ProductList.jsx'
import ProductForm from './catalog/ProductForm.jsx'
import ProductDetail from './catalog/ProductDetail.jsx'

export default function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route element={<ConsoleShell />}>
          <Route index element={<CatalogOverview />} />
          <Route path="products" element={<ProductList />} />
          <Route path="products/new" element={<ProductForm />} />
          <Route path="products/:id" element={<ProductDetail />} />
        </Route>
      </Routes>
    </ToastProvider>
  )
}
```

> The four catalog pages are created in Tasks 7–10. To keep the app booting between tasks, create each catalog file as a one-line stub (`export default function X(){return null}`) first if executing strictly in order, then flesh out. Subagent-driven execution should build Task 7→10 before running the dev server.

- [ ] **Step 5: Write a smoke test** (`src/ui/ui.test.jsx`)

```jsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import Pill from './Pill.jsx'
import StatCard from './StatCard.jsx'

describe('ui primitives', () => {
  it('Pill renders children', () => {
    render(<Pill tone="published">Published</Pill>)
    expect(screen.getByText('Published')).toBeInTheDocument()
  })
  it('StatCard shows label and value', () => {
    render(<StatCard label="Total products" value={12} />)
    expect(screen.getByText('Total products')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
  })
})
```

- [ ] **Step 6: Run test**

Run: `npx vitest run src/ui/ui.test.jsx`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add systems/admin-ui/src/ui systems/admin-ui/src/shell systems/admin-ui/src/App.jsx
git commit -m "feat(admin-ui): shared UI primitives, console shell, routing"
```

---

## Task 7: Catalog Overview page

**Files:**
- Create: `src/catalog/CatalogOverview.jsx`

- [ ] **Step 1: Implement `src/catalog/CatalogOverview.jsx`**

```jsx
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import mockApi from '../data/mockApi.js'
import Card from '../ui/Card.jsx'
import StatCard from '../ui/StatCard.jsx'
import Pill from '../ui/Pill.jsx'
import Button from '../ui/Button.jsx'

export default function CatalogOverview() {
  const [stats, setStats] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    mockApi.getOverviewStats().then(setStats).catch((e) => setError(e.message))
  }, [])

  if (error) return <p className="text-accent">{error}</p>
  if (!stats) return <p className="text-gray-400">Loading…</p>

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold">Catalog</h1>
          <p className="text-gray-500">Manage your product catalog.</p>
        </div>
        <Link to="/products/new"><Button>+ New product</Button></Link>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total products" value={stats.totalProducts} />
        <StatCard label="Published" value={stats.published} />
        <StatCard label="Drafts" value={stats.draft} />
        <StatCard label="Archived" value={stats.archived} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <div className="flex items-center justify-between">
            <h2 className="font-bold">Recently modified</h2>
            <Link to="/products" className="text-sm text-brand-dark">See all</Link>
          </div>
          <ul className="mt-3 space-y-2">
            {stats.recentlyModified.map((p) => (
              <li key={p.id} className="flex items-center justify-between text-sm">
                <Link to={`/products/${p.id}`} className="hover:underline">{p.name}</Link>
                <Pill tone={p.status}>{p.status}</Pill>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <h2 className="font-bold">Missing images</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {stats.missingImages.length === 0 && <li className="text-gray-400">None 🎉</li>}
            {stats.missingImages.map((p) => (
              <li key={p.id}><Link to={`/products/${p.id}`} className="hover:underline">{p.name}</Link></li>
            ))}
          </ul>
        </Card>
        <Card>
          <h2 className="font-bold">Missing variants</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {stats.missingVariants.length === 0 && <li className="text-gray-400">None 🎉</li>}
            {stats.missingVariants.map((p) => (
              <li key={p.id}><Link to={`/products/${p.id}`} className="hover:underline">{p.name}</Link></li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify in browser**

Run: `npm run dev`, open `http://localhost:5174/`
Expected: four stat cards (2 total, 1 published, 1 draft, 0 archived) and three lists; "Space Rover Kit" appears under Missing images and Missing variants. Stop server.

- [ ] **Step 3: Commit**

```bash
git add systems/admin-ui/src/catalog/CatalogOverview.jsx
git commit -m "feat(admin-ui): catalog overview home page"
```

---

## Task 8: Product List page (with filters, sort, pagination, bulk publish)

**Files:**
- Create: `src/catalog/ProductList.jsx`

- [ ] **Step 1: Implement `src/catalog/ProductList.jsx`**

```jsx
import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import mockApi from '../data/mockApi.js'
import Card from '../ui/Card.jsx'
import Pill from '../ui/Pill.jsx'
import Button from '../ui/Button.jsx'
import { useToast } from '../ui/toast.jsx'

const PAGE_SIZE = 20

export default function ProductList() {
  const toast = useToast()
  const [data, setData] = useState({ items: [], total: 0 })
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [sort, setSort] = useState('name_asc')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState(new Set())

  const load = useCallback(() => {
    mockApi.listProducts({ search, status, sort, page, limit: PAGE_SIZE }).then(setData)
  }, [search, status, sort, page])

  useEffect(() => { load() }, [load])

  const toggle = (id) => setSelected((s) => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n
  })

  const bulkPublish = async (newStatus) => {
    await mockApi.bulkSetStatus([...selected], newStatus)
    toast.push(`${selected.size} product(s) ${newStatus}`)
    setSelected(new Set())
    load()
  }

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE))

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold">Products</h1>
          <p className="text-gray-500">{data.total} total</p>
        </div>
        <Link to="/products/new"><Button>+ New product</Button></Link>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          placeholder="Search by name…" className="rounded-pill border border-gray-200 px-4 py-2 text-sm" />
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}
          className="rounded-pill border border-gray-200 px-4 py-2 text-sm">
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)}
          className="rounded-pill border border-gray-200 px-4 py-2 text-sm">
          <option value="name_asc">Name A–Z</option>
          <option value="name_desc">Name Z–A</option>
          <option value="updated_desc">Recently modified</option>
        </select>
        {selected.size > 0 && (
          <div className="ml-auto flex gap-2">
            <Button variant="brand" onClick={() => bulkPublish('published')}>Publish ({selected.size})</Button>
            <Button variant="ghost" onClick={() => bulkPublish('draft')}>Unpublish</Button>
          </div>
        )}
      </div>

      <Card className="mt-4 p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th className="w-10 p-3"></th>
              <th className="p-3">Name</th>
              <th className="p-3">Variants</th>
              <th className="p-3">Status</th>
              <th className="p-3">Last modified</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((p) => (
              <tr key={p.id} className="border-t border-gray-100">
                <td className="p-3"><input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} /></td>
                <td className="p-3"><Link to={`/products/${p.id}`} className="font-semibold hover:underline">{p.name}</Link></td>
                <td className="p-3">{p.variant_count}</td>
                <td className="p-3"><Pill tone={p.status}>{p.status}</Pill></td>
                <td className="p-3 text-gray-500">{new Date(p.updated_at).toLocaleDateString()}</td>
              </tr>
            ))}
            {data.items.length === 0 && (
              <tr><td colSpan={5} className="p-8 text-center text-gray-400">No products match.</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      <div className="mt-4 flex items-center justify-end gap-2 text-sm">
        <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-pill px-3 py-1 disabled:opacity-40">Prev</button>
        <span>Page {page} / {totalPages}</span>
        <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded-pill px-3 py-1 disabled:opacity-40">Next</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify in browser**

Run: `npm run dev`, open `/products`. Expected: 2 rows; typing "space" filters to Space Rover Kit; status filter works; selecting a row reveals bulk Publish; publishing flips its status pill. Stop server.

- [ ] **Step 3: Commit**

```bash
git add systems/admin-ui/src/catalog/ProductList.jsx
git commit -m "feat(admin-ui): product list with filters, sort, pagination, bulk publish"
```

---

## Task 9: Product create form

**Files:**
- Create: `src/catalog/ProductForm.jsx`

- [ ] **Step 1: Implement `src/catalog/ProductForm.jsx`**

```jsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import mockApi from '../data/mockApi.js'
import { slugify } from '../lib/slug.js'
import Card from '../ui/Card.jsx'
import Button from '../ui/Button.jsx'
import { useToast } from '../ui/toast.jsx'

export default function ProductForm() {
  const nav = useNavigate()
  const toast = useToast()
  const [form, setForm] = useState({ name: '', description: '', categories: '', slug: '' })
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const previewSlug = form.slug || slugify(form.name)
  const valid = form.name.trim().length > 0

  const submit = async (e) => {
    e.preventDefault()
    if (!valid) { setErrors({ name: 'Name is required' }); return }
    setSaving(true)
    try {
      const p = await mockApi.createProduct({
        name: form.name.trim(),
        description: form.description,
        slug: form.slug || undefined,
        categories: form.categories.split(',').map((c) => c.trim()).filter(Boolean),
        metadata: {},
      })
      toast.push('Product created')
      nav(`/products/${p.id}`)
    } catch (err) {
      setErrors(err.fields || { name: err.message })
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-3xl font-bold">New product</h1>
      <Card className="mt-4">
        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="text-sm font-semibold">Name</span>
            <input value={form.name} onChange={(e) => set('name', e.target.value)}
              className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2" />
            {errors.name && <span className="text-xs text-accent">{errors.name}</span>}
            {previewSlug && <span className="mt-1 block text-xs text-gray-400">slug: {previewSlug}</span>}
          </label>
          <label className="block">
            <span className="text-sm font-semibold">Description</span>
            <textarea value={form.description} onChange={(e) => set('description', e.target.value)}
              rows={4} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2" />
          </label>
          <label className="block">
            <span className="text-sm font-semibold">Categories <span className="text-gray-400">(comma-separated)</span></span>
            <input value={form.categories} onChange={(e) => set('categories', e.target.value)}
              className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2" />
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={!valid || saving}>{saving ? 'Creating…' : 'Create product'}</Button>
            <Button type="button" variant="ghost" onClick={() => nav('/products')}>Cancel</Button>
          </div>
        </form>
      </Card>
    </div>
  )
}
```

- [ ] **Step 2: Verify in browser**

Run: `npm run dev`, open `/products/new`. Expected: slug preview updates live; submit disabled until a name is typed; creating navigates to the new product's detail page; it then appears in `/products`. Stop server.

- [ ] **Step 3: Commit**

```bash
git add systems/admin-ui/src/catalog/ProductForm.jsx
git commit -m "feat(admin-ui): create-product form with live slug + validation"
```

---

## Task 10: Product Detail with tabs (Info, Variants, Images, Publish)

**Files:**
- Create: `src/catalog/ProductDetail.jsx`, `src/catalog/useAutoSave.js`, `src/catalog/tabs/InfoTab.jsx`, `VariantsTab.jsx`, `BulkVariantForm.jsx`, `ImagesTab.jsx`, `PublishTab.jsx`, `src/catalog/catalog.test.jsx`

- [ ] **Step 1: Create `src/catalog/useAutoSave.js`** (debounced save hook)

```js
import { useRef, useState, useCallback } from 'react'

// Returns [status, trigger]. trigger(fn) debounces fn by `delay` ms and tracks
// 'idle' | 'saving' | 'saved' status for an inline indicator.
export function useAutoSave(delay = 1000) {
  const [status, setStatus] = useState('idle')
  const timer = useRef(null)
  const trigger = useCallback((saveFn) => {
    setStatus('saving')
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      await saveFn()
      setStatus('saved')
      setTimeout(() => setStatus('idle'), 1500)
    }, delay)
  }, [delay])
  return [status, trigger]
}
```

- [ ] **Step 2: Create `src/catalog/tabs/InfoTab.jsx`**

```jsx
import { useState } from 'react'
import mockApi from '../../data/mockApi.js'
import { useAutoSave } from '../useAutoSave.js'

export default function InfoTab({ product, onUpdated }) {
  const [form, setForm] = useState({
    name: product.name, description: product.description,
    categories: (product.categories || []).join(', '),
  })
  const [status, trigger] = useAutoSave()

  const set = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }))
    trigger(async () => {
      const patch = k === 'categories'
        ? { categories: v.split(',').map((c) => c.trim()).filter(Boolean) }
        : { [k]: v }
      const updated = await mockApi.updateProduct(product.id, patch)
      onUpdated(updated)
    })
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-400 h-4">{status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved ✓' : ''}</p>
      <label className="block">
        <span className="text-sm font-semibold">Name</span>
        <input value={form.name} onChange={(e) => set('name', e.target.value)}
          className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2" />
      </label>
      <label className="block">
        <span className="text-sm font-semibold">Description</span>
        <textarea value={form.description} onChange={(e) => set('description', e.target.value)} rows={4}
          className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2" />
      </label>
      <label className="block">
        <span className="text-sm font-semibold">Categories</span>
        <input value={form.categories} onChange={(e) => set('categories', e.target.value)}
          className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2" />
      </label>
    </div>
  )
}
```

- [ ] **Step 3: Create `src/catalog/tabs/BulkVariantForm.jsx`**

```jsx
import { useState } from 'react'
import { generateVariants } from '../../lib/variants.js'
import Button from '../../ui/Button.jsx'

export default function BulkVariantForm({ onCreate }) {
  const [tpl, setTpl] = useState({ sku_prefix: '', price: '', attribute_key: 'size', values: '' })
  const set = (k, v) => setTpl((t) => ({ ...t, [k]: v }))
  const preview = generateVariants({ ...tpl, price: Number(tpl.price) || 0, values: tpl.values.split(',') })

  return (
    <div className="rounded-xl border border-dashed border-gray-300 p-4">
      <h4 className="font-semibold">Bulk create variants</h4>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <input placeholder="SKU prefix" value={tpl.sku_prefix} onChange={(e) => set('sku_prefix', e.target.value)} className="rounded-lg border border-gray-200 px-2 py-1 text-sm" />
        <input placeholder="Price" type="number" value={tpl.price} onChange={(e) => set('price', e.target.value)} className="rounded-lg border border-gray-200 px-2 py-1 text-sm" />
        <input placeholder="Attribute (e.g. size)" value={tpl.attribute_key} onChange={(e) => set('attribute_key', e.target.value)} className="rounded-lg border border-gray-200 px-2 py-1 text-sm" />
        <input placeholder="Values: S,M,L" value={tpl.values} onChange={(e) => set('values', e.target.value)} className="rounded-lg border border-gray-200 px-2 py-1 text-sm" />
      </div>
      {preview.length > 0 && (
        <p className="mt-2 text-xs text-gray-500">Will create: {preview.map((v) => v.sku).join(', ')}</p>
      )}
      <Button variant="brand" className="mt-3" disabled={preview.length === 0}
        onClick={() => onCreate({ ...tpl, price: Number(tpl.price) || 0, values: tpl.values.split(',') })}>
        Create {preview.length} variant(s)
      </Button>
    </div>
  )
}
```

- [ ] **Step 4: Create `src/catalog/tabs/VariantsTab.jsx`**

```jsx
import { useState } from 'react'
import mockApi from '../../data/mockApi.js'
import Button from '../../ui/Button.jsx'
import { useToast } from '../../ui/toast.jsx'
import BulkVariantForm from './BulkVariantForm.jsx'

export default function VariantsTab({ product, onUpdated }) {
  const toast = useToast()
  const [draft, setDraft] = useState({ sku: '', price: '' })
  const [error, setError] = useState(null)

  const refresh = async () => onUpdated(await mockApi.getProduct(product.id))

  const add = async () => {
    setError(null)
    try {
      await mockApi.createVariant(product.id, { sku: draft.sku.trim(), price: Number(draft.price) || 0, attributes: {} })
      setDraft({ sku: '', price: '' })
      toast.push('Variant added')
      refresh()
    } catch (e) { setError(e.message) }
  }
  const remove = async (vid) => { await mockApi.deleteVariant(product.id, vid); toast.push('Variant removed'); refresh() }
  const bulk = async (tpl) => { await mockApi.bulkCreateVariants(product.id, tpl); toast.push('Variants created'); refresh() }

  return (
    <div className="space-y-4">
      <table className="w-full text-sm">
        <thead className="text-left text-gray-500"><tr><th className="py-2">SKU</th><th>Price</th><th>Attributes</th><th></th></tr></thead>
        <tbody>
          {product.variants.map((v) => (
            <tr key={v.id} className="border-t border-gray-100">
              <td className="py-2 font-mono">{v.sku}</td>
              <td>${v.price.toFixed(2)}</td>
              <td className="text-gray-500">{Object.entries(v.attributes || {}).map(([k, val]) => `${k}:${val}`).join(', ') || '—'}</td>
              <td className="text-right"><button onClick={() => remove(v.id)} className="text-accent text-xs">Delete</button></td>
            </tr>
          ))}
          {product.variants.length === 0 && <tr><td colSpan={4} className="py-4 text-gray-400">No variants yet.</td></tr>}
        </tbody>
      </table>

      <div className="flex items-end gap-2">
        <input placeholder="SKU" value={draft.sku} onChange={(e) => setDraft((d) => ({ ...d, sku: e.target.value }))} className="rounded-lg border border-gray-200 px-2 py-1 text-sm" />
        <input placeholder="Price" type="number" value={draft.price} onChange={(e) => setDraft((d) => ({ ...d, price: e.target.value }))} className="rounded-lg border border-gray-200 px-2 py-1 text-sm" />
        <Button onClick={add} disabled={!draft.sku.trim()}>Add variant</Button>
        {error && <span className="text-xs text-accent">{error}</span>}
      </div>

      <BulkVariantForm onCreate={bulk} />
    </div>
  )
}
```

- [ ] **Step 5: Create `src/catalog/tabs/ImagesTab.jsx`** (mock upload via object URLs; reorder via up/down buttons)

```jsx
import mockApi from '../../data/mockApi.js'
import Button from '../../ui/Button.jsx'

export default function ImagesTab({ product, onUpdated }) {
  const refresh = async () => onUpdated(await mockApi.getProduct(product.id))

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file) // Phase A mock upload
    await mockApi.addImage(product.id, { url, alt_text: file.name })
    refresh()
  }
  const move = async (idx, dir) => {
    const ids = product.images.map((i) => i.id)
    const j = idx + dir
    if (j < 0 || j >= ids.length) return
    ;[ids[idx], ids[j]] = [ids[j], ids[idx]]
    await mockApi.reorderImages(product.id, ids)
    refresh()
  }
  const setAlt = async (id, alt) => { await mockApi.updateImageAlt(product.id, id, alt); refresh() }
  const del = async (id) => { await mockApi.deleteImage(product.id, id); refresh() }

  return (
    <div className="space-y-4">
      <label className="inline-block cursor-pointer rounded-pill bg-ink px-4 py-2 text-sm font-semibold text-white">
        Upload image
        <input type="file" accept="image/*" className="hidden" onChange={onFile} />
      </label>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {product.images.map((img, idx) => (
          <div key={img.id} className="rounded-card bg-white p-2 shadow-card">
            <img src={img.url} alt={img.alt_text} className="h-32 w-full rounded-lg object-cover" />
            <input value={img.alt_text} onChange={(e) => setAlt(img.id, e.target.value)}
              placeholder="alt text" className="mt-2 w-full rounded-lg border border-gray-200 px-2 py-1 text-xs" />
            <div className="mt-2 flex justify-between text-xs">
              <span>
                <button onClick={() => move(idx, -1)} className="px-1">↑</button>
                <button onClick={() => move(idx, 1)} className="px-1">↓</button>
              </span>
              <button onClick={() => del(img.id)} className="text-accent">Delete</button>
            </div>
          </div>
        ))}
        {product.images.length === 0 && <p className="text-gray-400">No images yet.</p>}
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Create `src/catalog/tabs/PublishTab.jsx`**

```jsx
import mockApi from '../../data/mockApi.js'
import Pill from '../../ui/Pill.jsx'
import Button from '../../ui/Button.jsx'
import { useToast } from '../../ui/toast.jsx'

export default function PublishTab({ product, onUpdated }) {
  const toast = useToast()
  const warnings = []
  if (product.variants.length === 0) warnings.push('No variants')
  if (product.images.length === 0) warnings.push('No images')
  if (!product.description) warnings.push('No description')

  const setStatus = async (status) => {
    const updated = await mockApi.setProductStatus(product.id, status)
    onUpdated(updated)
    toast.push(`Status: ${status}`)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="text-sm font-semibold">Current status:</span>
        <Pill tone={product.status}>{product.status}</Pill>
      </div>
      {warnings.length > 0 && (
        <div className="rounded-xl bg-accent-soft px-4 py-3 text-sm text-accent">
          Warnings (publish still allowed): {warnings.join(', ')}.
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="brand" onClick={() => setStatus('published')} disabled={product.status === 'published'}>Publish</Button>
        <Button variant="ghost" onClick={() => setStatus('draft')} disabled={product.status === 'draft'}>Set to draft</Button>
        <Button variant="danger" onClick={() => setStatus('archived')} disabled={product.status === 'archived'}>Archive</Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 7: Create `src/catalog/ProductDetail.jsx`** (loads product, owns tab state, passes `onUpdated`)

```jsx
import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import mockApi from '../data/mockApi.js'
import Card from '../ui/Card.jsx'
import Pill from '../ui/Pill.jsx'
import InfoTab from './tabs/InfoTab.jsx'
import VariantsTab from './tabs/VariantsTab.jsx'
import ImagesTab from './tabs/ImagesTab.jsx'
import PublishTab from './tabs/PublishTab.jsx'

const TABS = ['Info', 'Variants', 'Images', 'Publish']

export default function ProductDetail() {
  const { id } = useParams()
  const [product, setProduct] = useState(null)
  const [tab, setTab] = useState('Info')
  const [error, setError] = useState(null)

  useEffect(() => {
    mockApi.getProduct(id).then(setProduct).catch((e) => setError(e.message))
  }, [id])

  if (error) return <p className="text-accent">{error}</p>
  if (!product) return <p className="text-gray-400">Loading…</p>

  return (
    <div className="max-w-3xl">
      <Link to="/products" className="text-sm text-gray-500">← Products</Link>
      <div className="mt-2 flex items-center gap-3">
        <h1 className="text-3xl font-bold">{product.name}</h1>
        <Pill tone={product.status}>{product.status}</Pill>
      </div>

      <div className="mt-4 flex gap-1">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded-pill px-4 py-2 text-sm font-semibold ${tab === t ? 'bg-ink text-white' : 'text-gray-600 hover:bg-white'}`}>
            {t}
          </button>
        ))}
      </div>

      <Card className="mt-4">
        {tab === 'Info' && <InfoTab product={product} onUpdated={setProduct} />}
        {tab === 'Variants' && <VariantsTab product={product} onUpdated={setProduct} />}
        {tab === 'Images' && <ImagesTab product={product} onUpdated={setProduct} />}
        {tab === 'Publish' && <PublishTab product={product} onUpdated={setProduct} />}
      </Card>
    </div>
  )
}
```

- [ ] **Step 8: Write an integration test** (`src/catalog/catalog.test.jsx`)

```jsx
import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ToastProvider } from '../ui/toast.jsx'
import ProductDetail from './ProductDetail.jsx'

function renderDetail(id) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[`/products/${id}`]}>
        <Routes><Route path="/products/:id" element={<ProductDetail />} /></Routes>
      </MemoryRouter>
    </ToastProvider>,
  )
}

describe('ProductDetail', () => {
  it('loads a product and shows tabs', async () => {
    renderDetail('prod-001')
    expect(await screen.findByText('Classic Brick Set')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Variants' })).toBeInTheDocument()
  })

  it('adds a variant through the Variants tab', async () => {
    const user = userEvent.setup()
    renderDetail('prod-002') // starts with 0 variants
    await screen.findByText('Space Rover Kit')
    await user.click(screen.getByRole('button', { name: 'Variants' }))
    await user.type(screen.getByPlaceholderText('SKU'), 'SR-NEW')
    await user.type(screen.getByPlaceholderText('Price'), '12.50')
    await user.click(screen.getByRole('button', { name: 'Add variant' }))
    await waitFor(() => expect(screen.getByText('SR-NEW')).toBeInTheDocument())
  })
})
```

- [ ] **Step 9: Run the test**

Run: `npx vitest run src/catalog/catalog.test.jsx`
Expected: PASS (2 tests).

- [ ] **Step 10: Verify full flow in browser**

Run: `npm run dev`. Walk the loop: create a product → open it → Info auto-saves → add a variant + bulk-create S/M/L → upload an image and reorder → Publish (see the warnings clear as you add data) → return to `/products` and confirm the new status. Stop server.

- [ ] **Step 11: Commit**

```bash
git add systems/admin-ui/src/catalog
git commit -m "feat(admin-ui): product detail with Info/Variants/Images/Publish tabs"
```

---

## Task 11: README, full test run, and final validation

**Files:**
- Create: `systems/admin-ui/README.md`

- [ ] **Step 1: Write `systems/admin-ui/README.md`**

```markdown
# ImagiBricks Admin Console (admin-ui)

Internal staff admin console. **Separate from the storefront** (different package, different domain — never co-bundled). Catalog management is module 1.

## Phase A (current): model pages, no backend
All data is in-memory and resets on reload (`src/data/mockApi.js`). Use this to validate the catalog-management flow.

## Run
```
npm install
npm run dev      # http://localhost:5174
npm test         # unit + integration tests (vitest)
```

## Phase B (next)
Replace `src/data/mockApi.js` with `src/data/adminApi.js` (axios → catalog-admin `/api/admin`). The function surface is identical, so pages are untouched. See `docs/superpowers/specs/2026-06-04-catalog-admin-ui-design.md`.
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test` (in `systems/admin-ui/`)
Expected: all suites pass (slug, variants, query, store, ui, catalog).

- [ ] **Step 3: Run a production build to catch import/JSX errors**

Run: `npm run build`
Expected: build completes, writes `dist/` with no errors.

- [ ] **Step 4: Commit**

```bash
git add systems/admin-ui/README.md
git commit -m "docs(admin-ui): README + Phase A validation"
```

---

## Acceptance criteria (Phase A)

- `npm run dev` serves the console on :5174; nav switches between Overview and Products.
- Overview shows live catalog counts and attention lists.
- Product list filters by name/status, sorts, paginates, and bulk publish/unpublish updates statuses.
- Create form validates name, previews slug, and lands on the new product.
- Product detail Info auto-saves; Variants add/delete + bulk-create; Images upload (mock)/reorder/alt/delete; Publish flips status with non-blocking warnings.
- All mutations persist in-session (reflected across pages until reload).
- `npm test` green; `npm run build` clean.

## Phase B handoff (not in this plan)
A separate plan will: build the catalog-admin Express backend + migrations per SPEC §3.2–3.3, add `src/data/adminApi.js` with the identical surface to `mockApi`, switch the import, and verify published products surface on the storefront via catalog-service.
```
