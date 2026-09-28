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

-- OrderReviewReason gains 'duplicate_payment' (Q-P1): a second COMPLETED
-- payment for an already-paid order flags this way.
ALTER TYPE "OrderReviewReason" ADD VALUE 'duplicate_payment';

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
