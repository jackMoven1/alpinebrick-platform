-- AlterTable
-- Units on a placed-but-not-yet-received purchase order. Additive and
-- backfill-safe: existing rows take the default of 0, which is correct —
-- there are no purchase orders in the system yet.
ALTER TABLE "inventory" ADD COLUMN     "on_order" INTEGER NOT NULL DEFAULT 0;
