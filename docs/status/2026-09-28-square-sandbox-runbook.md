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
