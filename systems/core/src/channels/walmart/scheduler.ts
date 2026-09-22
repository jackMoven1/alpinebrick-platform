// Wires every outbound job handler and every recurring Walmart job
// (outbox drain, order/return pollers, inventory reconciliation, settlement
// import) into one process-owned scheduler. This module owns no process
// lifecycle itself -- `worker.ts` decides whether to call
// `startWalmartScheduler` at all, and with which options; `server.ts` is
// deliberately left untouched (see worker.ts's own header comment for why).
import { type WalmartClient, getWalmartClient } from './client.js'
import { processDueJobs } from './outbox.js'
import { pollWalmartOrders, pollWalmartReturns } from './pollers.js'
import { reconcileAllInventory, registerInventoryHandlers } from './inventory.sync.js'
import { registerPriceHandlers } from './price.sync.js'
import { registerShippingHandlers } from './shipping.js'
import { fetchAndImportSettlement, type SettlementImportResult } from './settlement.js'

export interface SchedulerOptions {
  /**
   * `false` (default) `unref()`s every interval, matching the Task 13 brief
   * -- a test process (or anything else already exiting on its own) must
   * never be kept alive by these timers. `true` refs them instead, which
   * `worker.ts` passes: a worker process has nothing else on the event
   * loop, so unref'd timers would let node exit immediately after start.
   */
  keepAlive?: boolean
  /**
   * Registers the 24h settlement-import interval only when `true`. Default
   * `false` -- `fetchAndImportSettlement` is unverified against a real
   * Walmart report (see settlement.ts's file-top banner) and carries an
   * unresolved cross-call re-stamping defect (finding B4, see the
   * `BLOCKER FOR PRODUCTION LAUNCH` comment near `importSettlementRowsAttempt`).
   * `worker.ts` sets this from `WALMART_SETTLEMENT_ENABLED`.
   */
  settlement?: boolean
}

let timers: NodeJS.Timeout[] = []

// Per-job-label in-flight guard. `processDueJobs` (every 30s) can outlast
// 30s; two concurrent pollers of the same kind running at once is pointless
// duplicate load (and, for the outbox drain, pointless contention on the
// same due jobs). Keyed by the job's own label, not by timer, so it works
// the same way whether the guarded job is registered through
// `startWalmartScheduler` or invoked directly (as tests do via
// `createGuardedJob`).
const inFlight = new Set<string>()

export function registerAllWalmartHandlers(client: WalmartClient = getWalmartClient()): void {
  registerInventoryHandlers(client)
  registerPriceHandlers(client)
  registerShippingHandlers(client)
}

/**
 * Wraps `fn` with the in-flight guard (ruling 5) and per-callback error
 * isolation (ruling 6: `console.error`, tagged with `label`, so one job's
 * failure never kills its own timer -- or any other job's). Returns a
 * zero-arg function that resolves once the guarded run (or the no-op skip)
 * completes, so `startWalmartScheduler`'s intervals can fire-and-forget it
 * while tests can `await` it directly.
 *
 * Exported as the minimal seam needed to test the guard and the error
 * isolation without depending on real interval periods (30s..24h) or any
 * I/O: this is the exact unit each interval below wraps around its job, so
 * exercising it directly is equivalent to driving it through a real tick,
 * without the flakiness of waiting on real (or fake) timers.
 */
export function createGuardedJob(label: string, fn: () => Promise<unknown>): () => Promise<void> {
  return async () => {
    if (inFlight.has(label)) return
    inFlight.add(label)
    try {
      await fn()
    } catch (e) {
      console.error(`walmart scheduler ${label}:`, e)
    } finally {
      inFlight.delete(label)
    }
  }
}

/**
 * Settlement's recurring callback, factored out of `startWalmartScheduler`
 * so it can be tested directly (with a stub `importFn`) without waiting on
 * the real 24h interval or a real settlement fetch. `importFn` defaults to
 * the real `fetchAndImportSettlement`; `worker.ts` and `startWalmartScheduler`
 * never pass anything else -- the parameter exists for tests.
 *
 * Always logs the result. `imported > 0 && linked === 0` -- rows landed but
 * not one of them matched an order we know about -- is a report that
 * reconciled nothing, which is exactly the shape a wrong report format or a
 * broken order-matching assumption would produce; `console.warn` flags it
 * as the thing an operator should look at, without throwing (a bad
 * reconciliation result must not kill the settlement timer any more than any
 * other job's failure kills its own -- see `createGuardedJob`).
 */
export async function runSettlementJob(
  client: WalmartClient,
  importFn: (reportDate: Date, client: WalmartClient) => Promise<SettlementImportResult> = fetchAndImportSettlement,
): Promise<SettlementImportResult> {
  const yesterday = new Date(Date.now() - 24 * 3600_000)
  const result = await importFn(yesterday, client)
  console.log('walmart scheduler settlement:', result)
  if (result.imported > 0 && result.linked === 0) {
    console.warn('walmart scheduler settlement: imported rows but linked none -- report may not be reconciling', result)
  }
  return result
}

function every(ms: number, runner: () => Promise<void>, keepAlive: boolean): NodeJS.Timeout {
  const t = setInterval(() => { void runner() }, ms)
  if (!keepAlive) t.unref()
  timers.push(t)
  return t
}

/**
 * Registers all outbound job handlers, then starts every recurring Walmart
 * job on its own interval. Idempotent -- a second call while timers are
 * already running is a no-op, matching the brief's "start/stop is
 * idempotent" test.
 */
export function startWalmartScheduler(
  client: WalmartClient = getWalmartClient(),
  opts: SchedulerOptions = {},
): void {
  if (timers.length > 0) return
  const keepAlive = opts.keepAlive ?? false

  registerAllWalmartHandlers(client)

  every(30_000, createGuardedJob('jobs', () => processDueJobs()), keepAlive)
  every(15 * 60_000, createGuardedJob('orders-poll', () => pollWalmartOrders(client)), keepAlive)
  every(30 * 60_000, createGuardedJob('returns-poll', () => pollWalmartReturns(client)), keepAlive)
  every(60 * 60_000, createGuardedJob('inventory-reconcile', () => reconcileAllInventory(client)), keepAlive)

  if (opts.settlement === true) {
    every(24 * 3600_000, createGuardedJob('settlement', () => runSettlementJob(client)), keepAlive)
  }
}

export function stopWalmartScheduler(): void {
  for (const t of timers) clearInterval(t)
  timers = []
  inFlight.clear()
}

/**
 * Test seam: the timers `startWalmartScheduler` currently owns, so a test
 * can assert on `.hasRef()` (ruling 2's keepAlive gate) or on how many
 * intervals got registered (ruling 3's settlement gate) without reaching
 * into module internals. Not used by production code.
 */
export function getActiveTimers(): NodeJS.Timeout[] {
  return timers
}
