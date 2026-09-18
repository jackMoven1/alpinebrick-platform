import { describe, it, expect } from 'vitest'
import {
  generateSessionToken, hashToken, generateApiKey, parseApiKey, hashesEqual, API_KEY_PREFIX,
} from '../src/auth/tokens.js'

describe('token primitives', () => {
  it('generates distinct high-entropy session tokens', () => {
    const a = generateSessionToken()
    const b = generateSessionToken()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(43)   // 32 bytes base64url
    expect(a).not.toMatch(/[+/=]/)                // base64url, safe in a cookie
  })

  it('hashes deterministically and irreversibly', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'))
    expect(hashToken('abc')).not.toBe(hashToken('abd'))
    expect(hashToken('abc')).toHaveLength(64)     // sha256 hex
    expect(hashToken('abc')).not.toContain('abc')
  })

  it('mints an api key whose stored hash is of the FULL plaintext', () => {
    const k = generateApiKey()
    expect(k.plaintext.startsWith(`${API_KEY_PREFIX}_`)).toBe(true)
    expect(k.plaintext.split('_')).toHaveLength(3)
    expect(k.prefix).toHaveLength(8)
    expect(k.keyHash).toBe(hashToken(k.plaintext))
    // The prefix is an identifier, not a secret, and must not be the hash input.
    expect(k.keyHash).not.toBe(hashToken(k.prefix))
  })

  it('parses a well-formed bearer header', () => {
    const k = generateApiKey()
    const parsed = parseApiKey(`Bearer ${k.plaintext}`)
    expect(parsed).toEqual({ prefix: k.prefix, plaintext: k.plaintext })
  })

  it('rejects malformed headers rather than guessing', () => {
    expect(parseApiKey(undefined)).toBeNull()
    expect(parseApiKey('')).toBeNull()
    expect(parseApiKey('Basic abc')).toBeNull()
    expect(parseApiKey('Bearer notakey')).toBeNull()
    expect(parseApiKey('Bearer xxx_abcd1234_secret')).toBeNull()  // wrong prefix
    expect(parseApiKey('Bearer abk__secret')).toBeNull()          // empty prefix
    expect(parseApiKey('Bearer abk_abcd1234_')).toBeNull()        // empty secret
  })

  it('compares equal-length hashes without leaking length mismatches', () => {
    expect(hashesEqual('a'.repeat(64), 'a'.repeat(64))).toBe(true)
    expect(hashesEqual('a'.repeat(64), 'b'.repeat(64))).toBe(false)
    expect(hashesEqual('short', 'a'.repeat(64))).toBe(false)      // must not throw
  })
})
