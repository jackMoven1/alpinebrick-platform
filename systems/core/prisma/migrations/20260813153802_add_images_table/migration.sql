-- CreateEnum
CREATE TYPE "ImageStatus" AS ENUM ('pending', 'ready');

-- CreateTable
CREATE TABLE "images" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "alt" TEXT NOT NULL DEFAULT '',
    "position" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "status" "ImageStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "images_storage_key_key" ON "images"("storage_key");

-- CreateIndex
CREATE INDEX "images_product_id_position_idx" ON "images"("product_id", "position");

-- Deferrable, NOT a plain unique index. Postgres checks a non-deferrable
-- constraint after EACH statement, so swapping two images' positions would
-- fail on the first UPDATE against the row that has not moved yet, making
-- reordering impossible. Deferring to commit lets the pair swap atomically.
ALTER TABLE "images"
  ADD CONSTRAINT "images_product_id_position_key"
  UNIQUE ("product_id", "position") DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "images" ADD CONSTRAINT "images_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill existing JSON images into rows. WITH ORDINALITY gives the array
-- index, which becomes position, so display order is preserved exactly.
--
-- width/height are 900x720 because that is the real viewBox of every
-- placeholder SVG currently in the catalogue. THIS IS ONLY TRUE WHILE THE
-- CATALOGUE IS PLACEHOLDERS -- if real photography was loaded before this
-- migration runs, these constants are wrong and each object must be probed
-- for its true dimensions instead.
INSERT INTO "images" (
  "id", "product_id", "storage_key", "alt", "position",
  "width", "height", "content_type", "byte_size", "status", "created_at"
)
SELECT
  gen_random_uuid()::text,
  p."id",
  img.value ->> 'url',
  COALESCE(img.value ->> 'alt', ''),
  (img.ordinality - 1)::int,
  900,
  720,
  'image/svg+xml',
  0,
  'ready'::"ImageStatus",
  NOW()
FROM "products" p
CROSS JOIN LATERAL jsonb_array_elements(p."images"::jsonb) WITH ORDINALITY AS img(value, ordinality)
WHERE jsonb_typeof(p."images"::jsonb) = 'array'
  AND img.value ->> 'url' IS NOT NULL;
