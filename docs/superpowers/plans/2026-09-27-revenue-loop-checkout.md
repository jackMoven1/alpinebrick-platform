# Revenue Loop — Storefront Checkout with Stripe — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer can put sets in a cart, pay through Stripe Embedded Checkout with Stripe Tax and flat-rate shipping, and land on a confirmation page. The order then shows up in the admin console, where it can be marked shipped or cancelled. Stripe webhooks keep order state, stock and refunds in step.

**Architecture:** Core gains a public `POST /api/v1/checkout`. It validates the cart, reserves stock through the existing `placeOrder` (with a deferred tax adapter), opens a Stripe Checkout Session through a `PaymentsPort`, and returns the session's client secret. A raw-body `POST /api/v1/webhooks/stripe` verifies signatures and de-duplicates events in a `stripe_events` table. It applies four event types inside one transaction per event. A 5-minute sweep in the web process is the backstop for missed `expired` events. The storefront gets a cart drawer and page, `/checkout` (Embedded Checkout), and `/order/complete` (polls core). The console gets an Orders section and a Settings page, plus weight and dimensions on variants.

**Tech Stack:** Node 20, TypeScript, Express 4, Prisma 5 on Postgres 16, `stripe` 22.6.2 (pinned), Vitest + Supertest (core); React 18, react-router 7, Vite 6, `@stripe/stripe-js` 9.17.0, `@stripe/react-stripe-js` 6.12.0, Vitest + Testing Library (storefront); React 18, react-router-dom 6, Vite 5, Vitest + Testing Library (admin-ui).

**Spec:** `docs/superpowers/specs/2026-09-27-revenue-loop-checkout-design.md`. Read it before starting. Section references (§) below point into it.

### Stripe facts verified for this plan (2026-09-27)

These were checked against current Stripe documentation and the published npm packages. Do not "correct" them from memory. Several differ from older Stripe examples.

| Fact | Value | Source |
|---|---|---|
| Server SDK | `stripe@22.6.2` (npm `latest`), pinned API version `2026-08-26.dahlia` (`esm/apiVersion.js`) | https://www.npmjs.com/package/stripe |
| Client SDKs | `@stripe/stripe-js@9.17.0`, `@stripe/react-stripe-js@6.12.0` (peer `@stripe/stripe-js >=9.16.0 <10`, `react <20`) | npm |
| Embedded Checkout `ui_mode` | **`'embedded_page'`**. Dahlia (2026-03-25) renamed the modes; `'embedded'` now **fails**. | https://docs.stripe.com/changelog/dahlia/2026-03-25/updates-available-checkout-session-ui-modes |
| React components | `EmbeddedCheckoutProvider` + `EmbeddedCheckout` from `@stripe/react-stripe-js`; options `{ fetchClientSecret }` or `{ clientSecret }`. The provider calls `stripe.createEmbeddedCheckoutPage()`, which replaced `initEmbeddedCheckout()`. | https://docs.stripe.com/checkout/embedded/quickstart?client=react |
| `return_url` | required for `embedded_page`; `{CHECKOUT_SESSION_ID}` is substituted by Stripe. `success_url`/`cancel_url` are **not allowed** with `embedded_page`. | https://docs.stripe.com/api/checkout/sessions/create |
| `expires_at` | 30 minutes to 24 hours after creation. The plan sends `now + session_minutes + 1 min` so clock skew never lands under the 30-minute floor. | same |
| Payment-method restriction | `allowed_payment_method_types: ['card']`. Dahlia 2026-08-26 removed `payment_method_types` from PaymentIntents and SetupIntents, and the Checkout create reference no longer lists it. Apple Pay and Google Pay are card wallets and stay available. Link is its own type and is filtered out. | https://docs.stripe.com/changelog/dahlia (2026-08-26 entry) |
| Tax codes | Line items `txcd_99999999` (General – Tangible Goods); shipping rate `txcd_92010001` (Shipping); `tax_behavior: 'exclusive'` on both | https://docs.stripe.com/tax/tax-codes |
| Shipping address location | `session.collected_information.shipping_details.{name,address}`. The top-level `shipping_details` is gone in current versions. Email is on `session.customer_details.email`. | https://docs.stripe.com/api/checkout/sessions/object?query=collected_information |
| Totals | `amount_total`, `total_details.amount_shipping` (pre-tax shipping), `total_details.amount_tax` (**all** tax, including tax on shipping), `total_details.amount_discount`. `shipping_cost.amount_total` is **after tax**. | https://docs.stripe.com/api/checkout/sessions/object?query=total_details |
| Webhook verification | `stripe.webhooks.constructEvent(rawBody, signatureHeader, secret)`; tests sign with `stripe.webhooks.generateTestHeaderString({ payload, secret })` | https://github.com/stripe/stripe-node#webhook-signing |
| Webhook payload shape | Events are rendered in the **webhook endpoint's** API version. The staging endpoint must be created with API version `2026-08-26.dahlia` (runbook, Task 10). | Stripe Workbench docs |

**§9.1 — contiguous-US enforcement: finding.** Stripe has no native way to restrict an `embedded_page` Checkout Session to particular US states. `shipping_address_collection` takes only `allowed_countries` (ISO country codes). The "dynamically customize shipping options" guide says: *"The full embedded page doesn't support dynamically customizing shipping options"* (https://docs.stripe.com/payments/checkout/custom-shipping-options?payment-ui=embedded-page). Server-side address updates (`permissions.update_shipping_details: 'server_only'`) are documented as *"only supported when `ui_mode=elements`"* (create reference, `permissions`). The `form`/`elements` modes can recalculate options per address, but even there Stripe notes that wallets (Apple Pay, Google Pay) bypass the server update. So the plan implements the spec's recommended option **(b)**:

- `custom_text.shipping_address.message` on every session, plus the notice on the cart, says "We ship to the contiguous US only."
- The `checkout.session.completed` handler flags a paid order shipped to AK, HI, PR, GU, VI, AS, MP, AA, AE, AP, or outside the US, with `reviewReason = 'outside_shipping_area'`, and logs it.
- A human refunds it in Stripe.

Revisit this if it happens in practice. Moving to `ui_mode: 'form'` would reject non-contiguous addresses for card entry, but it would not stop wallets.

## Global Constraints

- **Core tests use the project's own DB config. Do NOT set `DATABASE_URL`.** The `alpinebrick-core-db` container on :5433 must be running (`docker start alpinebrick-core-db`). If Docker cannot be brought up, push the branch and read `gh pr checks` — CI is the verifier. Say so in every report, and never claim a test passed that you did not see pass.
- **Never read or print `.env`, `.env.example` or `secrets/`.** No Stripe key (live or test) appears anywhere in code, tests, docs or commits. Tests use the fake payments port or a mocked Stripe client. The only key-shaped strings allowed are the literals `sk_test_unused_placeholder` and `sk_live_unused_placeholder`. They construct offline `Stripe` instances, for signing test payloads and for the livemode check, and they are not keys.
- **Branching:** one branch per PR, never pushed without Jack's OK. `feat/revenue-loop-core` (Tasks 0–10) is cut from `main` after the spec/plan branch `docs/revenue-loop-spec` merges. `feat/revenue-loop-storefront` (Tasks 11–14) and `feat/revenue-loop-console` (Tasks 15–18) are each cut from `main` after the core PR merges.
- **Commits:** conventional, and the subject names the system (`feat(core):`, `feat(storefront):`, `feat(admin-ui):`, `docs(...)`, `test(core):`). Every commit message ends with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Every commit block below passes the trailer as a second `-m`, which makes it the message's last paragraph.
- **Money:** integer cents everywhere. The console converts dollars to cents once, on submit, via `dollarsToCents`.
- **Audit:** every admin write, and every order transition, writes its `AuditLog` row through `recordAudit(..., tx)` in the same transaction as the change.
- **Stock semantics are unchanged (§2):** reserve at place, `paid` keeps the reservation, `fulfilled` decrements `on_hand` and `reserved`, `cancelled` releases, and a full refund of a `paid` order releases. The invariant `reserved + COALESCE(walmart_allocation, 0) <= on_hand` holds after every statement.
- **Error envelopes.** The public checkout routes use lower_snake codes `{ code, message, details? }`: `invalid_request` 400, `insufficient_stock` 409, `variant_not_found` 409, `rate_limited` 429, `checkout_unavailable` 503, `not_found` 404. The admin routes use UPPER_SNAKE `{ code, message, fields?, details? }` (existing convention).
- **Settings keys and defaults (§3):** `shipping.flat_rate_cents` = 995, `shipping.free_threshold_cents` = 15000 (NULL = no free shipping), `checkout.session_minutes` = 30.
- **Checkout limits (§4):** 1–20 lines, integer quantity 1–10 per line, no duplicate variants. The referral code pattern is `^[a-z0-9-]{2,32}$` after lowercasing; a bad code is dropped, not rejected. The referral window is 30 days. The rate limit is 20 checkout POSTs per minute per IP.
- **Pending checkout order:** `email = 'pending@checkout.invalid'`, `shipToState = ''`, `taxJurisdiction = 'stripe_tax_pending'` until the webhook writes the real values.
- **Copy (verbatim from the spec):** "We ship to the contiguous US only." · "Shipping and tax calculated at checkout" · "Free shipping on orders over $150" · opt-in label "Email me about new sets and restocks" (unticked) · "Only N left" · "No longer available" · "Checkout is temporarily unavailable — please try again in a minute." · "Order <number> confirmed" · "Your receipt is on its way from Stripe" · "Payment received — we're confirming your order. Your Stripe receipt is your confirmation." · "This checkout expired".
- **Env keys:** core `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (secrets, pasted by Jack) and `STOREFRONT_PUBLIC_URL` (new, `sync: false`). Core refuses to start when only one Stripe key is set, or when both are set but `STOREFRONT_PUBLIC_URL` is not. Storefront `VITE_STRIPE_PUBLISHABLE_KEY` (`sync: false`).
- **Before merging any PR:** that package's full `npx vitest run` and `npm run build`. For core, also boot the compiled server (`node dist/server.js`) and `curl /health`. A green suite does not prove the app starts.
- **No mock fallback in the console.** Every method calls core.

### Decisions this plan makes where the spec is silent (flagged for Jack)

1. **`STOREFRONT_PUBLIC_URL`** is the base of `return_url`. The storefront cannot send it, or checkout would become an open redirect.
2. **`GET /api/v1/checkout/config`** returns `{ flatRateCents, freeShippingThresholdCents }`. The cart's "Free shipping on orders over $150" note then follows the admin setting instead of a hardcoded number.
3. **Admin order queue is storefront-only.** Walmart orders are shipped through the Walmart flow (`shipping.ts`), and "Mark shipped" there would skip the Walmart ship job.
4. **Paid orders with a `reviewReason` stay in "To ship"** with a visible reason. Shipping one requires `acknowledgeReview: true` (409 `REVIEW_REQUIRED` otherwise), so an AK or disputed order is not shipped by accident.
5. **The sweep also cancels stale pending storefront orders that have no session id.** These are left when the process crashes between `placeOrder` and saving the session id, and without this they would hold stock forever.
6. **Refund and dispute events for an unknown PaymentIntent return 503** and record nothing, so Stripe retries. This covers a refund that arrives before `checkout.session.completed`.
7. **The cart persists to `localStorage`.** Stripe's `return_url` is a full page load, so an in-memory cart would already be empty when §6 says to "clear the cart".
8. **`orders` rows gain a `SELECT … FOR UPDATE` row lock** in every transition. Without it, a webhook "paid" racing a sweep "cancel" can leave a paid order whose reservation was released.
9. **Ship-to columns are nullable.** Pending and Walmart orders have no address.

---

## File Structure

**Core (`systems/core`)**

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` | + `Customer`, `AffiliatePartner`, `ReferralCode`, `StripeEvent`, `ShopSetting`; `Order` checkout columns; `Variant` weight/dims (Task 1) |
| `prisma/migrations/20260927120000_revenue_loop_checkout/migration.sql` | **New.** One migration for §3, seeds `shop_settings` (Task 1) |
| `src/settings/defaults.ts` | **New.** Setting keys and defaults (Task 1) |
| `src/settings/shop-settings.service.ts` | **New.** `getShopSettings`, `updateShippingSettings` (Task 2) |
| `src/ports/shipping/shipping.port.ts`, `flat-rate.adapter.ts` | **New.** `ShippingPort`, flat-rate adapter (Task 2) |
| `src/referrals/referrals.service.ts` | **New.** Code normalising, window check, `resolveReferral` (Task 3) |
| `src/customers/customers.service.ts` | **New.** `upsertCustomerFromCheckout` (Task 3) |
| `src/ports/email/email.port.ts`, `noop.adapter.ts` | **New.** `EmailPort`, no-op adapter (Task 3) |
| `src/orders/orders.service.ts` | `OrderError.details`; row lock; `*Tx` transitions; `refundOrderTx`; checkout fields on `placeOrder` (Task 4) |
| `src/ports/tax/deferred.adapter.ts` | **New.** `deferredTaxAdapter` (Task 4) |
| `src/ports/payments/payments.port.ts`, `stripe.adapter.ts`, `fake.adapter.ts`, `index.ts` | **New.** `PaymentsPort`, Stripe adapter, test fake, env selection (Task 5) |
| `src/lib/rate-limit.ts` | **New.** Per-IP fixed-window limiter (Task 6) |
| `src/checkout/checkout-input.ts` | **New.** Request parsing, `CheckoutError` (Task 6) |
| `src/checkout/checkout.service.ts` | **New.** `startCheckout`, `getCheckoutStatus`, `getCheckoutConfig` (Task 6) |
| `src/checkout/checkout.routes.ts` | **New.** `POST /`, `GET /status`, `GET /config` (Task 6) |
| `src/orders/orders.routes.ts` | **Deleted** (Task 6) |
| `src/app.ts` | `AppDeps`; trust proxy; Stripe webhook before `express.json`; checkout + admin orders mounts (Tasks 6, 7, 9) |
| `src/payments/stripe-events.ts` | **New.** Dispatcher, de-dup, four handlers (Task 7) |
| `src/payments/stripe-webhook.routes.ts` | **New.** Raw-body handler (Task 7) |
| `src/checkout/sweep.ts` | **New.** `sweepAbandonedCheckouts`, `startCheckoutSweep` (Task 8) |
| `src/server.ts` | Shares one payments port with the app and the sweep (Task 8) |
| `src/admin/admin-orders.service.ts`, `admin-orders.routes.ts` | **New.** Queue, detail, ship, cancel, shipping settings (Task 9) |
| `src/admin/product-input.ts`, `variant-write.service.ts`, `admin-product.dto.ts` | Variant weight/dims (Task 9) |
| `tests/helpers/db.ts` | Deletes the new tables; restores shop settings (Task 1) |
| `tests/helpers/checkout.ts` | **New.** App-with-fake-payments, event builder, signer (Tasks 6–7) |
| `tests/capture-admin-fixtures.test.ts` | + order and settings fixtures (Task 9) |
| `render.yaml`, `docs/status/2026-09-27-stripe-test-mode-runbook.md` | Env keys; Jack's Stripe test-mode setup (Task 10) |

**Storefront (`systems/storefront/code`)**

| File | Responsibility |
|---|---|
| `src/lib/referral.ts` | **New.** Capture, read, expiry, `useReferralCapture` (Task 11) |
| `src/lib/cart/CartContext.tsx` | Persistence, 10-per-line cap, `clear()` (Task 11) |
| `src/lib/checkout/previousOrder.ts` | **New.** `previousOrderId` in `sessionStorage` (Task 11) |
| `src/lib/api/checkout.ts` | **New.** `startCheckout`, `getCheckoutStatus`, `getCheckoutConfig`, `CheckoutError` (Task 12) |
| `src/components/cart/CartPanel.tsx`, `CartDrawer.tsx` | **New.** Shared cart UI with opt-in and checkout start (Task 12) |
| `src/pages/Cart.tsx`, `src/pages/legal/Terms.tsx`, `Privacy.tsx` | **New** (Task 12) |
| `src/app/Root.tsx` | Cart button opens drawer; referral hook; legal footer links (Tasks 11–12) |
| `src/lib/stripe.ts` | **New.** Lazy `loadStripe` (Task 13) |
| `src/pages/Checkout.tsx`, `src/pages/OrderComplete.tsx` | **New** (Task 13) |
| `src/routes.tsx` | `cart`, `checkout`, `order/complete`, `legal/*` (Tasks 12–13) |

**Console (`systems/admin-ui`)**

| File | Responsibility |
|---|---|
| `src/data/api.js` | Order and settings methods (Task 15) |
| `src/orders/OrderQueue.jsx` | **New.** Tabs, paging (Task 15) |
| `src/orders/OrderDetail.jsx`, `ShipDialog.jsx` | **New.** Detail, ship, cancel (Task 16) |
| `src/settings/ShippingSettings.jsx` | **New** (Task 17) |
| `src/catalog/tabs/DimensionsDialog.jsx`, `VariantsTab.jsx` | Weight/dims editing (Task 17) |
| `src/shell/Nav.jsx`, `src/App.jsx`, `src/lib/errorText.js` | Nav entries, routes, labels (Tasks 15–17) |

---

# PR 1 — Core (`feat/revenue-loop-core`)

## Task 0: Baseline

**Files:** none.

- [ ] **Step 1: Database up**

Run: `docker start alpinebrick-core-db && docker exec alpinebrick-core-db pg_isready -U postgres`
Expected: `accepting connections`. If Docker will not start, follow the Docker Desktop recovery in memory note "Docker Desktop reparse-point failure". If it is still broken, CI is the verifier (Global Constraints).

- [ ] **Step 2: Branch**

```bash
cd projects/engineering
git checkout main && git pull --ff-only
git checkout -b feat/revenue-loop-core
```

- [ ] **Step 3: Green baseline**

Run in `systems/core`: `npx prisma migrate deploy && npx vitest run`
Expected: all tests pass. Record the count; later tasks compare against it.

---

## Task 1: Schema migration and shop-setting seed

**Files:**
- Modify: `systems/core/prisma/schema.prisma`
- Create: `systems/core/prisma/migrations/20260927120000_revenue_loop_checkout/migration.sql`
- Create: `systems/core/src/settings/defaults.ts`
- Modify: `systems/core/tests/helpers/db.ts`
- Test: `systems/core/tests/revenue-loop-schema.test.ts`

**Interfaces:**
- Produces: Prisma models `Customer`, `AffiliatePartner`, `ReferralCode`, `StripeEvent`, `ShopSetting`. Enum `OrderReviewReason = 'amount_mismatch' | 'paid_after_cancel' | 'outside_shipping_area' | 'disputed'`. Enum `AffiliatePartnerStatus = 'active' | 'inactive'`.
- Produces on `Order`: `customerId`, `shipName`, `shipLine1`, `shipLine2`, `shipCity`, `shipPostalCode` (all `string | null`); `shippingCents: number` (0); `stripeCheckoutSessionId`, `stripePaymentIntentId` (unique, nullable); `paidAt`, `shippedAt: Date | null`; `carrier`, `trackingNumber: string | null`; `refundedCents: number` (0); `reviewReason: OrderReviewReason | null`; `marketingOptIn: boolean` (false); `referralCode: string | null`; `referralFirstSeenAt: Date | null`; `affiliatePartnerId: string | null`; `commissionRateBps: number | null`; `referralUnmatched: boolean` (false).
- Produces on `Variant`: `weightGrams`, `lengthMm`, `widthMm`, `heightMm` (`number | null`).
- Produces: `SETTING_KEYS`, `SHOP_SETTING_DEFAULTS` from `src/settings/defaults.ts`. `resetDb()` now clears the new tables and restores the three settings.

- [ ] **Step 1: Write the failing test**

```ts
// tests/revenue-loop-schema.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { SHOP_SETTING_DEFAULTS } from '../src/settings/defaults.js'

beforeEach(async () => { await resetDb(); await seed() })
afterAll(() => prisma.$disconnect())

describe('revenue loop schema', () => {
  it('seeds the three shop settings with the spec defaults', async () => {
    const rows = await prisma.shopSetting.findMany({ orderBy: { key: 'asc' } })
    expect(Object.fromEntries(rows.map((r) => [r.key, r.value]))).toEqual({
      'checkout.session_minutes': 30,
      'shipping.flat_rate_cents': 995,
      'shipping.free_threshold_cents': 15000,
    })
    expect(SHOP_SETTING_DEFAULTS['shipping.flat_rate_cents']).toBe(995)
  })

  it('resetDb restores settings a test changed', async () => {
    await prisma.shopSetting.update({ where: { key: 'shipping.flat_rate_cents' }, data: { value: 1 } })
    await resetDb()
    expect((await prisma.shopSetting.findUniqueOrThrow({ where: { key: 'shipping.flat_rate_cents' } })).value).toBe(995)
  })

  it('gives existing-style orders the new defaults', async () => {
    const o = await prisma.order.create({
      data: { email: 'a@example.com', shipToState: 'MI', subtotalCents: 100, taxCents: 0, totalCents: 100, taxRateBps: 0, taxJurisdiction: 'none' },
    })
    expect(o).toMatchObject({
      shippingCents: 0, refundedCents: 0, marketingOptIn: false, referralUnmatched: false,
      reviewReason: null, stripeCheckoutSessionId: null, shipLine1: null,
    })
  })

  it('keeps customer emails unique', async () => {
    await prisma.customer.create({ data: { email: 'x@example.com' } })
    await expect(prisma.customer.create({ data: { email: 'x@example.com' } }))
      .rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
  })

  it('rejects a referral code outside the pattern', async () => {
    const p = await prisma.affiliatePartner.create({ data: { name: 'Partner' } })
    await expect(prisma.referralCode.create({ data: { code: 'Bad Code', partnerId: p.id, commissionRateBps: 500 } }))
      .rejects.toThrow()
    await expect(prisma.referralCode.create({ data: { code: 'good-code', partnerId: p.id, commissionRateBps: 500 } }))
      .resolves.toMatchObject({ active: true })
  })

  it('rejects a non-positive variant weight', async () => {
    const v = await prisma.variant.findFirstOrThrow({ where: { sku: 'BBS-STD' } })
    await expect(prisma.variant.update({ where: { id: v.id }, data: { weightGrams: 0 } })).rejects.toThrow()
    await expect(prisma.variant.update({ where: { id: v.id }, data: { weightGrams: 850, lengthMm: 380 } }))
      .resolves.toMatchObject({ weightGrams: 850, lengthMm: 380, widthMm: null })
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/revenue-loop-schema.test.ts`
Expected: FAIL — `Cannot find module '../src/settings/defaults.js'` / `prisma.shopSetting` undefined.

- [ ] **Step 3: Add the models to `prisma/schema.prisma`**

Add the enums after `enum OrderChannel`:

```prisma
enum OrderReviewReason {
  amount_mismatch
  paid_after_cancel
  outside_shipping_area
  disputed
}

enum AffiliatePartnerStatus {
  active
  inactive
}
```

Add to `model Variant`, after `channelListing ChannelListing?`:

```prisma
  // Optional shipping physicals (spec 2026-09-27 §3). Unused until a
  // carrier-rate adapter exists; the flat-rate adapter ignores them.
  weightGrams Int? @map("weight_grams")
  lengthMm    Int? @map("length_mm")
  widthMm     Int? @map("width_mm")
  heightMm    Int? @map("height_mm")
```

Add to `model Order`, after `lines OrderLine[]`:

```prisma
  // --- Storefront checkout (spec 2026-09-27 §3) ---------------------------
  customerId              String?            @map("customer_id")
  customer                Customer?          @relation(fields: [customerId], references: [id])
  // Nullable: a pending checkout order has no address until Stripe's webhook
  // writes it, and Walmart orders never carry one here.
  shipName                String?            @map("ship_name")
  shipLine1               String?            @map("ship_line1")
  shipLine2               String?            @map("ship_line2")
  shipCity                String?            @map("ship_city")
  shipPostalCode          String?            @map("ship_postal_code")
  shippingCents           Int                @default(0) @map("shipping_cents")
  stripeCheckoutSessionId String?            @unique @map("stripe_checkout_session_id")
  stripePaymentIntentId   String?            @unique @map("stripe_payment_intent_id")
  paidAt                  DateTime?          @map("paid_at")
  shippedAt               DateTime?          @map("shipped_at")
  carrier                 String?
  trackingNumber          String?            @map("tracking_number")
  refundedCents           Int                @default(0) @map("refunded_cents")
  reviewReason            OrderReviewReason? @map("review_reason")
  // The checkbox as submitted; applied to the Customer only at payment.
  marketingOptIn          Boolean            @default(false) @map("marketing_opt_in")
  referralCode            String?            @map("referral_code")
  referralFirstSeenAt     DateTime?          @map("referral_first_seen_at")
  affiliatePartnerId      String?            @map("affiliate_partner_id")
  affiliatePartner        AffiliatePartner?  @relation(fields: [affiliatePartnerId], references: [id])
  commissionRateBps       Int?               @map("commission_rate_bps")
  referralUnmatched       Boolean            @default(false) @map("referral_unmatched")
  @@index([status, createdAt])
  @@index([reviewReason])
  @@index([customerId])
```

(Move the existing `@@map("orders")` so it stays the last line of the model.)

Add the new models at the end of the file:

```prisma
model Customer {
  id                     String    @id @default(cuid())
  // Stored trimmed and lowercased (customers.service.ts normalises).
  email                  String    @unique
  name                   String?
  // Only ever goes false -> true from checkout; an order placed without the
  // box ticked never revokes an earlier opt-in (spec §3).
  marketingConsent       Boolean   @default(false) @map("marketing_consent")
  marketingConsentAt     DateTime? @map("marketing_consent_at")
  marketingConsentSource String?   @map("marketing_consent_source")
  createdAt              DateTime  @default(now()) @map("created_at")
  lastOrderAt            DateTime? @map("last_order_at")
  orders                 Order[]
  @@map("customers")
}

model AffiliatePartner {
  id        String                 @id @default(cuid())
  name      String
  status    AffiliatePartnerStatus @default(active)
  createdAt DateTime               @default(now()) @map("created_at")
  codes     ReferralCode[]
  orders    Order[]
  @@map("affiliate_partners")
}

model ReferralCode {
  // Lowercased, ^[a-z0-9-]{2,32}$ -- enforced by a CHECK in the migration.
  code              String           @id
  partnerId         String           @map("partner_id")
  partner           AffiliatePartner @relation(fields: [partnerId], references: [id])
  commissionRateBps Int              @map("commission_rate_bps")
  active            Boolean          @default(true)
  @@index([partnerId])
  @@map("referral_codes")
}

// One row per Stripe event we have applied. Inserted in the SAME transaction
// as the event's effects: a unique violation means "already processed".
model StripeEvent {
  id          String   @id
  type        String
  processedAt DateTime @default(now()) @map("processed_at")
  @@map("stripe_events")
}

// Key/value shop configuration. Every current setting is an integer (cents or
// minutes), so the value column is an INTEGER; NULL is meaningful
// (shipping.free_threshold_cents NULL = no free shipping).
model ShopSetting {
  key       String   @id
  value     Int?
  updatedAt DateTime @default(now()) @updatedAt @map("updated_at")
  @@map("shop_settings")
}
```

- [ ] **Step 4: Write the migration**

```sql
-- prisma/migrations/20260927120000_revenue_loop_checkout/migration.sql
-- Revenue loop checkout (spec docs/superpowers/specs/2026-09-27-revenue-loop-checkout-design.md §3).

CREATE TYPE "OrderReviewReason" AS ENUM ('amount_mismatch', 'paid_after_cancel', 'outside_shipping_area', 'disputed');
CREATE TYPE "AffiliatePartnerStatus" AS ENUM ('active', 'inactive');

CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "marketing_consent" BOOLEAN NOT NULL DEFAULT false,
    "marketing_consent_at" TIMESTAMP(3),
    "marketing_consent_source" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_order_at" TIMESTAMP(3),
    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "customers_email_key" ON "customers"("email");

CREATE TABLE "affiliate_partners" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "AffiliatePartnerStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "affiliate_partners_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "referral_codes" (
    "code" TEXT NOT NULL,
    "partner_id" TEXT NOT NULL,
    "commission_rate_bps" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("code")
);
CREATE INDEX "referral_codes_partner_id_idx" ON "referral_codes"("partner_id");
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_partner_id_fkey"
  FOREIGN KEY ("partner_id") REFERENCES "affiliate_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_code_format"
  CHECK ("code" ~ '^[a-z0-9-]{2,32}$');
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_rate_range"
  CHECK ("commission_rate_bps" BETWEEN 0 AND 10000);

CREATE TABLE "stripe_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shop_settings" (
    "key" TEXT NOT NULL,
    "value" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shop_settings_pkey" PRIMARY KEY ("key")
);
-- Placeholders from D2 (Jack, 2026-09-27); editable in the admin Settings page.
INSERT INTO "shop_settings" ("key", "value") VALUES
  ('shipping.flat_rate_cents', 995),
  ('shipping.free_threshold_cents', 15000),
  ('checkout.session_minutes', 30)
ON CONFLICT ("key") DO NOTHING;

ALTER TABLE "orders"
  ADD COLUMN "customer_id" TEXT,
  ADD COLUMN "ship_name" TEXT,
  ADD COLUMN "ship_line1" TEXT,
  ADD COLUMN "ship_line2" TEXT,
  ADD COLUMN "ship_city" TEXT,
  ADD COLUMN "ship_postal_code" TEXT,
  ADD COLUMN "shipping_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "stripe_checkout_session_id" TEXT,
  ADD COLUMN "stripe_payment_intent_id" TEXT,
  ADD COLUMN "paid_at" TIMESTAMP(3),
  ADD COLUMN "shipped_at" TIMESTAMP(3),
  ADD COLUMN "carrier" TEXT,
  ADD COLUMN "tracking_number" TEXT,
  ADD COLUMN "refunded_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "review_reason" "OrderReviewReason",
  ADD COLUMN "marketing_opt_in" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "referral_code" TEXT,
  ADD COLUMN "referral_first_seen_at" TIMESTAMP(3),
  ADD COLUMN "affiliate_partner_id" TEXT,
  ADD COLUMN "commission_rate_bps" INTEGER,
  ADD COLUMN "referral_unmatched" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "orders_stripe_checkout_session_id_key" ON "orders"("stripe_checkout_session_id");
CREATE UNIQUE INDEX "orders_stripe_payment_intent_id_key" ON "orders"("stripe_payment_intent_id");
CREATE INDEX "orders_status_created_at_idx" ON "orders"("status", "created_at");
CREATE INDEX "orders_review_reason_idx" ON "orders"("review_reason");
CREATE INDEX "orders_customer_id_idx" ON "orders"("customer_id");
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_affiliate_partner_id_fkey"
  FOREIGN KEY ("affiliate_partner_id") REFERENCES "affiliate_partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_money_nonnegative"
  CHECK ("shipping_cents" >= 0 AND "refunded_cents" >= 0);

ALTER TABLE "variants"
  ADD COLUMN "weight_grams" INTEGER,
  ADD COLUMN "length_mm" INTEGER,
  ADD COLUMN "width_mm" INTEGER,
  ADD COLUMN "height_mm" INTEGER;
ALTER TABLE "variants" ADD CONSTRAINT "variants_physicals_positive" CHECK (
  ("weight_grams" IS NULL OR "weight_grams" > 0) AND
  ("length_mm" IS NULL OR "length_mm" > 0) AND
  ("width_mm" IS NULL OR "width_mm" > 0) AND
  ("height_mm" IS NULL OR "height_mm" > 0)
);
```

- [ ] **Step 5: Settings defaults and the test helper**

```ts
// src/settings/defaults.ts
/** Shop setting keys (spec 2026-09-27 §3). The migration seeds these rows. */
export const SETTING_KEYS = {
  flatRateCents: 'shipping.flat_rate_cents',
  freeThresholdCents: 'shipping.free_threshold_cents',
  sessionMinutes: 'checkout.session_minutes',
} as const

/** Must match the INSERT in migration 20260927120000_revenue_loop_checkout. */
export const SHOP_SETTING_DEFAULTS: Readonly<Record<string, number | null>> = {
  'shipping.flat_rate_cents': 995,
  'shipping.free_threshold_cents': 15000,
  'checkout.session_minutes': 30,
}
```

In `tests/helpers/db.ts`, add the import `import { SHOP_SETTING_DEFAULTS } from '../../src/settings/defaults.js'`. Then, directly after `await prisma.order.deleteMany()`, insert:

```ts
  await prisma.stripeEvent.deleteMany()
  await prisma.customer.deleteMany()
  await prisma.referralCode.deleteMany()
  await prisma.affiliatePartner.deleteMany()
```

and at the end of `resetDb()` (after `prisma.actor.deleteMany()`):

```ts
  // Settings are seeded by the migration, not by tests -- restore rather than
  // delete, so a test that edits one cannot leak into the next file.
  for (const [key, value] of Object.entries(SHOP_SETTING_DEFAULTS)) {
    await prisma.shopSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }
```

- [ ] **Step 6: Apply, regenerate, verify no drift, run**

```bash
npx prisma migrate deploy
npx prisma generate
npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code
npx vitest run tests/revenue-loop-schema.test.ts
```
Expected: the migration applies. `migrate diff` prints `No difference detected.` and exits 0. If it prints SQL, the hand-written migration and the schema disagree, so fix the migration, not the schema. The test PASSES (6 tests).

- [ ] **Step 7: Full suite, then commit**

Run: `npx vitest run`. Expected: baseline count + 6, all passing.

```bash
git add systems/core/prisma systems/core/src/settings/defaults.ts systems/core/tests/helpers/db.ts systems/core/tests/revenue-loop-schema.test.ts
git commit -m "feat(core): revenue loop schema — customers, referrals, stripe events, shop settings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: Shop settings service and the flat-rate ShippingPort

**Files:**
- Create: `systems/core/src/settings/shop-settings.service.ts`
- Create: `systems/core/src/ports/shipping/shipping.port.ts`
- Create: `systems/core/src/ports/shipping/flat-rate.adapter.ts`
- Test: `systems/core/tests/shop-settings.test.ts`, `systems/core/tests/shipping-flat-rate.test.ts`

**Interfaces:**
- Consumes: `SETTING_KEYS`, `SHOP_SETTING_DEFAULTS` (Task 1); `AdminError` (`src/admin/admin-errors.ts`); `recordAudit`.
- Produces:
  - `interface ShopSettings { flatRateCents: number; freeThresholdCents: number | null; sessionMinutes: number }`
  - `getShopSettings(db?: Pick<Prisma.TransactionClient, 'shopSetting'>): Promise<ShopSettings>`
  - `updateShippingSettings(body: unknown, actorId: string): Promise<ShopSettings>`. Throws `AdminError('VALIDATION_ERROR', …, fields)`. Audit action `shop_settings.update`, target `shop_settings:shipping`.
  - `interface ShippingOption { displayName: string; amountCents: number }`
  - `interface ShippingQuoteInput { subtotalCents: number; lines: { variantId: string; quantity: number }[] }`
  - `interface ShippingPort { quote(input: ShippingQuoteInput): Promise<ShippingOption[]> }`
  - `createFlatRateShippingPort(readSettings?: () => Promise<ShopSettings>): ShippingPort`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/shop-settings.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { getShopSettings, updateShippingSettings } from '../src/settings/shop-settings.service.js'

let actorId: string
beforeEach(async () => {
  await resetDb()
  actorId = (await prisma.actor.create({ data: { type: 'human', name: 'Jack' } })).id
})
afterAll(() => prisma.$disconnect())

describe('shop settings', () => {
  it('reads the seeded defaults', async () => {
    expect(await getShopSettings()).toEqual({ flatRateCents: 995, freeThresholdCents: 15000, sessionMinutes: 30 })
  })

  it('updates shipping settings and audits before/after', async () => {
    const out = await updateShippingSettings({ flatRateCents: 1295, freeThresholdCents: null }, actorId)
    expect(out).toEqual({ flatRateCents: 1295, freeThresholdCents: null, sessionMinutes: 30 })
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'shop_settings.update' } })
    expect(audit.target).toBe('shop_settings:shipping')
    expect(audit.before).toEqual({ flatRateCents: 995, freeThresholdCents: 15000 })
    expect(audit.after).toEqual({ flatRateCents: 1295, freeThresholdCents: null })
  })

  it('rejects bad input with field messages and writes nothing', async () => {
    await expect(updateShippingSettings({ flatRateCents: -1, freeThresholdCents: 0 }, actorId))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', fields: { flatRateCents: expect.any(String), freeThresholdCents: expect.any(String) } })
    await expect(updateShippingSettings({ flatRateCents: 995 }, actorId))
      .rejects.toMatchObject({ fields: { freeThresholdCents: expect.any(String) } })
    await expect(updateShippingSettings({ flatRateCents: 995, freeThresholdCents: 100, extra: 1 }, actorId))
      .rejects.toMatchObject({ fields: { extra: 'unknown field' } })
    expect(await prisma.auditLog.count()).toBe(0)
  })
})
```

```ts
// tests/shipping-flat-rate.test.ts
import { describe, it, expect } from 'vitest'
import { createFlatRateShippingPort } from '../src/ports/shipping/flat-rate.adapter.js'

const settings = (freeThresholdCents: number | null) => async () =>
  ({ flatRateCents: 995, freeThresholdCents, sessionMinutes: 30 })

describe('flat-rate shipping', () => {
  it('charges the flat rate below the threshold', async () => {
    const port = createFlatRateShippingPort(settings(15000))
    expect(await port.quote({ subtotalCents: 14999, lines: [] }))
      .toEqual([{ displayName: 'Standard shipping', amountCents: 995 }])
  })

  it('is free at or above the threshold', async () => {
    const port = createFlatRateShippingPort(settings(15000))
    expect(await port.quote({ subtotalCents: 15000, lines: [] }))
      .toEqual([{ displayName: 'Free shipping', amountCents: 0 }])
  })

  it('never frees shipping when the threshold is null', async () => {
    const port = createFlatRateShippingPort(settings(null))
    expect(await port.quote({ subtotalCents: 1_000_000, lines: [] }))
      .toEqual([{ displayName: 'Standard shipping', amountCents: 995 }])
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/shop-settings.test.ts tests/shipping-flat-rate.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

```ts
// src/settings/shop-settings.service.ts
import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { recordAudit } from '../audit.js'
import { AdminError } from '../admin/admin-errors.js'
import { SETTING_KEYS, SHOP_SETTING_DEFAULTS } from './defaults.js'

export interface ShopSettings {
  flatRateCents: number
  /** null = no free shipping. */
  freeThresholdCents: number | null
  sessionMinutes: number
}

type Db = Pick<Prisma.TransactionClient, 'shopSetting'>

/** A missing row falls back to the seeded default; a present NULL is kept. */
export async function getShopSettings(db: Db = prisma): Promise<ShopSettings> {
  const rows = await db.shopSetting.findMany()
  const byKey = new Map(rows.map((r) => [r.key, r.value]))
  const read = (key: string): number | null =>
    byKey.has(key) ? (byKey.get(key) as number | null) : (SHOP_SETTING_DEFAULTS[key] ?? null)
  return {
    flatRateCents: read(SETTING_KEYS.flatRateCents) ?? (SHOP_SETTING_DEFAULTS[SETTING_KEYS.flatRateCents] as number),
    freeThresholdCents: read(SETTING_KEYS.freeThresholdCents),
    sessionMinutes: read(SETTING_KEYS.sessionMinutes) ?? (SHOP_SETTING_DEFAULTS[SETTING_KEYS.sessionMinutes] as number),
  }
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const ALLOWED = ['flatRateCents', 'freeThresholdCents']

/** Both fields are required: the Settings page always sends the pair. */
export async function updateShippingSettings(body: unknown, actorId: string): Promise<ShopSettings> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AdminError('VALIDATION_ERROR', 'body must be a JSON object')
  }
  const b = body as Record<string, unknown>
  const fields: Record<string, string> = {}
  for (const k of Object.keys(b)) if (!ALLOWED.includes(k)) fields[k] = 'unknown field'
  if (!isInt(b.flatRateCents) || b.flatRateCents < 0 || b.flatRateCents > 100_000) {
    fields.flatRateCents = 'a whole number of cents from 0 to 100000'
  }
  const t = b.freeThresholdCents
  if (!('freeThresholdCents' in b) || (t !== null && (!isInt(t) || t < 1 || t > 10_000_000))) {
    fields.freeThresholdCents = 'a whole number of cents from 1 to 10000000, or null for no free shipping'
  }
  if (Object.keys(fields).length > 0) throw new AdminError('VALIDATION_ERROR', 'invalid input', fields)

  const flatRateCents = b.flatRateCents as number
  const freeThresholdCents = t as number | null
  await prisma.$transaction(async (tx) => {
    const before = await getShopSettings(tx)
    await tx.shopSetting.upsert({
      where: { key: SETTING_KEYS.flatRateCents },
      create: { key: SETTING_KEYS.flatRateCents, value: flatRateCents },
      update: { value: flatRateCents },
    })
    await tx.shopSetting.upsert({
      where: { key: SETTING_KEYS.freeThresholdCents },
      create: { key: SETTING_KEYS.freeThresholdCents, value: freeThresholdCents },
      update: { value: freeThresholdCents },
    })
    await recordAudit({
      actorId, action: 'shop_settings.update', target: 'shop_settings:shipping',
      before: { flatRateCents: before.flatRateCents, freeThresholdCents: before.freeThresholdCents },
      after: { flatRateCents, freeThresholdCents },
    }, tx)
  })
  return getShopSettings()
}
```

```ts
// src/ports/shipping/shipping.port.ts
export interface ShippingQuoteInput {
  subtotalCents: number
  /** Unused by the flat-rate adapter; a carrier adapter needs the variants' weights. */
  lines: { variantId: string; quantity: number }[]
}

