-- Roll Square back to Stripe (Jack, 2026-10-01). Reverses
-- 20260928120000_square_payments, which stays in history because production
-- (synced to main, preDeploy `prisma migrate deploy`) may already have run it.
-- Ends at the schema 20260927120000_revenue_loop_checkout left.

-- Guard FIRST, before any DDL: a Square payment id is the only record of money
-- Square took for an order. If any exist, stop rather than drop them. On a
-- Square *sandbox* database, null them out by hand first (see
-- docs/status/2026-09-27-stripe-test-mode-runbook.md, "Rolling back from Square").
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "orders" WHERE "square_payment_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'orders carry Square payment ids; settle them before rolling back to Stripe';
  END IF;
  IF EXISTS (SELECT 1 FROM "orders" WHERE "review_reason" = 'duplicate_payment') THEN
    RAISE EXCEPTION 'orders flagged duplicate_payment; resolve them before rolling back to Stripe';
  END IF;
END $$;

-- orders: Square columns out, Stripe columns back.
ALTER TABLE "orders" DROP CONSTRAINT "orders_payment_counters_nonnegative";
ALTER TABLE "orders"
  DROP COLUMN "square_payment_id",
  DROP COLUMN "payment_attempt_at",
  DROP COLUMN "payment_attempt_count",
  DROP COLUMN "quote_version",
  ADD COLUMN "stripe_checkout_session_id" TEXT,
  ADD COLUMN "stripe_payment_intent_id" TEXT;
CREATE UNIQUE INDEX "orders_stripe_checkout_session_id_key" ON "orders"("stripe_checkout_session_id");
CREATE UNIQUE INDEX "orders_stripe_payment_intent_id_key" ON "orders"("stripe_payment_intent_id");

-- payment_events -> stripe_events, keyed by id. Square rows are only webhook
-- de-dup records; they mean nothing to the Stripe handler.
DELETE FROM "payment_events" WHERE "provider" <> 'stripe';
ALTER TABLE "payment_events" DROP CONSTRAINT "payment_events_pkey";
ALTER TABLE "payment_events" DROP COLUMN "provider";
ALTER TABLE "payment_events" RENAME COLUMN "event_id" TO "id";
ALTER TABLE "payment_events" RENAME TO "stripe_events";
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id");

-- OrderReviewReason loses 'duplicate_payment'. Postgres cannot drop an enum
-- value, so swap the type (the guard above means no row holds it).
ALTER TYPE "OrderReviewReason" RENAME TO "OrderReviewReason_old";
CREATE TYPE "OrderReviewReason" AS ENUM ('amount_mismatch', 'paid_after_cancel', 'outside_shipping_area', 'disputed');
ALTER TABLE "orders" ALTER COLUMN "review_reason" TYPE "OrderReviewReason"
  USING ("review_reason"::text::"OrderReviewReason");
DROP TYPE "OrderReviewReason_old";
