# Revenue loop — storefront checkout with Stripe (design)

**Date:** 2026-09-27 · **Status:** approved in conversation by Jack, awaiting spec review
**Sub-project 1 of 4** for "get the core site selling" (Jack, 2026-09-27). The
others — production environment, launch readiness (policy pages, scaffold
deletion, About page), and the Shopify cutover — each get their own spec.
Walmart integration is deferred until after launch; Walmart is operating
manually meanwhile.

Supersedes, for checkout, the Phase-1 "revenue loop" sketch in
`2026-07-08-imagibrick-platform-redesign-design.md` §6. Where they differ, this
spec wins: no customer accounts, Stripe Tax instead of a nexus rate table,
Embedded Checkout instead of a redirect, and stock is decremented at shipment
(the existing order lifecycle) rather than at payment.

## 1. Decisions (Jack, 2026-09-27)

| # | Decision |
|---|---|
| D1 | **Tax: Stripe Tax.** Stripe computes tax per ship-to address inside the Checkout Session. |
| D2 | **Shipping behind a `ShippingPort`.** Launch adapter is flat-rate: **$9.95 per order, free at or above $150** (placeholders, admin-configurable). **Contiguous US only** (48 states + DC). A carrier-rate provider may follow — Tim named one, not yet identified; variants gain optional weight/dimensions now. |
| D3 | **Guest checkout only**, with a marketing opt-in. Every paid order finds-or-creates a `Customer` by email. No login, no accounts. |
| D4 | **Referral attribution: capture + minimal registry.** `?ref=CODE`, 30-day window, last click wins. Hand-seeded `AffiliatePartner` + `ReferralCode`; the order snapshots partner and commission rate at sale; unknown codes are kept raw and flagged. |
| D5 | **Email: Stripe receipts now**; an `EmailPort` with a no-op adapter so transactional email (shipped/tracking) plugs in later. |
| D6 | **Admin: order queue with Mark shipped and Cancel.** Refunds are issued in the Stripe dashboard; a webhook keeps our records and stock in step. |
| D7 | **Stripe Embedded Checkout** (`ui_mode: 'embedded'`) on our own `/checkout` page. |
| D8 | **Marketing opt-in is our own checkbox** on the cart page, unticked by default. |

## 2. What exists and what changes

**Exists (core):** `placeOrder` / `markOrderPaid` / `fulfillOrder` /
`cancelOrder` in `src/orders/orders.service.ts`. Reservation happens at place
(`reserved += q`, guarded by `on_hand - reserved - COALESCE(walmart_allocation,0) >= q`);
`paid` keeps the reservation; `fulfilled` decrements `on_hand` and `reserved`;
`cancelled` releases. `TaxPort` with a flat MI 6% adapter. Statuses:
`pending | paid | fulfilled | cancelled | refunded`.

**Kept as-is:** the reservation and decrement semantics. "Shipped" in the UI is
the existing `fulfilled` status — no new status.

**Retired:** the public `POST /api/v1/orders` and `GET /api/v1/orders/:id`
routes. POST lets anyone reserve stock with no payment (a hold-everything
abuse vector) and GET would expose a customer's address to anyone holding an
order id. Checkout replaces POST; the admin API replaces GET. `placeOrder`
stays as the internal service the checkout calls.

**Exists (storefront):** `CartContext` (lines keyed by variant), product and
collection pages. No cart page, no checkout.

## 3. Components

### Core

| Module | Responsibility |
|---|---|
| `checkout/` | `POST /api/v1/checkout`, `GET /api/v1/checkout/status`. Validates the cart, creates the pending order (via `placeOrder`), opens the session, returns `clientSecret`. |
| `payments/` | `PaymentsPort` + Stripe adapter (`createCheckoutSession`, `expireCheckoutSession`, `retrieveCheckoutSession`); `POST /api/v1/webhooks/stripe` with signature verification and event de-duplication. |
| `shipping/` | `ShippingPort.quote({ subtotalCents, lines }) → ShippingOption[]`; `flatRateShippingAdapter` reads `ShopSetting`. |
| `customers/` | `upsertCustomerFromCheckout({ email, name, consent })`. |
| `referrals/` | `resolveReferral(code) → { partnerId, commissionRateBps } \| null`. |
| `email/` | `EmailPort` + `noopEmailAdapter`. Nothing calls it at launch beyond a single no-op on paid, so the seam is exercised. |
| `admin/orders` | Admin order queue, detail, `ship`, `cancel`. |

