import { prisma } from './prisma.js'
import type { Prisma } from '@prisma/client'

/**
 * A Prisma client or an interactive-transaction client. Accepting both lets a
 * caller record an audit entry INSIDE the transaction that performs the write,
 * so the entry and the change it describes commit or roll back together.
 *
 * Passing nothing keeps the old behaviour: the entry is written on its own
 * connection, and a crash between the write and the audit leaves a change with
 * nobody attached to it.
 */
export type AuditDb = Pick<Prisma.TransactionClient, 'auditLog'>

export async function recordAudit(input: {
  actorId: string
  action: string
  target: string
  before?: unknown
  after?: unknown
}, db: AuditDb = prisma): Promise<{ id: string }> {
  const { id } = await db.auditLog.create({
    data: {
      actorId: input.actorId,
      action: input.action,
      target: input.target,
      before: (input.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (input.after ?? undefined) as Prisma.InputJsonValue | undefined,
    },
    select: { id: true },
  })
  return { id }
}
