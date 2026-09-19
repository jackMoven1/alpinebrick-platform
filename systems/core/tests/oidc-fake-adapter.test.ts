import { describe, it, expect } from 'vitest'
import { createFakeOidcPort } from '../src/ports/oidc/fake.adapter.js'
import { createGoogleOidcPort } from '../src/ports/oidc/google.adapter.js'

const identity = { sub: 's-1', email: 'jack@example.com', emailVerified: true, name: 'Jack' }

describe('oidc port', () => {
  it('fake round-trips an identity and carries state into the url', async () => {
    const port = createFakeOidcPort(identity)
    expect(port.authUrl({ state: 'st 1', codeChallenge: 'cc' })).toContain('state=st%201')
    expect(await port.exchange({ code: 'ok', codeVerifier: 'v' })).toEqual(identity)
  })

  it('fake rejects a bad code', async () => {
    const port = createFakeOidcPort(identity)
    await expect(port.exchange({ code: 'bad-code', codeVerifier: 'v' })).rejects.toThrow()
  })

  // Construction must not require live credentials, or importing app.ts in a
  // test would need a Google client.
  it('the real adapter constructs with no environment set', () => {
    expect(() => createGoogleOidcPort()).not.toThrow()
  })
})
