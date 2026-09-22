-- Review round 4, finding 5: carry the provisional status of settlement
-- reconciliation in the data itself. The DEFAULT backfills any existing row
-- with 'unverified', which is the correct provenance for every row written
-- before Task 13's sandbox check.
-- AlterTable
ALTER TABLE "channel_settlements" ADD COLUMN     "reconciliation_model" TEXT NOT NULL DEFAULT 'unverified';
