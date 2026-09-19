import { Router } from 'express'
import { randomBytes, createHash } from 'node:crypto'
import type { OidcPort } from '../ports/oidc/oidc.port.js'
import { prisma } from '../prisma.js'
import { createSession, revokeSession, sessionTtlMs, SESSION_COOKIE } from './session.service.js'
import { requireAuth } from './require-auth.js'
import { readCookie } from './cookies.js'
import { recordAudit } from '../audit.js'

const TX_COOKIE = 'ab_oauth_tx'
const TX_TTL_MS = 10 * 60_000

function allowedEmails(): string[] {
  return (process.env.ADMIN_ALLOWED_EMAILS ?? '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
}

function consoleOrigin(): string {
  return (process.env.ADMIN_CONSOLE_ORIGIN ?? '').split(',')[0].trim()
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function createAuthRouter(oidc: OidcPort): Router {
  const router = Router()

  router.get('/google/start', (_req, res) => {
    const state = randomBytes(16).toString('base64url')
    const codeVerifier = randomBytes(32).toString('base64url')
    const tx = Buffer.from(JSON.stringify({ state, codeVerifier })).toString('base64url')

    // Header set directly rather than res.cookie(), so this router works when
    // a test mounts it standalone without the full app's middleware.
    res.setHeader('Set-Cookie',
      `${TX_COOKIE}=${tx}; HttpOnly; Secure; SameSite=None; Path=/api/v1/auth; Max-Age=${TX_TTL_MS / 1000}`)
    res.redirect(302, oidc.authUrl({ state, codeChallenge: s256(codeVerifier) }))
  })

  router.get('/google/callback', async (req, res) => {
    // Express 4 does not catch a rejection thrown out of an async handler,
    // so every path below -- including a Prisma failure in the upsert --
    // must resolve to a response rather than propagate unguarded.
    try {
      const raw = readCookie(req.headers.cookie, TX_COOKIE)
      if (!raw) return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'missing oauth transaction' })

      let tx: { state: string; codeVerifier: string }
      try {
        tx = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
      } catch {
        return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'bad oauth transaction' })
      }

      const { code, state } = req.query
      if (typeof code !== 'string' || typeof state !== 'string' || state !== tx.state) {
        return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'state mismatch' })
      }

      let identity
      try {
        identity = await oidc.exchange({ code, codeVerifier: tx.codeVerifier })
      } catch {
        return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'code exchange failed' })
      }

      // Order matters, and a failure creates NO actor: signature (verified by
      // exchange above), then email_verified, then the allowlist.
      if (!identity.emailVerified) {
        return res.status(403).json({ code: 'FORBIDDEN', message: 'email not verified' })
      }
      if (!allowedEmails().includes(identity.email.toLowerCase())) {
        return res.status(403).json({ code: 'FORBIDDEN', message: 'email not permitted' })
      }

      // Keyed on sub -- the stable identifier. An email can be reassigned.
      const actor = await prisma.actor.upsert({
        where: { googleSub: identity.sub },
        update: { email: identity.email, name: identity.name ?? identity.email },
        create: {
          type: 'human',
          name: identity.name ?? identity.email,
          email: identity.email,
          googleSub: identity.sub,
        },
      })
      if (actor.disabled) {
        return res.status(403).json({ code: 'FORBIDDEN', message: 'actor disabled' })
      }

      const { token } = await createSession(actor.id, {
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      })
      await recordAudit({ actorId: actor.id, action: 'auth.login', target: `actor:${actor.id}` })

      res.setHeader('Set-Cookie',
        `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${sessionTtlMs() / 1000}`)
      res.redirect(302, consoleOrigin() || '/')
    } catch {
      // A DB/upsert failure (or anything else unexpected below the known
      // checks) must still produce a response rather than an unhandled
      // rejection. Distinct from the 400/403 above: this is an unexpected
      // server-side failure, not a rejected transaction or identity.
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'sign-in failed' })
    }
  })

  router.post('/logout', async (req, res) => {
    try {
      const token = readCookie(req.headers.cookie, SESSION_COOKIE)
      if (token) await revokeSession(token)
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0`)
      res.status(204).end()
    } catch {
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'logout failed' })
    }
  })

  router.get('/me', requireAuth, (req, res) => {
    res.json(req.actor)
  })

  return router
}
