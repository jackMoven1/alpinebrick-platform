import { prisma } from '../prisma.js'
import { generateApiKey, parseApiKey, hashToken, hashesEqual } from './tokens.js'
import type { AuthActor } from './session.service.js'

export async function createApiKey(opts: {
  actorName: string
  keyName: string
  expiresAt?: Date | null
}): Promise<{ plaintext: string; id: string; actorId: string }> {
  const { plaintext, prefix, keyHash } = generateApiKey()
  const actor = await prisma.actor.create({ data: { type: 'agent', name: opts.actorName } })
  const row = await prisma.apiKey.create({
    data: {
      actorId: actor.id,
      name: opts.keyName,
      prefix,
      keyHash,
      expiresAt: opts.expiresAt ?? null,
    },
  })
  return { plaintext, id: row.id, actorId: actor.id }
}

export async function resolveApiKey(header: string | undefined): Promise<AuthActor | null> {
  const parsed = parseApiKey(header)
  if (!parsed) return null

  const row = await prisma.apiKey.findUnique({
    where: { prefix: parsed.prefix },
    include: { actor: true },
  })
  if (!row) return null

  // The prefix only narrows the lookup. The secret is what authenticates, and
  // it is compared in constant time against the stored hash.
  if (!hashesEqual(row.keyHash, hashToken(parsed.plaintext))) return null

  if (row.revokedAt) return null
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null
  if (row.actor.disabled) return null

  void prisma.apiKey
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined)

  return { id: row.actor.id, type: row.actor.type, name: row.actor.name }
}
