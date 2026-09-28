# Square payments — replace Stripe in storefront checkout (design)

**Date:** 2026-09-28 · **Status:** approved in conversation by Jack; awaiting spec review
**Supersedes** the payment and tax parts of
`2026-09-27-revenue-loop-checkout-design.md` (D1 Stripe Tax, D5 Stripe
receipts, D7 Stripe Embedded Checkout, §4–§5 Stripe session and webhooks, §8
Stripe config). Everything else in that spec stands and is already merged
(PRs #40, #41, #42): cart, reservation and order lifecycle, row locks,
`onlyIfPending` cancels, monotonic refunds, sweep, referrals, customers and
consent, shipping port, admin queue, ship and cancel.

Research: `.superpowers/sdd/square-research-findings.md` (git-ignored; its
citations are summarised where used below).

## 1. Decisions (Jack, 2026-09-28)

| # | Decision |
|---|---|
| Q1 | **Square for all payments**, online and in person at the LEGO events, where the business already uses Square with readers. The partner prefers Square. Stripe is removed. |
| Q2 | **Affiliates and designers are paid directly** by the business. No Stripe Connect, and no marketplace payouts in the platform. Commission and royalty *accrual* stays in scope for later plans; *payout* is manual. |
| Q3 | **Sales tax: Michigan only for now.** 6% on Michigan ship-to addresses, $0 elsewhere, via the existing `createFlatRateTaxPort`. Square computes no destination tax for API payments (see §9). A tax service may replace it later behind the same port. **The partner must sign off on nexus.** |
| Q4 | **Event stock is set aside (option B).** Before an event, the operator lowers the website's on-hand for the sets taken, using the existing stock dialog. After the event, unsold units are added back. **No Square inventory integration.** |
| Q5 | **Payments only, no Square Orders.** Core stays the order system of record. Square only takes the card payment for our total. Web sales appear in Square as payment amounts without line items. |
| Q6 | **Square Web Payments SDK** on our own `/checkout` page, with the address collected first. |
| Q7 | **A separate Square location "Online"** for web payments, so web and event sales report apart and web payments never show on event readers. *Recommended; confirm at setup.* |
| Q8 | **Michigan tax applies to goods only, not shipping,** until the partner or an accountant says otherwise. |

## 2. Checkout flow

1. **Cart → `POST /api/v1/checkout`.** Unchanged: live re-pricing, reservation, and a `pending` order. The response drops `clientSecret` and returns `{ orderId }`. `previousOrderId` release now cancels our own pending order (`onlyIfPending`). There is no provider session to expire.
2. **Address step (`/checkout`).** The shopper enters email, name and shipping address. Validation:
   - US only, and the 48 contiguous states + DC.
   - AK, HI, PR, GU, VI, AS, MP, AA, AE and AP are rejected **before any charge** with "We ship to the contiguous US only."
3. **`POST /api/v1/checkout/:orderId/quote { email, name, address }`.** Public, and rate limited like checkout. Core then:
   - locks the order and requires `pending`;
   - validates the address;
   - writes the address, email and name to the order;
   - quotes `ShippingPort` and `TaxPort` (tax on line items only, per Q8);
   - stores `shippingCents`, `taxCents`, `taxRateBps`, `taxJurisdiction` (`MI` or `none`) and `totalCents`, plus a `quoteVersion` that increments on every quote;
   - returns `{ quoteVersion, subtotalCents, shippingCents, taxCents, totalCents }`.
4. **Card step.** Square's card form (Web Payments SDK; Apple Pay and Google Pay use the same flow) is shown with the quoted total. `card.tokenize(verificationDetails)` returns a one-time `sourceToken`, with bank verification handled inside `tokenize`.
5. **`POST /api/v1/checkout/:orderId/pay { sourceToken, quoteVersion }`.** Core:
   1. Locks the order and requires `pending`, a stored quote, and a matching `quoteVersion` (otherwise 409 `quote_changed`, and the page re-quotes).
   2. Sets `paymentAttemptAt = now` and commits.
   3. Calls `payments.charge({ sourceToken, amountCents: totalCents, idempotencyKey, referenceId: orderId, buyerEmail, shippingAddress, locationId })`, where `idempotencyKey = <orderId>:<quoteVersion>:<attemptCount>` (≤ 45 characters). A retried HTTP request reuses the key; a new attempt after a decline increments `attemptCount`.
   4. On `COMPLETED`: `markOrderPaidTx` in a locked transaction, storing `squarePaymentId` and `paidAt`; upsert the Customer and apply consent; resolve the referral; call `EmailPort.orderPaid`. Returns `{ status: 'paid', orderNumber, lines, totals }`.
   5. On decline or failure: returns 402 `payment_declined` with Square's buyer-safe message. The order stays `pending`, and the shopper can re-enter a card.
   6. On a non-final status (`APPROVED` or `PENDING`, not expected for cards): returns `{ status: 'processing' }`. The webhook finishes it.
6. **Confirmation.** `/checkout` shows "Order <number> confirmed" directly from the pay response and clears the cart and `previousOrderId`. `/order/complete?order=<id>` stays for reloads and the processing state, polling `GET /api/v1/checkout/status?orderId=` (no address or email returned).
7. **Sweep.** Every 5 minutes it cancels (`onlyIfPending`) pending storefront orders older than `checkout.session_minutes` (30) whose `paymentAttemptAt` is null or older than 10 minutes. It makes no Square call.

**Race rule.** Step 5.1 and the sweep both lock the order row. A sweep that wins first leaves `pay` answering 409 `order_expired` before any charge. `pay` stamps `paymentAttemptAt` before charging, so a sweep that runs during the charge skips the order. **No paid-after-cancel case can arise from our own code.** A webhook reporting a payment for a cancelled order, which shouldn't happen, sets `reviewReason = 'paid_after_cancel'` as today.

## 3. Webhooks

`POST /api/v1/webhooks/square` is mounted with a raw body before `express.json`, with no CORS, auth or origin middleware.

- **Verification.** HMAC-SHA256, base64, of `SQUARE_WEBHOOK_NOTIFICATION_URL + rawBody` using `SQUARE_WEBHOOK_SIGNATURE_KEY`, compared in constant time against `x-square-hmacsha256-signature`. The URL comes from config, never from request headers. A bad signature returns 400.
- **De-duplication.** `PaymentEvent(provider='square', eventId)` is inserted in the same transaction as the event's effects. A duplicate returns 200.
- **Ordering.** Square doesn't guarantee delivery order. Every handler is written so events can arrive in any order and be repeated safely.

| Event | Effect |
|---|---|
| `payment.updated` with `status = COMPLETED` | Find the order by `reference_id` or `squarePaymentId`. If `pending`, mark it paid as step 5.4 does. This covers a crash after the charge. If `cancelled`, set `reviewReason = 'paid_after_cancel'` and log an error. Otherwise ignore. |
| `refund.created` / `refund.updated` | Find the order by `payment_id`. Recompute the total of the payment's `COMPLETED` refunds (retrieved from Square) and call `refundOrderTx` with that total (monotonic). A full refund of a `paid` order releases the reservation; a `fulfilled` order's stock is left alone. |
| `dispute.created` | Set `reviewReason = 'disputed'` and keep the prior reason in the audit `before`. |
| `dispute.state.updated` | Record the state in the audit log. `LOST` or `ACCEPTED` logs an error. The existing admin "cancel disputed order with acknowledgement" path still applies. |

Events that can never succeed (an `OrderError`) → 200 `ignored` + `console.error` (as T7-R1). An event for an order we can't find, less than 24 hours old → 503 so Square retries. Square retries for 24 hours; older events → 200 + `console.error` (as P15).

## 4. Components

**Core**
- `ports/payments`:
  - `PaymentsPort` becomes `{ configured, charge(), getPayment(), listPaymentRefunds(), verifyWebhook(rawBody, signature) }`.
  - `SquarePaymentsAdapter` uses `square@46.0.0`, pinned exactly (API version `2026-09-16`).
  - The fake is updated.
  - `createPaymentsPort(env)` refuses to start when the config is partial.
  - The Stripe adapter and the `stripe` package are removed.
- `ports/tax`: checkout uses `createFlatRateTaxPort()` (MI 600 bps). `deferredTaxAdapter` is removed.
- `checkout/`: the quote and pay routes and service, the status route reading by `orderId`, and the sweep change.
- `payments/`: the Square event handler and route replace the Stripe ones.
- **Schema (one migration):**
  - Rename `stripe_events` to `payment_events` and add `provider`, with a unique key on (`provider`, `event_id`).
  - Drop `orders.stripe_checkout_session_id` and `orders.stripe_payment_intent_id`.
  - Add `orders.square_payment_id` (unique, nullable), `payment_attempt_at`, `payment_attempt_count` (default 0) and `quote_version` (default 0).
  - The migration is safe: staging has no paid Stripe orders because no keys were ever set. Any staging rows with pending Stripe ids are cancelled by the sweep before the migration, or the migration nulls the ids.
- Admin: `admin-orders` returns `payment: { provider: 'square', url }`. The Square Dashboard deep link format is to be confirmed in the sandbox; until then it is omitted. Error codes are renamed provider-neutrally: `STRIPE_UNAVAILABLE` becomes `PAYMENTS_UNAVAILABLE`, and `ORDER_PAID` loses the Stripe wording.

**Storefront**
- `/checkout`: address and email form, then the quote summary, then Square's card form (loaded through Square's script on `web.squarecdn.com` for sandbox or production), with Apple Pay and Google Pay buttons.
- Error copy:
  - decline → "Your card was declined — try another card.";
  - `quote_changed` → re-quote and show the new total;
  - `order_expired` → "This checkout expired" and a link back to the cart.
