# Alpine Brick Exchange — storefront design handoff

You are implementing the Alpine Brick Exchange ecommerce storefront. This folder is a **design handoff package**, not a production codebase.

## Read these first, in this order

1. **`README.md`** — the authoritative spec. Design tokens, type scale, and a screen-by-screen breakdown of all 19 screens with exact hex values, sizes, letter-spacing, and copy. If the spec and the code ever disagree, the spec wins for *visuals*; the code wins for *behavior*.
2. **`figma-src/`** — a runnable React reference app (the recovered Figma Make source). This is the closest thing to ground truth for layout and interaction.
3. **`Alpine Brick.dc.html`** — a single-file interactive prototype of the same 19 screens. Open it in a browser to click through every flow without installing anything. Useful for checking behavior quickly; **do not** copy its inline-style markup — it is a preview artifact.
4. **`theme-tokens.css`** — the raw token block, also inlined into `figma-src/src/styles/globals.css`.

## Run the reference app

```bash
cd figma-src
npm install
npm run dev
```

React 18 · Vite · React Router v7 · Tailwind CSS v4 · lucide-react icons. Tokens are mapped to Tailwind's semantic scale in `src/styles/globals.css`, so `bg-background`, `text-primary`, `border-border`, and `rounded-md` all resolve to the design system values.

## What to build

Recreate these designs **inside the Alpine Brick platform's own environment**, using its existing routing, component library, and data layer. Do not fork `figma-src/` as the production app unless the platform has no frontend yet — in that case it is a reasonable starting point.

## Non-negotiable visual rules

These four carry the brand identity. Breaking any one of them makes the result look wrong even when everything else is correct.

- **Uppercase micro-labels are always letter-spaced** (`0.12em`–`0.2em`): eyebrows, nav links, button labels, badges, meta text. This is the single most identity-defining rule.
- **Display type is `Barlow Condensed` at weight 900, uppercase, always.** Body is `DM Sans` 400/500/600. Nothing else.
- **Hard edges.** `border-radius: 2px` on buttons and inputs only; cards, badges, and images are square. **No shadows anywhere** — depth comes from `#181818` surfaces on `#0f0f0f` with `rgba(255,255,255,0.08)` borders.
- **Foreground is `#f0ede8`, not white.** Pure white (`#ffffff`) is reserved for the accent state (the "Added ✓" confirmation).

## Placeholder data — replace all of it

Everything below is design-time fiction. Wire each to the real platform API:

| Area | Currently | Needs |
|---|---|---|
| Catalog | 8 hardcoded products in `figma-src/src/app/data.ts` | Product/inventory API |
| Product imagery | Unsplash URLs (generic photos, not real sets) | Real product photography — **the largest open gap** |
| Cart | React context, in-memory, lost on reload | Persisted cart / session |
| Checkout totals | Free standard shipping at $75+, tiers $6.99/$14.99/$29.99, promo `ALPINE10` = 10% off, tax flat 7% | Real shipping rates, promo engine, tax service |
| Payment | Unvalidated card fields, no processor | Payment provider (Stripe or equivalent) |
| Order tracking | One mock order; matches any number containing "ABE" | Order + carrier tracking API |
| Contact form | Fake 1.4s delay, then success | Ticketing / email backend |
| Press & community links | Non-functional | Real destinations |

## Routes

```
/                        Home (hero, spotlights, filterable catalog, trust marquee)
/product/:id             Product detail (gallery, tabs, add to cart)
/collections             Collections index
/collections/:slug       Collection detail — architecture · fantasy · space · ocean ·
                         nature · limited-edition · new-arrivals
/checkout                Cart → shipping → payment → confirmation (one route, four steps)
/support                 Support hub
/support/faq             FAQ accordion
/support/shipping        Shipping info
/support/returns         Returns & exchanges
/support/track-order     Order tracking
/support/contact         Contact form
/about  /designers  /careers  /press  /community
```

## Accessibility gaps to close during implementation

The prototypes are visual references and do not fully cover these — treat them as implementation requirements:

- Keyboard focus states on every interactive element (the `--ring` token exists for this).
- Accordion, tab, and step-indicator ARIA roles and state.
- Form labels bound to inputs, plus real validation and error messaging (the prototype has none).
- `#8a8a8a` on `#0f0f0f` is ~5.5:1 — fine for body text, but do not use it for text below 12px.
