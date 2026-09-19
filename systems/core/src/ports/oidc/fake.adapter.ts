import type { OidcPort, GoogleIdentity } from './oidc.port.js'

/**
 * Test double. Never registered by app.ts.
 *
 * Echoes `codeChallenge` into the authorize URL as `code_challenge` so a test
 * can assert the PKCE binding end to end (s256 of the verifier carried in the
 * tx cookie equals the challenge that went out to the provider) without this
 * fake needing to perform real PKCE verification itself.
 */
export function createFakeOidcPort(identity: GoogleIdentity): OidcPort {
  return {
    authUrl: ({ state, codeChallenge }) =>
      `https://accounts.example/fake?state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(codeChallenge)}`,
    exchange: async ({ code }) => {
      if (code === 'bad-code') throw new Error('invalid_grant')
      return identity
    },
  }
}
