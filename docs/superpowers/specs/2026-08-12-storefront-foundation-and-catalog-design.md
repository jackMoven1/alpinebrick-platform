# Storefront Foundation and Catalog — Design

**Status:** DRAFT — awaiting Jack's review.
**Date:** 2026-08-12.
**Owners:** Storefront Engineer (primary), Catalog Engineer (core changes),
Engineering Lead (approver).
**Input:** the Figma design handoff package, `Alpine brick ecommerce website.zip`,
supplied by Jack 2026-08-12.

---

## 1. Why this document exists

Jack supplied a design handoff covering **19 screens across 16 routes** for the
Alpine Brick Exchange storefront. The handoff is a design package, not a
codebase: a runnable React reference app (`figma-src/`), a single-file
prototype, a token block, and a written spec.

The platform cannot back most of it today. Of the 19 screens, roughly **three**
have real data behind them. The rest are either static content or blocked on
backend work that has not been designed.

This document therefore covers **two of the three sub-projects** the handoff
implies:

| | Sub-project | This spec |
|---|---|---|
| **A** | Storefront foundation — shell, design system, 11 static content pages | **In scope** |
| **B** | Catalog — home grid, product detail, collections | **In scope** |
| **C** | Cart persistence, checkout, payments, shipping, promo | **Deferred** |
| **D** | Order tracking, contact-form backend | **Deferred** |

Sub-projects C and D each get their own spec. C is much larger than A and B
combined and depends on decisions — payment provider, shipping rates, promo
engine — that are not made. D depends on a carrier integration and a ticketing
or email backend, neither of which exists.

## 2. Scope

### 2.1 In scope

- The storefront application shell: navigation, footer, routing, design tokens,
  and a small set of shared primitives.
- **11 static content pages** with no backend dependency: About, Designers,
  Careers, Press, Community, the Support hub, FAQ, Shipping info, Returns.
- **The catalog surface**: home page with filterable grid, product detail page,
  collections index, collection detail.
- **The core API work** required to back the catalog surface.
- A cart held in client memory, sufficient to drive the nav badge and a cart
  review screen.

### 2.2 Out of scope, and where it goes

| Deferred | Why | Goes to |
|---|---|---|
| Checkout steps 2–4 (shipping, payment, confirmation) | No payment provider, no shipping rates | Sub-project C |
| Cart persistence across sessions | Needs a session or account model | Sub-project C |
| Promo codes | No promo engine; see §3.5 on the discount trap | Sub-project C |
| Order tracking by number | Needs carrier integration | Sub-project D |
| Contact form submission | Needs a ticketing or email backend | Sub-project D |
| Product reviews and ratings | See §6.3 | Unscheduled |

### 2.3 The standing assumption about "live"

**Nothing built here is deployed to customers.** `alpinebrickexchange.com`
resolves to the live Shopify store and continues to until the Phase 5 cutover.
This build targets local and staging environments only.

This matters because it makes an incomplete checkout a normal mid-build state
rather than a customer-facing defect. It is recorded explicitly so that nobody
later reads "the storefront is built" as "the storefront is live." **If the
cutover schedule changes, §2.2 becomes a launch blocker list.**

---

## 3. Decisions taken, and the conflicts they resolve

### 3.1 Core is the source of truth for the catalog API; ADR-0001 is amended

**Ruled by Jack, 2026-08-12.**

ADR-0001 is ACCEPTED and signed off by both engineer roles. It states that the
storefront never reaches around the API, and that neither engineer ships
features depending on the contract until it is signed off. But `systems/core` —
the backend of record, merged, 36 tests green — **implements a different API
than the one the contract describes**:

| | ADR-0001 / `catalog.yaml` | `core` as built |
|---|---|---|
| Page-size parameter | `limit`, default 24 | `pageSize`, default 20 |
| Field naming | `snake_case` | `camelCase` |
| Money | `price`, float | `priceCents`, integer |
| `category` filter | specified | absent |
| `sort` enum (4 frozen values) | specified | absent |
| `published` filter | specified | absent; hardcoded to published |
| `images` as `{url, alt}` | specified | column exists, dropped by `toDto` |
| Error envelope | `{code, message, fields?}` | `{error: 'not_found'}` |
| Availability shape | `{product_id, available, variants[]}` | bare array |

Neither side was built carelessly. The existing storefront's
`catalogService.js` was written **faithfully to the contract**, which is
precisely why it does not work against core.

**Resolution: core wins on shape; the contract wins on features.**

