# Square Payments — Replace Stripe in Storefront Checkout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Storefront checkout takes card, Apple Pay and Google Pay payments through Square instead of Stripe. The shopper enters an address first. Core quotes shipping and Michigan-only tax, then charges the quoted total through the Square Payments API. Square webhooks keep payments, refunds and disputes in step. Every trace of Stripe is removed from code, config and copy.

**Architecture:** `POST /api/v1/checkout` still reserves stock and creates a `pending` order, but returns only `{ orderId }`. The new `POST /checkout/:orderId/quote` writes the address and stores a versioned quote from `ShippingPort` and the flat-rate `TaxPort` (goods only). The new `POST /checkout/:orderId/pay` locks the order, checks the quote version, stamps `paymentAttemptAt` and commits. It then calls `PaymentsPort.charge()` (Square `CreatePayment`, with no Square Order) using an idempotency key of `orderId:quoteVersion:attemptCount`, and marks the order paid on `COMPLETED`. A raw-body `POST /api/v1/webhooks/square` verifies an HMAC over the configured notification URL plus the body. It de-duplicates on `payment_events(provider, event_id)` and handles `payment.updated`, `refund.*` and `dispute.*`. The sweep no longer calls the provider; it skips orders with a payment attempt in the last 10 minutes. The storefront `/checkout` becomes address → quote → Square card form and wallets → confirmation.

**Tech Stack:** Node 20, TypeScript, Express 4, Prisma 5 on Postgres 16, **`square@46.0.0`** (pinned, API `2026-09-16`), Vitest + Supertest (core). React 18, react-router 7, Vite 6, the Square Web Payments SDK script, **`@square/web-payments-sdk-types@1.84.5`** (types only, pinned), Vitest + Testing Library (storefront). React 18, react-router-dom 6, Vite 5, Vitest + Testing Library (admin-ui).

**Spec:** `docs/superpowers/specs/2026-09-28-square-payments-design.md` is binding. Read it in full before starting. It supersedes the payment and tax parts of `docs/superpowers/specs/2026-09-27-revenue-loop-checkout-design.md`; everything else in that spec is already merged and stands. The research, with citations, is in `.superpowers/sdd/square-research-findings.md` (git-ignored). Section references (§) below point into the 09-28 spec unless marked otherwise.

### Square facts verified for this plan (2026-09-28)

These were checked against the published packages (installed into a scratch directory and their `.d.ts` read) and against current Square documentation. Do not "correct" them from memory. The Node SDK was rewritten at v40, and most examples online show the legacy `Client`/`paymentsApi` shape, which **does not exist** in v46.

| Fact | Value | Source |
|---|---|---|
| Server SDK | `square@46.0.0` is npm `latest` (modified 2026-09-15). CommonJS with an `exports` map; named ESM imports work from Node: `import { SquareClient, SquareEnvironment, SquareError, SquareTimeoutError, WebhooksHelper } from 'square'` (checked by running them). | npm; `node_modules/square/index.d.ts` |
| Client | `new SquareClient({ token, environment: SquareEnvironment.Sandbox \| SquareEnvironment.Production, version: '2026-09-16', timeoutInSeconds, maxRetries })`. `version` is typed as the literal `"2026-09-16"`, so the pin is compile-checked. This settles research unverified item 9. `SquareEnvironment.Sandbox` = `https://connect.squareupsandbox.com`. | `BaseClient.d.ts`, `environments.d.ts` |
| Retries | The SDK retries 408, 429 and 5xx (default `maxRetries` 2) with the same request, and therefore the same idempotency key. | `core/fetcher/requestWithRetries.js` |
| Create payment | `client.payments.create({ sourceId, idempotencyKey, amountMoney: { amount: bigint, currency: 'USD' }, autocomplete, locationId, referenceId, buyerEmailAddress, shippingAddress })` returns `{ payment?: Payment, errors? }`. **`Money.amount` is a `bigint`.** | `api/resources/payments/client/requests/CreatePaymentRequest.d.ts`, `api/types/Money.d.ts` |
| Get payment | `client.payments.get({ paymentId })` returns `{ payment }`. `Payment.refundIds?: string[]`, `status?: string`, `referenceId`, `locationId`, `amountMoney`. | `api/resources/payments/client/Client.d.ts`, `api/types/Payment.d.ts` |
| Refunds | There is **no** "list refunds for a payment" call. `client.refunds.list` filters by location and time only. The adapter reads `payment.refundIds` and calls `client.refunds.get({ refundId })` for each (at most 20 per payment). `PaymentRefund.status` is `PENDING` / `COMPLETED` / `REJECTED` / `FAILED`. | `api/resources/refunds/client/Client.d.ts`; https://developer.squareup.com/docs/payments-api/refund-payments |
| Errors | A non-2xx response throws `SquareError { statusCode, errors: { category, code, detail?, field? }[], body }`. **`SquareError.message` embeds the whole response body**, which can include the buyer's email and address, so it must never be logged. Decline codes include `GENERIC_DECLINE`, `CVV_FAILURE`, `ADDRESS_VERIFICATION_FAILURE`, `INSUFFICIENT_FUNDS`, `CARD_DECLINED_VERIFICATION_REQUIRED` (category `PAYMENT_METHOD_ERROR`). Token codes are `CARD_TOKEN_EXPIRED`, `CARD_TOKEN_USED`, `SOURCE_USED` and `SOURCE_EXPIRED`. Idempotency conflicts return `IDEMPOTENCY_KEY_REUSED`. | `errors/SquareError.js`, `api/types/ErrorCode.d.ts` |
| Webhook helper | `WebhooksHelper.verifySignature({ requestBody: string, signatureHeader, signatureKey, notificationUrl }): Promise<boolean>`. It HMAC-SHA256s `notificationUrl + requestBody`, base64-encodes the result and compares it with **`===`, which is not constant-time.** Square's docs say that if you validate yourself you should use a constant-time comparison. So core computes the same HMAC itself and compares with `crypto.timingSafeEqual`. A test proves parity with `WebhooksHelper`. | `wrapper/WebhooksHelper.js`; https://developer.squareup.com/docs/webhooks/step3validate |
| Webhook header | `x-square-hmacsha256-signature`. The HMAC is keyed with the subscription's signature key, over the notification URL followed by the raw body. | https://developer.squareup.com/docs/webhooks/step3validate |
| Webhook payloads | The envelope is `{ merchant_id, type, event_id, created_at, data: { type, id, object: { <type>: {...} } } }`, in raw snake_case. `refund.*`: `data.object.refund.{ id, status, amount_money.amount (number), payment_id, location_id }`. `dispute.*`: `data.object.dispute.{ id, state, disputed_payment.payment_id, location_id }`. | https://developer.squareup.com/reference/square/refunds-api/webhooks/refund.updated, https://developer.squareup.com/reference/square/disputes-api/webhooks/dispute.created |
| Web Payments SDK script | Sandbox `https://sandbox.web.squarecdn.com/v1/square.js`. Production `https://web.squarecdn.com/v1/square.js`. It must be loaded from Square's CDN. | https://developer.squareup.com/docs/web-payments/quickstart/add-sdk-to-web-client, https://developer.squareup.com/docs/web-payments/apple-pay |
| Web Payments API | `window.Square.payments(appId, locationId): Payments`. `await payments.card(): Card`. `await card.attach(selectorOrElement)`. `card.tokenize(verificationDetails?) → TokenResult` (`{ status: 'OK', token } \| { status: 'Error' \| 'Invalid', errors } \| { status: 'Unknown' \| 'Abort' \| 'Cancel' }`). `ChargeCardVerificationDetails = { amount: string, currencyCode, intent: 'CHARGE', billingContact, customerInitiated, sellerKeyedIn }`. `verifyBuyer()` is being deprecated; verification runs inside `tokenize`. | `@square/web-payments-sdk-types@1.84.5` (`types/payments.d.ts`, `payment-method/cards/*.d.ts`); https://developer.squareup.com/docs/web-payments/take-card-payment |
| Wallets | `payments.paymentRequest({ countryCode: 'US', currencyCode: 'USD', total: { amount: '116.53', label } })`. `await payments.applePay(req)` has **no `attach`**: we render our own button and call `applePay.tokenize()` synchronously inside its click handler, with nothing awaited first. `await payments.googlePay(req)` then `await googlePay.attach(el)`; clicking the element calls `googlePay.tokenize()`. Both throw when unavailable on the device. `paymentRequest.update({ total })` changes the amount after a re-quote. | `types/payment-request.d.ts`, `payment-method/apple-pay/method.d.ts`, `payment-method/google-pay/method.d.ts`; https://developer.squareup.com/docs/web-payments/apple-pay, https://developer.squareup.com/docs/web-payments/google-pay |
| Apple Pay | The domain must be registered in the Developer Console, with the file served at `/.well-known/apple-developer-merchantid-domain-association` over HTTPS (not localhost). The sandbox rejects test cards for Apple Pay; use a real Wallet card, which is not charged. | https://developer.squareup.com/docs/web-payments/apple-pay |
| Types package | `@square/web-payments-sdk-types@1.84.5` is npm `latest` (2026-09-08). It augments `Window` with `Square?: Square` once imported. **It declares `typescript@5.1.6` as a runtime dependency**, so npm installs a nested copy. That is harmless: the build uses the storefront's own TypeScript. | npm; its `package.json` |
| Sandbox values | Card `4111 1111 1111 1111` (CVV 111, any future expiry, a valid ZIP). Decline card `4000 0000 0000 0002`. A payment of exactly **8801¢ ($88.01)** creates a dispute (`AMOUNT_DIFFERS`, state `EVIDENCE_REQUIRED`), and sandbox dispute webhooks fire. | https://developer.squareup.com/docs/devtools/sandbox/payments, https://developer.squareup.com/docs/disputes-api/sandbox-testing |

## Global Constraints

- **Spec decisions, verbatim (§1):** Square for all payments; Stripe removed (Q1). Affiliates and designers are paid directly, so there is no Stripe Connect (Q2). Sales tax is **Michigan only**: "6% on Michigan ship-to addresses, $0 elsewhere, via the existing `createFlatRateTaxPort`" (Q3). No Square inventory integration (Q4). **Payments only, no Square Orders** (Q5). Square Web Payments SDK on our own `/checkout`, "with the address collected first" (Q6). A separate Square location "Online" (Q7). "Michigan tax applies to goods only, not shipping" (Q8).
- **Core tests use the project's own DB config. Do NOT set `DATABASE_URL`.** The `alpinebrick-core-db` container on :5433 must be running (`docker start alpinebrick-core-db`). If Docker cannot be brought up, push the branch and read `gh pr checks`; CI is then the verifier. Say so in every report, and never claim a test passed that you did not see pass.
- **Never read or print `.env`, `.env.example` or `secrets/`.** No Square credential (sandbox or production) appears in code, tests, docs or commits. Tests use the fake payments port or a stubbed `SquareApi`. The only credential-shaped strings allowed are the literals `sq-access-token-unused-placeholder`, `fake-square-signature-key`, `adapter-test-signature-key` and `selection-test-signature-key`, and they are not credentials.
- **Branching:** one branch per PR, never pushed without Jack's OK. `feat/square-payments-core` (Tasks 0–8) is cut from `main` after the spec/plan branch `docs/square-payments-spec` merges. `feat/square-payments-storefront` (Tasks 9–13) and `feat/square-payments-console` (Tasks 14–15) are each cut from `main` after the core PR merges.
- **Commits:** conventional, with the subject naming the system (`feat(core):`, `feat(storefront):`, `feat(admin-ui):`, `docs(...)`, `test(core):`, `chore(...)`). Every commit message ends with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Every commit block below passes it as a second `-m`, which makes it the last paragraph.
- **Money:** integer cents everywhere in our code. Square's `Money.amount` is a `bigint` in the SDK and a JSON number in webhooks; convert only at the adapter and webhook boundary (`Number(bigint)`, `BigInt(cents)`).
- **Audit:** every order transition writes its `AuditLog` row through `recordAudit(..., tx)` in the same transaction as the change. A quote is not a transition and is not audited.
- **Stock semantics are unchanged:** reserve at place, `paid` keeps the reservation, `fulfilled` decrements `on_hand` and `reserved`, `cancelled` releases, and a full refund of a `paid` order releases. The invariant `reserved + COALESCE(walmart_allocation, 0) <= on_hand` holds after every statement.
- **Public checkout error envelope** `{ code, message, details? }`, lower_snake codes: `invalid_request` 400, `not_found` 404, `insufficient_stock` 409, `variant_not_found` 409, `quote_changed` 409, `order_expired` 409, `payment_pending` 409, `payment_declined` 402, `outside_shipping_area` 422, `rate_limited` 429, `too_many_attempts` 429, `checkout_unavailable` 503. The admin routes keep UPPER_SNAKE `{ code, message, fields?, details? }`.
- **Copy (verbatim from the spec, or kept from 09-27):** "We ship to the contiguous US only." · "Your card was declined — try another card." · "This checkout expired" · "Checkout is temporarily unavailable — please try again in a minute." · "Order <number> confirmed" · "refund it in the payment dashboard" (console). **No provider name appears in storefront or console copy.**
- **Contiguous US (§2 step 2):** the 48 contiguous states + DC. `AK, HI, PR, GU, VI, AS, MP, AA, AE, AP` and any non-US country → 422 `outside_shipping_area` at quote, before any charge.
- **Idempotency key (§2 step 5.3):** `` `${orderId}:${quoteVersion}:${paymentAttemptCount}` ``, at most 45 characters (a cuid is 25). `referenceId` is the order id, at most 40.
- **Timings:** sweep every 5 minutes; cancels pending storefront orders older than `checkout.session_minutes` (30) whose `paymentAttemptAt` is null or older than **10 minutes** (`PAYMENT_ATTEMPT_GRACE_MS`). Webhook retry window 24 hours (Square retries for 24 hours).
- **Env keys:** core `SQUARE_ENVIRONMENT` (`sandbox` | `production`), `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_WEBHOOK_NOTIFICATION_URL`. All five or none: partial config refuses to start, naming the missing keys. `STOREFRONT_PUBLIC_URL` stays declared, for links, and checkout no longer needs it. Storefront: `VITE_SQUARE_APPLICATION_ID`, `VITE_SQUARE_LOCATION_ID`, `VITE_SQUARE_ENVIRONMENT`; without all three the cart refuses to start checkout. Every `STRIPE_*` / `VITE_STRIPE_*` key is removed.
- **Before merging any PR:** that package's full `npx vitest run` and `npm run build`. For core, also boot the compiled server (`node dist/server.js`) and `curl /health`. A green suite does not prove the app starts.
- **Mid-PR red suites (PR 1).** This is a replacement, so the Task 1 migration drops columns that code not yet rewritten still reads. Between tasks, **run only the test files each task names**, and expect these files to fail until their rewrite lands:

  | File | Red after | Green again after |
  |---|---|---|
  | `tests/checkout-routes.test.ts` | Task 1 | Task 3 |
  | `tests/checkout-sweep.test.ts` | Task 1 | Task 5 |
  | `tests/admin-orders.test.ts` | Task 1 | Task 7 |
  | `npm run typecheck` | Task 1 | Task 7 |

  Task 8 requires the whole suite, the typecheck and the build to be green. No other file may go red. If one does, stop and report.

### Decisions this plan makes where the spec is silent or loose (flagged for Jack)

1. **Constant-time signature check, done ourselves.** `WebhooksHelper.verifySignature` in `square@46.0.0` compares with `===`. Core computes the same HMAC with `node:crypto` and uses `timingSafeEqual`, over the raw bytes (no UTF-8 round trip). A test pins parity with Square's helper.
2. **Webhooks for other locations are ignored.** The subscription is per application, so event readers' POS payments, refunds and disputes arrive at our endpoint too. Without this filter, each POS payment would be answered 503 and retried for 24 hours. Events whose `location_id` is not `SQUARE_LOCATION_ID` get 200 `ignored` and are not recorded.
3. **When a retried HTTP request reuses the key, and when a new attempt gets one (§2 step 5.3).** `paymentAttemptCount` increments only on a definite decline. An unknown outcome (timeout, 5xx, network) returns 503 and leaves the count alone. The storefront's **Try again** re-sends the **same token**, so Square replays the first result. A **new** token under the same key gets Square's `IDEMPOTENCY_KEY_REUSED`; core answers 409 `payment_pending`, and the storefront moves to `/order/complete?order=` to poll. The webhook resolves a charge that did land. If it never lands, the sweep releases the order 10 minutes after the attempt. **This never double-charges.** The cost is that a shopper whose earlier attempt was silently declined must restart from the cart. See "Spec issues" in the task report.
4. **Replays of a paid order.** `pay` on an order that is already `paid` at the same `quoteVersion` returns the paid confirmation from the database without charging, so a lost 200 response is recoverable.
5. **Amount check on every paid path.** If Square's completed amount differs from `order.totalCents`, the order is still marked paid, with the existing `reviewReason = 'amount_mismatch'`. A re-quote racing an in-flight charge is the only way to get there.
6. **Card-testing guard:** `pay` shares the checkout rate limiter (20 per minute per IP across start, quote and pay), and an order stops accepting attempts after **10 declines** (429 `too_many_attempts`).
7. **Payment attempts block other cancels too.** The `previousOrderId` release and the admin Cancel both skip or refuse (409 `PAYMENT_IN_PROGRESS`) a pending order with a payment attempt in the last 10 minutes. This extends the spec's race rule, "No paid-after-cancel case can arise from our own code", to those two paths.
8. **Decline messages are ours, not Square's `detail`.** Square's `detail` strings are developer text (for example "Authorization error: 'GENERIC_DECLINE'"). Core maps codes to buyer-safe copy, and the default is the spec's "Your card was declined — try another card."
9. **Placement-time tax jurisdiction is `quote_pending`** (it replaces `stripe_tax_pending`, and `deferred.adapter.ts` is deleted). The console already shows any `*_pending` jurisdiction as "pending".
10. **Admin `payment` also carries the Square payment `id`** (`{ provider: 'square', id, url: null }`), so the operator can search the Square Dashboard until the deep-link format is confirmed (§9.3). The console shows it as "Payment ID", without naming the provider.
11. **`PAYMENTS_UNAVAILABLE` is not added.** The admin API no longer calls the provider at all (cancel no longer expires a session), so nothing would ever raise it. `STRIPE_UNAVAILABLE` is deleted, and `PAYMENT_IN_PROGRESS` (409) is added for decision 7.
12. **Storefront confirmation copy** drops "Your receipt is on its way from Stripe". It says "Keep your order number for your reference." until §9.1 (receipts) is settled.
13. **The migration refuses to run** if any order carries a Stripe payment-intent id, rather than silently dropping a record of money taken. Pending orders with Stripe session ids simply lose the id, and the new sweep releases them.
14. **Migration-on-existing-rows (§6) is proved by a scripted run in Task 1**, recorded in the task report, not by a CI test. A CI test would need a second, older schema.

---

## File Structure

**Core (`systems/core`)**

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` | `StripeEvent` → `PaymentEvent(provider, eventId)`; `Order` drops the two `stripe*` fields and gains `squarePaymentId`, `paymentAttemptAt`, `paymentAttemptCount`, `quoteVersion` (Task 1) |
| `prisma/migrations/20260928120000_square_payments/migration.sql` | **New.** The one migration, with the Stripe-payment guard (Task 1) |
| `tests/helpers/db.ts` | Clears `paymentEvent` (Task 1) |
| `src/ports/payments/payments.port.ts` | **Rewritten.** Square-shaped `PaymentsPort`, errors, decline copy (Task 2) |
| `src/ports/payments/webhook-signature.ts` | **Rewritten.** `squareSignature`, constant-time `verifySquareSignature` (Task 2) |
| `src/ports/payments/square.adapter.ts` | **New.** `createSquarePaymentsPort` over `square@46.0.0` (Task 2) |
| `src/ports/payments/fake.adapter.ts` | **Rewritten.** In-memory Square with real idempotency semantics (Task 2) |
| `src/ports/payments/index.ts` | **Rewritten.** Env selection over the five `SQUARE_*` keys (Task 2) |
| `src/ports/payments/stripe.adapter.ts` | **Deleted** (Task 2) |
| `src/payments/stripe-events.ts`, `stripe-webhook.routes.ts` | **Deleted** (Task 2) |
| `src/ports/tax/deferred.adapter.ts` | **Deleted** (Task 3) |
| `src/checkout/checkout-input.ts` | + `parseQuoteRequest`, `parsePayRequest`, contiguous-US sets, `checkoutErrors` (Task 3) |
| `src/checkout/payment-attempt.ts` | **New.** `PAYMENT_ATTEMPT_GRACE_MS`, `attemptInFlight` (Task 3) |
| `src/checkout/checkout.service.ts` | `startCheckout → { orderId }`; own-order release; `quoteCheckout`; `getCheckoutStatus(orderId)`; `BEFORE_QUOTE_TAX` (Task 3) |
| `src/checkout/pay.service.ts` | **New.** `payForOrder` (Task 4) |
| `src/payments/complete-payment.ts` | **New.** `applyCompletedPayment`, shared by pay and the webhook (Task 4) |
| `src/checkout/checkout.routes.ts` | `POST /`, `POST /:orderId/quote`, `POST /:orderId/pay`, `GET /status?orderId=`, `GET /config` (Tasks 3–4) |
| `src/checkout/sweep.ts` | No provider call; attempt-aware, lock-checked (Task 5) |
| `src/payments/square-events.ts`, `square-webhook.routes.ts` | **New.** Parser, dispatcher, five handlers, raw-body route (Task 6) |
| `src/app.ts` | `AppDeps` (+`tax`, −`storefrontUrl`); Stripe mount removed (Task 2); Square webhook mount (Task 6); admin router without payments (Task 7) |
| `src/server.ts` | Comment only (Task 2) |
| `src/admin/admin-orders.service.ts`, `admin-orders.routes.ts` | `payment` field; no provider call on cancel; neutral copy; `PAYMENT_IN_PROGRESS` (Task 7) |
| `src/ports/email/email.port.ts`, `noop.adapter.ts` | Comments: receipts are open item §9.1 (Task 8) |
| `tests/setup.ts` | Clears `SQUARE_*` (Task 2) |
| `tests/helpers/checkout.ts` | App-with-fake, quote/pay helpers (Task 3); Square event builder and signer (Task 6) |
| `render.yaml`, `README.md`, `docs/status/2026-09-28-square-sandbox-runbook.md` | Config, docs; the Stripe runbook is deleted (Task 8) |
| `CLAUDE.md` (engineering root), `docs/superpowers/specs/2026-09-27-revenue-loop-checkout-design.md` | Locked decisions; supersession note (Task 8) |

**Storefront (`systems/storefront/code`)**

| File | Responsibility |
|---|---|
| `src/lib/api/checkout.ts` | `startCheckout → { orderId }`, `quoteCheckout`, `payCheckout`, `getCheckoutStatus(orderId)`, new codes (Task 9) |
| `src/lib/square.ts` | **New.** `squareConfig`, `loadSquare` (script injection) (Task 10) |
| `src/components/checkout/SquarePayment.tsx` | **New.** Card form, Apple Pay, Google Pay, tokenize (Task 10) |
| `src/components/checkout/AddressForm.tsx` | **New** (Task 11) |
| `src/components/checkout/OrderConfirmation.tsx` | **New.** Shared confirmation view (Task 11) |
| `src/pages/Checkout.tsx` | **Rewritten.** Address → quote → pay → confirmation (Task 11) |
| `src/pages/OrderComplete.tsx` | `?order=` polling, neutral copy (Task 12) |
| `src/components/cart/CartPanel.tsx` | Square config gate; navigates with `{ orderId }` (Task 12) |
| `src/lib/stripe.ts`, `src/lib/stripe.test.ts` | **Deleted** (Task 12) |
| `src/routes.tsx`, `src/lib/cart/CartContext.tsx` | Comments only (Task 12) |
| `package.json` (+ root `package-lock.json`) | −`@stripe/*`, +`@square/web-payments-sdk-types` (Tasks 10, 12) |

**Console (`systems/admin-ui`)**

| File | Responsibility |
|---|---|
| `src/orders/OrderDetail.jsx`, `OrderQueue.jsx` | `payment` rendering, neutral copy (Task 14) |
| `src/data/__fixtures__/*.json` | Re-captured from core (Task 14) |

`src/lib/errorText.js` needs **no** change. Its `LABELS` map names request fields, not error codes, and none of them is provider-specific.

---

# PR 1 — Core (`feat/square-payments-core`)

Every command in PR 1 runs in `systems/core` unless it says otherwise.

## Task 0: Baseline

**Files:** none.

- [ ] **Step 1: Database up**

Run: `docker start alpinebrick-core-db && docker exec alpinebrick-core-db pg_isready -U postgres`
Expected: `accepting connections`. If Docker will not start, follow memory note "Docker Desktop reparse-point failure". If it is still broken, CI is the verifier (Global Constraints), and Task 1's migration rehearsal (Step 6) is recorded as not run.

- [ ] **Step 2: Branch**

```bash
cd projects/engineering
git checkout main && git pull --ff-only
git checkout -b feat/square-payments-core
```

- [ ] **Step 3: Green baseline**

Run in `systems/core`: `npx prisma migrate deploy && npx prisma generate && npx vitest run`
Expected: all tests pass. Record the count.

---

## Task 1: Schema migration — payment events, Square columns, Stripe columns dropped

**Files:**
- Modify: `systems/core/prisma/schema.prisma` (the `Order` model's `stripeCheckoutSessionId` / `stripePaymentIntentId` lines; the `StripeEvent` model)
- Create: `systems/core/prisma/migrations/20260928120000_square_payments/migration.sql`
- Modify: `systems/core/tests/helpers/db.ts:11`
- Modify: `systems/core/tests/revenue-loop-schema.test.ts:34`
- Test: `systems/core/tests/square-payments-schema.test.ts`

**Interfaces:**
- Produces on `Order`: `squarePaymentId: string | null` (unique), `paymentAttemptAt: Date | null`, `paymentAttemptCount: number` (default 0), `quoteVersion: number` (default 0). **Removes** `stripeCheckoutSessionId` and `stripePaymentIntentId`.
- Produces: Prisma model `PaymentEvent { provider: string; eventId: string; type: string; processedAt: Date }`, primary key `(provider, eventId)`, accessed as `prisma.paymentEvent` / `tx.paymentEvent`. Removes `prisma.stripeEvent`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/square-payments-schema.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'

beforeEach(async () => { await resetDb() })
afterAll(() => prisma.$disconnect())

const order = (data: Partial<Prisma.OrderUncheckedCreateInput> = {}) => prisma.order.create({
  data: {
    email: 'a@example.com', shipToState: 'MI', subtotalCents: 100, taxCents: 0, totalCents: 100,
    taxRateBps: 0, taxJurisdiction: 'none', ...data,
  },
})

describe('square payments schema', () => {
  it('gives orders the payment-attempt defaults', async () => {
    expect(await order()).toMatchObject({
      squarePaymentId: null, paymentAttemptAt: null, paymentAttemptCount: 0, quoteVersion: 0,
    })
  })

  it('keeps Square payment ids unique', async () => {
    await order({ squarePaymentId: 'sqpay_1' })
    await expect(order({ squarePaymentId: 'sqpay_1' })).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
  })

  it('de-duplicates payment events per provider, not globally', async () => {
    await prisma.paymentEvent.create({ data: { provider: 'square', eventId: 'e1', type: 'payment.updated' } })
    await prisma.paymentEvent.create({ data: { provider: 'stripe', eventId: 'e1', type: 'charge.refunded' } })
    await expect(prisma.paymentEvent.create({ data: { provider: 'square', eventId: 'e1', type: 'payment.updated' } }))
      .rejects.toMatchObject({ code: 'P2002' })
  })

  it('refuses negative attempt counters and quote versions', async () => {
    await expect(order({ paymentAttemptCount: -1 })).rejects.toThrow(/orders_payment_counters_nonnegative/)
    await expect(order({ quoteVersion: -1 })).rejects.toThrow(/orders_payment_counters_nonnegative/)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/square-payments-schema.test.ts`
Expected: FAIL. The TypeScript fields are unknown to the generated client, so Prisma raises `PrismaClientValidationError` (`Unknown argument squarePaymentId`), and `prisma.paymentEvent` is undefined.

- [ ] **Step 3: Edit the Prisma schema**

In `model Order`, delete these two lines:

```prisma
  stripeCheckoutSessionId String?            @unique @map("stripe_checkout_session_id")
  stripePaymentIntentId   String?            @unique @map("stripe_payment_intent_id")
```

and put these four in their place:

```prisma
  // --- Square payments (spec 2026-09-28 §2, §4) ----------------------------
  squarePaymentId         String?            @unique @map("square_payment_id")
  // Stamped by POST /checkout/:id/pay before it charges; the sweep and the
  // other cancel paths leave a pending order alone for 10 minutes after it.
  paymentAttemptAt        DateTime?          @map("payment_attempt_at")
  // Incremented on each definite decline; part of the idempotency key.
  paymentAttemptCount     Int                @default(0) @map("payment_attempt_count")
  // Incremented on every quote; pay must name the current one.
  quoteVersion            Int                @default(0) @map("quote_version")
```

Also update the comment above `shipName` from "until Stripe's webhook writes it" to "until the checkout quote writes it".

Replace the whole `model StripeEvent { ... }` block with:

```prisma
// One row per applied payment-provider webhook event (spec 2026-09-28 §3).
// Inserted in the same transaction as the event's effects; the primary key
// turns a repeat delivery into P2002 -> 'duplicate'. Rows written while
// Stripe was the provider keep provider = 'stripe'.
model PaymentEvent {
  provider    String
  eventId     String   @map("event_id")
  type        String
  processedAt DateTime @default(now()) @map("processed_at")
  @@id([provider, eventId])
  @@map("payment_events")
}
```

- [ ] **Step 4: Write the migration**

```sql
-- prisma/migrations/20260928120000_square_payments/migration.sql
-- Square payments replace Stripe (spec docs/superpowers/specs/2026-09-28-square-payments-design.md §4).

-- Guard FIRST, before any DDL: a Stripe payment-intent id is the only record
-- of money Stripe took for an order. Staging never had Stripe keys, so there
-- should be none. If there are, stop rather than drop them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "orders" WHERE "stripe_payment_intent_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'orders carry Stripe payment ids; settle them before migrating to Square';
  END IF;
END $$;

-- stripe_events -> payment_events, keyed by (provider, event_id).
ALTER TABLE "stripe_events" RENAME TO "payment_events";
ALTER TABLE "payment_events" DROP CONSTRAINT "stripe_events_pkey";
ALTER TABLE "payment_events" RENAME COLUMN "id" TO "event_id";
ALTER TABLE "payment_events" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'stripe';
ALTER TABLE "payment_events" ALTER COLUMN "provider" DROP DEFAULT;
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_pkey" PRIMARY KEY ("provider", "event_id");

-- Pending orders that still hold a Stripe session id lose it. The new sweep
-- (no provider call) releases them once they are older than the session
-- lifetime. Dropping a column drops its unique index.
ALTER TABLE "orders"
  DROP COLUMN "stripe_checkout_session_id",
  DROP COLUMN "stripe_payment_intent_id",
  ADD COLUMN "square_payment_id" TEXT,
  ADD COLUMN "payment_attempt_at" TIMESTAMP(3),
  ADD COLUMN "payment_attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "quote_version" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "orders_square_payment_id_key" ON "orders"("square_payment_id");
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_counters_nonnegative"
  CHECK ("payment_attempt_count" >= 0 AND "quote_version" >= 0);
```

- [ ] **Step 5: Point the test helpers at the new model**

`tests/helpers/db.ts` line 11: `await prisma.stripeEvent.deleteMany()` → `await prisma.paymentEvent.deleteMany()`.

`tests/revenue-loop-schema.test.ts` line 34: `reviewReason: null, stripeCheckoutSessionId: null, shipLine1: null,` → `reviewReason: null, squarePaymentId: null, shipLine1: null,`.

- [ ] **Step 6: Rehearse the migration on a database with legacy rows (§6), then apply it**

The local DB is still at `20260927120000` (Task 0). Put in one legacy pending order with a Stripe session id, one `stripe_events` row, and one order with a Stripe payment-intent id. These scripts run through Prisma, which loads the project's own config. Nothing here reads or sets `DATABASE_URL`.

```bash
node --input-type=module <<'JS'
import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
await p.$executeRawUnsafe(`INSERT INTO stripe_events (id, type) VALUES ('evt_legacy_1', 'checkout.session.completed') ON CONFLICT DO NOTHING`)
await p.$executeRawUnsafe(`INSERT INTO orders (id, email, ship_to_state, subtotal_cents, tax_cents, total_cents, tax_rate_bps, tax_jurisdiction, stripe_checkout_session_id, updated_at)
  VALUES ('legacy_pending_1', 'pending@checkout.invalid', '', 4999, 0, 4999, 0, 'stripe_tax_pending', 'cs_test_legacy', now()) ON CONFLICT DO NOTHING`)
await p.$executeRawUnsafe(`INSERT INTO orders (id, email, ship_to_state, subtotal_cents, tax_cents, total_cents, tax_rate_bps, tax_jurisdiction, status, stripe_payment_intent_id, updated_at)
  VALUES ('legacy_paid_1', 'a@example.com', 'MI', 4999, 300, 5299, 600, 'stripe_tax', 'paid', 'pi_test_legacy', now()) ON CONFLICT DO NOTHING`)
await p.$disconnect()
JS
npx prisma migrate deploy
```
Expected: the deploy **fails** on `20260928120000_square_payments` with `orders carry Stripe payment ids; settle them before migrating to Square`. The guard ran before any DDL, so nothing changed.

```bash
node --input-type=module <<'JS'
import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
await p.$executeRawUnsafe(`DELETE FROM orders WHERE id = 'legacy_paid_1'`)
await p.$disconnect()
JS
npx prisma migrate resolve --rolled-back 20260928120000_square_payments
npx prisma migrate deploy
npx prisma generate
node --input-type=module <<'JS'
import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
console.log(await p.$queryRawUnsafe(`SELECT provider, event_id FROM payment_events WHERE event_id = 'evt_legacy_1'`))
console.log(await p.$queryRawUnsafe(`SELECT id, status, square_payment_id, payment_attempt_count, quote_version FROM orders WHERE id = 'legacy_pending_1'`))
await p.$executeRawUnsafe(`DELETE FROM orders WHERE id = 'legacy_pending_1'`)
await p.$executeRawUnsafe(`DELETE FROM payment_events WHERE event_id = 'evt_legacy_1'`)
await p.$disconnect()
JS
```
Expected: `Applying migration 20260928120000_square_payments` succeeds, and the script prints `[ { provider: 'stripe', event_id: 'evt_legacy_1' } ]` and `[ { id: 'legacy_pending_1', status: 'pending', square_payment_id: null, payment_attempt_count: 0, quote_version: 0 } ]`. Copy both outputs into the task report.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/square-payments-schema.test.ts tests/revenue-loop-schema.test.ts tests/schema.test.ts tests/orders-schema.test.ts tests/orders-checkout-support.test.ts`
Expected: PASS. (`checkout-routes`, `checkout-sweep`, `stripe-webhook` and `admin-orders` now fail. See the Global Constraints table.)

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260928120000_square_payments tests/square-payments-schema.test.ts tests/helpers/db.ts tests/revenue-loop-schema.test.ts
git commit -m "feat(core): square payments schema — payment_events, square payment id, attempt and quote counters" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: `PaymentsPort` for Square — adapter, fake, env selection; Stripe removed

**Files:**
- Modify (rewrite): `systems/core/src/ports/payments/payments.port.ts`, `webhook-signature.ts`, `fake.adapter.ts`, `index.ts`
- Create: `systems/core/src/ports/payments/square.adapter.ts`
- Delete: `systems/core/src/ports/payments/stripe.adapter.ts`, `src/payments/stripe-events.ts`, `src/payments/stripe-webhook.routes.ts`, `tests/payments-stripe-adapter.test.ts`, `tests/stripe-webhook.test.ts`
- Modify: `systems/core/src/app.ts` (remove the Stripe webhook import and mount), `src/server.ts` (comment), `tests/setup.ts`, `package.json` / `package-lock.json`
- Test: `systems/core/tests/payments-square-adapter.test.ts`, `tests/payments-selection.test.ts` (rewrite), `tests/payments-fake.test.ts`

**Interfaces:**
- Produces (`payments.port.ts`):
  - `SQUARE_API_VERSION = '2026-09-16'`
  - `interface ShipToAddress { name: string; line1: string; line2: string | null; city: string; state: string; postalCode: string }`
  - `interface ChargeInput { sourceToken: string; amountCents: number; idempotencyKey: string; referenceId: string; buyerEmail: string; shippingAddress: ShipToAddress }`
  - `type ChargeResult = { outcome: 'completed'; paymentId: string; amountCents: number } | { outcome: 'processing'; paymentId: string; status: string } | { outcome: 'declined'; code: string; message: string }`
  - `interface PaymentSummary { id: string; status: string; amountCents: number; referenceId: string | null; locationId: string | null }`
  - `interface RefundSummary { id: string; status: string; amountCents: number }`
  - `interface PaymentsPort { readonly configured: boolean; readonly locationId: string | null; charge(input: ChargeInput): Promise<ChargeResult>; getPayment(paymentId: string): Promise<PaymentSummary>; listPaymentRefunds(paymentId: string): Promise<RefundSummary[]>; verifyWebhook(rawBody: Buffer, signature: string): void }`
  - Errors: `PaymentsUnavailableError`, `PaymentAttemptConflictError`, `WebhookSignatureError`
  - `DECLINE_MESSAGE = 'Your card was declined — try another card.'`, `declineMessage(code: string): string`
- Produces (`webhook-signature.ts`): `squareSignature(notificationUrl: string, rawBody: Buffer, signatureKey: string): string`, `verifySquareSignature(rawBody: Buffer, signature: string, signatureKey: string, notificationUrl: string): void`
- Produces (`square.adapter.ts`): `interface SquareConfig { environment: 'sandbox' | 'production'; accessToken: string; locationId: string; webhookSignatureKey: string; webhookNotificationUrl: string }`, `interface SquareApi`, `createSquarePaymentsPort(config: SquareConfig, client?: SquareApi): PaymentsPort`
- Produces (`fake.adapter.ts`): `FAKE_SIGNATURE_KEY`, `FAKE_NOTIFICATION_URL`, `FAKE_LOCATION_ID`, `type FakeOutcome = 'completed' | 'declined' | 'processing' | 'lost' | 'unavailable'`, `interface FakePaymentsPort extends PaymentsPort { charges: ChargeInput[]; nextOutcomes: FakeOutcome[]; payments: Map<string, PaymentSummary>; refunds: Map<string, RefundSummary[]>; duringCharge: (() => Promise<void>) | null; addRefund(paymentId: string, refund: RefundSummary): void; paymentFor(orderId: string): PaymentSummary; sign(payload: string, notificationUrl?: string): string }`, `createFakePaymentsPort(): FakePaymentsPort`
- Produces (`index.ts`): `SQUARE_KEYS`, `unconfiguredPaymentsPort: PaymentsPort`, `createPaymentsPort(env?: NodeJS.ProcessEnv): PaymentsPort`

- [ ] **Step 1: Swap the SDK**

Run in `systems/core`:
```bash
npm uninstall stripe
npm install --save-exact square@46.0.0
```
Expected: `package.json` lists `"square": "46.0.0"` (no caret) and no `stripe`.

- [ ] **Step 2: Write the failing tests**

```ts
// tests/payments-square-adapter.test.ts
import { describe, it, expect, vi } from 'vitest'
import { SquareError, WebhooksHelper } from 'square'
import { createSquarePaymentsPort, type SquareApi } from '../src/ports/payments/square.adapter.js'
import {
  SQUARE_API_VERSION, DECLINE_MESSAGE, PaymentAttemptConflictError, WebhookSignatureError,
} from '../src/ports/payments/payments.port.js'
import { squareSignature } from '../src/ports/payments/webhook-signature.js'

const CONFIG = {
  environment: 'sandbox' as const,
  accessToken: 'sq-access-token-unused-placeholder',
  locationId: 'LONLINE',
  webhookSignatureKey: 'adapter-test-signature-key',
  webhookNotificationUrl: 'https://api-staging.alpinebrickexchange.com/api/v1/webhooks/square',
}

const INPUT = {
  sourceToken: 'cnon:card-nonce-ok', amountCents: 11593, idempotencyKey: 'ord_1:1:0', referenceId: 'ord_1',
  buyerEmail: 'buyer@example.com',
  shippingAddress: { name: 'Ann Buyer', line1: '1 Main St', line2: 'Apt 2', city: 'Traverse City', state: 'MI', postalCode: '49684' },
}

type AnyAsync = (...args: any[]) => Promise<unknown>
function stub(over: { create?: AnyAsync; get?: AnyAsync; refundGet?: AnyAsync } = {}) {
  const create = vi.fn<AnyAsync>(over.create ?? (async () => ({
    payment: { id: 'sqpay_1', status: 'COMPLETED', amountMoney: { amount: 11593n, currency: 'USD' } },
  })))
  const get = vi.fn<AnyAsync>(over.get ?? (async () => ({ payment: { id: 'sqpay_1', status: 'COMPLETED', amountMoney: { amount: 11593n }, referenceId: 'ord_1', locationId: 'LONLINE', refundIds: [] } })))
  const refundGet = vi.fn<AnyAsync>(over.refundGet ?? (async () => ({ refund: null })))
  const client = { payments: { create, get }, refunds: { get: refundGet } } as unknown as SquareApi
  return { client, create, get, refundGet }
}

const squareError = (statusCode: number, errors: { category: string; code: string; detail?: string }[]) =>
  new SquareError({ statusCode, body: { errors, payment: { buyer_email_address: 'buyer@example.com' } } })

describe('Square payments adapter', () => {
  it('pins the API version square@46.0.0 is typed for', () => {
    expect(SQUARE_API_VERSION).toBe('2026-09-16')
  })

  it('charges the quoted total at the Online location, with no Square Order, and reports COMPLETED', async () => {
    const { client, create } = stub()
    const port = createSquarePaymentsPort(CONFIG, client)
    expect(await port.charge(INPUT)).toEqual({ outcome: 'completed', paymentId: 'sqpay_1', amountCents: 11593 })
    expect(create).toHaveBeenCalledWith({
      sourceId: 'cnon:card-nonce-ok',
      idempotencyKey: 'ord_1:1:0',
      amountMoney: { amount: 11593n, currency: 'USD' },
      autocomplete: true,
      locationId: 'LONLINE',
      referenceId: 'ord_1',
      buyerEmailAddress: 'buyer@example.com',
      shippingAddress: {
        firstName: 'Ann Buyer', addressLine1: '1 Main St', addressLine2: 'Apt 2', locality: 'Traverse City',
        administrativeDistrictLevel1: 'MI', postalCode: '49684', country: 'US',
      },
    })
    expect(create.mock.calls[0][0]).not.toHaveProperty('orderId') // Q5: payments only
  })

  it('reports APPROVED or PENDING as processing', async () => {
    const { client } = stub({ create: async () => ({ payment: { id: 'sqpay_2', status: 'APPROVED', amountMoney: { amount: 1n } } }) })
    expect(await createSquarePaymentsPort(CONFIG, client).charge(INPUT)).toEqual({ outcome: 'processing', paymentId: 'sqpay_2', status: 'APPROVED' })
  })

  it('turns a card decline into declined with our buyer-safe copy, not Square detail text', async () => {
    const { client } = stub({ create: async () => { throw squareError(402, [{ category: 'PAYMENT_METHOD_ERROR', code: 'GENERIC_DECLINE', detail: "Authorization error: 'GENERIC_DECLINE'" }]) } })
    expect(await createSquarePaymentsPort(CONFIG, client).charge(INPUT)).toEqual({ outcome: 'declined', code: 'GENERIC_DECLINE', message: DECLINE_MESSAGE })
  })

  it('names a CVV mismatch and a used token specifically', async () => {
    const cvv = stub({ create: async () => { throw squareError(400, [{ category: 'PAYMENT_METHOD_ERROR', code: 'CVV_FAILURE' }]) } })
    expect((await createSquarePaymentsPort(CONFIG, cvv.client).charge(INPUT))).toMatchObject({ outcome: 'declined', message: 'The security code did not match — check it and try again.' })
    const used = stub({ create: async () => { throw squareError(400, [{ category: 'INVALID_REQUEST_ERROR', code: 'CARD_TOKEN_USED' }]) } })
    expect((await createSquarePaymentsPort(CONFIG, used.client).charge(INPUT))).toMatchObject({ outcome: 'declined', message: 'Please re-enter your card details and try again.' })
  })

  it('raises PaymentAttemptConflictError when Square refuses a reused idempotency key', async () => {
    const { client } = stub({ create: async () => { throw squareError(400, [{ category: 'INVALID_REQUEST_ERROR', code: 'IDEMPOTENCY_KEY_REUSED' }]) } })
    await expect(createSquarePaymentsPort(CONFIG, client).charge(INPUT)).rejects.toBeInstanceOf(PaymentAttemptConflictError)
  })

  it('rethrows other failures WITHOUT the response body (it can hold the buyer email and address)', async () => {
    const { client } = stub({ create: async () => { throw squareError(401, [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED' }]) } })
    const err = await createSquarePaymentsPort(CONFIG, client).charge(INPUT).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('Square request failed (401): UNAUTHORIZED')
    expect(err.message).not.toContain('buyer@example.com')
  })

  it('reads a payment', async () => {
    const { client, get } = stub()
    expect(await createSquarePaymentsPort(CONFIG, client).getPayment('sqpay_1')).toEqual({
      id: 'sqpay_1', status: 'COMPLETED', amountCents: 11593, referenceId: 'ord_1', locationId: 'LONLINE',
    })
    expect(get).toHaveBeenCalledWith({ paymentId: 'sqpay_1' })
  })

  it('lists a payment’s refunds through payment.refundIds', async () => {
    const refunds: Record<string, unknown> = {
      r1: { id: 'r1', status: 'COMPLETED', amountMoney: { amount: 500n } },
      r2: { id: 'r2', status: 'PENDING', amountMoney: { amount: 700n } },
    }
    const { client, refundGet } = stub({
      get: async () => ({ payment: { id: 'sqpay_1', refundIds: ['r1', 'r2'] } }),
      refundGet: async ({ refundId }: { refundId: string }) => ({ refund: refunds[refundId] }),
    })
    expect(await createSquarePaymentsPort(CONFIG, client).listPaymentRefunds('sqpay_1')).toEqual([
      { id: 'r1', status: 'COMPLETED', amountCents: 500 },
      { id: 'r2', status: 'PENDING', amountCents: 700 },
    ])
    expect(refundGet).toHaveBeenCalledTimes(2)
  })

  describe('webhook signature', () => {
    const body = Buffer.from('{"event_id":"e1","type":"payment.updated"}')
    const port = createSquarePaymentsPort(CONFIG, stub().client)

    it('matches Square’s own WebhooksHelper', async () => {
      const sig = squareSignature(CONFIG.webhookNotificationUrl, body, CONFIG.webhookSignatureKey)
      expect(await WebhooksHelper.verifySignature({
        requestBody: body.toString('utf8'), signatureHeader: sig,
        signatureKey: CONFIG.webhookSignatureKey, notificationUrl: CONFIG.webhookNotificationUrl,
      })).toBe(true)
      expect(() => port.verifyWebhook(body, sig)).not.toThrow()
    })

    it('rejects a signature over another URL, a tampered body, and a wrong-length header', () => {
      const otherUrl = squareSignature('https://evil.example/hook', body, CONFIG.webhookSignatureKey)
      expect(() => port.verifyWebhook(body, otherUrl)).toThrow(WebhookSignatureError)
      const sig = squareSignature(CONFIG.webhookNotificationUrl, body, CONFIG.webhookSignatureKey)
      expect(() => port.verifyWebhook(Buffer.from('{"event_id":"e2"}'), sig)).toThrow(WebhookSignatureError)
      expect(() => port.verifyWebhook(body, 'short')).toThrow(WebhookSignatureError)
    })
  })
})
```

```ts
// tests/payments-selection.test.ts (replace the whole file)
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createPaymentsPort, SQUARE_KEYS } from '../src/ports/payments/index.js'
import { PaymentsUnavailableError, WebhookSignatureError } from '../src/ports/payments/payments.port.js'

const FULL = {
  SQUARE_ENVIRONMENT: 'sandbox',
  SQUARE_ACCESS_TOKEN: 'sq-access-token-unused-placeholder',
  SQUARE_LOCATION_ID: 'LONLINE',
  SQUARE_WEBHOOK_SIGNATURE_KEY: 'selection-test-signature-key',
  SQUARE_WEBHOOK_NOTIFICATION_URL: 'https://api-staging.alpinebrickexchange.com/api/v1/webhooks/square',
}
afterEach(() => vi.restoreAllMocks())

describe('createPaymentsPort', () => {
  it('is unconfigured, not broken, when no Square key is set', async () => {
    const port = createPaymentsPort({})
    expect(port.configured).toBe(false)
    expect(port.locationId).toBeNull()
    await expect(port.getPayment('x')).rejects.toBeInstanceOf(PaymentsUnavailableError)
    expect(() => port.verifyWebhook(Buffer.from('{}'), 'x')).toThrow(WebhookSignatureError)
  })

  it.each(SQUARE_KEYS.map((k) => [k]))('refuses to start without %s when the others are set, naming it', (missing) => {
    const env: Record<string, string> = { ...FULL }
    delete env[missing]
    expect(() => createPaymentsPort(env)).toThrow(new RegExp(`Square is half-configured; missing: ${missing}`))
  })

  it('refuses an unknown SQUARE_ENVIRONMENT and a non-https notification URL', () => {
    expect(() => createPaymentsPort({ ...FULL, SQUARE_ENVIRONMENT: 'live' })).toThrow(/sandbox or production/)
    expect(() => createPaymentsPort({ ...FULL, SQUARE_WEBHOOK_NOTIFICATION_URL: 'http://x.example/h' })).toThrow(/https/)
  })

  it('builds the Square adapter when fully configured', () => {
    const port = createPaymentsPort(FULL)
    expect(port.configured).toBe(true)
    expect(port.locationId).toBe('LONLINE')
  })

  it('warns about leftover Stripe keys instead of failing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createPaymentsPort({ ...FULL, STRIPE_SECRET_KEY: 'x' })
    expect(warn.mock.calls.join(' ')).toContain('STRIPE_')
  })
})
```

```ts
// tests/payments-fake.test.ts
import { describe, it, expect } from 'vitest'
import { createFakePaymentsPort, FAKE_NOTIFICATION_URL } from '../src/ports/payments/fake.adapter.js'
import { PaymentAttemptConflictError, DECLINE_MESSAGE } from '../src/ports/payments/payments.port.js'

const input = (over: Record<string, unknown> = {}) => ({
  sourceToken: 'tok_1', amountCents: 1000, idempotencyKey: 'o:1:0', referenceId: 'o', buyerEmail: 'b@example.com',
  shippingAddress: { name: 'A', line1: '1', line2: null, city: 'C', state: 'MI', postalCode: '49684' }, ...over,
})

describe('fake Square', () => {
  it('replays the first result for the same key and token, like Square', async () => {
    const fake = createFakePaymentsPort()
    const a = await fake.charge(input())
    const b = await fake.charge(input())
    expect(b).toEqual(a)
    expect(fake.payments.size).toBe(1)
  })

  it('refuses the same key with a different token', async () => {
    const fake = createFakePaymentsPort()
    await fake.charge(input())
    await expect(fake.charge(input({ sourceToken: 'tok_2' }))).rejects.toBeInstanceOf(PaymentAttemptConflictError)
  })

  it('follows queued outcomes: declined, then a lost response that did charge', async () => {
    const fake = createFakePaymentsPort()
    fake.nextOutcomes = ['declined', 'lost']
    expect(await fake.charge(input())).toEqual({ outcome: 'declined', code: 'GENERIC_DECLINE', message: DECLINE_MESSAGE })
    await expect(fake.charge(input({ idempotencyKey: 'o:1:1' }))).rejects.toThrow(/lost/)
    expect(fake.paymentFor('o').status).toBe('COMPLETED')
    expect(await fake.charge(input({ idempotencyKey: 'o:1:1' }))).toMatchObject({ outcome: 'completed' })
  })

  it('signs payloads over the notification URL', () => {
    const fake = createFakePaymentsPort()
    const body = '{"event_id":"e"}'
    expect(() => fake.verifyWebhook(Buffer.from(body), fake.sign(body))).not.toThrow()
    expect(() => fake.verifyWebhook(Buffer.from(body), fake.sign(body, `${FAKE_NOTIFICATION_URL}x`))).toThrow()
  })
})
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `npx vitest run tests/payments-square-adapter.test.ts tests/payments-selection.test.ts tests/payments-fake.test.ts`
Expected: FAIL. `square.adapter.js` cannot be resolved, and `SQUARE_KEYS` is not exported.

- [ ] **Step 4: Write the port**

```ts
// src/ports/payments/payments.port.ts (replace the whole file)
/**
 * square@46.0.0 is generated for this Square API version; its client option
 * `version` is typed as exactly this literal (plan header, verified 2026-09-28).
 * The webhook subscription must be pinned to the same version (runbook §3).
 */
