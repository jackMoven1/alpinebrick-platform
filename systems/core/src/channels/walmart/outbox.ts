import { prisma } from '../../prisma.js'
import type { Prisma } from '@prisma/client'

type Handler = (payload: any) => Promise<void>

const handlers = new Map<string, Handler>()

export function registerHandler(type: string, handler: Handler): void {
  handlers.set(type, handler)
}

export function clearHandlers(): void {
  handlers.clear()
}

/**
 * A Prisma client or an interactive-transaction client. Mirrors
 * `AuditDb` in `../../audit.ts`: accepting both lets a caller enqueue a job
 * INSIDE the transaction that performs the write it schedules follow-up work
 * for, so the job and that write commit or roll back together. Passing
 * nothing keeps the old behaviour -- the job is written on its own
 * connection, independent of any transaction the caller happens to be in.
 */
export type JobDb = Pick<Prisma.TransactionClient, 'channelJob'>

/**
 * Enqueue a job whose dedupeKey is RECURRING (inventory and price pushes).
 *
 * `dedupeKey` collapses bursts: while a job with that key is waiting to be
 * picked up, further enqueues return null. The key is released in two places
 * so recurring work can be queued again:
 *
 *  - at pickup: `processDueJobs` nulls the key of a `recurring` job just
 *    before running its handler (final fix wave A2). The handler reads
 *    current state (stock, price) when it runs; a change that lands after
 *    that read must be able to queue a fresh job, or it is lost until the
 *    next reconcile. Every job this function writes is marked `recurring`.
 *  - on collision with a job that has left `pending` (below): covers rows
 *    written before the `recurring` column existed, and any job that ends
 *    `done`/`dead` still holding its key.
 *
 * The release matters more than it looks. `dedupe_key` is UNIQUE across the
 * whole table, not scoped to status, so without it a key is spent permanently
 * the moment its job completes -- and because this returns null rather than
 * throwing, the halt is silent.
 */
export async function enqueueJob(
  type: string,
  payload: unknown,
  opts: { dedupeKey?: string; runAfter?: Date } = {},
  db: JobDb = prisma,
): Promise<{ id: string } | null> {
  return createJob(type, payload, opts, false, db)
}

async function createJob(
  type: string,
  payload: unknown,
  opts: { dedupeKey?: string; runAfter?: Date },
  retried: boolean,
  db: JobDb,
): Promise<{ id: string } | null> {
  try {
    return await db.channelJob.create({
      data: {
        type,
        payload: payload as Prisma.InputJsonValue,
        dedupeKey: opts.dedupeKey,
        runAfter: opts.runAfter ?? new Date(),
        recurring: true,
      },
      select: { id: true },
    })
  } catch (e: any) {
    if (e?.code !== 'P2002') throw e
    if (!opts.dedupeKey) throw e
    // Retry at most once. A second P2002 means another writer won the race and
    // its job is pending, which is exactly the burst this key exists to collapse.
    if (retried) return null
    const existing = await db.channelJob.findUnique({ where: { dedupeKey: opts.dedupeKey } })
    if (existing && existing.status !== 'pending') {
      await db.channelJob.update({ where: { id: existing.id }, data: { dedupeKey: null } })
      return createJob(type, payload, opts, true, db)
    }
    return null
  }
}

