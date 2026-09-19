import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library'
import type { OidcPort, GoogleIdentity } from './oidc.port.js'

/**
 * The raw shape handed back by `TokenPayload`. Typed loosely (fields widened
 * to `unknown`, not the library's `TokenPayload`) on purpose: the payload
 * comes from decoded JWT claims, and nothing at runtime guarantees
 * `email_verified` is actually a boolean -- that is exactly the assumption
 * `toGoogleIdentity` must not make.
 */
export type RawGooglePayload = {
  sub?: unknown
  email?: unknown
  email_verified?: unknown
  name?: unknown
} | undefined

/**
 * Maps a verified Google ID token payload to our internal identity shape.
 * Pulled out of `exchange()` so the `email_verified` mapping -- the security
 * gate the whole sign-in flow turns on -- can be unit tested directly rather
 * than only through the fake adapter, which never exercises this code path.
 */
export function toGoogleIdentity(payload: RawGooglePayload): GoogleIdentity {
  const sub = payload?.sub
  const email = payload?.email
  if (typeof sub !== 'string' || !sub || typeof email !== 'string' || !email) {
    throw new Error('id_token missing sub or email')
  }
  return {
    sub,
    email,
    // Strict equality: only the literal boolean `true` counts as verified.
    // A string "true" or a number 1 must not be coerced into a pass.
    emailVerified: payload?.email_verified === true,
    name: typeof payload?.name === 'string' ? payload.name : undefined,
  }
}

export function createGoogleOidcPort(): OidcPort {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? ''
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri })

  return {
    authUrl: ({ state, codeChallenge }) =>
      client.generateAuthUrl({
        scope: ['openid', 'email', 'profile'],
        state,
        code_challenge_method: CodeChallengeMethod.S256,
        code_challenge: codeChallenge,
        prompt: 'select_account',
      }),

    exchange: async ({ code, codeVerifier }): Promise<GoogleIdentity> => {
      const { tokens } = await client.getToken({ code, codeVerifier })
      if (!tokens.id_token) throw new Error('no id_token in token response')
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId })
      return toGoogleIdentity(ticket.getPayload())
    },
  }
}
