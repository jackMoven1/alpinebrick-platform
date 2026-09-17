import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { enqueueJob, processDueJobs, registerHandler, clearHandlers } from '../src/channels/walmart/outbox.js'

describe('walmart outbox', () => {
  beforeEach(async () => {
    await resetDb()
    clearHandlers()
  })

  it('runs a due job and marks it done', async () => {
    const seen: unknown[] = []
    registerHandler('t', async (p) => { seen.push(p) })
    await enqueueJob('t', { a: 1 })
    const r = await processDueJobs()
    expect(r).toEqual({ processed: 1, failed: 0 })
    expect(seen).toEqual([{ a: 1 }])
    expect((await prisma.channelJob.findFirstOrThrow()).status).toBe('done')
  })

  it('dedupes by dedupeKey', async () => {
    registerHandler('t', async () => {})
    expect(await enqueueJob('t', {}, { dedupeKey: 'k1' })).not.toBeNull()
    expect(await enqueueJob('t', {}, { dedupeKey: 'k1' })).toBeNull()
    expect(await prisma.channelJob.count()).toBe(1)
  })

  it('backs off on failure and dead-letters after 5 attempts', async () => {
    registerHandler('t', async () => { throw new Error('nope') })
    await enqueueJob('t', {})
    for (let i = 0; i < 5; i++) {
      const job = await prisma.channelJob.findFirstOrThrow()
      await processDueJobs(new Date(job.runAfter.getTime() + 1))
    }
    const job = await prisma.channelJob.findFirstOrThrow()
    expect(job.status).toBe('dead')
    expect(job.attempts).toBe(5)
    expect(job.lastError).toContain('nope')
  })

  it('skips jobs with runAfter in the future and unknown types fail', async () => {
    registerHandler('known', async () => {})
    await enqueueJob('known', {}, { runAfter: new Date(Date.now() + 60_000) })
    await enqueueJob('unknown', {})
    const r = await processDueJobs()
    expect(r.processed).toBe(0)
    expect(r.failed).toBe(1)
  })

  // Pulled forward from Task 7. Without this, a dedupeKey is spent permanently
  // once its job completes: every later enqueue returns null, so recurring
  // inventory and price pushes stop after the first one and processDueJobs
  // still reports {processed: 0, failed: 0} -- a silent halt.
  it('allows re-enqueue after a deduped job completes', async () => {
    registerHandler('t', async () => {})
    await enqueueJob('t', {}, { dedupeKey: 'k2' })
    await processDueJobs()
    expect(await enqueueJob('t', {}, { dedupeKey: 'k2' })).not.toBeNull()
  })

  // A pending job must still collapse bursts -- the re-enqueue path above must
  // not become a way to double-queue work that has not run yet.
  it('still dedupes while the existing job is pending', async () => {
    registerHandler('t', async () => {})
    await enqueueJob('t', {}, { dedupeKey: 'k3' })
    expect(await enqueueJob('t', {}, { dedupeKey: 'k3' })).toBeNull()
    expect(await prisma.channelJob.count()).toBe(1)
  })
})
