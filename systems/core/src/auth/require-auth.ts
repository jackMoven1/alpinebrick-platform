import type { RequestHandler } from 'express'
import { resolveSession, SESSION_COOKIE, type AuthActor } from './session.service.js'
import { resolveApiKey } from './apikey.service.js'
import { readCookie } from './cookies.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: AuthActor
    }
  }
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  const auth = req.headers.authorization
  const actor = auth
    ? await resolveApiKey(auth)
    : await resolveSession(readCookie(req.headers.cookie, SESSION_COOKIE) ?? '')

  if (!actor) {
    res.status(401).json({ code: 'UNAUTHENTICATED', message: 'authentication required' })
    return
  }
  req.actor = actor
  next()
}
