import { describe, it, expect, beforeEach, vi } from 'vitest'
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

  // --- Final fix wave A2: dedupe claim released at pickup, recurring only ---
  //
  // A job stays `pending` while its handler runs. Before this fix, an
  // enqueueJob under the same key during that window returned null, while the
  // running handler had already read the old stock -- the change was lost
  // until the hourly reconcile. A gate lets each test enqueue mid-run.
  function blockingHandler() {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const started = new Promise<void>((r) => { entered = r })
    const handler = async () => { entered(); await gate }
    return { handler, started, release: () => release() }
  }

  it('A2: a recurring push re-enqueued while its job is running is not dropped', async () => {
    const b = blockingHandler()
    registerHandler('walmart_push_inventory', b.handler)
    expect(await enqueueJob('walmart_push_inventory', { variantId: 'v1' }, { dedupeKey: 'inv:v1' })).not.toBeNull()

    const run = processDueJobs()
    await b.started
    // Mid-run: stock changed again. This must queue a fresh push.
    const second = await enqueueJob('walmart_push_inventory', { variantId: 'v1' }, { dedupeKey: 'inv:v1' })
    b.release()
    await run

    expect(second).not.toBeNull()
    const pending = await prisma.channelJob.findMany({ where: { type: 'walmart_push_inventory', status: 'pending' } })
    expect(pending).toHaveLength(1)
    expect(pending[0].dedupeKey).toBe('inv:v1')
    expect(await prisma.channelJob.count({ where: { type: 'walmart_push_inventory', status: 'done' } })).toBe(1)
  })

  it('A2: a one-shot key (enqueueIdempotentJob) is NOT released at pickup, so a mid-run replay cannot create a second job', async () => {
    const b = blockingHandler()
    registerHandler('walmart_ship_order', b.handler)
    await enqueueIdempotentJob('walmart_ship_order', { orderId: 'o1' }, 'ship:o1', prisma)

    const run = processDueJobs()
    await b.started
    const running = await prisma.channelJob.findFirstOrThrow({ where: { type: 'walmart_ship_order' } })
    expect(running.dedupeKey).toBe('ship:o1') // still claimed while it runs
    // A replay of the same one-shot enqueue mid-run must be a no-op.
    await enqueueIdempotentJob('walmart_ship_order', { orderId: 'o1' }, 'ship:o1', prisma)
    b.release()
    await run

    const jobs = await prisma.channelJob.findMany({ where: { type: 'walmart_ship_order' } })
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ status: 'done', dedupeKey: 'ship:o1' })
    // And the key stays spent after completion: a later replay is still a no-op.
    await enqueueIdempotentJob('walmart_ship_order', { orderId: 'o1' }, 'ship:o1', prisma)
    expect(await prisma.channelJob.count({ where: { type: 'walmart_ship_order' } })).toBe(1)
  })

  it('A2: a one-shot job and a recurring job in the same batch -- only the recurring key is released', async () => {
    const seenKeys: Record<string, string | null> = {}
    registerHandler('walmart_ship_order', async () => {
      seenKeys.ship = (await prisma.channelJob.findFirstOrThrow({ where: { type: 'walmart_ship_order' } })).dedupeKey
    })
    registerHandler('walmart_push_inventory', async () => {
      seenKeys.inv = (await prisma.channelJob.findFirstOrThrow({ where: { type: 'walmart_push_inventory' } })).dedupeKey
    })
    await enqueueIdempotentJob('walmart_ship_order', { orderId: 'o2' }, 'ship:o2', prisma)
    await enqueueJob('walmart_push_inventory', { variantId: 'v2' }, { dedupeKey: 'inv:v2' })
    await processDueJobs()
    expect(seenKeys).toEqual({ ship: 'ship:o2', inv: null })
  })

  // --- Final fix wave A3: dead-lettering is logged -------------------------
  it('A3: console.errors type, id, dedupeKey and truncated lastError when a job dead-letters -- never the payload', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const long = 'x'.repeat(5000)
      registerHandler('walmart_ship_order', async () => { throw new Error(`boom ${long}`) })
      // A one-shot job: its key stays on the row for life, so it is still
      // there to log. (A recurring job's key is released at its first
      // pickup -- A2 -- so by the time it dies it logs dedupeKey null; type
      // and id still identify it.)
      await enqueueIdempotentJob('walmart_ship_order', { secretish: 'PAYLOAD-MARKER' }, 'ship:o-dead', prisma)
      for (let i = 0; i < 4; i++) {
        const job = await prisma.channelJob.findFirstOrThrow()
        await processDueJobs(new Date(job.runAfter.getTime() + 1))
      }
      expect(errorSpy).not.toHaveBeenCalled() // retries 1-4 are not dead yet
      const job = await prisma.channelJob.findFirstOrThrow()
      await processDueJobs(new Date(job.runAfter.getTime() + 1))

      expect(errorSpy).toHaveBeenCalledTimes(1)
      const logged = errorSpy.mock.calls[0].map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
      expect(logged).toContain('dead')
      expect(logged).toContain('walmart_ship_order')
      expect(logged).toContain(job.id)
      expect(logged).toContain('ship:o-dead')
      expect(logged).toContain('boom')
      expect(logged).not.toContain('PAYLOAD-MARKER')
      expect(logged.length).toBeLessThan(1000)
    } finally {
      errorSpy.mockRestore()
    }
  })
})