- `src/lib/stripe.ts` and the `@stripe/*` packages are removed.
- New settings: `VITE_SQUARE_APPLICATION_ID`, `VITE_SQUARE_LOCATION_ID` and `VITE_SQUARE_ENVIRONMENT`. Without them the cart refuses to start checkout, as now.

**Admin console**
- Renders `payment.url` when present and names no provider.
- Copy: "refund it in the payment dashboard".

**Config (`render.yaml`, `sync: false`)**
- Core: `SQUARE_ENVIRONMENT`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY` and `SQUARE_WEBHOOK_NOTIFICATION_URL`. `STOREFRONT_PUBLIC_URL` stays, for links.
- Storefront: the three `VITE_SQUARE_*` keys.
- All Stripe keys are removed.

**Docs**
- `projects/engineering/CLAUDE.md` locked decisions: Square replaces Stripe, and affiliates and designers are paid directly.
- The 09-27 spec gets a supersession note.
- A new runbook, `docs/status/…-square-sandbox-runbook.md`, replaces the Stripe runbook. It covers the sandbox app, the Online location, keys, the webhook subscription pinned to `2026-09-16` with the five event types, Apple Pay domain registration, and the order of steps (storefront keys first).

## 5. Error handling summary

| Case | Behaviour |
|---|---|
| Address outside the contiguous US | 422 `outside_shipping_area` at quote. No charge. |
| Quote stale at pay | 409 `quote_changed`. The page re-quotes. |
| Order no longer pending at pay | 409 `order_expired`. No charge. |
| Card declined | 402 `payment_declined` with Square's message. The order stays pending and the shopper can retry. |
| Square unavailable | 503 `checkout_unavailable`. The order stays pending and the sweep releases it. |
| Crash after charge | The `payment.updated` webhook marks it paid. The idempotency key prevents a second charge on retry. |
| Refund in the Square Dashboard | The refund webhooks recompute the refunded total, and stock is released if the order hasn't shipped. |
| Dispute | Flagged for review. Admin cancel with acknowledgement releases stock. |

## 6. Testing

- **Core:** quote validation, including AK and HI refused and the MI tax figure; the pay paths (success, decline, stale quote, expired order, idempotent retry, crash recovery via webhook); the sweep skipping an order during a payment attempt; the webhook signature over the configured URL; duplicate and out-of-order events; refund totals; disputes; the migration on a DB with existing rows.
- **Storefront and admin:** component tests with the Square SDK faked; no provider names in the console.
- **Staging, Square sandbox (runbook):**
  1. A Michigan order with tax.
  2. An order of $150 or more with free shipping.
  3. A declined card (`4000000000000002`), then a retry.
  4. A refund from the sandbox Dashboard reaching our webhook.
  5. A dispute or risk test value.
  6. A referral order.
  7. An AK address refused at quote.
  8. Confirm whether Square emails a receipt for API payments (§9).

## 7. Out of scope

- Square inventory sync (Q4).
- Square Orders (Q5).
- Affiliate and designer payouts (Q2).
- A tax service (Q3).
- Cash App Pay, Afterpay and ACH.
- Walmart changes.
- Production cutover.

## 8. Production gates (unchanged from the checkout work, plus Square)

- Per-visitor cap on outstanding pending holds (F-R2).
- Alerting on review conditions.
- Square production keys and an Apple Pay domain on `www`.
- Partner sign-off on nexus (Q3) and on shipping taxability (Q8).

## 9. Open items to settle during the build

1. **Receipts.** It is undocumented whether `buyer_email_address` on an API payment makes Square email a receipt. If it doesn't, the D5 replacement needs `EmailPort` with a provider, which is Jack's choice.
2. Dashboard refunds emitting `refund.*` events to our subscription (sandbox proof).
3. The Square Dashboard payment deep-link format.
4. Confirm with Square developer support that no API computes destination tax today. The evidence so far is staff forum posts from 2024.
5. Whether the business already has a separate Online location, or creates one (Q7).
