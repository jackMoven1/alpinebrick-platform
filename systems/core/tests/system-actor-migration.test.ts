import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { prisma } from '../src/prisma.js'

// Reads the actual migration file rather than duplicating its SQL, so this
// test fails if the migration is ever edited to do something other than what
// it claims.
const MIGRATION_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../prisma/migrations/20260922100000_seed_system_actor/migration.sql',
)
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, 'utf8')

// Deliberately NOT resetDb(): resetDb() deletes every actor, and
// tests/auth-schema.test.ts asserts an exact actor count after creating two
// of its own -- adding a third actor to that count would break an unrelated
// test. This test also must not depend on suite ordering (the 'system' actor
// may or may not exist when it runs, depending on which other test file ran
// last), so it clears its own narrow slice of state -- the 'system' actor
// and anything that would block deleting it -- before each assertion,
// rather than relying on ambient state.
async function clearSystemActor() {
  await prisma.auditLog.deleteMany({ where: { actorId: 'system' } })
  await prisma.adminSession.deleteMany({ where: { actorId: 'system' } })
  await prisma.apiKey.deleteMany({ where: { actorId: 'system' } })
  await prisma.actor.deleteMany({ where: { id: 'system' } })
}

describe('system actor data migration (20260922100000_seed_system_actor)', () => {
  afterAll(() => prisma.$disconnect())

  it('creates the system actor row on a database that lacks it', async () => {
    await clearSystemActor()
    expect(await prisma.actor.findUnique({ where: { id: 'system' } })).toBeNull()

    await prisma.$executeRawUnsafe(MIGRATION_SQL)

    const actor = await prisma.actor.findUnique({ where: { id: 'system' } })
    expect(actor).toMatchObject({ id: 'system', type: 'human', name: 'system' })
  })

  it('is a no-op when re-run -- exactly one row, no error', async () => {
    await clearSystemActor()

    await prisma.$executeRawUnsafe(MIGRATION_SQL)
    await expect(prisma.$executeRawUnsafe(MIGRATION_SQL)).resolves.not.toThrow()

    const rows = await prisma.actor.findMany({ where: { id: 'system' } })
    expect(rows).toHaveLength(1)
  })

  it('is also a no-op against a database where the seed already created the row', async () => {
    await clearSystemActor()
    // Simulate the seed's upsert having already run.
    await prisma.actor.create({ data: { id: 'system', type: 'human', name: 'system' } })

    await expect(prisma.$executeRawUnsafe(MIGRATION_SQL)).resolves.not.toThrow()

    const rows = await prisma.actor.findMany({ where: { id: 'system' } })
    expect(rows).toHaveLength(1)
  })
})
