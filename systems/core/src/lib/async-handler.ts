import type { NextFunction, Request, RequestHandler, Response } from 'express'

/**
 * Wraps an async Express route handler so a rejected promise reaches
 * Express's error pipeline via `next(err)` instead of becoming an unhandled
 * promise rejection.
 *
 * Express 4 does not await route handlers and does not catch a promise they
 * return -- a throw inside `async (req, res) => { ... }` that isn't caught
 * by the handler's own try/catch rejects a promise nothing is listening to.
 * With no `process.on('unhandledRejection', ...)` anywhere in this codebase
 * and Node 20 defaulting to `--unhandled-rejections=throw`, that rejection
 * crashes the whole process -- not just the one request, every route the
 * process was serving. This wrapper is the fix: attach `.catch(next)` to the
 * handler's returned promise at call time, so any rejection -- whether from
 * an explicit `throw err` past a narrower try/catch, or from a route with no
 * try/catch at all -- is handed to Express's error-handling middleware
 * (see `error-handler.ts`, mounted last in `app.ts`) instead of escaping
 * uncaught.
 */
export function asyncHandler<Req extends Request = Request>(
  handler: (req: Req, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req as Req, res, next).catch(next)
  }
}
