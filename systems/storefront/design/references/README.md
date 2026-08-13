# Storefront — Design Reference Inputs

Drop design models / mockups / references here for the engineer to take as **input** when designing the customer storefront pages.

## What goes here
- Mockup images — PNG, JPG, WEBP (annotated screenshots, hand sketches, Figma exports)
- HTML/CSS prototypes (single files or small folders)
- PDFs of design comps
- Links / notes — a `.md` file listing reference sites or describing intent

## How to use it
- Name files so they map to a page or component, e.g. `home.png`, `product-detail.png`, `cart.png`, `catalog-browse-filters.png`.
- Multiple options for the same screen: suffix them, e.g. `home-a.png`, `home-b.png`.
- If a file needs explanation, add a sibling `<name>.notes.md` or just tell me in chat which file to look at.

These are **inputs**, not the source of truth — committed design docs in
`docs/superpowers/specs/` remain the spec. References here inform the visual
treatment of the storefront pages.

## The 2026-08-12 design handoff

`../handoff/` holds the full Figma design package for the storefront: the
authoritative visual spec (`handoff/README.md`), a runnable React reference app
(`handoff/figma-src/`), a single-file clickable prototype
(`handoff/Alpine Brick.dc.html`), and the raw token block
(`handoff/theme-tokens.css`).

**It is a reference, not a codebase.** Do not build or deploy from it. Where the
spec and the reference code disagree, the spec wins on visuals and the code wins
on behaviour — **except** for the three defects recorded in
`docs/superpowers/specs/2026-08-12-storefront-foundation-and-catalog-design.md`
§6, which are not to be carried forward at all:

1. the cart keys on product ID where it must key on **variant** ID,
2. prices are floats where they must be **integer cents**, and
3. four places use `text-[10px]` with `--muted-foreground`, which the handoff's
   own accessibility rule forbids below 12px.