export interface ShippingOption {
  displayName: string
  amountCents: number
}

/** Spec §3 / D2: flat rate at launch; a carrier-rate adapter may follow. */
export interface ShippingPort {
  quote(input: ShippingQuoteInput): Promise<ShippingOption[]>
}
```

```ts
// src/ports/shipping/flat-rate.adapter.ts
import type { ShippingPort } from './shipping.port.js'
import { getShopSettings, type ShopSettings } from '../../settings/shop-settings.service.js'

/** $X per order, free at or above the threshold (both from ShopSetting). */
export function createFlatRateShippingPort(
  readSettings: () => Promise<ShopSettings> = () => getShopSettings(),
): ShippingPort {
  return {
    async quote({ subtotalCents }) {
      const s = await readSettings()
      if (s.freeThresholdCents !== null && subtotalCents >= s.freeThresholdCents) {
        return [{ displayName: 'Free shipping', amountCents: 0 }]
      }
      return [{ displayName: 'Standard shipping', amountCents: s.flatRateCents }]
    },
  }
}
```

- [ ] **Step 4: Run, then commit**

Run: `npx vitest run tests/shop-settings.test.ts tests/shipping-flat-rate.test.ts`. Expected: PASS (6 tests).

```bash
git add systems/core/src/settings systems/core/src/ports/shipping systems/core/tests/shop-settings.test.ts systems/core/tests/shipping-flat-rate.test.ts
git commit -m "feat(core): shop settings service and flat-rate shipping port" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3: Referrals, customers, and the email seam

**Files:**
- Create: `systems/core/src/referrals/referrals.service.ts`
- Create: `systems/core/src/customers/customers.service.ts`
- Create: `systems/core/src/ports/email/email.port.ts`
- Create: `systems/core/src/ports/email/noop.adapter.ts`
- Test: `systems/core/tests/referrals.test.ts`, `systems/core/tests/customers.test.ts`

**Interfaces:**
- Produces:
  - `REFERRAL_CODE_RE = /^[a-z0-9-]{2,32}$/`, `REFERRAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000`
  - `normalizeReferralCode(raw: unknown): string | null`
  - `parseReferralInput(raw: unknown, now?: Date): { code: string; firstSeenAt: Date } | null`
  - `resolveReferral(code: string, db?: Pick<Prisma.TransactionClient, 'referralCode'>): Promise<{ partnerId: string; commissionRateBps: number } | null>`
  - `CONSENT_WORDING = 'Email me about new sets and restocks'`, `CONSENT_SOURCE`
  - `normalizeEmail(email: string): string`
  - `upsertCustomerFromCheckout(input: { email: string; name: string | null; consent: boolean; at?: Date }, db?: Pick<Prisma.TransactionClient, 'customer'>): Promise<{ id: string }>`
  - `interface OrderPaidEmail { orderId: string; orderNumber: string; email: string }`
  - `interface EmailPort { orderPaid(input: OrderPaidEmail): Promise<void> }`
  - `noopEmailAdapter: EmailPort`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/referrals.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { normalizeReferralCode, parseReferralInput, resolveReferral } from '../src/referrals/referrals.service.js'

beforeEach(() => resetDb())
afterAll(() => prisma.$disconnect())

const NOW = new Date('2026-10-01T12:00:00Z')

describe('referral input', () => {
  it('lowercases and trims a valid code', () => {
    expect(normalizeReferralCode('  Brick-Club ')).toBe('brick-club')
  })

  it('drops codes outside the pattern', () => {
    for (const bad of ['a', 'x'.repeat(33), 'has space', 'semi;colon', 42, null]) {
      expect(normalizeReferralCode(bad)).toBeNull()
    }
  })

  it('accepts a first-seen time inside the 30-day window', () => {
    expect(parseReferralInput({ code: 'club', firstSeenAt: '2026-09-15T00:00:00Z' }, NOW))
      .toEqual({ code: 'club', firstSeenAt: new Date('2026-09-15T00:00:00Z') })
  })

  it('drops a referral older than 30 days, in the future, or with a bad date', () => {
    expect(parseReferralInput({ code: 'club', firstSeenAt: '2026-08-31T11:59:00Z' }, NOW)).toBeNull()
    expect(parseReferralInput({ code: 'club', firstSeenAt: '2026-10-01T12:10:00Z' }, NOW)).toBeNull()
    expect(parseReferralInput({ code: 'club', firstSeenAt: 'yesterday' }, NOW)).toBeNull()
    expect(parseReferralInput({ code: 'bad code', firstSeenAt: '2026-09-30T00:00:00Z' }, NOW)).toBeNull()
    expect(parseReferralInput(null, NOW)).toBeNull()
  })
})

describe('resolveReferral', () => {
  async function partner(status: 'active' | 'inactive', code: string, active = true) {
    const p = await prisma.affiliatePartner.create({ data: { name: `P-${code}`, status } })
    await prisma.referralCode.create({ data: { code, partnerId: p.id, commissionRateBps: 750, active } })
    return p
  }

  it('returns partner and rate for an active code of an active partner', async () => {
    const p = await partner('active', 'club')
    expect(await resolveReferral('club')).toEqual({ partnerId: p.id, commissionRateBps: 750 })
  })

  it('returns null for unknown, inactive codes and inactive partners', async () => {
    await partner('active', 'off', false)
    await partner('inactive', 'gone')
    expect(await resolveReferral('nobody')).toBeNull()
    expect(await resolveReferral('off')).toBeNull()
    expect(await resolveReferral('gone')).toBeNull()
  })
})
```

```ts
// tests/customers.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { upsertCustomerFromCheckout, CONSENT_SOURCE } from '../src/customers/customers.service.js'

beforeEach(() => resetDb())
afterAll(() => prisma.$disconnect())

const T1 = new Date('2026-10-01T00:00:00Z')
const T2 = new Date('2026-10-05T00:00:00Z')

describe('upsertCustomerFromCheckout', () => {
  it('creates a customer with a normalised email and consent when ticked', async () => {
    const { id } = await upsertCustomerFromCheckout({ email: '  Buyer@Example.COM ', name: 'Ann Buyer', consent: true, at: T1 })
    const c = await prisma.customer.findUniqueOrThrow({ where: { id } })
    expect(c).toMatchObject({
      email: 'buyer@example.com', name: 'Ann Buyer', marketingConsent: true,
      marketingConsentAt: T1, marketingConsentSource: CONSENT_SOURCE, lastOrderAt: T1,
    })
  })

  it('finds the same customer by email and never revokes consent', async () => {
    const a = await upsertCustomerFromCheckout({ email: 'b@example.com', name: 'B', consent: true, at: T1 })
    const b = await upsertCustomerFromCheckout({ email: 'B@example.com', name: null, consent: false, at: T2 })
    expect(b.id).toBe(a.id)
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: a.id } })
    expect(c).toMatchObject({ name: 'B', marketingConsent: true, marketingConsentAt: T1, lastOrderAt: T2 })
  })

  it('turns consent on later without changing it when already on', async () => {
    await upsertCustomerFromCheckout({ email: 'c@example.com', name: null, consent: false, at: T1 })
    await upsertCustomerFromCheckout({ email: 'c@example.com', name: null, consent: true, at: T2 })
    await upsertCustomerFromCheckout({ email: 'c@example.com', name: null, consent: true, at: new Date('2026-11-01T00:00:00Z') })
    const c = await prisma.customer.findUniqueOrThrow({ where: { email: 'c@example.com' } })
    expect(c.marketingConsent).toBe(true)
    expect(c.marketingConsentAt).toEqual(T2)
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/referrals.test.ts tests/customers.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

```ts
// src/referrals/referrals.service.ts
import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'

export const REFERRAL_CODE_RE = /^[a-z0-9-]{2,32}$/
export const REFERRAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
/** Tolerated client clock skew for a first-seen time in the "future". */
const FUTURE_SKEW_MS = 5 * 60 * 1000

export function normalizeReferralCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const code = raw.trim().toLowerCase()
  return REFERRAL_CODE_RE.test(code) ? code : null
}

/**
 * Spec §4: an invalid referral is DROPPED, never a reason to reject checkout.
 * The storefront enforces the 30-day window too; this repeats it because the
 * browser's value is not trusted.
 */
export function parseReferralInput(raw: unknown, now = new Date()): { code: string; firstSeenAt: Date } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { code, firstSeenAt } = raw as Record<string, unknown>
  const normalized = normalizeReferralCode(code)
  if (!normalized || typeof firstSeenAt !== 'string') return null
  const seen = new Date(firstSeenAt)
  const t = seen.getTime()
  if (Number.isNaN(t)) return null
  if (t > now.getTime() + FUTURE_SKEW_MS) return null
  if (now.getTime() - t > REFERRAL_WINDOW_MS) return null
  return { code: normalized, firstSeenAt: seen }
}

/** The partner and rate to snapshot on a paid order, or null (unmatched). */
export async function resolveReferral(
  code: string,
  db: Pick<Prisma.TransactionClient, 'referralCode'> = prisma,
): Promise<{ partnerId: string; commissionRateBps: number } | null> {
  const row = await db.referralCode.findUnique({ where: { code }, include: { partner: true } })
  if (!row || !row.active || row.partner.status !== 'active') return null
  return { partnerId: row.partnerId, commissionRateBps: row.commissionRateBps }
}
```

```ts
// src/customers/customers.service.ts
import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'

/** The storefront checkbox label, verbatim (spec §6, D8). */
export const CONSENT_WORDING = 'Email me about new sets and restocks'
/** Recorded with the consent so the exact wording agreed to is on file. */
export const CONSENT_SOURCE = `storefront_checkout: "${CONSENT_WORDING}"`

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Find-or-create by email (D3). Consent only ever goes false -> true, and the
 * first opt-in's timestamp is kept (spec §3).
 *
 * The upsert is on the unique email, so two webhooks for the same new
 * customer cannot create two rows. Consent is a separate conditional
 * UPDATE (`marketingConsent: false` in the WHERE), so a repeat opt-in never
 * moves the original timestamp.
 */
export async function upsertCustomerFromCheckout(
  input: { email: string; name: string | null; consent: boolean; at?: Date },
  db: Pick<Prisma.TransactionClient, 'customer'> = prisma,
): Promise<{ id: string }> {
  const email = normalizeEmail(input.email)
  const at = input.at ?? new Date()
  const consent = { marketingConsent: true, marketingConsentAt: at, marketingConsentSource: CONSENT_SOURCE }
  const customer = await db.customer.upsert({
    where: { email },
    create: { email, name: input.name, lastOrderAt: at, ...(input.consent ? consent : {}) },
    update: { lastOrderAt: at, ...(input.name ? { name: input.name } : {}) },
    select: { id: true },
  })
  if (input.consent) {
    await db.customer.updateMany({ where: { id: customer.id, marketingConsent: false }, data: consent })
  }
  return customer
}
```

```ts
// src/ports/email/email.port.ts
export interface OrderPaidEmail {
  orderId: string
  orderNumber: string
  email: string
}

/**
 * Transactional email seam (D5). Stripe sends receipts at launch; nothing
 * but the webhook's single orderPaid call uses this until shipped/tracking
 * emails land.
 */
export interface EmailPort {
  orderPaid(input: OrderPaidEmail): Promise<void>
}
```

```ts
// src/ports/email/noop.adapter.ts
import type { EmailPort } from './email.port.js'

export const noopEmailAdapter: EmailPort = {
  async orderPaid() {
    // Intentionally empty (D5): Stripe's receipt is the customer's email.
  },
}
```

- [ ] **Step 4: Run, then commit**

Run: `npx vitest run tests/referrals.test.ts tests/customers.test.ts`. Expected: PASS (9 tests).

```bash
git add systems/core/src/referrals systems/core/src/customers systems/core/src/ports/email systems/core/tests/referrals.test.ts systems/core/tests/customers.test.ts
git commit -m "feat(core): referral resolution, customer upsert and the email port" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: Orders service — structured errors, row lock, transaction-scoped transitions, refunds

**Files:**
- Modify: `systems/core/src/orders/orders.service.ts`
- Create: `systems/core/src/ports/tax/deferred.adapter.ts`
- Test: `systems/core/tests/orders-checkout-support.test.ts`

**Interfaces:**
- Consumes: `storefrontSellable(onHand, reserved, allocation)` from `src/inventory/allocation.ts`.
- Produces (all exported from `src/orders/orders.service.ts`):
  - `class OrderError extends Error { code: string; details?: Record<string, unknown> }`. Its constructor is `(code, message, details?)`. `insufficient_stock` carries `{ variantId, available }`; `variant_not_found` carries `{ variantId }`.
  - `PENDING_CHECKOUT_EMAIL = 'pending@checkout.invalid'`
  - `PlaceOrderInput` gains `marketingOptIn?: boolean` and `referral?: { code: string; firstSeenAt: Date } | null`.
  - `type OrderWithLines = Prisma.OrderGetPayload<{ include: { lines: true } }>`
  - `lockOrderRow(tx: Prisma.TransactionClient, orderId: string): Promise<OrderWithLines | null>`. Takes `SELECT … FOR UPDATE`.
  - `markOrderPaidTx(tx, orderId: string, actorId?: string, data?: Prisma.OrderUncheckedUpdateInput): Promise<OrderWithLines>`
  - `cancelOrderTx(tx, orderId: string, actorId?: string, opts?: TransitionOptions): Promise<OrderWithLines>`
  - `refundOrderTx(tx, orderId: string, input: { refundedCents: number; full: boolean }, actorId?: string): Promise<{ order: OrderWithLines; releasedVariantIds: string[] }>`. Audit actions `order.refunded` and `order.refund_partial`.
  - `enqueueInventoryPushesAfterCommit(variantIds: string[], context: string): Promise<void>` (now exported)
  - `deferredTaxAdapter: TaxPort` from `src/ports/tax/deferred.adapter.ts`. It returns `{ taxCents: 0, rateBps: 0, jurisdiction: 'stripe_tax_pending' }`.
- `markOrderPaid`, `fulfillOrder`, `cancelOrder` keep their signatures and behaviour.

- [ ] **Step 1: Write the failing test**

```ts
// tests/orders-checkout-support.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import {
  placeOrder, markOrderPaid, fulfillOrder, cancelOrder, refundOrderTx, OrderError, PENDING_CHECKOUT_EMAIL,
} from '../src/orders/orders.service.js'
import { deferredTaxAdapter } from '../src/ports/tax/deferred.adapter.js'

beforeEach(async () => { await resetDb(); await seed() })
afterAll(() => prisma.$disconnect())

async function vid(sku: string) { return (await prisma.variant.findFirstOrThrow({ where: { sku } })).id }
async function inv(variantId: string) { return prisma.inventory.findFirstOrThrow({ where: { variantId } }) }
const pending = (variantId: string, quantity = 1) => placeOrder(
  { email: PENDING_CHECKOUT_EMAIL, shipToState: '', lines: [{ variantId, quantity }] }, deferredTaxAdapter,
)
const refund = (orderId: string, refundedCents: number, full: boolean) =>
  prisma.$transaction((tx) => refundOrderTx(tx, orderId, { refundedCents, full }))

describe('placeOrder for checkout', () => {
  it('records opt-in and referral, with tax deferred to Stripe', async () => {
    const v = await vid('BBS-STD')
    const o = await placeOrder({
      email: PENDING_CHECKOUT_EMAIL, shipToState: '', lines: [{ variantId: v, quantity: 2 }],
      marketingOptIn: true, referral: { code: 'club', firstSeenAt: new Date('2026-09-20T00:00:00Z') },
    }, deferredTaxAdapter)
    const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(row).toMatchObject({
      taxCents: 0, taxRateBps: 0, taxJurisdiction: 'stripe_tax_pending', totalCents: 9998,
      marketingOptIn: true, referralCode: 'club', referralFirstSeenAt: new Date('2026-09-20T00:00:00Z'),
    })
  })

  it('reports how many units are available on insufficient stock', async () => {
    const v = await vid('CMP-LTD') // onHand 8
    await pending(v, 3)
    const err = await pending(v, 6).catch((e) => e)
    expect(err).toBeInstanceOf(OrderError)
    expect(err).toMatchObject({ code: 'insufficient_stock', details: { variantId: v, available: 5 } })
  })

  it('names the missing variant', async () => {
    await expect(pending('nope')).rejects.toMatchObject({ code: 'variant_not_found', details: { variantId: 'nope' } })
  })
})

describe('refundOrderTx', () => {
  it('full refund of a paid order releases the reservation', async () => {
    const v = await vid('BBS-STD')
    const o = await pending(v, 2)
    await markOrderPaid(o.id)
    const { releasedVariantIds } = await refund(o.id, 9998, true)
    expect(releasedVariantIds).toEqual([v])
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ status: 'refunded', refundedCents: 9998 })
    expect(await inv(v)).toMatchObject({ onHand: 25, reserved: 0 })
    expect(await prisma.auditLog.count({ where: { action: 'order.refunded', target: `order:${o.id}` } })).toBe(1)
  })

  it('full refund after shipment leaves stock alone', async () => {
    const v = await vid('BBS-STD')
    const o = await pending(v, 1)
    await markOrderPaid(o.id)
    await fulfillOrder(o.id)
    const { releasedVariantIds } = await refund(o.id, 4999, true)
    expect(releasedVariantIds).toEqual([])
    expect(await inv(v)).toMatchObject({ onHand: 24, reserved: 0 })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('refunded')
  })

  it('partial refund changes the amount only', async () => {
    const v = await vid('BBS-STD')
    const o = await pending(v, 2)
    await markOrderPaid(o.id)
    await refund(o.id, 1000, false)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ status: 'paid', refundedCents: 1000 })
    expect((await inv(v)).reserved).toBe(2)
  })

  it('full refund of a cancelled order does not release twice', async () => {
    const v = await vid('BBS-STD')
    const o = await pending(v, 1)
    await cancelOrder(o.id)
    await refund(o.id, 4999, true)
    expect(await inv(v)).toMatchObject({ onHand: 25, reserved: 0 })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('refunded')
  })

  it('refuses a full refund of a pending order', async () => {
    const o = await pending(await vid('BBS-STD'))
    await expect(refund(o.id, 4999, true)).rejects.toMatchObject({ code: 'invalid_transition' })
  })
})