The tax port is not used for storefront orders: `placeOrder` gains a
`taxPort` argument already, and checkout passes a `deferredTaxAdapter` that
returns `{ taxCents: 0, rateBps: 0, jurisdiction: 'stripe_tax_pending' }`.
The webhook writes the real figures. The MI 6% adapter stays for tests and
any non-Stripe path.

### Schema (Prisma, one migration)

- **`Customer`** *(new)*: `id`, `email` (unique, stored lowercased/trimmed),
  `name?`, `marketingConsent` (bool, default false), `marketingConsentAt?`,
  `marketingConsentSource?` (the exact checkbox wording + `storefront_checkout`),
  `createdAt`, `lastOrderAt?`. Consent only ever goes false→true from checkout;
  an order without the box ticked never revokes an earlier opt-in.
- **`Order`** adds: `customerId?`; `shipName`, `shipLine1`, `shipLine2?`,
  `shipCity`, `shipPostalCode` (existing `shipToState` kept); `shippingCents`
  (default 0); `stripeCheckoutSessionId?` (unique); `stripePaymentIntentId?`;
  `paidAt?`, `shippedAt?`, `carrier?`, `trackingNumber?`; `refundedCents`
  (default 0); `reviewReason?` (`amount_mismatch` \| `paid_after_cancel` \|
`outside_shipping_area` \| `disputed`); `marketingOptIn` (bool, default
false — the checkbox as submitted, applied to the Customer at payment); referral
  snapshot `referralCode?`, `referralFirstSeenAt?`, `affiliatePartnerId?`,
  `commissionRateBps?`, `referralUnmatched` (default false).
  `email` stays required: the pending order uses a placeholder
  `pending@checkout.invalid` until the webhook writes the real address, since
  Stripe collects the email.
- **`AffiliatePartner`** *(new)*: `id`, `name`, `status` (`active`\|`inactive`), `createdAt`.
- **`ReferralCode`** *(new)*: `code` (PK, lowercased, `^[a-z0-9-]{2,32}$`),
  `partnerId`, `commissionRateBps`, `active`.
- **`StripeEvent`** *(new)*: `id` (Stripe event id, PK), `type`, `processedAt`.
- **`Variant`** adds optional `weightGrams`, `lengthMm`, `widthMm`, `heightMm`
  (editable in the admin Variants tab; unused until a carrier adapter exists).
- **`ShopSetting`** *(new, key/value)*: `shipping.flat_rate_cents` = 995,
  `shipping.free_threshold_cents` = 15000 (nullable = no free shipping),
  `checkout.session_minutes` = 30. Seeded by migration; editable in admin
  (a small Settings page).

## 4. Checkout flow

1. **`POST /api/v1/checkout`** (public, storefront CORS, no credentials, rate
   limited per IP) with
   `{ lines: [{variantId, quantity}], marketingOptIn: boolean, referral: {code, firstSeenAt} | null, previousOrderId?: string }`.
   Validation: 1–20 lines, integer quantity 1–10 per line, no duplicate
   variants, referral code matching the pattern (else dropped, not rejected).
2. **`previousOrderId`**: if it names a `pending` storefront order with a
   Stripe session, expire that session via Stripe and cancel the order
   (releasing stock) before reserving again. Anything else is ignored.
3. **`placeOrder`** in one transaction: live price snapshot, published +
   active check, reservation, `pending` order with `deferredTaxAdapter`,
   referral snapshot (`referralCode`, `referralFirstSeenAt`; partner fields
   resolved later), `marketingOptIn` on the order for the webhook.
4. **Create the Checkout Session** (outside the DB transaction):
   `ui_mode: 'embedded'`, `mode: 'payment'`, `automatic_tax: {enabled: true}`,
   `line_items` from the order's snapshot (`price_data`, product name, tax
   behaviour `exclusive`, Stripe's general tangible-goods tax code),
   `shipping_address_collection: {allowed_countries: ['US']}`,
   `shipping_options` from the `ShippingPort`, `payment_method_types`
   restricted to card (wallets ride on card), `expires_at` = now + 30 min,
   `client_reference_id` and `metadata.orderId` = order id,
   `return_url` = `<storefront>/order/complete?session_id={CHECKOUT_SESSION_ID}`.
   Save `stripeCheckoutSessionId`. If Stripe fails, cancel the order (release)
   and return 503 `checkout_unavailable`.
