-- Data migration: create the 'system' actor sentinel.
--
-- No migration has ever inserted this row -- only prisma/seed.ts creates it,
-- and render.yaml's preDeployCommand is `npx prisma migrate deploy`, with no
-- seed step. On a fresh production database `actors` is therefore empty.
--
-- That is now a production-blocking defect, not just a missing audit row:
-- src/orders/orders.service.ts calls recordAudit() *inside* the same
-- transaction as placeOrder / markOrderPaid / fulfillOrder / cancelOrder,
-- defaulting actorId to 'system'. Without this row, recordAudit hits a
-- foreign-key violation on audit_log.actor_id and the transaction -- order
-- state change included -- rolls back. Placing or paying an order fails
-- outright on a fresh deploy.
--
-- Matches prisma/seed.ts's upsert exactly: { id: 'system', type: 'human',
-- name: 'system' }. Do not change `type` to 'agent' here -- existing
-- databases already hold 'human' from the seed, and diverging would make
-- environments inconsistent.
--
-- ON CONFLICT DO NOTHING makes this safe to re-run, and safe on a database
-- where prisma/seed.ts already created the row.
INSERT INTO "actors" ("id", "type", "name")
VALUES ('system', 'human', 'system')
ON CONFLICT ("id") DO NOTHING;