- Keep core's `camelCase`, `pageSize`, and **integer cents**.
- Add the contract's genuinely valuable features to core: the `category` filter,
  the frozen `sort` enum, `images` with `alt` text, and the structured error
  envelope.
- Rewrite `contracts/openapi/catalog.yaml` to describe what core actually does.
- Record the change as an amendment to ADR-0001.

**Integer cents is non-negotiable regardless of the rest.** The contract types
price as `number, format: float`. Floating-point dollars accumulate
representation error, and this repo's money convention forbids estimated
figures. Every price in this system is an integer count of cents.

**Why core rather than the contract:** core is running, tested, and merged. The
contract's only consumer is a storefront being replaced in this same spec, so
conforming core to the contract would churn tested code to satisfy a document
with no other reader.

### 3.2 The Sprint-1 storefront is replaced

**Ruled by Jack, 2026-08-12.**

`systems/storefront/code` currently holds a Sprint-1 skeleton: three JSX
components, an Express proxy, one 240-byte test, roughly 18KB total. It has no
router, no design system, and points at `catalog-service:4001` — one of the
in-memory mocks `CLAUDE.md` warns "look real."

It is replaced by a TypeScript application in the same directory. Git history
preserves what is removed.

**One thing is ported forward rather than rewritten:** the error-normalisation
pattern in `catalogService.js` — `toCatalogError`, mapping API failures onto
stable `NOT_FOUND` / `VALIDATION_ERROR` / `INTERNAL` codes the UI can branch on,
including synthesising `INTERNAL` for network and timeout failures. That design
is sound; it is retargeted at core.

The handoff advises against forking `figma-src/` as the production app "unless
the platform has no frontend yet." The platform's frontend is a catalog
skeleton wired to a mock backend, not a foundation 19 screens can sit on. The
reference app's structure is used as the starting point; its placeholder data
layer is not.

### 3.3 Design-only product fields become typed columns

**Ruled by Jack, 2026-08-12.**

The design's `Product` interface carries 18 fields. Six already have a home in
core — `id`, `name`, `description`, `category` (via `categories`), `images`, and
`price` (via `variants[].priceCents`). The remaining **twelve** are accounted for
as follows:

| Disposition | Count | Fields |
|---|---|---|
| New typed columns | 8 | `pieces`, `difficulty`, `ageRecommendation`, `dimensions`, `longDescription`, `features`, `includes`, `builderNotes` |
| Derived, not stored | 2 | `badge`, `setNumber` |
| Cut — see §6.4 | 2 | `rating`, `reviewCount` |

The eight become **typed columns rather than a JSON blob**, so they are
validated and queryable rather than failing silently at render time.

The two derived fields:

- **`badge`** — from existing data. `releaseType: limited_run` yields "Limited";
  a recent `createdAt` yields "New". Storing a badge would duplicate state that
  already exists and can drift from it.
- **`setNumber`** — the variant SKU, which already serves this purpose.

### 3.4 Merchandised display order, with two independent orderings

**Requested by Jack, 2026-08-12.**

The storefront must receive products **already in the order they should be
displayed**, rather than sorting them itself. Merchandising sequence is a
business decision, and a client that re-sorts what the server sent will
disagree with it the moment pagination is involved — page 2 would be sorted
independently of page 1.

**There are two independent orderings**, because a product's place on the home
page is not its place inside a collection:

| Column | Governs |
|---|---|
| `homePosition` | Order of products on the home page |
| `collectionPosition` | Order of products within a collection |

Both are **nullable integers, ascending, with unranked products last**
(`NULLS LAST`) and **ties broken by name**. Nullable rather than defaulted to
zero: a newly created product is unmerchandised, and defaulting to `0` would
silently promote it to the top of the home page. Sorting last is the safe
default. The name tiebreak means two products sharing a position never return
in arbitrary order, which would make pagination unstable.

They surface as two new values on the sort enum — `home_display` and
`collection_display` — taking it from four values to six. The home loader
requests `home_display`; collection loaders request `collection_display`.
Neither becomes the API-wide default: `name_asc` remains the default so a caller
that expresses no preference gets a stable, meaningful order rather than one
that depends on merchandising data that may not be set.

**Known limitation, accepted deliberately.** `categories` is an array, so a
product can belong to several collections while carrying only one
`collectionPosition`. It therefore holds the same rank in every collection it
appears in. Ranking a product differently per collection requires a
`(productId, collectionSlug, position)` join table. That is not built, because
nothing yet needs it — but the constraint should be understood before someone
discovers it by surprise.

