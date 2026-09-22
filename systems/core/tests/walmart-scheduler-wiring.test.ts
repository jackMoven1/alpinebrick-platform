// Final fix wave B1: the in-flight guard and error isolation are tested in
// walmart-scheduler.test.ts through `createGuardedJob` directly -- which
// proves the wrapper works, but not that `startWalmartScheduler` actually
// wraps its real intervals with it. These tests go through the real
// interval wiring: the job functions are vi.mock'd (no I/O), time is faked,
// and the assertions are about what the scheduled intervals do on each tick.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../src/channels/walmart/outbox.js', async (importOriginal) => {
  const actual: any = await importOriginal()
  return { ...actual, processDueJobs: vi.fn() }
})
vi.mock('../src/channels/walmart/pollers.js', () => ({
  pollWalmartOrders: vi.fn(async () => ({})),
  pollWalmartReturns: vi.fn(async () => ({})),
}))
vi.mock('../src/channels/walmart/inventory.sync.js', async (importOriginal) => {
  const actual: any = await importOriginal()
  return { ...actual, reconcileAllInventory: vi.fn(async () => ({ pushed: 0, failed: 0 })) }
})

import { startWalmartScheduler, stopWalmartScheduler } from '../src/channels/walmart/scheduler.js'
import { processDueJobs, clearHandlers } from '../src/channels/walmart/outbox.js'
import type { WalmartClient } from '../src/channels/walmart/client.js'

const client: WalmartClient = { request: async () => ({}) }
const JOBS_TICK_MS = 30_000

describe('walmart scheduler interval wiring (B1)', () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(processDueJobs).mockReset()
    unhandled.length = 0
    process.on('unhandledRejection', onUnhandled)
  })
  afterEach(() => {
    stopWalmartScheduler()
    clearHandlers()
    vi.useRealTimers()
    process.off('unhandledRejection', onUnhandled)
  })

  it('a job that never resolves is invoked once across several ticks (in-flight guard on the real interval)', async () => {
    vi.mocked(processDueJobs).mockImplementation(() => new Promise(() => {}))
    startWalmartScheduler(client)

    await vi.advanceTimersByTimeAsync(JOBS_TICK_MS * 5)

    expect(processDueJobs).toHaveBeenCalledTimes(1)
  })

  it('a job that rejects keeps being invoked on later ticks, with no unhandled rejection', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      vi.mocked(processDueJobs).mockRejectedValue(new Error('db down'))
      startWalmartScheduler(client)

      await vi.advanceTimersByTimeAsync(JOBS_TICK_MS * 4)
      // Let any rejection that escaped the tick surface as 'unhandledRejection'.
      vi.useRealTimers()
      await new Promise((r) => setTimeout(r, 20))

      expect(processDueJobs).toHaveBeenCalledTimes(4)
      expect(unhandled).toEqual([])
      expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('jobs'))).toBe(true)
    } finally {
      errorSpy.mockRestore()
    }
  })
})