describe('transitions lock the order row', () => {
  // Without SELECT ... FOR UPDATE, paid and cancel can both read `pending`:
  // cancel releases the hold, then paid overwrites the status -- a paid order
  // with no reservation. With the lock, whichever runs second sees the first's
  // result. paid-then-cancel is legal (cancel accepts paid), so every
  // interleaving must end cancelled with nothing reserved.
  it('paid racing cancel always ends cancelled with the hold released', async () => {
    const v = await vid('BBS-STD')
    for (let i = 0; i < 8; i++) {
      const o = await pending(v, 1)
      await Promise.allSettled([markOrderPaid(o.id), cancelOrder(o.id)])
      expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('cancelled')
      expect((await inv(v)).reserved).toBe(0)
    }
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/orders-checkout-support.test.ts`
Expected: FAIL — `deferred.adapter.js` not found; `refundOrderTx` / `PENDING_CHECKOUT_EMAIL` not exported.

- [ ] **Step 3: The deferred tax adapter**

```ts
// src/ports/tax/deferred.adapter.ts
import type { TaxPort } from './tax.port.js'

/**
 * Storefront checkout orders are placed before Stripe knows the ship-to
 * address. Stripe Tax computes tax inside the Checkout Session (D1), and the
 * checkout.session.completed webhook writes the real figures. The MI 6%
 * flat-rate adapter stays for tests and any non-Stripe path.
 */
export const deferredTaxAdapter: TaxPort = {
  async computeTax() {
    return { taxCents: 0, rateBps: 0, jurisdiction: 'stripe_tax_pending' }
  },
}
```

- [ ] **Step 4: Change `src/orders/orders.service.ts`**

4a. Imports: add `import { storefrontSellable } from '../inventory/allocation.js'`.

4b. Replace the `OrderError` class and add the constant:

```ts
export class OrderError extends Error {
  constructor(public code: string, message: string, public details?: Record<string, unknown>) {
    super(message)
    this.name = 'OrderError'
  }
}

/** A pending checkout order's email until Stripe's webhook writes the real one (spec §3). */
export const PENDING_CHECKOUT_EMAIL = 'pending@checkout.invalid'

export type OrderWithLines = Prisma.OrderGetPayload<{ include: { lines: true } }>
```

(The file's existing `import type { Prisma } from '@prisma/client'` covers `Prisma.OrderGetPayload`, `Prisma.TransactionClient` and `Prisma.OrderUncheckedUpdateInput`. All three are types, so the import does not change.)

4c. Extend `PlaceOrderInput`:

```ts
export interface PlaceOrderInput {
  email: string
  shipToState: string
  lines: { variantId: string; quantity: number }[]
  actorId?: string
  /** The storefront checkbox as submitted; applied to the Customer at payment. */
  marketingOptIn?: boolean
  /** Snapshotted now; partner and rate are resolved by the webhook at payment. */
  referral?: { code: string; firstSeenAt: Date } | null
}
```

4d. In `placeOrder`, change the not-found throw to:

```ts
      if (!variant) throw new OrderError('variant_not_found', `no published variant ${line.variantId}`, { variantId: line.variantId })
```

and the reservation failure to:

```ts
      if (affected === 0) {
        // The UPDATE matched nothing (not an error), so the transaction is
        // still usable: read what IS available so the storefront can say
        // "Only N left" instead of a bare failure.
        const row = await tx.inventory.findUnique({ where: { variantId: line.variantId } })
        const available = row ? storefrontSellable(row.onHand, row.reserved, row.walmartAllocation) : 0
        throw new OrderError('insufficient_stock', `not enough stock for variant ${line.variantId}`, { variantId: line.variantId, available })
      }
```

and add to the `tx.order.create` `data` object, after `taxJurisdiction: tax.jurisdiction,`:

```ts
        marketingOptIn: input.marketingOptIn ?? false,
        referralCode: input.referral?.code ?? null,
        referralFirstSeenAt: input.referral?.firstSeenAt ?? null,
```

4e. Export the post-commit helper: change `async function enqueueInventoryPushesAfterCommit(` to `export async function enqueueInventoryPushesAfterCommit(`.

4f. Replace `loadOrderForUpdate`, `markOrderPaid` and `cancelOrder` with the following. `fulfillOrder` keeps its body, and its `loadOrderForUpdate(tx, orderId)` call now takes the lock too.

```ts
/**
 * Row-locks the order for the rest of the transaction. Every transition
 * goes through here: without the lock, two transitions (the Stripe webhook's
 * paid and the sweep's cancel, say) can both read `pending` and both write,
 * leaving a paid order whose reservation was released. With it, the second
 * waits, then re-reads the committed status (READ COMMITTED takes a fresh
 * snapshot per statement) and refuses.
 */
export async function lockOrderRow(tx: Prisma.TransactionClient, orderId: string): Promise<OrderWithLines | null> {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`
  return tx.order.findUnique({ where: { id: orderId }, include: { lines: true } })
}

async function loadOrderForUpdate(tx: Prisma.TransactionClient, orderId: string): Promise<OrderWithLines> {
  const order = await lockOrderRow(tx, orderId)
  if (!order) throw new OrderError('order_not_found', `no order ${orderId}`)
  return order
}

/** pending -> paid inside the caller's transaction. `data` is written with the status change. */
export async function markOrderPaidTx(
  tx: Prisma.TransactionClient,
  orderId: string,
  actorId = 'system',
  data: Prisma.OrderUncheckedUpdateInput = {},
): Promise<OrderWithLines> {
  const order = await loadOrderForUpdate(tx, orderId)
  if (order.status !== 'pending') {
    throw new OrderError('invalid_transition', `cannot mark ${order.status} order as paid`)
  }
  const next = await tx.order.update({ where: { id: orderId }, data: { ...data, status: 'paid' }, include: { lines: true } })
  await recordAudit({ actorId, action: 'order.paid', target: `order:${orderId}`, before: { status: 'pending' }, after: { status: 'paid' } }, tx)
  return next
}

export async function markOrderPaid(orderId: string, actorId = 'system'): Promise<OrderDto> {
  return toDto(await prisma.$transaction((tx) => markOrderPaidTx(tx, orderId, actorId)))
}

/** pending|paid -> cancelled inside the caller's transaction; releases the reservation. */
export async function cancelOrderTx(
  tx: Prisma.TransactionClient,
  orderId: string,
  actorId = 'system',
  opts: TransitionOptions = {},
): Promise<OrderWithLines> {
  const order = await loadOrderForUpdate(tx, orderId)
  if (order.status !== 'pending' && order.status !== 'paid') {
    throw new OrderError('invalid_transition', `cannot cancel a ${order.status} order`)
  }
  for (const line of order.lines) {
    // (keep the existing comment block from cancelOrder here verbatim)
    const affected = order.channel === 'walmart'
      ? await tx.$executeRaw`
          UPDATE inventory
          SET reserved = reserved - ${line.quantity},
              walmart_allocation = CASE WHEN walmart_allocation IS NULL THEN NULL
                                        ELSE walmart_allocation + ${line.quantity} END
          WHERE variant_id = ${line.variantId} AND reserved >= ${line.quantity}`
      : await tx.$executeRaw`
          UPDATE inventory SET reserved = reserved - ${line.quantity}
          WHERE variant_id = ${line.variantId} AND reserved >= ${line.quantity}`
    if (affected === 0) throw new OrderError('inventory_conflict', `cannot release reservation for variant ${line.variantId}`)
  }
  const next = await tx.order.update({ where: { id: orderId }, data: { status: 'cancelled' }, include: { lines: true } })
  await recordAudit({ actorId, action: 'order.cancelled', target: `order:${orderId}`, after: { status: 'cancelled' } }, tx)
  if (opts.inTransaction) await opts.inTransaction(tx)
  return next
}

export async function cancelOrder(orderId: string, actorId = 'system', opts: TransitionOptions = {}): Promise<OrderDto> {
  const updated = await prisma.$transaction((tx) => cancelOrderTx(tx, orderId, actorId, opts))
  await enqueueInventoryPushesAfterCommit(updated.lines.map((l) => l.variantId), `order.cancelled order:${orderId}`)
  return toDto(updated)
}

/**
 * A Stripe refund (charge.refunded, spec §5). Partial: amount only. Full:
 * status `refunded`. A `paid` order (not yet shipped) also releases its
 * reservation; `fulfilled` and `cancelled` have no hold left to release.
 * Storefront only -- Walmart refunds go through returns.service.ts.
 */
export async function refundOrderTx(
  tx: Prisma.TransactionClient,
  orderId: string,
  input: { refundedCents: number; full: boolean },
  actorId = 'system',
): Promise<{ order: OrderWithLines; releasedVariantIds: string[] }> {
  const order = await loadOrderForUpdate(tx, orderId)
  if (order.channel !== 'storefront') {
    throw new OrderError('invalid_transition', `refunds for ${order.channel} orders are not handled here`)
  }
  const target = `order:${orderId}`
  const before = { status: order.status, refundedCents: order.refundedCents }

  if (!input.full) {
    const next = await tx.order.update({ where: { id: orderId }, data: { refundedCents: input.refundedCents }, include: { lines: true } })
    await recordAudit({ actorId, action: 'order.refund_partial', target, before, after: { status: next.status, refundedCents: next.refundedCents } }, tx)
    return { order: next, releasedVariantIds: [] }
  }

  if (order.status === 'pending') throw new OrderError('invalid_transition', 'cannot refund a pending order')

  const releasedVariantIds: string[] = []
  if (order.status === 'paid') {
    for (const line of order.lines) {
      const affected = await tx.$executeRaw`
        UPDATE inventory SET reserved = reserved - ${line.quantity}
        WHERE variant_id = ${line.variantId} AND reserved >= ${line.quantity}`
      if (affected === 0) throw new OrderError('inventory_conflict', `cannot release reservation for variant ${line.variantId}`)
      releasedVariantIds.push(line.variantId)
    }
  }
  const next = await tx.order.update({
    where: { id: orderId }, data: { status: 'refunded', refundedCents: input.refundedCents }, include: { lines: true },
  })
  await recordAudit({ actorId, action: 'order.refunded', target, before, after: { status: 'refunded', refundedCents: input.refundedCents } }, tx)
  return { order: next, releasedVariantIds }
}
```

`fulfillOrder` needs no edit: its existing `loadOrderForUpdate(tx, orderId)` call now takes the row lock too.

- [ ] **Step 5: Run the new test and the order suites**

Run: `npx vitest run tests/orders-checkout-support.test.ts tests/orders-service.test.ts tests/orders-transitions.test.ts tests/orders-concurrency.test.ts tests/walmart-ship-cancel-atomicity.test.ts tests/walmart-returns.test.ts`
Expected: PASS. The race test fails if you temporarily remove the `FOR UPDATE` line. Confirm that once, then put it back.

- [ ] **Step 6: Full suite, then commit**

Run: `npx vitest run`. Expected: all pass.

```bash
git add systems/core/src/orders/orders.service.ts systems/core/src/ports/tax/deferred.adapter.ts systems/core/tests/orders-checkout-support.test.ts
git commit -m "feat(core): order row locks, refund transition and checkout fields on placeOrder" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 5: PaymentsPort, the Stripe adapter, the fake, and env selection

**Files:**
- Modify: `systems/core/package.json`, `systems/core/package-lock.json` (`stripe@22.6.2`, exact)
- Create: `systems/core/src/ports/payments/payments.port.ts`
- Create: `systems/core/src/ports/payments/stripe.adapter.ts`
- Create: `systems/core/src/ports/payments/fake.adapter.ts`
- Create: `systems/core/src/ports/payments/index.ts`
- Test: `systems/core/tests/payments-stripe-adapter.test.ts`, `systems/core/tests/payments-selection.test.ts`

**Interfaces:**
- Consumes: `ShippingOption` (Task 2).
- Produces (from `payments.port.ts`):
  - `STRIPE_API_VERSION = '2026-08-26.dahlia'`, `TANGIBLE_GOODS_TAX_CODE = 'txcd_99999999'`, `SHIPPING_TAX_CODE = 'txcd_92010001'`, `CONTIGUOUS_US_NOTICE = 'We ship to the contiguous US only.'`
  - `interface CheckoutLine { name: string; unitAmountCents: number; quantity: number }`
  - `interface CreateCheckoutSessionInput { orderId: string; lines: CheckoutLine[]; shippingOptions: ShippingOption[]; expiresAt: Date; returnUrl: string }`
  - `interface CheckoutSessionRef { sessionId: string; clientSecret: string }`
  - `type SessionStatus = 'open' | 'complete' | 'expired'`
  - `type SessionPaymentStatus = 'paid' | 'unpaid' | 'no_payment_required'`
  - `interface CheckoutSessionState { id: string; status: SessionStatus; paymentStatus: SessionPaymentStatus }`
  - `class PaymentsUnavailableError extends Error`, `class WebhookSignatureError extends Error`
  - `interface PaymentsPort { readonly configured: boolean; readonly livemode: boolean; createCheckoutSession(i: CreateCheckoutSessionInput): Promise<CheckoutSessionRef>; expireCheckoutSession(sessionId: string): Promise<'expired' | 'complete'>; retrieveCheckoutSession(sessionId: string): Promise<CheckoutSessionState>; constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event }`
  - `createStripePaymentsPort(config: { secretKey: string; webhookSecret: string }, client?: Stripe): PaymentsPort`
  - `unconfiguredPaymentsPort: PaymentsPort`
  - `createPaymentsPort(env?: NodeJS.ProcessEnv): PaymentsPort`. Throws `Error` naming missing keys.
  - `FAKE_WEBHOOK_SECRET`, `createFakePaymentsPort(webhookSecret?: string): FakePaymentsPort`. `FakePaymentsPort` extends `PaymentsPort` with `sessions: Map<string, FakeSession>`, `failNextCreate: boolean`, `setSession(id, status, paymentStatus?)`, `sign(payload: string): string`, `expired: string[]`.

- [ ] **Step 1: Install the pinned SDK**

Run in `systems/core`: `npm install --save-exact stripe@22.6.2`
Expected: `package.json` has `"stripe": "22.6.2"`. Confirm the pinned API version:
`cat node_modules/stripe/esm/apiVersion.js`
Expected: `export const ApiVersion = '2026-08-26.dahlia';`. If this prints something else, stop and report. `STRIPE_API_VERSION` and the webhook endpoint version must match what the SDK types describe.

- [ ] **Step 2: Write the failing tests**

```ts
// tests/payments-stripe-adapter.test.ts
import { describe, it, expect, vi } from 'vitest'
import Stripe from 'stripe'
import {
  createStripePaymentsPort,
} from '../src/ports/payments/stripe.adapter.js'
import { WebhookSignatureError, STRIPE_API_VERSION } from '../src/ports/payments/payments.port.js'

const SECRET = 'whsec_adapter_test'
// Offline instance used only for its webhook helpers. Not a key.
const offline = new Stripe('sk_test_unused_placeholder')

function mockClient() {
  const sessions = {
    create: vi.fn(async (_p: Stripe.Checkout.SessionCreateParams) => ({ id: 'cs_test_1', client_secret: 'cs_test_1_secret_abc' })),
    expire: vi.fn(async () => ({ id: 'cs_test_1', status: 'expired' })),
    retrieve: vi.fn(async () => ({ id: 'cs_test_1', status: 'complete', payment_status: 'paid' })),
  }
  const client = { checkout: { sessions }, webhooks: offline.webhooks } as unknown as Stripe
  return { client, sessions }
}

const INPUT = {
  orderId: 'ord_1',
  lines: [{ name: 'Brick Builder Set', unitAmountCents: 4999, quantity: 2 }],
  shippingOptions: [{ displayName: 'Standard shipping', amountCents: 995 }],
  expiresAt: new Date('2026-10-01T12:31:00Z'),
  returnUrl: 'https://staging.alpinebrickexchange.com/order/complete?session_id={CHECKOUT_SESSION_ID}',
}

describe('Stripe payments adapter', () => {
  it('pins the API version the SDK was verified against', () => {
    expect(STRIPE_API_VERSION).toBe('2026-08-26.dahlia')
  })

  it('creates an embedded_page session with tax, US shipping and card only', async () => {
    const { client, sessions } = mockClient()
    const port = createStripePaymentsPort({ secretKey: 'sk_test_unused_placeholder', webhookSecret: SECRET }, client)
    expect(await port.createCheckoutSession(INPUT)).toEqual({ sessionId: 'cs_test_1', clientSecret: 'cs_test_1_secret_abc' })
    expect(sessions.create).toHaveBeenCalledWith({
      ui_mode: 'embedded_page',
      mode: 'payment',
      line_items: [{
        quantity: 2,
        price_data: {
          currency: 'usd', unit_amount: 4999, tax_behavior: 'exclusive',
          product_data: { name: 'Brick Builder Set', tax_code: 'txcd_99999999' },
        },
      }],
      automatic_tax: { enabled: true },
      shipping_address_collection: { allowed_countries: ['US'] },
      shipping_options: [{
        shipping_rate_data: {
          type: 'fixed_amount', display_name: 'Standard shipping',
          fixed_amount: { amount: 995, currency: 'usd' },
          tax_behavior: 'exclusive', tax_code: 'txcd_92010001',
        },
      }],
      allowed_payment_method_types: ['card'],
      custom_text: { shipping_address: { message: 'We ship to the contiguous US only.' } },
      expires_at: Math.floor(INPUT.expiresAt.getTime() / 1000),
      client_reference_id: 'ord_1',
      metadata: { orderId: 'ord_1' },
      payment_intent_data: { metadata: { orderId: 'ord_1' } },
      return_url: INPUT.returnUrl,
    })
  })

  it('reports an already-completed session instead of failing to expire it', async () => {
    const { client, sessions } = mockClient()
    sessions.expire.mockRejectedValueOnce(new Error('session is not open'))
    const port = createStripePaymentsPort({ secretKey: 'sk_test_unused_placeholder', webhookSecret: SECRET }, client)
    expect(await port.expireCheckoutSession('cs_test_1')).toBe('complete')
  })

  it('maps a retrieved session', async () => {
    const { client } = mockClient()
    const port = createStripePaymentsPort({ secretKey: 'sk_test_unused_placeholder', webhookSecret: SECRET }, client)
    expect(await port.retrieveCheckoutSession('cs_test_1')).toEqual({ id: 'cs_test_1', status: 'complete', paymentStatus: 'paid' })
  })

  it('verifies a correctly signed payload and rejects a tampered one', () => {
    const { client } = mockClient()
    const port = createStripePaymentsPort({ secretKey: 'sk_test_unused_placeholder', webhookSecret: SECRET }, client)
    const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'checkout.session.expired', data: { object: {} } })
    const header = offline.webhooks.generateTestHeaderString({ payload, secret: SECRET })
    expect(port.constructWebhookEvent(Buffer.from(payload), header).id).toBe('evt_1')
    expect(() => port.constructWebhookEvent(Buffer.from(payload.replace('evt_1', 'evt_2')), header))
      .toThrow(WebhookSignatureError)
  })

  it('knows test mode from the key prefix', () => {
    const { client } = mockClient()
    expect(createStripePaymentsPort({ secretKey: 'sk_test_unused_placeholder', webhookSecret: SECRET }, client).livemode).toBe(false)
    expect(createStripePaymentsPort({ secretKey: 'sk_live_unused_placeholder', webhookSecret: SECRET }, client).livemode).toBe(true)
  })
})
```

```ts
// tests/payments-selection.test.ts
import { describe, it, expect } from 'vitest'
import { createPaymentsPort } from '../src/ports/payments/index.js'
import { PaymentsUnavailableError } from '../src/ports/payments/payments.port.js'

const FULL = {
  STRIPE_SECRET_KEY: 'sk_test_unused_placeholder',
  STRIPE_WEBHOOK_SECRET: 'whsec_selection_test',
  STOREFRONT_PUBLIC_URL: 'https://staging.alpinebrickexchange.com',
}

describe('createPaymentsPort', () => {
  it('is unconfigured, not broken, when no Stripe key is set', async () => {
    const port = createPaymentsPort({})
    expect(port.configured).toBe(false)
    await expect(port.retrieveCheckoutSession('cs_x')).rejects.toBeInstanceOf(PaymentsUnavailableError)
  })

  it('refuses to start with only one Stripe key, naming the missing one', () => {
    expect(() => createPaymentsPort({ STRIPE_SECRET_KEY: FULL.STRIPE_SECRET_KEY }))
      .toThrow(/STRIPE_WEBHOOK_SECRET/)
    expect(() => createPaymentsPort({ STRIPE_WEBHOOK_SECRET: FULL.STRIPE_WEBHOOK_SECRET }))
      .toThrow(/STRIPE_SECRET_KEY/)
  })

  it('refuses to start with both keys but no storefront URL for return_url', () => {
    expect(() => createPaymentsPort({ STRIPE_SECRET_KEY: FULL.STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET: FULL.STRIPE_WEBHOOK_SECRET }))
      .toThrow(/STOREFRONT_PUBLIC_URL/)
  })

  it('builds the Stripe adapter when fully configured', () => {
    const port = createPaymentsPort(FULL)
    expect(port.configured).toBe(true)
    expect(port.livemode).toBe(false)
  })
})
```

- [ ] **Step 3: Run to see them fail**

Run: `npx vitest run tests/payments-stripe-adapter.test.ts tests/payments-selection.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement the port**

```ts
// src/ports/payments/payments.port.ts
import type Stripe from 'stripe'
import type { ShippingOption } from '../shipping/shipping.port.js'

/** stripe@22.6.2's pinned version (verified 2026-09-27; see the plan header). */
export const STRIPE_API_VERSION = '2026-08-26.dahlia' as const
/** Stripe Tax "General - Tangible Goods" (§9.5: revisit if an accountant names a toys code). */
export const TANGIBLE_GOODS_TAX_CODE = 'txcd_99999999'
/** Stripe Tax "Shipping". */
export const SHIPPING_TAX_CODE = 'txcd_92010001'
/** Spec §4: shown on the session and in the cart, verbatim. */
export const CONTIGUOUS_US_NOTICE = 'We ship to the contiguous US only.'

export interface CheckoutLine { name: string; unitAmountCents: number; quantity: number }

export interface CreateCheckoutSessionInput {
  orderId: string
  lines: CheckoutLine[]
  shippingOptions: ShippingOption[]
  expiresAt: Date
  /** Must contain {CHECKOUT_SESSION_ID}; Stripe substitutes it. */
  returnUrl: string
}

export interface CheckoutSessionRef { sessionId: string; clientSecret: string }
export type SessionStatus = 'open' | 'complete' | 'expired'
export type SessionPaymentStatus = 'paid' | 'unpaid' | 'no_payment_required'
export interface CheckoutSessionState { id: string; status: SessionStatus; paymentStatus: SessionPaymentStatus }

/** Stripe is not configured on this instance (no keys). Checkout answers 503. */
export class PaymentsUnavailableError extends Error {
  constructor() { super('payments are not configured'); this.name = 'PaymentsUnavailableError' }
}

export class WebhookSignatureError extends Error {
  constructor(message = 'invalid Stripe signature') { super(message); this.name = 'WebhookSignatureError' }
}

/**
 * Everything core asks of Stripe. Unit tests use fake.adapter.ts; the Stripe
 * adapter has a thin mocked-client test and the staging end-to-end run.
 */
export interface PaymentsPort {
  readonly configured: boolean
  /** false for test-mode keys; picks the Dashboard URL shape. */
  readonly livemode: boolean
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSessionRef>
  /** 'complete' when the customer paid before the expire landed. */
  expireCheckoutSession(sessionId: string): Promise<'expired' | 'complete'>
  retrieveCheckoutSession(sessionId: string): Promise<CheckoutSessionState>
  /** Throws WebhookSignatureError on a bad or stale signature. */
  constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event
}
```

- [ ] **Step 5: Implement the Stripe adapter**

```ts
// src/ports/payments/stripe.adapter.ts
import Stripe from 'stripe'
import {
  CONTIGUOUS_US_NOTICE, SHIPPING_TAX_CODE, STRIPE_API_VERSION, TANGIBLE_GOODS_TAX_CODE, WebhookSignatureError,
  type CheckoutSessionState, type PaymentsPort, type SessionPaymentStatus,
} from './payments.port.js'

export function createStripePaymentsPort(
  config: { secretKey: string; webhookSecret: string },
  client: Stripe = new Stripe(config.secretKey, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2, timeout: 10_000 }),
): PaymentsPort {
  const livemode = !/^(sk|rk)_test_/.test(config.secretKey)

  async function retrieve(sessionId: string): Promise<CheckoutSessionState> {
    const s = await client.checkout.sessions.retrieve(sessionId)
    return {
      id: s.id,
      status: (s.status ?? 'open') as CheckoutSessionState['status'],
      paymentStatus: s.payment_status as SessionPaymentStatus,
    }
  }

  return {
    configured: true,
    livemode,

    async createCheckoutSession(input) {
      const session = await client.checkout.sessions.create({
        // Dahlia renamed the UI modes; 'embedded' now fails (plan header).
        ui_mode: 'embedded_page',
        mode: 'payment',
        line_items: input.lines.map((l) => ({
          quantity: l.quantity,
          price_data: {
            currency: 'usd', unit_amount: l.unitAmountCents, tax_behavior: 'exclusive',
            product_data: { name: l.name, tax_code: TANGIBLE_GOODS_TAX_CODE },
          },
        })),
        automatic_tax: { enabled: true },
        // Country-level only: Stripe cannot exclude AK/HI/territories here.
        // The webhook flags them (spec §4, plan header §9.1 finding).
        shipping_address_collection: { allowed_countries: ['US'] },
        shipping_options: input.shippingOptions.map((o) => ({
          shipping_rate_data: {
            type: 'fixed_amount', display_name: o.displayName,
            fixed_amount: { amount: o.amountCents, currency: 'usd' },
            tax_behavior: 'exclusive', tax_code: SHIPPING_TAX_CODE,
          },
        })),
        // Cards only; Apple Pay and Google Pay are card wallets and remain.
        allowed_payment_method_types: ['card'],
        custom_text: { shipping_address: { message: CONTIGUOUS_US_NOTICE } },
        expires_at: Math.floor(input.expiresAt.getTime() / 1000),
        client_reference_id: input.orderId,
        metadata: { orderId: input.orderId },
        payment_intent_data: { metadata: { orderId: input.orderId } },
        return_url: input.returnUrl,
      })
      if (!session.client_secret) throw new Error(`Stripe returned no client_secret for ${session.id}`)
      return { sessionId: session.id, clientSecret: session.client_secret }
    },

    async expireCheckoutSession(sessionId) {
      try {
        await client.checkout.sessions.expire(sessionId)
        return 'expired'
      } catch (err) {
        // Expire fails when the session is no longer open. Find out why.
        const s = await retrieve(sessionId)
        if (s.status === 'expired') return 'expired'
        if (s.status === 'complete') return 'complete'
        throw err
      }
    },

    retrieveCheckoutSession: retrieve,

    constructWebhookEvent(rawBody, signature) {
      try {
        return client.webhooks.constructEvent(rawBody, signature, config.webhookSecret)
      } catch (err) {
        throw new WebhookSignatureError(err instanceof Error ? err.message : undefined)
      }
    },
  }
}
```

If `tsc` rejects `allowed_payment_method_types` on `SessionCreateParams` in 22.6.2, stop and report it. Do not fall back to `payment_method_types` without checking the Dahlia changelog again.

- [ ] **Step 6: Implement the fake and the selection**

```ts
// src/ports/payments/fake.adapter.ts
import Stripe from 'stripe'
import {
  WebhookSignatureError,
  type CreateCheckoutSessionInput, type PaymentsPort, type SessionPaymentStatus, type SessionStatus,
} from './payments.port.js'

export const FAKE_WEBHOOK_SECRET = 'whsec_fake_for_tests'

export interface FakeSession { input: CreateCheckoutSessionInput; status: SessionStatus; paymentStatus: SessionPaymentStatus }

export interface FakePaymentsPort extends PaymentsPort {
  sessions: Map<string, FakeSession>
  /** Next createCheckoutSession rejects (then resets). */
  failNextCreate: boolean
  /** Session ids passed to expireCheckoutSession, in order. */
  expired: string[]
  setSession(id: string, status: SessionStatus, paymentStatus?: SessionPaymentStatus): void
  /** A valid Stripe-Signature header for `payload` under this fake's secret. */
  sign(payload: string): string
}

/**
 * In-memory PaymentsPort for tests. Signature checks use the real stripe-node
 * implementation (an offline client), so webhook tests exercise genuine
 * verification with payloads signed by generateTestHeaderString.
 */
export function createFakePaymentsPort(webhookSecret = FAKE_WEBHOOK_SECRET): FakePaymentsPort {
  const offline = new Stripe('sk_test_unused_placeholder')
  const sessions = new Map<string, FakeSession>()
  let n = 0
  const fake: FakePaymentsPort = {
    configured: true,
    livemode: false,
    sessions,
    failNextCreate: false,
    expired: [],
    async createCheckoutSession(input) {
      if (fake.failNextCreate) { fake.failNextCreate = false; throw new Error('stripe is down (fake)') }
      const id = `cs_test_fake_${++n}_${Date.now()}`
      sessions.set(id, { input, status: 'open', paymentStatus: 'unpaid' })
      return { sessionId: id, clientSecret: `${id}_secret_fake` }
    },
    async expireCheckoutSession(id) {
      fake.expired.push(id)
      const s = sessions.get(id)
      if (s?.status === 'complete') return 'complete'
      if (s) s.status = 'expired'
      return 'expired'
    },
    async retrieveCheckoutSession(id) {
      const s = sessions.get(id)
      if (!s) throw new Error(`no such session ${id} (fake)`)
      return { id, status: s.status, paymentStatus: s.paymentStatus }
    },
    constructWebhookEvent(rawBody, signature) {
      try {
        return offline.webhooks.constructEvent(rawBody, signature, webhookSecret)
      } catch (err) {
        throw new WebhookSignatureError(err instanceof Error ? err.message : undefined)
      }
    },
    setSession(id, status, paymentStatus = status === 'complete' ? 'paid' : 'unpaid') {
      const s = sessions.get(id)
      if (!s) throw new Error(`no such session ${id} (fake)`)
      s.status = status
      s.paymentStatus = paymentStatus
    },
    sign(payload) {
      return offline.webhooks.generateTestHeaderString({ payload, secret: webhookSecret })
    },
  }
  return fake
}
```

```ts
// src/ports/payments/index.ts
import { PaymentsUnavailableError, WebhookSignatureError, type PaymentsPort } from './payments.port.js'
import { createStripePaymentsPort } from './stripe.adapter.js'

const STRIPE_KEYS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] as const

/** No Stripe keys: checkout and the webhook answer 503, nothing else is affected. */
export const unconfiguredPaymentsPort: PaymentsPort = {
  configured: false,
  livemode: false,
  async createCheckoutSession() { throw new PaymentsUnavailableError() },
  async expireCheckoutSession() { throw new PaymentsUnavailableError() },
  async retrieveCheckoutSession() { throw new PaymentsUnavailableError() },
  constructWebhookEvent() { throw new WebhookSignatureError('payments are not configured') },
}

/**
 * Picks the payments adapter at startup (spec §8). Half-configured refuses to
 * start, naming each missing key: a deploy with the secret key but no webhook
 * secret would take money and never mark an order paid.
 */
export function createPaymentsPort(env: NodeJS.ProcessEnv = process.env): PaymentsPort {
  const present = STRIPE_KEYS.filter((k) => env[k])
  if (present.length === 0) return unconfiguredPaymentsPort
  const missing: string[] = STRIPE_KEYS.filter((k) => !env[k])
  if (!env.STOREFRONT_PUBLIC_URL) missing.push('STOREFRONT_PUBLIC_URL')
  if (missing.length > 0) throw new Error(`Stripe is half-configured; missing: ${missing.join(', ')}`)
  return createStripePaymentsPort({ secretKey: env.STRIPE_SECRET_KEY!, webhookSecret: env.STRIPE_WEBHOOK_SECRET! })
}
```

- [ ] **Step 7: Run, typecheck, commit**

Run: `npx vitest run tests/payments-stripe-adapter.test.ts tests/payments-selection.test.ts && npm run typecheck`
Expected: PASS (10 tests); typecheck clean.

```bash
git add systems/core/package.json systems/core/package-lock.json systems/core/src/ports/payments systems/core/tests/payments-stripe-adapter.test.ts systems/core/tests/payments-selection.test.ts
git commit -m "feat(core): PaymentsPort with a pinned Stripe adapter and a test fake" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 6: Checkout endpoint, status and config; retire the public order routes

**Files:**
- Create: `systems/core/src/lib/rate-limit.ts`
- Create: `systems/core/src/checkout/checkout-input.ts`
- Create: `systems/core/src/checkout/checkout.service.ts`
- Create: `systems/core/src/checkout/checkout.routes.ts`
- Modify: `systems/core/src/app.ts`
- Delete: `systems/core/src/orders/orders.routes.ts`, `systems/core/tests/orders-api.test.ts`
- Modify: `systems/core/tests/orders-post-commit-push.test.ts` (drop the route case)
- Create: `systems/core/tests/helpers/checkout.ts`
- Test: `systems/core/tests/checkout-routes.test.ts`, `systems/core/tests/rate-limit.test.ts`

**Interfaces:**
- Consumes: `placeOrder`, `cancelOrder`, `OrderError`, `PENDING_CHECKOUT_EMAIL`, `orderNumber` (Task 4); `deferredTaxAdapter` (Task 4); `PaymentsPort`, `createPaymentsPort`, `createFakePaymentsPort` (Task 5); `ShippingPort`, `createFlatRateShippingPort`, `getShopSettings` (Task 2); `parseReferralInput` (Task 3); `EmailPort`, `noopEmailAdapter` (Task 3).
- Produces:
  - `createRateLimiter(opts: { limit: number; windowMs: number; now?: () => number }): RequestHandler`
  - `class CheckoutError extends Error { code: string; status: number; details?: Record<string, unknown> }`
  - `interface CheckoutRequest { lines: { variantId: string; quantity: number }[]; marketingOptIn: boolean; referral: { code: string; firstSeenAt: Date } | null; previousOrderId: string | null }`
  - `parseCheckoutRequest(body: unknown, now?: Date): CheckoutRequest`
  - `interface CheckoutDeps { payments: PaymentsPort; shipping: ShippingPort; storefrontUrl: string | null; now?: () => Date }`
  - `interface LineProblem { variantId: string; code: 'insufficient_stock' | 'variant_not_found'; available?: number }`
  - `lineName(productName: string, attributes: unknown): string`
  - `startCheckout(req: CheckoutRequest, deps: CheckoutDeps): Promise<{ orderId: string; clientSecret: string }>`
  - `interface CheckoutStatusDto { status: 'pending' | 'paid' | 'cancelled'; orderNumber: string; lines: { name: string; sku: string; quantity: number; unitPriceCents: number; lineSubtotalCents: number }[]; totals: { subtotalCents: number; shippingCents: number; taxCents: number; totalCents: number } }`
  - `getCheckoutStatus(sessionId: string): Promise<CheckoutStatusDto | null>`
  - `getCheckoutConfig(): Promise<{ flatRateCents: number; freeShippingThresholdCents: number | null }>`
  - `createCheckoutRouter(deps: CheckoutDeps & { rateLimit: RequestHandler }): Router`
  - `interface AppDeps { payments: PaymentsPort; shipping: ShippingPort; email: EmailPort; storefrontUrl: string | null; checkoutRateLimit: RequestHandler }`
  - `buildApp(deps?: Partial<AppDeps>): Express`
  - HTTP: `POST /api/v1/checkout` → `201 { orderId, clientSecret }`. `GET /api/v1/checkout/status?session_id=` → `CheckoutStatusDto`. `GET /api/v1/checkout/config` → `{ flatRateCents, freeShippingThresholdCents }`.
  - Test helpers: `STOREFRONT_URL`, `makeApp(over?: Partial<AppDeps>): { app: Express; payments: FakePaymentsPort }`, `variantIdBySku(sku)`, `inventoryOf(sku)`, `setOnHand(sku, onHand)`, `postCheckout(app, body)`.

- [ ] **Step 1: Test helpers**

```ts
// tests/helpers/checkout.ts
import request from 'supertest'
import type { Express } from 'express'
import { buildApp, type AppDeps } from '../../src/app.js'
import { createFakePaymentsPort, type FakePaymentsPort } from '../../src/ports/payments/fake.adapter.js'
import { prisma } from '../../src/prisma.js'

export const STOREFRONT_URL = 'https://staging.alpinebrickexchange.com'

/** An app wired to the fake Stripe, with the rate limit off unless a test supplies one. */
export function makeApp(over: Partial<AppDeps> = {}): { app: Express; payments: FakePaymentsPort } {
  const payments = (over.payments as FakePaymentsPort | undefined) ?? createFakePaymentsPort()
  const app = buildApp({
    storefrontUrl: STOREFRONT_URL,
    checkoutRateLimit: (_req, _res, next) => next(),
    ...over,
    payments,
  })
  return { app, payments }
}

export async function variantIdBySku(sku: string): Promise<string> {
  return (await prisma.variant.findFirstOrThrow({ where: { sku } })).id
}

export async function inventoryOf(sku: string) {
  return prisma.inventory.findFirstOrThrow({ where: { variant: { sku } } })
}

export async function setOnHand(sku: string, onHand: number): Promise<string> {
  const id = await variantIdBySku(sku)
  await prisma.inventory.update({ where: { variantId: id }, data: { onHand, reserved: 0 } })
  return id
}

export function postCheckout(app: Express, body: Record<string, unknown>) {
  return request(app).post('/api/v1/checkout').send({ marketingOptIn: false, referral: null, ...body })
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/rate-limit.test.ts
import { describe, it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createRateLimiter } from '../src/lib/rate-limit.js'

describe('createRateLimiter', () => {
  it('allows `limit` requests per window per IP, then 429s until the window resets', async () => {
    let t = 0
    const app = express()
    app.get('/', createRateLimiter({ limit: 2, windowMs: 60_000, now: () => t }), (_req, res) => { res.json({ ok: true }) })
    expect((await request(app).get('/')).status).toBe(200)
    expect((await request(app).get('/')).status).toBe(200)
    const blocked = await request(app).get('/')
    expect(blocked.status).toBe(429)
    expect(blocked.body.code).toBe('rate_limited')
    expect(blocked.headers['retry-after']).toBe('60')
    t = 60_000
    expect((await request(app).get('/')).status).toBe(200)
  })
})
```

```ts
// tests/checkout-routes.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { markOrderPaid } from '../src/orders/orders.service.js'
import { createRateLimiter } from '../src/lib/rate-limit.js'
import { unconfiguredPaymentsPort } from '../src/ports/payments/index.js'
import { makeApp, postCheckout, variantIdBySku, inventoryOf, setOnHand, STOREFRONT_URL } from './helpers/checkout.js'

const ORIGIN = 'https://staging.alpinebrickexchange.com'
beforeEach(async () => {
  await resetDb(); await seed()
  process.env.STOREFRONT_ORIGIN = ORIGIN
})
afterAll(async () => { delete process.env.STOREFRONT_ORIGIN; await prisma.$disconnect() })

describe('POST /api/v1/checkout', () => {
  it('reserves stock, creates a pending order and returns the client secret', async () => {
    const { app, payments } = makeApp()
    const v = await variantIdBySku('BBS-STD') // $49.99, onHand 25
    const res = await postCheckout(app, {
      lines: [{ variantId: v, quantity: 2 }], marketingOptIn: true,
      referral: { code: 'Brick-Club', firstSeenAt: new Date(Date.now() - 86_400_000).toISOString() },
    })
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ orderId: expect.any(String), clientSecret: expect.stringMatching(/_secret_/) })

    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } })
    expect(order).toMatchObject({
      status: 'pending', email: 'pending@checkout.invalid', shipToState: '', subtotalCents: 9998,
      taxJurisdiction: 'stripe_tax_pending', marketingOptIn: true, referralCode: 'brick-club',
    })
    expect(order.stripeCheckoutSessionId).toMatch(/^cs_test_fake_/)
    expect((await inventoryOf('BBS-STD')).reserved).toBe(2)

    const session = payments.sessions.get(order.stripeCheckoutSessionId!)!
    expect(session.input.lines).toEqual([{ name: 'Brick Builder Set', unitAmountCents: 4999, quantity: 2 }])
    expect(session.input.shippingOptions).toEqual([{ displayName: 'Standard shipping', amountCents: 995 }])
    expect(session.input.returnUrl).toBe(`${STOREFRONT_URL}/order/complete?session_id={CHECKOUT_SESSION_ID}`)
    expect(session.input.expiresAt.getTime() - Date.now()).toBeGreaterThan(30 * 60_000)
    expect(session.input.orderId).toBe(order.id)
  })

  it('offers free shipping at the threshold', async () => {
    const { app, payments } = makeApp()
    const res = await postCheckout(app, { lines: [{ variantId: await variantIdBySku('ABE-1001'), quantity: 1 }] }) // $189
    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } })
    expect(payments.sessions.get(order.stripeCheckoutSessionId!)!.input.shippingOptions)
      .toEqual([{ displayName: 'Free shipping', amountCents: 0 }])
  })

  it.each([
    ['no lines', { lines: [] }],
    ['21 lines', { lines: Array.from({ length: 21 }, (_, i) => ({ variantId: `v${i}`, quantity: 1 })) }],
    ['quantity 11', { lines: [{ variantId: 'x', quantity: 11 }] }],
    ['quantity 0', { lines: [{ variantId: 'x', quantity: 0 }] }],
    ['fractional quantity', { lines: [{ variantId: 'x', quantity: 1.5 }] }],
    ['duplicate variants', { lines: [{ variantId: 'x', quantity: 1 }, { variantId: 'x', quantity: 2 }] }],
    ['non-boolean opt-in', { lines: [{ variantId: 'x', quantity: 1 }], marketingOptIn: 'yes' }],
  ])('rejects %s with 400 invalid_request and reserves nothing', async (_name, body) => {
    const { app } = makeApp()
    const res = await postCheckout(app, body)
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_request')
    expect(await prisma.order.count()).toBe(0)
  })

  it('drops an invalid referral instead of rejecting the checkout', async () => {
    const { app } = makeApp()
    const res = await postCheckout(app, {
      lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: 1 }],
      referral: { code: 'not valid!', firstSeenAt: new Date().toISOString() },
    })
    expect(res.status).toBe(201)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } })).referralCode).toBeNull()
  })

  it('409s insufficient_stock naming every short line and how many are left', async () => {
    const { app } = makeApp()
    const a = await setOnHand('CMP-LTD', 2)
    const b = await variantIdBySku('BBS-STD')
    const res = await postCheckout(app, { lines: [{ variantId: a, quantity: 3 }, { variantId: b, quantity: 1 }, { variantId: 'gone', quantity: 1 }] })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('insufficient_stock')
    expect(res.body.details.lines).toEqual([
      { variantId: a, code: 'insufficient_stock', available: 2 },
      { variantId: 'gone', code: 'variant_not_found' },
    ])
    expect(await prisma.order.count()).toBe(0)
  })

  it('cancels the order and 503s when Stripe fails, releasing the hold', async () => {
    const { app, payments } = makeApp()
    payments.failNextCreate = true
    const res = await postCheckout(app, { lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: 2 }] })
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('checkout_unavailable')
    expect((await prisma.order.findFirstOrThrow()).status).toBe('cancelled')
    expect((await inventoryOf('BBS-STD')).reserved).toBe(0)
  })

  it('503s without touching stock when Stripe is not configured', async () => {
    const { app } = makeApp({ payments: unconfiguredPaymentsPort })
    const res = await postCheckout(app, { lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: 1 }] })
    expect(res.status).toBe(503)
    expect(await prisma.order.count()).toBe(0)
  })

  it('previousOrderId expires the old session and releases its hold first', async () => {
    const { app, payments } = makeApp()
    const v = await variantIdBySku('BBS-STD')
    const first = await postCheckout(app, { lines: [{ variantId: v, quantity: 3 }] })
    const second = await postCheckout(app, { lines: [{ variantId: v, quantity: 1 }], previousOrderId: first.body.orderId })
    expect(second.status).toBe(201)
    const old = await prisma.order.findUniqueOrThrow({ where: { id: first.body.orderId } })
    expect(old.status).toBe('cancelled')
    expect(payments.expired).toEqual([old.stripeCheckoutSessionId])
    expect((await inventoryOf('BBS-STD')).reserved).toBe(1)
  })

  it('ignores a previousOrderId that is already paid', async () => {
    const { app, payments } = makeApp()
    const v = await variantIdBySku('BBS-STD')
    const first = await postCheckout(app, { lines: [{ variantId: v, quantity: 1 }] })
    await markOrderPaid(first.body.orderId)
    await postCheckout(app, { lines: [{ variantId: v, quantity: 1 }], previousOrderId: first.body.orderId })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: first.body.orderId } })).status).toBe('paid')
    expect(payments.expired).toEqual([])
  })

  it('lets exactly one of two concurrent checkouts take the last unit', async () => {
    const { app } = makeApp()
    const v = await setOnHand('CMP-LTD', 1)
    const results = await Promise.all([1, 2].map(() => postCheckout(app, { lines: [{ variantId: v, quantity: 1 }] })))
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    expect((await inventoryOf('CMP-LTD')).reserved).toBe(1)
  })

  it('rate-limits per IP', async () => {
    const { app } = makeApp({ checkoutRateLimit: createRateLimiter({ limit: 2, windowMs: 60_000 }) })
    await postCheckout(app, { lines: [] })
    await postCheckout(app, { lines: [] })
    expect((await postCheckout(app, { lines: [] })).status).toBe(429)
  })

  it('answers the storefront preflight without credentials', async () => {
    const { app } = makeApp()
    const res = await request(app).options('/api/v1/checkout')
      .set('Origin', ORIGIN).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type')
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN)
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
  })
})

describe('GET /api/v1/checkout/status', () => {
  it('returns non-sensitive fields only', async () => {
    const { app } = makeApp()
    const created = await postCheckout(app, { lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: 1 }] })
    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.body.orderId } })
    const res = await request(app).get(`/api/v1/checkout/status?session_id=${order.stripeCheckoutSessionId}`)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toEqual({
      status: 'pending',
      orderNumber: expect.stringMatching(/^ABE-\d{6}$/),
      lines: [{ name: 'Brick Builder Set', sku: 'BBS-STD', quantity: 1, unitPriceCents: 4999, lineSubtotalCents: 4999 }],
      totals: { subtotalCents: 4999, shippingCents: 0, taxCents: 0, totalCents: 4999 },
    })
    expect(JSON.stringify(res.body)).not.toContain('@')
  })

  it('404s an unknown session and 400s a malformed one', async () => {
    const { app } = makeApp()
    expect((await request(app).get('/api/v1/checkout/status?session_id=cs_test_nope')).status).toBe(404)
    expect((await request(app).get('/api/v1/checkout/status?session_id=../../x')).status).toBe(400)
    expect((await request(app).get('/api/v1/checkout/status')).status).toBe(400)
  })
})

describe('GET /api/v1/checkout/config', () => {
  it('exposes the shipping settings the cart needs', async () => {
    const { app } = makeApp()
    const res = await request(app).get('/api/v1/checkout/config')
    expect(res.body).toEqual({ flatRateCents: 995, freeShippingThresholdCents: 15000 })
  })
})

describe('retired public order routes (spec §2)', () => {
  it('404s POST and GET /api/v1/orders', async () => {
    const { app } = makeApp()
    const v = await variantIdBySku('BBS-STD')
    expect((await request(app).post('/api/v1/orders').send({ email: 'a@b.c', shipToState: 'MI', lines: [{ variantId: v, quantity: 1 }] })).status).toBe(404)
    expect((await request(app).get('/api/v1/orders/anything')).status).toBe(404)
    expect(await prisma.order.count()).toBe(0)
  })
})
```

The adapter test in Task 5 already asserts that `orderId` becomes both `metadata.orderId` and `client_reference_id`, so this test only checks that the fake received it.

- [ ] **Step 3: Run to see them fail**

Run: `npx vitest run tests/rate-limit.test.ts tests/checkout-routes.test.ts`
Expected: FAIL — `rate-limit.js` not found; `buildApp` does not accept deps; `/api/v1/checkout` 404.

- [ ] **Step 4: The rate limiter**

```ts
// src/lib/rate-limit.ts
import type { RequestHandler } from 'express'

/**
 * Per-IP fixed-window limiter, in memory (spec §8: "so it cannot be used to
 * lock up stock"). Per process: with N web instances the effective limit is
 * N x `limit`, acceptable at one starter instance. req.ip is the client's
 * address because app.ts sets `trust proxy` to Render's single hop.
 */
export function createRateLimiter(opts: { limit: number; windowMs: number; now?: () => number }): RequestHandler {
  const now = opts.now ?? Date.now
  const hits = new Map<string, { count: number; resetAt: number }>()
  return (req, res, next) => {
    const t = now()
    const key = req.ip ?? 'unknown'
    let entry = hits.get(key)
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + opts.windowMs }
      hits.set(key, entry)
    }
    entry.count += 1
    if (hits.size > 10_000) for (const [k, e] of hits) if (e.resetAt <= t) hits.delete(k)
    if (entry.count > opts.limit) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - t) / 1000)))
      res.status(429).json({ code: 'rate_limited', message: 'Too many checkout attempts. Please wait a minute and try again.' })
      return
    }
    next()
  }
}
```

- [ ] **Step 5: Request parsing**

```ts
// src/checkout/checkout-input.ts
import { parseReferralInput } from '../referrals/referrals.service.js'

export const MAX_LINES = 20
export const MAX_QUANTITY = 10

/** Public checkout error: lower_snake `code`, HTTP `status`, optional `details`. */
export class CheckoutError extends Error {
  constructor(public code: string, message: string, public status: number, public details?: Record<string, unknown>) {
    super(message)
    this.name = 'CheckoutError'
  }
}

export interface CheckoutRequest {
  lines: { variantId: string; quantity: number }[]
  marketingOptIn: boolean
  referral: { code: string; firstSeenAt: Date } | null
  previousOrderId: string | null
}

const invalid = (field: string, message: string) => new CheckoutError('invalid_request', message, 400, { field })

/** Spec §4 step 1. A bad referral is dropped (parseReferralInput -> null), never rejected. */
export function parseCheckoutRequest(body: unknown, now = new Date()): CheckoutRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('body', 'body must be a JSON object')
  const b = body as Record<string, unknown>
  if (!Array.isArray(b.lines) || b.lines.length < 1 || b.lines.length > MAX_LINES) {
    throw invalid('lines', `between 1 and ${MAX_LINES} lines`)
  }
  const seen = new Set<string>()
  const lines = b.lines.map((raw, i) => {
    const l = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    if (typeof l.variantId !== 'string' || l.variantId.length < 1 || l.variantId.length > 64) {
      throw invalid(`lines.${i}.variantId`, 'a variant id')
    }
    if (typeof l.quantity !== 'number' || !Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > MAX_QUANTITY) {
      throw invalid(`lines.${i}.quantity`, `a whole number from 1 to ${MAX_QUANTITY}`)
    }
    if (seen.has(l.variantId)) throw invalid(`lines.${i}.variantId`, 'each variant may appear only once')
    seen.add(l.variantId)
    return { variantId: l.variantId, quantity: l.quantity }
  })
  if ('marketingOptIn' in b && typeof b.marketingOptIn !== 'boolean') throw invalid('marketingOptIn', 'true or false')
  const prev = b.previousOrderId
  return {
    lines,
    marketingOptIn: b.marketingOptIn === true,
    referral: parseReferralInput(b.referral, now),
    previousOrderId: typeof prev === 'string' && prev.length > 0 && prev.length <= 64 ? prev : null,
  }
}
```

- [ ] **Step 6: The service**

```ts
// src/checkout/checkout.service.ts
import { prisma } from '../prisma.js'
import {
  placeOrder, cancelOrder, orderNumber, OrderError, PENDING_CHECKOUT_EMAIL, type OrderDto,
} from '../orders/orders.service.js'
import { deferredTaxAdapter } from '../ports/tax/deferred.adapter.js'
import { storefrontSellable } from '../inventory/allocation.js'
import { getShopSettings } from '../settings/shop-settings.service.js'
import type { PaymentsPort, CheckoutSessionRef } from '../ports/payments/payments.port.js'
import type { ShippingPort } from '../ports/shipping/shipping.port.js'
import { scrubError } from '../auth/scrub.js'
import { CheckoutError, type CheckoutRequest } from './checkout-input.js'

export interface CheckoutDeps {
  payments: PaymentsPort
  shipping: ShippingPort
  /** STOREFRONT_PUBLIC_URL, no trailing slash. null = checkout unavailable. */
  storefrontUrl: string | null
  now?: () => Date
}

export interface LineProblem {
  variantId: string
  code: 'insufficient_stock' | 'variant_not_found'
  available?: number
}

export const SESSION_ID_RE = /^cs_[A-Za-z0-9_]{1,250}$/

const unavailable = () =>
  new CheckoutError('checkout_unavailable', 'Checkout is temporarily unavailable — please try again in a minute.', 503)

function stockError(lines: LineProblem[]): CheckoutError {
  const code = lines[0].code
  const message = code === 'insufficient_stock'
    ? 'Some items are not available in the quantity requested.'
    : 'Some items are no longer available.'
  return new CheckoutError(code, message, 409, { lines })
}

/** "Brick Builder Set — Sealed" when the variant has attribute values, else the product name. */
export function lineName(productName: string, attributes: unknown): string {
  const values = attributes && typeof attributes === 'object' && !Array.isArray(attributes)
    ? Object.values(attributes as Record<string, unknown>).filter((v): v is string => typeof v === 'string' && v.length > 0)
    : []
  return values.length ? `${productName} — ${values.join(', ')}` : productName
}

/** Spec §4 step 2. Never blocks the new checkout: failures are logged and the sweep cleans up. */
async function releasePreviousOrder(orderId: string, payments: PaymentsPort): Promise<void> {
  const prev = await prisma.order.findUnique({
    where: { id: orderId }, select: { status: true, channel: true, stripeCheckoutSessionId: true },
  })
  if (!prev || prev.status !== 'pending' || prev.channel !== 'storefront' || !prev.stripeCheckoutSessionId) return
  try {
    // Expire FIRST: cancelling while the session is still open would release
    // stock the customer can then pay for in the other tab.
    if ((await payments.expireCheckoutSession(prev.stripeCheckoutSessionId)) === 'complete') return
    await cancelOrder(orderId, 'system')
  } catch (err) {
    if (err instanceof OrderError && err.code === 'invalid_transition') return
    console.error('[checkout] could not release previous order', orderId, scrubError(err))
  }
}