### 3.5 Discounts are not written in this build

No screen in scope creates a discount. `Order.discountCents` and
`OrderLine.discountCents` exist on `main` and stay at their `0` default.

This is called out because of a known trap: **when a discount is eventually
written, the royalty basis and the tax base both depend on it.** The columns
were nearly missed once already. Sub-project C must treat the first non-zero
discount as the moment two open questions come due — the Michigan discount tax
base, and third-party-funded discounts, both still undecided in the business
repo's handoff.

---

## 4. Core changes

### 4.1 Migration: `add_product_details`

A new enum and eight columns on `products`. All are nullable or defaulted, so
the migration is additive and safe against existing rows.

```prisma
enum Difficulty {
  beginner
  intermediate
  advanced
  expert
}

model Product {
  // ... existing fields unchanged ...
  pieces             Int?        @map("pieces")
  difficulty         Difficulty?
  ageRecommendation  String?     @map("age_recommendation")
  dimensions         String?
  longDescription    String      @default("") @map("long_description")
  features           Json        @default("[]")
  includes           Json        @default("[]")
  builderNotes       String      @default("") @map("builder_notes")
  homePosition       Int?        @map("home_position")
  collectionPosition Int?        @map("collection_position")

  @@index([homePosition])
  @@index([collectionPosition])
}
```

The two position columns carry the merchandised display order described in
§3.4. They are indexed because every home-page and collection-page query orders
by one of them.

`features` and `includes` are ordered arrays of display strings. They are JSON
because they are variable-length editorial lists with no query requirement —
unlike the scalar fields above them, which are typed so they can be filtered on
later without a second migration.

**Migration ordering matters.** A prior migration-ordering fix is in flight on
`fix/migration-ordering`. This migration must be generated against a database
already carrying every migration on `main` at branch time, and its timestamp
must sort after them.

### 4.2 `toDto` stops dropping data

`images` and `categories` already exist on `Product` and are silently omitted by
`toDto`. They start being returned, alongside the new fields.

```ts
export interface ProductDto {
  id: string; slug: string; name: string; description: string
  productType: string; releaseType: string; status: string
  images: { url: string; alt: string }[]
  categories: string[]
  pieces: number | null
  difficulty: string | null
  ageRecommendation: string | null
  dimensions: string | null
  longDescription: string
  features: string[]
  includes: string[]
  builderNotes: string
  variants: { id: string; sku: string; priceCents: number; currency: string }[]
}
```

`images` and `categories` are `Json` columns, so they are **unvalidated at the
database boundary**. `toDto` validates their shape on read and coerces a
malformed value to an empty array rather than propagating it to the client. A
product with a corrupt `images` value renders without images; it does not crash
the grid.

### 4.3 `listProducts` gains filtering and sorting

Two new options:

