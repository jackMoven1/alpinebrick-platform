-- The contract step of expand -> migrate -> contract.
--
-- The preceding migration created the images table and backfilled every entry
-- from this column, and the catalog DTO now reads the relation. Nothing else
-- references it, so the legacy JSON column goes.
ALTER TABLE "products" DROP COLUMN "images";
