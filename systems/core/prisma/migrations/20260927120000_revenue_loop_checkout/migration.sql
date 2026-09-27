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
