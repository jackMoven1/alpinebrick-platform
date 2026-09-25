-- The percentage buffer is replaced by the per-variant Walmart allocation
-- (spec 2026-09-24 §5.1 rule 5): it told Walmart 0 for every one-off.
-- No listings exist on any environment.
ALTER TABLE "channel_listings" DROP COLUMN "buffer_pct";
