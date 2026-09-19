import type { OidcPort, GoogleIdentity } from './oidc.port.js'

/** Test double. Never registered by app.ts. */
export function createFakeOidcPort(identity: GoogleIdentity): OidcPort {
  return {
    authUrl: ({ state }) => `https://accounts.example/fake?state=${encodeURIComponent(state)}`,
    exchange: async ({ code }) => {
      if (code === 'bad-code') throw new Error('invalid_grant')
      return identity
    },
  }
}
