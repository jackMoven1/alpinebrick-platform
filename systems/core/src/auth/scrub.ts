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
 *
 * Lives in its own module rather than auth.routes.ts: admin-catalog.routes.ts
 * and assets.routes.ts also depend on it, and importing a scrubbing utility
 * from the auth *router* made that router look like a shared utility module
 * rather than a set of routes.
 */
export function scrubError(err: unknown): { message: string; code?: unknown; status?: unknown } {
  // Guarded as a whole, not just the code/status reads: `'code' in err` does
  // not invoke a getter, but reading `err.code`/`err.status` (or even
  // `err.message`, or `String(err)` on a hostile non-Error) does, and this
  // runs at several call sites with no enclosing try. A throwing getter
  // there must not itself become an unhandled rejection in an async
  // Express 4 handler.
  try {
    if (!(err instanceof Error)) return { message: String(err) }
    const out: { message: string; code?: unknown; status?: unknown } = { message: err.message }
    if ('code' in err) out.code = (err as { code?: unknown }).code
    if ('status' in err) out.status = (err as { status?: unknown }).status
    return out
  } catch {
    return { message: 'unloggable error' }
  }
}
