import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library'
import type { OidcPort, GoogleIdentity } from './oidc.port.js'

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
      const p = ticket.getPayload()
      if (!p?.sub || !p.email) throw new Error('id_token missing sub or email')
      return {
        sub: p.sub,
        email: p.email,
        emailVerified: p.email_verified === true,
        name: p.name,
      }
    },
  }
}
