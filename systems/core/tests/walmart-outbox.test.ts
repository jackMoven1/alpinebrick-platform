import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { enqueueJob, enqueueIdempotentJob, processDueJobs, registerHandler, clearHandlers } from '../src/channels/walmart/outbox.js'

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

  // enqueueIdempotentJob exists specifically so an in-transaction caller
  // (ingestWalmartOrder's ack-job enqueue) never risks a raising INSERT on a
  // dedupeKey collision -- see its doc comment for why enqueueJob's ordinary
  // P2002-catch-and-recover would poison the surrounding transaction. These
  // exercise it directly, against the default client, independent of any
  // ingest flow.
  describe('enqueueIdempotentJob', () => {
    it('creates the job when the key is free', async () => {
      await enqueueIdempotentJob('t', { a: 1 }, 'idem-k1', prisma)
      const job = await prisma.channelJob.findUniqueOrThrow({ where: { dedupeKey: 'idem-k1' } })
      expect(job).toMatchObject({ type: 't', status: 'pending', payload: { a: 1 } })
    })

    it('is a silent no-op -- no throw, no duplicate -- when the key already holds a pending job', async () => {
      await enqueueIdempotentJob('t', { a: 1 }, 'idem-k2', prisma)
      await expect(enqueueIdempotentJob('t', { a: 2 }, 'idem-k2', prisma)).resolves.toBeUndefined()
      expect(await prisma.channelJob.count({ where: { dedupeKey: 'idem-k2' } })).toBe(1)
      const job = await prisma.channelJob.findUniqueOrThrow({ where: { dedupeKey: 'idem-k2' } })
      expect(job.payload).toEqual({ a: 1 }) // untouched -- the second call was skipped, not applied
    })

    it('leaves a done job alone -- the one-shot work it names already completed', async () => {
      await prisma.channelJob.create({ data: { type: 't', payload: {}, dedupeKey: 'idem-k3', status: 'done' } })
      await enqueueIdempotentJob('t', {}, 'idem-k3', prisma)
      expect(await prisma.channelJob.count({ where: { dedupeKey: 'idem-k3' } })).toBe(1)
      const job = await prisma.channelJob.findUniqueOrThrow({ where: { dedupeKey: 'idem-k3' } })
      expect(job.status).toBe('done')
    })

    it('revives a dead job under the key back to pending, instead of leaving it stuck forever', async () => {
      await prisma.channelJob.create({
        data: { type: 't', payload: {}, dedupeKey: 'idem-k4', status: 'dead', attempts: 5, lastError: 'boom' },
      })
      await enqueueIdempotentJob('t', {}, 'idem-k4', prisma)
      expect(await prisma.channelJob.count({ where: { dedupeKey: 'idem-k4' } })).toBe(1)
      const job = await prisma.channelJob.findUniqueOrThrow({ where: { dedupeKey: 'idem-k4' } })
      expect(job).toMatchObject({ status: 'pending', attempts: 0, lastError: null })
    })
  })
})
