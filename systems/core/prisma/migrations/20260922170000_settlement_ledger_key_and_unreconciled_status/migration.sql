-- AlterEnum
ALTER TYPE "ChannelSettlementStatus" ADD VALUE 'unreconciled';

-- DropIndex
DROP INDEX "channel_settlements_external_order_id_report_date_transac_key";

-- AlterTable
ALTER TABLE "channel_settlements" ADD COLUMN     "ledger_key" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "channel_settlements_ledger_key_key" ON "channel_settlements"("ledger_key");
