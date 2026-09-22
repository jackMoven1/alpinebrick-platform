-- AlterTable
ALTER TABLE "channel_settlements" ADD COLUMN     "discrepancy_cents" INTEGER;

-- CreateIndex
CREATE INDEX "channel_settlements_status_idx" ON "channel_settlements"("status");