export const SQUARE_API_VERSION = '2026-09-16' as const

export interface ShipToAddress {
  name: string
  line1: string
  line2: string | null
  city: string
  state: string
  postalCode: string
}

export interface ChargeInput {
  /** The Web Payments SDK token (card or wallet). Single use. */
  sourceToken: string
  amountCents: number
  /** `<orderId>:<quoteVersion>:<attemptCount>`; Square allows at most 45 characters. */
  idempotencyKey: string
  /** Our order id, Square's `reference_id` (at most 40 characters). */
  referenceId: string
  buyerEmail: string
  shippingAddress: ShipToAddress
}

export type ChargeResult =
  | { outcome: 'completed'; paymentId: string; amountCents: number }
  | { outcome: 'processing'; paymentId: string; status: string }
  | { outcome: 'declined'; code: string; message: string }

export interface PaymentSummary {
  id: string
  status: string
  amountCents: number
  referenceId: string | null
  locationId: string | null
}

export interface RefundSummary { id: string; status: string; amountCents: number }

/** No Square keys on this instance. Checkout answers 503. */
export class PaymentsUnavailableError extends Error {
  constructor() { super('payments are not configured'); this.name = 'PaymentsUnavailableError' }
}

/**
 * Square refused the idempotency key because an earlier attempt used it with
 * a different card token. That attempt's outcome is unknown to us; the
 * payment.updated webhook, or the sweep, settles the order (plan decision 3).
 */
export class PaymentAttemptConflictError extends Error {
  constructor() { super('an earlier payment attempt for this order is unresolved'); this.name = 'PaymentAttemptConflictError' }
}

export class WebhookSignatureError extends Error {
  constructor(message = 'invalid Square signature') { super(message); this.name = 'WebhookSignatureError' }
}

/** Spec §4 Storefront, verbatim. */
export const DECLINE_MESSAGE = 'Your card was declined — try another card.'
const RETYPE = 'Please re-enter your card details and try again.'
const POSTAL = 'The billing ZIP code did not match — check it and try again.'
const EXPIRY = 'The expiry date is not valid — check it and try again.'
/** Buyer-safe copy per Square error code (plan decision 8). Anything else gets DECLINE_MESSAGE. */
const DECLINE_MESSAGES: Record<string, string> = {
  CVV_FAILURE: 'The security code did not match — check it and try again.',
  ADDRESS_VERIFICATION_FAILURE: POSTAL,
  INVALID_POSTAL_CODE: POSTAL,
  INVALID_EXPIRATION: EXPIRY,
  EXPIRATION_FAILURE: EXPIRY,
  BAD_EXPIRATION: EXPIRY,
  CARD_EXPIRED: 'This card has expired — try another card.',
  CARD_TOKEN_EXPIRED: RETYPE,
  CARD_TOKEN_USED: RETYPE,
  SOURCE_USED: RETYPE,
  SOURCE_EXPIRED: RETYPE,
  INVALID_CARD_DATA: RETYPE,
}
export function declineMessage(code: string): string {
  return DECLINE_MESSAGES[code] ?? DECLINE_MESSAGE
}

/**
 * Everything core asks of the payment provider (spec §4). Unit tests use
 * fake.adapter.ts; the Square adapter has a stubbed-client test and the
 * staging sandbox run.
 */
export interface PaymentsPort {
  readonly configured: boolean
  /** The Square "Online" location (Q7). Webhooks for any other location are not ours. */
  readonly locationId: string | null
  charge(input: ChargeInput): Promise<ChargeResult>
  getPayment(paymentId: string): Promise<PaymentSummary>
  listPaymentRefunds(paymentId: string): Promise<RefundSummary[]>
  /** Throws WebhookSignatureError unless `signature` is the HMAC of notification URL + raw body. */
  verifyWebhook(rawBody: Buffer, signature: string): void
}
```

```ts
// src/ports/payments/webhook-signature.ts (replace the whole file)
import { createHmac, timingSafeEqual } from 'node:crypto'
import { WebhookSignatureError } from './payments.port.js'

/**
 * Square's scheme (https://developer.squareup.com/docs/webhooks/step3validate):
 * base64 HMAC-SHA256, keyed with the subscription's signature key, over the
 * notification URL followed by the raw request body. Computed over bytes, so
 * the body is never re-encoded.
 */
export function squareSignature(notificationUrl: string, rawBody: Buffer, signatureKey: string): string {
  return createHmac('sha256', signatureKey)
    .update(Buffer.concat([Buffer.from(notificationUrl, 'utf8'), rawBody]))
    .digest('base64')
}

/**
 * Constant-time check (plan decision 1): square@46.0.0's
 * WebhooksHelper.verifySignature compares with ===. `notificationUrl` comes
 * from config, never from request headers (spec §3) -- behind Render's proxy
 * a URL rebuilt from the request would not be the one Square signed.
 */
export function verifySquareSignature(rawBody: Buffer, signature: string, signatureKey: string, notificationUrl: string): void {
  const expected = Buffer.from(squareSignature(notificationUrl, rawBody, signatureKey), 'utf8')
  const given = Buffer.from(signature, 'utf8')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new WebhookSignatureError()
}
```

- [ ] **Step 5: Write the Square adapter**

```ts
// src/ports/payments/square.adapter.ts
import { SquareClient, SquareEnvironment, SquareError, SquareTimeoutError } from 'square'
import {
  SQUARE_API_VERSION, PaymentAttemptConflictError, declineMessage,
  type PaymentsPort, type ShipToAddress, type RefundSummary,
} from './payments.port.js'
import { verifySquareSignature } from './webhook-signature.js'

export interface SquareConfig {
  environment: 'sandbox' | 'production'
  accessToken: string
  locationId: string
  webhookSignatureKey: string
  /** Exactly the URL registered on the webhook subscription (spec §3). */
  webhookNotificationUrl: string
}

/** The slice of SquareClient the adapter calls. Tests pass a stub. */
export interface SquareApi {
  payments: Pick<SquareClient['payments'], 'create' | 'get'>
  refunds: Pick<SquareClient['refunds'], 'get'>
}

/** Codes that mean "this token cannot be charged; ask for the card again". */
const TOKEN_CODES: ReadonlySet<string> = new Set(['CARD_TOKEN_EXPIRED', 'CARD_TOKEN_USED', 'SOURCE_USED', 'SOURCE_EXPIRED', 'INVALID_CARD_DATA'])

const cents = (amount: bigint | null | undefined): number => Number(amount ?? 0n)

/**
 * SquareError.message embeds the whole response body, which can carry the
 * buyer's email and address. Nothing above this adapter ever sees it: every
 * other failure becomes a plain Error naming only the status and codes.
 */
function sanitize(err: unknown): Error {
  if (err instanceof SquareError) {
    return new Error(`Square request failed (${err.statusCode ?? 'no status'}): ${err.errors.map((e) => e.code).join(', ')}`)
  }
  if (err instanceof SquareTimeoutError) return new Error('Square request timed out')
  return new Error(err instanceof Error ? err.message : String(err))
}

function toSquareAddress(a: ShipToAddress) {
  return {
    firstName: a.name,
    addressLine1: a.line1,
    ...(a.line2 ? { addressLine2: a.line2 } : {}),
    locality: a.city,
    administrativeDistrictLevel1: a.state,
    postalCode: a.postalCode,
    country: 'US' as const,
  }
}

export function createSquarePaymentsPort(
  config: SquareConfig,
  client: SquareApi = new SquareClient({
    token: config.accessToken,
    environment: config.environment === 'production' ? SquareEnvironment.Production : SquareEnvironment.Sandbox,
    version: SQUARE_API_VERSION,
    timeoutInSeconds: 20,
    // The SDK retries 408/429/5xx with the same body -- same idempotency key.
    maxRetries: 2,
  }),
): PaymentsPort {
  return {
    configured: true,
    locationId: config.locationId,

    async charge(input) {
      let payment
      try {
        const res = await client.payments.create({
          sourceId: input.sourceToken,
          idempotencyKey: input.idempotencyKey,
          amountMoney: { amount: BigInt(input.amountCents), currency: 'USD' },
          autocomplete: true,
          locationId: config.locationId,
          referenceId: input.referenceId,
          buyerEmailAddress: input.buyerEmail,
          shippingAddress: toSquareAddress(input.shippingAddress),
        })
        payment = res.payment
      } catch (err) {
        if (err instanceof SquareError && err.statusCode !== undefined && err.statusCode < 500) {
          if (err.errors.some((e) => e.code === 'IDEMPOTENCY_KEY_REUSED')) throw new PaymentAttemptConflictError()
          const decline = err.errors.find((e) => e.category === 'PAYMENT_METHOD_ERROR' || TOKEN_CODES.has(e.code))
          if (decline) return { outcome: 'declined', code: decline.code, message: declineMessage(decline.code) }
        }
        throw sanitize(err)
      }
      if (!payment?.id) throw new Error('Square returned no payment')
      if (payment.status === 'COMPLETED') {
        return { outcome: 'completed', paymentId: payment.id, amountCents: cents(payment.amountMoney?.amount) }
      }
      if (payment.status === 'FAILED' || payment.status === 'CANCELED') {
        return { outcome: 'declined', code: payment.status, message: declineMessage(payment.status) }
      }
      // APPROVED or PENDING: not expected for cards (spec §2 step 5.6); the webhook finishes it.
      return { outcome: 'processing', paymentId: payment.id, status: payment.status ?? 'UNKNOWN' }
    },

    async getPayment(paymentId) {
      let payment
      try { payment = (await client.payments.get({ paymentId })).payment } catch (err) { throw sanitize(err) }
      if (!payment?.id) throw new Error(`Square returned no payment for ${paymentId}`)
      return {
        id: payment.id, status: payment.status ?? 'UNKNOWN', amountCents: cents(payment.amountMoney?.amount),
        referenceId: payment.referenceId ?? null, locationId: payment.locationId ?? null,
      }
    },

    // square@46.0.0 has no per-payment refund listing; RefundsApi.list filters
    // by location and time only. A payment carries at most 20 refund ids.
    async listPaymentRefunds(paymentId) {
      try {
        const { payment } = await client.payments.get({ paymentId })
        const out: RefundSummary[] = []
        for (const refundId of payment?.refundIds ?? []) {
          const { refund } = await client.refunds.get({ refundId })
          if (refund) out.push({ id: refund.id, status: refund.status ?? 'UNKNOWN', amountCents: cents(refund.amountMoney.amount) })
        }
        return out
      } catch (err) { throw sanitize(err) }
    },

    verifyWebhook(rawBody, signature) {
      verifySquareSignature(rawBody, signature, config.webhookSignatureKey, config.webhookNotificationUrl)
    },
  }
}
```

- [ ] **Step 6: Write the fake**

```ts
// src/ports/payments/fake.adapter.ts (replace the whole file)
import {
  DECLINE_MESSAGE, PaymentAttemptConflictError,
  type ChargeInput, type ChargeResult, type PaymentSummary, type PaymentsPort, type RefundSummary,
} from './payments.port.js'
import { squareSignature, verifySquareSignature } from './webhook-signature.js'

export const FAKE_SIGNATURE_KEY = 'fake-square-signature-key'
export const FAKE_NOTIFICATION_URL = 'https://api-staging.alpinebrickexchange.com/api/v1/webhooks/square'
export const FAKE_LOCATION_ID = 'LFAKEONLINE'

/**
 * - completed / declined / processing: Square's three answers.
 * - lost: Square charged, then the response never arrived (the charge is
 *   recorded under the key, and charge() throws).
 * - unavailable: the request never reached Square (nothing recorded; throws).
 */
export type FakeOutcome = 'completed' | 'declined' | 'processing' | 'lost' | 'unavailable'

export interface FakePaymentsPort extends PaymentsPort {
  charges: ChargeInput[]
  /** Outcomes for the next charges that reach "Square"; empty means completed. */
  nextOutcomes: FakeOutcome[]
  payments: Map<string, PaymentSummary>
  refunds: Map<string, RefundSummary[]>
  /** Runs once, inside the next charge, before it answers: races the sweep or an admin against a charge. */
  duringCharge: (() => Promise<void>) | null
  addRefund(paymentId: string, refund: RefundSummary): void
  /** The Square payment taken for `orderId` (by reference id). Throws if none. */
  paymentFor(orderId: string): PaymentSummary
  /** A valid x-square-hmacsha256-signature for `payload` (over `notificationUrl`). */
  sign(payload: string, notificationUrl?: string): string
}

/**
 * In-memory Square with Square's idempotency semantics: the same key and the
 * same token replay the first result; the same key with a different token is
 * refused. Signatures use the real HMAC helper, so webhook tests exercise
 * genuine verification.
 */
export function createFakePaymentsPort(): FakePaymentsPort {
  const byKey = new Map<string, { token: string; result: ChargeResult }>()
  let n = 0
  const fake: FakePaymentsPort = {
    configured: true,
    locationId: FAKE_LOCATION_ID,
    charges: [],
    nextOutcomes: [],
    payments: new Map(),
    refunds: new Map(),
    duringCharge: null,

    async charge(input) {
      fake.charges.push(input)
      const prior = byKey.get(input.idempotencyKey)
      if (prior) {
        if (prior.token !== input.sourceToken) throw new PaymentAttemptConflictError()
        return prior.result
      }
      if (fake.duringCharge) {
        const hook = fake.duringCharge
        fake.duringCharge = null
        await hook()
      }
      const next = fake.nextOutcomes.shift() ?? 'completed'
      if (next === 'unavailable') throw new Error('square is down (fake)')
      let result: ChargeResult
      if (next === 'declined') {
        result = { outcome: 'declined', code: 'GENERIC_DECLINE', message: DECLINE_MESSAGE }
      } else {
        const id = `sqpay_fake_${++n}`
        const status = next === 'processing' ? 'PENDING' : 'COMPLETED'
        fake.payments.set(id, { id, status, amountCents: input.amountCents, referenceId: input.referenceId, locationId: FAKE_LOCATION_ID })
        result = status === 'COMPLETED'
          ? { outcome: 'completed', paymentId: id, amountCents: input.amountCents }
          : { outcome: 'processing', paymentId: id, status }
      }
      byKey.set(input.idempotencyKey, { token: input.sourceToken, result })
      if (next === 'lost') throw new Error('response lost after Square charged (fake)')
      return result
    },

    async getPayment(paymentId) {
      const p = fake.payments.get(paymentId)
      if (!p) throw new Error(`no such payment ${paymentId} (fake)`)
      return p
    },

    async listPaymentRefunds(paymentId) {
      return fake.refunds.get(paymentId) ?? []
    },

    verifyWebhook(rawBody, signature) {
      verifySquareSignature(rawBody, signature, FAKE_SIGNATURE_KEY, FAKE_NOTIFICATION_URL)
    },

    addRefund(paymentId, refund) {
      const list = (fake.refunds.get(paymentId) ?? []).filter((r) => r.id !== refund.id)
      fake.refunds.set(paymentId, [...list, refund])
    },

    paymentFor(orderId) {
      const p = [...fake.payments.values()].find((x) => x.referenceId === orderId)
      if (!p) throw new Error(`no payment for order ${orderId} (fake)`)
      return p
    },

    sign(payload, notificationUrl = FAKE_NOTIFICATION_URL) {
      return squareSignature(notificationUrl, Buffer.from(payload, 'utf8'), FAKE_SIGNATURE_KEY)
    },
  }
  return fake
}
```

- [ ] **Step 7: Write env selection**

```ts
// src/ports/payments/index.ts (replace the whole file)
import { PaymentsUnavailableError, WebhookSignatureError, type PaymentsPort } from './payments.port.js'
import { createSquarePaymentsPort } from './square.adapter.js'

export const SQUARE_KEYS = [
  'SQUARE_ENVIRONMENT', 'SQUARE_ACCESS_TOKEN', 'SQUARE_LOCATION_ID',
  'SQUARE_WEBHOOK_SIGNATURE_KEY', 'SQUARE_WEBHOOK_NOTIFICATION_URL',
] as const

/** No Square keys: checkout and the webhook answer 503; nothing else is affected. */
export const unconfiguredPaymentsPort: PaymentsPort = {
  configured: false,
  locationId: null,
  async charge() { throw new PaymentsUnavailableError() },
  async getPayment() { throw new PaymentsUnavailableError() },
  async listPaymentRefunds() { throw new PaymentsUnavailableError() },
  verifyWebhook() { throw new WebhookSignatureError('payments are not configured') },
}

/**
 * Picks the payments adapter at startup (spec §4). Partial config refuses to
 * start, naming each missing key: a deploy that can charge but cannot verify
 * webhooks would take money it can never reconcile.
 */
export function createPaymentsPort(env: NodeJS.ProcessEnv = process.env): PaymentsPort {
  if (Object.keys(env).some((k) => k.startsWith('STRIPE_'))) {
    console.warn('payments: STRIPE_* keys are set but no longer used -- remove them from this environment')
  }
  const present = SQUARE_KEYS.filter((k) => env[k])
  if (present.length === 0) return unconfiguredPaymentsPort
  const missing = SQUARE_KEYS.filter((k) => !env[k])
  if (missing.length > 0) throw new Error(`Square is half-configured; missing: ${missing.join(', ')}`)
  const environment = env.SQUARE_ENVIRONMENT
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new Error(`SQUARE_ENVIRONMENT must be sandbox or production, not "${environment}"`)
  }
  const notificationUrl = env.SQUARE_WEBHOOK_NOTIFICATION_URL!
  if (!notificationUrl.startsWith('https://')) throw new Error('SQUARE_WEBHOOK_NOTIFICATION_URL must be an https URL')
  return createSquarePaymentsPort({
    environment,
    accessToken: env.SQUARE_ACCESS_TOKEN!,
    locationId: env.SQUARE_LOCATION_ID!,
    webhookSignatureKey: env.SQUARE_WEBHOOK_SIGNATURE_KEY!,
    webhookNotificationUrl: notificationUrl,
  })
}
```

- [ ] **Step 8: Remove Stripe and fix the neighbours**

```bash
git rm src/ports/payments/stripe.adapter.ts src/payments/stripe-events.ts src/payments/stripe-webhook.routes.ts \
  tests/payments-stripe-adapter.test.ts tests/stripe-webhook.test.ts
```

In `src/app.ts`: delete `import { createStripeWebhookHandler } from './payments/stripe-webhook.routes.js'`. Delete the whole `app.post('/api/v1/webhooks/stripe', ...)` block and its comment above it. (Task 6 mounts the Square route in the same place.)

In `src/server.ts`, replace the comment line `// half-configured Stripe, so the process refuses to start (spec §8).` with `// partial Square config, so the process refuses to start (spec 2026-09-28 §4).`.

Replace `tests/setup.ts` with:

```ts
// Ruling P13 (carried over): buildApp() builds the payments port from env at
// construction time. A developer machine with stray SQUARE_* keys set (or
// only some of them) would make createPaymentsPort() throw, and every test
// file that builds the app at module scope would fail to load. Clearing them
// keeps buildApp() defaulting to unconfiguredPaymentsPort. Tests that need
// payments pass a payments dep explicitly (see tests/helpers/checkout.ts).
// STRIPE_* are cleared too, so the leftover-key warning stays out of test output.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('SQUARE_') || key.startsWith('STRIPE_')) delete process.env[key]
}
delete process.env.STOREFRONT_PUBLIC_URL
```

- [ ] **Step 9: Run the tests**

Run: `npx vitest run tests/payments-square-adapter.test.ts tests/payments-selection.test.ts tests/payments-fake.test.ts tests/health.test.ts tests/cors.test.ts`
Expected: PASS. (`checkout.service.ts`, `sweep.ts` and `admin-orders.service.ts` still call removed port methods. Their suites stay red until Tasks 3, 5 and 7, as planned.)

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json src/ports/payments src/app.ts src/server.ts tests/setup.ts \
  tests/payments-square-adapter.test.ts tests/payments-selection.test.ts tests/payments-fake.test.ts
