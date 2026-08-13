# AlpineBrick Storefront

Customer-facing React application for the Alpine Brick Exchange platform.

## Tech stack

- **React 18** + **TypeScript** (strict)
- **Vite 6** for dev server and build
- **React Router v7** — data routers, with catalog data fetched in route loaders
- **Tailwind CSS v4** — configured **in CSS**, not `tailwind.config.js`
- **Vitest** + **@testing-library/react** (jsdom)
- **lucide-react** for icons

## Architecture

The storefront talks to exactly one backend: **`systems/core`**.

```
┌────────────────────┐
│ Vite dev server    │  :5173
│ React app          │
└─────────┬──────────┘
          │  /api/v1/catalog/*   (proxied by vite.config.ts)
          ▼
┌────────────────────┐
│ systems/core       │  :4000
│ Express + Prisma   │
└─────────┬──────────┘
          ▼
     PostgreSQL  :5433
```

There is **no Express proxy in this app**, and it does **not** talk to
`catalog-service`, `order-service`, `inventory-service` or `affiliate-service`.
Those are pre-redesign in-memory mocks; an earlier version of this storefront
was wired to them and could not work against core.

`src/lib/api/` is the only place that knows core's wire format. Pages consume
typed domain objects and never call `fetch` directly.

## Running it

Core must be running first — the storefront is useless without it.

```bash
# 1. Postgres (from the repo root)
docker start alpinebrick-core-db

# 2. Core API on :4000
cd systems/core
npm run seed          # optional, but the catalog is empty without it
npm run dev

# 3. Storefront on :5173
cd systems/storefront/code
npm run dev
```

Open http://localhost:5173.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on :5173, proxying `/api` to core on :4000 |
| `npm run build` | Typecheck (`tsc -b`) then production build to `dist/` |
| `npm run preview` | Serve the built `dist/` locally |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest, single run |

## Layout

```
src/
  main.tsx                  entry point
  routes.tsx                route table
  app/
    Root.tsx                shell: nav, footer, skip link, cart provider
    Logo.tsx
  design-system/
    tokens.css              the design tokens, verbatim from the handoff
    primitives/             Button, Input, Badge, Card, Eyebrow, Accordion, Tabs
  lib/
    api/                    typed core client — the ONLY place that knows the wire format
    cart/                   in-memory cart context
    collections.ts          collection slug -> core query registry
    money.ts                integer cents -> display string
    badge.ts                Limited / New derivation
  components/               ProductCard, ProductGrid, PageHeader
  pages/                    route components
  test/setup.ts             Vitest setup
public/img/placeholder/     neutral placeholder product images
```

## Things that will bite you

- **Tailwind v4 has no `tailwind.config.js`.** Theme mapping lives in
  `src/styles/globals.css` under `@theme inline`. Older storefront docs that
  reference a JS config are stale.
- **`tsconfig.json` includes only `src`.** This app is an npm workspace member,
  so Vite is installed both hoisted at the engineering root and locally.
  Typechecking `vite.config.ts` compares two structurally incompatible `Plugin`
  types and fails. The configs are executed by the bundler, not typechecked.
- **Core listens on 4000, not 3000.** The dev proxy targets 4000.
- **Money is always integer cents.** `priceCents`, never a float dollar amount.
  `formatCents()` in `src/lib/money.ts` is the single conversion point.
- **The cart keys on variant id, not product id.** Two variants of one product
  are two cart lines at two prices, and core's order API takes `variantId`.
- **The server owns display order.** Products arrive already ordered
  (`home_display` / `collection_display`); components must not re-sort them, or
  page 2 gets sorted independently of page 1.
- **Never render `--muted-foreground` below 12px.** It is roughly 5.5:1 and
  fails contrast under that size. `text-xs` is the floor.
- **Product photography is placeholder.** `public/img/placeholder/` holds
  deliberately neutral SVGs. Real photography is the largest open gap.

## Not built yet

Cart persistence, checkout (shipping, payment, confirmation), promo codes,
order tracking, the contact form backend, and product reviews. Each is a later
sub-project with its own spec.
