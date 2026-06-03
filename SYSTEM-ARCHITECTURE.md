# ImagiBricks Platform Architecture

## Overview
This document describes the application infrastructure for ImagiBricks, supporting a retail eCommerce platform with the following systems:

1. Web storefront
2. Inventory management
3. Affiliate marketing
4. Product ordering and checkout
5. Product catalog management

The architecture is defined as a set of bounded systems with clear integration points, shared domain models, and a single source of truth for orders, products, inventory, and affiliate attribution.

---

## System boundaries

### 1. Storefront website
Purpose: customer-facing product discovery, shopping cart, checkout flow, and account sign-in.

Responsibilities:
- Browse products, categories, and metadata
- Add items to cart and manage cart contents
- Apply referral codes and affiliate links
- Present checkout steps and payment UI
- Show order confirmation and order history

Integration points:
- Catalog service for product data and availability
- Ordering/checkout service for cart validation, order creation, and payment
- Affiliate service for referral attribution and campaign tracking
- Inventory service for low-stock warnings and product availability indicators

### 2. Inventory management
Purpose: manage stock, track availability, and synchronize inventory with live commerce data.

Responsibilities:
- Receive order events and decrement stock
- Support stock adjustments, restocking, and reservation logic
- Provide availability data to storefront and catalog
- Expose inventory status to OMS and operations staff

Integration points:
- Ordering/checkout service for reservation and fulfillment status
- Catalog service for current stock information
- Storefront site for product availability flags
- Event bus or API layer for real-time inventory updates

### 3. Affiliate marketing
Purpose: capture referrals, calculate commission for flat-% affiliate model, and prepare payout data.

Responsibilities:
- Manage affiliate partner profiles and referral codes
- Track click-throughs, sessions, and order-level attribution
- Apply affiliate attribution on checkout and order creation
- Calculate commission amounts and expose reporting data
- Integrate with Stripe Connect payout workflows

Integration points:
- Storefront and checkout for link tracking and referral attribution
- Ordering service for order-level affiliate assignment
- Reporting/analytics pipeline for performance metrics
- Payment platform for payout-ready commission records

### 4. Ordering and checkout
Purpose: process orders, validate payments, and coordinate fulfillment.

Responsibilities:
- Accept cart submissions and create canonical orders
- Integrate with Stripe for payment intents and capture
- Attach affiliate attribution to orders
- Validate inventory and enforce stock rules
- Emit fulfillment events to inventory and OMS workflows
- Manage order lifecycle: pending, paid, canceled, refunded

Integration points:
- Storefront website for checkout UI and payment flow
- Inventory management for stock validation and reservation
- Affiliate marketing for commission attribution
- Catalog service for SKU validation and pricing
- CRM/order admin interfaces for order status and support

### 5. Product catalog management
Purpose: author and maintain the product catalog, SKUs, pricing, and merchandising.

Responsibilities:
- Create/update products, variants, attributes, and pricing
- Manage categories, collections, and search metadata
- Publish/unpublish catalog items for the storefront
- Maintain SKU-to-inventory mapping
- Provide product feeds for the website and integrations

Integration points:
- Storefront for published product content
- Inventory service for SKU linkage and stock status
- Ordering/checkout for SKU validation and pricing information
- Marketing/affiliate systems for product metadata and promotions

---

## Data model and shared domains

### Core domain entities
- `Product`
- `ProductVariant` / `SKU`
- `InventoryItem`
- `Order`
- `OrderLineItem`
- `Customer`
- `AffiliatePartner`
- `ReferralCode` / `ReferralSession`
- `PaymentIntent`
- `CommissionRecord`

### Single source of truth
Use a canonical data model for:
- Orders and order items
- Product catalog structure and pricing
- Inventory quantities and availability
- Affiliate referral attribution

This can be implemented as a central relational database with service-owned tables and API contracts, or as a primary store plus an event-driven sync layer if the architecture later moves toward microservices.

### Affiliate attribution
Affiliate attribution must live at the order level. Each order should carry:
- `affiliate_id`
- `referral_code`
- `affiliate_attribution_source`
- `affiliate_commission_rate`
- `affiliate_commission_amount`