/**
 * Reports EVERY short line at once so the cart can mark them all. A read,
 * not a lock -- placeOrder's guarded UPDATE is the real check.
 */
async function preflight(lines: CheckoutRequest['lines']): Promise<Map<string, string>> {
  const variants = await prisma.variant.findMany({
    where: { id: { in: lines.map((l) => l.variantId) } },
    include: { inventory: true, product: { select: { name: true, status: true } } },
  })
  const byId = new Map(variants.map((v) => [v.id, v]))
  const problems: LineProblem[] = []
  for (const line of lines) {
    const v = byId.get(line.variantId)
    if (!v || v.product.status !== 'published') {
      problems.push({ variantId: line.variantId, code: 'variant_not_found' })
      continue
    }
    const available = v.inventory ? storefrontSellable(v.inventory.onHand, v.inventory.reserved, v.inventory.walmartAllocation) : 0
    if (available < line.quantity) problems.push({ variantId: line.variantId, code: 'insufficient_stock', available })
  }
  if (problems.length > 0) throw stockError(problems)
  return new Map(variants.map((v) => [v.id, lineName(v.product.name, v.attributes)]))
}

export async function startCheckout(req: CheckoutRequest, deps: CheckoutDeps): Promise<{ orderId: string; clientSecret: string }> {
  if (!deps.payments.configured || !deps.storefrontUrl) throw unavailable()
  const now = deps.now?.() ?? new Date()

  if (req.previousOrderId) await releasePreviousOrder(req.previousOrderId, deps.payments)
  const names = await preflight(req.lines)

  let order: OrderDto
  try {
    order = await placeOrder({
      email: PENDING_CHECKOUT_EMAIL, shipToState: '', lines: req.lines,
      marketingOptIn: req.marketingOptIn, referral: req.referral,
    }, deferredTaxAdapter)
  } catch (err) {
    if (err instanceof OrderError && (err.code === 'insufficient_stock' || err.code === 'variant_not_found')) {
      const available = err.details?.available
      throw stockError([{
        variantId: String(err.details?.variantId), code: err.code,
        ...(typeof available === 'number' ? { available } : {}),
      }])
    }
    throw err
  }

  // Outside the DB transaction (spec §4 step 4). If Stripe fails, release.
  let session: CheckoutSessionRef
  try {
    const settings = await getShopSettings()
    const shippingOptions = await deps.shipping.quote({ subtotalCents: order.subtotalCents, lines: req.lines })
    session = await deps.payments.createCheckoutSession({
      orderId: order.id,
      lines: order.lines.map((l) => ({ name: names.get(l.variantId) ?? l.sku, unitAmountCents: l.unitPriceCents, quantity: l.quantity })),
      shippingOptions,
      // Stripe's floor is 30 minutes after creation; +1 minute absorbs clock skew.
      expiresAt: new Date(now.getTime() + (settings.sessionMinutes + 1) * 60_000),
      returnUrl: `${deps.storefrontUrl}/order/complete?session_id={CHECKOUT_SESSION_ID}`,
    })
  } catch (err) {
    console.error('[checkout] Stripe session creation failed', order.id, scrubError(err))
    try {
      await cancelOrder(order.id, 'system')
    } catch (releaseErr) {
      console.error('[checkout] releasing after the Stripe failure also failed; the sweep will retry', order.id, scrubError(releaseErr))
    }
    throw unavailable()
  }

  await prisma.order.update({ where: { id: order.id }, data: { stripeCheckoutSessionId: session.sessionId } })
  return { orderId: order.id, clientSecret: session.clientSecret }
}

export interface CheckoutStatusDto {
  status: 'pending' | 'paid' | 'cancelled'
  orderNumber: string
  lines: { name: string; sku: string; quantity: number; unitPriceCents: number; lineSubtotalCents: number }[]
  totals: { subtotalCents: number; shippingCents: number; taxCents: number; totalCents: number }
}

/** Spec §4 step 7: no address, no email. */
export async function getCheckoutStatus(sessionId: string): Promise<CheckoutStatusDto | null> {
  const o = await prisma.order.findUnique({
    where: { stripeCheckoutSessionId: sessionId },
    include: { lines: { include: { variant: { select: { attributes: true, product: { select: { name: true } } } } } } },
  })
  if (!o) return null
  // A payment that landed after the sweep cancelled the order is money taken:
  // "confirming" is truer than "expired" while a human sorts out the refund.
  const status: CheckoutStatusDto['status'] =
    o.status === 'pending' || o.reviewReason === 'paid_after_cancel' ? 'pending'
      : o.status === 'cancelled' ? 'cancelled'
        : 'paid'
  return {
    status,
    orderNumber: orderNumber(o.number),
    lines: o.lines.map((l) => ({
      name: lineName(l.variant.product.name, l.variant.attributes), sku: l.sku, quantity: l.quantity,
      unitPriceCents: l.unitPriceCents, lineSubtotalCents: l.lineSubtotalCents,
    })),
    totals: { subtotalCents: o.subtotalCents, shippingCents: o.shippingCents, taxCents: o.taxCents, totalCents: o.totalCents },
  }
}

/** What the cart needs to say "Free shipping on orders over $X" (plan decision 2). */
export async function getCheckoutConfig(): Promise<{ flatRateCents: number; freeShippingThresholdCents: number | null }> {
  const s = await getShopSettings()
  return { flatRateCents: s.flatRateCents, freeShippingThresholdCents: s.freeThresholdCents }
}
```

- [ ] **Step 7: The router**

```ts
// src/checkout/checkout.routes.ts
import { Router, type RequestHandler, type Response } from 'express'
import { asyncHandler } from '../lib/async-handler.js'
import { CheckoutError, parseCheckoutRequest } from './checkout-input.js'
import {
  startCheckout, getCheckoutStatus, getCheckoutConfig, SESSION_ID_RE, type CheckoutDeps,
} from './checkout.service.js'

function send(res: Response, err: CheckoutError) {
  return res.status(err.status).json({ code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) })
}

/** Public, storefront-CORS, no credentials (spec §8). Mounted in app.ts. */
export function createCheckoutRouter(deps: CheckoutDeps & { rateLimit: RequestHandler }): Router {
  const router = Router()

  router.post('/', deps.rateLimit, asyncHandler(async (req, res) => {
    try {
      res.status(201).json(await startCheckout(parseCheckoutRequest(req.body), deps))
    } catch (err) {
      if (err instanceof CheckoutError) return send(res, err)
      throw err
    }
  }))

  router.get('/status', asyncHandler(async (req, res) => {
    const id = req.query.session_id
    if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) {
      return res.status(400).json({ code: 'invalid_request', message: 'session_id is required' })
    }
    const status = await getCheckoutStatus(id)
    if (!status) return res.status(404).json({ code: 'not_found', message: 'no checkout for that session' })
    res.setHeader('Cache-Control', 'no-store')
    res.json(status)
  }))

  router.get('/config', asyncHandler(async (_req, res) => {
    res.json(await getCheckoutConfig())
  }))

  return router
}
```

- [ ] **Step 8: Wire `app.ts`; retire the order routes**

Replace the imports and the top of `buildApp` in `src/app.ts`:

```ts
import express, { type Express, type RequestHandler } from 'express'
import { catalogRouter } from './catalog/catalog.routes.js'
// ... existing imports, minus `ordersRouter` ...
import { createPaymentsPort } from './ports/payments/index.js'
import type { PaymentsPort } from './ports/payments/payments.port.js'
import { createFlatRateShippingPort } from './ports/shipping/flat-rate.adapter.js'
import type { ShippingPort } from './ports/shipping/shipping.port.js'
import { noopEmailAdapter } from './ports/email/noop.adapter.js'
import type { EmailPort } from './ports/email/email.port.js'
import { createCheckoutRouter } from './checkout/checkout.routes.js'
import { createRateLimiter } from './lib/rate-limit.js'

export interface AppDeps {
  payments: PaymentsPort
  shipping: ShippingPort
  email: EmailPort
  /** Base for Stripe's return_url; env STOREFRONT_PUBLIC_URL by default. */
  storefrontUrl: string | null
  checkoutRateLimit: RequestHandler
}

export function buildApp(deps: Partial<AppDeps> = {}): Express {
  // createPaymentsPort throws on half-configured Stripe -- the process refuses
  // to start rather than take money it can never mark paid (spec §8).
  const payments = deps.payments ?? createPaymentsPort()
  const shipping = deps.shipping ?? createFlatRateShippingPort()
  // `email` is used by the Stripe webhook (Task 7).
  const email = deps.email ?? noopEmailAdapter
  const storefrontUrl = (deps.storefrontUrl !== undefined ? deps.storefrontUrl : (process.env.STOREFRONT_PUBLIC_URL ?? null))
    ?.replace(/\/+$/, '') ?? null
  const checkoutRateLimit = deps.checkoutRateLimit ?? createRateLimiter({ limit: 20, windowMs: 60_000 })

  const app = express()
  // Render terminates TLS one proxy hop in front of the app. Without this,
  // req.ip is the proxy's address and the checkout rate limit (and the
  // session ip recorded at sign-in) would treat every customer as one.
  app.set('trust proxy', 1)
  app.use(express.json())
  app.get('/health', (_req, res) => res.json({ status: 'ok' }))
```

Replace the `// Deliberately no CORS handler here …` comment block and the `app.use('/api/v1/orders', ordersRouter)` line with:

```ts
  // Storefront checkout (spec §4). Public like catalog: storefront allowlist,
  // credentials off. POST is rate-limited per IP inside the router so the
  // endpoint cannot be used to hold stock. The old public POST/GET
  // /api/v1/orders routes are retired (spec §2): POST reserved stock with no
  // payment, GET exposed addresses to anyone holding an order id.
  app.use('/api/v1/checkout', createCors({ origins: allowedStorefrontOrigins, credentials: false }))
  app.use('/api/v1/checkout', createCheckoutRouter({ payments, shipping, storefrontUrl, rateLimit: checkoutRateLimit }))
```

Then add `void email` right before `return app`, so `noUnusedLocals` does not fail the build before Task 7 uses it:

```ts
  void email // consumed by the Stripe webhook mount (Task 7)
  return app
```

Delete the old files and the route case:

```bash
git rm systems/core/src/orders/orders.routes.ts systems/core/tests/orders-api.test.ts
```

In `tests/orders-post-commit-push.test.ts`, delete the whole `it('POST /api/v1/orders returns 201, not 500, …')` case, and remove the now-unused `request`, `buildApp` imports and the `const app = buildApp()` line. The service-level case stays.

- [ ] **Step 9: Run**

Run: `npx vitest run tests/rate-limit.test.ts tests/checkout-routes.test.ts tests/orders-post-commit-push.test.ts tests/cors.test.ts tests/auth-route-coverage.test.ts`
Expected: PASS. If `auth-route-coverage.test.ts` enumerates mounted prefixes and fails on `/api/v1/orders` or `/api/v1/checkout`, update its expected list: `/api/v1/orders` removed, `/api/v1/checkout` added as a public (non-admin) prefix. That test exists to force exactly this review.

- [ ] **Step 10: Full suite, typecheck, commit**

Run: `npx vitest run && npm run typecheck`. Expected: all pass (the three deleted `orders-api` cases are gone from the count).

```bash
git add systems/core/src systems/core/tests
git commit -m "feat(core): storefront checkout endpoint; retire public order routes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 7: Stripe webhook — verification, de-duplication, and the four events

**Files:**
- Create: `systems/core/src/payments/stripe-events.ts`
- Create: `systems/core/src/payments/stripe-webhook.routes.ts`
- Modify: `systems/core/src/app.ts`
- Modify: `systems/core/tests/helpers/checkout.ts` (event helpers)
- Test: `systems/core/tests/stripe-webhook.test.ts`

**Interfaces:**
- Consumes: `lockOrderRow`, `markOrderPaidTx`, `cancelOrderTx`, `refundOrderTx`, `enqueueInventoryPushesAfterCommit`, `orderNumber` (Task 4); `upsertCustomerFromCheckout`, `normalizeEmail`, `resolveReferral`, `EmailPort` (Task 3); `PaymentsPort`, `WebhookSignatureError` (Task 5); `recordAudit`.
- Produces:
  - `OUTSIDE_SHIPPING_AREA: ReadonlySet<string>` = AK, HI, PR, GU, VI, AS, MP, AA, AE, AP
  - `type EventOutcome = 'processed' | 'duplicate' | 'ignored' | 'retry'`
  - `handleStripeEvent(event: Stripe.Event, deps: { email: EmailPort }): Promise<EventOutcome>`
  - `createStripeWebhookHandler(deps: { payments: PaymentsPort; email: EmailPort }): RequestHandler`
  - HTTP `POST /api/v1/webhooks/stripe`: 200 `{ received: true, outcome }`, 400 `bad_signature`, 503 `retry_later` / `webhook_not_configured`.
  - Test helpers: `stripeEvent(type: string, object: Record<string, unknown>, id?: string)`, `deliver(app, payments, event, signature?)`, `completedSession(opts)`.

- [ ] **Step 1: Event helpers**

Append to `tests/helpers/checkout.ts`:

```ts
let seq = 0
/** A Stripe event envelope as the endpoint would render it (API 2026-08-26.dahlia). */
export function stripeEvent(type: string, object: Record<string, unknown>, id = `evt_test_${Date.now()}_${++seq}`) {
  return {
    id, object: 'event', type, api_version: '2026-08-26.dahlia', created: Math.floor(Date.now() / 1000),
    livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null }, data: { object },
  }
}

/** POSTs `event` with a valid signature (or the one given) exactly as Stripe does: raw JSON bytes. */
export function deliver(app: Express, payments: FakePaymentsPort, event: object, signature?: string) {
  const payload = JSON.stringify(event)
  return request(app).post('/api/v1/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', signature ?? payments.sign(payload))
    .send(payload)
}

/**
 * A checkout.session.completed object. Defaults are internally consistent:
 * amount_total = subtotal + shipping + tax.
 */
export function completedSession(o: {
  orderId: string; sessionId: string; subtotal: number; shipping?: number; tax?: number; total?: number
  state?: string; country?: string; email?: string; name?: string; paymentIntent?: string; paymentStatus?: string
}) {
  const shipping = o.shipping ?? 995
  const tax = o.tax ?? 0
  return {
    id: o.sessionId, object: 'checkout.session', mode: 'payment', status: 'complete',
    payment_status: o.paymentStatus ?? 'paid',
    client_reference_id: o.orderId, metadata: { orderId: o.orderId },
    amount_subtotal: o.subtotal, amount_total: o.total ?? o.subtotal + shipping + tax,
    total_details: { amount_discount: 0, amount_shipping: shipping, amount_tax: tax },
    shipping_cost: { amount_subtotal: shipping, amount_tax: 0, amount_total: shipping, shipping_rate: 'shr_test' },
    customer_details: { email: o.email ?? 'Buyer@Example.com', name: o.name ?? 'Ann Buyer', address: null },
    collected_information: {
      shipping_details: {
        name: o.name ?? 'Ann Buyer',
        address: { line1: '1 Main St', line2: 'Apt 2', city: 'Traverse City', state: o.state ?? 'MI', postal_code: '49684', country: o.country ?? 'US' },
      },
    },
    payment_intent: o.paymentIntent ?? `pi_test_${o.orderId}`,
  }
}
```

(`FakePaymentsPort`, `request` and `Express` are already imported at the top of the file from Task 6.)

- [ ] **Step 2: Write the failing test**

```ts
// tests/stripe-webhook.test.ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { fulfillOrder } from '../src/orders/orders.service.js'
import { unconfiguredPaymentsPort } from '../src/ports/payments/index.js'
import type { EmailPort } from '../src/ports/email/email.port.js'
import {
  makeApp, postCheckout, variantIdBySku, inventoryOf, stripeEvent, deliver, completedSession,
} from './helpers/checkout.js'

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(async () => {
  await resetDb(); await seed()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterAll(async () => { errorSpy.mockRestore(); await prisma.$disconnect() })

/** A pending checkout for `qty` x BBS-STD ($49.99), through the real endpoint. */
async function pendingOrder(app: any, qty = 2, extra: Record<string, unknown> = {}) {
  const res = await postCheckout(app, { lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: qty }], ...extra })
  return prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } })
}

function setup() {
  const email: EmailPort = { orderPaid: vi.fn(async () => {}) }
  return { ...makeApp({ email }), email }
}

describe('POST /api/v1/webhooks/stripe', () => {
  it('rejects a bad signature with 400 and records nothing', async () => {
    const { app, payments } = setup()
    const res = await deliver(app, payments, stripeEvent('checkout.session.expired', {}), 't=1,v1=deadbeef')
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('bad_signature')
    expect(await prisma.stripeEvent.count()).toBe(0)
  })

  it('503s when Stripe is not configured', async () => {
    const { app } = makeApp({ payments: unconfiguredPaymentsPort })
    const { payments: signer } = makeApp() // only used to produce a well-formed signature
    expect((await deliver(app, signer, stripeEvent('checkout.session.expired', {}))).status).toBe(503)
  })

  it('checkout.session.completed marks the order paid with Stripe’s figures', async () => {
    const { app, payments, email } = setup()
    const order = await pendingOrder(app, 2, { marketingOptIn: true })
    const res = await deliver(app, payments, stripeEvent('checkout.session.completed', completedSession({
      orderId: order.id, sessionId: order.stripeCheckoutSessionId!, subtotal: 9998, shipping: 995, tax: 660,
    })))
    expect(res.status).toBe(200)
    expect(res.body.outcome).toBe('processed')

    const paid = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(paid).toMatchObject({
      status: 'paid', email: 'buyer@example.com', taxCents: 660, shippingCents: 995, totalCents: 11653,
      taxJurisdiction: 'stripe_tax', taxRateBps: 600, shipToState: 'MI', shipName: 'Ann Buyer',
      shipLine1: '1 Main St', shipLine2: 'Apt 2', shipCity: 'Traverse City', shipPostalCode: '49684',
      stripePaymentIntentId: `pi_test_${order.id}`, reviewReason: null,
    })
    expect(paid.paidAt).toBeInstanceOf(Date)
    expect((await inventoryOf('BBS-STD'))).toMatchObject({ onHand: 25, reserved: 2 }) // paid keeps the hold
    const customer = await prisma.customer.findUniqueOrThrow({ where: { email: 'buyer@example.com' } })
    expect(paid.customerId).toBe(customer.id)
    expect(customer.marketingConsent).toBe(true)
    expect(email.orderPaid).toHaveBeenCalledWith({ orderId: order.id, orderNumber: expect.stringMatching(/^ABE-/), email: 'buyer@example.com' })
  })

  it('treats a redelivered event as already processed', async () => {
    const { app, payments } = setup()
    const order = await pendingOrder(app)
    const evt = stripeEvent('checkout.session.completed', completedSession({ orderId: order.id, sessionId: order.stripeCheckoutSessionId!, subtotal: 9998 }))
    expect((await deliver(app, payments, evt)).body.outcome).toBe('processed')
    const again = await deliver(app, payments, evt)
    expect(again.status).toBe(200)
    expect(again.body.outcome).toBe('duplicate')
    expect(await prisma.auditLog.count({ where: { action: 'order.paid', target: `order:${order.id}` } })).toBe(1)
  })

  it('applies concurrent duplicate deliveries exactly once', async () => {
    const { app, payments } = setup()
    const order = await pendingOrder(app)
    const evt = stripeEvent('checkout.session.completed', completedSession({ orderId: order.id, sessionId: order.stripeCheckoutSessionId!, subtotal: 9998 }))
    const results = await Promise.all(Array.from({ length: 5 }, () => deliver(app, payments, evt)))
    expect(results.every((r) => r.status === 200)).toBe(true)
    expect(results.map((r) => r.body.outcome).sort()).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'processed'])
    expect(await prisma.auditLog.count({ where: { action: 'order.paid', target: `order:${order.id}` } })).toBe(1)
  })

  it('still marks paid, but flags amount_mismatch, when totals disagree', async () => {
    const { app, payments } = setup()
    const order = await pendingOrder(app)
    await deliver(app, payments, stripeEvent('checkout.session.completed', completedSession({
      orderId: order.id, sessionId: order.stripeCheckoutSessionId!, subtotal: 9998, total: 1,
    })))
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'paid', reviewReason: 'amount_mismatch', totalCents: 1 })
  })

  it('flags paid_after_cancel and leaves stock released', async () => {
    const { app, payments } = setup()
    const order = await pendingOrder(app)
    await deliver(app, payments, stripeEvent('checkout.session.expired', { id: order.stripeCheckoutSessionId, object: 'checkout.session', metadata: { orderId: order.id } }))
    await deliver(app, payments, stripeEvent('checkout.session.completed', completedSession({ orderId: order.id, sessionId: order.stripeCheckoutSessionId!, subtotal: 9998 })))
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(o).toMatchObject({ status: 'cancelled', reviewReason: 'paid_after_cancel', stripePaymentIntentId: `pi_test_${order.id}` })
    expect((await inventoryOf('BBS-STD')).reserved).toBe(0)
  })

  it.each(['AK', 'HI', 'PR', 'AE'])('flags a paid order shipping to %s as outside_shipping_area', async (state) => {
    const { app, payments } = setup()
    const order = await pendingOrder(app)
    await deliver(app, payments, stripeEvent('checkout.session.completed', completedSession({ orderId: order.id, sessionId: order.stripeCheckoutSessionId!, subtotal: 9998, state })))
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'paid', reviewReason: 'outside_shipping_area', shipToState: state })
  })

  it('resolves a seeded referral and flags an unknown one', async () => {
    const { app, payments } = setup()
    const partner = await prisma.affiliatePartner.create({ data: { name: 'Brick Club' } })
    await prisma.referralCode.create({ data: { code: 'club', partnerId: partner.id, commissionRateBps: 800 } })
    const seen = new Date(Date.now() - 3_600_000).toISOString()
    const matched = await pendingOrder(app, 1, { referral: { code: 'club', firstSeenAt: seen } })
    const unknown = await pendingOrder(app, 1, { referral: { code: 'nobody', firstSeenAt: seen } })
    for (const o of [matched, unknown]) {
      await deliver(app, payments, stripeEvent('checkout.session.completed', completedSession({ orderId: o.id, sessionId: o.stripeCheckoutSessionId!, subtotal: 4999 })))
    }
    expect(await prisma.order.findUniqueOrThrow({ where: { id: matched.id } })).toMatchObject({ affiliatePartnerId: partner.id, commissionRateBps: 800, referralUnmatched: false })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: unknown.id } })).toMatchObject({ affiliatePartnerId: null, commissionRateBps: null, referralUnmatched: true })
  })

  it('ignores an unpaid completed session', async () => {
    const { app, payments } = setup()
    const order = await pendingOrder(app)
    await deliver(app, payments, stripeEvent('checkout.session.completed', completedSession({ orderId: order.id, sessionId: order.stripeCheckoutSessionId!, subtotal: 9998, paymentStatus: 'unpaid' })))
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('pending')
  })

  it('checkout.session.expired cancels a pending order and ignores a paid one', async () => {
    const { app, payments } = setup()
    const a = await pendingOrder(app, 1)
    const b = await pendingOrder(app, 1)
    await deliver(app, payments, stripeEvent('checkout.session.completed', completedSession({ orderId: b.id, sessionId: b.stripeCheckoutSessionId!, subtotal: 4999 })))
    for (const o of [a, b]) {
      await deliver(app, payments, stripeEvent('checkout.session.expired', { id: o.stripeCheckoutSessionId, object: 'checkout.session', metadata: { orderId: o.id } }))
    }
    expect((await prisma.order.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('cancelled')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('paid')
    expect((await inventoryOf('BBS-STD')).reserved).toBe(1)
  })

  async function paidOrder(app: any, payments: any, qty = 2) {
    const o = await pendingOrder(app, qty)
    await deliver(app, payments, stripeEvent('checkout.session.completed', completedSession({ orderId: o.id, sessionId: o.stripeCheckoutSessionId!, subtotal: 4999 * qty })))
    return prisma.order.findUniqueOrThrow({ where: { id: o.id } })
  }
  const charge = (pi: string, amount: number, amountRefunded: number) => ({
    id: `ch_${pi}`, object: 'charge', payment_intent: pi, amount, amount_refunded: amountRefunded, refunded: amountRefunded >= amount,
  })

  it('full refund before shipment: refunded and the hold released', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app, payments)
    await deliver(app, payments, stripeEvent('charge.refunded', charge(o.stripePaymentIntentId!, o.totalCents, o.totalCents)))
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ status: 'refunded', refundedCents: o.totalCents })
    expect(await inventoryOf('BBS-STD')).toMatchObject({ onHand: 25, reserved: 0 })
  })

  it('full refund after shipment: refunded, stock untouched', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app, payments)
    await fulfillOrder(o.id)
    await deliver(app, payments, stripeEvent('charge.refunded', charge(o.stripePaymentIntentId!, o.totalCents, o.totalCents)))
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('refunded')
    expect(await inventoryOf('BBS-STD')).toMatchObject({ onHand: 23, reserved: 0 })
  })

  it('partial refund: amount only', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app, payments)
    await deliver(app, payments, stripeEvent('charge.refunded', charge(o.stripePaymentIntentId!, o.totalCents, 500)))
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ status: 'paid', refundedCents: 500 })
    expect((await inventoryOf('BBS-STD')).reserved).toBe(2)
  })

  it('out of order: a refund before the completed event is retried, then applies', async () => {
    const { app, payments } = setup()
    const o = await pendingOrder(app, 1)
    const pi = `pi_test_${o.id}`
    const refundEvt = stripeEvent('charge.refunded', charge(pi, 5994, 5994))
    const early = await deliver(app, payments, refundEvt)
    expect(early.status).toBe(503)
    expect(await prisma.stripeEvent.count({ where: { id: refundEvt.id } })).toBe(0)

    await deliver(app, payments, stripeEvent('checkout.session.completed', completedSession({ orderId: o.id, sessionId: o.stripeCheckoutSessionId!, subtotal: 4999, paymentIntent: pi })))
    const retried = await deliver(app, payments, refundEvt)
    expect(retried.body.outcome).toBe('processed')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('refunded')
  })

  it('charge.dispute.created flags the order for review', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app, payments, 1)
    await deliver(app, payments, stripeEvent('charge.dispute.created', { id: 'dp_1', object: 'dispute', charge: 'ch_1', payment_intent: o.stripePaymentIntentId }))
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).reviewReason).toBe('disputed')
    expect(errorSpy).toHaveBeenCalled()
  })

  it('acknowledges event types it does not handle without recording them', async () => {
    const { app, payments } = setup()
    const res = await deliver(app, payments, stripeEvent('customer.created', { id: 'cus_1' }))
    expect(res.status).toBe(200)
    expect(res.body.outcome).toBe('ignored')
    expect(await prisma.stripeEvent.count()).toBe(0)
  })
})
```

The expected `taxRateBps: 600` is `round(660 * 10000 / (9998 + 995))` = `round(600.38)` = 600. The expected `totalCents: 11653` is 9998 + 995 + 660.

- [ ] **Step 3: Run to see it fail**

Run: `npx vitest run tests/stripe-webhook.test.ts`
Expected: FAIL — 404 on `/api/v1/webhooks/stripe`.

- [ ] **Step 4: Event handling**

```ts
// src/payments/stripe-events.ts
import type Stripe from 'stripe'
import { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { recordAudit } from '../audit.js'
import {
  lockOrderRow, markOrderPaidTx, cancelOrderTx, refundOrderTx, enqueueInventoryPushesAfterCommit, orderNumber,
} from '../orders/orders.service.js'
import { upsertCustomerFromCheckout, normalizeEmail } from '../customers/customers.service.js'
import { resolveReferral } from '../referrals/referrals.service.js'
import type { EmailPort } from '../ports/email/email.port.js'
import { scrubError } from '../auth/scrub.js'

/** Spec §4: AK, HI, and territory/military codes. */
export const OUTSIDE_SHIPPING_AREA: ReadonlySet<string> = new Set(['AK', 'HI', 'PR', 'GU', 'VI', 'AS', 'MP', 'AA', 'AE', 'AP'])

export type EventOutcome = 'processed' | 'duplicate' | 'ignored' | 'retry'

const HANDLED = new Set(['checkout.session.completed', 'checkout.session.expired', 'charge.refunded', 'charge.dispute.created'])

class DuplicateEvent extends Error {}
/** Thrown when the event cannot be applied YET; the route answers 503 and Stripe redelivers. */
class RetryLater extends Error {}

type Tx = Prisma.TransactionClient
/** Work to run after the transaction commits (inventory pushes, email). */
type FollowUp = () => Promise<void>

const idOf = (v: string | { id: string } | null | undefined): string | null =>
  typeof v === 'string' ? v : v?.id ?? null

async function onCompleted(tx: Tx, session: Stripe.Checkout.Session, deps: { email: EmailPort }): Promise<FollowUp | null> {
  if (session.payment_status !== 'paid') {
    console.warn('[stripe] completed session not paid; ignoring', session.id, session.payment_status)
    return null
  }
  const orderId = session.metadata?.orderId ?? session.client_reference_id
  const order = orderId ? await lockOrderRow(tx, orderId) : null
  if (!order) {
    console.error('[stripe] completed session for an unknown order', session.id, orderId)
    return null
  }

  const ship = session.collected_information?.shipping_details ?? null
  const addr = ship?.address
  const rawEmail = session.customer_details?.email
  const state = (addr?.state ?? '').trim().toUpperCase()
  const details = {
    email: rawEmail ? normalizeEmail(rawEmail) : order.email,
    shipName: ship?.name ?? session.customer_details?.name ?? null,
    shipLine1: addr?.line1 ?? null,
    shipLine2: addr?.line2 ?? null,
    shipCity: addr?.city ?? null,
    shipPostalCode: addr?.postal_code ?? null,
    shipToState: state,
    stripePaymentIntentId: idOf(session.payment_intent as string | { id: string } | null),
    paidAt: new Date(),
  }

  if (order.status === 'cancelled') {
    // The sweep or an admin beat the webhook. Money was taken: record who
    // paid so a human can refund in Stripe (spec §5).
    await tx.order.update({ where: { id: order.id }, data: { ...details, reviewReason: 'paid_after_cancel' } })
    await recordAudit({ actorId: 'system', action: 'order.paid_after_cancel', target: `order:${order.id}`, after: { stripePaymentIntentId: details.stripePaymentIntentId } }, tx)
    console.error(`[stripe] order ${order.id} was PAID AFTER IT WAS CANCELLED -- refund it in Stripe`)
    return null
  }
  if (order.status !== 'pending') {
    console.warn('[stripe] completed session for a non-pending order; ignoring', order.id, order.status)
    return null
  }

  // total_details.amount_tax is ALL tax, including tax on shipping, and
  // amount_shipping is pre-tax -- so the identity is subtotal + shipping + tax
  // (- discount). shipping_cost.amount_total already includes shipping tax and
  // would double-count it (plan header).
  const taxCents = session.total_details?.amount_tax ?? 0
  const shippingCents = session.total_details?.amount_shipping ?? 0
  const discountCents = session.total_details?.amount_discount ?? 0
  const totalCents = session.amount_total ?? 0
  const expected = order.subtotalCents + shippingCents + taxCents - discountCents
  const mismatch = totalCents !== expected
  const outside = OUTSIDE_SHIPPING_AREA.has(state) || (addr?.country != null && addr.country !== 'US')
  if (mismatch) console.error(`[stripe] order ${order.id} amount mismatch: Stripe ${totalCents}, expected ${expected}`)
  if (outside) console.error(`[stripe] order ${order.id} ships outside the contiguous US (${state || addr?.country}) -- refund in Stripe`)
  const base = order.subtotalCents + shippingCents

  const paid = await markOrderPaidTx(tx, order.id, 'system', {
    ...details,
    taxCents, shippingCents, totalCents,
    taxJurisdiction: 'stripe_tax',
    // Effective rate over the taxable base Stripe saw (goods + shipping).
    taxRateBps: base > 0 ? Math.round((taxCents * 10000) / base) : 0,
    reviewReason: mismatch ? 'amount_mismatch' : outside ? 'outside_shipping_area' : null,
  })

  const customer = await upsertCustomerFromCheckout({ email: details.email, name: details.shipName, consent: order.marketingOptIn }, tx)
  const referral = order.referralCode ? await resolveReferral(order.referralCode, tx) : null
  await tx.order.update({
    where: { id: order.id },
    data: {
      customerId: customer.id,
      ...(order.referralCode
        ? referral
          ? { affiliatePartnerId: referral.partnerId, commissionRateBps: referral.commissionRateBps }
          : { referralUnmatched: true }
        : {}),
    },
  })

  return async () => {
    try {
      await deps.email.orderPaid({ orderId: paid.id, orderNumber: orderNumber(paid.number), email: details.email })
    } catch (err) {
      console.error('[stripe] orderPaid email failed', paid.id, scrubError(err))
    }
  }
}

async function onExpired(tx: Tx, session: Stripe.Checkout.Session): Promise<FollowUp | null> {
  const orderId = session.metadata?.orderId ?? session.client_reference_id
  const order = orderId ? await lockOrderRow(tx, orderId) : null
  if (!order || order.status !== 'pending') return null
  const cancelled = await cancelOrderTx(tx, order.id, 'system')
  return () => enqueueInventoryPushesAfterCommit(cancelled.lines.map((l) => l.variantId), `checkout.expired order:${order.id}`)
}

async function orderIdByPaymentIntent(tx: Tx, pi: string | null): Promise<string> {
  const order = pi ? await tx.order.findUnique({ where: { stripePaymentIntentId: pi }, select: { id: true } }) : null
  // Not found yet: the completed event may not have landed. 503 -> Stripe retries
  // (plan decision 6). A charge unrelated to the storefront retries until Stripe gives up.
  if (!order) throw new RetryLater(`no order for payment intent ${pi}`)
  return order.id
}

async function onRefunded(tx: Tx, charge: Stripe.Charge): Promise<FollowUp | null> {
  const orderId = await orderIdByPaymentIntent(tx, idOf(charge.payment_intent as string | { id: string } | null))
  const full = charge.refunded === true || charge.amount_refunded >= charge.amount
  const { releasedVariantIds } = await refundOrderTx(tx, orderId, { refundedCents: charge.amount_refunded, full }, 'system')
  return releasedVariantIds.length
    ? () => enqueueInventoryPushesAfterCommit(releasedVariantIds, `charge.refunded order:${orderId}`)
    : null
}

async function onDispute(tx: Tx, dispute: Stripe.Dispute): Promise<FollowUp | null> {
  const orderId = await orderIdByPaymentIntent(tx, idOf(dispute.payment_intent as string | { id: string } | null))
  await tx.order.update({ where: { id: orderId }, data: { reviewReason: 'disputed' } })
  await recordAudit({ actorId: 'system', action: 'order.disputed', target: `order:${orderId}`, after: { dispute: dispute.id } }, tx)
  console.error(`[stripe] order ${orderId} has a DISPUTE (${dispute.id}) -- respond in the Stripe dashboard`)
  return null
}

/**
 * Applies one verified event. The StripeEvent insert and the event's effects
 * share one transaction (spec §5): a crash commits neither, and a concurrent
 * or repeated delivery blocks on the primary key, then fails with P2002
 * -> 'duplicate'.
 */
export async function handleStripeEvent(event: Stripe.Event, deps: { email: EmailPort }): Promise<EventOutcome> {
  if (!HANDLED.has(event.type)) return 'ignored'
  let followUp: FollowUp | null = null
  try {
    followUp = await prisma.$transaction(async (tx) => {
      try {
        await tx.stripeEvent.create({ data: { id: event.id, type: event.type } })
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new DuplicateEvent()
        throw err
      }
      const object = event.data.object as unknown
      switch (event.type) {
        case 'checkout.session.completed': return onCompleted(tx, object as Stripe.Checkout.Session, deps)
        case 'checkout.session.expired': return onExpired(tx, object as Stripe.Checkout.Session)
        case 'charge.refunded': return onRefunded(tx, object as Stripe.Charge)
        case 'charge.dispute.created': return onDispute(tx, object as Stripe.Dispute)
        default: return null
      }
    })
  } catch (err) {
    if (err instanceof DuplicateEvent) return 'duplicate'
    if (err instanceof RetryLater) {
      console.warn('[stripe] deferring event', event.id, event.type, err.message)
      return 'retry'
    }
    throw err
  }
  if (followUp) await followUp()
  return 'processed'
}
```

- [ ] **Step 5: The route and its mount**

```ts
// src/payments/stripe-webhook.routes.ts
import type { RequestHandler } from 'express'
import { asyncHandler } from '../lib/async-handler.js'
import { WebhookSignatureError, type PaymentsPort } from '../ports/payments/payments.port.js'
import type { EmailPort } from '../ports/email/email.port.js'
import { handleStripeEvent } from './stripe-events.js'

/**
 * POST /api/v1/webhooks/stripe. Mounted in app.ts BEFORE express.json with
 * express.raw: signature verification needs the exact bytes Stripe signed.
 * No CORS, auth, origin or content-type middleware -- the signature is the
 * only auth layer (spec §5).
 */
export function createStripeWebhookHandler(deps: { payments: PaymentsPort; email: EmailPort }): RequestHandler {
  return asyncHandler(async (req, res) => {
    if (!deps.payments.configured) return res.status(503).json({ code: 'webhook_not_configured' })
    const signature = req.get('stripe-signature')
    if (!signature || !Buffer.isBuffer(req.body)) return res.status(400).json({ code: 'bad_signature' })
    let event
    try {
      event = deps.payments.constructWebhookEvent(req.body, signature)
    } catch (err) {
      if (err instanceof WebhookSignatureError) return res.status(400).json({ code: 'bad_signature' })
      throw err
    }
    const outcome = await handleStripeEvent(event, { email: deps.email })
    if (outcome === 'retry') return res.status(503).json({ code: 'retry_later' })
    res.status(200).json({ received: true, outcome })
  })
}
```

In `src/app.ts`: add `import { createStripeWebhookHandler } from './payments/stripe-webhook.routes.js'`, delete the `void email` line from Task 6, and insert this between `app.set('trust proxy', 1)` and `app.use(express.json())`:

```ts
  // Stripe webhook: raw body, registered BEFORE express.json. body-parser
  // skips a request whose body was already read (req._body), so the JSON
  // parser below never touches these bytes. Nothing else is mounted on this
  // path -- see stripe-webhook.routes.ts.
  app.post(
    '/api/v1/webhooks/stripe',
    express.raw({ type: 'application/json', limit: '1mb' }),
    createStripeWebhookHandler({ payments, email }),
  )
```

- [ ] **Step 6: Run**

Run: `npx vitest run tests/stripe-webhook.test.ts`
Expected: PASS (19 tests). If the concurrent-duplicate test ever reports two `processed`, the StripeEvent insert has moved out of the effects' transaction. That is a bug; do not loosen the test.

- [ ] **Step 7: Full suite, typecheck, commit**

Run: `npx vitest run && npm run typecheck`. Expected: all pass.

```bash
git add systems/core/src/payments systems/core/src/app.ts systems/core/tests/helpers/checkout.ts systems/core/tests/stripe-webhook.test.ts
git commit -m "feat(core): Stripe webhook with signature checks, de-dup and four order events" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 8: Abandoned-checkout sweep

**Files:**
- Create: `systems/core/src/checkout/sweep.ts`
- Modify: `systems/core/src/server.ts`
- Test: `systems/core/tests/checkout-sweep.test.ts`

**Interfaces:**
- Consumes: `cancelOrder`, `OrderError` (Task 4); `getShopSettings` (Task 2); `PaymentsPort` (Task 5); `createPaymentsPort` (Task 5); `makeApp`, `postCheckout`, `variantIdBySku`, `inventoryOf` (Task 6 helpers).
- Produces:
  - `SWEEP_INTERVAL_MS = 300_000`, `SWEEP_GRACE_MINUTES = 10`
  - `sweepAbandonedCheckouts(payments: PaymentsPort, now?: Date): Promise<{ cancelled: string[]; skipped: string[] }>`
  - `startCheckoutSweep(payments: PaymentsPort, intervalMs?: number): () => void` (returns a stop function)

- [ ] **Step 1: Write the failing test**

```ts
// tests/checkout-sweep.test.ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { placeOrder, PENDING_CHECKOUT_EMAIL } from '../src/orders/orders.service.js'
import { deferredTaxAdapter } from '../src/ports/tax/deferred.adapter.js'
import { unconfiguredPaymentsPort } from '../src/ports/payments/index.js'
import { sweepAbandonedCheckouts, startCheckoutSweep } from '../src/checkout/sweep.js'
import { makeApp, postCheckout, variantIdBySku, inventoryOf } from './helpers/checkout.js'

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(async () => {
  await resetDb(); await seed()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterAll(async () => { errorSpy.mockRestore(); await prisma.$disconnect() })

const age = (id: string, minutes: number) =>
  prisma.order.update({ where: { id }, data: { createdAt: new Date(Date.now() - minutes * 60_000) } })

async function agedCheckout(app: any, minutes: number) {
  const res = await postCheckout(app, { lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: 1 }] })
  await age(res.body.orderId, minutes)
  return prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } })
}

describe('sweepAbandonedCheckouts', () => {
  it('cancels an old pending order whose session Stripe reports expired', async () => {
    const { app, payments } = makeApp()
    const o = await agedCheckout(app, 41) // session 30 + grace 10
    payments.setSession(o.stripeCheckoutSessionId!, 'expired')
    expect(await sweepAbandonedCheckouts(payments)).toEqual({ cancelled: [o.id], skipped: [] })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('cancelled')
    expect((await inventoryOf('BBS-STD')).reserved).toBe(0)
  })

  it('cancels complete-but-unpaid sessions', async () => {
    const { app, payments } = makeApp()
    const o = await agedCheckout(app, 41)
    payments.setSession(o.stripeCheckoutSessionId!, 'complete', 'unpaid')
    expect((await sweepAbandonedCheckouts(payments)).cancelled).toEqual([o.id])
  })

  it('leaves a paid session alone and logs the missed webhook', async () => {
    const { app, payments } = makeApp()
    const o = await agedCheckout(app, 41)
    payments.setSession(o.stripeCheckoutSessionId!, 'complete', 'paid')
    expect(await sweepAbandonedCheckouts(payments)).toEqual({ cancelled: [], skipped: [o.id] })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('pending')
    expect(errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('webhook')
  })

  it('leaves open sessions and young orders alone', async () => {
    const { app, payments } = makeApp()
    const open = await agedCheckout(app, 41)
    const young = await agedCheckout(app, 39)
    payments.setSession(young.stripeCheckoutSessionId!, 'expired')
    const out = await sweepAbandonedCheckouts(payments)
    expect(out.cancelled).toEqual([])
    expect(out.skipped).toEqual([open.id])
  })

  it('cancels a stale storefront order that never got a session', async () => {
    const { payments } = makeApp()
    const orphan = await placeOrder({ email: PENDING_CHECKOUT_EMAIL, shipToState: '', lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: 2 }] }, deferredTaxAdapter)
    await age(orphan.id, 41)
    expect((await sweepAbandonedCheckouts(payments)).cancelled).toEqual([orphan.id])
    expect((await inventoryOf('BBS-STD')).reserved).toBe(0)
  })

  it('never touches Walmart orders', async () => {
    const { payments } = makeApp()
    const w = await prisma.order.create({ data: {
      channel: 'walmart', externalOrderId: 'PO-1', email: 'w@example.com', shipToState: 'MI',
      subtotalCents: 100, taxCents: 0, totalCents: 100, taxRateBps: 0, taxJurisdiction: 'none',
      createdAt: new Date(Date.now() - 3 * 3_600_000),
    } })
    expect(await sweepAbandonedCheckouts(payments)).toEqual({ cancelled: [], skipped: [] })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: w.id } })).status).toBe('pending')
  })

  it('does not start without Stripe', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const stop = startCheckoutSweep(unconfiguredPaymentsPort)
    expect(typeof stop).toBe('function')
    stop()
    expect(logSpy.mock.calls.join(' ')).toContain('not started')
    logSpy.mockRestore()
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/checkout-sweep.test.ts`
Expected: FAIL, `sweep.js` not found.

- [ ] **Step 3: Implement**

```ts
// src/checkout/sweep.ts
import { prisma } from '../prisma.js'
import { cancelOrder, OrderError } from '../orders/orders.service.js'
import { getShopSettings } from '../settings/shop-settings.service.js'
import type { PaymentsPort } from '../ports/payments/payments.port.js'
import { scrubError } from '../auth/scrub.js'

export const SWEEP_INTERVAL_MS = 5 * 60_000
export const SWEEP_GRACE_MINUTES = 10
const BATCH = 100

/**
 * Backstop for a missed checkout.session.expired webhook (spec §5). Cancels
 * pending STOREFRONT orders older than session lifetime + grace when Stripe
 * reports the session expired, or complete-but-unpaid. An order that never
 * got a session (the process died between placeOrder and saving the id) is
 * cancelled too (plan decision 5). A paid session with a pending order means
 * the webhook was missed: it is logged, never cancelled -- money was taken.
 */
export async function sweepAbandonedCheckouts(
  payments: PaymentsPort,
  now = new Date(),
): Promise<{ cancelled: string[]; skipped: string[] }> {
  const { sessionMinutes } = await getShopSettings()
  const cutoff = new Date(now.getTime() - (sessionMinutes + SWEEP_GRACE_MINUTES) * 60_000)
  const stale = await prisma.order.findMany({
    where: { status: 'pending', channel: 'storefront', createdAt: { lt: cutoff } },
    select: { id: true, stripeCheckoutSessionId: true },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  })
  const cancelled: string[] = []
  const skipped: string[] = []
  for (const order of stale) {
    try {
      if (order.stripeCheckoutSessionId) {
        const s = await payments.retrieveCheckoutSession(order.stripeCheckoutSessionId)
        const abandoned = s.status === 'expired' || (s.status === 'complete' && s.paymentStatus !== 'paid')
        if (!abandoned) {
          if (s.status === 'complete') {
            console.error(`[checkout-sweep] order ${order.id} is PAID in Stripe but still pending here -- the completed webhook was missed; resend it from the Stripe dashboard`)
          }
          skipped.push(order.id)
          continue
        }
      }
      await cancelOrder(order.id, 'system')
      cancelled.push(order.id)
    } catch (err) {
      if (!(err instanceof OrderError && err.code === 'invalid_transition')) {
        console.error('[checkout-sweep] failed for order', order.id, scrubError(err))
      }
      skipped.push(order.id)
    }
  }
  return { cancelled, skipped }
}

/** Runs in the web process (spec §5); core-worker is Walmart-only and unprovisioned. */
export function startCheckoutSweep(payments: PaymentsPort, intervalMs = SWEEP_INTERVAL_MS): () => void {
  if (!payments.configured) {
    console.log('checkout sweep: Stripe is not configured -- not started')
    return () => {}
  }
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    sweepAbandonedCheckouts(payments)
      .then((r) => { if (r.cancelled.length) console.log(`checkout sweep: cancelled ${r.cancelled.length} abandoned order(s)`) })
      .catch((err) => console.error('[checkout-sweep] run failed', scrubError(err)))
      .finally(() => { running = false })
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
```

```ts
// src/server.ts
import { buildApp } from './app.js'
import { createPaymentsPort } from './ports/payments/index.js'
import { startCheckoutSweep } from './checkout/sweep.js'

const port = Number(process.env.PORT ?? 4000)
// One port for the app and the sweep. createPaymentsPort throws on a
// half-configured Stripe, so the process refuses to start (spec §8).
const payments = createPaymentsPort()
buildApp({ payments }).listen(port, () => console.log(`core listening on :${port}`))
startCheckoutSweep(payments)
```

- [ ] **Step 4: Run, full suite, commit**

Run: `npx vitest run tests/checkout-sweep.test.ts && npx vitest run && npm run typecheck`
Expected: PASS.

```bash
git add systems/core/src/checkout/sweep.ts systems/core/src/server.ts systems/core/tests/checkout-sweep.test.ts
git commit -m "feat(core): sweep abandoned checkouts in the web process" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 9: Admin orders API, shipping settings API, variant weight and dimensions

**Files:**
- Create: `systems/core/src/admin/admin-orders.service.ts`
- Create: `systems/core/src/admin/admin-orders.routes.ts`
- Modify: `systems/core/src/app.ts`
- Modify: `systems/core/src/admin/product-input.ts`, `variant-write.service.ts`, `admin-product.dto.ts`
- Modify: `systems/core/tests/capture-admin-fixtures.test.ts`
- Test: `systems/core/tests/admin-orders.test.ts`, `systems/core/tests/variant-physicals.test.ts`

**Interfaces:**
- Consumes: `fulfillOrder`, `cancelOrder`, `orderNumber`, `OrderError`, `PENDING_CHECKOUT_EMAIL` (Task 4); `lineName` (Task 6); `getShopSettings`, `updateShippingSettings` (Task 2); `PaymentsPort` (Task 5); `AdminError`; `recordAudit`.
- Produces:
  - `ORDER_TABS = ['to_ship', 'shipped', 'pending', 'closed', 'review']`, `CARRIERS = ['USPS', 'UPS', 'FedEx', 'Other']`
  - `interface AdminOrderRow { id: string; orderNumber: string; createdAt: Date; email: string | null; itemCount: number; totalCents: number; shipToState: string | null; status: string; reviewReason: string | null }`
  - `listAdminOrders(q: { tab?: unknown; page?: number; pageSize?: number }): Promise<{ items: AdminOrderRow[]; total: number; page: number; pageSize: number }>`
  - `interface AdminOrderDetail`, with the fields listed in Step 3
  - `getAdminOrder(id: string, payments: Pick<PaymentsPort, 'livemode'>): Promise<AdminOrderDetail | null>`
  - `shipOrder(id: string, body: unknown, actorId: string, payments): Promise<AdminOrderDetail>`. Audit `order.ship`.
  - `cancelPendingOrder(id: string, actorId: string, payments: PaymentsPort): Promise<AdminOrderDetail>`
  - `createAdminOrdersRouter(payments: PaymentsPort): Router`
  - HTTP (all behind requireAuth/requireOrigin/requireJsonContentType): `GET /api/v1/admin/orders?tab=&page=&pageSize=`, `GET /api/v1/admin/orders/:id`, `POST /api/v1/admin/orders/:id/ship` `{ carrier, trackingNumber?, acknowledgeReview? }`, `POST /api/v1/admin/orders/:id/cancel`, `GET|PUT /api/v1/admin/settings/shipping`
  - New admin codes: `REVIEW_REQUIRED` 409, `WRONG_CHANNEL` 409, `ORDER_PAID` 409, `INVENTORY_CONFLICT` 409, `STRIPE_UNAVAILABLE` 503
  - `AdminVariantDto` gains `weightGrams`, `lengthMm`, `widthMm`, `heightMm: number | null`. Variant create and PATCH accept the same four keys (`null` clears).
  - Fixtures written to `systems/admin-ui/src/data/__fixtures__/`: `order-queue.json`, `order-detail.json`, `shipping-settings.json`, `product-with-stock.json` (now with the physical fields)

- [ ] **Step 1: Write the failing tests**

```ts
// tests/admin-orders.test.ts
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import request from 'supertest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { createSession, SESSION_COOKIE } from '../src/auth/session.service.js'
import { makeApp, postCheckout, variantIdBySku, inventoryOf, stripeEvent, deliver, completedSession } from './helpers/checkout.js'

const ORIGIN = 'https://admin-staging.alpinebrickexchange.com'
let ctx: ReturnType<typeof makeApp>
let cookie: string
let actorId: string

beforeEach(async () => {
  await resetDb(); await seed()
  process.env.ADMIN_CONSOLE_ORIGIN = ORIGIN
  vi.spyOn(console, 'error').mockImplementation(() => {})
  ctx = makeApp()
  const actor = await prisma.actor.create({ data: { type: 'human', name: 'Jack' } })
  actorId = actor.id
  cookie = `${SESSION_COOKIE}=${(await createSession(actor.id)).token}`
})
afterEach(() => { vi.restoreAllMocks() })
afterAll(async () => { delete process.env.ADMIN_CONSOLE_ORIGIN; await prisma.$disconnect() })

const get = (path: string) => request(ctx.app).get(`/api/v1/admin${path}`).set('Cookie', cookie)
const write = (method: 'post' | 'put', path: string, body: unknown = {}) =>
  request(ctx.app)[method](`/api/v1/admin${path}`).set('Cookie', cookie).set('Origin', ORIGIN)
    .set('Content-Type', 'application/json').send(JSON.stringify(body))

async function pending(qty = 1) {
  const res = await postCheckout(ctx.app, { lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: qty }] })
  return prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } })
}
async function paid(state = 'MI', qty = 1) {
  const o = await pending(qty)
  await deliver(ctx.app, ctx.payments, stripeEvent('checkout.session.completed', completedSession({
    orderId: o.id, sessionId: o.stripeCheckoutSessionId!, subtotal: 4999 * qty, state,
  })))
  return prisma.order.findUniqueOrThrow({ where: { id: o.id } })
}

