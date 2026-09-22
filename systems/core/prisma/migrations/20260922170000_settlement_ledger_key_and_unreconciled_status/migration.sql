-- AlterEnum
ALTER TYPE "ChannelSettlementStatus" ADD VALUE 'unreconciled';

-- DropIndex
DROP INDEX "channel_settlements_external_order_id_report_date_transac_key";

-- AlterTable
-- Review round 4: add nullable, backfill, THEN constrain. Adding the column
-- as NOT NULL directly fails on any table that already holds rows. Existing
-- rows get `legacy:<id>` -- unique by construction (ids are unique), and the
-- prefix can never collide with the `tk:` / `po:` / `raw:` keys settlement.ts
-- writes. Backfilled rows are NOT re-keyed into the identity scheme (that
-- needs the parsed row fields, which only settlement.ts has), so re-importing
-- the report they came from would not recognise them as already imported.
ALTER TABLE "channel_settlements" ADD COLUMN     "ledger_key" TEXT;
UPDATE "channel_settlements" SET "ledger_key" = 'legacy:' || "id" WHERE "ledger_key" IS NULL;
ALTER TABLE "channel_settlements" ALTER COLUMN "ledger_key" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "channel_settlements_ledger_key_key" ON "channel_settlements"("ledger_key");
