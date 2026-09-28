import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import {
  captureReferral, readReferral, useReferralCapture, REFERRAL_STORAGE_KEY, REFERRAL_TTL_MS,
} from './referral'

function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() { return m.size },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k) },
    setItem: (k, v) => { m.set(k, String(v)) },
  }
}
const NOW = new Date('2026-10-01T12:00:00Z')

describe('referral capture', () => {
  it('stores a valid code, lowercased, with first-seen time', () => {
    const s = memoryStorage()
    expect(captureReferral('?ref=Brick-Club', s, NOW)).toBe(true)
    expect(readReferral(s, NOW)).toEqual({ code: 'brick-club', firstSeenAt: NOW.toISOString() })
  })

  it('reports ref present but stores nothing for an invalid code', () => {
    const s = memoryStorage()
    expect(captureReferral('?ref=not%20valid!', s, NOW)).toBe(true)
    expect(s.getItem(REFERRAL_STORAGE_KEY)).toBeNull()
    expect(captureReferral('?q=castle', s, NOW)).toBe(false)
  })

  it('last click wins', () => {
    const s = memoryStorage()
    captureReferral('?ref=first', s, NOW)
    const later = new Date(NOW.getTime() + 60_000)
    captureReferral('?ref=second', s, later)
    expect(readReferral(s, later)).toEqual({ code: 'second', firstSeenAt: later.toISOString() })
  })

  it('expires after 30 days', () => {
    const s = memoryStorage()
    captureReferral('?ref=club', s, NOW)
    expect(readReferral(s, new Date(NOW.getTime() + REFERRAL_TTL_MS - 1))).not.toBeNull()
    expect(readReferral(s, new Date(NOW.getTime() + REFERRAL_TTL_MS))).toBeNull()
    expect(s.getItem(REFERRAL_STORAGE_KEY)).toBeNull()
  })

  it('swallows storage failures and corrupt values', () => {
    const throwing = { ...memoryStorage(), setItem: () => { throw new Error('QuotaExceeded') }, getItem: () => { throw new Error('denied') } } as Storage
    expect(captureReferral('?ref=club', throwing, NOW)).toBe(true)
    expect(readReferral(throwing, NOW)).toBeNull()
    expect(captureReferral('?ref=club', null, NOW)).toBe(true)
    const corrupt = memoryStorage()
    corrupt.setItem(REFERRAL_STORAGE_KEY, '{not json')
    expect(readReferral(corrupt, NOW)).toBeNull()
  })
})

// The full data router (createMemoryRouter + RouterProvider) constructs a real
// Request for every navigate() call, including this replace-in-place one. Under
// jsdom that Request's AbortSignal comes from a different realm than the one
// Node's fetch validates against, so it throws "Expected signal to be an
// instance of AbortSignal" — see the same note in
// src/pages/catalog-pages.test.tsx. The declarative MemoryRouter exercises the
// same useLocation/useNavigate hook without going through that data-router
// machinery, so it is used here instead.
describe('useReferralCapture', () => {
  function Probe() {
    useReferralCapture()
    const l = useLocation()
    return <p data-testid="loc">{l.pathname + l.search}</p>
  }

  it('stores the code and strips ref from the URL, keeping other params', async () => {
    render(
      <MemoryRouter initialEntries={['/collections?ref=Brick-Club&sort=new']}>
        <Probe />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/collections?sort=new'))
    expect(readReferral(window.localStorage)?.code).toBe('brick-club')
  })
})