describe('admin orders', () => {
  it('requires a session', async () => {
    expect((await request(ctx.app).get('/api/v1/admin/orders?tab=to_ship')).status).toBe(401)
  })

  it('queues storefront orders by tab, newest first', async () => {
    const p = await pending()
    const q = await paid()
    const r = await paid('AK')
    await prisma.order.create({ data: {
      channel: 'walmart', externalOrderId: 'PO-9', status: 'paid', email: 'w@example.com', shipToState: 'MI',
      subtotalCents: 1, taxCents: 0, totalCents: 1, taxRateBps: 0, taxJurisdiction: 'none',
    } })
    const ids = async (tab: string) => (await get(`/orders?tab=${tab}`)).body.items.map((i: any) => i.id)
    expect(await ids('to_ship')).toEqual([r.id, q.id])
    expect(await ids('pending')).toEqual([p.id])
    expect(await ids('review')).toEqual([r.id])
    expect(await ids('shipped')).toEqual([])
    expect(await ids('closed')).toEqual([])

    const page = (await get('/orders?tab=pending')).body
    expect(page).toMatchObject({ total: 1, page: 1, pageSize: 25 })
    expect(page.items[0]).toMatchObject({ email: null, itemCount: 1, totalCents: 4999, shipToState: null, status: 'pending', reviewReason: null })
    expect((await get('/orders?tab=to_ship')).body.items[1]).toMatchObject({ email: 'buyer@example.com', shipToState: 'MI' })
  })

  it('400s an unknown tab', async () => {
    const res = await get('/orders?tab=everything')
    expect(res.status).toBe(400)
    expect(res.body.fields.tab).toBeDefined()
  })

  it('returns the order detail with a test-mode Stripe link and the audit trail', async () => {
    const q = await paid()
    const res = await get(`/orders/${q.id}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: q.id, status: 'paid', email: 'buyer@example.com',
      shipTo: { name: 'Ann Buyer', line1: '1 Main St', line2: 'Apt 2', city: 'Traverse City', state: 'MI', postalCode: '49684' },
      lines: [{ sku: 'BBS-STD', name: 'Brick Builder Set', quantity: 1, unitPriceCents: 4999, lineSubtotalCents: 4999 }],
      subtotalCents: 4999, shippingCents: 995, refundedCents: 0, referral: null,
      stripePaymentUrl: `https://dashboard.stripe.com/test/payments/pi_test_${q.id}`,
    })
    expect(res.body.audit.map((a: any) => a.action)).toEqual(['order.place', 'order.paid'])
    expect(res.body.audit[0].actorName).toBe('system')
    expect((await get('/orders/nope')).status).toBe(404)
  })

  it('validates the ship form', async () => {
    const q = await paid()
    const noTracking = await write('post', `/orders/${q.id}/ship`, { carrier: 'USPS' })
    expect(noTracking.status).toBe(400)
    expect(noTracking.body.fields.trackingNumber).toBeDefined()
    const badCarrier = await write('post', `/orders/${q.id}/ship`, { carrier: 'Pigeon', trackingNumber: '1' })
    expect(badCarrier.body.fields.carrier).toBeDefined()
  })

  it('marks shipped: fulfilled, stock decremented, carrier recorded, audited', async () => {
    const q = await paid('MI', 2)
    const res = await write('post', `/orders/${q.id}/ship`, { carrier: 'USPS', trackingNumber: ' 9400 1000 0000 0000 0000 00 ' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'fulfilled', carrier: 'USPS', trackingNumber: '9400 1000 0000 0000 0000 00' })
    expect(res.body.shippedAt).toEqual(expect.any(String))
    expect(await inventoryOf('BBS-STD')).toMatchObject({ onHand: 23, reserved: 0 })
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.ship', target: `order:${q.id}` } })
    expect(audit.actorId).toBe(actorId)
  })

  it('ships with carrier Other and no tracking number', async () => {
    const q = await paid()
    expect((await write('post', `/orders/${q.id}/ship`, { carrier: 'Other' })).body).toMatchObject({ status: 'fulfilled', trackingNumber: null })
  })

  it('requires acknowledgement before shipping a flagged order', async () => {
    const r = await paid('HI')
    const refused = await write('post', `/orders/${r.id}/ship`, { carrier: 'UPS', trackingNumber: '1Z999' })
    expect(refused.status).toBe(409)
    expect(refused.body.code).toBe('REVIEW_REQUIRED')
    expect((await write('post', `/orders/${r.id}/ship`, { carrier: 'UPS', trackingNumber: '1Z999', acknowledgeReview: true })).status).toBe(200)
  })

  it('refuses to ship a pending order', async () => {
    const p = await pending()
    const res = await write('post', `/orders/${p.id}/ship`, { carrier: 'UPS', trackingNumber: '1Z999' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('INVALID_TRANSITION')
  })

  it('cancels a pending order: expires the session first, then releases stock', async () => {
    const p = await pending(3)
    const res = await write('post', `/orders/${p.id}/cancel`)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('cancelled')
    expect(ctx.payments.expired).toEqual([p.stripeCheckoutSessionId])
    expect((await inventoryOf('BBS-STD')).reserved).toBe(0)
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.cancelled', target: `order:${p.id}` } })).actorId).toBe(actorId)
  })

  it('does not cancel when the customer paid in the meantime', async () => {
    const p = await pending()
    ctx.payments.setSession(p.stripeCheckoutSessionId!, 'complete', 'paid')
    const res = await write('post', `/orders/${p.id}/cancel`)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('ORDER_PAID')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('pending')
  })

  it('refuses to cancel a paid order (refund it in Stripe)', async () => {
    const q = await paid()
    const res = await write('post', `/orders/${q.id}/cancel`)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('INVALID_TRANSITION')
  })

  it('reads and updates shipping settings', async () => {
    expect((await get('/settings/shipping')).body).toEqual({ flatRateCents: 995, freeThresholdCents: 15000, sessionMinutes: 30 })
    const ok = await write('put', '/settings/shipping', { flatRateCents: 1295, freeThresholdCents: 20000 })
    expect(ok.body).toMatchObject({ flatRateCents: 1295, freeThresholdCents: 20000 })
    const bad = await write('put', '/settings/shipping', { flatRateCents: 'free', freeThresholdCents: null })
    expect(bad.status).toBe(400)
    expect(bad.body.fields.flatRateCents).toBeDefined()
  })
})
```

```ts
// tests/variant-physicals.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createProduct } from '../src/admin/product-write.service.js'
import { createVariant, updateVariant } from '../src/admin/variant-write.service.js'
import { parseVariantInput } from '../src/admin/product-input.js'

let actorId: string
beforeEach(async () => {
  await resetDb()
  actorId = (await prisma.actor.create({ data: { type: 'human', name: 't' } })).id
})
afterAll(() => prisma.$disconnect())

describe('variant weight and dimensions', () => {
  it('parses the four optional fields, null clearing', () => {
    expect(parseVariantInput({ weightGrams: 850, lengthMm: null }, 'patch')).toEqual({ weightGrams: 850, lengthMm: null })
    expect(() => parseVariantInput({ widthMm: 0 }, 'patch')).toThrow()
    expect(() => parseVariantInput({ heightMm: 1.5 }, 'patch')).toThrow()
  })

  it('creates and edits them, and the admin DTO returns them', async () => {
    const p = await createProduct({ name: 'Castle', productType: 'resale' }, actorId)
    const created = await createVariant(p.id, { sku: 'C-1', priceCents: 1000, weightGrams: 900, lengthMm: 380, widthMm: 260, heightMm: 70 }, actorId)
    expect(created.variants[0]).toMatchObject({ weightGrams: 900, lengthMm: 380, widthMm: 260, heightMm: 70 })
    const edited = await updateVariant(created.variants[0].id, { weightGrams: 950, heightMm: null }, actorId)
    expect(edited.variants[0]).toMatchObject({ weightGrams: 950, lengthMm: 380, heightMm: null })
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'variant.update' } })
    expect(audit.after).toEqual({ weightGrams: 950, heightMm: null })
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/admin-orders.test.ts tests/variant-physicals.test.ts`
Expected: FAIL — 404 on `/api/v1/admin/orders`; unknown field `weightGrams`.

- [ ] **Step 3: The service**

```ts
// src/admin/admin-orders.service.ts
import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { recordAudit } from '../audit.js'
import { AdminError } from './admin-errors.js'
import { fulfillOrder, cancelOrder, orderNumber, OrderError, PENDING_CHECKOUT_EMAIL } from '../orders/orders.service.js'
import { lineName } from '../checkout/checkout.service.js'
import type { PaymentsPort } from '../ports/payments/payments.port.js'
import { scrubError } from '../auth/scrub.js'

export const ORDER_TABS = ['to_ship', 'shipped', 'pending', 'closed', 'review'] as const
export type OrderTab = (typeof ORDER_TABS)[number]
export const CARRIERS = ['USPS', 'UPS', 'FedEx', 'Other'] as const

/** Storefront only: Walmart orders ship through the Walmart flow (plan decision 3). */
function tabWhere(tab: OrderTab): Prisma.OrderWhereInput {
  const storefront = { channel: 'storefront' as const }
  switch (tab) {
    case 'to_ship': return { ...storefront, status: 'paid' }
    case 'shipped': return { ...storefront, status: 'fulfilled' }
    case 'pending': return { ...storefront, status: 'pending' }
    case 'closed': return { ...storefront, status: { in: ['cancelled', 'refunded'] } }
    case 'review': return { ...storefront, reviewReason: { not: null } }
  }
}

const shownEmail = (email: string) => (email === PENDING_CHECKOUT_EMAIL ? null : email)

export interface AdminOrderRow {
  id: string; orderNumber: string; createdAt: Date; email: string | null; itemCount: number
  totalCents: number; shipToState: string | null; status: string; reviewReason: string | null
}

export async function listAdminOrders(q: { tab?: unknown; page?: number; pageSize?: number }) {
  if (typeof q.tab !== 'string' || !(ORDER_TABS as readonly string[]).includes(q.tab)) {
    throw new AdminError('VALIDATION_ERROR', 'invalid input', { tab: `one of ${ORDER_TABS.join(', ')}` })
  }
  const page = q.page && q.page >= 1 ? q.page : 1
  const pageSize = q.pageSize && q.pageSize >= 1 && q.pageSize <= 100 ? q.pageSize : 25
  const where = tabWhere(q.tab as OrderTab)
  const [total, rows] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where, orderBy: [{ createdAt: 'desc' }, { number: 'desc' }], skip: (page - 1) * pageSize, take: pageSize,
      include: { lines: { select: { quantity: true } } },
    }),
  ])
  const items: AdminOrderRow[] = rows.map((o) => ({
    id: o.id, orderNumber: orderNumber(o.number), createdAt: o.createdAt, email: shownEmail(o.email),
    itemCount: o.lines.reduce((n, l) => n + l.quantity, 0), totalCents: o.totalCents,
    shipToState: o.shipToState || null, status: o.status, reviewReason: o.reviewReason,
  }))
  return { items, total, page, pageSize }
}

export interface AdminOrderDetail {
  id: string; orderNumber: string; channel: string; status: string; reviewReason: string | null
  createdAt: Date; paidAt: Date | null; shippedAt: Date | null
  email: string | null; marketingOptIn: boolean
  shipTo: { name: string | null; line1: string; line2: string | null; city: string | null; state: string; postalCode: string | null } | null
  lines: { variantId: string; sku: string; name: string; quantity: number; unitPriceCents: number; lineSubtotalCents: number }[]
  subtotalCents: number; shippingCents: number; taxCents: number; totalCents: number; refundedCents: number
  taxJurisdiction: string; taxRateBps: number
  carrier: string | null; trackingNumber: string | null
  referral: { code: string; partnerName: string | null; commissionRateBps: number | null; unmatched: boolean } | null
  stripePaymentUrl: string | null
  audit: { action: string; actorName: string; createdAt: Date; after: unknown }[]
}

export async function getAdminOrder(id: string, payments: Pick<PaymentsPort, 'livemode'>): Promise<AdminOrderDetail | null> {
  const o = await prisma.order.findUnique({
    where: { id },
    include: {
      affiliatePartner: { select: { name: true } },
      lines: { include: { variant: { select: { attributes: true, product: { select: { name: true } } } } } },
    },
  })
  if (!o) return null
  const audit = await prisma.auditLog.findMany({
    where: { target: `order:${id}` }, orderBy: { createdAt: 'asc' }, include: { actor: { select: { name: true } } },
  })
  const pi = o.stripePaymentIntentId
  return {
    id: o.id, orderNumber: orderNumber(o.number), channel: o.channel, status: o.status, reviewReason: o.reviewReason,
    createdAt: o.createdAt, paidAt: o.paidAt, shippedAt: o.shippedAt,
    email: shownEmail(o.email), marketingOptIn: o.marketingOptIn,
    shipTo: o.shipLine1
      ? { name: o.shipName, line1: o.shipLine1, line2: o.shipLine2, city: o.shipCity, state: o.shipToState, postalCode: o.shipPostalCode }
      : null,
    lines: o.lines.map((l) => ({
      variantId: l.variantId, sku: l.sku, name: lineName(l.variant.product.name, l.variant.attributes),
      quantity: l.quantity, unitPriceCents: l.unitPriceCents, lineSubtotalCents: l.lineSubtotalCents,
    })),
    subtotalCents: o.subtotalCents, shippingCents: o.shippingCents, taxCents: o.taxCents, totalCents: o.totalCents,
    refundedCents: o.refundedCents, taxJurisdiction: o.taxJurisdiction, taxRateBps: o.taxRateBps,
    carrier: o.carrier, trackingNumber: o.trackingNumber,
    referral: o.referralCode
      ? { code: o.referralCode, partnerName: o.affiliatePartner?.name ?? null, commissionRateBps: o.commissionRateBps, unmatched: o.referralUnmatched }
      : null,
    stripePaymentUrl: pi ? `https://dashboard.stripe.com/${payments.livemode ? '' : 'test/'}payments/${pi}` : null,
    audit: audit.map((a) => ({ action: a.action, actorName: a.actor.name, createdAt: a.createdAt, after: a.after })),
  }
}

function mapOrderError(err: unknown): unknown {
  if (!(err instanceof OrderError)) return err
  if (err.code === 'order_not_found') return new AdminError('NOT_FOUND', 'order not found')
  if (err.code === 'inventory_conflict') return new AdminError('INVENTORY_CONFLICT', 'stock no longer matches this order; check the variant before retrying')
  return new AdminError('INVALID_TRANSITION', err.message)
}

async function requireStorefrontOrder(id: string) {
  const order = await prisma.order.findUnique({
    where: { id }, select: { channel: true, status: true, reviewReason: true, stripeCheckoutSessionId: true },
  })
  if (!order) throw new AdminError('NOT_FOUND', 'order not found')
  if (order.channel !== 'storefront') throw new AdminError('WRONG_CHANNEL', 'Walmart orders are handled through the Walmart flow')
  return order
}

const TRACKING_RE = /^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$/

function parseShipInput(body: unknown): { carrier: (typeof CARRIERS)[number]; trackingNumber: string | null; acknowledgeReview: boolean } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new AdminError('VALIDATION_ERROR', 'body must be a JSON object')
  const b = body as Record<string, unknown>
  const fields: Record<string, string> = {}
  for (const k of Object.keys(b)) if (!['carrier', 'trackingNumber', 'acknowledgeReview'].includes(k)) fields[k] = 'unknown field'
  const carrier = b.carrier
  if (typeof carrier !== 'string' || !(CARRIERS as readonly string[]).includes(carrier)) fields.carrier = 'USPS, UPS, FedEx or Other'
  const tracking = typeof b.trackingNumber === 'string' ? b.trackingNumber.trim() : ''
  if (b.trackingNumber !== undefined && b.trackingNumber !== null && typeof b.trackingNumber !== 'string') fields.trackingNumber = 'text'
  else if (tracking === '' && carrier !== 'Other') fields.trackingNumber = 'required unless the carrier is Other'
  else if (tracking !== '' && !TRACKING_RE.test(tracking)) fields.trackingNumber = 'letters, numbers, spaces and hyphens, at most 64'
  if ('acknowledgeReview' in b && typeof b.acknowledgeReview !== 'boolean') fields.acknowledgeReview = 'true or false'
  if (Object.keys(fields).length > 0) throw new AdminError('VALIDATION_ERROR', 'invalid input', fields)
  return { carrier: carrier as (typeof CARRIERS)[number], trackingNumber: tracking || null, acknowledgeReview: b.acknowledgeReview === true }
}

/** Mark shipped (spec §7): `paid` only -> fulfillOrder, with carrier details in the same transaction. */
export async function shipOrder(id: string, body: unknown, actorId: string, payments: Pick<PaymentsPort, 'livemode'>): Promise<AdminOrderDetail> {
  const input = parseShipInput(body)
  const order = await requireStorefrontOrder(id)
  if (order.reviewReason && !input.acknowledgeReview) {
    throw new AdminError('REVIEW_REQUIRED', `This order is flagged (${order.reviewReason}). Confirm you have reviewed it before shipping.`, undefined, { reviewReason: order.reviewReason })
  }
  try {
    await fulfillOrder(id, actorId, {
      inTransaction: async (tx) => {
        await tx.order.update({ where: { id }, data: { shippedAt: new Date(), carrier: input.carrier, trackingNumber: input.trackingNumber } })
        await recordAudit({
          actorId, action: 'order.ship', target: `order:${id}`,
          after: { carrier: input.carrier, trackingNumber: input.trackingNumber, ...(order.reviewReason ? { acknowledgedReview: order.reviewReason } : {}) },
        }, tx)
      },
    })
  } catch (err) { throw mapOrderError(err) }
  return (await getAdminOrder(id, payments))!
}

/**
 * Cancel (spec §7): `pending` only. Expire the Stripe session FIRST, so the
 * customer cannot pay for stock this is about to release. Paid orders are
 * refunded in Stripe, never cancelled here.
 */
export async function cancelPendingOrder(id: string, actorId: string, payments: PaymentsPort): Promise<AdminOrderDetail> {
  const order = await requireStorefrontOrder(id)
  if (order.status !== 'pending') {
    throw new AdminError('INVALID_TRANSITION', `cannot cancel a ${order.status} order here; refund paid orders in the Stripe dashboard`)
  }
  if (order.stripeCheckoutSessionId) {
    let outcome: 'expired' | 'complete'
    try {
      outcome = await payments.expireCheckoutSession(order.stripeCheckoutSessionId)
    } catch (err) {
      console.error('[admin-orders] could not expire session', id, scrubError(err))
      throw new AdminError('STRIPE_UNAVAILABLE', 'Could not reach Stripe to close this checkout. Try again in a minute.')
    }
    if (outcome === 'complete') {
      throw new AdminError('ORDER_PAID', 'The customer has just paid for this order. Refresh the page; refund it in Stripe if it should not ship.')
    }
  }
  try { await cancelOrder(id, actorId) } catch (err) { throw mapOrderError(err) }
  return (await getAdminOrder(id, payments))!
}
```

- [ ] **Step 4: The router and its mount**

```ts
// src/admin/admin-orders.routes.ts
import { Router, type Response } from 'express'
import { AdminError } from './admin-errors.js'
import { listAdminOrders, getAdminOrder, shipOrder, cancelPendingOrder } from './admin-orders.service.js'
import { getShopSettings, updateShippingSettings } from '../settings/shop-settings.service.js'
import type { PaymentsPort } from '../ports/payments/payments.port.js'
import { scrubError } from '../auth/scrub.js'

const STATUS_BY_CODE: Record<string, number> = {
  NOT_FOUND: 404, VALIDATION_ERROR: 400, INVALID_TRANSITION: 409, INVENTORY_CONFLICT: 409,
  REVIEW_REQUIRED: 409, WRONG_CHANNEL: 409, ORDER_PAID: 409, STRIPE_UNAVAILABLE: 503,
}

function fail(res: Response, err: unknown) {
  if (err instanceof AdminError) {
    return res.status(STATUS_BY_CODE[err.code] ?? 400).json({
      code: err.code, message: err.message,
      ...(err.fields ? { fields: err.fields } : {}), ...(err.details ? { details: err.details } : {}),
    })
  }
  console.error('[admin-orders] unexpected failure', scrubError(err))
  res.status(500).json({ code: 'INTERNAL_ERROR', message: 'internal error' })
}

const int = (v: unknown) => (typeof v === 'string' && Number.isInteger(Number(v)) ? Number(v) : undefined)

/** PRECONDITION: mounted behind requireAuth (req.actor!.id), like adminCatalogRouter. */
export function createAdminOrdersRouter(payments: PaymentsPort): Router {
  const router = Router()

  router.get('/orders', async (req, res) => {
    try {
      res.json(await listAdminOrders({ tab: req.query.tab, page: int(req.query.page), pageSize: int(req.query.pageSize) }))
    } catch (err) { fail(res, err) }
  })

  router.get('/orders/:id', async (req, res) => {
    try {
      const o = await getAdminOrder(req.params.id, payments)
      if (!o) return res.status(404).json({ code: 'NOT_FOUND', message: 'order not found' })
      res.json(o)
    } catch (err) { fail(res, err) }
  })

  router.post('/orders/:id/ship', async (req, res) => {
    try { res.json(await shipOrder(req.params.id, req.body, req.actor!.id, payments)) } catch (err) { fail(res, err) }
  })

  router.post('/orders/:id/cancel', async (req, res) => {
    try { res.json(await cancelPendingOrder(req.params.id, req.actor!.id, payments)) } catch (err) { fail(res, err) }
  })

  router.get('/settings/shipping', async (_req, res) => {
    try { res.json(await getShopSettings()) } catch (err) { fail(res, err) }
  })

  router.put('/settings/shipping', async (req, res) => {
    try { res.json(await updateShippingSettings(req.body, req.actor!.id)) } catch (err) { fail(res, err) }
  })

  return router
}
```

In `src/app.ts`, add `import { createAdminOrdersRouter } from './admin/admin-orders.routes.js'`. Directly after `app.use('/api/v1/admin', adminCatalogRouter)`, add:

```ts
  app.use('/api/v1/admin', createAdminOrdersRouter(payments))
```

- [ ] **Step 5: Variant weight and dimensions**

In `src/admin/product-input.ts`:

```ts
export type VariantData = {
  sku?: string; priceCents?: number; attributes?: Record<string, string>; onHand?: number
  weightGrams?: number | null; lengthMm?: number | null; widthMm?: number | null; heightMm?: number | null
}

/** Optional shipping physicals (spec §3); null clears. Unused until a carrier adapter exists. */
const PHYSICAL_KEYS = ['weightGrams', 'lengthMm', 'widthMm', 'heightMm'] as const
const VARIANT_CREATE_KEYS = ['sku', 'priceCents', 'currency', 'attributes', 'onHand', ...PHYSICAL_KEYS]
const VARIANT_PATCH_KEYS = ['sku', 'priceCents', 'currency', 'attributes', ...PHYSICAL_KEYS]
```

(replacing the two existing `VARIANT_*_KEYS` lines and the `VariantData` type). In `parseVariantInput`, immediately before the final `done(f)`:

```ts
  for (const k of PHYSICAL_KEYS) {
    if (!(k in b)) continue
    const v = b[k]
    if (v === null) { out[k] = null; continue }
    if (!isInt(v) || v < 1 || v > 1_000_000) f[prefix + k] = 'a whole number above 0, or empty'
    else out[k] = v
  }
