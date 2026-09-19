import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { recordAudit } from '../src/audit.js'

beforeEach(resetDb)
afterAll(() => prisma.$disconnect())

describe('recordAudit', () => {
  it('writes an audit row linked to an actor', async () => {
    const actor = await prisma.actor.create({ data: { type: 'agent', name: 'catalog-agent' } })
    const entry = await recordAudit({
      actorId: actor.id, action: 'product.publish', target: 'product:123',
      before: { status: 'draft' }, after: { status: 'published' },
    })
    const row = await prisma.auditLog.findUnique({ where: { id: entry.id } })
    expect(row?.action).toBe('product.publish')
    expect(row?.actorId).toBe(actor.id)
    expect((row?.after as any).status).toBe('published')
  })

  it('rolls back with the transaction when handed a transaction client', async () => {
    const actor = await prisma.actor.create({ data: { type: 'agent', name: 'tx-agent' } })

    await expect(prisma.$transaction(async (tx) => {
      await recordAudit(
        { actorId: actor.id, action: 'product.status', target: 'product:rollback' },
        tx,
      )
      throw new Error('boom')
    })).rejects.toThrow('boom')

    const rows = await prisma.auditLog.findMany({ where: { target: 'product:rollback' } })
    expect(rows).toHaveLength(0)
  })

  // Pins the hazard the tx parameter exists to remove, so the default cannot be
  // quietly "fixed" without someone reading this. Without a transaction client
  // the entry is written on its own connection and survives a rollback -- an
  // audit row describing a change that never happened.
  it('without a transaction client, the entry outlives a rolled-back change', async () => {
    const actor = await prisma.actor.create({ data: { type: 'agent', name: 'no-tx-agent' } })

    await expect(prisma.$transaction(async () => {
      await recordAudit({ actorId: actor.id, action: 'product.status', target: 'product:orphan' })
      throw new Error('boom')
    })).rejects.toThrow('boom')

    const rows = await prisma.auditLog.findMany({ where: { target: 'product:orphan' } })
    expect(rows).toHaveLength(1)
  })
})
