-- Catalog editing (spec 2026-09-24).
--
-- first_published_at: no backfill. Nothing had been published on any
-- environment when this ran. Where products HAD been published, those rows
-- would read as never-published and keep an editable slug -- a one-time gap.
ALTER TABLE "products" ADD COLUMN "first_published_at" TIMESTAMP(3);

-- walmart_allocation: NULL (shared) for every existing row, the chosen default.
ALTER TABLE "inventory" ADD COLUMN "walmart_allocation" INTEGER;
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_walmart_allocation_nonnegative"
  CHECK ("walmart_allocation" IS NULL OR "walmart_allocation" >= 0);