```

In `src/admin/variant-write.service.ts` `insert()`, add to `tx.variant.create({ data: { … } })`, after `attributes: v.attributes ?? {},`:

```ts
      weightGrams: v.weightGrams ?? null, lengthMm: v.lengthMm ?? null,
      widthMm: v.widthMm ?? null, heightMm: v.heightMm ?? null,
```

`updateVariant` needs no change: its before/after diff already handles any scalar key the parser returns.

In `src/admin/admin-product.dto.ts`, add to `AdminVariantDto`:

```ts
  weightGrams: number | null; lengthMm: number | null; widthMm: number | null; heightMm: number | null
```

and to the object returned in `variants: p.variants.map(...)`, after `currency: v.currency,`:

```ts
        weightGrams: v.weightGrams, lengthMm: v.lengthMm, widthMm: v.widthMm, heightMm: v.heightMm,
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/admin-orders.test.ts tests/variant-physicals.test.ts tests/product-input.test.ts tests/variant-write.test.ts tests/admin-product-dto.test.ts tests/auth-route-coverage.test.ts`
Expected: PASS. If `auth-route-coverage.test.ts` lists admin routes explicitly, add the six new ones as `requireAuth`-covered.

- [ ] **Step 7: Capture console fixtures**

In `tests/capture-admin-fixtures.test.ts`, add these imports:

```ts
import { ensureSystemActor } from './helpers/db.js'
import { placeOrder, markOrderPaidTx, PENDING_CHECKOUT_EMAIL } from '../src/orders/orders.service.js'
import { deferredTaxAdapter } from '../src/ports/tax/deferred.adapter.js'
```

and a second case after `it('captures', …)` (it reuses the product the first case created):

```ts
  it('captures orders and shipping settings', async () => {
    await ensureSystemActor()
    const v = await prisma.variant.findFirstOrThrow({ where: { sku: 'ABE-1001' }, include: { product: true } })
    await prisma.product.update({ where: { id: v.productId }, data: { status: 'published' } })
    await prisma.inventory.update({ where: { variantId: v.id }, data: { onHand: 10, reserved: 0, walmartAllocation: null } })
    const placed = await placeOrder({
      email: PENDING_CHECKOUT_EMAIL, shipToState: '', lines: [{ variantId: v.id, quantity: 1 }],
      marketingOptIn: true, referral: { code: 'club', firstSeenAt: new Date('2026-09-26T12:00:00Z') },
    }, deferredTaxAdapter)
    await prisma.$transaction((tx) => markOrderPaidTx(tx, placed.id, 'system', {
      email: 'buyer@example.com', shipName: 'Ann Buyer', shipLine1: '1 Main St', shipCity: 'Traverse City',
      shipToState: 'MI', shipPostalCode: '49684', shippingCents: 0, taxCents: 1134, totalCents: 20034,
      taxJurisdiction: 'stripe_tax', taxRateBps: 600, stripePaymentIntentId: 'pi_test_fixture',
      paidAt: new Date('2026-09-27T15:00:00Z'), referralUnmatched: true,
    }))
    save('order-queue', (await send('get', '/orders?tab=to_ship')).body)
    save('order-detail', (await send('get', `/orders/${placed.id}`)).body)
    save('shipping-settings', (await send('get', '/settings/shipping')).body)
  })
```

Run: `CAPTURE_ADMIN_FIXTURES=1 npx vitest run tests/capture-admin-fixtures.test.ts`
(PowerShell: `$env:CAPTURE_ADMIN_FIXTURES='1'; npx vitest run tests/capture-admin-fixtures.test.ts; Remove-Item Env:CAPTURE_ADMIN_FIXTURES`)
Expected: PASS. `systems/admin-ui/src/data/__fixtures__/` gains `order-queue.json`, `order-detail.json` and `shipping-settings.json`, and `product-with-stock.json` now has `weightGrams: null` and the other physical fields. Open `order-detail.json` and confirm it has `shipTo`, `referral.unmatched: true`, and `stripePaymentUrl` containing `/test/payments/pi_test_fixture`.

Then run the console suite, since the fixture shapes changed: in `systems/admin-ui`, `npx vitest run`. Expected: PASS (the new fields are additive).

- [ ] **Step 8: Full suite, typecheck, commit**

Run in `systems/core`: `npx vitest run && npm run typecheck`. Expected: all pass.

```bash
git add systems/core/src systems/core/tests systems/admin-ui/src/data/__fixtures__
git commit -m "feat(core): admin order queue, ship and cancel, shipping settings, variant physicals" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 10: Configuration, runbook, core verification and PR

**Files:**
- Modify: `render.yaml`
- Modify: `systems/core/README.md` (new "Checkout and Stripe" section)
- Create: `docs/status/2026-09-27-stripe-test-mode-runbook.md`

**Interfaces:**
- Produces: env keys `STOREFRONT_PUBLIC_URL` (core-env, `sync: false`) and `VITE_STRIPE_PUBLISHABLE_KEY` (storefront, `sync: false`). Jack's runbook for Stripe test mode on staging.

- [ ] **Step 1: `render.yaml`**

Under `services:` → `storefront` → `envVars`, after the `VITE_ASSET_BASE_URL` entry, add:

```yaml
      # Stripe publishable key (pk_test_... on staging, pk_live_... on
      # production). Publishable keys are designed to be public, but they are
      # still per environment, so sync: false -- never hardcode one here.
      - key: VITE_STRIPE_PUBLISHABLE_KEY
        sync: false
```

Under `envVarGroups` → `core-env` → `envVars`, after the `ASSET_S3_REGION` entry, add:

```yaml
      # The storefront's public origin for this environment (e.g.
      # https://staging.alpinebrickexchange.com). The base of Stripe
      # Checkout's return_url. Core refuses to start when STRIPE_SECRET_KEY and
      # STRIPE_WEBHOOK_SECRET are set without it -- and when only one of
      # those two is set. See docs/status/2026-09-27-stripe-test-mode-runbook.md
      - key: STOREFRONT_PUBLIC_URL
        sync: false
```

`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are already listed in the secrets comment. Leave them there and do not declare them.

- [ ] **Step 2: README section**

Append to `systems/core/README.md`:

```markdown
## Checkout and Stripe

Spec: `docs/superpowers/specs/2026-09-27-revenue-loop-checkout-design.md`.

- `POST /api/v1/checkout` (public, storefront CORS, 20/min per IP) reserves
  stock via `placeOrder`, opens a Stripe Embedded Checkout session
  (`ui_mode: 'embedded_page'`), and returns `{ orderId, clientSecret }`.
- `POST /api/v1/webhooks/stripe` is mounted **before** `express.json` with a
  raw-body parser; each event is applied once (`stripe_events`), in one
  transaction with its effects. Handled: `checkout.session.completed`,
  `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`.
- The abandoned-checkout sweep runs every 5 minutes **in the web process**
  (`src/checkout/sweep.ts`), unlike the Walmart scheduler.
- `stripe` is pinned to **22.6.2** (API `2026-08-26.dahlia`). Upgrading the SDK
  changes the API version: update `STRIPE_API_VERSION`, the webhook endpoint's
  version in the Stripe dashboard, and re-verify the field locations noted in
  `src/payments/stripe-events.ts`.

| Var | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Secret, pasted by Jack. Test mode (`sk_test_…`) on staging. |
| `STRIPE_WEBHOOK_SECRET` | Secret (`whsec_…`) of this environment's webhook endpoint. |
| `STOREFRONT_PUBLIC_URL` | Base of Checkout's `return_url`. |

None set: checkout answers 503 and the sweep does not start. One Stripe key
set without the other, or both without `STOREFRONT_PUBLIC_URL`: core
**refuses to start**, naming the missing keys.
```

- [ ] **Step 3: The runbook**

Create `docs/status/2026-09-27-stripe-test-mode-runbook.md`:

```markdown
# Stripe Test Mode on Staging — Runbook

**Date:** 2026-09-27 · **For:** Jack · **Spec:** `docs/superpowers/specs/2026-09-27-revenue-loop-checkout-design.md`

Every step here is a dashboard action on an account Jack owns. Keys are pasted
by Jack into Render; they never go into chat, the repo, or a ticket.

## 0. Open questions this depends on (spec §9)

- **§9.2 Stripe account:** who owns it and under which email. Needs partner sign-off (external account).
- **§9.3 Stripe Tax:** Michigan must be registered in Stripe Tax before launch; partner sign-off on tax obligations.
- **§9.5 Tax code:** the build uses `txcd_99999999` (General – Tangible Goods) until an accountant names another.

## 1. Test-mode keys

1. Stripe Dashboard → toggle **Test mode**.
2. Developers → API keys: copy the **publishable** key (`pk_test_…`) and **secret** key (`sk_test_…`).
3. Render → staging `core-env` group: set `STRIPE_SECRET_KEY` = the `sk_test_…` value.
4. Render → staging `storefront` service: set `VITE_STRIPE_PUBLISHABLE_KEY` = the `pk_test_…` value.
5. Render → staging `core-env`: set `STOREFRONT_PUBLIC_URL` = `https://staging.alpinebrickexchange.com`.
   (Leave `STRIPE_WEBHOOK_SECRET` for step 3 below; core refuses to start with
   only one Stripe key, so **do not redeploy core until step 3 is done**.)

## 2. Stripe Tax (test mode)

1. Dashboard → Tax → set the origin address (the business address) and turn on Stripe Tax.
2. Tax → Registrations → add **Michigan** (test mode). Without a registration
   Stripe computes $0 tax everywhere and the staging "Michigan address with tax" check fails.
3. Leave the default product tax code alone; the code sets it per line.

## 3. Webhook endpoint

1. Workbench → Webhooks → **Add destination** (test mode).
2. URL: `https://api-staging.alpinebrickexchange.com/api/v1/webhooks/stripe`
3. **API version: `2026-08-26.dahlia`**. Event payloads are rendered in the
   endpoint's version, and core reads fields at that version's locations
   (`collected_information.shipping_details`).
4. Events — exactly these four:
   - `checkout.session.completed`
   - `checkout.session.expired`
   - `charge.refunded`
   - `charge.dispute.created`
5. Reveal the **signing secret** (`whsec_…`) → Render staging `core-env`: `STRIPE_WEBHOOK_SECRET`.
6. Redeploy `core-api` (staging). Check the deploy log shows `core listening`
   and no "Stripe is half-configured" error. Redeploy the `storefront`
   (staging) so the publishable key is baked into the build.

## 4. Payment methods and branding

- Settings → Payment methods: **Cards** on; Apple Pay and Google Pay on (they
  ride on card). The session restricts to card, so other methods will not show.
- Settings → Branding: logo and colours (the embedded form uses them).

## 5. A referral partner for the end-to-end check

There is no partner admin screen (spec §11). Seed one partner on **staging
only**, from a Render shell on `core-api` (staging): `npx prisma studio` is not
available there, so use `psql "$DATABASE_URL"`:

    INSERT INTO affiliate_partners (id, name) VALUES ('partner_test_1', 'Test Partner');
    INSERT INTO referral_codes (code, partner_id, commission_rate_bps) VALUES ('test-partner', 'partner_test_1', 1000);

## 6. End-to-end checks (spec §10) — Stripe test cards

Card `4242 4242 4242 4242`, any future expiry, any CVC. Record each result in the PR.

| # | Do | Expect |
|---|---|---|
| 1 | Buy one set, ship to a Michigan address | Stripe shows MI tax; console order **To ship** with tax, shipping $9.95, address, email |
| 2 | Buy ≥ $150 | Shipping "Free shipping", $0 |
| 3 | Start checkout, close the tab, wait 45 min | Order **Closed** (`cancelled`); stock back (via `checkout.session.expired` or the sweep) |
| 4 | Pay, then refund in full in Stripe before shipping | Order `refunded`; stock reservation released |
| 5 | Pay, Mark shipped in console, then refund in Stripe | Order `refunded`; on-hand stays decremented |
| 6 | Pay with dispute card `4000 0000 0000 0259` | Order in **Needs review** (`disputed`) |
| 7 | Visit `/?ref=test-partner`, then buy | Order detail: referral `test-partner`, Test Partner, 10.00% |
| 8 | Visit `/?ref=nobody-here`, then buy | Order detail: referral "unmatched" |
| 9 | Ship to an Alaska address | Paid, **Needs review** "outside_shipping_area"; refund it in Stripe |
| 10 | Workbench → the endpoint → **Resend** a delivered `checkout.session.completed` | 200 `duplicate`; nothing changes |
```

- [ ] **Step 4: Verify the core build and boot**

```bash
cd systems/core
npx vitest run
npm run build
PORT=4099 node dist/server.js &   # PowerShell: Start-Process node -ArgumentList 'dist/server.js' with $env:PORT='4099'
curl -s http://localhost:4099/health
curl -s http://localhost:4099/api/v1/checkout/config
```
Expected: suite all green (record the count); build clean; `{"status":"ok"}`; config `{"flatRateCents":995,"freeShippingThresholdCents":15000}`. If the local config has no Stripe keys, the boot log says `checkout sweep: Stripe is not configured -- not started`. Do not open the config to find out. Stop the server.

Refuse-to-start check. The variables are set for this one child process only; no config file is touched:
`STRIPE_SECRET_KEY=sk_test_unused_placeholder STRIPE_WEBHOOK_SECRET= node dist/server.js`
Expected: exits non-zero with `Stripe is half-configured; missing: STRIPE_WEBHOOK_SECRET` (plus `STOREFRONT_PUBLIC_URL` unless the local config sets it).

- [ ] **Step 5: Commit, then ask before pushing**

```bash
git add render.yaml systems/core/README.md docs/status/2026-09-27-stripe-test-mode-runbook.md
git commit -m "docs(core): Stripe env keys, checkout README and the staging test-mode runbook" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Ask Jack for the OK to push. Then:

```bash
git push -u origin feat/revenue-loop-core
gh pr create --title "feat(core): revenue loop — checkout, Stripe webhook, admin orders" --body "$(cat <<'BODY'
Implements PR 1 (Tasks 0–10) of docs/superpowers/plans/2026-09-27-revenue-loop-checkout.md.

- Checkout endpoint, status and config; public order routes retired
- Stripe webhook (four events, de-duplication, order row locks) and the abandoned-checkout sweep
- Admin orders and shipping-settings API; variant weight and dimensions
- render.yaml keys and the Stripe test-mode runbook

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
gh pr checks --watch
```
Expected: CI green (core, storefront, admin-ui jobs). Record the PR number.

---

# PR 2 — Storefront (`feat/revenue-loop-storefront`)

Cut from `main` after PR 1 merges: `git checkout main && git pull --ff-only && git checkout -b feat/revenue-loop-storefront`. Every command below runs in `systems/storefront/code`. Baseline first: `npx vitest run` (record the count).

## Task 11: Referral capture, persistent cart, and the previous-order handle

**Files:**
- Create: `systems/storefront/code/src/lib/referral.ts`
- Create: `systems/storefront/code/src/lib/checkout/previousOrder.ts`
- Modify: `systems/storefront/code/src/lib/cart/CartContext.tsx`
- Modify: `systems/storefront/code/src/test/setup.ts`
- Modify: `systems/storefront/code/src/app/Root.tsx` (call the hook)
- Test: `systems/storefront/code/src/lib/referral.test.tsx`, `systems/storefront/code/src/lib/cart/CartContext.test.tsx`

**Interfaces:**
- Produces:
  - `REFERRAL_STORAGE_KEY = 'ab.referral'`, `REFERRAL_TTL_MS`, `REFERRAL_CODE_RE = /^[a-z0-9-]{2,32}$/`
  - `interface Referral { code: string; firstSeenAt: string }` (the checkout request's `referral` shape)
  - `safeLocalStorage(): Storage | null`
  - `captureReferral(search: string, storage: Storage | null, now?: Date): boolean`. Returns true when `ref` was present.
  - `readReferral(storage: Storage | null, now?: Date): Referral | null`
  - `useReferralCapture(): void`
  - `PREVIOUS_ORDER_KEY = 'ab.previousOrderId'`, `getPreviousOrderId(): string | null`, `setPreviousOrderId(id: string): void`, `clearPreviousOrderId(): void`
  - Cart: `MAX_QUANTITY = 10`, `CART_STORAGE_KEY = 'ab.cart.v1'`. `useCart()` gains `clear(): void`. `addItem`, `setQuantity`, `removeItem` and `clear` are referentially stable.

- [ ] **Step 1: Isolate storage between tests**

Append to `src/test/setup.ts`:

```ts
import { beforeEach } from 'vitest'

// The cart, referral and previous-order handle now live in browser storage.
// Clear it before every test so no test sees another's cart.
beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
})
```

- [ ] **Step 2: Write the failing tests**

```tsx
// src/lib/referral.test.tsx
import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router'
import {
  captureReferral, readReferral, useReferralCapture, REFERRAL_STORAGE_KEY, REFERRAL_TTL_MS,
} from './referral'

function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() { return m.size },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k) },
    setItem: (k, v) => { m.set(k, String(v)) },
  }
}
const NOW = new Date('2026-10-01T12:00:00Z')

describe('referral capture', () => {
  it('stores a valid code, lowercased, with first-seen time', () => {
    const s = memoryStorage()
    expect(captureReferral('?ref=Brick-Club', s, NOW)).toBe(true)
    expect(readReferral(s, NOW)).toEqual({ code: 'brick-club', firstSeenAt: NOW.toISOString() })
  })

  it('reports ref present but stores nothing for an invalid code', () => {
    const s = memoryStorage()
    expect(captureReferral('?ref=not%20valid!', s, NOW)).toBe(true)
    expect(s.getItem(REFERRAL_STORAGE_KEY)).toBeNull()
    expect(captureReferral('?q=castle', s, NOW)).toBe(false)
  })

  it('last click wins', () => {
    const s = memoryStorage()
    captureReferral('?ref=first', s, NOW)
    const later = new Date(NOW.getTime() + 60_000)
    captureReferral('?ref=second', s, later)
    expect(readReferral(s, later)).toEqual({ code: 'second', firstSeenAt: later.toISOString() })
  })

  it('expires after 30 days', () => {
    const s = memoryStorage()
    captureReferral('?ref=club', s, NOW)
    expect(readReferral(s, new Date(NOW.getTime() + REFERRAL_TTL_MS - 1))).not.toBeNull()
    expect(readReferral(s, new Date(NOW.getTime() + REFERRAL_TTL_MS))).toBeNull()
    expect(s.getItem(REFERRAL_STORAGE_KEY)).toBeNull()
  })

  it('swallows storage failures and corrupt values', () => {
    const throwing = { ...memoryStorage(), setItem: () => { throw new Error('QuotaExceeded') }, getItem: () => { throw new Error('denied') } } as Storage
    expect(captureReferral('?ref=club', throwing, NOW)).toBe(true)
    expect(readReferral(throwing, NOW)).toBeNull()
    expect(captureReferral('?ref=club', null, NOW)).toBe(true)
    const corrupt = memoryStorage()
    corrupt.setItem(REFERRAL_STORAGE_KEY, '{not json')
    expect(readReferral(corrupt, NOW)).toBeNull()
  })
})

describe('useReferralCapture', () => {
  function Probe() {
    useReferralCapture()
    const l = useLocation()
    return <p data-testid="loc">{l.pathname + l.search}</p>
  }

  it('stores the code and strips ref from the URL, keeping other params', async () => {
    const router = createMemoryRouter([{ path: '*', element: <Probe /> }], {
      initialEntries: ['/collections?ref=Brick-Club&sort=new'],
    })
    render(<RouterProvider router={router} />)
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/collections?sort=new'))
    expect(readReferral(window.localStorage)?.code).toBe('brick-club')
  })
})
```

Add to `src/lib/cart/CartContext.test.tsx` (inside the existing `describe('cart', …)`):

```tsx
  it('caps a line at 10', () => {
    const { result } = renderHook(() => useCart(), { wrapper })
    act(() => result.current.addItem(LINE_A, 8))
    act(() => result.current.addItem(LINE_A, 5))
    expect(result.current.items[0].quantity).toBe(10)
    act(() => result.current.setQuantity('v1', 25))
    expect(result.current.items[0].quantity).toBe(10)
  })

  it('persists across a reload and clears', () => {
    const first = renderHook(() => useCart(), { wrapper })
    act(() => first.result.current.addItem(LINE_A, 2))
    first.unmount()
    const second = renderHook(() => useCart(), { wrapper })
    expect(second.result.current.items).toEqual([{ ...LINE_A, quantity: 2 }])
    act(() => second.result.current.clear())
    expect(second.result.current.count).toBe(0)
    expect(JSON.parse(window.localStorage.getItem('ab.cart.v1')!)).toEqual([])
  })

  it('ignores a corrupt stored cart', () => {
    window.localStorage.setItem('ab.cart.v1', '{"nope":1}')
    const { result } = renderHook(() => useCart(), { wrapper })
    expect(result.current.items).toEqual([])
  })

  it('keeps its actions stable across renders', () => {
    const { result } = renderHook(() => useCart(), { wrapper })
    const clear = result.current.clear
    act(() => result.current.addItem(LINE_A))
    expect(result.current.clear).toBe(clear)
  })
```

- [ ] **Step 3: Run to see them fail**

Run: `npx vitest run src/lib/referral.test.tsx src/lib/cart/CartContext.test.tsx`
Expected: FAIL — `./referral` not found; `clear` undefined; the quantity is 13.

- [ ] **Step 4: Implement**

```ts
// src/lib/referral.ts
import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router'

export const REFERRAL_STORAGE_KEY = 'ab.referral'
export const REFERRAL_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Same pattern core enforces (spec §3); core re-validates everything. */
export const REFERRAL_CODE_RE = /^[a-z0-9-]{2,32}$/

export interface Referral { code: string; firstSeenAt: string }
interface StoredReferral extends Referral { expiresAt: string }

export function safeLocalStorage(): Storage | null {
  try { return window.localStorage } catch { return null }
}

/**
 * Spec §6: `?ref=` on any page. A valid code overwrites any earlier one
 * (last click wins) with a 30-day expiry. Storage failures are swallowed.
 * Returns true whenever `ref` was present, valid or not, so the caller
 * strips it from the URL either way.
 */
export function captureReferral(search: string, storage: Storage | null, now = new Date()): boolean {
  const params = new URLSearchParams(search)
  if (!params.has('ref')) return false
  const code = (params.get('ref') ?? '').trim().toLowerCase()
  if (storage && REFERRAL_CODE_RE.test(code)) {
    const value: StoredReferral = {
      code, firstSeenAt: now.toISOString(), expiresAt: new Date(now.getTime() + REFERRAL_TTL_MS).toISOString(),
    }
    try { storage.setItem(REFERRAL_STORAGE_KEY, JSON.stringify(value)) } catch { /* blocked or full */ }
  }
  return true
}

export function readReferral(storage: Storage | null, now = new Date()): Referral | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(REFERRAL_STORAGE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<StoredReferral>
    if (typeof v.code !== 'string' || !REFERRAL_CODE_RE.test(v.code)
      || typeof v.firstSeenAt !== 'string' || typeof v.expiresAt !== 'string') return null
    if (Date.parse(v.expiresAt) <= now.getTime()) {
      storage.removeItem(REFERRAL_STORAGE_KEY)
      return null
    }
    return { code: v.code, firstSeenAt: v.firstSeenAt }
  } catch {
    return null
  }
}

/** Mounted once in Root: capture `?ref=`, then replace the URL without it. */
export function useReferralCapture(): void {
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    if (!captureReferral(location.search, safeLocalStorage())) return
    const params = new URLSearchParams(location.search)
    params.delete('ref')
    const qs = params.toString()
    navigate({ pathname: location.pathname, search: qs ? `?${qs}` : '', hash: location.hash }, { replace: true })
  }, [location.pathname, location.search, location.hash, navigate])
}
```

```ts
// src/lib/checkout/previousOrder.ts
/**
 * The pending order from the last checkout attempt in this tab (spec §6).
 * Sent as previousOrderId so core releases its stock before reserving again.
 * sessionStorage: a new tab is a new attempt.
 */
export const PREVIOUS_ORDER_KEY = 'ab.previousOrderId'

function store(): Storage | null {
  try { return window.sessionStorage } catch { return null }
}

export function getPreviousOrderId(): string | null {
  try { return store()?.getItem(PREVIOUS_ORDER_KEY) ?? null } catch { return null }
}

export function setPreviousOrderId(id: string): void {
  try { store()?.setItem(PREVIOUS_ORDER_KEY, id) } catch { /* ignore */ }
}

export function clearPreviousOrderId(): void {
  try { store()?.removeItem(PREVIOUS_ORDER_KEY) } catch { /* ignore */ }
}
```

Replace `src/lib/cart/CartContext.tsx` with:

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export interface CartLine {
  variantId: string
  productId: string
  productSlug: string
  name: string
  priceCents: number
  /** Storage key of the product's primary image, NOT a URL. Resolve at render. */
  imageKey: string
  quantity: number
}

interface CartValue {
  items: CartLine[]
  count: number
  subtotalCents: number
  addItem: (line: Omit<CartLine, 'quantity'>, qty?: number) => void
  setQuantity: (variantId: string, qty: number) => void
  removeItem: (variantId: string) => void
  clear: () => void
}

/** Spec §4: core accepts 1–10 per line. */
export const MAX_QUANTITY = 10
export const CART_STORAGE_KEY = 'ab.cart.v1'

const CartContext = createContext<CartValue | null>(null)

const cap = (q: number) => Math.min(MAX_QUANTITY, q)

function isCartLine(x: unknown): x is CartLine {
  const l = x as Record<string, unknown>
  return typeof l === 'object' && l !== null
    && typeof l.variantId === 'string' && typeof l.productId === 'string' && typeof l.productSlug === 'string'
    && typeof l.name === 'string' && typeof l.imageKey === 'string'
    && Number.isInteger(l.priceCents) && Number.isInteger(l.quantity) && (l.quantity as number) > 0
}

function loadCart(): CartLine[] {
  try {
    const raw = window.localStorage.getItem(CART_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(isCartLine).map((l) => ({ ...l, quantity: cap(l.quantity) })) : []
  } catch {
    return []
  }
}

/**
 * Line identity is the VARIANT, not the product.
 *
 * The design handoff's reference implementation keyed on product id, which
 * would collapse two variants of one product into a single line at whichever
 * price was added first — and core's checkout takes variantId, so such a line
 * could not be ordered at all.
 *
 * Persisted to localStorage: Stripe's return_url is a full page load, so an
 * in-memory cart would already be gone when the confirmation page clears it.
 * Prices here are display-only; core snapshots live prices at checkout.
 */
export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartLine[]>(loadCart)

  useEffect(() => {
    try { window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(items)) } catch { /* blocked or full */ }
  }, [items])

  const addItem = useCallback((line: Omit<CartLine, 'quantity'>, qty = 1) => {
    setItems((prev) => {
      const found = prev.find((i) => i.variantId === line.variantId)
      if (found) {
        return prev.map((i) => (i.variantId === line.variantId ? { ...i, quantity: cap(i.quantity + qty) } : i))
      }
      return [...prev, { ...line, quantity: cap(qty) }]
    })
  }, [])

  const setQuantity = useCallback((variantId: string, qty: number) => {
    setItems((prev) =>
      qty <= 0
        ? prev.filter((i) => i.variantId !== variantId)
        : prev.map((i) => (i.variantId === variantId ? { ...i, quantity: cap(qty) } : i)),
    )
  }, [])

  const removeItem = useCallback((variantId: string) => {
    setItems((prev) => prev.filter((i) => i.variantId !== variantId))
  }, [])

  const clear = useCallback(() => setItems([]), [])

  const value = useMemo<CartValue>(
    () => ({
      items,
      count: items.reduce((n, i) => n + i.quantity, 0),
      subtotalCents: items.reduce((n, i) => n + i.priceCents * i.quantity, 0),
      addItem, setQuantity, removeItem, clear,
    }),
    [items, addItem, setQuantity, removeItem, clear],
  )

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart(): CartValue {
  const ctx = useContext(CartContext)
  if (!ctx) throw new Error('useCart must be used inside a CartProvider')
  return ctx
}
```

In `src/app/Root.tsx`, add `import { useReferralCapture } from '../lib/referral'` and make `useReferralCapture()` the first line of `export default function Root()`.

- [ ] **Step 5: Run, full suite, commit**

Run: `npx vitest run`. Expected: PASS.

```bash
git add systems/storefront/code/src
git commit -m "feat(storefront): referral capture, persistent capped cart, previous-order handle" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 12: Checkout API client, cart drawer and cart page

**Files:**
- Create: `systems/storefront/code/src/lib/api/checkout.ts`
- Create: `systems/storefront/code/src/components/cart/CartPanel.tsx`
- Create: `systems/storefront/code/src/components/cart/CartDrawer.tsx`
- Create: `systems/storefront/code/src/pages/Cart.tsx`
- Create: `systems/storefront/code/src/pages/legal/Terms.tsx`, `systems/storefront/code/src/pages/legal/Privacy.tsx`
- Modify: `systems/storefront/code/src/app/Root.tsx`, `systems/storefront/code/src/app/Root.test.tsx`, `systems/storefront/code/src/routes.tsx`
- Test: `systems/storefront/code/src/lib/api/checkout.test.ts`, `systems/storefront/code/src/components/cart/CartPanel.test.tsx`

**Interfaces:**
- Consumes: `useCart`, `MAX_QUANTITY` (Task 11); `readReferral`, `safeLocalStorage` (Task 11); `getPreviousOrderId`, `setPreviousOrderId` (Task 11); core's `POST /api/v1/checkout`, `GET /api/v1/checkout/status`, `GET /api/v1/checkout/config` (Task 6).
- Produces:
  - `type CheckoutErrorCode = 'insufficient_stock' | 'variant_not_found' | 'invalid_request' | 'rate_limited' | 'checkout_unavailable'`
  - `interface LineProblem { variantId: string; code: 'insufficient_stock' | 'variant_not_found'; available?: number }`
  - `class CheckoutError extends Error { code: CheckoutErrorCode; lines: LineProblem[] }`, `UNAVAILABLE_MESSAGE`
  - `startCheckout(req: StartCheckoutRequest): Promise<{ orderId: string; clientSecret: string }>`
  - `interface CheckoutStatus { status: 'pending' | 'paid' | 'cancelled'; orderNumber: string; lines: { name: string; sku: string; quantity: number; unitPriceCents: number; lineSubtotalCents: number }[]; totals: { subtotalCents: number; shippingCents: number; taxCents: number; totalCents: number } }`
  - `getCheckoutStatus(sessionId: string): Promise<CheckoutStatus>`
  - `getCheckoutConfig(): Promise<{ flatRateCents: number; freeShippingThresholdCents: number | null }>`
  - `CartPanel({ onNavigate?: () => void })`. On success it navigates to `/checkout` with `state: { clientSecret, orderId }`.
  - `CONTIGUOUS_NOTICE`, `OPT_IN_LABEL`
  - Routes `/cart`, `/legal/terms`, `/legal/privacy`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/api/checkout.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { startCheckout, getCheckoutStatus, CheckoutError, UNAVAILABLE_MESSAGE } from './checkout'

function stubFetch(status: number, body: unknown) {
  const spy = vi.fn(async () => ({ ok: status < 400, status, json: async () => body }))
  vi.stubGlobal('fetch', spy)
  return spy
}
afterEach(() => vi.unstubAllGlobals())

const REQ = { lines: [{ variantId: 'v1', quantity: 2 }], marketingOptIn: false, referral: null }

describe('checkout client', () => {
  it('POSTs JSON without credentials and returns the secret', async () => {
    const spy = stubFetch(201, { orderId: 'o1', clientSecret: 'cs_1_secret' })
    expect(await startCheckout(REQ)).toEqual({ orderId: 'o1', clientSecret: 'cs_1_secret' })
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url.endsWith('/api/v1/checkout')).toBe(true)
    expect(init.method).toBe('POST')
    expect(init.credentials).toBeUndefined()
    expect(JSON.parse(init.body as string)).toEqual(REQ)
  })

  it('maps stock errors with their lines', async () => {
    stubFetch(409, { code: 'insufficient_stock', message: 'm', details: { lines: [{ variantId: 'v1', code: 'insufficient_stock', available: 1 }] } })
    const err = await startCheckout(REQ).catch((e) => e)
    expect(err).toBeInstanceOf(CheckoutError)
    expect(err.code).toBe('insufficient_stock')
    expect(err.lines).toEqual([{ variantId: 'v1', code: 'insufficient_stock', available: 1 }])
  })

  it('turns unknown codes, bad bodies and network failures into checkout_unavailable', async () => {
    stubFetch(500, { code: 'INTERNAL_ERROR' })
    expect(await startCheckout(REQ).catch((e) => e)).toMatchObject({ code: 'checkout_unavailable', message: UNAVAILABLE_MESSAGE })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
    expect(await startCheckout(REQ).catch((e) => e)).toMatchObject({ code: 'checkout_unavailable' })
  })

  it('explains the rate limit', async () => {
    stubFetch(429, { code: 'rate_limited', message: 'x' })
    expect((await startCheckout(REQ).catch((e) => e)).message).toMatch(/wait a minute/)
  })

  it('reads the status for a session id, encoded', async () => {
    const spy = stubFetch(200, { status: 'paid' })
    await getCheckoutStatus('cs_test_a b')
    expect(String(spy.mock.calls[0][0])).toContain('/api/v1/checkout/status?session_id=cs_test_a%20b')
  })
})
```

```tsx
// src/components/cart/CartPanel.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router'
import { CartProvider, CART_STORAGE_KEY } from '../../lib/cart/CartContext'

vi.mock('../../lib/api/checkout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/checkout')>()
  return { ...actual, startCheckout: vi.fn(), getCheckoutConfig: vi.fn() }
})
import { startCheckout, getCheckoutConfig, CheckoutError } from '../../lib/api/checkout'
import CartPanel from './CartPanel'

afterEach(() => vi.clearAllMocks())

const LINE = (variantId: string, name: string, priceCents: number, quantity: number) => ({
  variantId, productId: `p-${variantId}`, productSlug: name.toLowerCase().replace(/ /g, '-'), name, priceCents, imageKey: '', quantity,
})

function StateProbe() {
  const state = useLocation().state as { clientSecret: string; orderId: string }
  return <p>checkout page {state.clientSecret} {state.orderId}</p>
}

function renderCart(lines: ReturnType<typeof LINE>[], threshold: number | null = 15000) {
  window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(lines))
  vi.mocked(getCheckoutConfig).mockResolvedValue({ flatRateCents: 995, freeShippingThresholdCents: threshold })
  const router = createMemoryRouter([
    { path: '/cart', element: <CartProvider><CartPanel /></CartProvider> },
    { path: '/checkout', element: <StateProbe /> },
  ], { initialEntries: ['/cart'] })
  return render(<RouterProvider router={router} />)
}