This ensures the affiliate engine and future MCP connector can calculate commissions exactly from completed orders.

---

## Recommended infrastructure pattern

### Deployment model
Recommended: a cloud-hosted containerized application stack with a managed relational database.

Components:
- Web app(s): storefront UI + catalog/admin UI
- API backend(s): ordering, inventory, affiliate, catalog
- Database: PostgreSQL or managed SQL
- Object storage: file assets, product images, static assets
- Authentication: JWT + session management / OAuth for admin and partners
- Payments: Stripe for checkout and Stripe Connect for affiliate payouts
- Observability: logging, monitoring, error tracking

### Service topology
Option A — modular backend services with shared database and API gateway:
- `storefront-service` (Frontend + BFF)
- `catalog-service`
- `inventory-service`
- `order-service`
- `affiliate-service`
- `admin-service` (catalog + inventory management consoles)

Option B — monolith API with distinct modules and a single backend service
- A single backend app with module boundaries for catalog, inventory, order, affiliate, and admin
- Simpler early-stage development and deployment
- Still conceptually separate by feature, with future extraction possible

Recommendation: start with Option B if team size is small and the MVP needs speed, then evolve into Option A once the product/traffic scale requires it.

### Independent project ownership
Each system should be managed as its own project with a dedicated codebase, deployment pipeline, and ownership model.
- `storefront` project: customer-facing web app and commerce UX.
- `catalog` project: product authoring, pricing, SKU publishing, and merchandising.
- `inventory` project: stock management, reservations, and availability.
- `order` project: checkout orchestration, payment processing, and order state.
- `affiliate` project: referral capture, attribution, commissions, and payout data.

Each project owns its bounded context and domain data, while integration is managed through explicit contracts and shared event schemas.

### Integration approach
- API-driven integration is the primary pattern.
- Use REST/GraphQL for frontend/backend communication.
- Use event notifications for eventual consistency between inventory, order, and affiliate systems.
- Keep the storefront and admin UI on the same platform stack when possible to reduce operational complexity.
- Maintain a shared `contracts` repository or package with OpenAPI specs, shared DTO definitions, and event schema definitions.
- Version integration contracts so each independent project can evolve without breaking connected systems.
- Use an integration matrix to document connection points and ownership:
  - `storefront` reads from `catalog`, `inventory`, and `order`; writes referral attribution and cart submissions to `order`.
  - `order` validates against `catalog`, reserves stock through `inventory`, and applies attribution from `affiliate`.
  - `inventory` exposes availability and publishes stock change events.
  - `affiliate` exposes referral and commission records and consumes order events for attribution.
  - `catalog` pushes product publish/unpublish events and exposes product metadata.

### Security and compliance
- Store no Stripe secrets in source control.
- Use environment variables and secret management for API keys.
- Enforce least-privilege access between services.
- Ensure PCI compliance by letting Stripe handle sensitive payment flows and tokens.

---

## Build and rollout sequence

1. Define the domain model and canonical database schema.
2. Build catalog management and storefront browsing first.
3. Add the ordering and checkout service with Stripe payment flow.
4. Add inventory management and stock sync to protect availability.
5. Add affiliate referral tracking and commission attribution.
6. Add product catalog admin features and WHOLE-system audit/reporting.
7. Implement tracking/analytics and set up the MCP connector later.

This sequence preserves the core constraint: the live commerce site must capture order-level affiliate attribution from day one.

---

## Recommended first-stage architecture

For an initial launch, I recommend:
- A single TypeScript backend service with discrete modules for catalog, orders, inventory, and affiliate.
- A shared PostgreSQL database for core data.
- A React/Next.js storefront for customers and a separate admin UI for catalog/inventory.
- Stripe checkout integration and webhooks managed by the backend.
- Affiliate codes and referral attribution applied in the checkout path.

This keeps the system manageable, while still preserving the five functional domains.

---

## Next step
Create the first architecture decision record and choose whether to build:
- `storefront + catalog` first, or
- `ordering + inventory` first.

I can also turn this design into a formal ADR and a minimal repository scaffold next.
