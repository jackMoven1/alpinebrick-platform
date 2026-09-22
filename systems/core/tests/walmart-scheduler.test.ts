import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  startWalmartScheduler,
  stopWalmartScheduler,
  registerAllWalmartHandlers,
  getActiveTimers,
  createGuardedJob,
  runSettlementJob,
} from '../src/channels/walmart/scheduler.js'
import { clearHandlers, enqueueJob, processDueJobs } from '../src/channels/walmart/outbox.js'
import { resetDb } from './helpers/db.js'
import type { WalmartClient } from '../src/channels/walmart/client.js'
import type { SettlementImportResult } from '../src/channels/walmart/settlement.js'

describe('walmart scheduler', () => {
  afterEach(() => { stopWalmartScheduler(); clearHandlers() })

  // --- Brief's own tests (Task 13 brief, Step 1) -----------------------

  it('registers handlers for all outbound job types', async () => {
    await resetDb()
    const client: WalmartClient = { request: async () => ({}) }
    registerAllWalmartHandlers(client)
    for (const type of ['walmart_push_inventory', 'walmart_push_price', 'walmart_ack_order', 'walmart_ship_order', 'walmart_cancel_order']) {
      await enqueueJob(type, { variantId: 'missing', orderId: 'missing', externalOrderId: 'PO-X' })
    }
    const r = await processDueJobs()
    // inventory/price on a missing variant no-op (processed); ship/cancel on a missing order fail (retryable) -- the point is every type HAS a handler, so nothing fails with "no handler registered"
    const jobs = await (await import('../src/prisma.js')).prisma.channelJob.findMany()
    expect(jobs.every((j) => j.lastError === null || !j.lastError.includes('no handler'))).toBe(true)
    expect(r.processed + r.failed).toBe(5)
  })

  it('start/stop is idempotent and does not throw', () => {
    const client: WalmartClient = { request: async () => ({}) }
    startWalmartScheduler(client)
    startWalmartScheduler(client)
    stopWalmartScheduler()
    stopWalmartScheduler()
  })

  // --- Ruling 2: keepAlive ----------------------------------------------
  //
  // The brief unref()s every timer unconditionally -- fine for tests, fatal
  // for a worker process with nothing else on the event loop (unref'd
  // intervals let node exit immediately). `startWalmartScheduler`'s second
  // argument controls this; default is `keepAlive: false` (unref, matching
  // the brief), and `worker.ts` passes `keepAlive: true`. Checked directly
  // via `timer.hasRef()` on the timers `getActiveTimers()` exposes -- we
  // never let a real interval actually fire here (stopWalmartScheduler runs
  // before the shortest one, 30s, could elapse).

  it('unrefs every timer by default (keepAlive: false)', () => {
    const client: WalmartClient = { request: async () => ({}) }
    startWalmartScheduler(client)
    const timers = getActiveTimers()
    expect(timers.length).toBeGreaterThan(0)
    expect(timers.every((t) => t.hasRef() === false)).toBe(true)
  })

  it('refs every timer when keepAlive is true, so a worker process stays alive', () => {
    const client: WalmartClient = { request: async () => ({}) }
    startWalmartScheduler(client, { keepAlive: true })
    const timers = getActiveTimers()
    expect(timers.length).toBeGreaterThan(0)
    expect(timers.every((t) => t.hasRef() === true)).toBe(true)
  })

  // --- Ruling 3: settlement is gated separately, default off ------------

  it('does not register the settlement interval unless opts.settlement is true', () => {
    const client: WalmartClient = { request: async () => ({}) }
    startWalmartScheduler(client)
    // processDueJobs / pollWalmartOrders / pollWalmartReturns / reconcileAllInventory -- 4, never 5.
    expect(getActiveTimers().length).toBe(4)
  })

  it('registers a 5th interval for settlement when opts.settlement is true', () => {
    const client: WalmartClient = { request: async () => ({}) }
    startWalmartScheduler(client, { settlement: true })
    expect(getActiveTimers().length).toBe(5)
  })

  it('runSettlementJob logs the result and warns when rows imported but none linked', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client: WalmartClient = { request: async () => ({}) }
    const result: SettlementImportResult = { imported: 3, linked: 0, unmatched: 3 }
    const importFn = vi.fn(async () => result)

    const got = await runSettlementJob(client, importFn)

    expect(got).toBe(result)
    expect(importFn).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain('imported')

    warnSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('runSettlementJob does not warn when some rows linked', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client: WalmartClient = { request: async () => ({}) }
    const result: SettlementImportResult = { imported: 3, linked: 2, unmatched: 1 }
    const importFn = vi.fn(async () => result)

    await runSettlementJob(client, importFn)

    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('runSettlementJob does not warn when nothing was imported', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client: WalmartClient = { request: async () => ({}) }
    const result: SettlementImportResult = { imported: 0, linked: 0, unmatched: 0 }
    const importFn = vi.fn(async () => result)

    await runSettlementJob(client, importFn)

    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
    logSpy.mockRestore()
  })

  // --- Ruling 5: in-flight guard -----------------------------------------
  //
  // `createGuardedJob` is the exact per-tick unit `startWalmartScheduler`'s
  // intervals wrap around each registered job (see scheduler.ts) -- testing
  // it directly, by invoking the tick function it returns more than once
  // while the first invocation's promise is still pending, is equivalent to
  // "two ticks of the real interval, the second while the first is still
  // running" but deterministic: no timer needs to actually fire.

  it('does not invoke an in-flight job again on a second tick', async () => {
    let calls = 0
    let release!: () => void
    const fn = () => new Promise<void>((resolve) => {
      calls++
      release = resolve // overwritten on each real invocation of fn -- one release per run
    })
    const tick = createGuardedJob('probe', fn)

    const first = tick() // starts the job; leaves it pending
    const second = tick() // "next tick" while the first has not resolved -- must be a no-op
    expect(calls).toBe(1) // fn was NOT invoked a second time

    release() // resolve the first (and only) run
    await first
    await second

    const third = tick() // the first run has finished -- this one is allowed to actually run
    expect(calls).toBe(2)
    release() // resolve the third run's own promise (release was reassigned when fn ran again)
    await third
  })

  // --- Ruling 6: every callback catches its own error --------------------

  it('keeps firing on later ticks after a job throws, and logs the label', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let calls = 0
    const fn = async () => {
      calls++
      throw new Error('kaboom')
    }
    const tick = createGuardedJob('test-error-job', fn)

    await tick()
    await tick()
    await tick()

    expect(calls).toBe(3)
    expect(errorSpy).toHaveBeenCalledTimes(3)
    expect(String(errorSpy.mock.calls[0][0])).toContain('test-error-job')

    errorSpy.mockRestore()
  })
})
