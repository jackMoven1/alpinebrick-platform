# ImagiBricks Engineering — Agent Plan

*Owned by the Engineering Lead. Last updated 2026-06-03.*

## Purpose
Defines the specialist engineer agents in the ImagiBricks engineering workspace — who's hired, who's planned, and the order we bring them on.

## Current state
- **Active agents:**
  - `engineering-lead` — me.
  - `storefront-engineer` — owns the customer-facing UI (catalog browse, product-detail, search/filter, cart, checkout, accounts, site shell). Consumes catalog APIs.
  - `catalog-engineer` — owns the catalog backend (data model, services, read + write/admin APIs, search infrastructure, image-handling backend).
- **Seam between Catalog and Storefront:** the catalog API contract, captured as `docs/adr/0001-catalog-api-contract.md`. Both engineers co-author; I approve.

## Specialist roles (full roster)
1. ~~`storefront-engineer`~~ — **HIRED 2026-06-03**. UI only.
2. ~~`catalog-engineer`~~ — **HIRED 2026-06-03**. Backend only.
3. `oms-engineer` — Order management, inventory writes, fulfillment workflow. Plugs into the catalog data model and writes order/inventory state.
4. `tracking-engineer` — Interaction tracking, event capture, **order-level affiliate attribution**.
5. `affiliate-engineer` — Affiliate partner accounts, referral codes, flat-% commission engine, Stripe Connect payout support.
6. `mcp-integration-engineer` — The ImagiBricks MCP connector exposing orders/inventory/customers/affiliates/referrals to back-office agents.

## Recommended hire sequence going forward
1. `oms-engineer` — order lifecycle and inventory foundation; needs the catalog data model in place (which the Catalog Engineer is delivering first).
2. `tracking-engineer` — capture attribution and analytics **before launch**; must precede the affiliate engine so it has clean data to consume.
3. `affiliate-engineer` — affiliate referral logic and payout data; consumes tracking attribution.
4. `mcp-integration-engineer` — expose data to back-office MCP agents once the core models are stable.

## Architectural conventions
- Code lives in branches; reviewed before merge.
- Architecture decisions live in `docs/adr/` (numbered, status-tagged).
- Locked engineering constraints from `CLAUDE.md`: custom web app, Stripe payments, flat-% affiliate model, order-level attribution, no secrets in code.
- New specialist hires get a charter in `.claude/agents/`, get pointed at the parent-workspace plan and org docs, and inherit the company-wide draft-for-approval default.

## Notes
- I update this file as the engineering org evolves. HR updates the parent-workspace Agent Registry to match.