git commit -m "feat(core): Square PaymentsPort (square@46.0.0), constant-time webhook signature, fake; remove Stripe" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3: Checkout start and quote — `{ orderId }`, own-order release, address validation, MI tax on goods

**Files:**
- Modify (rewrite): `systems/core/src/checkout/checkout-input.ts`, `src/checkout/checkout.service.ts`, `src/checkout/checkout.routes.ts`
- Create: `systems/core/src/checkout/payment-attempt.ts`
- Delete: `systems/core/src/ports/tax/deferred.adapter.ts`
- Modify: `systems/core/src/app.ts` (`AppDeps`, checkout mount)
- Modify (rewrite): `systems/core/tests/helpers/checkout.ts`, `tests/checkout-routes.test.ts`
- Modify: `systems/core/tests/orders-checkout-support.test.ts` (import and one expectation), `tests/capture-admin-fixtures.test.ts` (import and the paid fixture's fields)
- Test: `systems/core/tests/checkout-quote.test.ts`

**Interfaces:**
- Consumes: `PaymentsPort`, `ShipToAddress` (Task 2); `lockOrderRow`, `cancelOrderTx`, `placeOrder`, `enqueueInventoryPushesAfterCommit`, `orderNumber` (existing `orders.service.ts`); `ShippingPort.quote`, `TaxPort.computeTax`, `createFlatRateTaxPort` (existing); `normalizeEmail` (existing `customers.service.ts`); `Order.paymentAttemptAt`, `Order.quoteVersion` (Task 1).
- Produces (`checkout-input.ts`): `CheckoutError` and `CheckoutRequest` (unchanged); `parseCheckoutRequest` (unchanged, except that `previousOrderId` must now match `ORDER_ID_RE`); `CONTIGUOUS_US_NOTICE`; `OUTSIDE_SHIPPING_AREA: ReadonlySet<string>`; `CONTIGUOUS_STATES: ReadonlySet<string>` (49 codes); `ORDER_ID_RE`; `interface QuoteRequest { email: string; name: string; address: ShipToAddress }`; `parseQuoteRequest(body: unknown): QuoteRequest`; `interface PayRequest { sourceToken: string; quoteVersion: number }`; `parsePayRequest(body: unknown): PayRequest`; `checkoutErrors: { unavailable, notFound, expired, quoteChanged, paymentPending, tooManyAttempts }` (each `() => CheckoutError`).
- Produces (`payment-attempt.ts`): `PAYMENT_ATTEMPT_GRACE_MS = 600_000`, `attemptInFlight(at: Date | null, now: Date): boolean`. Tasks 5 and 7 rely on these.
- Produces (`checkout.service.ts`): `interface CheckoutDeps { payments: PaymentsPort; shipping: ShippingPort; tax: TaxPort; email: EmailPort; now?: () => Date }`; `BEFORE_QUOTE_TAX: TaxPort` (jurisdiction `'quote_pending'`); `lineName` (unchanged); `startCheckout(req: CheckoutRequest, deps: CheckoutDeps): Promise<{ orderId: string }>`; `interface QuoteDto { quoteVersion: number; subtotalCents: number; shippingCents: number; taxCents: number; totalCents: number }`; `quoteCheckout(orderId: string, req: QuoteRequest, deps: CheckoutDeps): Promise<QuoteDto>`; `CheckoutStatusDto` (unchanged shape); `getCheckoutStatus(orderId: string): Promise<CheckoutStatusDto | null>`; `getCheckoutConfig` (unchanged).
- Produces (`checkout.routes.ts`): `createCheckoutRouter(deps: CheckoutDeps & { rateLimit: RequestHandler }): Router` with `POST /`, `POST /:orderId/quote`, `GET /status?orderId=`, `GET /config`. The exported helpers `orderIdOf(raw: unknown): string` and `json(status: number, fn: (req: Request) => Promise<unknown>): RequestHandler` are reused by Task 4.
- Produces (`app.ts`): `interface AppDeps { payments: PaymentsPort; shipping: ShippingPort; tax: TaxPort; email: EmailPort; checkoutRateLimit: RequestHandler }` (`storefrontUrl` removed).
- Produces (`tests/helpers/checkout.ts`): `makeApp(over?)`, `variantIdBySku`, `inventoryOf`, `setOnHand`, `postCheckout`, `MI_ADDRESS`, `quoteBody(over?)`, `postQuote(app, orderId, body?)`, `readyToPay(app, o?) → { orderId, quoteVersion, totalCents }`.

- [ ] **Step 1: Rewrite the test helpers**

```ts
// tests/helpers/checkout.ts (replace the whole file; Tasks 4 and 6 append to it)
import request from 'supertest'
import type { Express } from 'express'
import { buildApp, type AppDeps } from '../../src/app.js'
import { createFakePaymentsPort, type FakePaymentsPort } from '../../src/ports/payments/fake.adapter.js'
import { prisma } from '../../src/prisma.js'

/** An app wired to the fake Square, with the rate limit off unless a test supplies one. */
export function makeApp(over: Partial<AppDeps> = {}): { app: Express; payments: FakePaymentsPort } {
  const payments = (over.payments as FakePaymentsPort | undefined) ?? createFakePaymentsPort()
  const app = buildApp({ checkoutRateLimit: (_req, _res, next) => next(), ...over, payments })
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

export const MI_ADDRESS = { line1: '1 Main St', line2: 'Apt 2', city: 'Traverse City', state: 'MI', postalCode: '49684' }

export function quoteBody(over: { email?: string; name?: string; address?: Record<string, unknown> } = {}) {
  return { email: over.email ?? 'Buyer@Example.com', name: over.name ?? 'Ann Buyer', address: { ...MI_ADDRESS, ...over.address } }
}

export function postQuote(app: Express, orderId: string, body: object = quoteBody()) {
  return request(app).post(`/api/v1/checkout/${orderId}/quote`).send(body)
}

/** Start a checkout (`qty` x `sku`, default 2 x BBS-STD at $49.99) and quote it. */
export async function readyToPay(
  app: Express,
  o: { qty?: number; sku?: string; address?: Record<string, unknown>; extra?: Record<string, unknown> } = {},
): Promise<{ orderId: string; quoteVersion: number; totalCents: number }> {
  const start = await postCheckout(app, { lines: [{ variantId: await variantIdBySku(o.sku ?? 'BBS-STD'), quantity: o.qty ?? 2 }], ...o.extra })
  if (start.status !== 201) throw new Error(`checkout failed: ${start.status} ${JSON.stringify(start.body)}`)
  const quote = await postQuote(app, start.body.orderId, quoteBody({ address: o.address }))
  if (quote.status !== 200) throw new Error(`quote failed: ${quote.status} ${JSON.stringify(quote.body)}`)
  return { orderId: start.body.orderId, quoteVersion: quote.body.quoteVersion, totalCents: quote.body.totalCents }
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/checkout-routes.test.ts (replace the whole file)
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { markOrderPaid } from '../src/orders/orders.service.js'
import { createRateLimiter } from '../src/lib/rate-limit.js'
import { unconfiguredPaymentsPort } from '../src/ports/payments/index.js'
import { makeApp, postCheckout, postQuote, variantIdBySku, inventoryOf, setOnHand } from './helpers/checkout.js'

const ORIGIN = 'https://staging.alpinebrickexchange.com'
beforeEach(async () => {
  await resetDb(); await seed()
  process.env.STOREFRONT_ORIGIN = ORIGIN
})
afterAll(async () => { delete process.env.STOREFRONT_ORIGIN; await prisma.$disconnect() })

describe('POST /api/v1/checkout', () => {
  it('reserves stock and returns only the order id (no provider session)', async () => {
    const { app, payments } = makeApp()
    const v = await variantIdBySku('BBS-STD') // $49.99, onHand 25
    const res = await postCheckout(app, {
      lines: [{ variantId: v, quantity: 2 }], marketingOptIn: true,
      referral: { code: 'Brick-Club', firstSeenAt: new Date(Date.now() - 86_400_000).toISOString() },
    })
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ orderId: expect.any(String) })
    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } })
    expect(order).toMatchObject({
      status: 'pending', email: 'pending@checkout.invalid', shipToState: '', subtotalCents: 9998,
      taxCents: 0, totalCents: 9998, taxJurisdiction: 'quote_pending', quoteVersion: 0,
      marketingOptIn: true, referralCode: 'brick-club', squarePaymentId: null, paymentAttemptAt: null,
    })
    expect((await inventoryOf('BBS-STD')).reserved).toBe(2)
    expect(payments.charges).toEqual([])
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

  it('503s without touching stock when payments are not configured', async () => {
    const { app } = makeApp({ payments: unconfiguredPaymentsPort })
    const res = await postCheckout(app, { lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: 1 }] })
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('checkout_unavailable')
    expect(await prisma.order.count()).toBe(0)
  })

  it('previousOrderId cancels our own pending order and releases its hold first', async () => {
    const { app } = makeApp()
    const v = await variantIdBySku('BBS-STD')
    const first = await postCheckout(app, { lines: [{ variantId: v, quantity: 3 }] })
    const second = await postCheckout(app, { lines: [{ variantId: v, quantity: 1 }], previousOrderId: first.body.orderId })
    expect(second.status).toBe(201)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: first.body.orderId } })).status).toBe('cancelled')
    expect((await inventoryOf('BBS-STD')).reserved).toBe(1)
  })

  it('ignores a previousOrderId that is already paid', async () => {
    const { app } = makeApp()
    const v = await variantIdBySku('BBS-STD')
    const first = await postCheckout(app, { lines: [{ variantId: v, quantity: 1 }] })
    await markOrderPaid(first.body.orderId)
    await postCheckout(app, { lines: [{ variantId: v, quantity: 1 }], previousOrderId: first.body.orderId })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: first.body.orderId } })).status).toBe('paid')
  })

  // Plan decision 7: another tab may be charging this order right now.
  it('leaves a previousOrderId alone while a payment attempt is in flight', async () => {
    const { app } = makeApp()
    const v = await variantIdBySku('BBS-STD')
    const first = await postCheckout(app, { lines: [{ variantId: v, quantity: 1 }] })
    await prisma.order.update({ where: { id: first.body.orderId }, data: { paymentAttemptAt: new Date() } })
    await postCheckout(app, { lines: [{ variantId: v, quantity: 1 }], previousOrderId: first.body.orderId })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: first.body.orderId } })).status).toBe('pending')
    expect((await inventoryOf('BBS-STD')).reserved).toBe(2)
  })

  it('lets exactly one of two concurrent checkouts take the last unit', async () => {
    const { app } = makeApp()
    const v = await setOnHand('CMP-LTD', 1)
    const results = await Promise.all([1, 2].map(() => postCheckout(app, { lines: [{ variantId: v, quantity: 1 }] })))
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    expect((await inventoryOf('CMP-LTD')).reserved).toBe(1)
  })

  it('rate-limits per IP, counting quotes against the same budget', async () => {
    const { app } = makeApp({ checkoutRateLimit: createRateLimiter({ limit: 2, windowMs: 60_000 }) })
    await postCheckout(app, { lines: [] })
    await postQuote(app, 'some-order', {})
    expect((await postCheckout(app, { lines: [] })).status).toBe(429)
  })

  it('400s malformed JSON as invalid_request, with CORS headers, and reserves nothing', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/v1/checkout')
      .set('Origin', ORIGIN).set('Content-Type', 'application/json').send('{"lines": [')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ code: 'invalid_request', message: expect.any(String) })
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN)
    expect(await prisma.order.count()).toBe(0)
  })

  it('leaves the admin error shape for malformed JSON unchanged', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/v1/admin/orders/x/cancel').set('Content-Type', 'application/json').send('{')
    expect(res.body.code).not.toBe('invalid_request')
  })

  it('answers the storefront preflight for the quote route without credentials', async () => {
    const { app } = makeApp()
    const res = await request(app).options('/api/v1/checkout/abc/quote')
      .set('Origin', ORIGIN).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type')
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN)
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
  })
})

describe('GET /api/v1/checkout/status', () => {
  it('reads by order id and returns non-sensitive fields only, even after the address is quoted', async () => {
    const { app } = makeApp()
    const created = await postCheckout(app, { lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: 1 }] })
    await postQuote(app, created.body.orderId)
    const res = await request(app).get(`/api/v1/checkout/status?orderId=${created.body.orderId}`)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toEqual({
      status: 'pending',
      orderNumber: expect.stringMatching(/^ABE-\d{6}$/),
      lines: [{ name: 'Brick Builder Set', sku: 'BBS-STD', quantity: 1, unitPriceCents: 4999, lineSubtotalCents: 4999 }],
      totals: { subtotalCents: 4999, shippingCents: 995, taxCents: 300, totalCents: 6294 },
    })
    const text = JSON.stringify(res.body)
    expect(text).not.toContain('@')
    expect(text).not.toContain('Main St')
  })

  it('404s an unknown order and 400s a malformed or missing id', async () => {
    const { app } = makeApp()
    expect((await request(app).get('/api/v1/checkout/status?orderId=nope')).status).toBe(404)
    expect((await request(app).get('/api/v1/checkout/status?orderId=../../x')).status).toBe(400)
    expect((await request(app).get('/api/v1/checkout/status')).status).toBe(400)
  })
})

describe('GET /api/v1/checkout/config', () => {
  it('exposes the shipping settings the cart needs', async () => {
    const { app } = makeApp()
    expect((await request(app).get('/api/v1/checkout/config')).body).toEqual({ flatRateCents: 995, freeShippingThresholdCents: 15000 })
  })
})

describe('retired public order routes', () => {
  it('404s POST and GET /api/v1/orders', async () => {
    const { app } = makeApp()
    const v = await variantIdBySku('BBS-STD')
    expect((await request(app).post('/api/v1/orders').send({ email: 'a@b.c', shipToState: 'MI', lines: [{ variantId: v, quantity: 1 }] })).status).toBe(404)
    expect((await request(app).get('/api/v1/orders/anything')).status).toBe(404)
    expect(await prisma.order.count()).toBe(0)
  })
})
```

```ts
// tests/checkout-quote.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import type { Express } from 'express'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { cancelOrder } from '../src/orders/orders.service.js'
import { unconfiguredPaymentsPort } from '../src/ports/payments/index.js'
import { CONTIGUOUS_STATES, OUTSIDE_SHIPPING_AREA } from '../src/checkout/checkout-input.js'
import { makeApp, postCheckout, postQuote, quoteBody, variantIdBySku } from './helpers/checkout.js'

beforeEach(async () => { await resetDb(); await seed() })
afterAll(() => prisma.$disconnect())

async function started(app: Express, sku = 'BBS-STD', quantity = 2): Promise<string> {
  const res = await postCheckout(app, { lines: [{ variantId: await variantIdBySku(sku), quantity }] })
  return res.body.orderId
}

describe('POST /api/v1/checkout/:orderId/quote', () => {
  it('quotes Michigan: $9.95 shipping and 6% tax on the goods only (Q3, Q8)', async () => {
    const { app } = makeApp()
    const id = await started(app) // 2 x $49.99 = $99.98
    const res = await postQuote(app, id)
    expect(res.status).toBe(200)
    // 9998 x 6% = 599.88 -> 600. Tax on goods + shipping would be 660.
    expect(res.body).toEqual({ quoteVersion: 1, subtotalCents: 9998, shippingCents: 995, taxCents: 600, totalCents: 11593 })
    expect(await prisma.order.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'pending', email: 'buyer@example.com', shipName: 'Ann Buyer', shipLine1: '1 Main St', shipLine2: 'Apt 2',
      shipCity: 'Traverse City', shipToState: 'MI', shipPostalCode: '49684',
      shippingCents: 995, taxCents: 600, taxRateBps: 600, taxJurisdiction: 'MI', totalCents: 11593, quoteVersion: 1,
    })
  })

  it('charges no tax outside Michigan', async () => {
    const { app } = makeApp()
    const id = await started(app)
    const res = await postQuote(app, id, quoteBody({ address: { state: 'CA', city: 'Fresno', postalCode: '93650' } }))
    expect(res.body).toMatchObject({ taxCents: 0, totalCents: 9998 + 995 })
    expect((await prisma.order.findUniqueOrThrow({ where: { id } })).taxJurisdiction).toBe('none')
  })

  it('gives free shipping at the threshold', async () => {
    const { app } = makeApp()
    const id = await started(app, 'ABE-1001', 1) // $189
    expect((await postQuote(app, id)).body).toEqual({ quoteVersion: 1, subtotalCents: 18900, shippingCents: 0, taxCents: 1134, totalCents: 20034 })
  })

  it('increments the quote version on every quote and keeps the latest address', async () => {
    const { app } = makeApp()
    const id = await started(app)
    await postQuote(app, id)
    const second = await postQuote(app, id, quoteBody({ address: { state: 'OH', city: 'Toledo', postalCode: '43604' } }))
    expect(second.body.quoteVersion).toBe(2)
    expect(await prisma.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ shipToState: 'OH', taxCents: 0, quoteVersion: 2 })
  })

  it('knows the 48 contiguous states plus DC', () => {
    expect(CONTIGUOUS_STATES.size).toBe(49)
    for (const s of ['AK', 'HI', 'PR']) expect(CONTIGUOUS_STATES.has(s)).toBe(false)
    expect(CONTIGUOUS_STATES.has('DC')).toBe(true)
  })

  it.each([...OUTSIDE_SHIPPING_AREA])('refuses %s with 422 outside_shipping_area before any charge, changing nothing', async (state) => {
    const { app, payments } = makeApp()
    const id = await started(app)
    const res = await postQuote(app, id, quoteBody({ address: { state } }))
    expect(res.status).toBe(422)
    expect(res.body).toMatchObject({ code: 'outside_shipping_area', message: 'We ship to the contiguous US only.' })
    expect(await prisma.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ quoteVersion: 0, shipLine1: null, email: 'pending@checkout.invalid' })
    expect(payments.charges).toEqual([])
  })

  it('refuses a non-US country with 422', async () => {
    const { app } = makeApp()
    const id = await started(app)
    const res = await postQuote(app, id, quoteBody({ address: { country: 'CA', state: 'ON' } }))
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('outside_shipping_area')
  })

  it.each([
    ['a bad email', { email: 'nope' }, 'email'],
    ['a missing name', { name: '' }, 'name'],
    ['a missing street', { address: { line1: '' } }, 'address.line1'],
    ['a blank city', { address: { city: ' ' } }, 'address.city'],
    ['an unknown state', { address: { state: 'ZZ' } }, 'address.state'],
    ['a bad ZIP', { address: { postalCode: '4968' } }, 'address.postalCode'],
  ] as const)('400s %s naming the field', async (_n, over, field) => {
    const { app } = makeApp()
    const id = await started(app)
    const res = await postQuote(app, id, quoteBody(over as Parameters<typeof quoteBody>[0]))
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'invalid_request', details: { field } })
  })

  it('409s order_expired for a cancelled order, 404s an unknown one, 400s a malformed id', async () => {
    const { app } = makeApp()
    const id = await started(app)
    await cancelOrder(id)
    expect((await postQuote(app, id)).body.code).toBe('order_expired')
    expect((await postQuote(app, 'no-such-order')).status).toBe(404)
    expect((await postQuote(app, 'bad id!')).status).toBe(400)
  })

  it('503s when payments are not configured', async () => {
    const { app } = makeApp({ payments: unconfiguredPaymentsPort })
    expect((await postQuote(app, 'anything')).status).toBe(503)
  })
})
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `npx vitest run tests/checkout-routes.test.ts tests/checkout-quote.test.ts`
Expected: FAIL. `POST /` still calls the removed `createCheckoutSession` (500), and `/quote` is a 404.

- [ ] **Step 4: Write `payment-attempt.ts`**

```ts
// src/checkout/payment-attempt.ts
/**
 * Spec §2 step 7 and the race rule: POST /checkout/:id/pay stamps
 * paymentAttemptAt before it charges. For this long afterwards, nothing of
 * ours cancels the order -- not the sweep, not a previousOrderId release,
 * not the admin Cancel (plan decision 7) -- because a charge may be landing.
 */
export const PAYMENT_ATTEMPT_GRACE_MS = 10 * 60_000

export function attemptInFlight(at: Date | null, now: Date): boolean {
  return at !== null && now.getTime() - at.getTime() < PAYMENT_ATTEMPT_GRACE_MS
}
```

- [ ] **Step 5: Rewrite `checkout-input.ts`**

```ts
// src/checkout/checkout-input.ts (replace the whole file)
import { parseReferralInput } from '../referrals/referrals.service.js'
import { normalizeEmail } from '../customers/customers.service.js'
import type { ShipToAddress } from '../ports/payments/payments.port.js'

export const MAX_LINES = 20
export const MAX_QUANTITY = 10

/** Spec §2 step 2, verbatim. */
export const CONTIGUOUS_US_NOTICE = 'We ship to the contiguous US only.'
/** Refused at quote, before any charge (spec §2 step 2). */
export const OUTSIDE_SHIPPING_AREA: ReadonlySet<string> = new Set(['AK', 'HI', 'PR', 'GU', 'VI', 'AS', 'MP', 'AA', 'AE', 'AP'])
/** The 48 contiguous states and DC. */
export const CONTIGUOUS_STATES: ReadonlySet<string> = new Set([
  'AL', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA',
  'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH',
  'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
])
/** Order ids are cuids; this only keeps junk out of queries and logs. */
export const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Public checkout error: lower_snake `code`, HTTP `status`, optional `details`. */
export class CheckoutError extends Error {
  constructor(public code: string, message: string, public status: number, public details?: Record<string, unknown>) {
    super(message)
    this.name = 'CheckoutError'
  }
}

/** One place for the public error copy (spec §5). */
export const checkoutErrors = {
  unavailable: () => new CheckoutError('checkout_unavailable', 'Checkout is temporarily unavailable — please try again in a minute.', 503),
  notFound: () => new CheckoutError('not_found', 'No checkout for that order.', 404),
  expired: () => new CheckoutError('order_expired', 'This checkout expired.', 409),
  quoteChanged: () => new CheckoutError('quote_changed', 'Your total has changed. Check it and pay again.', 409),
  paymentPending: () => new CheckoutError('payment_pending', "We're still confirming an earlier payment attempt for this order.", 409),
  tooManyAttempts: () => new CheckoutError('too_many_attempts', 'Too many payment attempts for this order. Start again from your cart.', 429),
}

export interface CheckoutRequest {
  lines: { variantId: string; quantity: number }[]
  marketingOptIn: boolean
  referral: { code: string; firstSeenAt: Date } | null
  previousOrderId: string | null
}

const invalid = (field: string, message: string) => new CheckoutError('invalid_request', message, 400, { field })

function asObject(v: unknown, field: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw invalid(field, `${field} must be a JSON object`)
  return v as Record<string, unknown>
}

/** A bad referral is dropped (parseReferralInput -> null), never rejected. */
export function parseCheckoutRequest(body: unknown, now = new Date()): CheckoutRequest {
  const b = asObject(body, 'body')
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
    previousOrderId: typeof prev === 'string' && ORDER_ID_RE.test(prev) ? prev : null,
  }
}

function text(v: unknown, field: string, max: number): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (s.length < 1 || s.length > max) throw invalid(field, `required, at most ${max} characters`)
  return s
}

export interface QuoteRequest { email: string; name: string; address: ShipToAddress }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ZIP_RE = /^\d{5}(-\d{4})?$/

/**
 * Spec §2 steps 2-3. Outside the contiguous US is 422 before anything is
 * written; a malformed field is 400 naming it.
 */
export function parseQuoteRequest(body: unknown): QuoteRequest {
  const b = asObject(body, 'body')
  const email = typeof b.email === 'string' ? b.email.trim() : ''
  if (email.length > 254 || !EMAIL_RE.test(email)) throw invalid('email', 'an email address')
  const name = text(b.name, 'name', 100)
  const a = asObject(b.address, 'address')
  const country = typeof a.country === 'string' && a.country.trim() !== '' ? a.country.trim().toUpperCase() : 'US'
  const state = typeof a.state === 'string' ? a.state.trim().toUpperCase() : ''
  if (country !== 'US' || OUTSIDE_SHIPPING_AREA.has(state)) {
    throw new CheckoutError('outside_shipping_area', CONTIGUOUS_US_NOTICE, 422, { field: 'address.state' })
  }
  const line1 = text(a.line1, 'address.line1', 100)
  const line2 = typeof a.line2 === 'string' ? a.line2.trim() : ''
  if (line2.length > 100) throw invalid('address.line2', 'at most 100 characters')
  const city = text(a.city, 'address.city', 60)
  if (!CONTIGUOUS_STATES.has(state)) throw invalid('address.state', 'a two-letter US state code')
  const postalCode = typeof a.postalCode === 'string' ? a.postalCode.trim() : ''
  if (!ZIP_RE.test(postalCode)) throw invalid('address.postalCode', 'a 5-digit ZIP code')
  return {
    email: normalizeEmail(email),
    name,
    address: { name, line1, line2: line2 || null, city, state, postalCode },
  }
}

export interface PayRequest { sourceToken: string; quoteVersion: number }

export function parsePayRequest(body: unknown): PayRequest {
  const b = asObject(body, 'body')
  if (typeof b.sourceToken !== 'string' || b.sourceToken.length < 1 || b.sourceToken.length > 1024) {
    throw invalid('sourceToken', 'a payment token')
  }
  if (typeof b.quoteVersion !== 'number' || !Number.isInteger(b.quoteVersion) || b.quoteVersion < 1) {
    throw invalid('quoteVersion', 'the quote version being paid')
  }
  return { sourceToken: b.sourceToken, quoteVersion: b.quoteVersion }
}
```

- [ ] **Step 6: Rewrite `checkout.service.ts`**

```ts
// src/checkout/checkout.service.ts (replace the whole file)
import { prisma } from '../prisma.js'
import {
  placeOrder, cancelOrderTx, lockOrderRow, enqueueInventoryPushesAfterCommit, orderNumber, OrderError, PENDING_CHECKOUT_EMAIL,
} from '../orders/orders.service.js'
import { storefrontSellable } from '../inventory/allocation.js'
import { getShopSettings } from '../settings/shop-settings.service.js'
import type { PaymentsPort } from '../ports/payments/payments.port.js'
import type { ShippingPort } from '../ports/shipping/shipping.port.js'
import type { TaxPort } from '../ports/tax/tax.port.js'
import type { EmailPort } from '../ports/email/email.port.js'
import { scrubError } from '../auth/scrub.js'
import { CheckoutError, checkoutErrors, type CheckoutRequest, type QuoteRequest } from './checkout-input.js'
import { attemptInFlight } from './payment-attempt.js'

export interface CheckoutDeps {
  payments: PaymentsPort
  shipping: ShippingPort
  tax: TaxPort
  email: EmailPort
  now?: () => Date
}

export interface LineProblem {
  variantId: string
  code: 'insufficient_stock' | 'variant_not_found'
  available?: number
}

/**
 * Tax at placement: there is no address until the quote (spec §2 step 3).
 * The '_pending' suffix keeps the console showing tax as "pending" (plan decision 9).
 */
export const BEFORE_QUOTE_TAX: TaxPort = {
  async computeTax() {
    return { taxCents: 0, rateBps: 0, jurisdiction: 'quote_pending' }
  },
}

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

/**
 * Spec §2 step 1: cancel our own pending order (onlyIfPending). There is no
 * provider session to expire. Never blocks the new checkout: failures are
 * logged, and the sweep cleans up.
 */
async function releasePreviousOrder(orderId: string, now: Date): Promise<void> {
  try {
    const cancelled = await prisma.$transaction(async (tx) => {
      const prev = await lockOrderRow(tx, orderId)
      if (!prev || prev.channel !== 'storefront' || prev.status !== 'pending') return null
      if (attemptInFlight(prev.paymentAttemptAt, now)) return null
      return cancelOrderTx(tx, orderId, 'system', { onlyIfPending: true })
    })
    if (cancelled) {
      await enqueueInventoryPushesAfterCommit(cancelled.lines.map((l) => l.variantId), `checkout.previous order:${orderId}`)
    }
  } catch (err) {
    console.error('[checkout] could not release previous order', orderId, scrubError(err))
  }
}

/**
 * Reports EVERY short line at once so the cart can mark them all. A read,
 * not a lock -- placeOrder's guarded UPDATE is the real check.
 */
async function preflight(lines: CheckoutRequest['lines']): Promise<void> {
  const variants = await prisma.variant.findMany({
    where: { id: { in: lines.map((l) => l.variantId) } },
    include: { inventory: true, product: { select: { status: true } } },
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
}

/** Spec §2 step 1: live re-pricing, reservation and a pending order. */
export async function startCheckout(req: CheckoutRequest, deps: CheckoutDeps): Promise<{ orderId: string }> {
  if (!deps.payments.configured) throw checkoutErrors.unavailable()
  const now = deps.now?.() ?? new Date()
  if (req.previousOrderId) await releasePreviousOrder(req.previousOrderId, now)
  await preflight(req.lines)
  try {
    const order = await placeOrder({
      email: PENDING_CHECKOUT_EMAIL, shipToState: '', lines: req.lines,
      marketingOptIn: req.marketingOptIn, referral: req.referral,
    }, BEFORE_QUOTE_TAX)
    return { orderId: order.id }
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
}

export interface QuoteDto { quoteVersion: number; subtotalCents: number; shippingCents: number; taxCents: number; totalCents: number }

/**
 * Spec §2 step 3. The ports are asked first, outside the transaction; the
 * write happens under the order's row lock and re-checks `pending`. Tax is
 * on the goods only (Q8), net of each line's discount.
 */
export async function quoteCheckout(orderId: string, req: QuoteRequest, deps: CheckoutDeps): Promise<QuoteDto> {
  if (!deps.payments.configured) throw checkoutErrors.unavailable()
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { lines: true } })
  if (!order || order.channel !== 'storefront') throw checkoutErrors.notFound()
  if (order.status !== 'pending') throw checkoutErrors.expired()

  const [shipping] = await deps.shipping.quote({
    subtotalCents: order.subtotalCents, lines: order.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
  })
  if (!shipping) throw checkoutErrors.unavailable()
  const tax = await deps.tax.computeTax({
    shipToState: req.address.state,
    lineItems: order.lines.map((l) => ({ amountCents: l.lineSubtotalCents - l.discountCents })),
  })

  return prisma.$transaction(async (tx) => {
    const locked = await lockOrderRow(tx, orderId)
    if (!locked || locked.status !== 'pending') throw checkoutErrors.expired()
    const next = await tx.order.update({
      where: { id: orderId },
      data: {
        email: req.email,
        shipName: req.name,
        shipLine1: req.address.line1,
        shipLine2: req.address.line2,
        shipCity: req.address.city,
        shipToState: req.address.state,
        shipPostalCode: req.address.postalCode,
        shippingCents: shipping.amountCents,
        taxCents: tax.taxCents,
        taxRateBps: tax.rateBps,
        taxJurisdiction: tax.jurisdiction,
        totalCents: locked.subtotalCents - locked.discountCents + shipping.amountCents + tax.taxCents,
        quoteVersion: { increment: 1 },
      },
    })
    return {
      quoteVersion: next.quoteVersion, subtotalCents: next.subtotalCents, shippingCents: next.shippingCents,
      taxCents: next.taxCents, totalCents: next.totalCents,
    }
  })
}

export interface CheckoutStatusDto {
  status: 'pending' | 'paid' | 'cancelled'
  orderNumber: string
  lines: { name: string; sku: string; quantity: number; unitPriceCents: number; lineSubtotalCents: number }[]
  totals: { subtotalCents: number; shippingCents: number; taxCents: number; totalCents: number }
}

/** Spec §2 step 6: by order id; no address, no email. */
export async function getCheckoutStatus(orderId: string): Promise<CheckoutStatusDto | null> {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    include: { lines: { include: { variant: { select: { attributes: true, product: { select: { name: true } } } } } } },
  })
  if (!o || o.channel !== 'storefront') return null
  // Money taken after a cancel is "confirming", not "expired", while a human sorts out the refund.
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

/** What the cart needs to say "Free shipping on orders over $X". */
export async function getCheckoutConfig(): Promise<{ flatRateCents: number; freeShippingThresholdCents: number | null }> {
  const s = await getShopSettings()
  return { flatRateCents: s.flatRateCents, freeShippingThresholdCents: s.freeThresholdCents }
}
```

- [ ] **Step 7: Rewrite `checkout.routes.ts`**

```ts
// src/checkout/checkout.routes.ts (replace the whole file)
import { Router, type Request, type RequestHandler, type Response } from 'express'
import { asyncHandler } from '../lib/async-handler.js'
import { CheckoutError, ORDER_ID_RE, checkoutErrors, parseCheckoutRequest, parseQuoteRequest } from './checkout-input.js'
import { startCheckout, quoteCheckout, getCheckoutStatus, getCheckoutConfig, type CheckoutDeps } from './checkout.service.js'

function send(res: Response, err: CheckoutError) {
  return res.status(err.status).json({ code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) })
}

export function orderIdOf(raw: unknown): string {
  if (typeof raw !== 'string' || !ORDER_ID_RE.test(raw)) throw new CheckoutError('invalid_request', 'an order id', 400, { field: 'orderId' })
  return raw
}

/** Every public checkout answer is per shopper: never cached, and errors use the public envelope. */
export function json(status: number, fn: (req: Request) => Promise<unknown>): RequestHandler {
  return asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      res.status(status).json(await fn(req))
    } catch (err) {
      if (err instanceof CheckoutError) return send(res, err)
      throw err
    }
  })
}

/**
 * Public, storefront CORS, no credentials. Mounted in app.ts. Start, quote
 * and pay share one per-IP limiter (plan decision 6).
 */
export function createCheckoutRouter(deps: CheckoutDeps & { rateLimit: RequestHandler }): Router {
  const router = Router()
  router.post('/', deps.rateLimit, json(201, (req) => startCheckout(parseCheckoutRequest(req.body), deps)))
  router.post('/:orderId/quote', deps.rateLimit, json(200, (req) =>
    quoteCheckout(orderIdOf(req.params.orderId), parseQuoteRequest(req.body), deps)))
  router.get('/status', json(200, async (req) => {
    const status = await getCheckoutStatus(orderIdOf(req.query.orderId))
    if (!status) throw checkoutErrors.notFound()
    return status
  }))
  router.get('/config', json(200, () => getCheckoutConfig()))
  return router
}
```

- [ ] **Step 8: Wire `app.ts`**

In `src/app.ts`:
- Add the imports `import { createFlatRateTaxPort } from './ports/tax/flat-rate.adapter.js'` and `import type { TaxPort } from './ports/tax/tax.port.js'`.
- Replace the `AppDeps` interface with:

```ts
export interface AppDeps {
  payments: PaymentsPort
  shipping: ShippingPort
  /** Checkout tax: Michigan 6% on goods, $0 elsewhere (spec Q3, Q8). */
  tax: TaxPort
  email: EmailPort
  checkoutRateLimit: RequestHandler
}
```

- In `buildApp`, delete the two `storefrontUrl` lines and add `const tax = deps.tax ?? createFlatRateTaxPort()` after `shipping`. In the first comment of `buildApp`, change "half-configured Stripe" to "partial Square config (spec 2026-09-28 §4)".
- Change the checkout mount to `app.use('/api/v1/checkout', createCheckoutRouter({ payments, shipping, tax, email, rateLimit: checkoutRateLimit }))`. In its comment, replace "POST is rate-limited per IP inside the router" with "start, quote and pay are rate-limited per IP inside the router".

- [ ] **Step 9: Delete the deferred tax adapter and repoint its users**

```bash
git rm src/ports/tax/deferred.adapter.ts
```

In `tests/orders-checkout-support.test.ts`:
- Replace `import { deferredTaxAdapter } from '../src/ports/tax/deferred.adapter.js'` with `import { BEFORE_QUOTE_TAX } from '../src/checkout/checkout.service.js'`.
- Replace every other `deferredTaxAdapter` with `BEFORE_QUOTE_TAX` (lines 18, 29, 330, 339, 349).
- Rename the test `'records opt-in and referral, with tax deferred to Stripe'` to `'records opt-in and referral, with tax left for the quote'`, and change its `taxJurisdiction: 'stripe_tax_pending'` to `taxJurisdiction: 'quote_pending'`.

In `tests/capture-admin-fixtures.test.ts`:
- Make the same import swap and change `}, deferredTaxAdapter)` to `}, BEFORE_QUOTE_TAX)`.
- In the `markOrderPaidTx` data, change `taxJurisdiction: 'stripe_tax', taxRateBps: 600, stripePaymentIntentId: 'pi_test_fixture',` to `taxJurisdiction: 'MI', taxRateBps: 600, squarePaymentId: 'sqpay_fixture', quoteVersion: 1,`.

- [ ] **Step 10: Run the tests**

Run: `npx vitest run tests/checkout-routes.test.ts tests/checkout-quote.test.ts tests/orders-checkout-support.test.ts tests/capture-admin-fixtures.test.ts tests/tax.test.ts tests/rate-limit.test.ts`
Expected: PASS (the capture file reports its suite as skipped).

- [ ] **Step 11: Commit**

```bash
git add src/checkout src/app.ts src/ports/tax tests/helpers/checkout.ts tests/checkout-routes.test.ts tests/checkout-quote.test.ts \
  tests/orders-checkout-support.test.ts tests/capture-admin-fixtures.test.ts
