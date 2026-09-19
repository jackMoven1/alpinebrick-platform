import { prisma } from '../prisma.js'
import { generateApiKey, parseApiKey, hashToken, hashesEqual } from './tokens.js'
import type { AuthActor } from './session.service.js'
import { recordAudit } from '../audit.js'

export async function createApiKey(opts: {
  actorName: string
  keyName: string
  expiresAt?: Date | null
}): Promise<{ plaintext: string; id: string; actorId: string }> {
  const { plaintext, prefix, keyHash } = generateApiKey()

  // The Actor, its ApiKey and the audit row recording the mint all commit or
  // roll back together. This also closes the deferred finding that the
  // Actor and ApiKey writes were non-atomic: a crash between them used to be
  // able to leave a credential-less agent Actor behind.
  //
  // Minting happens during an incident (spec §5.4 break-glass) -- exactly
  // when you later need to know who did what -- so a mint with no audit
  // trail is the same gap as any other unaudited write.
  //
  // No signed-in operator exists at this call site to attribute the mint
  // to: createApiKey is reached only from the break-glass CLI script
  // (src/scripts/create-api-key.ts), run directly against the server with
  // no admin session. The one actor that genuinely exists by this point is
  // the key's own new agent Actor, so the audit row attributes the mint to
  // it rather than inventing an operator identity -- `AuditLog.actorId` is
  // NOT NULL and FK-enforced (schema.prisma), so there is no "unattributed"
  // option here.
  const { actor, row } = await prisma.$transaction(async (tx) => {
    const actor = await tx.actor.create({ data: { type: 'agent', name: opts.actorName } })
    const row = await tx.apiKey.create({
      data: {
        actorId: actor.id,
        name: opts.keyName,
        prefix,
        keyHash,
        expiresAt: opts.expiresAt ?? null,
      },
    })
    await recordAudit({ actorId: actor.id, action: 'apikey.create', target: `apikey:${row.id}` }, tx)
    return { actor, row }
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
