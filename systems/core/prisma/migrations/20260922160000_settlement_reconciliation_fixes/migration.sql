-- AlterEnum
ALTER TYPE "ChannelSettlementStatus" ADD VALUE 'discrepant';

-- AlterTable
ALTER TABLE "channel_settlements" ADD COLUMN     "transaction_type" TEXT NOT NULL,
ADD COLUMN     "net_cents" INTEGER NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "channel_settlements_external_order_id_report_date_transac_key" ON "channel_settlements"("external_order_id", "report_date", "transaction_type", "amount_cents", "fee_cents");
