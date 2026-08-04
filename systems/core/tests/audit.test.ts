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
})