- **`category`** — exact match against a member of the product's `categories`
  array, as a JSON array-containment query.

  **Category values are stored as lowercase kebab-case slugs** (`architecture`,
  `limited-edition`), never as display text. The design's `category:
  "Architecture"` is display casing; storing it would make the filter
  case-sensitive against a human-typed value, which breaks the first time
  someone seeds `"architecture"`. Display names live in the storefront's
  collection registry (§5.4), not in the database.
- **`sort`** — a six-value enum: `name_asc` (default), `price_asc`,
  `price_desc`, `newest`, `home_display`, `collection_display`. Per ADR-0001's
  semantics, `price_asc`/`price_desc` sort by the product's **cheapest
  variant**, and products with no variants sort last. `newest` is `createdAt`
  descending, which is the current hardcoded behaviour. The two `*_display`
  values order by `homePosition` and `collectionPosition` respectively, both
  ascending with `NULLS LAST` and a `name` tiebreak — see §3.4.

  **This widens ADR-0001's frozen four-value enum to six.** The amendment
  records it; the four original values keep their exact semantics.

An unrecognised `sort` value is a `VALIDATION_ERROR`, not a silent fallback to
default. Silently ignoring a bad parameter returns plausible wrong results,
which is harder to notice than an error.

### 4.4 Structured errors

Routes return `{ code, message, fields? }` with `code` drawn from `NOT_FOUND`,
`VALIDATION_ERROR`, `INTERNAL`. This replaces `{ error: 'not_found' }`.

**This is a breaking change to a shipped response shape.** Its only current
consumer is the storefront being replaced in this same spec, so the blast radius
is zero — but the orders routes use the older shape too, and are **left alone**
here. Aligning them is a follow-up, not this spec's business.

### 4.5 Contract and ADR updates

- `contracts/openapi/catalog.yaml` rewritten to describe core as built.
- ADR-0001 gains an amendment section recording that core became the source of
  truth, what changed, and why — including the float-money reasoning, so the
  decision is not silently re-litigated.

### 4.6 Seed data

The seed carries two products with no images and no categories, which cannot
exercise the catalog surface. It is expanded to roughly eight products spanning
the five category collections, with at least one `limited_run`, populated
detail fields, and placeholder imagery per §6.2.

Seed data is **development fixture, not content**. It must never be presented as
the real catalog.

---

## 5. Storefront architecture

### 5.1 Stack

React 18, Vite, React Router v7, Tailwind CSS v4, TypeScript, lucide-react —
matching the reference app, and matching the stack the storefront system's own
README already names.

**Tailwind v4 configures in CSS, not `tailwind.config.js`.** The existing
JS-config file goes away with the Sprint-1 app. Anyone reading old storefront
docs will find instructions that no longer apply.

### 5.2 Layout

```
systems/storefront/code/
  src/
    main.tsx
    routes.ts                  route table
    app/
      Root.tsx                 shell: Nav, Footer, ScrollToTop
    design-system/
      tokens.css               the token block, verbatim
      primitives/              Button, Input, Badge, Eyebrow, Card, Accordion, Tabs
    lib/
      api/
        client.ts              fetch wrapper + error normalisation
        catalog.ts             typed catalog calls
        types.ts               DTOs mirroring core
      cart/
        CartContext.tsx
      collections.ts           the collection registry (§5.4)
    content/                   static page copy, one module per page
    pages/
  tests/
```

The boundaries are deliberate. `lib/api` is the **only** place that knows core's
wire format; pages consume domain types. `content/` holds copy as data so a
wording change is not a component edit. `design-system/primitives` are the only
components allowed to hardcode token values.

### 5.3 Data flow

Catalog data is fetched in **React Router route loaders**, not in component
effects. Pagination, filtering, sorting, and search stay server-owned — the
client passes parameters through and consumes the response envelope directly,
never slicing results locally. Page components receive data as props and stay
pure, which makes them testable without mocking the network.

### 5.4 Collections need no table

The seven collection slugs resolve to core queries through a storefront-side
registry:

| Slug | Resolves to |
|---|---|
| `architecture`, `fantasy`, `space`, `ocean`, `nature` | `category=<slug>`, `sort=collection_display` |
| `limited-edition` | `category=limited-edition`, `sort=collection_display` |
| `new-arrivals` | `sort=newest` |

`limited-edition` resolves through a **category**, not `releaseType`. Core has
no `releaseType` filter parameter and adding one would duplicate a distinction
the category already expresses. `new-arrivals` keeps `newest` because "recently
added" is intrinsically chronological — merchandising it by hand would mean
re-ranking on every new product.

The home page requests `sort=home_display`. Everything else about ordering is
server-side; the storefront never re-sorts what it receives.

A collections table would be schema for what is really a set of saved queries.
Each entry carries its own title and blurb for the collection detail header.

**A slug not in the registry is a 404**, not an empty grid. An empty grid tells
a customer the collection exists but has nothing in it, which for a typo is
wrong.

### 5.5 Cart

Client-side React context, lost on reload — sufficient for the nav badge and the
cart review screen, and explicitly not a persistence solution.

**It keys on variant, not product.** See §6.1.

---

## 6. Defects in the reference implementation

The reference app is a design artifact, and three of its behaviours must not be
carried into production code.

### 6.1 The cart keys on product ID

`CartContext.tsx` stores `id: number` — a product ID — and increments quantity
on a match. Core's order API takes `variantId`. A product with two variants at
different prices would collapse into a single cart line at whichever price was
added first, and would be unorderable against core.

**The cart keys on variant ID.** Line identity is the variant; the product name
and image are display data hanging off it.

### 6.2 Prices are floats

The reference uses `price: 189`. Every price becomes `priceCents: 18900`.
Formatting to a display string happens once, at the render boundary.

### 6.3 The reference violates its own accessibility rule

The handoff states that `#8a8a8a` on `#0f0f0f` is approximately 5.5:1 and
**must not be used for text below 12px**. `Root.tsx` then does exactly that in
four places — `text-[10px]` combined with `text-muted-foreground` at lines 194,
208, 293, and 308, covering category eyebrows and piece counts.

