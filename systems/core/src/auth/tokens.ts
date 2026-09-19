import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'

export const API_KEY_PREFIX = 'abk'

/** 32 random bytes, base64url so it is safe in a cookie without escaping. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * SHA-256, not Argon2. These are 256-bit random tokens, not user-chosen
 * passwords: there is no dictionary to attack, so a slow KDF buys nothing and
 * costs latency on every authenticated request. See spec §4.4.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export interface GeneratedApiKey {
  plaintext: string
  prefix: string
  keyHash: string
}

/**
 * Format: `abk_<prefix8>_<secret43>`. The prefix is an identifier, stored in
 * clear so a key can be named in logs and revoked; the hash covers the WHOLE
 * plaintext, so knowing a prefix reveals nothing.
 *
 * Base64url can produce underscores, which would break the delimiter-based
 * parsing. We generate extra bytes and filter underscores to ensure the
 * prefix and secret are delimiter-free.
 */
export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBytes(10).toString('base64url').replace(/_/g, '').slice(0, 8)
  const secret = randomBytes(50).toString('base64url').replace(/_/g, '').slice(0, 43)
  const plaintext = `${API_KEY_PREFIX}_${prefix}_${secret}`
  return { plaintext, prefix, keyHash: hashToken(plaintext) }
}

export function parseApiKey(header: string | undefined): { prefix: string; plaintext: string } | null {
  if (!header) return null
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim())
  if (!m) return null
  const plaintext = m[1]
  const parts = plaintext.split('_')
  if (parts.length !== 3) return null
  const [scheme, prefix, secret] = parts
  if (scheme !== API_KEY_PREFIX || !prefix || !secret) return null
  return { prefix, plaintext }
}

/** Constant-time for equal-length inputs; length mismatch is not secret. */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}