/**
 * Enqueue a job under a dedupeKey the caller already knows is one-shot: a
 * collision on that key can only mean "this exact unit of work already has
 * a job," never "a different unit of work needs the key back." Unlike
 * `enqueueJob`, this never raises on collision -- it uses a
 * conflict-tolerant INSERT (`createMany` + `skipDuplicates`, i.e. Postgres
 * `ON CONFLICT DO NOTHING`) instead of catching P2002 and recovering with
 * follow-up queries.
 *
 * That distinction is load-bearing when `db` is an interactive-transaction
 * client (`tx`), which is the only reason this function exists rather than
 * just calling `enqueueJob(..., tx)`: Postgres aborts the ENTIRE transaction
 * block on the first statement error, unique-violation included, and every
 * later statement fails with `25P02: current transaction is aborted` until
 * rollback -- Prisma does not wrap interactive-transaction queries in
 * per-statement savepoints, so catching the P2002 in application code (the
 * way `enqueueJob`'s `createJob` does) cannot undo that. A raising INSERT
 * here would poison the surrounding transaction and roll back whatever else
 * it was doing (an order, a reservation, a ChannelEvent) over a condition
 * that's actually fine: the job this key names already exists.
 *
 * If the INSERT is skipped, and the existing job under that key has already
 * dead-lettered (it will never run again on its own), this revives it to
 * `pending` -- the caller's one-shot guarantee means the unit of work that
 * key names still needs doing, even though a prior attempt at it
 * permanently failed (e.g. an orphaned job left behind by ops cleanup, a
 * backfill, or a row predating some migration, with no companion record to
 * have driven a retry). A `pending` job is left alone (it will still run);
 * a `done` job is left alone too (the one-shot work it names already
 * completed). `updateMany` rather than `update` because there's no id in
 * hand without a second read, and matching zero rows is not an error.
 *
 * Jobs written here are never `recurring` (the column defaults to false), so
 * `processDueJobs` never releases their key at pickup: a one-shot key stays
 * claimed while its job runs and after it completes. That is what stops a
 * replayed ship/cancel enqueue from creating a second job (double-ship).
 *
 * Do NOT use this for a dedupeKey that legitimately gets reused across
 * separate units of work -- e.g. the recurring inventory/price-push keys
 * `enqueueJob`'s release-on-completion recovery exists for (see its own doc
 * comment). Those need `enqueueJob`'s existing out-of-transaction behaviour,
 * unchanged. This function is for callers who can prove -- as
 * `ingestWalmartOrder` can, via `ChannelEvent(externalId, eventType)`
 * uniqueness upstream -- that the key is spent exactly once, ever.
 */
export async function enqueueIdempotentJob(
  type: string,
  payload: unknown,
  dedupeKey: string,
  db: JobDb,
  runAfter: Date = new Date(),
): Promise<void> {
  const { count } = await db.channelJob.createMany({
    data: [{ type, payload: payload as Prisma.InputJsonValue, dedupeKey, runAfter }],
    skipDuplicates: true,
  })
  if (count === 0) {
    await db.channelJob.updateMany({
      where: { dedupeKey, status: 'dead' },
      data: { status: 'pending', attempts: 0, lastError: null, runAfter },
    })
  }
}

const MAX_ATTEMPTS = 5

export async function processDueJobs(
  now: Date = new Date(),
): Promise<{ processed: number; failed: number }> {
  const due = await prisma.channelJob.findMany({
    where: { status: 'pending', runAfter: { lte: now } },
    orderBy: { createdAt: 'asc' },
    take: 50,
  })
  let processed = 0
  let failed = 0
  for (const job of due) {
    const handler = handlers.get(job.type)
    // Release a RECURRING key at pickup, before the handler reads state
    // (final fix wave A2). While the key was held for the whole run, an
    // enqueue during the run returned null and the change it carried was
    // lost: this handler had already read the old value. Released here, that
    // enqueue creates a second pending job that reads the new value. Two
    // pushes of the same variant are harmless -- each sends current state.
    // One-shot keys (`recurring` false) are never released: see
    // enqueueIdempotentJob.
    if (job.recurring && job.dedupeKey !== null) {
      await prisma.channelJob.update({ where: { id: job.id }, data: { dedupeKey: null } })
    }
    try {
      if (!handler) throw new Error(`no handler registered for job type ${job.type}`)
      await handler(job.payload)
      await prisma.channelJob.update({ where: { id: job.id }, data: { status: 'done' } })
      processed++
    } catch (e: any) {
      const attempts = job.attempts + 1
      const dead = attempts >= MAX_ATTEMPTS
      const lastError = String(e?.message ?? e).slice(0, 1000)
      failed++
      await prisma.channelJob.update({
        where: { id: job.id },
        data: {
          attempts,
          lastError,
          status: dead ? 'dead' : 'pending',
          runAfter: new Date(now.getTime() + 2 ** attempts * 60_000),
        },
      })
      if (dead) {
        // Final fix wave A3: a dead job never runs again on its own, so it
        // must not be silent. Identifiers and a short error only -- never the
        // payload, which can carry customer and order data.
        console.error('walmart outbox: job dead-lettered', {
          type: job.type,
          id: job.id,
          dedupeKey: job.dedupeKey,
          attempts,
          lastError: lastError.slice(0, 200),
        })
      }
    }
  }
  return { processed, failed }
}