5. Respond `201 { orderId, clientSecret }`.
6. **Webhook `checkout.session.completed`** (see §5) marks the order paid.
7. **`GET /api/v1/checkout/status?session_id=`** returns
   `{ status: 'pending'|'paid'|'cancelled', orderNumber, lines, totals }` for
   the confirmation page — only non-sensitive fields; no address, no email.

**Contiguous-US enforcement.** `shipping_address_collection` restricts by
country only, and Stripe collects the address, so the storefront never sees it
before payment. The mechanism is settled in planning (§9, item 1). Whatever
the mechanism, the webhook is the backstop: a paid order whose state is AK, HI,
or a territory/military code (PR, GU, VI, AS, MP, AA, AE, AP) is marked
`reviewReason = 'outside_shipping_area'` and logged, and a human refunds it in
Stripe. The cart and the checkout's custom text both say "We ship to the
contiguous US only."

## 5. Webhooks

`POST /api/v1/webhooks/stripe`, mounted **before** the JSON body parser with a
raw-body parser (signature verification needs the exact bytes), and with no
CORS, auth, origin or content-type middleware. Verify with
`STRIPE_WEBHOOK_SECRET`; reject with 400 on a bad signature. Insert the event
id into `StripeEvent` in the same transaction as its effects; a unique
violation means "already processed" → 200.

| Event | Effect |
|---|---|
| `checkout.session.completed` (`payment_status = 'paid'`) | Load the order by `metadata.orderId`. If `pending`: verify `amount_total == subtotal + shipping_cost.amount_total + total_details.amount_tax`; write `taxCents`, `shippingCents`, `totalCents`, `taxJurisdiction = 'stripe_tax'`, `taxRateBps` (effective, rounded), address, real email, `stripePaymentIntentId`, `paidAt`; `markOrderPaid`; `upsertCustomerFromCheckout`; resolve the referral (set partner + rate, or `referralUnmatched = true`); `EmailPort.orderPaid` (no-op). On amount mismatch still mark paid (money was taken) and set `reviewReason = 'amount_mismatch'` + `console.error`. If the order is `cancelled` (the sweep or an admin beat the webhook): mark `reviewReason = 'paid_after_cancel'`, `console.error` — a human refunds in Stripe. Any other status: log and ignore. |
| `checkout.session.expired` | If the order is still `pending`, `cancelOrder` (releases stock). Otherwise ignore. |
| `charge.refunded` | Find the order by `stripePaymentIntentId`; set `refundedCents = charge.amount_refunded`. If fully refunded: status `refunded`; if it was `paid` (not yet shipped) release the reservation; if `fulfilled`, no stock change. Partial refund: amount only, status unchanged. |
| `charge.dispute.created` | Set `reviewReason = 'disputed'`, `console.error`. |

**Sweep.** A timer in the web process (every 5 min) cancels `pending`
storefront orders older than session lifetime + 10 min whose session Stripe
reports as `expired` or `complete`-but-unpaid — the backstop for a missed
`expired` webhook. It never touches Walmart orders.

## 6. Storefront

- **Cart:** a drawer (from the header) and a `/cart` page. Quantity steppers
  capped at 10; per-line remove; subtotal; the note "Shipping and tax
  calculated at checkout"; "Free shipping on orders over $150" when under the
  threshold; the opt-in checkbox *"Email me about new sets and restocks"*
  (unticked); the **Checkout** button.
- **Checkout errors from core:** `insufficient_stock` / `variant_not_found`
  mark the affected lines in the cart with "Only N left" / "No longer
  available" and keep the rest; `checkout_unavailable` shows "Checkout is
  temporarily unavailable — please try again in a minute."
- **`/checkout`:** `EmbeddedCheckoutProvider` + `EmbeddedCheckout` with the
  `clientSecret` from step 5. The pending order id goes to `sessionStorage` as
  `previousOrderId` for the next attempt. On a load error: message + "Back to
  cart".
- **`/order/complete`:** polls `/checkout/status` every 1.5 s up to 20 s.
  Paid → "Order <number> confirmed" (the existing `orderNumber` format), lines, subtotal/shipping/tax/total,
  "Your receipt is on its way from Stripe"; clears the cart and
  `previousOrderId`. Still pending at 20 s → "Payment received — we're
  confirming your order. Your Stripe receipt is your confirmation." Cancelled
  → "This checkout expired" + back to cart.
