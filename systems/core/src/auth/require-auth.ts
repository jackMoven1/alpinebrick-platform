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
  // Express 4 does not catch a rejection thrown out of an async handler --
  // it becomes an unhandled rejection (request hangs) or, with no listener,
  // crashes the process. This runs in front of every admin request, so any
  // throw here (a bad Prisma call, an unexpected shape) must resolve to a
  // response, never propagate unguarded.
  try {
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
  } catch (err) {
    next(err)
  }
}