git commit -m "feat(core): checkout returns the order id; quote route with contiguous-US check and Michigan tax on goods" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: Pay route — stamp, charge, mark paid; declines, stale quotes, expiry, replays

**Files:**
- Create: `systems/core/src/payments/complete-payment.ts`, `src/checkout/pay.service.ts`
- Modify: `systems/core/src/checkout/checkout.routes.ts` (add the pay route)
- Modify: `systems/core/tests/helpers/checkout.ts` (append)
- Test: `systems/core/tests/checkout-pay.test.ts`

**Interfaces:**
- Consumes: `CheckoutDeps`, `getCheckoutStatus`, `CheckoutStatusDto` (Task 3); `checkoutErrors`, `CheckoutError`, `PayRequest`, `parsePayRequest` (Task 3); `orderIdOf`, `json` (Task 3 routes); `PaymentsPort.charge`, `ChargeResult`, `ShipToAddress`, `PaymentAttemptConflictError` (Task 2); `lockOrderRow`, `markOrderPaidTx`, `orderNumber` (existing); `upsertCustomerFromCheckout`, `resolveReferral`, `recordAudit` (existing).
- Produces (`complete-payment.ts`): `type FollowUp = () => Promise<void>`; `interface CompletedPayment { paymentId: string; amountCents: number }`; `type CompletionOutcome = 'paid' | 'already_paid' | 'paid_after_cancel' | 'not_applied'`; `applyCompletedPayment(tx: Prisma.TransactionClient, orderId: string, payment: CompletedPayment, deps: { email: EmailPort }): Promise<{ outcome: CompletionOutcome; followUp: FollowUp | null }>`. Task 6 relies on this.
- Produces (`pay.service.ts`): `MAX_PAYMENT_ATTEMPTS = 10`; `type PayResult = (Omit<CheckoutStatusDto, 'status'> & { status: 'paid' }) | { status: 'processing' }`; `payForOrder(orderId: string, req: PayRequest, deps: CheckoutDeps): Promise<PayResult>`.
- Produces (route): `POST /api/v1/checkout/:orderId/pay { sourceToken, quoteVersion }` → 200 `PayResult`, or 400 / 402 / 404 / 409 / 429 / 503 per Global Constraints.
- Produces (helpers): `postPay(app, orderId, body)`; `paidOrder(app, o?)`, which returns the paid `Order` row.

- [ ] **Step 1: Append the helpers**

```ts
// tests/helpers/checkout.ts (append)
export function postPay(app: Express, orderId: string, body: Record<string, unknown>) {
  return request(app).post(`/api/v1/checkout/${orderId}/pay`).send(body)
}

/** readyToPay, then pay with the fake's default outcome (completed). Returns the paid order row. */
export async function paidOrder(app: Express, o: Parameters<typeof readyToPay>[1] = {}) {
  const r = await readyToPay(app, o)
  const res = await postPay(app, r.orderId, { sourceToken: `tok_${r.orderId}`, quoteVersion: r.quoteVersion })
  if (res.body.status !== 'paid') throw new Error(`pay failed: ${res.status} ${JSON.stringify(res.body)}`)
  return prisma.order.findUniqueOrThrow({ where: { id: r.orderId } })
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/checkout-pay.test.ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { cancelOrder } from '../src/orders/orders.service.js'
import { unconfiguredPaymentsPort } from '../src/ports/payments/index.js'
import type { EmailPort } from '../src/ports/email/email.port.js'
import { makeApp, readyToPay, postPay, postQuote, postCheckout, variantIdBySku, inventoryOf } from './helpers/checkout.js'

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(async () => {
  await resetDb(); await seed()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterAll(async () => { errorSpy.mockRestore(); await prisma.$disconnect() })

function setup() {
  const email: EmailPort = { orderPaid: vi.fn(async () => {}) }
  return { ...makeApp({ email }), email }
}
const order = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } })

describe('POST /api/v1/checkout/:orderId/pay', () => {
  it('charges the quoted total once and marks the order paid (§2 step 5.4)', async () => {
    const { app, payments, email } = setup()
    const r = await readyToPay(app, { extra: { marketingOptIn: true } })
    const res = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      status: 'paid',
      orderNumber: expect.stringMatching(/^ABE-\d{6}$/),
      lines: [{ name: 'Brick Builder Set', sku: 'BBS-STD', quantity: 2, unitPriceCents: 4999, lineSubtotalCents: 9998 }],
      totals: { subtotalCents: 9998, shippingCents: 995, taxCents: 600, totalCents: 11593 },
    })
    expect(payments.charges).toEqual([{
      sourceToken: 'tok_a', amountCents: 11593, idempotencyKey: `${r.orderId}:1:0`, referenceId: r.orderId,
      buyerEmail: 'buyer@example.com',
      shippingAddress: { name: 'Ann Buyer', line1: '1 Main St', line2: 'Apt 2', city: 'Traverse City', state: 'MI', postalCode: '49684' },
    }])
    expect(payments.charges[0].idempotencyKey.length).toBeLessThanOrEqual(45)
    expect(r.orderId.length).toBeLessThanOrEqual(40)

    const paid = await order(r.orderId)
    expect(paid).toMatchObject({ status: 'paid', squarePaymentId: payments.paymentFor(r.orderId).id, reviewReason: null, paymentAttemptCount: 0 })
    expect(paid.paidAt).toBeInstanceOf(Date)
    expect(paid.paymentAttemptAt).toBeInstanceOf(Date)
    expect(await inventoryOf('BBS-STD')).toMatchObject({ onHand: 25, reserved: 2 }) // paid keeps the hold
    const customer = await prisma.customer.findUniqueOrThrow({ where: { email: 'buyer@example.com' } })
    expect(paid.customerId).toBe(customer.id)
    expect(customer.marketingConsent).toBe(true)
    expect(email.orderPaid).toHaveBeenCalledWith({ orderId: r.orderId, orderNumber: expect.stringMatching(/^ABE-/), email: 'buyer@example.com' })
  })

  it('402s a decline with our copy, keeps the order pending, and a new card gets a new key', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    payments.nextOutcomes = ['declined']
    const declined = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(declined.status).toBe(402)
    expect(declined.body).toEqual({ code: 'payment_declined', message: 'Your card was declined — try another card.' })
    expect(await order(r.orderId)).toMatchObject({ status: 'pending', paymentAttemptCount: 1 })

    const retry = await postPay(app, r.orderId, { sourceToken: 'tok_b', quoteVersion: r.quoteVersion })
    expect(retry.body.status).toBe('paid')
    expect(payments.charges.map((c) => c.idempotencyKey)).toEqual([`${r.orderId}:1:0`, `${r.orderId}:1:1`])
  })

  it('409s quote_changed for a stale or missing quote, before any charge', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    await postQuote(app, r.orderId) // now version 2
    const stale = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: 1 })
    expect(stale.status).toBe(409)
    expect(stale.body.code).toBe('quote_changed')

    const unquoted = await postCheckout(app, { lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: 1 }] })
    expect((await postPay(app, unquoted.body.orderId, { sourceToken: 'tok_a', quoteVersion: 1 })).body.code).toBe('quote_changed')
    expect(payments.charges).toEqual([])
  })

  it('409s order_expired for an order the sweep or an admin cancelled, before any charge', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    await cancelOrder(r.orderId)
    const res = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('order_expired')
    expect(payments.charges).toEqual([])
  })

  it('answers a repeated pay for a paid order from the database, without charging again (plan decision 4)', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    const again = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(again.body.status).toBe('paid')
    expect(payments.charges).toHaveLength(1)
  })

  it('an unknown outcome is 503; retrying with the same token reuses the key and Square replays the charge', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    payments.nextOutcomes = ['lost']
    const first = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(first.status).toBe(503)
    expect(first.body.code).toBe('checkout_unavailable')
    expect(await order(r.orderId)).toMatchObject({ status: 'pending', paymentAttemptCount: 0 })

    const retry = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(retry.body.status).toBe('paid')
    expect(payments.payments.size).toBe(1) // one charge at Square, not two
    expect(new Set(payments.charges.map((c) => c.idempotencyKey)).size).toBe(1)
  })

  it('a new token after an unknown outcome is 409 payment_pending, never a second charge (plan decision 3)', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    payments.nextOutcomes = ['lost']
    await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    const res = await postPay(app, r.orderId, { sourceToken: 'tok_b', quoteVersion: r.quoteVersion })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('payment_pending')
    expect(payments.payments.size).toBe(1)
    expect((await order(r.orderId)).status).toBe('pending') // the webhook settles it (Task 6)
  })

  it('503s when Square is unreachable and leaves the order pending with the attempt stamped', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    payments.nextOutcomes = ['unavailable']
    const res = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(res.status).toBe(503)
    const o = await order(r.orderId)
    expect(o.status).toBe('pending')
    expect(o.paymentAttemptAt).toBeInstanceOf(Date)
  })

  it('a non-final status answers processing and records the payment id', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    payments.nextOutcomes = ['processing']
    const res = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(res.body).toEqual({ status: 'processing' })
    expect(await order(r.orderId)).toMatchObject({ status: 'pending', squarePaymentId: payments.paymentFor(r.orderId).id })
  })

  it('still marks paid, but flags amount_mismatch, when the order total moved during the charge (plan decision 5)', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    payments.duringCharge = async () => { await prisma.order.update({ where: { id: r.orderId }, data: { totalCents: 1 } }) }
    await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(await order(r.orderId)).toMatchObject({ status: 'paid', reviewReason: 'amount_mismatch' })
  })

  it('resolves a seeded referral at payment and flags an unknown one', async () => {
    const { app } = setup()
    const partner = await prisma.affiliatePartner.create({ data: { name: 'Brick Club' } })
    await prisma.referralCode.create({ data: { code: 'club', partnerId: partner.id, commissionRateBps: 800 } })
    const seen = new Date(Date.now() - 3_600_000).toISOString()
    const cases = [
      ['club', { affiliatePartnerId: partner.id, commissionRateBps: 800, referralUnmatched: false }],
      ['nobody', { affiliatePartnerId: null, commissionRateBps: null, referralUnmatched: true }],
    ] as const
    for (const [code, expected] of cases) {
      const r = await readyToPay(app, { qty: 1, extra: { referral: { code, firstSeenAt: seen } } })
      await postPay(app, r.orderId, { sourceToken: `tok_${code}`, quoteVersion: r.quoteVersion })
      expect(await order(r.orderId)).toMatchObject(expected)
    }
  })

  it('429s too_many_attempts after 10 declines (plan decision 6)', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    await prisma.order.update({ where: { id: r.orderId }, data: { paymentAttemptCount: 10 } })
    const res = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(res.status).toBe(429)
    expect(res.body.code).toBe('too_many_attempts')
    expect(payments.charges).toEqual([])
  })

  it.each([
    ['no token', { quoteVersion: 1 }, 'sourceToken'],
    ['no quote version', { sourceToken: 't' }, 'quoteVersion'],
    ['quote version 0', { sourceToken: 't', quoteVersion: 0 }, 'quoteVersion'],
  ] as const)('400s %s', async (_n, body, field) => {
    const { app } = setup()
    const r = await readyToPay(app)
    const res = await postPay(app, r.orderId, body)
    expect(res.status).toBe(400)
    expect(res.body.details).toEqual({ field })
  })

  it('404s an unknown order and 503s when payments are not configured', async () => {
    const { app } = setup()
    expect((await postPay(app, 'no-such-order', { sourceToken: 't', quoteVersion: 1 })).status).toBe(404)
    const { app: bare } = makeApp({ payments: unconfiguredPaymentsPort })
    expect((await postPay(bare, 'no-such-order', { sourceToken: 't', quoteVersion: 1 })).status).toBe(503)
  })
})
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npx vitest run tests/checkout-pay.test.ts`
Expected: FAIL. `/pay` is a 404.

- [ ] **Step 4: Write `complete-payment.ts`**

```ts
// src/payments/complete-payment.ts
import type { Prisma } from '@prisma/client'
import { recordAudit } from '../audit.js'
import { lockOrderRow, markOrderPaidTx, orderNumber } from '../orders/orders.service.js'
import { upsertCustomerFromCheckout } from '../customers/customers.service.js'
import { resolveReferral } from '../referrals/referrals.service.js'
import type { EmailPort } from '../ports/email/email.port.js'
import { scrubError } from '../auth/scrub.js'

/** Work to run after the transaction commits (email). */
export type FollowUp = () => Promise<void>
export interface CompletedPayment { paymentId: string; amountCents: number }
export type CompletionOutcome = 'paid' | 'already_paid' | 'paid_after_cancel' | 'not_applied'

/**
 * A COMPLETED Square payment, applied to its order inside the caller's
 * transaction. The pay route (spec §2 step 5.4) and payment.updated (§3)
 * share this, so a crash between the charge and the write is repaired by
 * the webhook with the same code. It is safe to repeat and to receive in any order.
 */
export async function applyCompletedPayment(
  tx: Prisma.TransactionClient,
  orderId: string,
  payment: CompletedPayment,
  deps: { email: EmailPort },
): Promise<{ outcome: CompletionOutcome; followUp: FollowUp | null }> {
  const order = await lockOrderRow(tx, orderId)
  if (!order || order.channel !== 'storefront') return { outcome: 'not_applied', followUp: null }
  const target = `order:${order.id}`

  if (order.status !== 'pending' && order.squarePaymentId === payment.paymentId) {
    return { outcome: 'already_paid', followUp: null }
  }

  if (order.status === 'cancelled') {
    // Money taken for an order already cancelled. Our own code cannot get
    // here (race rule, §2); it is recorded for a human to refund.
    const customer = await upsertCustomerFromCheckout({ email: order.email, name: order.shipName, consent: order.marketingOptIn }, tx)
    await tx.order.update({
      where: { id: order.id },
      data: { squarePaymentId: payment.paymentId, paidAt: new Date(), customerId: customer.id, reviewReason: 'paid_after_cancel' },
    })
    await recordAudit({ actorId: 'system', action: 'order.paid_after_cancel', target, after: { squarePaymentId: payment.paymentId } }, tx)
    console.error(`[payments] order ${order.id} was PAID AFTER IT WAS CANCELLED -- refund it in the payment dashboard`)
    return { outcome: 'paid_after_cancel', followUp: null }
  }

  if (order.status !== 'pending') {
    // Paid (or further along) through a DIFFERENT payment: a second charge.
    await recordAudit({ actorId: 'system', action: 'order.duplicate_payment', target, after: { squarePaymentId: payment.paymentId } }, tx)
    console.error(`[payments] order ${order.id} is ${order.status}, but payment ${payment.paymentId} also completed for it -- refund the duplicate in the payment dashboard`)
    return { outcome: 'not_applied', followUp: null }
  }

  const mismatch = payment.amountCents !== order.totalCents
  if (mismatch) console.error(`[payments] order ${order.id} amount mismatch: charged ${payment.amountCents}, order total ${order.totalCents}`)
  const paid = await markOrderPaidTx(tx, order.id, 'system', {
    squarePaymentId: payment.paymentId,
    paidAt: new Date(),
    reviewReason: mismatch ? 'amount_mismatch' : null,
  })

  const customer = await upsertCustomerFromCheckout({ email: order.email, name: order.shipName, consent: order.marketingOptIn }, tx)
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

  return {
    outcome: 'paid',
    followUp: async () => {
      try {
        await deps.email.orderPaid({ orderId: paid.id, orderNumber: orderNumber(paid.number), email: order.email })
      } catch (err) {
        console.error('[payments] orderPaid email failed', paid.id, scrubError(err))
      }
    },
  }
}
```

- [ ] **Step 5: Write `pay.service.ts`**

```ts
// src/checkout/pay.service.ts
import { prisma } from '../prisma.js'
import { lockOrderRow } from '../orders/orders.service.js'
import { PaymentAttemptConflictError, type ChargeResult, type ShipToAddress } from '../ports/payments/payments.port.js'
import { applyCompletedPayment } from '../payments/complete-payment.js'
import { scrubError } from '../auth/scrub.js'
import { CheckoutError, checkoutErrors, type PayRequest } from './checkout-input.js'
import { getCheckoutStatus, type CheckoutDeps, type CheckoutStatusDto } from './checkout.service.js'

/** Plan decision 6: the number of declines after which an order stops taking attempts. */
export const MAX_PAYMENT_ATTEMPTS = 10

export type PayResult = (Omit<CheckoutStatusDto, 'status'> & { status: 'paid' }) | { status: 'processing' }

type Attempt =
  | { replay: true }
  | { replay: false; key: string; attemptCount: number; amountCents: number; email: string; address: ShipToAddress }

/** What the shopper should see for this order now, read from the database. */
async function currentResult(orderId: string): Promise<PayResult> {
  const s = await getCheckoutStatus(orderId)
  return s?.status === 'paid' ? { ...s, status: 'paid' } : { status: 'processing' }
}

/**
 * Spec §2 step 5. The lock-check-stamp commits BEFORE the charge, so a sweep
 * running during the charge sees paymentAttemptAt and skips the order. A
 * sweep that won the lock first leaves this answering order_expired before
 * any charge (the race rule).
 */
export async function payForOrder(orderId: string, req: PayRequest, deps: CheckoutDeps): Promise<PayResult> {
  if (!deps.payments.configured) throw checkoutErrors.unavailable()
  const now = deps.now?.() ?? new Date()

  const attempt = await prisma.$transaction(async (tx): Promise<Attempt> => {
    const o = await lockOrderRow(tx, orderId)
    if (!o || o.channel !== 'storefront') throw checkoutErrors.notFound()
    // A lost 200, retried (plan decision 4): answer from the database.
    if (o.status === 'paid' && o.quoteVersion === req.quoteVersion) return { replay: true }
    if (o.status !== 'pending') throw checkoutErrors.expired()
    if (o.quoteVersion === 0 || o.quoteVersion !== req.quoteVersion || !o.shipLine1) throw checkoutErrors.quoteChanged()
    if (o.paymentAttemptCount >= MAX_PAYMENT_ATTEMPTS) throw checkoutErrors.tooManyAttempts()
    await tx.order.update({ where: { id: orderId }, data: { paymentAttemptAt: now } })
    return {
      replay: false,
      key: `${o.id}:${o.quoteVersion}:${o.paymentAttemptCount}`,
      attemptCount: o.paymentAttemptCount,
      amountCents: o.totalCents,
      email: o.email,
      address: {
        name: o.shipName ?? '', line1: o.shipLine1, line2: o.shipLine2, city: o.shipCity ?? '',
        state: o.shipToState, postalCode: o.shipPostalCode ?? '',
      },
    }
  })
  if (attempt.replay) return currentResult(orderId)

  let result: ChargeResult
  try {
    result = await deps.payments.charge({
      sourceToken: req.sourceToken, amountCents: attempt.amountCents, idempotencyKey: attempt.key,
      referenceId: orderId, buyerEmail: attempt.email, shippingAddress: attempt.address,
    })
  } catch (err) {
    if (err instanceof PaymentAttemptConflictError) throw checkoutErrors.paymentPending()
    // Unknown outcome. The count, and so the key, is left alone: a retry with
    // the same token replays Square's answer (plan decision 3).
    console.error('[checkout] payment request failed', orderId, scrubError(err))
    throw checkoutErrors.unavailable()
  }

  if (result.outcome === 'declined') {
    // Guarded on the count this attempt used, so two racing declines move it once.
    await prisma.order.updateMany({
      where: { id: orderId, status: 'pending', paymentAttemptCount: attempt.attemptCount },
      data: { paymentAttemptCount: { increment: 1 } },
    })
    throw new CheckoutError('payment_declined', result.message, 402)
  }

  if (result.outcome === 'processing') {
    await prisma.order.updateMany({ where: { id: orderId, squarePaymentId: null }, data: { squarePaymentId: result.paymentId } })
    return { status: 'processing' }
  }

  const completed = { paymentId: result.paymentId, amountCents: result.amountCents }
  const { followUp } = await prisma.$transaction((tx) => applyCompletedPayment(tx, orderId, completed, deps))
  if (followUp) await followUp()
  return currentResult(orderId)
}
```

- [ ] **Step 6: Mount the route**

In `src/checkout/checkout.routes.ts`:
- Add `parsePayRequest` to the `./checkout-input.js` import.
- Add `import { payForOrder } from './pay.service.js'`.
- Add this after the quote route:

```ts
  router.post('/:orderId/pay', deps.rateLimit, json(200, (req) =>
    payForOrder(orderIdOf(req.params.orderId), parsePayRequest(req.body), deps)))
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/checkout-pay.test.ts tests/checkout-routes.test.ts tests/checkout-quote.test.ts tests/customers.test.ts tests/referrals.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/payments/complete-payment.ts src/checkout/pay.service.ts src/checkout/checkout.routes.ts tests/helpers/checkout.ts tests/checkout-pay.test.ts
git commit -m "feat(core): pay route — attempt stamp, Square charge with a per-attempt idempotency key, decline and replay handling" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 5: Sweep — no provider call, attempt-aware, re-checked under the row lock

**Files:**
- Modify (rewrite): `systems/core/src/checkout/sweep.ts`
- Modify (rewrite): `systems/core/tests/checkout-sweep.test.ts`

**Interfaces:**
- Consumes: `PAYMENT_ATTEMPT_GRACE_MS`, `attemptInFlight` (Task 3); `lockOrderRow`, `cancelOrderTx`, `enqueueInventoryPushesAfterCommit` (existing); `getShopSettings` (existing); `PaymentsPort['configured']` (Task 2); test helpers `makeApp`, `readyToPay`, `postPay`, `postCheckout`, `variantIdBySku`, `inventoryOf` (Tasks 3–4).
- Produces: `SWEEP_INTERVAL_MS`; `sweepAbandonedCheckouts(now?: Date): Promise<{ cancelled: string[]; skipped: string[] }>` (**no payments parameter**); `startCheckoutSweep(payments: Pick<PaymentsPort, 'configured'>, intervalMs?: number): () => void` (signature unchanged for `server.ts`). `SWEEP_GRACE_MINUTES` is removed.

- [ ] **Step 1: Write the failing test**

```ts
// tests/checkout-sweep.test.ts (replace the whole file)
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

vi.mock('../src/channels/walmart/inventory.sync.js', async (importOriginal) => {
  const actual: any = await importOriginal()
  return { ...actual, enqueueInventoryPush: vi.fn(actual.enqueueInventoryPush) }
})
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { markOrderPaid } from '../src/orders/orders.service.js'
import { enqueueInventoryPush } from '../src/channels/walmart/inventory.sync.js'
import { unconfiguredPaymentsPort } from '../src/ports/payments/index.js'
import { sweepAbandonedCheckouts, startCheckoutSweep } from '../src/checkout/sweep.js'
import { makeApp, postCheckout, readyToPay, postPay, variantIdBySku, inventoryOf } from './helpers/checkout.js'

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(async () => {
  await resetDb(); await seed()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(enqueueInventoryPush).mockClear()
})
afterAll(async () => { errorSpy.mockRestore(); await prisma.$disconnect() })

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)
const age = (id: string, minutes: number) => prisma.order.update({ where: { id }, data: { createdAt: minutesAgo(minutes) } })

async function pendingAged(minutes: number, qty = 1): Promise<string> {
  const { app } = makeApp()
  const res = await postCheckout(app, { lines: [{ variantId: await variantIdBySku('BBS-STD'), quantity: qty }] })
  await age(res.body.orderId, minutes)
  return res.body.orderId
}

