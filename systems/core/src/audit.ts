import { prisma } from './prisma.js'
import type { Prisma } from '@prisma/client'

export async function recordAudit(input: {
  actorId: string
  action: string
  target: string
  before?: unknown
  after?: unknown
}): Promise<{ id: string }> {
  const { id } = await prisma.auditLog.create({
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