**The written rule wins over the reference code.** These micro-labels render at
12px minimum, or take a lighter foreground where the design requires the smaller
size. This is a spec conflict resolved in favour of accessibility, not a
judgement call to revisit per-component.

### 6.4 Fabricated review data is cut

The reference carries `rating: 4.9, reviewCount: 214`. Rendering invented review
counts on a real storefront is fabricated social proof — it tells customers 214
people reviewed a product when none did.

**The ratings UI is not built.** No columns, no components, no placeholder
stars. Real reviews need a reviews subsystem that nobody has designed. When one
exists, the UI arrives with it.

---

## 7. Accessibility requirements

The handoff names four gaps and calls them implementation requirements, not
suggestions. They are:

- **Visible keyboard focus on every interactive element.** The `--ring` token
  exists for this and is currently unused.
- **ARIA roles and state** on the accordion (FAQ), tabs (product detail), and
  any step indicator.
- **Labels bound to inputs**, with real validation and error messaging. The
  prototype has none.
- **No `#8a8a8a` below 12px**, per §6.3.

These are acceptance criteria for the pages that contain the relevant controls,
not a cleanup pass afterwards.

---

## 8. External dependencies

### 8.1 Fonts

The reference loads Barlow Condensed and DM Sans from Google Fonts via CSS
`@import`. For a commerce site that is a third-party runtime dependency on every
page load, a render-blocking request, and a privacy consideration.

**Both families are self-hosted**, with `font-display: swap` and the weights
actually used — Barlow Condensed 900, DM Sans 400/500/600.

### 8.2 Product photography

The handoff calls real product photography "the largest open gap," and it
remains open. The design is image-led; the reference uses Unsplash URLs of
generic photos that are not Alpine Brick sets.

This build seeds **committed, visibly neutral placeholders** with real `alt`
text. Unsplash URLs are not carried forward: they are an external runtime
dependency, they are licensed for a purpose that is not this, and they depict
products we do not sell.

The `{url, alt}` shape is retained exactly as ADR-0002 specified, because
ADR-0002 confirms it is forward-compatible with adding `width`, `height`, and
`srcset` variants once a CDN is chosen. **ADR-0002 is DRAFT and is Jack's spend
decision — this spec does not pre-empt it.**

---

## 9. Testing

Test-driven throughout: a failing test observed before the implementation that
satisfies it.

| Layer | Approach |
|---|---|
| Core service | Extends the existing vitest suite — filter, sort, DTO shape, malformed-JSON coercion, validation errors |
| Core routes | Request-level tests for the new parameters and the error envelope |
| Storefront `lib/api` | Tested against fixtures captured from core's **actual** responses, not hand-written ideals |
| Components | React Testing Library, including keyboard and ARIA assertions from §7 |
| Collection registry | Slug resolution, and that an unknown slug 404s |

**Two standing traps apply.**

`systems/core` is not in the root npm workspaces, so `npm test --workspaces`
**silently skips it**. Core's tests run as `cd systems/core && npm test`.

**A green suite does not mean the application boots.** Vitest resolves
TypeScript directly and never touches compiled output, which has already hidden
a broken production entrypoint once in this repo. `npm run build` and a real
boot of the compiled server are run as separate verification steps for both core
and the storefront.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Migration ordering collides with `fix/migration-ordering` | Generate against a database at `main`'s migration state; verify timestamp ordering before merge |
| Error-envelope change breaks an unknown consumer | Only consumer is the storefront replaced here; orders routes deliberately untouched |
| Tailwind v4 CSS config surprises anyone following old storefront docs | Storefront README rewritten as part of the work |
| Placeholder imagery mistaken for real product photos | Visibly neutral, never photographic; gap tracked in §8.2 |
| Sub-project C inherits an in-memory cart and treats it as a design | §5.5 and §2.2 state its scope explicitly |

---

## 11. Open questions

1. **Is there real product photography, or a source for it?** Everything ships
   with placeholders until there is. This is the single largest gap between this
   build and something presentable.
2. **What are the real seven collections?** The slugs come from the design.
   Whether Alpine Brick's actual catalog divides this way is a merchandising
   decision, not an engineering one.
3. **Does the static page copy hold up?** About, Careers, Press, and Community
   carry design-time placeholder prose. It renders correctly; whether it says
   what Jack wants it to say is a marketing review.

None of these block starting. All three block anything customer-facing.
