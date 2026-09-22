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
 * Enqueue a job.
 *
 * `dedupeKey` collapses bursts: while a job with that key is still `pending`,
 * further enqueues return null. Once it leaves `pending` the key is released,
 * so recurring work (inventory and price pushes) can be queued again.
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
    try {
      if (!handler) throw new Error(`no handler registered for job type ${job.type}`)
      await handler(job.payload)
      await prisma.channelJob.update({ where: { id: job.id }, data: { status: 'done' } })
      processed++
    } catch (e: any) {
      const attempts = job.attempts + 1
      failed++
      await prisma.channelJob.update({
        where: { id: job.id },
        data: {
          attempts,
          lastError: String(e?.message ?? e).slice(0, 1000),
          status: attempts >= MAX_ATTEMPTS ? 'dead' : 'pending',
          runAfter: new Date(now.getTime() + 2 ** attempts * 60_000),
        },
      })
    }
  }
  return { processed, failed }
}