- **Referral capture:** a root hook reads `?ref=` on any page; if it matches
  the pattern, stores `{code, firstSeenAt}` in `localStorage` with a 30-day
  expiry, overwriting any earlier code (last click wins), then strips `ref`
  from the URL. Storage failures are swallowed.
- **Footer/checkout links** to Terms, Privacy, Refund and Shipping pages
  (placeholders until sub-project 3).
- Config: `VITE_STRIPE_PUBLISHABLE_KEY` (per environment, `sync: false`).

## 7. Admin console

- **Orders** in the nav. Queue tabs: **To ship** (`paid`), **Shipped**
  (`fulfilled`), **Pending**, **Closed** (`cancelled`, `refunded`), **Needs
  review** (`reviewReason` set). Rows: number, date, customer email, item
  count, total, ship-to state. Paged, newest first.
- **Order detail:** lines, address, subtotal/shipping/tax/total, refunded
  amount, referral (code, partner, rate, or "unmatched"), payment link
  (`https://dashboard.stripe.com/payments/<pi>`), audit trail.
- **Mark shipped** (`paid` only): carrier (USPS, UPS, FedEx, Other) + tracking
  number (required unless Other) → `fulfillOrder` with `shippedAt`, carrier,
  tracking; audited.
- **Cancel** (`pending` only): expires the Stripe session, then `cancelOrder`.
  Paid orders are refunded in Stripe, not cancelled here.
- **Settings:** flat rate and free-shipping threshold.
- **Variants tab:** the four optional weight/dimension fields.

## 8. Configuration and security

- `core-env`: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (secrets, pasted by
  Jack; already listed in `render.yaml`). Core refuses to start if one is set
  without the other.
- Storefront: `VITE_STRIPE_PUBLISHABLE_KEY`.
- Staging uses Stripe **test mode**; the staging webhook endpoint subscribes to
  the four events in §5.
- `/api/v1/checkout` gets storefront CORS (credentials off) and a per-IP rate
  limit (e.g. 20/min) so it cannot be used to lock up stock.
- Nothing card-related touches our servers.

## 9. Open questions (must be settled before or during planning)

1. **Enforcing contiguous US.** Stripe Checkout restricts shipping addresses by
   country only; it cannot exclude AK/HI/territories. Options: (a) accept the
   order and refund in Stripe (poor), (b) flag and let a human refund, (c) use
   Checkout's **custom-field / address-restriction** capabilities if the
   current API supports a state allowlist, (d) collect the address on our own
   page before Checkout and pass it in. **Planning must check the current
   Stripe API first**; if no native restriction exists, the recommendation is
   (b) — the webhook backstop in §4 — revisited if it happens in practice.
2. **Stripe account** — who owns it and under which email. Needed before
   staging keys exist.
3. **Stripe Tax registrations** — at minimum Michigan must be registered in
   Stripe Tax before launch; partner sign-off on tax obligations.
4. **Tim's shipping provider** — name and whether he wants live rates at
   checkout or label buying for fulfilment.
5. **Tax code** — general tangible goods at launch; revisit if an accountant
   names a toys/collectibles code.

## 10. Testing

- **Core** (vitest + supertest against the test DB): checkout validation and
  pricing; reservation and release on Stripe failure; `previousOrderId`
  release; each webhook event with Stripe-signed test payloads
  (`stripe.webhooks.generateTestHeaderString`); duplicate and out-of-order
  delivery; amount mismatch; paid-after-cancel; full vs partial refund before
  and after shipment; the sweep; two concurrent checkouts for the last unit
  (exactly one reserves); retired routes return 404. The `PaymentsPort` is
  faked in unit tests.
- **Storefront / admin:** component tests for cart, checkout error mapping,
  confirmation polling states, referral capture (expiry, last click wins,
  invalid codes), order queue, ship and cancel dialogs.
- **Staging end to end (Stripe test mode):** a Michigan address with tax; an
  order over $150 with free shipping; an abandoned checkout releasing stock
  after expiry; a full refund before shipment and a refund after shipment; a
  dispute (Stripe test card); a referral-linked order resolving to a seeded
  partner and one with an unknown code; an AK address (behaviour per §9.1).

## 11. Out of scope

Customer accounts and order lookup; promo codes/discounts (the `discountCents`
columns stay 0); transactional email; carrier rates and label buying; refunds
issued from the console; partner management, commission engine and payouts;
international shipping; Walmart changes.
