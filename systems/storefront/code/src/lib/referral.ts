import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router'

export const REFERRAL_STORAGE_KEY = 'ab.referral'
export const REFERRAL_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Same pattern core enforces (spec §3); core re-validates everything. */
export const REFERRAL_CODE_RE = /^[a-z0-9-]{2,32}$/

export interface Referral { code: string; firstSeenAt: string }
interface StoredReferral extends Referral { expiresAt: string }

export function safeLocalStorage(): Storage | null {
  try { return window.localStorage } catch { return null }
}

/**
 * Spec §6: `?ref=` on any page. A valid code overwrites any earlier one
 * (last click wins) with a 30-day expiry. Storage failures are swallowed.
 * Returns true whenever `ref` was present, valid or not, so the caller
 * strips it from the URL either way.
 */
export function captureReferral(search: string, storage: Storage | null, now = new Date()): boolean {
  const params = new URLSearchParams(search)
  if (!params.has('ref')) return false
  const code = (params.get('ref') ?? '').trim().toLowerCase()
  if (storage && REFERRAL_CODE_RE.test(code)) {
    const value: StoredReferral = {
      code, firstSeenAt: now.toISOString(), expiresAt: new Date(now.getTime() + REFERRAL_TTL_MS).toISOString(),
    }
    try { storage.setItem(REFERRAL_STORAGE_KEY, JSON.stringify(value)) } catch { /* blocked or full */ }
  }
  return true
}

export function readReferral(storage: Storage | null, now = new Date()): Referral | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(REFERRAL_STORAGE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<StoredReferral>
    if (typeof v.code !== 'string' || !REFERRAL_CODE_RE.test(v.code)
      || typeof v.firstSeenAt !== 'string' || typeof v.expiresAt !== 'string') return null
    if (Date.parse(v.expiresAt) <= now.getTime()) {
      storage.removeItem(REFERRAL_STORAGE_KEY)
      return null
    }
    return { code: v.code, firstSeenAt: v.firstSeenAt }
  } catch {
    return null
  }
}

/** Mounted once in Root: capture `?ref=`, then replace the URL without it. */
export function useReferralCapture(): void {
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    if (!captureReferral(location.search, safeLocalStorage())) return
    const params = new URLSearchParams(location.search)
    params.delete('ref')
    const qs = params.toString()
    navigate(`${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`, { replace: true })
  }, [location.pathname, location.search, location.hash, navigate])
}
