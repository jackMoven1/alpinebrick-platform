import { describe, it, expect } from 'vitest'
import { toGoogleIdentity } from '../src/ports/oidc/google.adapter.js'

const basePayload = { sub: 'sub-1', email: 'jack@example.com' }

describe('toGoogleIdentity', () => {
  // The strict-equality check on email_verified is the security gate the
  // whole sign-in flow turns on. Every non-`true` shape must map to false --
  // no truthy coercion of a string or number claim.
  it('maps a missing email_verified claim to emailVerified: false', () => {
    expect(toGoogleIdentity({ ...basePayload }).emailVerified).toBe(false)
  })

  it('maps email_verified: false to emailVerified: false', () => {
    expect(toGoogleIdentity({ ...basePayload, email_verified: false }).emailVerified).toBe(false)
  })

  it('maps the string "true" to emailVerified: false', () => {
    expect(toGoogleIdentity({ ...basePayload, email_verified: 'true' }).emailVerified).toBe(false)
  })

  it('maps the number 1 to emailVerified: false', () => {
    expect(toGoogleIdentity({ ...basePayload, email_verified: 1 }).emailVerified).toBe(false)
  })

  it('maps the boolean true to emailVerified: true', () => {
    expect(toGoogleIdentity({ ...basePayload, email_verified: true }).emailVerified).toBe(true)
  })

  it('carries sub, email and name through', () => {
    const identity = toGoogleIdentity({ ...basePayload, email_verified: true, name: 'Jack' })
    expect(identity).toEqual({
      sub: 'sub-1',
      email: 'jack@example.com',
      emailVerified: true,
      name: 'Jack',
    })
  })

  it('throws when sub is missing', () => {
    expect(() => toGoogleIdentity({ email: 'jack@example.com' })).toThrow()
  })

  it('throws when email is missing', () => {
    expect(() => toGoogleIdentity({ sub: 'sub-1' })).toThrow()
  })
})