describe('CartPanel', () => {
  it('shows the subtotal and the checkout notes', async () => {
    renderCart([LINE('v1', 'Dragon Fortress', 4999, 2)])
    expect(screen.getByText('$99.98')).toBeInTheDocument()
    expect(screen.getByText('Shipping and tax calculated at checkout')).toBeInTheDocument()
    expect(screen.getByText('We ship to the contiguous US only.')).toBeInTheDocument()
    expect(await screen.findByText('Free shipping on orders over $150')).toBeInTheDocument()
  })

  it('drops the free-shipping note at or over the threshold', async () => {
    renderCart([LINE('v1', 'Skyline', 18900, 1)])
    await screen.findByText('Shipping and tax calculated at checkout')
    expect(screen.queryByText(/Free shipping on orders over/)).not.toBeInTheDocument()
  })

  it('has the opt-in unticked, caps quantity at 10 and removes lines', async () => {
    renderCart([LINE('v1', 'Dragon Fortress', 100, 9)])
    expect(screen.getByRole('checkbox', { name: 'Email me about new sets and restocks' })).not.toBeChecked()
    const inc = screen.getByRole('button', { name: 'Increase quantity of Dragon Fortress' })
    await userEvent.click(inc)
    expect(screen.getByLabelText('Quantity of Dragon Fortress')).toHaveTextContent('10')
    expect(inc).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Remove Dragon Fortress' }))
    expect(screen.getByText(/Your cart is empty/)).toBeInTheDocument()
  })

  it('starts checkout with lines, opt-in, referral and the previous order, then opens /checkout', async () => {
    window.localStorage.setItem('ab.referral', JSON.stringify({ code: 'club', firstSeenAt: '2026-10-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' }))
    window.sessionStorage.setItem('ab.previousOrderId', 'old-order')
    vi.mocked(startCheckout).mockResolvedValue({ orderId: 'new-order', clientSecret: 'cs_secret_1' })
    renderCart([LINE('v1', 'Dragon Fortress', 4999, 2)])
    await userEvent.click(screen.getByRole('checkbox', { name: 'Email me about new sets and restocks' }))
    await userEvent.click(screen.getByRole('button', { name: 'Checkout' }))
    expect(startCheckout).toHaveBeenCalledWith({
      lines: [{ variantId: 'v1', quantity: 2 }], marketingOptIn: true,
      referral: { code: 'club', firstSeenAt: '2026-10-01T00:00:00.000Z' }, previousOrderId: 'old-order',
    })
    expect(await screen.findByText('checkout page cs_secret_1 new-order')).toBeInTheDocument()
    expect(window.sessionStorage.getItem('ab.previousOrderId')).toBe('new-order')
  })

  it('marks short and missing lines and keeps the rest', async () => {
    vi.mocked(startCheckout).mockRejectedValue(new CheckoutError('insufficient_stock', 'x', [
      { variantId: 'v1', code: 'insufficient_stock', available: 2 },
      { variantId: 'v2', code: 'variant_not_found' },
    ]))
    renderCart([LINE('v1', 'Dragon Fortress', 100, 3), LINE('v2', 'Old Set', 100, 1), LINE('v3', 'Skyline', 100, 1)])
    await userEvent.click(screen.getByRole('button', { name: 'Checkout' }))
    const items = within(screen.getByRole('list', { name: 'Cart items' })).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(within(items[0]).getByText('Only 2 left')).toBeInTheDocument()
    expect(within(items[1]).getByText('No longer available')).toBeInTheDocument()
    expect(within(items[2]).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the spec message when checkout is unavailable', async () => {
    vi.mocked(startCheckout).mockRejectedValue(new CheckoutError('checkout_unavailable', 'Checkout is temporarily unavailable — please try again in a minute.'))
    renderCart([LINE('v1', 'Dragon Fortress', 100, 1)])
    await userEvent.click(screen.getByRole('button', { name: 'Checkout' }))
    expect(await screen.findByText('Checkout is temporarily unavailable — please try again in a minute.')).toBeInTheDocument()
  })
})
```

In `src/app/Root.test.tsx`, replace the test `labels the cart control for screen readers and reports it empty` with:

```tsx
  it('labels the cart button for screen readers and opens the cart drawer', async () => {
    renderShell()
    await userEvent.click(screen.getByRole('button', { name: /cart, empty/i }))
    expect(screen.getByRole('dialog', { name: 'Cart' })).toBeInTheDocument()
    expect(screen.getByText(/Your cart is empty/)).toBeInTheDocument()
  })

  it('links the legal and policy pages from the footer', () => {
    renderShell()
    const footer = screen.getByRole('contentinfo')
    expect(within(footer).getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/legal/terms')
    expect(within(footer).getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/legal/privacy')
    expect(within(footer).getByRole('link', { name: 'Refunds' })).toHaveAttribute('href', '/support/returns')
    expect(within(footer).getByRole('link', { name: 'Shipping' })).toHaveAttribute('href', '/support/shipping')
  })
```

and add `within` to its `@testing-library/react` import and `import userEvent from '@testing-library/user-event'`. The drawer's config fetch fails harmlessly under jsdom because `getCheckoutConfig` is caught.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run src/lib/api/checkout.test.ts src/components/cart/CartPanel.test.tsx src/app/Root.test.tsx`
Expected: FAIL, modules not found; no cart button.

- [ ] **Step 3: The API client**

```ts
// src/lib/api/checkout.ts
import { API_BASE_URL } from '../apiBase'

const BASE = `${API_BASE_URL}/api/v1/checkout`

export type CheckoutErrorCode =
  | 'insufficient_stock' | 'variant_not_found' | 'invalid_request' | 'rate_limited' | 'checkout_unavailable'

export interface LineProblem {
  variantId: string
  code: 'insufficient_stock' | 'variant_not_found'
  available?: number
}

/** Spec §6, verbatim. */
export const UNAVAILABLE_MESSAGE = 'Checkout is temporarily unavailable — please try again in a minute.'
const RATE_LIMIT_MESSAGE = 'Too many checkout attempts. Please wait a minute and try again.'
const KNOWN: ReadonlySet<string> = new Set(['insufficient_stock', 'variant_not_found', 'invalid_request', 'rate_limited', 'checkout_unavailable'])

export class CheckoutError extends Error {
  readonly code: CheckoutErrorCode
  readonly lines: LineProblem[]
  constructor(code: CheckoutErrorCode, message: string, lines: LineProblem[] = []) {
    super(message)
    this.name = 'CheckoutError'
    this.code = code
    this.lines = lines
  }
}

export interface StartCheckoutRequest {
  lines: { variantId: string; quantity: number }[]
  marketingOptIn: boolean
  referral: { code: string; firstSeenAt: string } | null
  previousOrderId?: string
}

export interface CheckoutStatus {
  status: 'pending' | 'paid' | 'cancelled'
  orderNumber: string
  lines: { name: string; sku: string; quantity: number; unitPriceCents: number; lineSubtotalCents: number }[]
  totals: { subtotalCents: number; shippingCents: number; taxCents: number; totalCents: number }
}

export interface CheckoutConfig {
  flatRateCents: number
  freeShippingThresholdCents: number | null
}

function isLineProblem(x: unknown): x is LineProblem {
  const l = x as Record<string, unknown>
  return typeof l === 'object' && l !== null && typeof l.variantId === 'string'
    && (l.code === 'insufficient_stock' || l.code === 'variant_not_found')
}

async function toError(res: Response): Promise<CheckoutError> {
  let body: Record<string, unknown> | null = null
  try { body = (await res.json()) as Record<string, unknown> } catch { /* not JSON */ }
  const code = (typeof body?.code === 'string' && KNOWN.has(body.code) ? body.code : 'checkout_unavailable') as CheckoutErrorCode
  const details = body?.details as { lines?: unknown } | undefined
  const lines = Array.isArray(details?.lines) ? details.lines.filter(isLineProblem) : []
  const message = code === 'checkout_unavailable' ? UNAVAILABLE_MESSAGE
    : code === 'rate_limited' ? RATE_LIMIT_MESSAGE
      : typeof body?.message === 'string' ? body.message : UNAVAILABLE_MESSAGE
  return new CheckoutError(code, message, lines)
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    throw new CheckoutError('checkout_unavailable', UNAVAILABLE_MESSAGE)
  }
  if (!res.ok) throw await toError(res)
  try {
    return (await res.json()) as T
  } catch {
    throw new CheckoutError('checkout_unavailable', UNAVAILABLE_MESSAGE)
  }
}

/** No cookies: checkout is public and core's CORS has credentials off. */
export function startCheckout(req: StartCheckoutRequest): Promise<{ orderId: string; clientSecret: string }> {
  return request(BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) })
}

export function getCheckoutStatus(sessionId: string): Promise<CheckoutStatus> {
  return request(`${BASE}/status?session_id=${encodeURIComponent(sessionId)}`)
}

export function getCheckoutConfig(): Promise<CheckoutConfig> {
  return request(`${BASE}/config`)
}
```

- [ ] **Step 4: The cart UI**

```tsx
// src/components/cart/CartPanel.tsx
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Minus, Plus, X } from 'lucide-react'
import { useCart, MAX_QUANTITY } from '../../lib/cart/CartContext'
import { formatCents } from '../../lib/money'
import { imageUrl } from '../../lib/images'
import {
  startCheckout, getCheckoutConfig, CheckoutError, UNAVAILABLE_MESSAGE, type LineProblem,
} from '../../lib/api/checkout'
import { readReferral, safeLocalStorage } from '../../lib/referral'
import { getPreviousOrderId, setPreviousOrderId } from '../../lib/checkout/previousOrder'
import { Button } from '../../design-system/primitives'

export const CONTIGUOUS_NOTICE = 'We ship to the contiguous US only.'
export const OPT_IN_LABEL = 'Email me about new sets and restocks'

/** "$150" for whole dollars, "$149.50" otherwise -- the spec's copy says "$150". */
function dollars(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : formatCents(cents)
}

function problemText(p: LineProblem): string {
  if (p.code === 'variant_not_found') return 'No longer available'
  return p.available && p.available > 0 ? `Only ${p.available} left` : 'Out of stock'
}

/** Shared by the drawer and /cart (spec §6). */
export default function CartPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { items, subtotalCents, setQuantity, removeItem } = useCart()
  const navigate = useNavigate()
  const [optIn, setOptIn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [problems, setProblems] = useState<Record<string, LineProblem>>({})
  const [threshold, setThreshold] = useState<number | null>(null)

  useEffect(() => {
    let live = true
    getCheckoutConfig()
      .then((c) => { if (live) setThreshold(c.freeShippingThresholdCents) })
      .catch(() => { /* no note rather than a wrong one */ })
    return () => { live = false }
  }, [])

  function forget(variantId: string) {
    setProblems((p) => {
      const next = { ...p }
      delete next[variantId]
      return next
    })
  }

  async function checkout() {
    if (busy) return
    setBusy(true)
    setError(null)
    setProblems({})
    try {
      const previousOrderId = getPreviousOrderId()
      const { orderId, clientSecret } = await startCheckout({
        lines: items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
        marketingOptIn: optIn,
        referral: readReferral(safeLocalStorage()),
        ...(previousOrderId ? { previousOrderId } : {}),
      })
      setPreviousOrderId(orderId)
      onNavigate?.()
      navigate('/checkout', { state: { clientSecret, orderId } })
    } catch (err) {
      if (err instanceof CheckoutError && err.lines.length > 0) {
        setProblems(Object.fromEntries(err.lines.map((l) => [l.variantId, l])))
        setError('Some items in your cart need attention.')
      } else {
        setError(err instanceof CheckoutError ? err.message : UNAVAILABLE_MESSAGE)
      }
    } finally {
      setBusy(false)
    }
  }

  if (items.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        <p>Your cart is empty.</p>
        <Link to="/collections" onClick={onNavigate} className="mt-4 inline-block underline">Browse the collections</Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <ul aria-label="Cart items" className="divide-y divide-border">
        {items.map((i) => {
          const problem = problems[i.variantId]
          return (
            <li key={i.variantId} className="py-4 flex gap-4">
              {i.imageKey && (
                <img src={imageUrl(i.imageKey, { width: 160 })} alt="" width={64} height={64} className="w-16 h-16 object-cover rounded-md" />
              )}
              <div className="flex-1 min-w-0">
                <Link to={`/product/${i.productSlug}`} onClick={onNavigate} className="font-semibold text-sm">{i.name}</Link>
                <p className="text-xs text-muted-foreground">{formatCents(i.priceCents)}</p>
                <div className="mt-2 flex items-center gap-2">
                  <button type="button" aria-label={`Decrease quantity of ${i.name}`}
                    onClick={() => { setQuantity(i.variantId, i.quantity - 1); forget(i.variantId) }}
                    className="p-1.5 border border-border rounded-md"><Minus size={14} aria-hidden /></button>
                  <span aria-label={`Quantity of ${i.name}`} className="w-6 text-center text-sm">{i.quantity}</span>
                  <button type="button" aria-label={`Increase quantity of ${i.name}`} disabled={i.quantity >= MAX_QUANTITY}
                    onClick={() => { setQuantity(i.variantId, i.quantity + 1); forget(i.variantId) }}
                    className="p-1.5 border border-border rounded-md disabled:opacity-40"><Plus size={14} aria-hidden /></button>
                  <button type="button" aria-label={`Remove ${i.name}`} onClick={() => { removeItem(i.variantId); forget(i.variantId) }}
                    className="ml-auto p-1.5 text-muted-foreground hover:text-foreground"><X size={14} aria-hidden /></button>
                </div>
                {problem && <p role="alert" className="mt-1 text-xs text-destructive">{problemText(problem)}</p>}
              </div>
            </li>
          )
        })}
      </ul>

      <div className="space-y-2 text-sm">
        <div className="flex justify-between font-semibold"><span>Subtotal</span><span>{formatCents(subtotalCents)}</span></div>
        <p className="text-muted-foreground">Shipping and tax calculated at checkout</p>
        {threshold !== null && subtotalCents < threshold && (
          <p className="text-muted-foreground">{`Free shipping on orders over ${dollars(threshold)}`}</p>
        )}
        <p className="text-muted-foreground">{CONTIGUOUS_NOTICE}</p>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} />
        {OPT_IN_LABEL}
      </label>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button className="w-full" onClick={checkout} disabled={busy}>{busy ? 'Starting checkout…' : 'Checkout'}</Button>
    </div>
  )
}
```

(`text-destructive` is an existing theme colour: `--color-destructive` in `src/styles/globals.css`. `Input.tsx` uses it for field errors.)

```tsx
// src/components/cart/CartDrawer.tsx
import { useEffect } from 'react'
import { Link } from 'react-router'
import { X } from 'lucide-react'
import CartPanel from './CartPanel'

export default function CartDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-[70]">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <aside role="dialog" aria-modal="true" aria-label="Cart"
        className="absolute right-0 top-0 h-full w-full max-w-md bg-background border-l border-border overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-black uppercase tracking-[0.12em]" style={{ fontFamily: 'var(--font-display)' }}>Your cart</h2>
          <button type="button" aria-label="Close cart" onClick={onClose} className="p-2 text-muted-foreground hover:text-foreground">
            <X size={18} aria-hidden />
          </button>
        </div>
        <CartPanel onNavigate={onClose} />
        <Link to="/cart" onClick={onClose} className="mt-6 block text-center text-xs uppercase tracking-[0.16em] text-muted-foreground hover:text-foreground">
          View full cart
        </Link>
      </aside>
    </div>
  )
}
```

```tsx
// src/pages/Cart.tsx
import { PageHeader } from '../components/PageHeader'
import CartPanel from '../components/cart/CartPanel'

export default function Cart() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-16 space-y-10">
      <PageHeader eyebrow="Cart" title="Your cart" />
      <CartPanel />
    </div>
  )
}
```

```tsx
// src/pages/legal/Terms.tsx
import { Link } from 'react-router'
import { PageHeader } from '../../components/PageHeader'

/** Placeholder until launch readiness (sub-project 3) supplies reviewed terms. */
export default function Terms() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-16 space-y-6">
      <PageHeader eyebrow="Legal" title="Terms of sale" />
      <p className="text-sm text-muted-foreground">
        Our terms of sale are being finalised. Questions about an order? Visit <Link to="/support" className="underline">Support</Link>.
      </p>
    </div>
  )
}
```

```tsx
// src/pages/legal/Privacy.tsx
import { Link } from 'react-router'
import { PageHeader } from '../../components/PageHeader'

/** Placeholder until launch readiness (sub-project 3) supplies a reviewed policy. */
export default function Privacy() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-16 space-y-6">
      <PageHeader eyebrow="Legal" title="Privacy" />
      <p className="text-sm text-muted-foreground">
        Our privacy policy is being finalised. Questions? Visit <Link to="/support" className="underline">Support</Link>.
      </p>
    </div>
  )
}
```

- [ ] **Step 5: Root and routes**

In `src/app/Root.tsx`:
- Add `import CartDrawer from '../components/cart/CartDrawer'`.
- In `Nav`, add `const [cartOpen, setCartOpen] = useState(false)` and `const closeCart = useCallback(() => setCartOpen(false), [])`. Add `useCallback` to the React import.
- Replace the cart `<Link to="/checkout" …>…</Link>` with a `<button type="button" onClick={() => setCartOpen(true)} …>`. Keep the same className, `aria-label` expression, icon and badge.
- Render `<CartDrawer open={cartOpen} onClose={closeCart} />` just before `</nav>`.
- In `Footer`'s bottom row, after the Contact link, add four links in the same style:

```tsx
            <Link to="/legal/terms" className="text-muted-foreground text-xs hover:text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring">Terms</Link>
            <Link to="/legal/privacy" className="text-muted-foreground text-xs hover:text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring">Privacy</Link>
            <Link to="/support/returns" className="text-muted-foreground text-xs hover:text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring">Refunds</Link>
            <Link to="/support/shipping" className="text-muted-foreground text-xs hover:text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring">Shipping</Link>
```

In `src/routes.tsx`, import `Cart`, `Terms`, `Privacy`, and add after the `collections/:slug` route:

```tsx
      { path: 'cart', Component: Cart },
      { path: 'legal/terms', Component: Terms },
      { path: 'legal/privacy', Component: Privacy },
```

(The `checkout` route stays `NotFound` until Task 13.)

- [ ] **Step 6: Run, full suite, build, commit**

Run: `npx vitest run && npm run build`. Expected: PASS; build clean.

```bash
git add systems/storefront/code/src
git commit -m "feat(storefront): cart drawer and page with checkout start and stock error mapping" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 13: `/checkout` with Embedded Checkout, and `/order/complete`

**Files:**
- Modify: `systems/storefront/code/package.json` (`@stripe/stripe-js@9.17.0`, `@stripe/react-stripe-js@6.12.0`, exact)
- Create: `systems/storefront/code/src/lib/stripe.ts`
- Create: `systems/storefront/code/src/pages/Checkout.tsx`
- Create: `systems/storefront/code/src/pages/OrderComplete.tsx`
- Modify: `systems/storefront/code/src/routes.tsx`
- Test: `systems/storefront/code/src/pages/checkout-pages.test.tsx`

**Interfaces:**
- Consumes: `getCheckoutStatus`, `CheckoutStatus`, `UNAVAILABLE_MESSAGE` (Task 12); `useCart().clear` (Task 11); `setPreviousOrderId`, `clearPreviousOrderId` (Task 11); router state `{ clientSecret, orderId }` from `CartPanel` (Task 12).
- Produces: `getStripe(): Promise<Stripe | null> | null`; `POLL_INTERVAL_MS = 1500`, `POLL_LIMIT_MS = 20_000`; routes `/checkout`, `/order/complete`.

- [ ] **Step 1: Install the pinned client SDKs**

Run: `npm install --save-exact @stripe/stripe-js@9.17.0 @stripe/react-stripe-js@6.12.0`
Expected: both in `dependencies` without a caret. (`@stripe/react-stripe-js@6.12.0` peers: `@stripe/stripe-js >=9.16.0 <10`, `react <20`; both are satisfied.)

- [ ] **Step 2: Write the failing tests**

```tsx
// src/pages/checkout-pages.test.tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { render, screen, act } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { CartProvider, CART_STORAGE_KEY } from '../lib/cart/CartContext'

const captured = vi.hoisted(() => ({ options: undefined as undefined | { fetchClientSecret: () => Promise<string> } }))
vi.mock('@stripe/react-stripe-js', () => ({
  EmbeddedCheckoutProvider: ({ options, children }: { options: typeof captured.options; children: ReactNode }) => {
    captured.options = options
    return <div data-testid="provider">{children}</div>
  },
  EmbeddedCheckout: () => <div data-testid="embedded-checkout" />,
}))
vi.mock('../lib/stripe', () => ({ getStripe: vi.fn() }))
vi.mock('../lib/api/checkout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api/checkout')>()
  return { ...actual, getCheckoutStatus: vi.fn() }
})
import { getStripe } from '../lib/stripe'
import { getCheckoutStatus, type CheckoutStatus } from '../lib/api/checkout'
import Checkout from './Checkout'
import OrderComplete, { POLL_LIMIT_MS } from './OrderComplete'

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })

function renderCheckout(state?: { clientSecret: string; orderId: string }) {
  const router = createMemoryRouter(
    [{ path: '/checkout', element: <Checkout /> }, { path: '/cart', element: <p>cart page</p> }],
    { initialEntries: [{ pathname: '/checkout', state }] },
  )
  return render(<RouterProvider router={router} />)
}

describe('/checkout', () => {
  it('mounts Embedded Checkout with the client secret and remembers the order', async () => {
    vi.mocked(getStripe).mockReturnValue(Promise.resolve({} as never))
    renderCheckout({ clientSecret: 'cs_1_secret', orderId: 'order-1' })
    expect(screen.getByTestId('embedded-checkout')).toBeInTheDocument()
    expect(await captured.options!.fetchClientSecret()).toBe('cs_1_secret')
    expect(window.sessionStorage.getItem('ab.previousOrderId')).toBe('order-1')
    expect(screen.getByText('We ship to the contiguous US only.')).toBeInTheDocument()
    for (const name of ['Terms', 'Privacy', 'Refund', 'Shipping']) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument()
    }
  })

  it('sends a visitor without a session back to the cart', () => {
    vi.mocked(getStripe).mockReturnValue(Promise.resolve({} as never))
    renderCheckout()
    expect(screen.getByText('Your checkout has ended')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to cart' })).toHaveAttribute('href', '/cart')
  })

  it('explains when there is no publishable key', () => {
    vi.mocked(getStripe).mockReturnValue(null)
    renderCheckout({ clientSecret: 'cs_1_secret', orderId: 'o' })
    expect(screen.getByText("We couldn't load the payment form")).toBeInTheDocument()
    expect(screen.queryByTestId('embedded-checkout')).not.toBeInTheDocument()
  })

  it('explains when Stripe.js fails to load', async () => {
    vi.mocked(getStripe).mockReturnValue(Promise.reject(new Error('blocked by an extension')))
    renderCheckout({ clientSecret: 'cs_1_secret', orderId: 'o' })
    expect(await screen.findByText("We couldn't load the payment form")).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to cart' })).toBeInTheDocument()
  })
})

const PAID: CheckoutStatus = {
  status: 'paid', orderNumber: 'ABE-000042',
  lines: [{ name: 'Dragon Fortress', sku: 'ABE-3001', quantity: 1, unitPriceCents: 24900, lineSubtotalCents: 24900 }],
  totals: { subtotalCents: 24900, shippingCents: 0, taxCents: 1494, totalCents: 26394 },
}

function renderComplete(search = '?session_id=cs_test_1') {
  const router = createMemoryRouter(
    [{ path: '/order/complete', element: <CartProvider><OrderComplete /></CartProvider> }],
    { initialEntries: [`/order/complete${search}`] },
  )
  return render(<RouterProvider router={router} />)
}

