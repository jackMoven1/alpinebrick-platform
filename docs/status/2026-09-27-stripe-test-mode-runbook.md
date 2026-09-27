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
3. Create the webhook endpoint **first** (step 3 below) so its signing secret exists.
4. Render → staging `core-env` group: set `STRIPE_SECRET_KEY` (the `sk_test_…`
   value), `STRIPE_WEBHOOK_SECRET` (the `whsec_…` value from step 3) and
   `STOREFRONT_PUBLIC_URL` = `https://staging.alpinebrickexchange.com`
   **together, in one save**. Core refuses to start when any one of these
   three is set without the other two — saving them separately means an
   in-between deploy fails to boot, and Render redeploys on every save.
5. Render → staging `storefront` service: set `VITE_STRIPE_PUBLISHABLE_KEY` = the `pk_test_…` value.

## 2. Stripe Tax (test mode)

1. Dashboard → Tax → set the origin address (the business address) and turn on Stripe Tax.
2. Tax → Registrations → add **Michigan** (test mode). Without a registration
   Stripe computes $0 tax everywhere and the staging "Michigan address with tax" check fails.
3. Leave the default product tax code alone; the code sets it per line.

## 3. Webhook endpoint

Do this **before** step 1.4 above — the signing secret this produces is one
of the three values saved together.

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
5. Reveal the **signing secret** (`whsec_…`) and use it in step 1.4's combined
   save.
6. After that save, Render redeploys `core-api` (staging) automatically.
   Check the deploy log shows `core listening` and no "Stripe is
   half-configured" error. Redeploy the `storefront` (staging) so the
   publishable key is baked into the build.

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

## 7. Trust-proxy verification (carried from Task 6 review)

`app.set('trust proxy', 1)` tells Express to trust exactly one hop of
`X-Forwarded-For` when deriving the client IP the checkout rate limiter keys
on (20/min per IP). If Render puts more than one proxy hop in front of
`core-api`, `req.ip` resolves to an intermediate proxy's address instead of
the real client's, and the per-IP limiter either lumps every visitor behind
that hop together or — if the hop count is set too low — trusts an
attacker-supplied `X-Forwarded-For` value outright.

Confirm this once on staging before relying on the limiter:

1. From a browser (not curl, so a real Render edge hop is in the path), hit
   any endpoint that is easy to correlate with a timestamp, e.g.
   `GET /api/v1/checkout/config`.
2. In the Render dashboard, open the `core-api` (staging) service logs for
   that request's timestamp and compare the inbound `X-Forwarded-For` header
   value Render's edge sent against what `req.ip` resolved to. (Render's
   request logs show the raw header; if core's own access log does not
   already print `req.ip`, add a temporary `console.log(req.ip,
   req.headers['x-forwarded-for'])` in a scratch branch for this one check
   and remove it before merging — do not leave debug logging in the shipped
   code.)
3. `req.ip` should equal the **last** address in `X-Forwarded-For` before
   Render's own edge IP (i.e. the one hop closest to the origin, which is
   what `trust proxy: 1` selects). If it instead equals the first
   (client-supplied) address, or an internal/private address, the hop count
   is wrong and the rate limiter is keying on the wrong value — raise this
   before relying on the 20/min limiter in production.
4. Repeat the same check by triggering the checkout rate limiter directly
   (e.g. a scripted burst of `POST /api/v1/checkout` requests from one
   machine) and confirm the `429 rate_limited` response applies to that one
   client, not to unrelated traffic.
