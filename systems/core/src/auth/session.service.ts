import { prisma } from '../prisma.js'
import { generateSessionToken, hashToken } from './tokens.js'

export const SESSION_COOKIE = 'ab_admin_session'

export interface AuthActor {
  id: string
  type: 'human' | 'agent'
  name: string
}

/**
 * 12 hours, absolute, no sliding window (spec §4.2). Anything unparseable or
 * non-positive falls back to the default rather than producing a session that
 * never expires or expires instantly.
 */
export function sessionTtlMs(): number {
  const raw = Number(process.env.SESSION_TTL_HOURS)
  const hours = Number.isFinite(raw) && raw > 0 ? raw : 12
  return hours * 3600_000
}

export async function createSession(
  actorId: string,
  meta: { userAgent?: string; ip?: string } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken()
  const expiresAt = new Date(Date.now() + sessionTtlMs())
  await prisma.adminSession.create({
    data: {
      actorId,
      tokenHash: hashToken(token),
      expiresAt,
      userAgent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
    },
  })
  return { token, expiresAt }
}

export async function resolveSession(token: string): Promise<AuthActor | null> {
  if (!token) return null
  const row = await prisma.adminSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { actor: true },
  })
  if (!row) return null
  if (row.revokedAt) return null
  if (row.expiresAt.getTime() <= Date.now()) return null
  if (row.actor.disabled) return null

  // Best effort: a failed touch must not fail the request.
  void prisma.adminSession
    .update({ where: { id: row.id }, data: { lastSeenAt: new Date() } })
    .catch(() => undefined)

  return { id: row.actor.id, type: row.actor.type, name: row.actor.name }
}

export async function revokeSession(token: string): Promise<void> {
  if (!token) return
  await prisma.adminSession.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  })
}