describe('/order/complete', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('confirms a paid order, then clears the cart and the previous order', async () => {
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([{ variantId: 'v', productId: 'p', productSlug: 's', name: 'n', priceCents: 1, imageKey: '', quantity: 1 }]))
    window.sessionStorage.setItem('ab.previousOrderId', 'order-1')
    vi.mocked(getCheckoutStatus).mockResolvedValue(PAID)
    renderComplete()
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('Order ABE-000042 confirmed')).toBeInTheDocument()
    expect(screen.getByText('Your receipt is on its way from Stripe')).toBeInTheDocument()
    expect(screen.getByText('$263.94')).toBeInTheDocument()
    expect(JSON.parse(window.localStorage.getItem(CART_STORAGE_KEY)!)).toEqual([])
    expect(window.sessionStorage.getItem('ab.previousOrderId')).toBeNull()
  })

  it('polls every 1.5 s and settles on the slow message at 20 s', async () => {
    vi.mocked(getCheckoutStatus).mockResolvedValue({ ...PAID, status: 'pending' })
    renderComplete()
    await act(() => vi.advanceTimersByTimeAsync(3000))
    expect(vi.mocked(getCheckoutStatus).mock.calls.length).toBe(3) // t=0, 1.5, 3.0
    await act(() => vi.advanceTimersByTimeAsync(POLL_LIMIT_MS))
    expect(screen.getByText("Payment received — we're confirming your order. Your Stripe receipt is your confirmation.")).toBeInTheDocument()
    const calls = vi.mocked(getCheckoutStatus).mock.calls.length
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(vi.mocked(getCheckoutStatus).mock.calls.length).toBe(calls) // stopped
  })

  it('keeps polling through a transient error', async () => {
    vi.mocked(getCheckoutStatus).mockRejectedValueOnce(new Error('blip')).mockResolvedValue(PAID)
    renderComplete()
    await act(() => vi.advanceTimersByTimeAsync(1500))
    expect(screen.getByText('Order ABE-000042 confirmed')).toBeInTheDocument()
  })

  it('says the checkout expired', async () => {
    vi.mocked(getCheckoutStatus).mockResolvedValue({ ...PAID, status: 'cancelled' })
    renderComplete()
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('This checkout expired')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to cart' })).toHaveAttribute('href', '/cart')
  })

  it('handles a missing session id without calling core', async () => {
    renderComplete('')
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(getCheckoutStatus).not.toHaveBeenCalled()
    expect(screen.getByText("We couldn't find that checkout")).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run to see it fail**

Run: `npx vitest run src/pages/checkout-pages.test.tsx`
Expected: FAIL, `./Checkout` not found.

- [ ] **Step 4: Implement**

```ts
// src/lib/stripe.ts
import { loadStripe, type Stripe } from '@stripe/stripe-js'

let promise: Promise<Stripe | null> | null = null

/**
 * Stripe.js loads from js.stripe.com (PCI requirement; loadStripe injects
 * the script). null when this build has no publishable key -- the checkout
 * page then says it cannot load rather than failing silently.
 */
export function getStripe(): Promise<Stripe | null> | null {
  const key = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined
  if (!key) return null
  if (!promise) promise = loadStripe(key)
  return promise
}
```

```tsx
// src/pages/Checkout.tsx
import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from '@stripe/react-stripe-js'
import { getStripe } from '../lib/stripe'
import { setPreviousOrderId } from '../lib/checkout/previousOrder'
import { UNAVAILABLE_MESSAGE } from '../lib/api/checkout'
import { PageHeader } from '../components/PageHeader'

interface CheckoutState { clientSecret?: string; orderId?: string }

function Problem({ title, body }: { title: string; body: string }) {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-24 text-center space-y-6">
      <h1 className="text-3xl font-black uppercase tracking-[0.05em]" style={{ fontFamily: 'var(--font-display)' }}>{title}</h1>
      <p className="text-sm text-muted-foreground">{body}</p>
      <Link to="/cart" className="inline-block underline text-sm">Back to cart</Link>
    </div>
  )
}

/** Spec §6 / D7: Stripe Embedded Checkout on our own page. */
export default function Checkout() {
  const state = (useLocation().state ?? null) as CheckoutState | null
  const clientSecret = state?.clientSecret
  const orderId = state?.orderId
  const stripe = getStripe()
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    if (orderId) setPreviousOrderId(orderId)
  }, [orderId])

  useEffect(() => {
    let live = true
    stripe?.then(
      (s) => { if (live && !s) setLoadFailed(true) },
      () => { if (live) setLoadFailed(true) },
    )
    return () => { live = false }
  }, [stripe])

  const fetchClientSecret = useCallback(() => Promise.resolve(clientSecret ?? ''), [clientSecret])

  if (!clientSecret) return <Problem title="Your checkout has ended" body="Start again from your cart." />
  if (!stripe || loadFailed) return <Problem title="We couldn't load the payment form" body={UNAVAILABLE_MESSAGE} />

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-16 space-y-8">
      <PageHeader eyebrow="Checkout" title="Payment" intro="We ship to the contiguous US only." />
      <div id="checkout">
        <EmbeddedCheckoutProvider stripe={stripe} options={{ fetchClientSecret }}>
          <EmbeddedCheckout />
        </EmbeddedCheckoutProvider>
      </div>
      <p className="text-xs text-muted-foreground">
        By paying you agree to our <Link to="/legal/terms" className="underline">Terms</Link> and{' '}
        <Link to="/legal/privacy" className="underline">Privacy</Link> policy. See our{' '}
        <Link to="/support/returns" className="underline">Refund</Link> and{' '}
        <Link to="/support/shipping" className="underline">Shipping</Link> policies.
      </p>
    </div>
  )
}
```

```tsx
// src/pages/OrderComplete.tsx
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { getCheckoutStatus, type CheckoutStatus } from '../lib/api/checkout'
import { useCart } from '../lib/cart/CartContext'
import { clearPreviousOrderId } from '../lib/checkout/previousOrder'
import { formatCents } from '../lib/money'

export const POLL_INTERVAL_MS = 1500
export const POLL_LIMIT_MS = 20_000

type View =
  | { kind: 'loading' }
  | { kind: 'paid'; status: CheckoutStatus }
  | { kind: 'slow' }
  | { kind: 'expired' }
  | { kind: 'missing' }

const heading = 'text-3xl font-black uppercase tracking-[0.05em]'

/** Spec §6: poll core every 1.5 s for up to 20 s after Stripe's redirect. */
export default function OrderComplete() {
  const [params] = useSearchParams()
  const sessionId = params.get('session_id')
  const { clear } = useCart()
  const [view, setView] = useState<View>(sessionId ? { kind: 'loading' } : { kind: 'missing' })

  useEffect(() => {
    if (!sessionId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const started = Date.now()
    const tick = async () => {
      try {
        const s = await getCheckoutStatus(sessionId)
        if (stopped) return
        if (s.status === 'paid') {
          clear()
          clearPreviousOrderId()
          setView({ kind: 'paid', status: s })
          return
        }
        if (s.status === 'cancelled') {
          setView({ kind: 'expired' })
          return
        }
      } catch {
        if (stopped) return
        // A blip is not an answer; keep polling until the limit.
      }
      if (Date.now() - started >= POLL_LIMIT_MS) {
        setView({ kind: 'slow' })
        return
      }
      timer = setTimeout(() => { void tick() }, POLL_INTERVAL_MS)
    }
    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [sessionId, clear])

  const wrap = (children: ReactNode) => (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-24 space-y-6" style={{ fontFamily: 'var(--font-sans)' }}>{children}</div>
  )

  switch (view.kind) {
    case 'loading':
      return wrap(<p className="text-sm text-muted-foreground">Confirming your order…</p>)
    case 'missing':
      return wrap(<>
        <h1 className={heading}>We couldn't find that checkout</h1>
        <Link to="/cart" className="underline text-sm">Back to cart</Link>
      </>)
    case 'expired':
      return wrap(<>
        <h1 className={heading}>This checkout expired</h1>
        <Link to="/cart" className="underline text-sm">Back to cart</Link>
      </>)
    case 'slow':
      return wrap(<p className="text-sm">Payment received — we're confirming your order. Your Stripe receipt is your confirmation.</p>)
    case 'paid': {
      const { orderNumber, lines, totals } = view.status
      return wrap(<>
        <h1 className={heading}>{`Order ${orderNumber} confirmed`}</h1>
        <ul className="divide-y divide-border text-sm">
          {lines.map((l) => (
            <li key={l.sku} className="py-3 flex justify-between">
              <span>{l.name} × {l.quantity}</span><span>{formatCents(l.lineSubtotalCents)}</span>
            </li>
          ))}
        </ul>
        <dl className="text-sm space-y-1">
          <div className="flex justify-between"><dt>Subtotal</dt><dd>{formatCents(totals.subtotalCents)}</dd></div>
          <div className="flex justify-between"><dt>Shipping</dt><dd>{formatCents(totals.shippingCents)}</dd></div>
          <div className="flex justify-between"><dt>Tax</dt><dd>{formatCents(totals.taxCents)}</dd></div>
          <div className="flex justify-between font-semibold"><dt>Total</dt><dd>{formatCents(totals.totalCents)}</dd></div>
        </dl>
        <p className="text-sm text-muted-foreground">Your receipt is on its way from Stripe</p>
        <Link to="/collections" className="underline text-sm">Keep browsing</Link>
      </>)
    }
  }
}
```

In `src/routes.tsx`, import both pages and replace the `checkout` → `NotFound` route (and its comment) with:

```tsx
      // Stripe Embedded Checkout (spec 2026-09-27 §6). Stripe's return_url
      // lands on /order/complete?session_id=...
      { path: 'checkout', Component: Checkout },
      { path: 'order/complete', Component: OrderComplete },
```

- [ ] **Step 5: Run, full suite, build, commit**

Run: `npx vitest run && npm run build`. Expected: PASS; build clean. `grep -rn "initEmbeddedCheckout\|ui_mode" src` shows nothing, because the storefront never names a UI mode.

```bash
git add systems/storefront/code
git commit -m "feat(storefront): embedded Stripe checkout and order confirmation polling" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 14: Storefront verification and PR

**Files:** none new.

- [ ] **Step 1: Full checks**

Run: `npx vitest run && npm run build`. Expected: all pass (record the count); build clean.

- [ ] **Step 2: See it in the browser (no Stripe keys needed)**

Start core (`npm run dev` in `systems/core`) and the storefront (`npm run dev` here) through the Browser pane's `preview_start` (add a `.claude/launch.json` entry if none exists). Then check:
- Add a set, open the cart from the header, and check the drawer shows the notes, the opt-in (unticked), and "Free shipping on orders over $150".
- Visit `/?ref=Test-Partner`. The URL drops `ref`, and `localStorage['ab.referral']` holds `test-partner`.
- Click **Checkout**. Without Stripe keys on the local core, the panel shows "Checkout is temporarily unavailable — please try again in a minute." That proves the error path end to end. The paid path is verified on staging (Task 18).

- [ ] **Step 3: Push (with Jack's OK) and open the PR**

```bash
git push -u origin feat/revenue-loop-storefront
gh pr create --title "feat(storefront): cart, Stripe embedded checkout and confirmation" --body "$(cat <<'BODY'
Implements PR 2 (Tasks 11–14) of docs/superpowers/plans/2026-09-27-revenue-loop-checkout.md.

- Referral capture (?ref=, 30 days, last click wins)
- Persistent cart (10 per line), drawer and /cart page, opt-in, stock error mapping
- /checkout (Embedded Checkout, @stripe/react-stripe-js 6.12.0) and /order/complete polling
- Legal placeholders linked from the footer and checkout

Needs VITE_STRIPE_PUBLISHABLE_KEY on the staging storefront (runbook docs/status/2026-09-27-stripe-test-mode-runbook.md).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
gh pr checks --watch
```
Expected: CI green.

---

# PR 3 — Console (`feat/revenue-loop-console`)

Cut from `main` after PR 1 merges (it needs the fixtures Task 9 captured): `git checkout main && git pull --ff-only && git checkout -b feat/revenue-loop-console`. Every command below runs in `systems/admin-ui`. Baseline: `npx vitest run` (record the count). Console conventions: errors via `errorText(err)`, an in-flight guard on every write button, nothing shown as saved until core confirms, no mock fallback.

## Task 15: Order and settings API methods; the Orders queue

**Files:**
- Modify: `systems/admin-ui/src/data/api.js`
- Modify: `systems/admin-ui/src/lib/errorText.js`
- Create: `systems/admin-ui/src/orders/OrderQueue.jsx`
- Create: `systems/admin-ui/src/orders/labels.js`
- Modify: `systems/admin-ui/src/shell/Nav.jsx`, `systems/admin-ui/src/App.jsx`
- Test: `systems/admin-ui/src/data/api.orders.test.js`, `systems/admin-ui/src/orders/order-queue.test.jsx`

**Interfaces:**
- Consumes: core `GET /api/v1/admin/orders`, `GET /orders/:id`, `POST /orders/:id/ship`, `POST /orders/:id/cancel`, `GET|PUT /settings/shipping` (Task 9); fixtures `order-queue.json`, `order-detail.json`, `shipping-settings.json`.
- Produces:
  - `api.listOrders({ tab, page?, pageSize? })`, `api.getOrder(id)`, `api.shipOrder(id, { carrier, trackingNumber?, acknowledgeReview? })`, `api.cancelOrder(id)`, `api.getShippingSettings()`, `api.updateShippingSettings({ flatRateCents, freeThresholdCents })`
  - `ORDER_TABS` (`[{ id, label }]`), `REVIEW_LABELS`, `STATUS_LABELS` from `src/orders/labels.js`
  - Routes `/orders` (`?tab=&page=`), `/orders/:id`, `/settings`; nav entries Orders and Settings

- [ ] **Step 1: Write the failing tests**

```js
// src/data/api.orders.test.js
import { describe, it, expect, vi, afterEach } from 'vitest'
import api from './api.js'
import queue from './__fixtures__/order-queue.json'

function spyFetch(status, body) {
  const spy = vi.fn(async () => ({ ok: status < 400, status, json: async () => body }))
  vi.stubGlobal('fetch', spy)
  return spy
}
afterEach(() => vi.unstubAllGlobals())
const call = (spy) => ({ url: String(spy.mock.calls[0][0]), init: spy.mock.calls[0][1] })

describe('order and settings methods hit core', () => {
  it.each([
    ['listOrders', () => api.listOrders({ tab: 'to_ship', page: 2 }), 'GET', '/api/v1/admin/orders?tab=to_ship&page=2&pageSize=25'],
    ['getOrder', () => api.getOrder('o 1'), 'GET', '/api/v1/admin/orders/o%201'],
    ['shipOrder', () => api.shipOrder('o1', { carrier: 'USPS', trackingNumber: '9400' }), 'POST', '/api/v1/admin/orders/o1/ship'],
    ['cancelOrder', () => api.cancelOrder('o1'), 'POST', '/api/v1/admin/orders/o1/cancel'],
    ['getShippingSettings', () => api.getShippingSettings(), 'GET', '/api/v1/admin/settings/shipping'],
    ['updateShippingSettings', () => api.updateShippingSettings({ flatRateCents: 995, freeThresholdCents: null }), 'PUT', '/api/v1/admin/settings/shipping'],
  ])('%s', async (_name, invoke, method, path) => {
    const spy = spyFetch(200, queue)
    await invoke()
    const { url, init } = call(spy)
    expect(url.endsWith(path)).toBe(true)
    expect(init.method ?? 'GET').toBe(method)
    expect(init.credentials).toBe('include')
  })

  it('sends the ship form as JSON', async () => {
    const spy = spyFetch(200, {})
    await api.shipOrder('o1', { carrier: 'Other', acknowledgeReview: true })
    expect(JSON.parse(call(spy).init.body)).toEqual({ carrier: 'Other', acknowledgeReview: true })
  })
})
```

```jsx
// src/orders/order-queue.test.jsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import OrderQueue from './OrderQueue.jsx'
import queue from '../data/__fixtures__/order-queue.json'
import { AdminApiError } from '../data/errors.js'

vi.mock('../data/api.js', () => ({ default: { listOrders: vi.fn() } }))
import api from '../data/api.js'
afterEach(() => vi.clearAllMocks())

const renderQueue = (url = '/orders') => render(
  <MemoryRouter initialEntries={[url]}><Routes><Route path="/orders" element={<OrderQueue />} /></Routes></MemoryRouter>,
)

describe('OrderQueue', () => {
  it('lists the To ship queue by default with core’s rows', async () => {
    vi.mocked(api.listOrders).mockResolvedValue(queue)
    renderQueue()
    const row = await screen.findByRole('row', { name: new RegExp(queue.items[0].orderNumber) })
    expect(within(row).getByRole('link', { name: queue.items[0].orderNumber })).toHaveAttribute('href', `/orders/${queue.items[0].id}`)
    expect(within(row).getByText(queue.items[0].email)).toBeInTheDocument()
    expect(within(row).getByText('MI')).toBeInTheDocument()
    expect(api.listOrders).toHaveBeenCalledWith({ tab: 'to_ship', page: 1, pageSize: 25 })
    expect(screen.getByRole('tab', { name: 'To ship' })).toHaveAttribute('aria-selected', 'true')
  })

  it('switches tabs', async () => {
    vi.mocked(api.listOrders).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 })
    renderQueue()
    await userEvent.click(screen.getByRole('tab', { name: 'Needs review' }))
    expect(api.listOrders).toHaveBeenLastCalledWith({ tab: 'review', page: 1, pageSize: 25 })
    expect(await screen.findByText('No orders here.')).toBeInTheDocument()
  })

  it('shows a review reason and a placeholder for pending orders without an email', async () => {
    vi.mocked(api.listOrders).mockResolvedValue({ ...queue, items: [{ ...queue.items[0], email: null, shipToState: null, reviewReason: 'outside_shipping_area' }] })
    renderQueue('/orders?tab=review')
    expect(await screen.findByText('Outside shipping area')).toBeInTheDocument()
    expect(screen.getAllByText('—').length).toBe(2)
  })

  it('shows core’s error', async () => {
    vi.mocked(api.listOrders).mockRejectedValue(new AdminApiError('Server unavailable', 'INTERNAL'))
    renderQueue()
    expect(await screen.findByRole('alert')).toHaveTextContent('Server unavailable')
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run src/data/api.orders.test.js src/orders/order-queue.test.jsx`
Expected: FAIL — `api.listOrders` is not a function; `OrderQueue.jsx` not found.

- [ ] **Step 3: Implement**

Add to the `api` object in `src/data/api.js`, after `getStockHistory`:

```js
  async listOrders({ tab, page = 1, pageSize = 25 }) {
    const params = new URLSearchParams({ tab, page: String(page), pageSize: String(pageSize) })
    return call(`/orders?${params}`)
  },
  async getOrder(id) {
    return call(`/orders/${encodeURIComponent(id)}`)
  },
  async shipOrder(id, input) {
    return call(`/orders/${encodeURIComponent(id)}/ship`, { method: 'POST', body: JSON.stringify(input) })
  },
  async cancelOrder(id) {
    return call(`/orders/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' })
  },
  async getShippingSettings() {
    return call('/settings/shipping')
  },
  async updateShippingSettings(input) {
    return call('/settings/shipping', { method: 'PUT', body: JSON.stringify(input) })
  },
```

Extend `LABELS` in `src/lib/errorText.js`:

```js
const LABELS = {
  sku: 'SKU', priceCents: 'price', onHand: 'quantity', attributes: 'attributes',
  walmartAllocation: 'Walmart allocation', expectedOnHand: 'expected on hand', note: 'note',
  carrier: 'carrier', trackingNumber: 'tracking number', acknowledgeReview: 'review confirmation',
  flatRateCents: 'flat rate', freeThresholdCents: 'free-shipping threshold',
  weightGrams: 'weight', lengthMm: 'length', widthMm: 'width', heightMm: 'height',
}
```

```js
// src/orders/labels.js
/** Queue tabs (spec §7). ids are core's `tab` values. */
export const ORDER_TABS = [
  { id: 'to_ship', label: 'To ship' },
  { id: 'shipped', label: 'Shipped' },
  { id: 'pending', label: 'Pending' },
  { id: 'closed', label: 'Closed' },
  { id: 'review', label: 'Needs review' },
]

export const REVIEW_LABELS = {
  amount_mismatch: 'Amount mismatch',
  paid_after_cancel: 'Paid after cancel',
  outside_shipping_area: 'Outside shipping area',
  disputed: 'Disputed',
}

/** "Shipped" in the console is core's `fulfilled` status (spec §2). */
export const STATUS_LABELS = {
  pending: 'Pending', paid: 'Paid', fulfilled: 'Shipped', cancelled: 'Cancelled', refunded: 'Refunded',
}
```

```jsx
// src/orders/OrderQueue.jsx
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import api from '../data/api.js'
import Pill from '../ui/Pill.jsx'
import { formatCents } from '../lib/money.js'
import { errorText } from '../lib/errorText.js'
import { ORDER_TABS, REVIEW_LABELS } from './labels.js'

const PAGE_SIZE = 25
const day = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

export default function OrderQueue() {
  const [params, setParams] = useSearchParams()
  const tab = ORDER_TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'to_ship'
  const page = Math.max(1, Number(params.get('page')) || 1)
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let live = true
    setData(null)
    setError(null)
    api.listOrders({ tab, page, pageSize: PAGE_SIZE })
      .then((d) => { if (live) setData(d) })
      .catch((e) => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [tab, page])

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1

  return (
    <div>
      <h1 className="text-3xl font-bold">Orders</h1>
      <p className="text-gray-500">Storefront orders. Refunds are issued in the Stripe dashboard.</p>

      <div role="tablist" aria-label="Order queues" className="mt-4 flex flex-wrap gap-2">
        {ORDER_TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === tab} onClick={() => setParams({ tab: t.id })}
            className={`rounded-pill px-4 py-2 text-sm font-semibold ${t.id === tab ? 'bg-ink text-white' : 'bg-white text-gray-600'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {error && <p role="alert" className="mt-4 text-sm text-accent">{error}</p>}
      {!data && !error && <p className="mt-4 text-sm text-gray-500">Loading…</p>}
      {data && (
        <>
          <table className="mt-4 w-full text-sm">
            <thead className="text-left text-gray-500">
              <tr><th className="py-2">Order</th><th>Date</th><th>Customer</th><th>Items</th><th>Total</th><th>Ship to</th><th></th></tr>
            </thead>
            <tbody>
              {data.items.map((o) => (
                <tr key={o.id} className="border-t border-gray-100">
                  <td className="py-2"><Link to={`/orders/${o.id}`} className="font-semibold">{o.orderNumber}</Link></td>
                  <td>{day(o.createdAt)}</td>
                  <td>{o.email ?? '—'}</td>
                  <td>{o.itemCount}</td>
                  <td>{formatCents(o.totalCents)}</td>
                  <td>{o.shipToState ?? '—'}</td>
                  <td>{o.reviewReason && <Pill>{REVIEW_LABELS[o.reviewReason] ?? o.reviewReason}</Pill>}</td>
                </tr>
              ))}
              {data.items.length === 0 && <tr><td colSpan={7} className="py-4 text-gray-400">No orders here.</td></tr>}
            </tbody>
          </table>
          <div className="mt-4 flex items-center gap-3 text-sm">
            <button disabled={page <= 1} onClick={() => setParams({ tab, page: String(page - 1) })} className="disabled:text-gray-300">Previous</button>
            <span>Page {page} of {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setParams({ tab, page: String(page + 1) })} className="disabled:text-gray-300">Next</button>
          </div>
        </>
      )}
    </div>
  )
}
```

`src/shell/Nav.jsx`: extend `sections`:

```js
const sections = [
  { to: '/', label: 'Overview', end: true },
  { to: '/products', label: 'Products' },
  { to: '/orders', label: 'Orders' },
  { to: '/settings', label: 'Settings' },
]
```

`src/App.jsx`: import `OrderQueue`, and add inside the `ConsoleShell` route:

```jsx
          <Route path="orders" element={<OrderQueue />} />
```

(`orders/:id` and `settings` routes are added in Tasks 16 and 17, with their components.)

- [ ] **Step 4: Run, full suite, commit**

Run: `npx vitest run`. Expected: PASS.

```bash
git add systems/admin-ui/src
git commit -m "feat(admin-ui): orders queue and order/settings API methods" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 16: Order detail, Mark shipped, Cancel

**Files:**
- Create: `systems/admin-ui/src/orders/OrderDetail.jsx`
- Create: `systems/admin-ui/src/orders/ShipDialog.jsx`
- Modify: `systems/admin-ui/src/App.jsx`
- Test: `systems/admin-ui/src/orders/order-detail.test.jsx`

**Interfaces:**
- Consumes: `api.getOrder`, `api.shipOrder`, `api.cancelOrder` (Task 15); `REVIEW_LABELS`, `STATUS_LABELS` (Task 15); `Modal`, `Button`, `Pill`, `useToast`, `errorText`, `formatCents`; fixture `order-detail.json` (status `paid`, `referral.unmatched: true`).
- Produces: route `/orders/:id`; `ShipDialog({ order, onClose, onShipped })`.

- [ ] **Step 1: Write the failing test**

```jsx
// src/orders/order-detail.test.jsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ToastProvider } from '../ui/toast.jsx'
import OrderDetail from './OrderDetail.jsx'
import detail from '../data/__fixtures__/order-detail.json'
import { AdminApiError } from '../data/errors.js'

vi.mock('../data/api.js', () => ({ default: { getOrder: vi.fn(), shipOrder: vi.fn(), cancelOrder: vi.fn() } }))
import api from '../data/api.js'
afterEach(() => vi.clearAllMocks())

function renderDetail(order = detail) {
  vi.mocked(api.getOrder).mockResolvedValue(order)
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[`/orders/${order.id}`]}>
        <Routes><Route path="/orders/:id" element={<OrderDetail />} /></Routes>
      </MemoryRouter>
    </ToastProvider>,
  )
}

describe('OrderDetail', () => {
  it('shows lines, address, money, referral and the Stripe link', async () => {
    renderDetail()
    expect(await screen.findByRole('heading', { name: new RegExp(detail.orderNumber) })).toBeInTheDocument()
    expect(screen.getByText(detail.lines[0].name)).toBeInTheDocument()
    expect(screen.getByText(detail.shipTo.line1)).toBeInTheDocument()
    expect(screen.getByText('unmatched')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /view payment in stripe/i })).toHaveAttribute('href', detail.stripePaymentUrl)
    expect(screen.getByText('order.paid')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /cancel order/i })).not.toBeInTheDocument() // paid: refund in Stripe
  })

  it('marks shipped: tracking required unless Other', async () => {
    const shipped = { ...detail, status: 'fulfilled', carrier: 'USPS', trackingNumber: '9400', shippedAt: '2026-09-28T10:00:00.000Z' }
    vi.mocked(api.shipOrder).mockResolvedValue(shipped)
    renderDetail()
    await userEvent.click(await screen.findByRole('button', { name: 'Mark shipped' }))
    const dialog = screen.getByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: 'Mark shipped' })
    expect(confirm).toBeDisabled()
    await userEvent.type(within(dialog).getByLabelText('Tracking number'), '9400')
    await userEvent.click(confirm)
    expect(api.shipOrder).toHaveBeenCalledWith(detail.id, { carrier: 'USPS', trackingNumber: '9400' })
    expect(await screen.findByText('Shipped')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('allows Other without tracking', async () => {
    vi.mocked(api.shipOrder).mockResolvedValue({ ...detail, status: 'fulfilled', carrier: 'Other' })
    renderDetail()
    await userEvent.click(await screen.findByRole('button', { name: 'Mark shipped' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.selectOptions(within(dialog).getByLabelText('Carrier'), 'Other')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark shipped' }))
    expect(api.shipOrder).toHaveBeenCalledWith(detail.id, { carrier: 'Other' })
  })

  it('requires the review acknowledgement for a flagged order', async () => {
    vi.mocked(api.shipOrder).mockResolvedValue({ ...detail, status: 'fulfilled' })
    renderDetail({ ...detail, reviewReason: 'outside_shipping_area' })
    await userEvent.click(await screen.findByRole('button', { name: 'Mark shipped' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Tracking number'), '1Z9')
    const confirm = within(dialog).getByRole('button', { name: 'Mark shipped' })
    expect(confirm).toBeDisabled()
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /reviewed it/i }))
    await userEvent.click(confirm)
    expect(api.shipOrder).toHaveBeenCalledWith(detail.id, { carrier: 'USPS', trackingNumber: '1Z9', acknowledgeReview: true })
  })

  it('shows core’s error in the dialog and keeps it open', async () => {
    vi.mocked(api.shipOrder).mockRejectedValue(new AdminApiError('invalid input', 'VALIDATION_ERROR', { trackingNumber: 'letters, numbers, spaces and hyphens, at most 64' }))
    renderDetail()
    await userEvent.click(await screen.findByRole('button', { name: 'Mark shipped' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Tracking number'), '###')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark shipped' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('tracking number: letters')
  })

  it('cancels a pending order after confirmation', async () => {
    vi.mocked(api.cancelOrder).mockResolvedValue({ ...detail, status: 'cancelled' })
    renderDetail({ ...detail, status: 'pending' })
    await userEvent.click(await screen.findByRole('button', { name: /cancel order/i }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel order' }))
    expect(api.cancelOrder).toHaveBeenCalledWith(detail.id)
    expect(await screen.findByText('Cancelled')).toBeInTheDocument()
  })

  it('explains when the customer paid before the cancel landed', async () => {
    vi.mocked(api.cancelOrder).mockRejectedValue(new AdminApiError('The customer has just paid for this order.', 'ORDER_PAID'))
    renderDetail({ ...detail, status: 'pending' })
    await userEvent.click(await screen.findByRole('button', { name: /cancel order/i }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel order' }))
    expect(await screen.findByText(/has just paid/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run src/orders/order-detail.test.jsx`
Expected: FAIL, `OrderDetail.jsx` not found.

- [ ] **Step 3: Implement**

```jsx
// src/orders/ShipDialog.jsx
import { useState } from 'react'
import api from '../data/api.js'
import Modal from '../ui/Modal.jsx'
import { errorText } from '../lib/errorText.js'
import { REVIEW_LABELS } from './labels.js'

const CARRIERS = ['USPS', 'UPS', 'FedEx', 'Other']

/** Spec §7: carrier + tracking (required unless Other) -> core fulfils. */
export default function ShipDialog({ order, onClose, onShipped }) {
  const [carrier, setCarrier] = useState('USPS')
  const [tracking, setTracking] = useState('')
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const flagged = Boolean(order.reviewReason)
  const trackingOk = carrier === 'Other' || tracking.trim() !== ''
  const valid = trackingOk && (!flagged || ack)

  const submit = async () => {
    if (busy || !valid) return
    setBusy(true)
    setError(null)
    try {
      onShipped(await api.shipOrder(order.id, {
        carrier,
        ...(tracking.trim() ? { trackingNumber: tracking.trim() } : {}),
        ...(flagged ? { acknowledgeReview: true } : {}),
      }))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open title={`Mark ${order.orderNumber} shipped`} onClose={onClose} onConfirm={submit}
      confirmLabel="Mark shipped" confirmDisabled={busy || !valid}>
      <div className="space-y-3">
        <label className="block">Carrier
          <select aria-label="Carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-gray-200 px-2 py-1">
            {CARRIERS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="block">Tracking number {carrier === 'Other' && <span className="text-gray-400">(optional)</span>}
          <input aria-label="Tracking number" value={tracking} onChange={(e) => setTracking(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-gray-200 px-2 py-1 font-mono" />
        </label>
        {flagged && (
          <label className="flex items-start gap-2 text-accent">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>This order is flagged ({REVIEW_LABELS[order.reviewReason] ?? order.reviewReason}). I have reviewed it and it should ship.</span>
          </label>
        )}
        {error && <p role="alert" className="text-accent">{error}</p>}
      </div>
    </Modal>
  )
}
```

```jsx
// src/orders/OrderDetail.jsx
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import api from '../data/api.js'
import Card from '../ui/Card.jsx'
import Pill from '../ui/Pill.jsx'
import Button from '../ui/Button.jsx'
import Modal from '../ui/Modal.jsx'
import { useToast } from '../ui/toast.jsx'
import { formatCents } from '../lib/money.js'
import { errorText } from '../lib/errorText.js'
import { REVIEW_LABELS, STATUS_LABELS } from './labels.js'
import ShipDialog from './ShipDialog.jsx'

const when = (iso) => (iso ? new Date(iso).toLocaleString('en-US') : '—')

export default function OrderDetail() {
  const { id } = useParams()
  const toast = useToast()
  const [order, setOrder] = useState(null)
  const [error, setError] = useState(null)
  const [shipping, setShipping] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  useEffect(() => {
    let live = true
    api.getOrder(id).then((o) => { if (live) setOrder(o) }).catch((e) => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [id])

  const cancel = async () => {
    if (cancelling) return
    setCancelling(true)
    setError(null)
    try {
      setOrder(await api.cancelOrder(order.id))
      toast.push('Order cancelled')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setCancelling(false)
      setConfirmCancel(false)
    }
  }

  if (!order) return error ? <p role="alert" className="text-accent">{error}</p> : <p className="text-gray-500">Loading…</p>

  const money = [
    ['Subtotal', order.subtotalCents], ['Shipping', order.shippingCents], ['Tax', order.taxCents], ['Total', order.totalCents],
  ]

  return (
    <div className="space-y-6">
      <Link to="/orders" className="text-sm text-gray-500">← Orders</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-bold">Order {order.orderNumber}</h1>
        <Pill>{STATUS_LABELS[order.status] ?? order.status}</Pill>
        {order.reviewReason && <Pill>{REVIEW_LABELS[order.reviewReason] ?? order.reviewReason}</Pill>}
        <div className="ml-auto flex gap-2">
          {order.status === 'paid' && <Button onClick={() => setShipping(true)}>Mark shipped</Button>}
          {order.status === 'pending' && <Button variant="danger" onClick={() => setConfirmCancel(true)}>Cancel order</Button>}
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-accent">{error}</p>}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <h2 className="font-semibold">Items</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {order.lines.map((l) => (
              <li key={l.variantId} className="flex justify-between gap-4">
                <span><span>{l.name}</span> <span className="font-mono text-gray-400">{l.sku}</span> × {l.quantity}</span>
                <span>{formatCents(l.lineSubtotalCents)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-4 space-y-1 text-sm">
            {money.map(([k, v]) => <div key={k} className="flex justify-between"><dt>{k}</dt><dd>{formatCents(v)}</dd></div>)}
            {order.refundedCents > 0 && <div className="flex justify-between text-accent"><dt>Refunded</dt><dd>{formatCents(order.refundedCents)}</dd></div>}
          </dl>
          {order.stripePaymentUrl && (
            <a href={order.stripePaymentUrl} target="_blank" rel="noreferrer" className="mt-3 inline-block text-sm font-semibold">View payment in Stripe</a>
          )}
          <p className="mt-2 text-xs text-gray-400">Refunds are issued in the Stripe dashboard.</p>
        </Card>

        <Card>
          <h2 className="font-semibold">Customer</h2>
          <p className="mt-2 text-sm">{order.email ?? '—'}</p>
          {order.shipTo ? (
            <address className="mt-2 text-sm not-italic">
              <div>{order.shipTo.name}</div>
              <div>{order.shipTo.line1}</div>
              {order.shipTo.line2 && <div>{order.shipTo.line2}</div>}
              <div>{order.shipTo.city}, {order.shipTo.state} {order.shipTo.postalCode}</div>
            </address>
          ) : <p className="mt-2 text-sm text-gray-400">No address yet.</p>}
          <dl className="mt-4 space-y-1 text-sm">
            <div className="flex justify-between"><dt>Placed</dt><dd>{when(order.createdAt)}</dd></div>
            <div className="flex justify-between"><dt>Paid</dt><dd>{when(order.paidAt)}</dd></div>
            {/* "Shipped at", not "Shipped": the status pill owns the word "Shipped". */}
            <div className="flex justify-between"><dt>Shipped at</dt><dd>{when(order.shippedAt)}</dd></div>
            {order.carrier && <div className="flex justify-between"><dt>Carrier</dt><dd>{order.carrier} {order.trackingNumber}</dd></div>}
            <div className="flex justify-between"><dt>Referral</dt><dd>{
              !order.referral ? '—'
                : order.referral.unmatched ? <span>{order.referral.code} · <span>unmatched</span></span>
                  : `${order.referral.code} · ${order.referral.partnerName} · ${(order.referral.commissionRateBps / 100).toFixed(2)}%`
            }</dd></div>
          </dl>
        </Card>
      </div>

      <Card>
        <h2 className="font-semibold">History</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {order.audit.map((a, i) => (
            <li key={i} className="flex gap-4"><span className="w-48 text-gray-500">{when(a.createdAt)}</span><span className="font-mono">{a.action}</span><span className="text-gray-500">{a.actorName}</span></li>
          ))}
        </ul>
      </Card>

      {shipping && (
        <ShipDialog order={order} onClose={() => setShipping(false)}
          onShipped={(o) => { setOrder(o); setShipping(false); toast.push('Order marked shipped') }} />
      )}
      <Modal open={confirmCancel} title={`Cancel ${order.orderNumber}?`} danger confirmLabel="Cancel order"
        confirmDisabled={cancelling} onClose={() => setConfirmCancel(false)} onConfirm={cancel}>
        This closes the customer's Stripe checkout and returns the items to stock.
      </Modal>
    </div>
  )
}
```

Add to `src/App.jsx`: import `OrderDetail` and `<Route path="orders/:id" element={<OrderDetail />} />`.

The tests find `'Shipped'` and `'Cancelled'` as the status pill text (`STATUS_LABELS`). This is why the timestamp row is labelled "Shipped at".

- [ ] **Step 4: Run, full suite, commit**

Run: `npx vitest run`. Expected: PASS.

```bash
git add systems/admin-ui/src
git commit -m "feat(admin-ui): order detail with mark-shipped and cancel" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 17: Shipping settings page and variant weight/dimensions

**Files:**
- Create: `systems/admin-ui/src/settings/ShippingSettings.jsx`
- Create: `systems/admin-ui/src/catalog/tabs/DimensionsDialog.jsx`
- Modify: `systems/admin-ui/src/catalog/tabs/VariantsTab.jsx`, `systems/admin-ui/src/App.jsx`
- Test: `systems/admin-ui/src/settings/shipping-settings.test.jsx`; add to `systems/admin-ui/src/catalog/variants-tab.test.jsx`

**Interfaces:**
- Consumes: `api.getShippingSettings`, `api.updateShippingSettings` (Task 15); `api.updateVariant` (existing); `dollarsToCents`, `formatCents`; fixtures `shipping-settings.json`, `product-with-stock.json` (with physicals, Task 9).
- Produces: route `/settings`; `DimensionsDialog({ variant, onClose, onSaved })`.

- [ ] **Step 1: Write the failing tests**

```jsx
// src/settings/shipping-settings.test.jsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../ui/toast.jsx'
import ShippingSettings from './ShippingSettings.jsx'
import settings from '../data/__fixtures__/shipping-settings.json'

vi.mock('../data/api.js', () => ({ default: { getShippingSettings: vi.fn(), updateShippingSettings: vi.fn() } }))
import api from '../data/api.js'
afterEach(() => vi.clearAllMocks())

const renderPage = () => {
  vi.mocked(api.getShippingSettings).mockResolvedValue(settings)
  return render(<ToastProvider><ShippingSettings /></ToastProvider>)
}

describe('ShippingSettings', () => {
  it('loads core’s values in dollars', async () => {
    renderPage()
    expect(await screen.findByLabelText('Flat rate per order ($)')).toHaveValue('9.95')
    expect(screen.getByLabelText('Free shipping at or above ($)')).toHaveValue('150.00')
    expect(screen.getByRole('checkbox', { name: 'Offer free shipping' })).toBeChecked()
  })

  it('saves cents, converting once', async () => {
    vi.mocked(api.updateShippingSettings).mockResolvedValue({ ...settings, flatRateCents: 1295 })
    renderPage()
    const flat = await screen.findByLabelText('Flat rate per order ($)')
    await userEvent.clear(flat)
    await userEvent.type(flat, '12.95')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.updateShippingSettings).toHaveBeenCalledWith({ flatRateCents: 1295, freeThresholdCents: 15000 })
    expect(await screen.findByText('Shipping settings saved')).toBeInTheDocument()
  })

  it('turns free shipping off as null and blocks a non-price', async () => {
    vi.mocked(api.updateShippingSettings).mockResolvedValue({ ...settings, freeThresholdCents: null })
    renderPage()
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Offer free shipping' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.updateShippingSettings).toHaveBeenCalledWith({ flatRateCents: 995, freeThresholdCents: null })
    const flat = screen.getByLabelText('Flat rate per order ($)')
    await userEvent.clear(flat)
    await userEvent.type(flat, 'abc')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})
```

Add to the `describe('VariantsTab', …)` in `src/catalog/variants-tab.test.jsx`:

```jsx
  it('edits weight and dimensions, sending only what changed', async () => {
    vi.mocked(api.updateVariant).mockResolvedValue(withStock)
    renderTab()
    await userEvent.click(screen.getByRole('button', { name: /dimensions/i }))
    const dialog = screen.getByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Weight (g)'), '850')
    await userEvent.type(within(dialog).getByLabelText('Length (mm)'), '380')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(api.updateVariant).toHaveBeenCalledWith(v.id, { weightGrams: 850, lengthMm: 380 })
  })

  it('refuses a non-whole weight', async () => {
    renderTab()
    await userEvent.click(screen.getByRole('button', { name: /dimensions/i }))
    const dialog = screen.getByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Weight (g)'), '8.5')
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
  })
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run src/settings/shipping-settings.test.jsx src/catalog/variants-tab.test.jsx`
Expected: FAIL, `ShippingSettings.jsx` not found; no Dimensions button.

- [ ] **Step 3: Implement**

```jsx
// src/settings/ShippingSettings.jsx
import { useEffect, useState } from 'react'
import api from '../data/api.js'
import Card from '../ui/Card.jsx'
import Button from '../ui/Button.jsx'
import { useToast } from '../ui/toast.jsx'
import { dollarsToCents } from '../lib/money.js'
import { errorText } from '../lib/errorText.js'

const toText = (cents) => (cents / 100).toFixed(2)

/** Spec §7: flat rate and free-shipping threshold (D2's placeholders live here). */
export default function ShippingSettings() {
  const toast = useToast()
  const [loaded, setLoaded] = useState(false)
  const [flat, setFlat] = useState('')
  const [freeOn, setFreeOn] = useState(true)
  const [threshold, setThreshold] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const apply = (s) => {
    setFlat(toText(s.flatRateCents))
    setFreeOn(s.freeThresholdCents !== null)
    setThreshold(s.freeThresholdCents !== null ? toText(s.freeThresholdCents) : '')
    setLoaded(true)
  }

  useEffect(() => {
    let live = true
    api.getShippingSettings().then((s) => { if (live) apply(s) }).catch((e) => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [])

  const flatCents = dollarsToCents(flat)
  const thresholdCents = freeOn ? dollarsToCents(threshold) : null
  const valid = flatCents !== null && (!freeOn || (thresholdCents !== null && thresholdCents > 0))

  const save = async () => {
    if (busy || !valid) return
    setBusy(true)
    setError(null)
    try {
      apply(await api.updateShippingSettings({ flatRateCents: flatCents, freeThresholdCents: thresholdCents }))
      toast.push('Shipping settings saved')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-3xl font-bold">Settings</h1>
      <Card>
        <h2 className="font-semibold">Shipping</h2>
        {!loaded && !error && <p className="text-sm text-gray-500">Loading…</p>}
        {loaded && (
          <div className="mt-3 space-y-3 text-sm">
            <label className="block">Flat rate per order ($)
              <input aria-label="Flat rate per order ($)" value={flat} onChange={(e) => setFlat(e.target.value)}
                className="mt-1 block w-32 rounded-lg border border-gray-200 px-2 py-1" />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={freeOn} onChange={(e) => setFreeOn(e.target.checked)} />
              Offer free shipping
            </label>
            {freeOn && (
              <label className="block">Free shipping at or above ($)
                <input aria-label="Free shipping at or above ($)" value={threshold} onChange={(e) => setThreshold(e.target.value)}
                  className="mt-1 block w-32 rounded-lg border border-gray-200 px-2 py-1" />
              </label>
            )}
            <p className="text-xs text-gray-400">Applies to checkouts started after saving. Contiguous US only.</p>
            <Button onClick={save} disabled={busy || !valid}>Save</Button>
          </div>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-accent">{error}</p>}
      </Card>
    </div>
  )
}
```

```jsx
// src/catalog/tabs/DimensionsDialog.jsx
import { useState } from 'react'
import api from '../../data/api.js'
import Modal from '../../ui/Modal.jsx'
import { errorText } from '../../lib/errorText.js'

const FIELDS = [
  ['weightGrams', 'Weight (g)'], ['lengthMm', 'Length (mm)'], ['widthMm', 'Width (mm)'], ['heightMm', 'Height (mm)'],
]
const WHOLE = /^[1-9]\d*$/

/**
 * Optional shipping physicals (spec §7). Unused until a carrier-rate adapter
 * exists. Sends only changed fields; an emptied field clears to null.
 */
export default function DimensionsDialog({ variant, onClose, onSaved }) {
  const [values, setValues] = useState(() =>
    Object.fromEntries(FIELDS.map(([k]) => [k, variant[k] == null ? '' : String(variant[k])])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const parsed = Object.fromEntries(FIELDS.map(([k]) => {
    const t = values[k].trim()
    return [k, t === '' ? null : WHOLE.test(t) ? Number(t) : undefined]
  }))
  const valid = Object.values(parsed).every((v) => v !== undefined)
  const patch = Object.fromEntries(Object.entries(parsed).filter(([k, v]) => v !== (variant[k] ?? null)))

  const save = async () => {
    if (busy || !valid) return
    if (Object.keys(patch).length === 0) { onClose(); return }
    setBusy(true)
    setError(null)
    try {
      onSaved(await api.updateVariant(variant.id, patch))
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open title={`${variant.sku} — weight and dimensions`} onClose={onClose} onConfirm={save}
      confirmLabel="Save" confirmDisabled={busy || !valid}>
      <div className="grid grid-cols-2 gap-3">
        {FIELDS.map(([k, label]) => (
          <label key={k} className="block">{label}
            <input aria-label={label} inputMode="numeric" value={values[k]}
              onChange={(e) => setValues((s) => ({ ...s, [k]: e.target.value }))}
              className="mt-1 block w-full rounded-lg border border-gray-200 px-2 py-1" />
          </label>
        ))}
      </div>
      <p className="mt-2 text-xs text-gray-400">Optional. Used for carrier rates later; flat-rate shipping ignores them.</p>
      {error && <p role="alert" className="mt-2 text-accent">{error}</p>}
    </Modal>
  )
}
```

In `src/catalog/tabs/VariantsTab.jsx`:
- `import DimensionsDialog from './DimensionsDialog.jsx'`
- In `VariantsTab`, add `const [dimsFor, setDimsFor] = useState(null)`.
- Give `VariantRow` an `onDimensions` prop, pass `onDimensions={setDimsFor}` where it is rendered, and add this button before "Set stock" in the row's action cell:

```jsx
        <button onClick={() => onDimensions(v)} className="text-xs font-semibold">Dimensions</button>
```

- After the `StockDialog` block, render:

```jsx
      {dimsFor && (
        <DimensionsDialog
          variant={product.variants.find((x) => x.id === dimsFor.id) ?? dimsFor}
          onClose={() => setDimsFor(null)}
          onSaved={onUpdated}
        />
      )}
```

In `src/App.jsx`, import `ShippingSettings` and add `<Route path="settings" element={<ShippingSettings />} />`.

- [ ] **Step 4: Run, full suite, build, commit**

Run: `npx vitest run && npm run build`. Expected: PASS; build clean.

```bash
git add systems/admin-ui/src
git commit -m "feat(admin-ui): shipping settings page and variant weight/dimensions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 18: Console verification, PR, and the staging end-to-end run

**Files:** none new (results go in the PR descriptions).

- [ ] **Step 1: Console checks**

Run in `systems/admin-ui`: `npx vitest run && npm run build`. Expected: all pass (record the count); build clean.

- [ ] **Step 2: Push (with Jack's OK) and open the PR**

```bash
git push -u origin feat/revenue-loop-console
gh pr create --title "feat(admin-ui): orders queue, ship/cancel, shipping settings, variant dimensions" --body "$(cat <<'BODY'
Implements PR 3 (Tasks 15–18) of docs/superpowers/plans/2026-09-27-revenue-loop-checkout.md.

- Orders nav: To ship / Shipped / Pending / Closed / Needs review
- Order detail with Mark shipped (carrier + tracking, review acknowledgement) and Cancel (pending only)
- Settings: flat rate and free-shipping threshold
- Variants tab: optional weight and dimensions

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
gh pr checks --watch
```
Expected: CI green.

- [ ] **Step 3: Staging end-to-end (after all three PRs merge and staging deploys)**

This needs Jack to have completed `docs/status/2026-09-27-stripe-test-mode-runbook.md` §§1–5 (keys, Stripe Tax Michigan registration, webhook endpoint at API version `2026-08-26.dahlia`, partner seed). Do not ask for, or handle, any key.

Run the ten checks in the runbook's §6 table against `https://staging.alpinebrickexchange.com` and `https://admin-staging.alpinebrickexchange.com`, using Stripe test cards only. For each, record the order number, what the console showed, and pass/fail in a comment on the core PR. Stop and report on the first failure; do not patch staging data by hand.

Expected: all ten pass. Check 9 (Alaska) confirms the §9.1 backstop: the order is paid and appears under **Needs review** as "Outside shipping area".

- [ ] **Step 4: Report**

Report to Jack: the three PR numbers, the ten e2e results, and the open questions still held by him and the partner (§9.2 Stripe account owner, §9.3 Stripe Tax registrations and partner tax sign-off, §9.4 Tim's shipping provider, §9.5 tax code). Do not write outside this repo.


---

## Self-review (run 2026-09-27, against the spec)

### Spec coverage

| Spec | Requirement | Task |
|---|---|---|
| D1 / §3 | Stripe Tax in the session; `deferredTaxAdapter` at place; webhook writes real tax | 4, 5, 7 |
| D2 / §3 | `ShippingPort`, flat rate $9.95 / free ≥ $150 from `ShopSetting`; contiguous US; variant weight/dims | 2, 5, 7, 9, 17 |
| D3 / §3 | Guest checkout; find-or-create `Customer` by email; consent only false→true | 3, 7 |
| D4 / §3 | `?ref=`, 30 days, last click wins; partner and rate snapshotted at payment; unknown → `referralUnmatched` | 3, 7, 11 |
| D5 | `EmailPort` + no-op, called once on paid | 3, 7 |
| D6 / §7 | Queue with Mark shipped and Cancel; refunds in Stripe, synced by webhook | 7, 9, 15, 16 |
| D7 | Embedded Checkout on `/checkout` (`ui_mode: 'embedded_page'`, the current name) | 5, 13 |
| D8 | Our own unticked opt-in checkbox on the cart | 12 |
| §2 | Retire public `POST`/`GET /api/v1/orders`; keep `placeOrder` | 6 |
| §3 schema | Customer, Order columns, AffiliatePartner, ReferralCode, StripeEvent, Variant physicals, ShopSetting seeded | 1 |
| §4.1 | Validation: 1–20 lines, qty 1–10, no duplicates, bad referral dropped | 6 |
| §4.2 | `previousOrderId`: expire session, cancel, then reserve | 6 |
| §4.3–4.5 | `placeOrder` in one tx; session outside tx; Stripe failure → cancel + 503; `201 { orderId, clientSecret }` | 6 |
| §4.7 | `GET /checkout/status`, no address or email | 6 |
| §4 contiguous US | Notice on session (`custom_text`) and cart; webhook backstop `outside_shipping_area` | 5, 7, 12 |
| §5 | Raw body before `express.json`; signature 400; `StripeEvent` in the same tx; the four events | 7 |
| §5 sweep | 5-minute timer in the web process; never Walmart | 8 |
| §6 cart | Drawer + `/cart`; steppers ≤ 10; remove; notes; opt-in; Checkout | 11, 12 |
| §6 errors | "Only N left" / "No longer available" per line; unavailable message | 12 |
| §6 `/checkout` | Provider + component; `previousOrderId` in `sessionStorage`; load error + Back to cart | 13 |
| §6 `/order/complete` | 1.5 s poll up to 20 s; paid / slow / expired copy; clear cart and `previousOrderId` | 13 |
| §6 referral | Root hook; storage failures swallowed; URL stripped | 11 |
| §6 links | Terms, Privacy, Refund, Shipping from footer and checkout | 12, 13 |
| §6 config | `VITE_STRIPE_PUBLISHABLE_KEY` `sync: false` | 10 |
| §7 | Tabs, rows, paging; detail (lines, address, money, refunded, referral, Stripe link, audit); ship; cancel; settings; variant fields | 9, 15, 16, 17 |
| §8 | Refuse to start on half config; storefront CORS without credentials; 20/min per IP | 5, 6, 10 |
| §9.1 | Researched; finding recorded in the header; option (b) implemented | header, 5, 7 |
| §9.2–9.5 | Held by Jack; listed in the runbook §0 and the final report | 10, 18 |
| §10 core | Validation, pricing, Stripe failure, `previousOrderId`, each event signed with `generateTestHeaderString`, duplicate + concurrent + out-of-order, mismatch, paid-after-cancel, refunds before/after shipment, sweep, last-unit race, retired 404 | 4, 6, 7, 8 |
| §10 UI | Cart, error mapping, polling states, referral capture, queue, ship and cancel dialogs | 11–13, 15–17 |
| §10 staging | Ten test-mode checks | 10 (runbook §6), 18 |
| §11 | Out of scope honoured: no accounts, promos, transactional email, carrier rates, console refunds, partner admin, international, Walmart changes | — |

No gaps found.

### Placeholder scan

Searched for "TBD", "TODO", "implement later", "fill in", "add validation", "handle edge cases", "similar to Task", "write tests for". There are no hits in instructions or code. The literal key-shaped strings are the documented `sk_test_unused_placeholder` / `sk_live_unused_placeholder` offline-client placeholders, plus `whsec_*_test` test secrets used only by the fake. No real key appears anywhere.

### Type and name consistency

Checked across tasks:
- `OrderError(code, message, details?)`
- `PENDING_CHECKOUT_EMAIL`
- `lockOrderRow` / `markOrderPaidTx` / `cancelOrderTx` / `refundOrderTx` → `{ order, releasedVariantIds }`
- `enqueueInventoryPushesAfterCommit`
- `PaymentsPort.{configured, livemode, createCheckoutSession, expireCheckoutSession → 'expired'|'complete', retrieveCheckoutSession, constructWebhookEvent}`
- `FakePaymentsPort.{sessions, failNextCreate, expired, setSession, sign}`
- `ShopSettings.{flatRateCents, freeThresholdCents, sessionMinutes}`
- `getCheckoutConfig → { flatRateCents, freeShippingThresholdCents }`. It is used by both core and the storefront client.
- `CheckoutStatusDto` / `CheckoutStatus` shapes are identical.
- `LineProblem` is identical in core and the storefront.
- `AppDeps` keys are used by `makeApp`.
- The test helper names are identical in Tasks 6–9.
- `AdminOrderDetail` fields are used by `OrderDetail.jsx`.
- The admin API method names in Tasks 15–17.

These fixes were made inline during the review:
- the status test's `metadataOrderId` reference;
- the double-rendered load-error test was split in two;
- `React.ReactNode` UMD usage was replaced with an imported `ReactNode`;
- the "Shipped" label collision;
- the webhook-unconfigured test's unused variable.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-27-revenue-loop-checkout.md`. Two execution options:

1. **Subagent-Driven (recommended)**: a fresh subagent per task, with a review between tasks (superpowers:subagent-driven-development).
2. **Inline Execution**: batch execution with checkpoints (superpowers:executing-plans).
