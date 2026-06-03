# ImagiBricks Integration Contracts

## Purpose
This document defines the shared integration contracts and API/event schema guidance for the independent ImagiBricks system projects.

The contracts are the source of truth for how the following systems communicate:
- `storefront`
- `catalog`
- `inventory`
- `order`
- `affiliate`

## Contract principles
- Each system owns its domain and API surface.
- Contracts are explicit and versioned.
- Integration uses both synchronous APIs and asynchronous events.
- Shared schemas are maintained in a central `contracts` package or repository.
- Breaking changes are released only with versioned migration support.

## Shared contract types
### Product data
- `Product`
  - `id`
  - `slug`
  - `name`
  - `description`
  - `published`
  - `categories`
  - `images`
  - `metadata`
- `ProductVariant` / `SKU`
  - `id`
  - `product_id`
  - `sku`
  - `price`
  - `currency`
  - `weight`
  - `attributes`
  - `inventory_item_id`

### Inventory data
- `InventoryItem`
  - `id`
  - `sku_id`
  - `available_quantity`
  - `reserved_quantity`
  - `status`
  - `location`

### Order data
- `Order`
  - `id`
  - `customer_id`
  - `status`
  - `total_amount`
  - `currency`
  - `payment_status`
  - `affiliate_id`
  - `referral_code`
  - `commission_rate`
  - `commission_amount`
- `OrderLineItem`
  - `id`
  - `order_id`
  - `sku_id`
  - `quantity`
  - `unit_price`
  - `line_total`

### Affiliate data
- `AffiliatePartner`
  - `id`
  - `name`
  - `code`
  - `commission_rate`
  - `status`
- `ReferralSession`
  - `id`
  - `affiliate_id`
  - `referral_code`
  - `source`
  - `landing_url`
  - `created_at`
- `CommissionRecord`
  - `id`
  - `order_id`
  - `affiliate_id`
  - `commission_rate`
  - `commission_amount`
  - `status`

## API contract examples
### Catalog service
- `GET /api/catalog/products`
- `GET /api/catalog/products/{id}`
- `GET /api/catalog/products/{id}/availability`
- `POST /api/catalog/products/{id}/publish`
- `POST /api/catalog/products/{id}/unpublish`

### Inventory service
- `GET /api/inventory/sku/{skuId}`
- `POST /api/inventory/sku/{skuId}/reserve`
- `POST /api/inventory/sku/{skuId}/release`
- `GET /api/inventory/sku/{skuId}/availability`
- `POST /api/inventory/adjustments`

### Order service
- `POST /api/orders`
- `GET /api/orders/{orderId}`
- `POST /api/orders/{orderId}/cancel`
- `POST /api/orders/{orderId}/refund`
- `POST /api/orders/{orderId}/capture`

### Affiliate service
- `POST /api/affiliate/referral`
- `GET /api/affiliate/partners/{id}`
- `GET /api/affiliate/referrals/{code}`
- `POST /api/affiliate/commissions/{orderId}`

## Event contracts
### Order events
- `order.created`
- `order.paid`
- `order.canceled`
- `order.refunded`

Payload contains core order and attribution details, including `affiliate_id`, `referral_code`, and line items.

### Inventory events
- `inventory.reserved`
- `inventory.released`
- `inventory.adjusted`
- `inventory.out_of_stock`

Payload includes `sku_id`, `quantity`, `available_quantity`, and `source_event_id`.

### Catalog events
- `catalog.product.published`
- `catalog.product.unpublished`
- `catalog.product.updated`

Payload includes product metadata and `sku` relationships.

### Affiliate events
- `affiliate.referral.created`
- `affiliate.commission.created`
- `affiliate.commission.paid`

Payload includes referral context, order attribution, and commission totals.

## Contract versioning
- Use semantic versioning for contract schemas: `v1`, `v2`, etc.
- Store versioned schema definitions in the `contracts` package or repo.
- Document backwards compatibility rules.
- When APIs change, publish a new contract version and keep the old version active until consumers migrate.

## Implementation guidance
- Maintain a central `contracts` repository or package with OpenAPI/JSON Schema definitions.
- Share the package across services and client applications.
- Use generated client code when possible to reduce drift.
- Review contract changes as part of PRs, not just code changes.
