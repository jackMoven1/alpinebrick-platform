import { Router } from 'express'
import { randomBytes, createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
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

/** True for a Prisma unique-constraint violation on the actors.email column. */
function isEmailConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false
  const target = err.meta?.target
  return Array.isArray(target) ? target.includes('email') : target === 'email'
}

/**
 * A safe-to-log summary of an unknown error: message, plus `code`/`status`
 * when present.
 *
 * Deliberately does NOT log the error object itself. The real Google adapter
 * wraps `google-auth-library`, which wraps `gaxios` -- a failed token
 * exchange (an expired, replayed, or tampered authorization code is the
 * routine case, not an edge case) throws a `GaxiosError` carrying `.config`,
 * a copy of the request including the request body: our one-time `code` and
 * PKCE `codeVerifier`. Gaxios's own redactor strips `client_secret` and
 * `grant_type` but NOT `code` or `code_verifier`, and `console.error(msg,
 * err)` prints an Error's own enumerable properties -- `config` included --
 * in the clear. Narrowing to this shape is the one place that policy is
 * enforced, so it only has to be gotten right once.
 */
function scrubError(err: unknown): { message: string; code?: unknown; status?: unknown } {
  if (!(err instanceof Error)) return { message: String(err) }
  const out: { message: string; code?: unknown; status?: unknown } = { message: err.message }
  if ('code' in err) out.code = (err as { code?: unknown }).code
  if ('status' in err) out.status = (err as { status?: unknown }).status
  return out
}

export function createAuthRouter(oidc: OidcPort): Router {
  const router = Router()

  router.get('/google/start', (_req, res) => {
    const state = randomBytes(16).toString('base64url')
    const codeVerifier = randomBytes(32).toString('base64url')
    const tx = Buffer.from(JSON.stringify({ state, codeVerifier })).toString('base64url')

    // Header set directly rather than res.cookie(), so this router works when
    // a test mounts it standalone without the full app's middleware.
    //
    // SameSite=Lax, not None: the only request that must carry this cookie is
    // the top-level cross-site GET redirect back from accounts.google.com,
    // which Lax already covers. None would additionally attach it to
    // cross-site subresource requests for no benefit. (The session cookie
    // below genuinely needs None -- the console lives on a different origin
    // and calls this API from script, not a top-level navigation.)
    res.setHeader('Set-Cookie',
      `${TX_COOKIE}=${tx}; HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth; Max-Age=${TX_TTL_MS / 1000}`)
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
      } catch (err) {
        // The one security-relevant event in this flow: a forged/tampered
        // id_token fails signature verification here exactly the same way a
        // transient network blip would. Both produce the same 400 to the
        // caller (nothing about our response should hint at which), but this
        // must not vanish from our own diagnostics -- it is the case that
        // matters most.
        console.error('[auth] oidc.exchange failed', scrubError(err))
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

      // Persisted lowercased: the allowlist check above already normalises
      // case, but Postgres unique indexes are case-sensitive, so storing the
      // raw claim would let "Jack@Example.com" and "jack@example.com" become
      // two distinct (and independently allowlisted) Actor rows.
      const email = identity.email.toLowerCase()

      // Keyed on sub -- the stable identifier. An email can be reassigned.
      let actor
      try {
        actor = await prisma.actor.upsert({
          where: { googleSub: identity.sub },
          update: { email, name: identity.name ?? email },
          create: {
            type: 'human',
            name: identity.name ?? email,
            email,
            googleSub: identity.sub,
          },
        })
      } catch (err) {
        // Actor.email is independently unique. If this sub is new (account
        // recreated/migrated, or first sign-in under a sub we've never seen)
        // but the email already belongs to a different row, the upsert falls
        // to create/update and hits that unique index. That is not "unknown
        // server failure" -- it is a specific, operator-actionable state:
        // nobody has told us these two identities are the same person, and
        // we must not guess. Surface it distinctly rather than folding it
        // into the generic 500 below.
        if (isEmailConflict(err)) {
          console.error('[auth] email already linked to a different googleSub', scrubError(err))
          return res.status(409).json({
            code: 'EMAIL_ALREADY_LINKED',
            message: 'this email is already linked to a different Google account; a manual googleSub re-link is needed',
          })
        }
        throw err
      }
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
    } catch (err) {
      // A DB/upsert failure (or anything else unexpected below the known
      // checks) must still produce a response rather than an unhandled
      // rejection. Distinct from the 400/403/409 above: this is an
      // unexpected server-side failure, not a rejected transaction or
      // identity.
      console.error('[auth] unexpected failure in google/callback', scrubError(err))
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'sign-in failed' })
    }
  })

  router.post('/logout', async (req, res) => {
    try {
      const token = readCookie(req.headers.cookie, SESSION_COOKIE)
      if (token) await revokeSession(token)
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0`)
      res.status(204).end()
    } catch (err) {
      console.error('[auth] unexpected failure in logout', scrubError(err))
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'logout failed' })
    }
  })

  router.get('/me', requireAuth, (req, res) => {
    res.json(req.actor)
  })

  return router
}
