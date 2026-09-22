-- AlterTable
ALTER TABLE "channel_feeds" ADD COLUMN     "listing_ids" JSONB NOT NULL DEFAULT '[]';
