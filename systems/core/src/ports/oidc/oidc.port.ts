export interface GoogleIdentity {
  sub: string
  email: string
  emailVerified: boolean
  name?: string
}

/**
 * Google sign-in, kept behind a port so the route tests in Task 8 need no
 * network access and no real Google credentials.
 *
 * Implemented today by the real Google adapter; the fake adapter in this same
 * directory stands in for it in tests, mirroring how ports/storage and
 * ports/tax keep their vendor behind an interface.
 */
export interface OidcPort {
  authUrl(opts: { state: string; codeChallenge: string }): string
  exchange(opts: { code: string; codeVerifier: string }): Promise<GoogleIdentity>
}
