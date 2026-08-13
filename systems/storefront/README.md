# Storefront System

**Status**: Foundation and catalog built; cart, checkout and support tooling deferred
**Owner**: Storefront Engineer
**Reports To**: Engineering Lead

---

## Overview

The **Storefront** is the customer-facing website for Alpine Brick Exchange. It
is a React 18 + TypeScript application built on the 2026-08-12 design handoff,
served by Vite and backed by **`systems/core`**.

**It is not live.** `alpinebrickexchange.com` resolves to the Shopify store and
continues to until the Phase 5 cutover. This app targets local and staging
environments only, which is why an incomplete checkout is a normal mid-build
state rather than a customer-facing defect.

## What is built

| Area | State |
|---|---|
| App shell, nav, footer, skip link | Built |
| Design system: tokens + 7 primitives | Built |
| Home page with category filtering and search | Built |
| Product detail: gallery, specs, tabs, add to cart | Built |
| Collections index and collection detail | Built |
| Company pages: About, Designers, Careers, Press, Community | Built |
| Support hub, FAQ, Shipping, Returns | Built |
| Cart (in-memory, lost on reload) | Built |

## What is deliberately not built

| Deferred | Blocked on |
|---|---|
| Checkout: shipping, payment, confirmation | No payment provider, no shipping rates |
| Cart persistence across sessions | Needs a session or account model |
| Promo codes | No promo engine; see the discount trap in the spec |
| Order tracking by number | Needs a carrier integration |
| Contact form submission | Needs a ticketing or email backend |
| Product reviews and ratings | No reviews subsystem is designed |

Ratings are **not** stubbed. Rendering an invented star rating or review count
on a real storefront is fabricated social proof, so the UI is absent until real
reviews exist.

## Directories

- **`code/`** — the application. See [`code/README.md`](./code/README.md) for
  how to run it and the traps that will bite you.
- **`design/handoff/`** — the 2026-08-12 Figma design package: the authoritative
  visual spec, a runnable React reference app, and a clickable prototype. It is
  a **reference, not a codebase**; do not build or deploy from it.
- **`design/references/`** — earlier mockups and design inputs.
- **`hiring/`** — role onboarding notes.

## Service dependencies

Exactly one: **`systems/core`** on `:4000`, backed by PostgreSQL on `:5433`.

The storefront does **not** depend on `catalog-service`, `order-service`,
`inventory-service` or `affiliate-service`. Those are pre-redesign in-memory
mocks. An earlier version of this app was wired to them and could not work
against core; that version was replaced.

## Governing documents

- Spec: `docs/superpowers/specs/2026-08-12-storefront-foundation-and-catalog-design.md`
- Plan: `docs/superpowers/plans/2026-08-12-storefront-foundation-and-catalog.md`
- API contract: `contracts/openapi/catalog.yaml` (2.0.0)
- ADR-0001 — Catalog API Contract, **amended 2026-08-12**: core is the source of
  truth for the catalog surface.

## Open questions

1. **Real product photography.** Everything ships with neutral placeholders.
   This is the largest gap between the current build and something presentable.
2. **Whether the seven collections match real merchandising.** The slugs came
   from the design, not from a merchandising decision.
3. **Whether the static page copy says what Jack wants.** It is honest and
   states plainly where facts do not exist yet, but it has not had a marketing
   review.
