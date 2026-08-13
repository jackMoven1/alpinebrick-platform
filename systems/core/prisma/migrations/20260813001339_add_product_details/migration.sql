-- CreateEnum
CREATE TYPE "Difficulty" AS ENUM ('beginner', 'intermediate', 'advanced', 'expert');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "age_recommendation" TEXT,
ADD COLUMN     "builder_notes" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "collection_position" INTEGER,
ADD COLUMN     "difficulty" "Difficulty",
ADD COLUMN     "dimensions" TEXT,
ADD COLUMN     "features" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "home_position" INTEGER,
ADD COLUMN     "includes" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "long_description" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "pieces" INTEGER;

-- CreateIndex
CREATE INDEX "products_home_position_idx" ON "products"("home_position");

-- CreateIndex
CREATE INDEX "products_collection_position_idx" ON "products"("collection_position");