describe('sweepAbandonedCheckouts', () => {
  it('cancels a pending order older than the session lifetime (30 min) with no payment attempt', async () => {
    const id = await pendingAged(31, 2)
    vi.mocked(enqueueInventoryPush).mockClear()
    expect(await sweepAbandonedCheckouts()).toEqual({ cancelled: [id], skipped: [] })
    expect((await prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('cancelled')
    expect((await inventoryOf('BBS-STD')).reserved).toBe(0)
    expect(enqueueInventoryPush).toHaveBeenCalledWith(await variantIdBySku('BBS-STD'))
  })

  it('leaves an order younger than the session lifetime alone', async () => {
    await pendingAged(29)
    expect(await sweepAbandonedCheckouts()).toEqual({ cancelled: [], skipped: [] })
  })

  it('waits 10 minutes after the last payment attempt, then cancels', async () => {
    const id = await pendingAged(45)
    await prisma.order.update({ where: { id }, data: { paymentAttemptAt: minutesAgo(9) } })
    expect(await sweepAbandonedCheckouts()).toEqual({ cancelled: [], skipped: [] })
    await prisma.order.update({ where: { id }, data: { paymentAttemptAt: minutesAgo(11) } })
    expect(await sweepAbandonedCheckouts()).toEqual({ cancelled: [id], skipped: [] })
  })

  // Spec §2 race rule: pay stamps paymentAttemptAt and commits before charging.
  it('skips an order whose charge is in flight, and the charge completes', async () => {
    const { app, payments } = makeApp()
    const r = await readyToPay(app)
    await age(r.orderId, 45)
    let during: Awaited<ReturnType<typeof sweepAbandonedCheckouts>> | null = null
    payments.duringCharge = async () => { during = await sweepAbandonedCheckouts() }
    const res = await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    expect(during).toEqual({ cancelled: [], skipped: [] })
    expect(res.body.status).toBe('paid')
    expect((await inventoryOf('BBS-STD')).reserved).toBe(2)
  })

  it('re-checks the attempt under the row lock (stamped after the sweep read it)', async () => {
    const id = await pendingAged(45)
    await prisma.order.update({ where: { id }, data: { paymentAttemptAt: new Date() } })
    // The unlocked read predates the stamp: make it return the order anyway.
    vi.spyOn(prisma.order, 'findMany').mockResolvedValueOnce([{ id }] as never)
    expect(await sweepAbandonedCheckouts()).toEqual({ cancelled: [], skipped: [id] })
    expect((await prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('pending')
  })

  it('never cancels an order that became paid after the read', async () => {
    const id = await pendingAged(45)
    await markOrderPaid(id)
    vi.spyOn(prisma.order, 'findMany').mockResolvedValueOnce([{ id }] as never)
    expect(await sweepAbandonedCheckouts()).toEqual({ cancelled: [], skipped: [id] })
    expect(await prisma.auditLog.count({ where: { action: 'order.cancelled', target: `order:${id}` } })).toBe(0)
  })

  it('never touches Walmart orders', async () => {
    const w = await prisma.order.create({ data: {
      channel: 'walmart', externalOrderId: 'PO-1', email: 'w@example.com', shipToState: 'MI',
      subtotalCents: 100, taxCents: 0, totalCents: 100, taxRateBps: 0, taxJurisdiction: 'none', createdAt: minutesAgo(180),
    } })
    expect(await sweepAbandonedCheckouts()).toEqual({ cancelled: [], skipped: [] })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: w.id } })).status).toBe('pending')
  })

  it('does not start without payments, and starts (returning a stop function) with them', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    startCheckoutSweep(unconfiguredPaymentsPort)()
    expect(logSpy.mock.calls.join(' ')).toContain('not started')
    const stop = startCheckoutSweep({ configured: true }, 60_000)
    expect(typeof stop).toBe('function')
    stop()
    logSpy.mockRestore()
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/checkout-sweep.test.ts`
Expected: FAIL. The old sweep takes a payments argument and calls `retrieveCheckoutSession`.

- [ ] **Step 3: Rewrite the sweep**

```ts
// src/checkout/sweep.ts (replace the whole file)
import { prisma } from '../prisma.js'
import { cancelOrderTx, lockOrderRow, enqueueInventoryPushesAfterCommit } from '../orders/orders.service.js'
import { getShopSettings } from '../settings/shop-settings.service.js'
import type { PaymentsPort } from '../ports/payments/payments.port.js'
import { scrubError } from '../auth/scrub.js'
import { PAYMENT_ATTEMPT_GRACE_MS, attemptInFlight } from './payment-attempt.js'

export const SWEEP_INTERVAL_MS = 5 * 60_000
const BATCH = 100

/**
 * Spec §2 step 7. Cancels (onlyIfPending) pending STOREFRONT orders older
 * than checkout.session_minutes whose paymentAttemptAt is null or older than
 * 10 minutes. It makes no provider call: an unpaid order is simply our
 * pending row. The attempt check is repeated under the row lock, because
 * pay may stamp the order between the read below and the lock (race rule).
 */
export async function sweepAbandonedCheckouts(now = new Date()): Promise<{ cancelled: string[]; skipped: string[] }> {
  const { sessionMinutes } = await getShopSettings()
  const createdBefore = new Date(now.getTime() - sessionMinutes * 60_000)
  const attemptBefore = new Date(now.getTime() - PAYMENT_ATTEMPT_GRACE_MS)
  const stale = await prisma.order.findMany({
    where: {
      status: 'pending', channel: 'storefront', createdAt: { lt: createdBefore },
      OR: [{ paymentAttemptAt: null }, { paymentAttemptAt: { lt: attemptBefore } }],
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  })
  const cancelled: string[] = []
  const skipped: string[] = []
  for (const { id } of stale) {
    try {
      const released = await prisma.$transaction(async (tx) => {
        const o = await lockOrderRow(tx, id)
        if (!o || o.status !== 'pending' || attemptInFlight(o.paymentAttemptAt, now)) return null
        return cancelOrderTx(tx, id, 'system', { onlyIfPending: true })
      })
      if (!released) {
        skipped.push(id)
        continue
      }
      cancelled.push(id)
      await enqueueInventoryPushesAfterCommit(released.lines.map((l) => l.variantId), `checkout.sweep order:${id}`)
    } catch (err) {
      console.error('[checkout-sweep] failed for order', id, scrubError(err))
      skipped.push(id)
    }
  }
  return { cancelled, skipped }
}

/** Runs in the web process; core-worker is Walmart-only and unprovisioned. */
export function startCheckoutSweep(payments: Pick<PaymentsPort, 'configured'>, intervalMs = SWEEP_INTERVAL_MS): () => void {
  if (!payments.configured) {
    console.log('checkout sweep: payments are not configured -- not started')
    return () => {}
  }
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    sweepAbandonedCheckouts()
      .then((r) => { if (r.cancelled.length) console.log(`checkout sweep: cancelled ${r.cancelled.length} abandoned order(s)`) })
      .catch((err) => console.error('[checkout-sweep] run failed', scrubError(err)))
      .finally(() => { running = false })
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/checkout-sweep.test.ts tests/checkout-pay.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/checkout/sweep.ts tests/checkout-sweep.test.ts
git commit -m "feat(core): sweep cancels abandoned checkouts without a provider call and skips in-flight payments" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 6: Square webhook — verification, de-duplication, the five events

**Files:**
- Create: `systems/core/src/payments/square-events.ts`, `src/payments/square-webhook.routes.ts`
- Modify: `systems/core/src/app.ts` (mount the route where the Stripe one was)
- Modify: `systems/core/tests/helpers/checkout.ts` (append; add one import)
- Test: `systems/core/tests/square-webhook.test.ts`

**Interfaces:**
- Consumes: `applyCompletedPayment`, `FollowUp` (Task 4); `PaymentsPort.verifyWebhook`, `listPaymentRefunds`, `locationId`, `WebhookSignatureError`, `RefundSummary` (Task 2); `refundOrderTx`, `lockOrderRow`, `enqueueInventoryPushesAfterCommit`, `OrderError` (existing); `recordAudit` (existing); `prisma.paymentEvent` (Task 1); `FAKE_LOCATION_ID` (Task 2); helpers `makeApp`, `readyToPay`, `postPay`, `paidOrder`, `inventoryOf`, `variantIdBySku` (Tasks 3–4).
- Produces (`square-events.ts`): `HANDLED_EVENTS: ReadonlySet<string>` (`payment.updated`, `refund.created`, `refund.updated`, `dispute.created`, `dispute.state.updated`); `RETRY_WINDOW_MS`; `type EventOutcome = 'processed' | 'duplicate' | 'ignored' | 'retry'`; `interface SquareEvent`; `class BadPayloadError`; `parseSquareEvent(rawBody: Buffer): SquareEvent`; `handleSquareEvent(event: SquareEvent, deps: { payments: PaymentsPort; email: EmailPort }): Promise<EventOutcome>`.
- Produces (`square-webhook.routes.ts`): `createSquareWebhookHandler(deps: { payments: PaymentsPort; email: EmailPort }): RequestHandler`, mounted at `POST /api/v1/webhooks/square`. It answers 400 `bad_signature` / 400 `bad_payload` / 503 `webhook_not_configured` / 503 `retry_later` / 200 `{ received: true, outcome }`.
- Produces (helpers): `squareEvent(type, object, o?)`, `deliver(app, payments, event, signature?)`, `sqPayment(o)`, `sqRefund(o)`, `sqDispute(o)`.

- [ ] **Step 1: Append the helpers**

At the top of `tests/helpers/checkout.ts`, change the fake import to `import { createFakePaymentsPort, FAKE_LOCATION_ID, type FakePaymentsPort } from '../../src/ports/payments/fake.adapter.js'`. Then append:

```ts
// tests/helpers/checkout.ts (append)
let seq = 0
/** A Square webhook envelope as the subscription (API 2026-09-16) delivers it: raw snake_case. */
export function squareEvent(type: string, object: Record<string, unknown>, o: { id?: string; createdAt?: Date } = {}) {
  const dataType = type.split('.')[0]
  return {
    merchant_id: 'MFAKEMERCHANT', type,
    event_id: o.id ?? `evt_${Date.now()}_${++seq}`,
    created_at: (o.createdAt ?? new Date()).toISOString(),
    data: { type: dataType, id: String(object.id ?? ''), object: { [dataType]: object } },
  }
}

/** POSTs `event` exactly as Square does: raw JSON bytes, signed over the notification URL. */
export function deliver(app: Express, payments: FakePaymentsPort, event: object, signature?: string) {
  const payload = JSON.stringify(event)
  return request(app).post('/api/v1/webhooks/square')
    .set('Content-Type', 'application/json')
    .set('x-square-hmacsha256-signature', signature ?? payments.sign(payload))
    .send(payload)
}

export function sqPayment(o: { id: string; orderId?: string; amount: number; status?: string; locationId?: string }) {
  return {
    id: o.id, status: o.status ?? 'COMPLETED', amount_money: { amount: o.amount, currency: 'USD' },
    ...(o.orderId ? { reference_id: o.orderId } : {}), location_id: o.locationId ?? FAKE_LOCATION_ID,
  }
}

export function sqRefund(o: { id: string; paymentId: string; amount: number; status?: string; locationId?: string }) {
  return {
    id: o.id, status: o.status ?? 'COMPLETED', amount_money: { amount: o.amount, currency: 'USD' },
    payment_id: o.paymentId, location_id: o.locationId ?? FAKE_LOCATION_ID,
  }
}

export function sqDispute(o: { id: string; paymentId: string; state?: string; locationId?: string }) {
  return {
    id: o.id, state: o.state ?? 'EVIDENCE_REQUIRED', disputed_payment: { payment_id: o.paymentId },
    location_id: o.locationId ?? FAKE_LOCATION_ID,
  }
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/square-webhook.test.ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

// Pass-through spy: the real enqueue runs, and the release paths can assert
// the post-commit Walmart pushes were requested for the released variants.
vi.mock('../src/channels/walmart/inventory.sync.js', async (importOriginal) => {
  const actual: any = await importOriginal()
  return { ...actual, enqueueInventoryPush: vi.fn(actual.enqueueInventoryPush) }
})
import request from 'supertest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { cancelOrder, fulfillOrder } from '../src/orders/orders.service.js'
import { enqueueInventoryPush } from '../src/channels/walmart/inventory.sync.js'
import { unconfiguredPaymentsPort } from '../src/ports/payments/index.js'
import { FAKE_NOTIFICATION_URL } from '../src/ports/payments/fake.adapter.js'
import type { EmailPort } from '../src/ports/email/email.port.js'
import {
  makeApp, readyToPay, postPay, paidOrder, inventoryOf, variantIdBySku,
  squareEvent, deliver, sqPayment, sqRefund, sqDispute,
} from './helpers/checkout.js'

let errorSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>
beforeEach(async () => {
  await resetDb(); await seed()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.mocked(enqueueInventoryPush).mockClear()
})
afterAll(async () => { errorSpy.mockRestore(); warnSpy.mockRestore(); await prisma.$disconnect() })

function setup() {
  const email: EmailPort = { orderPaid: vi.fn(async () => {}) }
  return { ...makeApp({ email }), email }
}
const order = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } })
const DAY_MS = 24 * 60 * 60 * 1000

describe('POST /api/v1/webhooks/square — transport', () => {
  it('rejects a bad signature with 400 and records nothing', async () => {
    const { app, payments } = setup()
    const res = await deliver(app, payments, squareEvent('payment.updated', sqPayment({ id: 'p', amount: 1 })), 'bm90IGEgc2lnbmF0dXJl')
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('bad_signature')
    expect(await prisma.paymentEvent.count()).toBe(0)
  })

  it('rejects a signature computed over any URL but the configured one (§3)', async () => {
    const { app, payments } = setup()
    const evt = squareEvent('payment.updated', sqPayment({ id: 'p', amount: 1 }))
    const res = await deliver(app, payments, evt, payments.sign(JSON.stringify(evt), `${FAKE_NOTIFICATION_URL}?x=1`))
    expect(res.status).toBe(400)
  })

  it('400s a missing signature header and a signed non-JSON body', async () => {
    const { app, payments } = setup()
    expect((await request(app).post('/api/v1/webhooks/square').set('Content-Type', 'application/json').send('{}')).status).toBe(400)
    const junk = 'not json'
    const res = await request(app).post('/api/v1/webhooks/square').set('Content-Type', 'application/json')
      .set('x-square-hmacsha256-signature', payments.sign(junk)).send(junk)
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('bad_payload')
  })

  it('503s when payments are not configured', async () => {
    const { app } = makeApp({ payments: unconfiguredPaymentsPort })
    const { payments: signer } = setup()
    expect((await deliver(app, signer, squareEvent('payment.updated', sqPayment({ id: 'p', amount: 1 })))).status).toBe(503)
  })

  it('acknowledges event types it does not handle without recording them', async () => {
    const { app, payments } = setup()
    const res = await deliver(app, payments, squareEvent('inventory.count.updated', { id: 'x' }))
    expect(res.body).toEqual({ received: true, outcome: 'ignored' })
    expect(await prisma.paymentEvent.count()).toBe(0)
  })

  // Plan decision 2: event readers' POS payments share the subscription.
  it('ignores events for another Square location without recording them', async () => {
    const { app, payments } = setup()
    const res = await deliver(app, payments, squareEvent('payment.updated', sqPayment({ id: 'pos_1', amount: 500, locationId: 'LEVENTS' })))
    expect(res.status).toBe(200)
    expect(res.body.outcome).toBe('ignored')
    expect(await prisma.paymentEvent.count()).toBe(0)
  })
})

describe('payment.updated', () => {
  it('marks a pending order paid after a crash between the charge and our write (§5)', async () => {
    const { app, payments, email } = setup()
    const r = await readyToPay(app)
    payments.nextOutcomes = ['lost']
    await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    const p = payments.paymentFor(r.orderId)
    const res = await deliver(app, payments, squareEvent('payment.updated', sqPayment({ id: p.id, orderId: r.orderId, amount: p.amountCents })))
    expect(res.body.outcome).toBe('processed')
    expect(await order(r.orderId)).toMatchObject({ status: 'paid', squarePaymentId: p.id, reviewReason: null })
    expect(email.orderPaid).toHaveBeenCalledTimes(1)
    expect(await prisma.customer.count({ where: { email: 'buyer@example.com' } })).toBe(1)
  })

  it('is a no-op for an order the pay route already marked paid', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app)
    await deliver(app, payments, squareEvent('payment.updated', sqPayment({ id: o.squarePaymentId!, orderId: o.id, amount: o.totalCents })))
    expect(await prisma.auditLog.count({ where: { action: 'order.paid', target: `order:${o.id}` } })).toBe(1)
  })

  it('treats a redelivered event as a duplicate and applies concurrent deliveries exactly once', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    payments.nextOutcomes = ['lost']
    await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    const p = payments.paymentFor(r.orderId)
    const evt = squareEvent('payment.updated', sqPayment({ id: p.id, orderId: r.orderId, amount: p.amountCents }))
    const results = await Promise.all(Array.from({ length: 5 }, () => deliver(app, payments, evt)))
    expect(results.every((x) => x.status === 200)).toBe(true)
    expect(results.map((x) => x.body.outcome).sort()).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'processed'])
    expect(await prisma.auditLog.count({ where: { action: 'order.paid', target: `order:${r.orderId}` } })).toBe(1)
  })

  it('ignores non-final statuses (the event is recorded, the order unchanged)', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    for (const status of ['APPROVED', 'FAILED', 'CANCELED']) {
      const res = await deliver(app, payments, squareEvent('payment.updated', sqPayment({ id: `p_${status}`, orderId: r.orderId, amount: 1, status })))
      expect(res.body.outcome).toBe('processed')
    }
    expect((await order(r.orderId)).status).toBe('pending')
  })

  it('flags paid_after_cancel on a cancelled order and keeps its stock released', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    await cancelOrder(r.orderId)
    await deliver(app, payments, squareEvent('payment.updated', sqPayment({ id: 'sq_late', orderId: r.orderId, amount: r.totalCents })))
    const o = await order(r.orderId)
    expect(o).toMatchObject({ status: 'cancelled', reviewReason: 'paid_after_cancel', squarePaymentId: 'sq_late' })
    expect(o.customerId).not.toBeNull()
    expect((await inventoryOf('BBS-STD')).reserved).toBe(0)
  })

  it('flags amount_mismatch when Square’s amount differs from the order total', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app)
    await deliver(app, payments, squareEvent('payment.updated', sqPayment({ id: 'sq_x', orderId: r.orderId, amount: r.totalCents - 1 })))
    expect(await order(r.orderId)).toMatchObject({ status: 'paid', reviewReason: 'amount_mismatch' })
  })

  it('records but does not apply a second completed payment for a paid order', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app)
    await deliver(app, payments, squareEvent('payment.updated', sqPayment({ id: 'sq_second', orderId: o.id, amount: o.totalCents })))
    expect(await order(o.id)).toMatchObject({ status: 'paid', squarePaymentId: o.squarePaymentId })
    expect(await prisma.auditLog.count({ where: { action: 'order.duplicate_payment', target: `order:${o.id}` } })).toBe(1)
  })

  it('ignores a payment with no reference id (not a storefront payment)', async () => {
    const { app, payments } = setup()
    const res = await deliver(app, payments, squareEvent('payment.updated', sqPayment({ id: 'sq_noref', amount: 100 })))
    expect(res.body.outcome).toBe('processed')
  })
})

describe('refund.created / refund.updated', () => {
  it('a full refund before shipment: refunded, hold released, Walmart push requested', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app)
    payments.addRefund(o.squarePaymentId!, { id: 'r1', status: 'COMPLETED', amountCents: o.totalCents })
    vi.mocked(enqueueInventoryPush).mockClear()
    await deliver(app, payments, squareEvent('refund.updated', sqRefund({ id: 'r1', paymentId: o.squarePaymentId!, amount: o.totalCents })))
    expect(await order(o.id)).toMatchObject({ status: 'refunded', refundedCents: o.totalCents })
    expect(await inventoryOf('BBS-STD')).toMatchObject({ onHand: 25, reserved: 0 })
    expect(enqueueInventoryPush).toHaveBeenCalledWith(await variantIdBySku('BBS-STD'))
  })

  it('a full refund after shipment leaves stock alone', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app)
    await fulfillOrder(o.id)
    payments.addRefund(o.squarePaymentId!, { id: 'r1', status: 'COMPLETED', amountCents: o.totalCents })
    await deliver(app, payments, squareEvent('refund.updated', sqRefund({ id: 'r1', paymentId: o.squarePaymentId!, amount: o.totalCents })))
    expect((await order(o.id)).status).toBe('refunded')
    expect(await inventoryOf('BBS-STD')).toMatchObject({ onHand: 23, reserved: 0 })
  })

  it('sums the payment’s COMPLETED refunds from Square, ignoring pending ones', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app)
    payments.addRefund(o.squarePaymentId!, { id: 'r1', status: 'COMPLETED', amountCents: 500 })
    payments.addRefund(o.squarePaymentId!, { id: 'r2', status: 'PENDING', amountCents: 700 })
    await deliver(app, payments, squareEvent('refund.created', sqRefund({ id: 'r2', paymentId: o.squarePaymentId!, amount: 700, status: 'PENDING' })))
    expect(await order(o.id)).toMatchObject({ status: 'paid', refundedCents: 500 })
    payments.addRefund(o.squarePaymentId!, { id: 'r2', status: 'COMPLETED', amountCents: 700 })
    await deliver(app, payments, squareEvent('refund.updated', sqRefund({ id: 'r2', paymentId: o.squarePaymentId!, amount: 700 })))
    expect(await order(o.id)).toMatchObject({ status: 'paid', refundedCents: 1200 })
    expect((await inventoryOf('BBS-STD')).reserved).toBe(2)
  })

  it('never lowers the refunded amount when Square’s list lags (monotonic)', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app)
    await prisma.order.update({ where: { id: o.id }, data: { refundedCents: 1200 } })
    payments.addRefund(o.squarePaymentId!, { id: 'r1', status: 'COMPLETED', amountCents: 500 })
    await deliver(app, payments, squareEvent('refund.updated', sqRefund({ id: 'r1', paymentId: o.squarePaymentId!, amount: 500 })))
    expect((await order(o.id)).refundedCents).toBe(1200)
  })

  it('a refund the order rules refuse (over the total) is acknowledged, logged and not recorded (T7-R1)', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app, { qty: 1 })
    payments.addRefund(o.squarePaymentId!, { id: 'r1', status: 'COMPLETED', amountCents: o.totalCents + 100 })
    errorSpy.mockClear()
    const evt = squareEvent('refund.updated', sqRefund({ id: 'r1', paymentId: o.squarePaymentId!, amount: o.totalCents + 100 }))
    const res = await deliver(app, payments, evt)
    expect(res.body.outcome).toBe('ignored')
    expect(String(errorSpy.mock.calls[0][0])).toContain(evt.event_id)
    expect(String(errorSpy.mock.calls[0][0])).toContain('invalid_refund')
    expect(await prisma.paymentEvent.count({ where: { eventId: evt.event_id } })).toBe(0)
  })
})

describe('dispute.created / dispute.state.updated', () => {
  it('dispute.created flags the order for review and keeps the prior reason in the audit', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app, { qty: 1 })
    await prisma.order.update({ where: { id: o.id }, data: { reviewReason: 'amount_mismatch' } })
    await deliver(app, payments, squareEvent('dispute.created', sqDispute({ id: 'dp_1', paymentId: o.squarePaymentId! })))
    expect((await order(o.id)).reviewReason).toBe('disputed')
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.disputed', target: `order:${o.id}` } })
    expect(audit.before).toEqual({ reviewReason: 'amount_mismatch' })
    expect(audit.after).toEqual({ dispute: 'dp_1', state: 'EVIDENCE_REQUIRED', reviewReason: 'disputed' })
    expect(errorSpy).toHaveBeenCalled()
  })

  it('dispute.state.updated records the state; LOST logs an error; arriving first still flags the order', async () => {
    const { app, payments } = setup()
    const o = await paidOrder(app, { qty: 1 })
    errorSpy.mockClear()
    await deliver(app, payments, squareEvent('dispute.state.updated', sqDispute({ id: 'dp_2', paymentId: o.squarePaymentId!, state: 'LOST' })))
    expect((await order(o.id)).reviewReason).toBe('disputed')
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.dispute_state', target: `order:${o.id}` } })
    expect(audit.after).toMatchObject({ dispute: 'dp_2', state: 'LOST' })
    expect(errorSpy.mock.calls.map((c) => String(c[0])).some((m) => m.includes('LOST'))).toBe(true)
  })
})

describe('out-of-order and unmatched events (P15)', () => {
  it('a refund before the payment is known is retried, then applies', async () => {
    const { app, payments } = setup()
    const r = await readyToPay(app, { qty: 1 })
    payments.nextOutcomes = ['lost']
    await postPay(app, r.orderId, { sourceToken: 'tok_a', quoteVersion: r.quoteVersion })
    const p = payments.paymentFor(r.orderId)
    payments.addRefund(p.id, { id: 'r1', status: 'COMPLETED', amountCents: r.totalCents })
    const refundEvt = squareEvent('refund.updated', sqRefund({ id: 'r1', paymentId: p.id, amount: r.totalCents }))
    const early = await deliver(app, payments, refundEvt)
    expect(early.status).toBe(503)
    expect(await prisma.paymentEvent.count({ where: { eventId: refundEvt.event_id } })).toBe(0)

    await deliver(app, payments, squareEvent('payment.updated', sqPayment({ id: p.id, orderId: r.orderId, amount: r.totalCents })))
    const retried = await deliver(app, payments, refundEvt)
    expect(retried.body.outcome).toBe('processed')
    expect((await order(r.orderId)).status).toBe('refunded')
  })

  it.each([
    ['payment.updated', () => sqPayment({ id: 'p_orphan', orderId: 'no-such-order', amount: 100 })],
    ['refund.updated', () => sqRefund({ id: 'r_orphan', paymentId: 'p_unrelated', amount: 100 })],
    ['dispute.created', () => sqDispute({ id: 'dp_orphan', paymentId: 'p_unrelated' })],
  ] as const)('%s with no matching order: 503 under 24h old, 200 + logged over', async (type, object) => {
    const { app, payments } = setup()
    const young = squareEvent(type, object(), { createdAt: new Date(Date.now() - DAY_MS + 60_000) })
    const res = await deliver(app, payments, young)
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('retry_later')

    errorSpy.mockClear()
    const old = squareEvent(type, object(), { createdAt: new Date(Date.now() - DAY_MS - 60_000) })
    const res2 = await deliver(app, payments, old)
    expect(res2.status).toBe(200)
    expect(res2.body.outcome).toBe('ignored')
    expect(String(errorSpy.mock.calls[0][0])).toContain(old.event_id)
    expect(await prisma.paymentEvent.count()).toBe(0)
  })
})
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npx vitest run tests/square-webhook.test.ts`
Expected: FAIL. `/api/v1/webhooks/square` is a 404.

- [ ] **Step 4: Write the event handler**

```ts
// src/payments/square-events.ts
import { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { recordAudit } from '../audit.js'
import { lockOrderRow, refundOrderTx, enqueueInventoryPushesAfterCommit, OrderError } from '../orders/orders.service.js'
import type { PaymentsPort, RefundSummary } from '../ports/payments/payments.port.js'
import type { EmailPort } from '../ports/email/email.port.js'
import { applyCompletedPayment, type FollowUp } from './complete-payment.js'

/** Spec §3, and the five event types the runbook subscribes to. */
export const HANDLED_EVENTS: ReadonlySet<string> = new Set([
  'payment.updated', 'refund.created', 'refund.updated', 'dispute.created', 'dispute.state.updated',
])
/** Square retries a failed delivery for 24 hours; after that we log and acknowledge (P15). */
export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000

export type EventOutcome = 'processed' | 'duplicate' | 'ignored' | 'retry'

// Webhook payloads are raw snake_case JSON (plan header), not the SDK's camelCase types.
interface SqPayment { id?: string; status?: string; amount_money?: { amount?: number }; reference_id?: string; location_id?: string }
interface SqRefund { id?: string; status?: string; payment_id?: string; location_id?: string }
interface SqDispute { id?: string; dispute_id?: string; state?: string; disputed_payment?: { payment_id?: string }; location_id?: string }
export interface SquareEvent {
  event_id: string
  type: string
  created_at: string
  data?: { type?: string; id?: string; object?: { payment?: SqPayment; refund?: SqRefund; dispute?: SqDispute } }
}

export class BadPayloadError extends Error {}

export function parseSquareEvent(rawBody: Buffer): SquareEvent {
  let parsed: unknown
  try { parsed = JSON.parse(rawBody.toString('utf8')) } catch { throw new BadPayloadError('body is not JSON') }
  const e = parsed as Partial<SquareEvent> | null
  if (!e || typeof e.event_id !== 'string' || typeof e.type !== 'string' || typeof e.created_at !== 'string') {
    throw new BadPayloadError('not a Square event envelope')
  }
  return e as SquareEvent
}

class DuplicateEvent extends Error {}
/** A refund or dispute the order rules refuse. Deterministic, so it is acknowledged (ruling T7-R1). */
class RefusedEvent extends Error {
  constructor(readonly orderError: OrderError) { super(orderError.message) }
}
/** The event cannot apply YET; the route answers 503 and Square redelivers. */
class RetryLater extends Error {}

type Tx = Prisma.TransactionClient
type Deps = { payments: PaymentsPort; email: EmailPort }

function locationOf(event: SquareEvent): string | undefined {
  const o = event.data?.object
  return o?.payment?.location_id ?? o?.refund?.location_id ?? o?.dispute?.location_id
}

async function onPaymentUpdated(tx: Tx, payment: SqPayment, deps: Deps): Promise<FollowUp | null> {
  if (payment.status !== 'COMPLETED' || !payment.id) return null
  const ref = payment.reference_id
  const byRef = ref ? await tx.order.findUnique({ where: { id: ref }, select: { id: true } }) : null
  const order = byRef ?? await tx.order.findUnique({ where: { squarePaymentId: payment.id }, select: { id: true } })
  if (!order) {
    if (!ref) return null // not a storefront payment
    throw new RetryLater(`no order ${ref} for payment ${payment.id}`)
  }
  const { followUp } = await applyCompletedPayment(tx, order.id, { paymentId: payment.id, amountCents: payment.amount_money?.amount ?? 0 }, deps)
  return followUp
}

async function orderIdByPayment(tx: Tx, paymentId: string | undefined): Promise<string> {
  const order = paymentId ? await tx.order.findUnique({ where: { squarePaymentId: paymentId }, select: { id: true } }) : null
  // Not found yet: payment.updated may not have landed. 503 -> Square retries.
  if (!order) throw new RetryLater(`no order for payment ${paymentId}`)
  return order.id
}

/**
 * Recomputes the total of the payment's COMPLETED refunds, as read from
 * Square, and hands it to refundOrderTx, which never lowers it (§3).
 */
async function onRefund(tx: Tx, refund: SqRefund, refunds: RefundSummary[]): Promise<FollowUp | null> {
  const orderId = await orderIdByPayment(tx, refund.payment_id)
  const { totalCents } = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { totalCents: true } })
  const refundedCents = refunds.filter((r) => r.status === 'COMPLETED').reduce((sum, r) => sum + r.amountCents, 0)
  const { releasedVariantIds } = await refundOrderTx(tx, orderId, { refundedCents, full: refundedCents >= totalCents }, 'system')
  return releasedVariantIds.length
    ? () => enqueueInventoryPushesAfterCommit(releasedVariantIds, `square.refund order:${orderId}`)
    : null
}

async function onDispute(tx: Tx, type: string, dispute: SqDispute): Promise<FollowUp | null> {
  const orderId = await orderIdByPayment(tx, dispute.disputed_payment?.payment_id)
  // Locked, so the reviewReason read here is the one being overwritten; the prior value survives in `before`.
  const order = await lockOrderRow(tx, orderId)
  const prior = order?.reviewReason ?? null
  const disputeId = dispute.id ?? dispute.dispute_id ?? null
  const state = dispute.state ?? null
  // Either event may arrive first; both flag the order.
  if (prior !== 'disputed') await tx.order.update({ where: { id: orderId }, data: { reviewReason: 'disputed' } })
  await recordAudit({
    actorId: 'system',
    action: type === 'dispute.created' ? 'order.disputed' : 'order.dispute_state',
    target: `order:${orderId}`,
    before: { reviewReason: prior },
    after: { dispute: disputeId, state, reviewReason: 'disputed' },
  }, tx)
  if (type === 'dispute.created') {
    console.error(`[square] order ${orderId} has a DISPUTE (${disputeId}) -- respond in the payment dashboard`)
  }
  if (state === 'LOST' || state === 'ACCEPTED') {
    console.error(`[square] order ${orderId} dispute ${disputeId} is ${state}: the money is gone -- Cancel the order in the console if it has not shipped`)
  }
  return null
}

/** Refund and dispute paths only: an OrderError becomes a RefusedEvent (ruling T7-R1). */
async function refusable(p: Promise<FollowUp | null>): Promise<FollowUp | null> {
  try {
    return await p
  } catch (err) {
    if (err instanceof OrderError) throw new RefusedEvent(err)
    throw err
  }
}

/**
 * Applies one verified event. The PaymentEvent insert and the event's
 * effects share one transaction (§3): a crash commits neither, and a
 * concurrent or repeated delivery blocks on the primary key, then fails with
 * P2002 -> 'duplicate'. Every handler tolerates any delivery order.
 */
export async function handleSquareEvent(event: SquareEvent, deps: Deps): Promise<EventOutcome> {
  if (!HANDLED_EVENTS.has(event.type)) return 'ignored'
  const location = locationOf(event)
  if (location && location !== deps.payments.locationId) return 'ignored' // plan decision 2
  const obj = event.data?.object ?? {}

  let refunds: RefundSummary[] = []
  if (event.type === 'refund.created' || event.type === 'refund.updated') {
    if (!obj.refund?.payment_id) return 'ignored'
    // Read Square BEFORE the transaction: no network call while holding the order's row lock.
    refunds = await deps.payments.listPaymentRefunds(obj.refund.payment_id)
  }

  let followUp: FollowUp | null = null
  try {
    followUp = await prisma.$transaction(async (tx) => {
      try {
        await tx.paymentEvent.create({ data: { provider: 'square', eventId: event.event_id, type: event.type } })
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new DuplicateEvent()
        throw err
      }
      switch (event.type) {
        case 'payment.updated': return onPaymentUpdated(tx, obj.payment ?? {}, deps)
        case 'refund.created':
        case 'refund.updated': return refusable(onRefund(tx, obj.refund ?? {}, refunds))
        case 'dispute.created':
        case 'dispute.state.updated': return refusable(onDispute(tx, event.type, obj.dispute ?? {}))
        default: return null
      }
    })
  } catch (err) {
    if (err instanceof DuplicateEvent) return 'duplicate'
    if (err instanceof RefusedEvent) {
      console.error(`[square] ${event.event_id} (${event.type}) refused: ${err.orderError.code} -- ${err.message}; acknowledging without applying, check it in the payment dashboard`)
      return 'ignored'
    }
    if (err instanceof RetryLater) {
      const created = Date.parse(event.created_at)
      if (Number.isFinite(created) && Date.now() - created >= RETRY_WINDOW_MS) {
        console.error(`[square] ${event.event_id} (${event.type}) matched no order after 24h; acknowledging without applying: ${err.message}`)
        return 'ignored'
      }
      console.warn('[square] deferring event', event.event_id, event.type, err.message)
      return 'retry'
    }
    throw err
  }
  if (followUp) await followUp()
  return 'processed'
}
```

- [ ] **Step 5: Write the route and mount it**

```ts
// src/payments/square-webhook.routes.ts
import type { RequestHandler } from 'express'
import { asyncHandler } from '../lib/async-handler.js'
import { WebhookSignatureError, type PaymentsPort } from '../ports/payments/payments.port.js'
import type { EmailPort } from '../ports/email/email.port.js'
import { BadPayloadError, handleSquareEvent, parseSquareEvent } from './square-events.js'

/**
 * POST /api/v1/webhooks/square. Mounted in app.ts BEFORE express.json with a
 * raw-body parser: the signature covers the exact bytes Square sent. No
 * CORS, auth, origin or content-type middleware -- the signature is the
 * only auth layer (spec §3).
 */
export function createSquareWebhookHandler(deps: { payments: PaymentsPort; email: EmailPort }): RequestHandler {
  return asyncHandler(async (req, res) => {
    if (!deps.payments.configured) return res.status(503).json({ code: 'webhook_not_configured' })
    const signature = req.get('x-square-hmacsha256-signature')
    if (!signature || !Buffer.isBuffer(req.body)) return res.status(400).json({ code: 'bad_signature' })
    try {
      deps.payments.verifyWebhook(req.body, signature)
    } catch (err) {
      if (err instanceof WebhookSignatureError) return res.status(400).json({ code: 'bad_signature' })
      throw err
    }
    let event
    try {
      event = parseSquareEvent(req.body)
    } catch (err) {
      if (err instanceof BadPayloadError) return res.status(400).json({ code: 'bad_payload' })
      throw err
    }
    const outcome = await handleSquareEvent(event, deps)
    if (outcome === 'retry') return res.status(503).json({ code: 'retry_later' })
    res.status(200).json({ received: true, outcome })
  })
}
```

In `src/app.ts`, add `import { createSquareWebhookHandler } from './payments/square-webhook.routes.js'` and put this where the Stripe block was, directly after `app.set('trust proxy', 1)` and before the checkout CORS line:

```ts
  // Square webhook: raw body, registered BEFORE express.json. body-parser
  // skips a request whose body was already read, so the JSON parser below
  // never touches these bytes. Any content type is accepted: the HMAC over
  // the configured notification URL + body is the only auth (spec §3).
  app.post(
    '/api/v1/webhooks/square',
    express.raw({ type: () => true, limit: '1mb' }),
    createSquareWebhookHandler({ payments, email }),
  )
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/square-webhook.test.ts tests/checkout-pay.test.ts tests/orders-checkout-support.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/payments/square-events.ts src/payments/square-webhook.routes.ts src/app.ts tests/helpers/checkout.ts tests/square-webhook.test.ts
git commit -m "feat(core): Square webhook — HMAC over the configured URL, payment_events de-dup, payment, refund and dispute events" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 7: Admin orders — `payment` reference, no provider call on cancel, neutral copy

**Files:**
- Modify (rewrite): `systems/core/src/admin/admin-orders.service.ts`, `src/admin/admin-orders.routes.ts`
- Modify: `systems/core/src/app.ts` (`createAdminOrdersRouter()` takes no argument)
- Modify (rewrite): `systems/core/tests/admin-orders.test.ts`

**Interfaces:**
- Consumes: `attemptInFlight` (Task 3); `lockOrderRow`, `cancelOrderTx`, `fulfillOrder`, `enqueueInventoryPushesAfterCommit`, `orderNumber`, `OrderError`, `PENDING_CHECKOUT_EMAIL` (existing); `lineName` (Task 3); helpers `makeApp`, `postCheckout`, `paidOrder`, `readyToPay`, `deliver`, `squareEvent`, `sqDispute`, `variantIdBySku`, `inventoryOf` (Tasks 3–6).
- Produces: `AdminOrderDetail.payment: { provider: 'square'; id: string; url: string | null } | null` (replaces `stripePaymentUrl`); `getAdminOrder(id: string): Promise<AdminOrderDetail | null>`; `shipOrder(id, body, actorId)`; `cancelPendingOrder(id, body, actorId)`; `createAdminOrdersRouter(): Router`. Error codes: `STRIPE_UNAVAILABLE` removed; `PAYMENT_IN_PROGRESS` (409) added; `ORDER_PAID` copy is provider-neutral. PR 3 consumes this shape.

- [ ] **Step 1: Write the failing test**

```ts
// tests/admin-orders.test.ts (replace the whole file)
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import request from 'supertest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { seed } from '../prisma/seed.js'
import { createSession, SESSION_COOKIE } from '../src/auth/session.service.js'
import { makeApp, postCheckout, paidOrder, variantIdBySku, inventoryOf, deliver, squareEvent, sqDispute } from './helpers/checkout.js'

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
const paid = (qty = 1) => paidOrder(ctx.app, { qty })
async function flagged(qty = 1) {
  const o = await paid(qty)
  return prisma.order.update({ where: { id: o.id }, data: { reviewReason: 'amount_mismatch' } })
}
async function disputed(qty = 1) {
  const q = await paid(qty)
  await deliver(ctx.app, ctx.payments, squareEvent('dispute.created', sqDispute({ id: `dp_${q.id}`, paymentId: q.squarePaymentId! })))
  return prisma.order.findUniqueOrThrow({ where: { id: q.id } })
}

describe('admin orders', () => {
  it('requires a session', async () => {
    expect((await request(ctx.app).get('/api/v1/admin/orders?tab=to_ship')).status).toBe(401)
  })

  it('queues storefront orders by tab, newest first', async () => {
    const p = await pending()
    const q = await paid()
    const r = await flagged()
    await prisma.order.create({ data: {
      channel: 'walmart', externalOrderId: 'PO-9', status: 'paid', email: 'w@example.com', shipToState: 'MI',
      subtotalCents: 1, taxCents: 0, totalCents: 1, taxRateBps: 0, taxJurisdiction: 'none',
    } })
    const ids = async (tab: string) => (await get(`/orders?tab=${tab}`)).body.items.map((i: { id: string }) => i.id)
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

  it('returns the order detail with the payment reference and no provider copy', async () => {
    const q = await paid()
    const res = await get(`/orders/${q.id}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: q.id, status: 'paid', email: 'buyer@example.com',
      shipTo: { name: 'Ann Buyer', line1: '1 Main St', line2: 'Apt 2', city: 'Traverse City', state: 'MI', postalCode: '49684' },
      lines: [{ sku: 'BBS-STD', name: 'Brick Builder Set', quantity: 1, unitPriceCents: 4999, lineSubtotalCents: 4999 }],
      subtotalCents: 4999, shippingCents: 995, taxCents: 300, totalCents: 6294, refundedCents: 0, referral: null,
      taxJurisdiction: 'MI', payment: { provider: 'square', id: q.squarePaymentId, url: null },
    })
    expect(res.body).not.toHaveProperty('stripePaymentUrl')
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('stripe')
    expect(res.body.audit.map((a: { action: string }) => a.action)).toEqual(['order.place', 'order.paid'])
    expect((await get(`/orders/${(await pending()).id}`)).body.payment).toBeNull()
    expect((await get('/orders/nope')).status).toBe(404)
  })

  it('validates the ship form', async () => {
    const q = await paid()
    const noTracking = await write('post', `/orders/${q.id}/ship`, { carrier: 'USPS' })
    expect(noTracking.status).toBe(400)
    expect(noTracking.body.fields.trackingNumber).toBeDefined()
    expect((await write('post', `/orders/${q.id}/ship`, { carrier: 'Pigeon', trackingNumber: '1' })).body.fields.carrier).toBeDefined()
  })

  it('marks shipped: fulfilled, stock decremented, carrier recorded, audited', async () => {
    const q = await paid(2)
    const res = await write('post', `/orders/${q.id}/ship`, { carrier: 'USPS', trackingNumber: ' 9400 1000 0000 0000 0000 00 ' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'fulfilled', carrier: 'USPS', trackingNumber: '9400 1000 0000 0000 0000 00' })
    expect(await inventoryOf('BBS-STD')).toMatchObject({ onHand: 23, reserved: 0 })
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.ship', target: `order:${q.id}` } })).actorId).toBe(actorId)
  })

  it('ships with carrier Other and no tracking number', async () => {
    const q = await paid()
    expect((await write('post', `/orders/${q.id}/ship`, { carrier: 'Other' })).body).toMatchObject({ status: 'fulfilled', trackingNumber: null })
  })

  it('requires acknowledgement before shipping a flagged order', async () => {
    const r = await flagged()
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

  it('cancels a pending order without calling the payment provider, releasing stock', async () => {
    const p = await pending(3)
    const res = await write('post', `/orders/${p.id}/cancel`)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('cancelled')
    expect(ctx.payments.charges).toEqual([])
    expect((await inventoryOf('BBS-STD')).reserved).toBe(0)
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.cancelled', target: `order:${p.id}` } })).actorId).toBe(actorId)
  })

  // Plan decision 7.
  it('refuses to cancel while the customer is paying (409 PAYMENT_IN_PROGRESS)', async () => {
    const p = await pending()
    await prisma.order.update({ where: { id: p.id }, data: { paymentAttemptAt: new Date() } })
    const res = await write('post', `/orders/${p.id}/cancel`)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PAYMENT_IN_PROGRESS')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('pending')
  })

  it('answers ORDER_PAID, without naming a provider, when the order was paid after the page loaded', async () => {
    const q = await paid()
    const stale = { channel: 'storefront', status: 'pending', reviewReason: null, paymentAttemptAt: null }
    vi.spyOn(prisma.order, 'findUnique').mockResolvedValueOnce(stale as never)
    const res = await write('post', `/orders/${q.id}/cancel`)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('ORDER_PAID')
    expect(res.body.message).toContain('payment dashboard')
    expect(res.body.message.toLowerCase()).not.toContain('stripe')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: q.id } })).status).toBe('paid')
  })

  it('refuses to cancel a paid order, pointing at the payment dashboard', async () => {
    const q = await paid()
    const res = await write('post', `/orders/${q.id}/cancel`)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('INVALID_TRANSITION')
    expect(res.body.message).toContain('payment dashboard')
  })

  it('cancels a disputed paid order with acknowledgement, releasing its stock (F-R1)', async () => {
    const d = await disputed(2)
    expect(d).toMatchObject({ status: 'paid', reviewReason: 'disputed' })
    const res = await write('post', `/orders/${d.id}/cancel`, { acknowledgeReview: true })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('cancelled')
    expect(await inventoryOf('BBS-STD')).toMatchObject({ onHand: 25, reserved: 0 })
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.cancelled', target: `order:${d.id}` } })
    expect(audit.actorId).toBe(actorId)
    expect(audit.after).toMatchObject({ status: 'cancelled', acknowledgedReview: 'disputed' })
  })

  it('refuses to cancel a disputed paid order without acknowledgement (F-R1)', async () => {
    const d = await disputed()
    const res = await write('post', `/orders/${d.id}/cancel`)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('REVIEW_REQUIRED')
    expect(res.body.details).toEqual({ reviewReason: 'disputed' })
    expect((await inventoryOf('BBS-STD')).reserved).toBe(1)
  })

  it('still refuses to cancel a non-disputed paid order, acknowledged or flagged (F-R1)', async () => {
    const q = await paid()
    expect((await write('post', `/orders/${q.id}/cancel`, { acknowledgeReview: true })).body.code).toBe('INVALID_TRANSITION')
    const r = await flagged()
    expect((await write('post', `/orders/${r.id}/cancel`, { acknowledgeReview: true })).body.code).toBe('INVALID_TRANSITION')
    expect((await inventoryOf('BBS-STD')).reserved).toBe(2)
  })

  it('validates the cancel body', async () => {
    const d = await disputed()
    const res = await write('post', `/orders/${d.id}/cancel`, { acknowledgeReview: 'yes' })
    expect(res.status).toBe(400)
    expect(res.body.fields.acknowledgeReview).toBeDefined()
  })

  it('refuses to ship when the order was flagged after the unlocked read (F-R3)', async () => {
    const q = await paid()
    await prisma.order.update({ where: { id: q.id }, data: { reviewReason: 'disputed' } })
    const stale = { channel: 'storefront', status: 'paid', reviewReason: null, paymentAttemptAt: null }
    vi.spyOn(prisma.order, 'findUnique').mockResolvedValueOnce(stale as never)
    const res = await write('post', `/orders/${q.id}/ship`, { carrier: 'UPS', trackingNumber: '1Z999' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('REVIEW_REQUIRED')
    expect(res.body.details).toEqual({ reviewReason: 'disputed' })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: q.id } })).toMatchObject({ status: 'paid', shippedAt: null })
  })

  it('audits the locked reviewReason when an acknowledged ship races a flag (F-R3)', async () => {
    const q = await paid()
    await prisma.order.update({ where: { id: q.id }, data: { reviewReason: 'disputed' } })
    const stale = { channel: 'storefront', status: 'paid', reviewReason: null, paymentAttemptAt: null }
    vi.spyOn(prisma.order, 'findUnique').mockResolvedValueOnce(stale as never)
    expect((await write('post', `/orders/${q.id}/ship`, { carrier: 'UPS', trackingNumber: '1Z999', acknowledgeReview: true })).status).toBe(200)
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.ship', target: `order:${q.id}` } })
    expect(audit.after).toMatchObject({ acknowledgedReview: 'disputed' })
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

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/admin-orders.test.ts`
Expected: FAIL. The detail still has `stripePaymentUrl`, and cancel calls the removed `expireCheckoutSession`.

- [ ] **Step 3: Rewrite the service**

```ts
// src/admin/admin-orders.service.ts (replace the whole file)
import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { recordAudit } from '../audit.js'
import { AdminError } from './admin-errors.js'
import {
  fulfillOrder, cancelOrderTx, lockOrderRow, enqueueInventoryPushesAfterCommit, orderNumber, OrderError, PENDING_CHECKOUT_EMAIL,
} from '../orders/orders.service.js'
import { lineName } from '../checkout/checkout.service.js'
import { attemptInFlight } from '../checkout/payment-attempt.js'

export const ORDER_TABS = ['to_ship', 'shipped', 'pending', 'closed', 'review'] as const
export type OrderTab = (typeof ORDER_TABS)[number]
export const CARRIERS = ['USPS', 'UPS', 'FedEx', 'Other'] as const

/** Storefront only: Walmart orders ship through the Walmart flow. */
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

/**
 * The payment behind a paid order. `url` stays null until the Square
 * Dashboard deep-link format is confirmed in the sandbox (spec §9.3); `id`
 * lets the operator search for it meanwhile (plan decision 10).
 */
export interface AdminOrderPayment { provider: 'square'; id: string; url: string | null }

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
  payment: AdminOrderPayment | null
  audit: { action: string; actorName: string; createdAt: Date; after: unknown }[]
}

export async function getAdminOrder(id: string): Promise<AdminOrderDetail | null> {
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
    payment: o.squarePaymentId ? { provider: 'square', id: o.squarePaymentId, url: null } : null,
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
    where: { id }, select: { channel: true, status: true, reviewReason: true, paymentAttemptAt: true },
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

function reviewRequired(reviewReason: string, verb: string) {
  return new AdminError('REVIEW_REQUIRED', `This order is flagged (${reviewReason}). Confirm you have reviewed it before ${verb}.`, undefined, { reviewReason })
}

/**
 * Mark shipped: `paid` only -> fulfillOrder, with carrier details in the same transaction.
 * The unlocked pre-read gives a fast refusal; the authoritative review check
 * re-reads under fulfillOrder's row lock (ruling F-R3).
 */
export async function shipOrder(id: string, body: unknown, actorId: string): Promise<AdminOrderDetail> {
  const input = parseShipInput(body)
  const order = await requireStorefrontOrder(id)
  if (order.reviewReason && !input.acknowledgeReview) throw reviewRequired(order.reviewReason, 'shipping')
  try {
    await fulfillOrder(id, actorId, {
      inTransaction: async (tx) => {
        const locked = await tx.order.findUniqueOrThrow({ where: { id }, select: { reviewReason: true } })
        if (locked.reviewReason && !input.acknowledgeReview) throw reviewRequired(locked.reviewReason, 'shipping')
        await tx.order.update({ where: { id }, data: { shippedAt: new Date(), carrier: input.carrier, trackingNumber: input.trackingNumber } })
        await recordAudit({
          actorId, action: 'order.ship', target: `order:${id}`,
          after: { carrier: input.carrier, trackingNumber: input.trackingNumber, ...(locked.reviewReason ? { acknowledgedReview: locked.reviewReason } : {}) },
        }, tx)
      },
    })
  } catch (err) { throw mapOrderError(err) }
  return (await getAdminOrder(id))!
}

/** The order is no longer pending by the time the lock was taken: it was paid. */
function orderPaidError() {
  return new AdminError('ORDER_PAID', 'The customer has just paid for this order. Refresh the page; refund it in the payment dashboard if it should not ship.')
}

/** Plan decision 7: a charge may be landing; the sweep releases the order later if not. */
function paymentInProgressError() {
  return new AdminError('PAYMENT_IN_PROGRESS', 'The customer is paying for this order right now. Wait ten minutes, then refresh.')
}

function parseCancelInput(body: unknown): { acknowledgeReview: boolean } {
  if (body === undefined || body === null) return { acknowledgeReview: false }
  if (typeof body !== 'object' || Array.isArray(body)) throw new AdminError('VALIDATION_ERROR', 'body must be a JSON object')
  const b = body as Record<string, unknown>
  const fields: Record<string, string> = {}
  for (const k of Object.keys(b)) if (k !== 'acknowledgeReview') fields[k] = 'unknown field'
  if ('acknowledgeReview' in b && typeof b.acknowledgeReview !== 'boolean') fields.acknowledgeReview = 'true or false'
  if (Object.keys(fields).length > 0) throw new AdminError('VALIDATION_ERROR', 'invalid input', fields)
  return { acknowledgeReview: b.acknowledgeReview === true }
}

/**
 * Cancel: `pending` orders, plus (ruling F-R1) a `paid` order under dispute.
 * Every other paid order is refunded in the payment dashboard, never
 * cancelled here. There is no provider session to close any more (spec
 * 2026-09-28 §2): the pending cancel is ours alone, under the row lock,
 * refused while a payment attempt is in flight, and onlyIfPending so a
 * payment that landed first is reported rather than undone.
 */
export async function cancelPendingOrder(id: string, body: unknown, actorId: string): Promise<AdminOrderDetail> {
  const input = parseCancelInput(body)
  const order = await requireStorefrontOrder(id)
  if (order.status === 'paid' && order.reviewReason === 'disputed') {
    if (!input.acknowledgeReview) throw reviewRequired(order.reviewReason, 'cancelling')
    await cancelDisputedOrder(id, actorId)
    return (await getAdminOrder(id))!
  }
  if (order.status !== 'pending') {
    throw new AdminError('INVALID_TRANSITION', `cannot cancel a ${order.status} order here; refund paid orders in the payment dashboard`)
  }
  const now = new Date()
  let cancelled
  try {
    cancelled = await prisma.$transaction(async (tx) => {
      const locked = await lockOrderRow(tx, id)
      if (!locked) throw new OrderError('order_not_found', `no order ${id}`)
      if (locked.status === 'pending' && attemptInFlight(locked.paymentAttemptAt, now)) throw paymentInProgressError()
      return cancelOrderTx(tx, id, actorId, { onlyIfPending: true })
    })
  } catch (err) { throw mapOrderError(err) }
  if (!cancelled) throw orderPaidError()
  await enqueueInventoryPushesAfterCommit(cancelled.lines.map((l) => l.variantId), `order.cancelled order:${id}`)
  return (await getAdminOrder(id))!
}

/**
 * paid + disputed -> cancelled, releasing the reservation (ruling F-R1).
 * Deliberately WITHOUT onlyIfPending -- the order is paid. The unlocked
 * pre-read is re-checked under the row lock.
 */
async function cancelDisputedOrder(id: string, actorId: string): Promise<void> {
  let cancelled
  try {
    cancelled = await prisma.$transaction(async (tx) => {
      const locked = await lockOrderRow(tx, id)
      if (!locked) throw new OrderError('order_not_found', `no order ${id}`)
      if (locked.status !== 'paid' || locked.reviewReason !== 'disputed') {
        throw new OrderError('invalid_transition', `this order is now ${locked.status}${locked.reviewReason ? ` (${locked.reviewReason})` : ''}; refresh the page`)
      }
      return cancelOrderTx(tx, id, actorId, { auditAfter: { acknowledgedReview: locked.reviewReason } })
    })
  } catch (err) { throw mapOrderError(err) }
  if (cancelled) await enqueueInventoryPushesAfterCommit(cancelled.lines.map((l) => l.variantId), `order.cancelled (disputed) order:${id}`)
}
```

- [ ] **Step 4: Rewrite the routes and fix the mount**

```ts
// src/admin/admin-orders.routes.ts (replace the whole file)
import { Router, type Response } from 'express'
import { listAdminOrders, getAdminOrder, shipOrder, cancelPendingOrder } from './admin-orders.service.js'
import { getShopSettings, updateShippingSettings } from '../settings/shop-settings.service.js'
import { fail as failWith, intParam } from './route-helpers.js'

const STATUS_BY_CODE: Record<string, number> = {
  NOT_FOUND: 404, VALIDATION_ERROR: 400, INVALID_TRANSITION: 409, INVENTORY_CONFLICT: 409,
  REVIEW_REQUIRED: 409, WRONG_CHANNEL: 409, ORDER_PAID: 409, PAYMENT_IN_PROGRESS: 409,
}

function fail(res: Response, err: unknown) {
  failWith(res, err, STATUS_BY_CODE, 'admin-orders')
}

/** PRECONDITION: mounted behind requireAuth (req.actor!.id), like adminCatalogRouter. */
export function createAdminOrdersRouter(): Router {
  const router = Router()

  router.get('/orders', async (req, res) => {
    try {
      res.json(await listAdminOrders({ tab: req.query.tab, page: intParam(req.query.page), pageSize: intParam(req.query.pageSize) }))
    } catch (err) { fail(res, err) }
  })

  router.get('/orders/:id', async (req, res) => {
    try {
      const o = await getAdminOrder(req.params.id)
      if (!o) return res.status(404).json({ code: 'NOT_FOUND', message: 'order not found' })
      res.json(o)
    } catch (err) { fail(res, err) }
  })

  router.post('/orders/:id/ship', async (req, res) => {
    try { res.json(await shipOrder(req.params.id, req.body, req.actor!.id)) } catch (err) { fail(res, err) }
  })

  router.post('/orders/:id/cancel', async (req, res) => {
    try { res.json(await cancelPendingOrder(req.params.id, req.body, req.actor!.id)) } catch (err) { fail(res, err) }
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

In `src/app.ts`: `app.use('/api/v1/admin', createAdminOrdersRouter(payments))` → `app.use('/api/v1/admin', createAdminOrdersRouter())`.

- [ ] **Step 5: Run the tests, then the typecheck**

Run: `npx vitest run tests/admin-orders.test.ts tests/auth-route-coverage.test.ts tests/admin-errors.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: exit 0. This is the first task since Task 1 where it must be clean (Global Constraints table). If it is not, fix only what earlier tasks of this plan left behind, and name each fix in the report.

- [ ] **Step 6: Commit**

```bash
git add src/admin/admin-orders.service.ts src/admin/admin-orders.routes.ts src/app.ts tests/admin-orders.test.ts
git commit -m "feat(core): admin order payment reference, provider-free cancel with an in-flight guard, neutral copy" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 8: Config, docs, runbook, core verification and PR

**Files:**
- Modify: `render.yaml` (repo root of `projects/engineering`)
- Modify: `systems/core/README.md` (the "Checkout and Stripe" section)
- Create: `docs/status/2026-09-28-square-sandbox-runbook.md`
- Delete: `docs/status/2026-09-27-stripe-test-mode-runbook.md`
- Modify: `CLAUDE.md` (the engineering workspace root: "What's being built here" items 1 and 3, and "Locked decisions")
- Modify: `docs/superpowers/specs/2026-09-27-revenue-loop-checkout-design.md` (supersession note under the title block)
- Modify: `systems/core/src/ports/email/email.port.ts`, `noop.adapter.ts` (comments)

**Interfaces:** none (docs and config).

- [ ] **Step 1: `render.yaml`**

In the storefront service, replace the Stripe block:

```yaml
      # Stripe publishable key (pk_test_... on staging, pk_live_... on
      # production). Publishable keys are designed to be public, but they are
      # still per environment, so sync: false -- never hardcode one here.
      - key: VITE_STRIPE_PUBLISHABLE_KEY
        sync: false
```

with:

```yaml
      # Square Web Payments SDK (spec docs/superpowers/specs/2026-09-28-square-payments-design.md §4).
      # Application ID (sandbox-sq0idb-... on staging) and the "Online"
      # location ID are public identifiers, but they are per environment, so
      # sync: false. VITE_SQUARE_ENVIRONMENT is `sandbox` or `production` and
      # picks the SDK script host. Without all three, the cart refuses to
      # start checkout. Vite bakes them in at build time.
      - key: VITE_SQUARE_APPLICATION_ID
        sync: false
      - key: VITE_SQUARE_LOCATION_ID
        sync: false
      - key: VITE_SQUARE_ENVIRONMENT
        sync: false
```

In the core env block, replace the `STOREFRONT_PUBLIC_URL` comment and key, and the secrets comment after it, with:

```yaml
      # The storefront's public origin for this environment (e.g.
      # https://staging.alpinebrickexchange.com), kept for links. Checkout
      # no longer needs it.
      - key: STOREFRONT_PUBLIC_URL
        sync: false
      # Square (spec 2026-09-28 §4). All five or none: any partial set makes
      # core refuse to start, naming the missing keys. None: checkout and the
      # webhook answer 503. See docs/status/2026-09-28-square-sandbox-runbook.md
      #   SQUARE_ENVIRONMENT               sandbox | production
      #   SQUARE_LOCATION_ID               the "Online" location
      #   SQUARE_WEBHOOK_NOTIFICATION_URL  EXACTLY the subscription's URL; the signature covers it
      - key: SQUARE_ENVIRONMENT
        sync: false
      - key: SQUARE_LOCATION_ID
        sync: false
      - key: SQUARE_WEBHOOK_NOTIFICATION_URL
        sync: false
      # Secrets are NEVER declared here. Set these in the Render dashboard,
      # per environment, entered by Jack:
      #   GOOGLE_CLIENT_SECRET,
      #   SQUARE_ACCESS_TOKEN, SQUARE_WEBHOOK_SIGNATURE_KEY,
      #   WALMART_CLIENT_ID, WALMART_CLIENT_SECRET, WALMART_WEBHOOK_SECRET,
      #   ASSET_S3_ACCESS_KEY_ID, ASSET_S3_SECRET_ACCESS_KEY
      # Staging uses the Square sandbox and the Walmart sandbox base URL.
```

- [ ] **Step 2: Core README**

Replace everything from `## Checkout and Stripe` to the end of the paragraph that ends "**refuses to start**, naming the missing keys." with:

```markdown
## Checkout and Square

Spec: `docs/superpowers/specs/2026-09-28-square-payments-design.md` (it
supersedes the payment and tax parts of the 09-27 checkout spec).

- `POST /api/v1/checkout` (public, storefront CORS) reserves stock through
  `placeOrder` and returns `{ orderId }`.
- `POST /api/v1/checkout/:orderId/quote { email, name, address }` refuses
  anything outside the contiguous US (422), writes the address, and stores
  a versioned quote: flat-rate shipping, and Michigan 6% on goods only.
- `POST /api/v1/checkout/:orderId/pay { sourceToken, quoteVersion }` stamps
  `paymentAttemptAt`, then charges through Square `CreatePayment` (no Square
  Order), with idempotency key `orderId:quoteVersion:attemptCount`.
- Start, quote and pay share one limit: 20 per minute per IP.
- `GET /api/v1/checkout/status?orderId=` returns no address and no email.
- `POST /api/v1/webhooks/square` is mounted **before** `express.json` with a
  raw-body parser. The signature is an HMAC over
  `SQUARE_WEBHOOK_NOTIFICATION_URL` + the body, compared in constant time.
  Each event is applied once (`payment_events`), in one transaction with its
  effects. Handled: `payment.updated`, `refund.created`, `refund.updated`,
  `dispute.created`, `dispute.state.updated`. Events for other Square
  locations are ignored.
- The abandoned-checkout sweep runs every 5 minutes **in the web process**.
  It makes no Square call, and skips orders with a payment attempt in the
  last 10 minutes.
- `square` is pinned to **46.0.0** (API `2026-09-16`). Upgrading the SDK
  changes the API version: update `SQUARE_API_VERSION`, re-pin the webhook
  subscription's version, and re-check the payload fields read in
  `src/payments/square-events.ts`.

| Var | Purpose |
|---|---|
| `SQUARE_ENVIRONMENT` | `sandbox` (staging) or `production`. |
| `SQUARE_ACCESS_TOKEN` | Secret, pasted by Jack. |
| `SQUARE_LOCATION_ID` | The "Online" location; web payments are taken there. |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | Secret, from this environment's webhook subscription. |
| `SQUARE_WEBHOOK_NOTIFICATION_URL` | Exactly the subscription's URL, e.g. `https://api-staging.alpinebrickexchange.com/api/v1/webhooks/square`. |
| `STOREFRONT_PUBLIC_URL` | Storefront origin, for links. |

None of the five Square keys set: checkout and the webhook answer 503 and
the sweep does not start. Any other partial set: core **refuses to start**,
naming the missing keys.
```

- [ ] **Step 3: Write the sandbox runbook**

```markdown
<!-- docs/status/2026-09-28-square-sandbox-runbook.md -->
# Square Sandbox on Staging — Runbook

**Date:** 2026-09-28 · **For:** Jack · **Spec:** `docs/superpowers/specs/2026-09-28-square-payments-design.md`
Replaces the Stripe test-mode runbook (deleted with this change).

Every step is a console action on an account Jack owns. Credentials are
pasted by Jack into Render; they never go into chat, the repo or a ticket.

## 0. Open items this depends on (spec §9, §8)

- **Q3 / Q8:** partner sign-off on Michigan-only nexus and on not taxing shipping.
- **§9.1 receipts:** check 8 below settles whether Square emails a receipt for API payments.
- **§9.3 Dashboard link:** find a payment's Dashboard URL during check 1; tell engineering the format.
- **§9.4:** ask Square developer support whether any API computes destination tax today.
- **§9.5 / Q7:** does the business already have an "Online" location, or is one created?

## 1. Sandbox application and the Online location

1. Square Developer Console → **Applications** → create (or open) the AlpineBrick web app.
2. Toggle **Sandbox**. Open the default test account's **Sandbox Seller Dashboard** →
   Locations → create **Online** (Q7) if it does not exist.
3. Note, from the app's **Credentials** page (Sandbox): the **Application ID**
   (`sandbox-sq0idb-…`) and the **Access token**. From Locations, note the **Online** location ID.

## 2. Storefront first

Render → staging `storefront` → Environment:
`VITE_SQUARE_APPLICATION_ID`, `VITE_SQUARE_LOCATION_ID` (Online) and
`VITE_SQUARE_ENVIRONMENT` = `sandbox`. Then make sure a rebuild runs
(Manual Deploy if Render did not start one), and **wait until it is live**.
Vite bakes these in at build time.

Why this order: once core has its Square keys, every checkout **reserves
stock**. A storefront built without the three keys refuses to start
checkout, but do the storefront first rather than rely on that.

## 3. Webhook subscription (before core's keys)

1. Developer Console → the app → **Webhooks** → **Subscriptions** → Sandbox → **Add subscription**.
2. URL: `https://api-staging.alpinebrickexchange.com/api/v1/webhooks/square`
3. **API version: `2026-09-16`**. The version decides the payload shape core reads.
4. Events, exactly these five:
   - `payment.updated`
   - `refund.created`
   - `refund.updated`
   - `dispute.created`
   - `dispute.state.updated`
5. Save, then copy the subscription's **Signature key**.

## 4. Core keys — all five in one save

Render → staging `core-env` group, **in one save**:

| Key | Value |
|---|---|
| `SQUARE_ENVIRONMENT` | `sandbox` |
| `SQUARE_ACCESS_TOKEN` | the sandbox access token |
| `SQUARE_LOCATION_ID` | the Online location ID |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | from step 3.5 |
| `SQUARE_WEBHOOK_NOTIFICATION_URL` | `https://api-staging.alpinebrickexchange.com/api/v1/webhooks/square`, character-for-character the URL in step 3.2 |

Any subset refuses to start ("Square is half-configured; missing: …").
**Delete** `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` from core, and
`VITE_STRIPE_PUBLISHABLE_KEY` from the storefront. Leftover Stripe keys only
log a warning, but they should not linger.

After the save, check the `core-api` deploy log shows `core listening`, with no
"half-configured" error. Then use **Send test event** on the subscription and
confirm core answers 200.

**Stale pending orders are released.** About 5 minutes after the first
configured boot, the sweep cancels every pending storefront order older than
30 minutes. That includes any left from the Stripe era (their session ids
were dropped by the migration). The log shows `checkout sweep: cancelled N
abandoned order(s)`. This is expected.

## 5. Apple Pay domain (sandbox)

Developer Console → the app → **Apple Pay** → add
`staging.alpinebrickexchange.com`. Download the verification file and hand it
to engineering, who commit it at
`systems/storefront/code/public/.well-known/apple-developer-merchantid-domain-association`.
Then click **Verify**. Apple Pay in the sandbox needs a real Wallet card, which
is not charged; test cards are rejected. Production needs the same for `www`
(spec §8).

## 6. A referral partner for check 6

Render shell on `core-api` (staging), `psql "$DATABASE_URL"`:

    INSERT INTO affiliate_partners (id, name) VALUES ('partner_test_1', 'Test Partner') ON CONFLICT DO NOTHING;
    INSERT INTO referral_codes (code, partner_id, commission_rate_bps) VALUES ('test-partner', 'partner_test_1', 1000) ON CONFLICT DO NOTHING;

## 7. End-to-end checks (spec §6)

Card `4111 1111 1111 1111`, CVV `111`, any future expiry, a valid ZIP. Record
each result (order number, console view, pass/fail) on the core PR.

| # | Do | Expect |
|---|---|---|
| 1 | Buy one set, ship to a Michigan address | Summary shows MI tax = 6% of the goods (not shipping), $9.95 shipping; console **To ship** with the address, email and a Payment ID; the payment appears in the sandbox Dashboard at the Online location |
| 2 | Buy ≥ $150 | Shipping $0 |
| 3 | Pay with `4000 0000 0000 0002`, then with `4111 1111 1111 1111` | "Your card was declined — try another card.", then paid; one payment in the Dashboard |
| 4 | Pay, then refund in full from the sandbox Dashboard before shipping | Order `refunded`, reserved stock released (proves §9.2: Dashboard refunds reach the webhook) |
| 5 | Make an order total exactly **$88.01** (non-MI address, a product at $78.06 plus $9.95 shipping; set a staging variant's price in the console for this) and pay | Dispute created (`EVIDENCE_REQUIRED`); order in **Needs review** (`disputed`); Cancel with acknowledgement releases stock. Put the price back afterwards |
| 6 | Visit `/?ref=test-partner`, then buy | Order detail: referral `test-partner`, Test Partner, 10.00% |
| 7 | Enter an Alaska address | "We ship to the contiguous US only." at the address step; no payment form; nothing in the Dashboard |
| 8 | After check 1, look at the buyer inbox used | Record whether Square sent a receipt (§9.1) |

## 8. Handling flagged orders

**`paid_after_cancel`** (Needs review; the order shows **Closed**). Money
was taken for an order already cancelled, whose stock may be sold. Refund it
in full in the Square Dashboard, and never ship it. The refund webhook marks
it `refunded`.

**`disputed`** (Needs review; still **To ship**). Respond in the Square
Dashboard first. If you won't ship it, use **Cancel** with the
acknowledgement, which releases its stock. A lost dispute sends no refund
event. If you will ship it, Mark shipped also needs the acknowledgement.

**`amount_mismatch`** (Needs review). Square charged a different amount
from the order total (a re-quote raced a payment). Compare them in the
Dashboard, and refund the difference or the whole order.

## 9. Trust-proxy check

Carried over from the Stripe runbook §7 and still required: confirm on
staging that `req.ip` is the client's address behind Render's one proxy
hop, and that the 20-per-minute limit applies to one client only.
```

Then:

```bash
git rm docs/status/2026-09-27-stripe-test-mode-runbook.md
```

- [ ] **Step 4: Engineering `CLAUDE.md`, the 09-27 spec note, the email comments**

In `CLAUDE.md` (the `projects/engineering` root):
- Item 1: `catalog, cart, checkout (Stripe), accounts.` → `catalog, cart, checkout (Square), accounts.`
- Item 3: `payouts (Stripe Connect).` → `payouts (paid directly by the business; the platform accrues commission, payout is manual).`
- Replace the first "Locked decisions" bullet with these three:

```markdown
- Custom web app (not Shopify). **Square** for all payments, online (Web Payments SDK + Payments API) and in person at events (decided 2026-09-28; replaces Stripe).
- **Affiliates and designers are paid directly** by the business. No Stripe Connect and no marketplace payouts in the platform. Commission and royalty *accrual* stays in scope; *payout* is manual.
- Sales tax: Michigan only (6% on goods, not shipping) until the partner signs off on anything else.
```

In `docs/superpowers/specs/2026-09-27-revenue-loop-checkout-design.md`, insert directly after the `**Date:**` line:

```markdown

> **Superseded in part (2026-09-28).** The payment and tax parts of this spec
> — D1 Stripe Tax, D5 Stripe receipts, D7 Stripe Embedded Checkout, §4–§5
> Stripe session and webhooks, §8 Stripe config — are replaced by
> `2026-09-28-square-payments-design.md`. Square takes payments, there is no
> Stripe Connect, and tax is Michigan-only via the flat-rate `TaxPort`.
> Everything else here stands.
```

In `src/ports/email/email.port.ts`, replace the doc comment with:

```ts
/**
 * Transactional email seam (D5). The pay route and payment.updated call
 * orderPaid once per paid order. Whether Square emails a receipt for API
 * payments is open item §9.1 of the Square spec (sandbox check 8). If it
 * does not, a real adapter goes here -- Jack chooses the provider.
 */
```

In `src/ports/email/noop.adapter.ts`, change the inner comment to `// Intentionally empty until spec §9.1 (receipts) is settled.`

- [ ] **Step 5: Verify the core build and boot**

```bash
cd systems/core
npx vitest run
npm run typecheck
npm run build
PORT=4099 node dist/server.js &   # PowerShell: $env:PORT='4099'; Start-Process node -ArgumentList 'dist/server.js'
curl -s http://localhost:4099/health
curl -s http://localhost:4099/api/v1/checkout/config
```
Expected: the suite is all green (record the count against Task 0's); typecheck and build are clean; `{"status":"ok"}`; config `{"flatRateCents":995,"freeShippingThresholdCents":15000}`. If the local config has no Square keys, the boot log says `checkout sweep: payments are not configured -- not started`. Do not open the config to find out. Stop the server.

Refuse-to-start check. The variable is set for this one child process only, and no config file is touched:
`SQUARE_ENVIRONMENT=sandbox node dist/server.js`
Expected: exits non-zero with `Square is half-configured; missing: SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_WEBHOOK_SIGNATURE_KEY, SQUARE_WEBHOOK_NOTIFICATION_URL`. If the local config already sets some Square keys, the list is shorter. Report what it named.

Stripe is gone:
`git grep -il stripe -- systems/core/src systems/core/tests render.yaml systems/core/README.md systems/core/package.json`
Expected: exactly `systems/core/src/ports/payments/index.ts` (leftover-key warning), `systems/core/tests/payments-selection.test.ts`, `systems/core/tests/setup.ts` and `systems/core/tests/square-payments-schema.test.ts` (provider `'stripe'` rows). Anything else is a leftover. Remove it.

- [ ] **Step 6: Commit, then ask before pushing**

```bash
git add render.yaml systems/core/README.md systems/core/src/ports/email docs/status CLAUDE.md docs/superpowers/specs/2026-09-27-revenue-loop-checkout-design.md
git commit -m "docs(core): Square env keys, checkout README, sandbox runbook; record Square and direct payouts as locked decisions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Ask Jack for the OK to push. Then:

```bash
git push -u origin feat/square-payments-core
gh pr create --title "feat(core): Square payments replace Stripe — quote, pay, webhooks, sweep, admin" --body "$(cat <<'BODY'
Implements PR 1 (Tasks 0–8) of docs/superpowers/plans/2026-09-28-square-payments.md
(spec docs/superpowers/specs/2026-09-28-square-payments-design.md).

- Migration: stripe_events -> payment_events(provider, event_id); Stripe order columns dropped (guarded); square_payment_id, payment_attempt_at/count, quote_version
- square@46.0.0 PaymentsPort with constant-time webhook signature; Stripe SDK and code removed
- Checkout: returns { orderId }; quote (contiguous US, Michigan 6% on goods); pay (per-attempt idempotency key, decline/replay/processing)
- Square webhook: payment.updated, refund.*, dispute.*; other locations ignored
- Sweep without a provider call; admin payment reference and provider-free cancel
- render.yaml, README, Square sandbox runbook (replaces the Stripe runbook), locked decisions

Migration rehearsal on legacy rows: <paste Task 1 Step 6 output>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
gh pr checks --watch
```
Expected: CI green (core, storefront, admin-ui jobs). Record the PR number. The storefront and admin-ui jobs still pass unchanged: neither reads core at test time.

---

# PR 2 — Storefront (`feat/square-payments-storefront`)

Cut from `main` after PR 1 merges: `git checkout main && git pull --ff-only && git checkout -b feat/square-payments-storefront`. Every command below runs in `systems/storefront/code`. Baseline: `npx vitest run` (record the count).

Storefront conventions carried over:
- Tests that navigate use the **declarative `MemoryRouter`**. `createMemoryRouter` combined with an imperative `navigate()` throws a cross-realm `AbortSignal` error under jsdom (see the comment in `CartPanel.test.tsx`). Tests that never navigate may keep `createMemoryRouter`.
- Cents become dollars only in `src/lib/money.ts`.
- Browser-storage failures are swallowed.

**Mid-PR red (PR 2):** `npm run build` (`tsc -b`) fails from Task 9 (the client's `startCheckout` loses `clientSecret`, which `CartPanel.tsx` still destructures) until Task 12. Each task runs only the test files it names. Task 13 needs the whole suite and the build green.

## Task 9: Checkout API client — start, quote, pay, status by order id, new error codes

**Files:**
- Modify (rewrite): `systems/storefront/code/src/lib/api/checkout.ts`
- Modify (rewrite): `systems/storefront/code/src/lib/api/checkout.test.ts`

**Interfaces:**
- Consumes: core's `POST /api/v1/checkout`, `POST /:orderId/quote`, `POST /:orderId/pay`, `GET /status?orderId=` and `GET /config` (PR 1).
- Produces:
  - `type CheckoutErrorCode = 'insufficient_stock' | 'variant_not_found' | 'invalid_request' | 'rate_limited' | 'checkout_unavailable' | 'not_found' | 'outside_shipping_area' | 'quote_changed' | 'order_expired' | 'payment_declined' | 'payment_pending' | 'too_many_attempts'`
  - `class CheckoutError { code; lines: LineProblem[]; field: string | null }`
  - `UNAVAILABLE_MESSAGE`, `LineProblem`, `StartCheckoutRequest`, `CheckoutStatus`, `CheckoutConfig` (unchanged shapes)
  - `interface ShipAddress { line1: string; line2: string; city: string; state: string; postalCode: string }`
  - `interface QuoteRequest { email: string; name: string; address: ShipAddress }`
  - `interface Quote { quoteVersion: number; subtotalCents: number; shippingCents: number; taxCents: number; totalCents: number }`
  - `type PaidResult = Omit<CheckoutStatus, 'status'> & { status: 'paid' }`, `type PayResult = PaidResult | { status: 'processing' }`
  - `startCheckout(req): Promise<{ orderId: string }>`; `quoteCheckout(orderId: string, req: QuoteRequest): Promise<Quote>`; `payCheckout(orderId: string, req: { sourceToken: string; quoteVersion: number }): Promise<PayResult>`; `getCheckoutStatus(orderId: string): Promise<CheckoutStatus>`; `getCheckoutConfig(): Promise<CheckoutConfig>`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/api/checkout.test.ts (replace the whole file)
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  startCheckout, quoteCheckout, payCheckout, getCheckoutStatus, CheckoutError, UNAVAILABLE_MESSAGE,
} from './checkout'

function stubFetch(status: number, body: unknown) {
  const spy = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: status < 400, status, json: async () => body }))
  vi.stubGlobal('fetch', spy)
  return spy
}
afterEach(() => vi.unstubAllGlobals())

const REQ = { lines: [{ variantId: 'v1', quantity: 2 }], marketingOptIn: false, referral: null }
const QUOTE_REQ = { email: 'a@example.com', name: 'Ann', address: { line1: '1 Main St', line2: '', city: 'Traverse City', state: 'MI', postalCode: '49684' } }

describe('checkout client', () => {
  it('POSTs the cart without credentials and returns the order id', async () => {
    const spy = stubFetch(201, { orderId: 'o1' })
    expect(await startCheckout(REQ)).toEqual({ orderId: 'o1' })
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url.endsWith('/api/v1/checkout')).toBe(true)
    expect(init.method).toBe('POST')
    expect(init.credentials).toBeUndefined()
    expect(JSON.parse(init.body as string)).toEqual(REQ)
  })

  it('quotes and pays against the order id, encoded', async () => {
    const spy = stubFetch(200, { quoteVersion: 1, subtotalCents: 1, shippingCents: 0, taxCents: 0, totalCents: 1 })
    await quoteCheckout('o 1', QUOTE_REQ)
    expect(String(spy.mock.calls[0][0])).toMatch(/\/api\/v1\/checkout\/o%201\/quote$/)
    expect(JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string)).toEqual(QUOTE_REQ)
    const pay = stubFetch(200, { status: 'processing' })
    expect(await payCheckout('o1', { sourceToken: 'tok', quoteVersion: 1 })).toEqual({ status: 'processing' })
    expect(String(pay.mock.calls[0][0])).toMatch(/\/api\/v1\/checkout\/o1\/pay$/)
  })

  it('reads the status by order id', async () => {
    const spy = stubFetch(200, { status: 'paid' })
    await getCheckoutStatus('o 1')
    expect(String(spy.mock.calls[0][0])).toContain('/api/v1/checkout/status?orderId=o%201')
  })

  it('maps stock errors with their lines', async () => {
    stubFetch(409, { code: 'insufficient_stock', message: 'm', details: { lines: [{ variantId: 'v1', code: 'insufficient_stock', available: 1 }] } })
    const err = await startCheckout(REQ).catch((e) => e)
    expect(err).toBeInstanceOf(CheckoutError)
    expect(err.lines).toEqual([{ variantId: 'v1', code: 'insufficient_stock', available: 1 }])
  })

  it.each([
    [422, 'outside_shipping_area', 'We ship to the contiguous US only.'],
    [409, 'quote_changed', 'Your total has changed. Check it and pay again.'],
    [409, 'order_expired', 'This checkout expired.'],
    [402, 'payment_declined', 'Your card was declined — try another card.'],
    [409, 'payment_pending', "We're still confirming an earlier payment attempt for this order."],
    [429, 'too_many_attempts', 'Too many payment attempts for this order. Start again from your cart.'],
  ])('keeps core’s code and message for %i %s', async (status, code, message) => {
    stubFetch(status, { code, message })
    expect(await payCheckout('o1', { sourceToken: 't', quoteVersion: 1 }).catch((e) => e)).toMatchObject({ code, message })
  })

  it('carries the invalid field', async () => {
    stubFetch(400, { code: 'invalid_request', message: 'a 5-digit ZIP code', details: { field: 'address.postalCode' } })
    expect(await quoteCheckout('o1', QUOTE_REQ).catch((e) => e)).toMatchObject({ code: 'invalid_request', field: 'address.postalCode' })
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

  it('maps not_found to its own error kind', async () => {
    stubFetch(404, { code: 'not_found', message: 'no such order' })
    expect((await getCheckoutStatus('missing').catch((e) => e)).code).toBe('not_found')
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/lib/api/checkout.test.ts`
Expected: FAIL. `quoteCheckout` and `payCheckout` are not exported, and the status URL uses `session_id`.

- [ ] **Step 3: Rewrite the client**

```ts
// src/lib/api/checkout.ts (replace the whole file)
import { API_BASE_URL } from '../apiBase'

const BASE = `${API_BASE_URL}/api/v1/checkout`

export type CheckoutErrorCode =
  | 'insufficient_stock' | 'variant_not_found' | 'invalid_request' | 'rate_limited' | 'checkout_unavailable' | 'not_found'
  | 'outside_shipping_area' | 'quote_changed' | 'order_expired' | 'payment_declined' | 'payment_pending' | 'too_many_attempts'

export interface LineProblem {
  variantId: string
  code: 'insufficient_stock' | 'variant_not_found'
  available?: number
}

/** Spec copy, verbatim. */
export const UNAVAILABLE_MESSAGE = 'Checkout is temporarily unavailable — please try again in a minute.'
const RATE_LIMIT_MESSAGE = 'Too many checkout attempts. Please wait a minute and try again.'
const KNOWN: ReadonlySet<string> = new Set([
  'insufficient_stock', 'variant_not_found', 'invalid_request', 'rate_limited', 'checkout_unavailable', 'not_found',
  'outside_shipping_area', 'quote_changed', 'order_expired', 'payment_declined', 'payment_pending', 'too_many_attempts',
])

export class CheckoutError extends Error {
  readonly code: CheckoutErrorCode
  readonly lines: LineProblem[]
  /** For invalid_request: which field core refused (e.g. `address.postalCode`). */
  readonly field: string | null
  constructor(code: CheckoutErrorCode, message: string, lines: LineProblem[] = [], field: string | null = null) {
    super(message)
    this.name = 'CheckoutError'
    this.code = code
    this.lines = lines
    this.field = field
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

export interface ShipAddress { line1: string; line2: string; city: string; state: string; postalCode: string }
export interface QuoteRequest { email: string; name: string; address: ShipAddress }
export interface Quote { quoteVersion: number; subtotalCents: number; shippingCents: number; taxCents: number; totalCents: number }
export type PaidResult = Omit<CheckoutStatus, 'status'> & { status: 'paid' }
export type PayResult = PaidResult | { status: 'processing' }

function isLineProblem(x: unknown): x is LineProblem {
  const l = x as Record<string, unknown>
  return typeof l === 'object' && l !== null && typeof l.variantId === 'string'
    && (l.code === 'insufficient_stock' || l.code === 'variant_not_found')
}

async function toError(res: Response): Promise<CheckoutError> {
  let body: Record<string, unknown> | null = null
  try { body = (await res.json()) as Record<string, unknown> } catch { /* not JSON */ }
  const code = (typeof body?.code === 'string' && KNOWN.has(body.code) ? body.code : 'checkout_unavailable') as CheckoutErrorCode
  const details = body?.details as { lines?: unknown; field?: unknown } | undefined
  const lines = Array.isArray(details?.lines) ? details.lines.filter(isLineProblem) : []
  const field = typeof details?.field === 'string' ? details.field : null
  const message = code === 'checkout_unavailable' ? UNAVAILABLE_MESSAGE
    : code === 'rate_limited' ? RATE_LIMIT_MESSAGE
      : typeof body?.message === 'string' ? body.message : UNAVAILABLE_MESSAGE
  return new CheckoutError(code, message, lines, field)
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
function post<T>(url: string, body: unknown): Promise<T> {
  return request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

const orderUrl = (orderId: string, action: string) => `${BASE}/${encodeURIComponent(orderId)}/${action}`

export function startCheckout(req: StartCheckoutRequest): Promise<{ orderId: string }> {
  return post(BASE, req)
}

export function quoteCheckout(orderId: string, req: QuoteRequest): Promise<Quote> {
  return post(orderUrl(orderId, 'quote'), req)
}

export function payCheckout(orderId: string, req: { sourceToken: string; quoteVersion: number }): Promise<PayResult> {
  return post(orderUrl(orderId, 'pay'), req)
}

export function getCheckoutStatus(orderId: string): Promise<CheckoutStatus> {
  return request(`${BASE}/status?orderId=${encodeURIComponent(orderId)}`)
}

export function getCheckoutConfig(): Promise<CheckoutConfig> {
  return request(`${BASE}/config`)
}
```

- [ ] **Step 4: Run it**

Run: `npx vitest run src/lib/api/checkout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api/checkout.ts src/lib/api/checkout.test.ts
git commit -m "feat(storefront): checkout client for quote, pay and status by order id" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 10: Square loader and the payment component (card, Apple Pay, Google Pay)

**Files:**
- Create: `systems/storefront/code/src/lib/square.ts`, `src/lib/square.test.ts`
- Create: `systems/storefront/code/src/components/checkout/SquarePayment.tsx`, `SquarePayment.test.tsx`
- Modify: `systems/storefront/code/src/lib/money.ts` (add `centsToDecimal`)
- Modify: `systems/storefront/code/package.json` and the root `package-lock.json` (types package)

**Interfaces:**
- Consumes: `QuoteRequest`, `UNAVAILABLE_MESSAGE` (Task 9); `formatCents` (existing); the `Button` primitive (existing); `@square/web-payments-sdk-types@1.84.5` types `Square`, `Card`, `ApplePay`, `GooglePay`, `PaymentRequest`, `TokenResult`.
- Produces (`money.ts`): `centsToDecimal(cents: number): string` (`11593 → '115.93'`).
- Produces (`square.ts`): `interface SquareConfig { applicationId: string; locationId: string; environment: 'sandbox' | 'production' }`; `SQUARE_SCRIPT_URLS`; `squareConfig(): SquareConfig | null`; `loadSquare(): Promise<Square | null> | null`.
- Produces (`SquarePayment.tsx`): default export `SquarePayment(props: { config: SquareConfig; amountCents: number; contact: QuoteRequest; disabled: boolean; onToken: (token: string) => void })`; `STORE_LABEL = 'Alpine Brick Exchange'`; `CARD_PROBLEM = 'Check your card details and try again.'`.

- [ ] **Step 1: Install the types**

Run: `npm install --save-dev --save-exact @square/web-payments-sdk-types@1.84.5`
Expected: `package.json` devDependencies has `"@square/web-payments-sdk-types": "1.84.5"`; the root `package-lock.json` changes (this is a workspace).

- [ ] **Step 2: Write the failing tests**

```ts
// src/lib/square.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'

const tags = () => document.head.querySelectorAll('script[data-square-sdk]')
async function fresh() {
  vi.resetModules()
  return import('./square')
}
function setEnv(environment = 'sandbox') {
  vi.stubEnv('VITE_SQUARE_APPLICATION_ID', 'sandbox-sq0idb-test')
  vi.stubEnv('VITE_SQUARE_LOCATION_ID', 'LONLINE')
  vi.stubEnv('VITE_SQUARE_ENVIRONMENT', environment)
}
afterEach(() => {
  vi.unstubAllEnvs()
  tags().forEach((s) => s.remove())
  delete (window as { Square?: unknown }).Square
})

describe('squareConfig / loadSquare', () => {
  it('is null unless all three settings are present and the environment is known', async () => {
    vi.stubEnv('VITE_SQUARE_APPLICATION_ID', 'x')
    let m = await fresh()
    expect(m.squareConfig()).toBeNull()
    expect(m.loadSquare()).toBeNull()
    setEnv('live')
    m = await fresh()
    expect(m.squareConfig()).toBeNull()
  })

  it('injects the sandbox script once and resolves window.Square', async () => {
    setEnv()
    const m = await fresh()
    expect(m.squareConfig()).toEqual({ applicationId: 'sandbox-sq0idb-test', locationId: 'LONLINE', environment: 'sandbox' })
    const a = m.loadSquare()!
    const b = m.loadSquare()!
    expect(tags()).toHaveLength(1)
    expect((tags()[0] as HTMLScriptElement).src).toBe('https://sandbox.web.squarecdn.com/v1/square.js')
    const square = { payments: vi.fn() }
    ;(window as { Square?: unknown }).Square = square
    tags()[0].dispatchEvent(new Event('load'))
    expect(await a).toBe(square)
    expect(await b).toBe(square)
  })

  it('uses Square’s production host in production', async () => {
    setEnv('production')
    const m = await fresh()
    void m.loadSquare()
    expect((tags()[0] as HTMLScriptElement).src).toBe('https://web.squarecdn.com/v1/square.js')
  })

  it('turns a failed load into null, removes the tag, and tries again next time', async () => {
    setEnv()
    const m = await fresh()
    const p = m.loadSquare()!
    tags()[0].dispatchEvent(new Event('error'))
    expect(await p).toBeNull()
    expect(tags()).toHaveLength(0)
    void m.loadSquare()
    expect(tags()).toHaveLength(1)
  })
})
```

```tsx
// src/components/checkout/SquarePayment.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../lib/square', () => ({ loadSquare: vi.fn() }))
import { loadSquare } from '../../lib/square'
import SquarePayment, { CARD_PROBLEM, STORE_LABEL } from './SquarePayment'

const CONFIG = { applicationId: 'sandbox-sq0idb-test', locationId: 'LONLINE', environment: 'sandbox' as const }
const CONTACT = { email: 'ann@example.com', name: 'Ann Buyer', address: { line1: '1 Main St', line2: 'Apt 2', city: 'Traverse City', state: 'MI', postalCode: '49684' } }

function fakeSquare(o: { tokenize?: unknown; applePay?: boolean; googlePay?: boolean } = {}) {
  const card = {
    attach: vi.fn(async () => {}),
    tokenize: vi.fn(async () => o.tokenize ?? { status: 'OK', token: 'tok_card' }),
    destroy: vi.fn(async () => true),
  }
  const request = { update: vi.fn(() => true), addEventListener: vi.fn() }
  const apple = { tokenize: vi.fn(async () => ({ status: 'OK', token: 'tok_apple' })), destroy: vi.fn(async () => true) }
  const google = { attach: vi.fn(async () => {}), tokenize: vi.fn(async () => ({ status: 'OK', token: 'tok_google' })), destroy: vi.fn(async () => true) }
  const payments = {
    card: vi.fn(async () => card),
    paymentRequest: vi.fn(() => request),
    applePay: vi.fn(async () => { if (!o.applePay) throw new Error('unsupported'); return apple }),
    googlePay: vi.fn(async () => { if (!o.googlePay) throw new Error('unsupported'); return google }),
  }
  const square = { payments: vi.fn(() => payments) }
  vi.mocked(loadSquare).mockReturnValue(Promise.resolve(square as never))
  return { square, payments, card, request, apple, google }
}

function renderPay(over: Partial<{ amountCents: number; disabled: boolean; onToken: (t: string) => void }> = {}) {
  const onToken = over.onToken ?? vi.fn()
  const view = render(
    <SquarePayment config={CONFIG} amountCents={over.amountCents ?? 11593} contact={CONTACT} disabled={over.disabled ?? false} onToken={onToken} />,
  )
  return { ...view, onToken }
}

afterEach(() => vi.clearAllMocks())

describe('SquarePayment', () => {
  it('attaches the card form at the configured location and tokenizes with verification details', async () => {
    const { square, card } = fakeSquare()
    const { onToken } = renderPay()
    const pay = await screen.findByRole('button', { name: 'Pay $115.93' })
    await waitFor(() => expect(pay).toBeEnabled())
    expect(square.payments).toHaveBeenCalledWith('sandbox-sq0idb-test', 'LONLINE')
    expect(card.attach).toHaveBeenCalledWith(screen.getByTestId('card-container'))
    await userEvent.click(pay)
    expect(card.tokenize).toHaveBeenCalledWith({
      amount: '115.93', currencyCode: 'USD', intent: 'CHARGE',
      billingContact: {
        givenName: 'Ann Buyer', email: 'ann@example.com', addressLines: ['1 Main St', 'Apt 2'],
        city: 'Traverse City', state: 'MI', postalCode: '49684', countryCode: 'US',
      },
      customerInitiated: true, sellerKeyedIn: false,
    })
    expect(onToken).toHaveBeenCalledWith('tok_card')
  })

  it('asks the shopper to check the card when tokenize fails, without calling onToken', async () => {
    fakeSquare({ tokenize: { status: 'Invalid', errors: [] } })
    const { onToken } = renderPay()
    const pay = await screen.findByRole('button', { name: 'Pay $115.93' })
    await waitFor(() => expect(pay).toBeEnabled())
    await userEvent.click(pay)
    expect(await screen.findByText(CARD_PROBLEM)).toBeInTheDocument()
    expect(onToken).not.toHaveBeenCalled()
  })

  it('shows the load-failed view when the SDK cannot load', async () => {
    vi.mocked(loadSquare).mockReturnValue(Promise.resolve(null))
    renderPay()
    expect(await screen.findByText("We couldn't load the payment form")).toBeInTheDocument()
  })

  it('offers only the wallets this device supports; Google Pay tokenizes on click', async () => {
    const { google, request, payments } = fakeSquare({ googlePay: true })
    const { onToken } = renderPay()
    const gp = await screen.findByRole('button', { name: 'Pay with Google Pay' })
    await waitFor(() => expect(gp).toBeVisible())
    expect(screen.queryByRole('button', { name: 'Pay with Apple Pay' })).not.toBeInTheDocument()
    expect(payments.paymentRequest).toHaveBeenCalledWith({ countryCode: 'US', currencyCode: 'USD', total: { amount: '115.93', label: STORE_LABEL } })
    expect(payments.googlePay).toHaveBeenCalledWith(request)
    expect(google.attach).toHaveBeenCalled()
    await userEvent.click(gp)
    await waitFor(() => expect(onToken).toHaveBeenCalledWith('tok_google'))
  })

  it('Apple Pay calls tokenize inside the click', async () => {
    const { apple } = fakeSquare({ applePay: true })
    const { onToken } = renderPay()
    await userEvent.click(await screen.findByRole('button', { name: 'Pay with Apple Pay' }))
    expect(apple.tokenize).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onToken).toHaveBeenCalledWith('tok_apple'))
  })

  it('updates the wallet total after a re-quote, and cleans up on unmount', async () => {
    const { request, card } = fakeSquare()
    const view = renderPay()
    // Enabled means 'ready': the payment request exists by then.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pay $115.93' })).toBeEnabled())
    view.rerender(<SquarePayment config={CONFIG} amountCents={12000} contact={CONTACT} disabled={false} onToken={vi.fn()} />)
    await waitFor(() => expect(request.update).toHaveBeenCalledWith({ total: { amount: '120.00', label: STORE_LABEL } }))
    view.unmount()
    expect(card.destroy).toHaveBeenCalled()
  })

  it('does nothing while disabled', async () => {
    const { card } = fakeSquare()
    renderPay({ disabled: true })
    const pay = await screen.findByRole('button', { name: 'Pay $115.93' })
    expect(pay).toBeDisabled()
    expect(card.tokenize).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `npx vitest run src/lib/square.test.ts src/components/checkout/SquarePayment.test.tsx`
Expected: FAIL. Neither module exists.

- [ ] **Step 4: Add `centsToDecimal` to `money.ts`**

Append to `src/lib/money.ts`:

```ts
/**
 * Cents to the decimal string the Square Web Payments SDK takes
 * (`11593` -> `'115.93'`). Integer arithmetic, so no float rounding.
 */
export function centsToDecimal(cents: number): string {
  const whole = Math.floor(cents / 100)
  const part = String(cents % 100).padStart(2, '0')
  return `${whole}.${part}`
}
```

- [ ] **Step 5: Write the loader**

```ts
// src/lib/square.ts
import type { Square } from '@square/web-payments-sdk-types'

export interface SquareConfig { applicationId: string; locationId: string; environment: 'sandbox' | 'production' }

/** Square requires the SDK to load from its own CDN (plan header). */
export const SQUARE_SCRIPT_URLS = {
  sandbox: 'https://sandbox.web.squarecdn.com/v1/square.js',
  production: 'https://web.squarecdn.com/v1/square.js',
} as const

/**
 * The three build-time settings (spec §4 Storefront). null when any is
 * missing: the cart then refuses to start checkout, because a checkout that
 * cannot show the payment form would only reserve stock for nothing.
 */
export function squareConfig(): SquareConfig | null {
  const applicationId = import.meta.env.VITE_SQUARE_APPLICATION_ID as string | undefined
  const locationId = import.meta.env.VITE_SQUARE_LOCATION_ID as string | undefined
  const environment = import.meta.env.VITE_SQUARE_ENVIRONMENT as string | undefined
  if (!applicationId || !locationId || (environment !== 'sandbox' && environment !== 'production')) return null
  return { applicationId, locationId, environment }
}

let promise: Promise<Square | null> | null = null

/**
 * Injects Square's script once and resolves `window.Square`. A failed load
 * (blocked script, network) resolves to null for the page's load-failed
 * view, and is not remembered: the next call tries again.
 */
export function loadSquare(): Promise<Square | null> | null {
  const config = squareConfig()
  if (!config) return null
  if (!promise) {
    promise = new Promise<Square | null>((resolve) => {
      if (window.Square) {
        resolve(window.Square)
        return
      }
      const script = document.createElement('script')
      script.src = SQUARE_SCRIPT_URLS[config.environment]
      script.async = true
      script.dataset.squareSdk = ''
      script.onload = () => resolve(window.Square ?? null)
      script.onerror = () => {
        script.remove()
        resolve(null)
      }
      document.head.appendChild(script)
    }).then((square) => {
      if (!square) promise = null
      return square
    })
  }
  return promise
}
```

- [ ] **Step 6: Write the payment component**

```tsx
// src/components/checkout/SquarePayment.tsx
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { ApplePay, Card, GooglePay, PaymentRequest, TokenResult } from '@square/web-payments-sdk-types'
import { loadSquare, type SquareConfig } from '../../lib/square'
import { UNAVAILABLE_MESSAGE, type QuoteRequest } from '../../lib/api/checkout'
import { centsToDecimal, formatCents } from '../../lib/money'
import { Button } from '../../design-system/primitives'

export const STORE_LABEL = 'Alpine Brick Exchange'
export const CARD_PROBLEM = 'Check your card details and try again.'

/** Apple's own button rendering (WebKit only; elsewhere the button never shows). */
const APPLE_PAY_STYLE = { WebkitAppearance: '-apple-pay-button', height: 48, width: '100%' } as CSSProperties

interface Props {
  config: SquareConfig
  amountCents: number
  /** The quoted address and email, sent as the billing contact for buyer verification. */
  contact: QuoteRequest
  disabled: boolean
  onToken: (token: string) => void
}

/**
 * Square's card form and the Apple Pay / Google Pay buttons (spec §2 step 4,
 * Q6). Card data never touches our page: Square's hosted fields tokenize it,
 * and buyer verification (3DS) runs inside tokenize().
 */
export default function SquarePayment({ config, amountCents, contact, disabled, onToken }: Props) {
  const cardEl = useRef<HTMLDivElement>(null)
  const googleEl = useRef<HTMLDivElement>(null)
  const card = useRef<Card | null>(null)
  const request = useRef<PaymentRequest | null>(null)
  const amount = useRef(amountCents)
  amount.current = amountCents
  const [applePay, setApplePay] = useState<ApplePay | null>(null)
  const [googlePay, setGooglePay] = useState<GooglePay | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const made: { destroy(): Promise<boolean> }[] = []
    void (async () => {
      const square = await loadSquare()
      if (!live) return
      if (!square) {
        setState('failed')
        return
      }
      try {
        const payments = square.payments(config.applicationId, config.locationId)
        const c = await payments.card()
        made.push(c)
        if (!live || !cardEl.current) return
        await c.attach(cardEl.current)
        card.current = c
        const req = payments.paymentRequest({
          countryCode: 'US', currencyCode: 'USD', total: { amount: centsToDecimal(amount.current), label: STORE_LABEL },
        })
        request.current = req
        if (live) setState('ready')
        try {
          const ap = await payments.applePay(req)
          made.push(ap)
          if (live) setApplePay(ap)
        } catch { /* Apple Pay is not available on this device or domain */ }
        try {
          const gp = await payments.googlePay(req)
          made.push(gp)
          if (live && googleEl.current) {
            await gp.attach(googleEl.current)
            setGooglePay(gp)
          }
        } catch { /* Google Pay is not available here */ }
      } catch {
        if (live) setState('failed')
      }
    })()
    return () => {
      live = false
      card.current = null
      request.current = null
      for (const m of made) void m.destroy().catch(() => false)
    }
  }, [config])

  // A re-quote changes the total; the wallet sheets must show the new one.
  useEffect(() => {
    request.current?.update({ total: { amount: centsToDecimal(amountCents), label: STORE_LABEL } })
  }, [amountCents])

  function settle(result: TokenResult) {
    if (result.status === 'OK') onToken(result.token)
    else if (result.status !== 'Cancel' && result.status !== 'Abort') setProblem(CARD_PROBLEM)
  }

  async function payByCard() {
    if (!card.current || disabled) return
    setProblem(null)
    try {
      settle(await card.current.tokenize({
        amount: centsToDecimal(amountCents),
        currencyCode: 'USD',
        intent: 'CHARGE',
        billingContact: {
          givenName: contact.name,
          email: contact.email,
          addressLines: [contact.address.line1, ...(contact.address.line2 ? [contact.address.line2] : [])],
          city: contact.address.city,
          state: contact.address.state,
          postalCode: contact.address.postalCode,
          countryCode: 'US',
        },
        customerInitiated: true,
        sellerKeyedIn: false,
      }))
    } catch {
      setProblem(CARD_PROBLEM)
    }
  }

  function payByWallet(method: ApplePay | GooglePay) {
    if (disabled) return
    // Apple requires tokenize() to start inside the click handler, before any await.
    const pending = method.tokenize()
    setProblem(null)
    pending.then(settle, () => setProblem(CARD_PROBLEM))
  }

  if (state === 'failed') {
    return (
      <div role="alert" className="space-y-2">
        <p className="font-semibold">We couldn't load the payment form</p>
        <p className="text-sm text-muted-foreground">{UNAVAILABLE_MESSAGE}</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {applePay && (
        <button type="button" aria-label="Pay with Apple Pay" style={APPLE_PAY_STYLE} disabled={disabled}
          onClick={() => payByWallet(applePay)} />
      )}
      <div ref={googleEl} role="button" aria-label="Pay with Google Pay" hidden={!googlePay}
        onClick={() => { if (googlePay) payByWallet(googlePay) }} />
      <div ref={cardEl} data-testid="card-container" />
      {state === 'loading' && <p className="text-sm text-muted-foreground">Loading the payment form…</p>}
      {problem && <p role="alert" className="text-sm text-destructive">{problem}</p>}
      <Button className="w-full" onClick={payByCard} disabled={disabled || state !== 'ready'}>
        {`Pay ${formatCents(amountCents)}`}
      </Button>
    </div>
  )
}
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/lib/square.test.ts src/components/checkout/SquarePayment.test.tsx src/lib/lib.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json ../../../package-lock.json src/lib/money.ts src/lib/square.ts src/lib/square.test.ts src/components/checkout/SquarePayment.tsx src/components/checkout/SquarePayment.test.tsx
git commit -m "feat(storefront): Square Web Payments loader and card / Apple Pay / Google Pay component" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 11: `/checkout` — address, quote summary, pay, confirmation

**Files:**
- Create: `systems/storefront/code/src/components/checkout/AddressForm.tsx`, `src/components/checkout/OrderConfirmation.tsx`
- Modify (rewrite): `systems/storefront/code/src/pages/Checkout.tsx`
- Test: `systems/storefront/code/src/pages/checkout-page.test.tsx` (new; the old `/checkout` cases in `checkout-pages.test.tsx` are removed in Task 12)

**Interfaces:**
- Consumes: `quoteCheckout`, `payCheckout`, `CheckoutError`, `UNAVAILABLE_MESSAGE`, `Quote`, `QuoteRequest`, `CheckoutStatus` (Task 9); `squareConfig`, `SquareConfig` (Task 10); `SquarePayment` (Task 10); `setPreviousOrderId`, `clearPreviousOrderId` (existing); `useCart().clear` (existing); `CONTIGUOUS_NOTICE` (existing, `CartPanel.tsx`); `PageHeader`, `Button` (existing).
- Produces: `AddressForm({ value: QuoteRequest; onChange(next: QuoteRequest): void; onSubmit(): void; busy: boolean })`; `US_STATES` (50 states + DC); `EMPTY_QUOTE_REQUEST: QuoteRequest`. `OrderConfirmation({ status: CheckoutStatus })` and `RECEIPT_NOTE = 'Keep your order number for your reference.'` (Task 12 reuses both). `Checkout` reads `location.state.orderId`, and on `processing` / `payment_pending` navigates to `/order/complete?order=<id>`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/pages/checkout-page.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router'
import { CartProvider, CART_STORAGE_KEY } from '../lib/cart/CartContext'

vi.mock('../components/checkout/SquarePayment', () => ({
  default: ({ onToken, amountCents, disabled }: { onToken: (t: string) => void; amountCents: number; disabled: boolean }) => (
    <button type="button" disabled={disabled} onClick={() => onToken('tok_1')}>{`Fake pay ${amountCents}`}</button>
  ),
}))
vi.mock('../lib/square', () => ({ squareConfig: vi.fn(() => ({ applicationId: 'a', locationId: 'l', environment: 'sandbox' })) }))
vi.mock('../lib/api/checkout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api/checkout')>()
  return { ...actual, quoteCheckout: vi.fn(), payCheckout: vi.fn() }
})
import { squareConfig } from '../lib/square'
import { quoteCheckout, payCheckout, CheckoutError, UNAVAILABLE_MESSAGE, type Quote, type PaidResult } from '../lib/api/checkout'
import Checkout from './Checkout'

afterEach(() => vi.clearAllMocks())

const QUOTE: Quote = { quoteVersion: 1, subtotalCents: 9998, shippingCents: 995, taxCents: 600, totalCents: 11593 }
const PAID: PaidResult = {
  status: 'paid', orderNumber: 'ABE-000042',
  lines: [{ name: 'Dragon Fortress', sku: 'ABE-3001', quantity: 2, unitPriceCents: 4999, lineSubtotalCents: 9998 }],
  totals: { subtotalCents: 9998, shippingCents: 995, taxCents: 600, totalCents: 11593 },
}
const CART = [{ variantId: 'v', productId: 'p', productSlug: 's', name: 'n', priceCents: 1, imageKey: '', quantity: 1 }]

function Probe() {
  const { pathname, search } = useLocation()
  return <p>{`at ${pathname}${search}`}</p>
}

function renderCheckout(state: { orderId: string } | null = { orderId: 'order-1' }) {
  window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(CART))
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/checkout', state }]}>
      <CartProvider>
        <Routes>
          <Route path="/checkout" element={<Checkout />} />
          <Route path="/order/complete" element={<Probe />} />
          <Route path="/cart" element={<p>cart page</p>} />
        </Routes>
      </CartProvider>
    </MemoryRouter>,
  )
}

async function fillAddress(state = 'MI') {
  await userEvent.type(screen.getByLabelText('Email'), 'ann@example.com')
  await userEvent.type(screen.getByLabelText('Full name'), 'Ann Buyer')
  await userEvent.type(screen.getByLabelText('Address line 1'), '1 Main St')
  await userEvent.type(screen.getByLabelText('City'), 'Traverse City')
  await userEvent.selectOptions(screen.getByLabelText('State'), state)
  await userEvent.type(screen.getByLabelText('ZIP code'), '49684')
  await userEvent.click(screen.getByRole('button', { name: 'Continue to payment' }))
}

async function toPayStep() {
  vi.mocked(quoteCheckout).mockResolvedValue(QUOTE)
  renderCheckout()
  await fillAddress()
  return screen.findByRole('button', { name: 'Fake pay 11593' })
}

describe('/checkout', () => {
  it('sends a visitor without an order back to the cart', () => {
    renderCheckout(null)
    expect(screen.getByText('Your checkout has ended')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to cart' })).toHaveAttribute('href', '/cart')
  })

  it('explains when this build has no Square settings', () => {
    vi.mocked(squareConfig).mockReturnValueOnce(null)
    renderCheckout()
    expect(screen.getByText("We couldn't load the payment form")).toBeInTheDocument()
  })

  it('collects the address first, then shows the quoted total with tax on goods', async () => {
    renderCheckout()
    expect(screen.getByText('We ship to the contiguous US only.')).toBeInTheDocument()
    expect(window.sessionStorage.getItem('ab.previousOrderId')).toBe('order-1')
    await toPayStepFromHere()
    expect(quoteCheckout).toHaveBeenCalledWith('order-1', {
      email: 'ann@example.com', name: 'Ann Buyer',
      address: { line1: '1 Main St', line2: '', city: 'Traverse City', state: 'MI', postalCode: '49684' },
    })
    const summary = screen.getByRole('list', { name: 'Order total' })
    for (const text of ['$99.98', '$9.95', '$6.00', '$115.93']) expect(within(summary).getByText(text)).toBeInTheDocument()
    for (const name of ['Terms', 'Privacy', 'Refund', 'Shipping']) expect(screen.getByRole('link', { name })).toBeInTheDocument()
  })

  it('refuses Alaska at the address step with the spec copy', async () => {
    vi.mocked(quoteCheckout).mockRejectedValue(new CheckoutError('outside_shipping_area', 'We ship to the contiguous US only.'))
    renderCheckout()
    await fillAddress('AK')
    expect(await screen.findByRole('alert')).toHaveTextContent('We ship to the contiguous US only.')
    expect(screen.queryByRole('button', { name: /Fake pay/ })).not.toBeInTheDocument()
  })

  it('confirms a paid order in place, then clears the cart and the previous order', async () => {
    vi.mocked(payCheckout).mockResolvedValue(PAID)
    await userEvent.click(await toPayStep())
    expect(payCheckout).toHaveBeenCalledWith('order-1', { sourceToken: 'tok_1', quoteVersion: 1 })
    expect(await screen.findByText('Order ABE-000042 confirmed')).toBeInTheDocument()
    expect(screen.getByText('Keep your order number for your reference.')).toBeInTheDocument()
    expect(JSON.parse(window.localStorage.getItem(CART_STORAGE_KEY)!)).toEqual([])
    expect(window.sessionStorage.getItem('ab.previousOrderId')).toBeNull()
  })

  it('shows a decline, stays on the payment step, and a second card succeeds', async () => {
    vi.mocked(payCheckout)
      .mockRejectedValueOnce(new CheckoutError('payment_declined', 'Your card was declined — try another card.'))
      .mockResolvedValueOnce(PAID)
    const pay = await toPayStep()
    await userEvent.click(pay)
    expect(await screen.findByRole('alert')).toHaveTextContent('Your card was declined — try another card.')
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Fake pay 11593' }))
    expect(await screen.findByText('Order ABE-000042 confirmed')).toBeInTheDocument()
  })

  it('re-quotes on quote_changed and shows the new total', async () => {
    vi.mocked(payCheckout).mockRejectedValueOnce(new CheckoutError('quote_changed', 'Your total has changed. Check it and pay again.'))
    const pay = await toPayStep()
    vi.mocked(quoteCheckout).mockResolvedValue({ ...QUOTE, quoteVersion: 2, totalCents: 12000 })
    await userEvent.click(pay)
    expect(await screen.findByText('Your total changed to $120.00 — check it and pay again.')).toBeInTheDocument()
    expect(quoteCheckout).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Fake pay 12000' })).toBeInTheDocument()
  })

  it('says the checkout expired, with a link back to the cart', async () => {
    vi.mocked(payCheckout).mockRejectedValue(new CheckoutError('order_expired', 'This checkout expired.'))
    await userEvent.click(await toPayStep())
    expect(await screen.findByText('This checkout expired')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to cart' })).toHaveAttribute('href', '/cart')
  })

  it.each([
    ['processing', () => vi.mocked(payCheckout).mockResolvedValue({ status: 'processing' })],
    ['payment_pending', () => vi.mocked(payCheckout).mockRejectedValue(new CheckoutError('payment_pending', 'x'))],
  ])('%s goes to the confirmation page to poll', async (_n, arrange) => {
    arrange()
    await userEvent.click(await toPayStep())
    expect(await screen.findByText('at /order/complete?order=order-1')).toBeInTheDocument()
  })

  it('an unknown outcome offers Try again, which re-sends the SAME token (plan decision 3)', async () => {
    vi.mocked(payCheckout)
      .mockRejectedValueOnce(new CheckoutError('checkout_unavailable', UNAVAILABLE_MESSAGE))
      .mockResolvedValueOnce(PAID)
    await userEvent.click(await toPayStep())
    expect(await screen.findByRole('alert')).toHaveTextContent(UNAVAILABLE_MESSAGE)
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(vi.mocked(payCheckout).mock.calls.map((c) => c[1].sourceToken)).toEqual(['tok_1', 'tok_1'])
    expect(await screen.findByText('Order ABE-000042 confirmed')).toBeInTheDocument()
  })
})

async function toPayStepFromHere() {
  vi.mocked(quoteCheckout).mockResolvedValue(QUOTE)
  await fillAddress()
  await screen.findByRole('button', { name: 'Fake pay 11593' })
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/pages/checkout-page.test.tsx`
Expected: FAIL. The page still imports `@stripe/react-stripe-js` and has no address form.

- [ ] **Step 3: Write the address form and the confirmation**

```tsx
// src/components/checkout/AddressForm.tsx
import type { ReactNode } from 'react'
import type { QuoteRequest } from '../../lib/api/checkout'
import { Button } from '../../design-system/primitives'

/** All 50 states + DC. AK and HI are offered so core can refuse them with the spec copy. */
export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const

export const EMPTY_QUOTE_REQUEST: QuoteRequest = {
  email: '', name: '', address: { line1: '', line2: '', city: '', state: '', postalCode: '' },
}

const input = 'w-full rounded-md border border-border px-3 py-2 text-sm'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block">{label}</span>
      {children}
    </label>
  )
}

/** Spec §2 step 2: email, name and a US shipping address, before any payment form. */
export default function AddressForm({ value, onChange, onSubmit, busy }: {
  value: QuoteRequest
  onChange: (next: QuoteRequest) => void
  onSubmit: () => void
  busy: boolean
}) {
  const setAddress = (patch: Partial<QuoteRequest['address']>) => onChange({ ...value, address: { ...value.address, ...patch } })
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); onSubmit() }}>
      <Field label="Email">
        <input className={input} type="email" required autoComplete="email" value={value.email}
          onChange={(e) => onChange({ ...value, email: e.target.value })} />
      </Field>
      <Field label="Full name">
        <input className={input} required autoComplete="name" value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })} />
      </Field>
      <Field label="Address line 1">
        <input className={input} required autoComplete="address-line1" value={value.address.line1}
          onChange={(e) => setAddress({ line1: e.target.value })} />
      </Field>
      <Field label="Address line 2 (optional)">
        <input className={input} autoComplete="address-line2" value={value.address.line2}
          onChange={(e) => setAddress({ line2: e.target.value })} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="City">
          <input className={input} required autoComplete="address-level2" value={value.address.city}
            onChange={(e) => setAddress({ city: e.target.value })} />
        </Field>
        <Field label="State">
          <select className={input} required autoComplete="address-level1" value={value.address.state}
            onChange={(e) => setAddress({ state: e.target.value })}>
            <option value="">Choose…</option>
            {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="ZIP code">
          <input className={input} required inputMode="numeric" autoComplete="postal-code" pattern="\d{5}(-\d{4})?"
            value={value.address.postalCode} onChange={(e) => setAddress({ postalCode: e.target.value })} />
        </Field>
      </div>
      <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Calculating…' : 'Continue to payment'}</Button>
    </form>
  )
}
```

```tsx
// src/components/checkout/OrderConfirmation.tsx
import { Link } from 'react-router'
import type { CheckoutStatus } from '../../lib/api/checkout'
import { formatCents } from '../../lib/money'

/** No provider name, and no receipt promise until spec §9.1 is settled (plan decision 12). */
export const RECEIPT_NOTE = 'Keep your order number for your reference.'

/** Shared by /checkout (from the pay response) and /order/complete (from the status poll). */
export default function OrderConfirmation({ status }: { status: CheckoutStatus }) {
  const { orderNumber, lines, totals } = status
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-24 space-y-6" style={{ fontFamily: 'var(--font-sans)' }}>
      <h1 className="text-3xl font-black uppercase tracking-[0.05em]">{`Order ${orderNumber} confirmed`}</h1>
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
      <p className="text-sm text-muted-foreground">{RECEIPT_NOTE}</p>
      <Link to="/collections" className="underline text-sm">Keep browsing</Link>
    </div>
  )
}
```

- [ ] **Step 4: Rewrite the page**

```tsx
// src/pages/Checkout.tsx (replace the whole file)
import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import {
  quoteCheckout, payCheckout, CheckoutError, UNAVAILABLE_MESSAGE, type CheckoutStatus, type Quote, type QuoteRequest,
} from '../lib/api/checkout'
import { squareConfig } from '../lib/square'
import { setPreviousOrderId, clearPreviousOrderId } from '../lib/checkout/previousOrder'
import { useCart } from '../lib/cart/CartContext'
import { formatCents } from '../lib/money'
import { CONTIGUOUS_NOTICE } from '../components/cart/CartPanel'
import { PageHeader } from '../components/PageHeader'
import { Button } from '../design-system/primitives'
import AddressForm, { EMPTY_QUOTE_REQUEST } from '../components/checkout/AddressForm'
import SquarePayment from '../components/checkout/SquarePayment'
import OrderConfirmation from '../components/checkout/OrderConfirmation'

type Step =
  | { kind: 'address' }
  | { kind: 'pay'; quote: Quote }
  | { kind: 'paid'; status: CheckoutStatus }
  | { kind: 'expired'; body: string }

function Problem({ title, body }: { title: string; body: string }) {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-24 text-center space-y-6">
      <h1 className="text-3xl font-black uppercase tracking-[0.05em]" style={{ fontFamily: 'var(--font-display)' }}>{title}</h1>
      <p className="text-sm text-muted-foreground">{body}</p>
      <Link to="/cart" className="inline-block underline text-sm">Back to cart</Link>
    </div>
  )
}

function Summary({ quote }: { quote: Quote }) {
  const rows: [string, number][] = [
    ['Subtotal', quote.subtotalCents], ['Shipping', quote.shippingCents], ['Tax', quote.taxCents], ['Total', quote.totalCents],
  ]
  return (
    <ul aria-label="Order total" className="text-sm space-y-1">
      {rows.map(([label, cents]) => (
        <li key={label} className={`flex justify-between ${label === 'Total' ? 'font-semibold' : ''}`}>
          <span>{label}</span><span>{formatCents(cents)}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Spec §2 steps 2-6 on our own page (Q6): address -> quote -> Square card
 * form and wallets -> confirmation from the pay response.
 * /order/complete is only for reloads and the processing state.
 */
export default function Checkout() {
  const orderId = (useLocation().state as { orderId?: string } | null)?.orderId
  const navigate = useNavigate()
  const { clear } = useCart()
  const [config] = useState(squareConfig)
  const [form, setForm] = useState<QuoteRequest>(EMPTY_QUOTE_REQUEST)
  const [step, setStep] = useState<Step>({ kind: 'address' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // The token of an attempt whose outcome is unknown: Try again re-sends it,
  // so core reuses the idempotency key and Square replays (plan decision 3).
  const [retryToken, setRetryToken] = useState<string | null>(null)

  useEffect(() => {
    if (orderId) setPreviousOrderId(orderId)
  }, [orderId])

  if (!orderId) return <Problem title="Your checkout has ended" body="Start again from your cart." />
  if (!config) return <Problem title="We couldn't load the payment form" body={UNAVAILABLE_MESSAGE} />
  if (step.kind === 'expired') return <Problem title="This checkout expired" body={step.body} />
  if (step.kind === 'paid') return <OrderConfirmation status={step.status} />
  const id = orderId
  const complete = () => navigate(`/order/complete?order=${encodeURIComponent(id)}`)

  /** Everything but the codes each caller handles itself. */
  function show(err: unknown) {
    if (!(err instanceof CheckoutError)) { setError(UNAVAILABLE_MESSAGE); return }
    if (err.code === 'order_expired' || err.code === 'not_found') { setStep({ kind: 'expired', body: 'Start again from your cart.' }); return }
    if (err.code === 'too_many_attempts') { setStep({ kind: 'expired', body: err.message }); return }
    if (err.code === 'payment_pending') { complete(); return }
    setError(err.message)
  }

  async function quote(): Promise<Quote | null> {
    try {
      return await quoteCheckout(id, form)
    } catch (err) {
      show(err)
      return null
    }
  }

  async function submitAddress() {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    const q = await quote()
    setBusy(false)
    if (q) setStep({ kind: 'pay', quote: q })
  }

  async function pay(token: string) {
    if (busy || step.kind !== 'pay') return
    setBusy(true)
    setError(null)
    setRetryToken(null)
    try {
      const result = await payCheckout(id, { sourceToken: token, quoteVersion: step.quote.quoteVersion })
      if (result.status === 'paid') {
        clear()
        clearPreviousOrderId()
        setStep({ kind: 'paid', status: result })
      } else {
        complete()
      }
    } catch (err) {
      if (err instanceof CheckoutError && err.code === 'quote_changed') {
        const q = await quote()
        if (q) {
          setStep({ kind: 'pay', quote: q })
          setNotice(`Your total changed to ${formatCents(q.totalCents)} — check it and pay again.`)
        }
      } else if (err instanceof CheckoutError && err.code === 'checkout_unavailable') {
        setRetryToken(token)
        setError(UNAVAILABLE_MESSAGE)
      } else {
        show(err)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-16 space-y-8">
      <PageHeader eyebrow="Checkout" title={step.kind === 'address' ? 'Shipping' : 'Payment'} intro={CONTIGUOUS_NOTICE} />
      {step.kind === 'address' ? (
        <AddressForm value={form} onChange={setForm} onSubmit={() => { void submitAddress() }} busy={busy} />
      ) : (
        <div className="space-y-6">
          <Summary quote={step.quote} />
          <button type="button" className="underline text-sm"
            onClick={() => { setStep({ kind: 'address' }); setError(null); setNotice(null); setRetryToken(null) }}>
            Edit address
          </button>
          {notice && <p role="status" className="text-sm font-semibold">{notice}</p>}
          <SquarePayment config={config} amountCents={step.quote.totalCents} contact={form} disabled={busy}
            onToken={(t) => { void pay(t) }} />
        </div>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {retryToken && (
        <Button className="w-full" disabled={busy} onClick={() => { void pay(retryToken) }}>Try again</Button>
      )}
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

- [ ] **Step 5: Run the test**

Run: `npx vitest run src/pages/checkout-page.test.tsx src/components/checkout`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/checkout/AddressForm.tsx src/components/checkout/OrderConfirmation.tsx src/pages/Checkout.tsx src/pages/checkout-page.test.tsx
git commit -m "feat(storefront): checkout page — address, quote summary, Square payment, in-page confirmation" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 12: `/order/complete` by order id; the cart's Square gate; Stripe removed

**Files:**
- Modify (rewrite): `systems/storefront/code/src/pages/OrderComplete.tsx`
- Modify (rewrite): `systems/storefront/code/src/pages/checkout-pages.test.tsx` (now `/order/complete` only)
- Modify: `systems/storefront/code/src/components/cart/CartPanel.tsx`, `CartPanel.test.tsx`
- Modify: `systems/storefront/code/src/routes.tsx` (comment), `src/lib/cart/CartContext.tsx` (comment)
- Delete: `systems/storefront/code/src/lib/stripe.ts`, `src/lib/stripe.test.ts`
- Modify: `systems/storefront/code/package.json` and the root `package-lock.json` (remove `@stripe/*`)

**Interfaces:**
- Consumes: `getCheckoutStatus(orderId)`, `CheckoutError`, `startCheckout → { orderId }` (Task 9); `squareConfig` (Task 10); `OrderConfirmation` (Task 11).
- Produces: `OrderComplete` reads `?order=`; `POLL_INTERVAL_MS`, `POLL_LIMIT_MS` (unchanged); `SLOW_MESSAGE`. `CartPanel` navigates to `/checkout` with state `{ orderId }` and refuses without `squareConfig()`.

- [ ] **Step 1: Write the failing tests**

Replace `src/pages/checkout-pages.test.tsx` with:

```tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { CartProvider, CART_STORAGE_KEY } from '../lib/cart/CartContext'

vi.mock('../lib/api/checkout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api/checkout')>()
  return { ...actual, getCheckoutStatus: vi.fn() }
})
import { getCheckoutStatus, CheckoutError, type CheckoutStatus } from '../lib/api/checkout'
import OrderComplete, { POLL_LIMIT_MS, SLOW_MESSAGE } from './OrderComplete'

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })

const PAID: CheckoutStatus = {
  status: 'paid', orderNumber: 'ABE-000042',
  lines: [{ name: 'Dragon Fortress', sku: 'ABE-3001', quantity: 1, unitPriceCents: 24900, lineSubtotalCents: 24900 }],
  totals: { subtotalCents: 24900, shippingCents: 0, taxCents: 1494, totalCents: 26394 },
}
const CART_LINE = [{ variantId: 'v', productId: 'p', productSlug: 's', name: 'n', priceCents: 1, imageKey: '', quantity: 1 }]

// No navigation happens on this page, so the data router is safe here.
function renderComplete(search = '?order=order-1') {
  const router = createMemoryRouter(
    [{ path: '/order/complete', element: <CartProvider><OrderComplete /></CartProvider> }],
    { initialEntries: [`/order/complete${search}`] },
  )
  return render(<RouterProvider router={router} />)
}
function seedCartAndPreviousOrder() {
  window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(CART_LINE))
  window.sessionStorage.setItem('ab.previousOrderId', 'order-1')
}
function expectCartKept() {
  expect(JSON.parse(window.localStorage.getItem(CART_STORAGE_KEY)!)).toEqual(CART_LINE)
  expect(window.sessionStorage.getItem('ab.previousOrderId')).toBe('order-1')
}
function expectCartCleared() {
  expect(JSON.parse(window.localStorage.getItem(CART_STORAGE_KEY)!)).toEqual([])
  expect(window.sessionStorage.getItem('ab.previousOrderId')).toBeNull()
}

describe('/order/complete', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('confirms a paid order by id, with no provider name, then clears the cart', async () => {
    seedCartAndPreviousOrder()
    vi.mocked(getCheckoutStatus).mockResolvedValue(PAID)
    renderComplete()
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(getCheckoutStatus).toHaveBeenCalledWith('order-1')
    expect(screen.getByText('Order ABE-000042 confirmed')).toBeInTheDocument()
    expect(screen.getByText('$263.94')).toBeInTheDocument()
    expect(document.body.textContent?.toLowerCase()).not.toContain('stripe')
    expectCartCleared()
  })

  it('polls every 1.5 s, settles on the slow message at 20 s and clears the cart', async () => {
    seedCartAndPreviousOrder()
    vi.mocked(getCheckoutStatus).mockResolvedValue({ ...PAID, status: 'pending' })
    renderComplete()
    await act(() => vi.advanceTimersByTimeAsync(3000))
    expect(vi.mocked(getCheckoutStatus).mock.calls.length).toBe(3)
    expectCartKept()
    await act(() => vi.advanceTimersByTimeAsync(POLL_LIMIT_MS))
    expect(screen.getByText(SLOW_MESSAGE)).toBeInTheDocument()
    expectCartCleared()
    const calls = vi.mocked(getCheckoutStatus).mock.calls.length
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(vi.mocked(getCheckoutStatus).mock.calls.length).toBe(calls)
  })

  it('keeps polling through a transient error', async () => {
    vi.mocked(getCheckoutStatus).mockRejectedValueOnce(new Error('blip')).mockResolvedValue(PAID)
    renderComplete()
    await act(() => vi.advanceTimersByTimeAsync(1500))
    expect(screen.getByText('Order ABE-000042 confirmed')).toBeInTheDocument()
  })

  it('says the checkout expired and keeps the cart', async () => {
    seedCartAndPreviousOrder()
    vi.mocked(getCheckoutStatus).mockResolvedValue({ ...PAID, status: 'cancelled' })
    renderComplete()
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('This checkout expired')).toBeInTheDocument()
    expectCartKept()
  })

  it('handles a missing order id without calling core', async () => {
    renderComplete('')
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(getCheckoutStatus).not.toHaveBeenCalled()
    expect(screen.getByText("We couldn't find that checkout")).toBeInTheDocument()
  })

  it('shows a terminal state when core reports the order not_found (Ruling P10)', async () => {
    seedCartAndPreviousOrder()
    vi.mocked(getCheckoutStatus).mockRejectedValue(new CheckoutError('not_found', 'not found'))
    renderComplete()
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText("We couldn't find that order")).toBeInTheDocument()
    expectCartKept()
  })
})
```

In `src/components/cart/CartPanel.test.tsx`:
- Replace `vi.mock('../../lib/stripe', () => ({ getStripe: vi.fn(() => Promise.resolve({})) }))` with `vi.mock('../../lib/square', () => ({ squareConfig: vi.fn(() => ({ applicationId: 'a', locationId: 'l', environment: 'sandbox' })) }))`, and `import { getStripe } from '../../lib/stripe'` with `import { squareConfig } from '../../lib/square'`.
- In `StateProbe`, type the state as `{ orderId: string }` and render `<p>checkout page {state.orderId}</p>`.
- In the "starts checkout …" test: `mockResolvedValue({ orderId: 'new-order' })`, and expect the text `'checkout page new-order'`.
- Replace the last test with:

```tsx
  // A build without the three VITE_SQUARE_* settings cannot show the payment
  // form, so starting a checkout would only reserve stock for nothing.
  it('does not start checkout when this build has no Square settings', async () => {
    vi.mocked(squareConfig).mockReturnValueOnce(null)
    renderCart([LINE('v1', 'Dragon Fortress', 100, 1)])
    await act(async () => {})
    await act(async () => { await userEvent.click(screen.getByRole('button', { name: 'Checkout' })) })
    expect(await screen.findByText('Checkout is temporarily unavailable — please try again in a minute.')).toBeInTheDocument()
    expect(startCheckout).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run src/pages/checkout-pages.test.tsx src/components/cart/CartPanel.test.tsx`
Expected: FAIL. `SLOW_MESSAGE` is not exported, `?order=` is ignored, and `lib/square` is not used by the cart.

- [ ] **Step 3: Rewrite `OrderComplete.tsx`**

```tsx
// src/pages/OrderComplete.tsx (replace the whole file)
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { getCheckoutStatus, CheckoutError, type CheckoutStatus } from '../lib/api/checkout'
import { useCart } from '../lib/cart/CartContext'
import { clearPreviousOrderId } from '../lib/checkout/previousOrder'
import OrderConfirmation from '../components/checkout/OrderConfirmation'

export const POLL_INTERVAL_MS = 1500
export const POLL_LIMIT_MS = 20_000
export const SLOW_MESSAGE = "We're confirming your payment. Please don't pay again — refresh this page in a few minutes."

type View =
  | { kind: 'loading' }
  | { kind: 'paid'; status: CheckoutStatus }
  | { kind: 'slow' }
  | { kind: 'expired' }
  | { kind: 'missing' }
  | { kind: 'order_not_found' }

const heading = 'text-3xl font-black uppercase tracking-[0.05em]'

/**
 * Spec §2 step 6: reloads and the processing state. Polls core by order id
 * every 1.5 s for up to 20 s. The pay response itself confirms most orders
 * on /checkout; this page is reached after a `processing` or
 * `payment_pending` answer, when money is probably in flight -- so, as
 * before (Jack, 2026-09-27), the slow state clears the cart too. It is not
 * cleared on `cancelled` or `not_found`: nothing was bought.
 */
export default function OrderComplete() {
  const [params] = useSearchParams()
  const orderId = params.get('order')
  const { clear } = useCart()
  const [view, setView] = useState<View>(orderId ? { kind: 'loading' } : { kind: 'missing' })

  useEffect(() => {
    if (!orderId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const started = Date.now()
    const forgetCart = () => {
      clear()
      clearPreviousOrderId()
    }
    const tick = async () => {
      try {
        const s = await getCheckoutStatus(orderId)
        if (stopped) return
        if (s.status === 'paid') {
          forgetCart()
          setView({ kind: 'paid', status: s })
          return
        }
        if (s.status === 'cancelled') {
          setView({ kind: 'expired' })
          return
        }
      } catch (err) {
        if (stopped) return
        if (err instanceof CheckoutError && err.code === 'not_found') {
          setView({ kind: 'order_not_found' })
          return
        }
      }
      if (Date.now() - started >= POLL_LIMIT_MS) {
        forgetCart()
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
  }, [orderId, clear])

  const wrap = (children: ReactNode) => (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-24 space-y-6" style={{ fontFamily: 'var(--font-sans)' }}>{children}</div>
  )

  switch (view.kind) {
    case 'loading':
      return wrap(<p className="text-sm text-muted-foreground">Confirming your order…</p>)
    case 'missing':
      return wrap(<><h1 className={heading}>We couldn't find that checkout</h1><Link to="/cart" className="underline text-sm">Back to cart</Link></>)
    case 'order_not_found':
      return wrap(<><h1 className={heading}>We couldn't find that order</h1><Link to="/cart" className="underline text-sm">Back to cart</Link></>)
    case 'expired':
      return wrap(<><h1 className={heading}>This checkout expired</h1><Link to="/cart" className="underline text-sm">Back to cart</Link></>)
    case 'slow':
      return wrap(<p className="text-sm">{SLOW_MESSAGE}</p>)
    case 'paid':
      return <OrderConfirmation status={view.status} />
  }
}
```

- [ ] **Step 4: Update `CartPanel.tsx`**

- Replace `import { getStripe } from '../../lib/stripe'` with `import { squareConfig } from '../../lib/square'`.
- In `checkout()`, replace the Stripe guard and its comment with:

```tsx
    // A build without the VITE_SQUARE_* settings cannot show the payment
    // form, so starting a checkout would only reserve stock for nothing.
    if (squareConfig() === null) {
      setError(UNAVAILABLE_MESSAGE)
      return
    }
```

- Replace `const { orderId, clientSecret } = await startCheckout({` with `const { orderId } = await startCheckout({`, and `navigate('/checkout', { state: { clientSecret, orderId } })` with `navigate('/checkout', { state: { orderId } })`.

- [ ] **Step 5: Remove Stripe, and update the comments that name it**

```bash
git rm src/lib/stripe.ts src/lib/stripe.test.ts
npm uninstall @stripe/react-stripe-js @stripe/stripe-js
```

In `src/routes.tsx`, replace the two-line comment above the `checkout` route with `// Square Web Payments on our own page (spec 2026-09-28 §2). /order/complete?order=<id> is for reloads and the processing state.`

In `src/lib/cart/CartContext.tsx`, replace `Persisted to localStorage: Stripe's return_url is a full page load, so an in-memory cart would already be gone when the confirmation page clears it.` with `Persisted to localStorage so a reload, a new tab, or /order/complete sees the same cart.`

- [ ] **Step 6: Run the storefront suite and the build**

Run: `npx vitest run && npm run build`
Expected: all pass; the build is clean (this closes the PR 2 red window).

Run: `git grep -il stripe -- . ':!*.tsbuildinfo'` (in `systems/storefront/code`)
Expected: no output. `tsconfig.tsbuildinfo` is a build artifact and is refreshed by the build.

- [ ] **Step 7: Commit**

```bash
git add -A src package.json ../../../package-lock.json
git commit -m "feat(storefront): order completion by order id, Square gate on the cart; remove Stripe" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 13: Storefront verification and PR

**Files:** none new.

- [ ] **Step 1: Full checks**

Run: `npx vitest run && npm run build`. Expected: all pass (record the count); the build is clean.

- [ ] **Step 2: See it in the browser (no Square credentials needed for these checks)**

Start core (`npm run dev` in `systems/core`) and the storefront (`npm run dev` here) through the Browser pane's `preview_start` (add a `.claude/launch.json` entry if there is none). Then:
- Add a set and open the cart. The notes and the opt-in (unticked) show.
- Click **Checkout**. If this build has no `VITE_SQUARE_*`, the panel says "Checkout is temporarily unavailable — please try again in a minute." and nothing is POSTed. That is the gate working. If local core has no Square keys either, it answers 503. The paid path is verified in the staging sandbox (Task 15).
- With `VITE_SQUARE_APPLICATION_ID`, `VITE_SQUARE_LOCATION_ID` and `VITE_SQUARE_ENVIRONMENT=sandbox` exported in the dev server's shell (sandbox identifiers Jack provides; they are public but per environment, so do not commit them), and local core configured by Jack, the address step → quote → the Square card form render. Check the Network tab: the script comes from `sandbox.web.squarecdn.com`. Enter `AK` and see "We ship to the contiguous US only."

- [ ] **Step 3: Push (with Jack's OK) and open the PR**

```bash
git push -u origin feat/square-payments-storefront
gh pr create --title "feat(storefront): Square checkout — address, quote, card and wallets" --body "$(cat <<'BODY'
Implements PR 2 (Tasks 9–13) of docs/superpowers/plans/2026-09-28-square-payments.md.

- Checkout client: start -> { orderId }, quote, pay, status by order id, new error codes
- Square Web Payments SDK loader (web.squarecdn.com / sandbox) and card + Apple Pay + Google Pay component
- /checkout: address -> quote summary -> pay -> in-page confirmation; decline / quote_changed / expired / processing / retry-with-same-token
- /order/complete?order= for reloads and processing; cart refuses checkout without VITE_SQUARE_*
- @stripe/* and lib/stripe.ts removed

Needs VITE_SQUARE_APPLICATION_ID / VITE_SQUARE_LOCATION_ID / VITE_SQUARE_ENVIRONMENT on the staging storefront (docs/status/2026-09-28-square-sandbox-runbook.md §2).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
gh pr checks --watch
```
Expected: CI green.

---

# PR 3 — Console (`feat/square-payments-console`)

Cut from `main` after PR 1 merges. It needs core's new detail shape for the fixtures: `git checkout main && git pull --ff-only && git checkout -b feat/square-payments-console`. Commands run in `systems/admin-ui` unless stated. Baseline: `npx vitest run` (record the count). Console conventions: errors via `errorText(err)`, in-flight guards on writes, and no mock fallback.

## Task 14: Order detail and queue — payment reference, provider-neutral copy, fresh fixtures

**Files:**
- Modify: `systems/admin-ui/src/orders/OrderDetail.jsx` (lines 38–42 comment; 79–82 comment; 122–125 payment block; 177–178 cancel copy)
- Modify: `systems/admin-ui/src/orders/OrderQueue.jsx:42`
- Modify: `systems/admin-ui/src/data/__fixtures__/order-detail.json`, `order-queue.json`, `shipping-settings.json` (re-captured from core, not hand-edited)
- Modify: `systems/admin-ui/src/orders/order-detail.test.jsx`, `order-queue.test.jsx`

**Interfaces:**
- Consumes: core `GET /api/v1/admin/orders/:id` → `payment: { provider: 'square'; id: string; url: string | null } | null` (Task 7); error codes `ORDER_PAID`, `PAYMENT_IN_PROGRESS`, `INVALID_TRANSITION` (Task 7).
- Produces: no new exports. The console shows **View payment** (a link) when `payment.url` is set; otherwise **Payment ID** with the id. It never names a provider. `src/lib/errorText.js` is unchanged (its `LABELS` are field names, none provider-specific).

- [ ] **Step 1: Re-capture the fixtures from core**

Run in `systems/core` (DB up, on this branch, which has PR 1): `CAPTURE_ADMIN_FIXTURES=1 npx vitest run tests/capture-admin-fixtures.test.ts` (PowerShell: `$env:CAPTURE_ADMIN_FIXTURES='1'; npx vitest run tests/capture-admin-fixtures.test.ts`).
Expected: PASS. `git diff --stat systems/admin-ui/src/data/__fixtures__` shows `order-detail.json` (and possibly its neighbours) changed. `order-detail.json` now has `"payment": { "provider": "square", "id": "sqpay_fixture", "url": null }` and `"taxJurisdiction": "MI"`, and no `stripePaymentUrl`. Check with `git grep -il stripe -- systems/admin-ui/src/data`: no output.

- [ ] **Step 2: Write the failing tests**

In `src/orders/order-detail.test.jsx`, replace the first test with these two:

```jsx
  it('shows lines, address, money, referral and the payment reference, naming no provider', async () => {
    renderDetail()
    expect(await screen.findByRole('heading', { name: new RegExp(detail.orderNumber) })).toBeInTheDocument()
    expect(screen.getByText(detail.lines[0].name)).toBeInTheDocument()
    expect(screen.getByText(detail.shipTo.line1)).toBeInTheDocument()
    expect(screen.getByText('unmatched')).toBeInTheDocument()
    expect(screen.getByText('Payment ID')).toBeInTheDocument()
    expect(screen.getByText(detail.payment.id)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'View payment' })).not.toBeInTheDocument() // url is null until §9.3
    expect(screen.getByText('Refunds are issued in the payment dashboard.')).toBeInTheDocument()
    expect(document.body.textContent.toLowerCase()).not.toMatch(/stripe|square/)
    expect(screen.getByText('order.paid')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /cancel order/i })).not.toBeInTheDocument() // paid: refund in the payment dashboard
  })

  it('links to the payment when core supplies a URL', async () => {
    renderDetail({ ...detail, payment: { ...detail.payment, url: 'https://example.test/payments/sqpay_fixture' } })
    expect(await screen.findByRole('link', { name: 'View payment' })).toHaveAttribute('href', 'https://example.test/payments/sqpay_fixture')
  })

  it('shows no payment reference for an unpaid order', async () => {
    renderDetail({ ...detail, status: 'pending', payment: null })
    await screen.findByRole('heading', { name: new RegExp(detail.orderNumber) })
    expect(screen.queryByText('Payment ID')).not.toBeInTheDocument()
  })
```

In the same file:
- In `'describes a disputed cancel without naming a payment provider…'`, change `queryByText(/closes the customer's stripe checkout/i)` to `queryByText(/stripe|square/i)`.
- Add, after the `'cancels a pending order after confirmation'` test:

```jsx
  it('describes a pending cancel without naming a payment provider', async () => {
    renderDetail({ ...detail, status: 'pending', payment: null })
    await userEvent.click(await screen.findByRole('button', { name: /cancel order/i }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText("This cancels the customer's checkout and returns the items to stock.")).toBeInTheDocument()
  })

  it('explains a cancel refused because the customer is paying right now', async () => {
    vi.mocked(api.cancelOrder).mockRejectedValue(new AdminApiError('The customer is paying for this order right now. Wait ten minutes, then refresh.', 'PAYMENT_IN_PROGRESS'))
    renderDetail({ ...detail, status: 'pending', payment: null })
    await userEvent.click(await screen.findByRole('button', { name: /cancel order/i }))
    const dialog = screen.getByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel order' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/paying for this order right now/)
  })
```

- Rename `'shows tax and total as pending while Stripe Tax has not run yet'` to `'shows tax and total as pending until the address is quoted'`, and change its `taxJurisdiction: 'stripe_tax_pending'` to `taxJurisdiction: 'quote_pending'`.

In `src/orders/order-queue.test.jsx`, add to the first test:

```jsx
    expect(screen.getByText('Storefront orders. Refunds are issued in the payment dashboard.')).toBeInTheDocument()
    expect(document.body.textContent.toLowerCase()).not.toContain('stripe')
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `npx vitest run src/orders`
Expected: FAIL. There is no "Payment ID", the copy still says Stripe, and the pending-cancel copy names the provider.

- [ ] **Step 4: Update the components**

In `src/orders/OrderDetail.jsx`:
- In the comment block above `requiresAckToCancel`, replace `a refund goes\n  // through the Stripe dashboard instead.` with `a refund goes\n  // through the payment dashboard instead.`
- Replace the tax comment (lines 79–81) with:

```jsx
  // Tax and total are unresolved until the shopper's address is quoted
  // (taxJurisdiction 'quote_pending', or any '*_pending') -- showing $0.00
  // would read as "this order owes no tax".
```

- Replace the Stripe link block (lines 122–125) with:

```jsx
          {order.payment?.url && (
            <a href={order.payment.url} target="_blank" rel="noreferrer" className="mt-3 inline-block text-sm font-semibold">View payment</a>
          )}
          {order.payment && !order.payment.url && (
            <p className="mt-3 text-sm"><span className="text-gray-500">Payment ID</span>{' '}<span className="font-mono">{order.payment.id}</span></p>
          )}
          <p className="mt-2 text-xs text-gray-400">Refunds are issued in the payment dashboard.</p>
```

- Replace the pending-cancel sentence `"This closes the customer's Stripe checkout and returns the items to stock."` with `"This cancels the customer's checkout and returns the items to stock."`

In `src/orders/OrderQueue.jsx` line 42: `Storefront orders. Refunds are issued in the Stripe dashboard.` → `Storefront orders. Refunds are issued in the payment dashboard.`

- [ ] **Step 5: Run the console suite and build**

Run: `npx vitest run && npm run build`
Expected: all pass; the build is clean.

Run: `git grep -il stripe -- src`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/orders src/data/__fixtures__
git commit -m "feat(admin-ui): provider-neutral payment reference and copy; fixtures re-captured from core" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 15: Console PR and the staging sandbox run

**Files:** none new (results go in the PR descriptions).

- [ ] **Step 1: Console checks**

Run in `systems/admin-ui`: `npx vitest run && npm run build`. Expected: all pass (record the count); the build is clean.

- [ ] **Step 2: Push (with Jack's OK) and open the PR**

```bash
git push -u origin feat/square-payments-console
gh pr create --title "feat(admin-ui): provider-neutral payment reference and copy" --body "$(cat <<'BODY'
Implements PR 3 (Tasks 14–15) of docs/superpowers/plans/2026-09-28-square-payments.md.

- Order detail shows core's payment reference: a "View payment" link when payment.url is set, otherwise "Payment ID"
- No provider named anywhere in the console; "Refunds are issued in the payment dashboard."
- Pending-cancel copy no longer mentions a provider checkout; PAYMENT_IN_PROGRESS explained in the dialog
- Fixtures re-captured from core

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
gh pr checks --watch
```
Expected: CI green.

- [ ] **Step 3: Staging sandbox end-to-end (after all three PRs merge and staging deploys)**

This needs Jack to have done `docs/status/2026-09-28-square-sandbox-runbook.md` §§1–6: the sandbox app, the Online location, the storefront keys first, the webhook subscription pinned to `2026-09-16` with the five events, core's five keys in one save, and the partner seed. Do not ask for, or handle, any credential.

Run the eight checks in runbook §7 (spec §6) against `https://staging.alpinebrickexchange.com` and `https://admin-staging.alpinebrickexchange.com`, using sandbox test values only. For each, record the order number, what the console showed and pass/fail in a comment on the core PR. Stop and report on the first failure; do not patch staging data by hand (the $88.01 price change in check 5 is done through the console and reverted there).

Also record the four facts the build could not settle (spec §9):
1. Whether Square emailed a receipt (check 8).
2. That the Dashboard refund reached the webhook (check 4).
3. The Dashboard URL shape of a payment. If a stable pattern exists, open a follow-up to fill `payment.url` in `getAdminOrder`.
4. The location the payments landed at (Online, not an event reader location).

- [ ] **Step 4: Report**

Report to Jack:
- the three PR numbers;
- the eight e2e results and the four §9 facts;
- what is still held by him or the partner:
  - Q3/Q8 nexus and shipping taxability sign-off;
  - §9.1 receipts (the `EmailPort` provider choice, if Square does not send them);
  - §9.4 Square support's answer on destination tax;
  - Q7 whether the Online location already existed;
  - the production gates in spec §8 (per-visitor hold cap, review alerting, production keys, Apple Pay on `www`).

Do not write outside this repo.

---

## Self-review (run 2026-09-28, against the spec)

### Spec coverage

| Spec | Requirement | Task |
|---|---|---|
| §1 Q1 | Square for payments; Stripe removed (SDK, adapter, webhook, env, runbook, copy, deps) | 2, 7, 8, 12, 14 |
| §1 Q2 | No Connect; affiliates/designers paid directly (locked decision recorded) | 8 |
| §1 Q3 / Q8 | `createFlatRateTaxPort` (MI 600 bps); tax on goods only | 3 |
| §1 Q4 | No Square inventory integration | — (nothing built; out of scope honoured) |
| §1 Q5 | Payments only: no `orderId` on CreatePayment (asserted in the adapter test) | 2 |
| §1 Q6 | Web Payments SDK on our `/checkout`, address first | 10, 11 |
| §1 Q7 | Online location: `SQUARE_LOCATION_ID`; other locations' webhooks ignored | 2, 6, 8 |
| §2.1 | `POST /checkout` → `{ orderId }`; `previousOrderId` cancels our own pending order (`onlyIfPending`) | 3 |
| §2.2 | Contiguous US + DC; AK, HI, PR, GU, VI, AS, MP, AA, AE, AP refused before any charge | 3, 11 |
| §2.3 | Quote: public + rate limited; lock; pending; validate; write address/email/name; ShippingPort + TaxPort; store figures + `quoteVersion++`; response shape | 3 |
| §2.4 | Card form + Apple Pay + Google Pay; `tokenize(verificationDetails)` | 10 |
| §2.5.1–5.2 | Lock, pending, stored quote, matching version (409 `quote_changed`), stamp `paymentAttemptAt`, commit | 4 |
| §2.5.3 | `charge()` with key `orderId:quoteVersion:attemptCount` ≤ 45; retried request reuses the key; decline increments | 2, 4 |
| §2.5.4 | COMPLETED → `markOrderPaidTx` + `squarePaymentId` + `paidAt`; customer + consent; referral; `EmailPort.orderPaid`; paid response | 4 |
| §2.5.5 | Decline → 402 `payment_declined`, order stays pending, retry allowed | 2, 4, 11 |
| §2.5.6 | APPROVED/PENDING → `{ status: 'processing' }`; webhook finishes | 4, 6, 11 |
| §2.6 | Confirmation from the pay response, clears cart + `previousOrderId`; `/order/complete?order=` polls status (no address/email) | 3, 11, 12 |
| §2.7 | Sweep: 5 min, older than `session_minutes`, attempt null or > 10 min, no Square call | 5 |
| §2 race rule | Pay and sweep both lock; `order_expired` before charge; stamp before charge; `paid_after_cancel` if a webhook reports it | 4, 5, 6 |
| §3 | Raw body before `express.json`; no CORS/auth; HMAC over configured URL + body, constant time; 400 on bad signature | 2, 6 |
| §3 | `PaymentEvent(provider, eventId)` in the same transaction; duplicate → 200 | 1, 6 |
| §3 table | `payment.updated`; `refund.*` recompute via Square, monotonic, release if paid; `dispute.created`; `dispute.state.updated` with LOST/ACCEPTED error | 6 |
| §3 | `OrderError` → 200 ignored (T7-R1); unknown order < 24 h → 503; older → 200 + error (P15) | 6 |
| §4 core | Port shape, `square@46.0.0` exact, fake, refuse partial config, Stripe removed, `deferredTaxAdapter` removed, schema migration incl. safety | 1, 2, 3 |
| §4 admin | `payment: { provider, url }` (url omitted until confirmed); `STRIPE_UNAVAILABLE` gone; `ORDER_PAID` neutral | 7 (decisions 10, 11) |
| §4 storefront | Script on `web.squarecdn.com` / sandbox; wallets; decline / quote_changed / order_expired copy; `lib/stripe.ts` and `@stripe/*` removed; three `VITE_SQUARE_*`, cart refuses without | 9–12 |
| §4 console | Renders `payment.url` when present; names no provider; "refund it in the payment dashboard" | 7, 14 |
| §4 config | Core five keys + `STOREFRONT_PUBLIC_URL`; storefront three; Stripe keys removed | 8 |
| §4 docs | Engineering `CLAUDE.md` locked decisions; 09-27 supersession note; Square sandbox runbook replaces Stripe's | 8 |
| §5 | Every row of the error table | 3, 4, 6, 7 |
| §6 core | Quote validation incl. AK/HI and the MI figure; pay paths (success, decline, stale, expired, idempotent retry, crash recovery via webhook); sweep during attempt; signature over configured URL; duplicate + out-of-order; refund totals; disputes; migration on existing rows | 1 (rehearsal), 3, 4, 5, 6 |
| §6 UI | Component tests with the SDK faked; no provider names in the console | 10–12, 14 |
| §6 staging | The eight sandbox checks | 8 (runbook §7), 15 |
| §7 | Out of scope honoured: no inventory sync, Square Orders, payouts, tax service, Cash App/Afterpay/ACH, Walmart, production cutover | — |
| §8 | Production gates listed in the runbook and the final report | 8, 15 |
| §9.1–9.5 | Each has a sandbox check or a named owner | 8 (runbook §0, §7), 15 |

No gaps found.

### Placeholder scan

Searched for "TBD", "TODO", "fill in", "similar to Task", and steps without code. The only fill-in is the PR body's `<paste Task 1 Step 6 output>`, which is a deliberate instruction to paste a recorded result. The Apple Pay verification file is Jack's download (runbook §5), not code.

### Type consistency

- `ChargeInput` / `ChargeResult` / `PaymentSummary` / `RefundSummary` / `PaymentsPort` (Task 2) are used unchanged in Tasks 4, 6 and the fake.
- `CheckoutDeps` gains `tax` and `email` in Task 3 and is consumed by `payForOrder` (Task 4) and `createCheckoutRouter`. `AppDeps` drops `storefrontUrl` in Task 3, and `makeApp` never passes it.
- `applyCompletedPayment(tx, orderId, { paymentId, amountCents }, { email })` is defined in Task 4 and called with the same argument shapes in Task 6.
- `attemptInFlight(at, now)` / `PAYMENT_ATTEMPT_GRACE_MS` are defined in Task 3 and used in Tasks 3, 5 and 7.
- `sweepAbandonedCheckouts(now?)` loses its payments parameter (Task 5); `startCheckoutSweep(payments)` keeps it, so `server.ts` is untouched.
- `AdminOrderDetail.payment` (Task 7) is exactly what Task 14 renders and what the fixture capture writes.
- Storefront `PaidResult` / `PayResult` / `Quote` / `QuoteRequest` (Task 9) are used in Tasks 10–12; `QuoteRequest.address.line2` is a string (`''` when empty), and core turns `''` into `null`.
- Fake names: `nextOutcomes`, `duringCharge`, `paymentFor`, `addRefund`, `sign`, `charges`, `payments`. They are used identically across Tasks 2–7.
