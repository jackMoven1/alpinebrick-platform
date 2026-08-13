-- CreateEnum
CREATE TYPE "OrderChannel" AS ENUM ('storefront', 'walmart');

-- CreateEnum
CREATE TYPE "ChannelListingStatus" AS ENUM ('draft', 'submitted', 'live', 'rejected', 'retired');

-- CreateEnum
CREATE TYPE "ChannelFeedType" AS ENUM ('item', 'price', 'inventory');

-- CreateEnum
CREATE TYPE "ChannelFeedStatus" AS ENUM ('submitted', 'processed', 'error');

-- CreateEnum
CREATE TYPE "ChannelEventSource" AS ENUM ('webhook', 'poll');

-- CreateEnum
CREATE TYPE "ChannelJobStatus" AS ENUM ('pending', 'done', 'dead');

-- CreateEnum
CREATE TYPE "ChannelSettlementStatus" AS ENUM ('matched', 'unmatched');

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'refunded';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "channel" "OrderChannel" NOT NULL DEFAULT 'storefront',
ADD COLUMN     "external_order_id" TEXT;

-- CreateTable
CREATE TABLE "channel_listings" (
    "id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "walmart_sku" TEXT NOT NULL,
    "status" "ChannelListingStatus" NOT NULL DEFAULT 'draft',
    "buffer_pct" INTEGER,
    "price_override_cents" INTEGER,
    "last_pushed_qty" INTEGER,
    "last_pushed_price_cents" INTEGER,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_feeds" (
    "id" TEXT NOT NULL,
    "feed_id" TEXT NOT NULL,
    "type" "ChannelFeedType" NOT NULL,
    "status" "ChannelFeedStatus" NOT NULL DEFAULT 'submitted',
    "errors" JSONB,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_feeds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_events" (
    "id" TEXT NOT NULL,
    "source" "ChannelEventSource" NOT NULL,
    "external_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_jobs" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "ChannelJobStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "run_after" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "dedupe_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_settlements" (
    "id" TEXT NOT NULL,
    "report_date" TIMESTAMP(3) NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "fee_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "order_id" TEXT,
    "status" "ChannelSettlementStatus" NOT NULL DEFAULT 'unmatched',
    "raw" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "channel_listings_variant_id_key" ON "channel_listings"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_listings_walmart_sku_key" ON "channel_listings"("walmart_sku");

-- CreateIndex
CREATE UNIQUE INDEX "channel_feeds_feed_id_key" ON "channel_feeds"("feed_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_events_external_id_event_type_key" ON "channel_events"("external_id", "event_type");

-- CreateIndex
CREATE UNIQUE INDEX "channel_jobs_dedupe_key_key" ON "channel_jobs"("dedupe_key");

-- CreateIndex
CREATE INDEX "channel_jobs_status_run_after_idx" ON "channel_jobs"("status", "run_after");

-- CreateIndex
CREATE INDEX "channel_settlements_external_order_id_idx" ON "channel_settlements"("external_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_external_order_id_key" ON "orders"("external_order_id");

-- AddForeignKey
ALTER TABLE "channel_listings" ADD CONSTRAINT "channel_listings_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

