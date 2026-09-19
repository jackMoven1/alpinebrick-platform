import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// import.meta.env is read once at module evaluation, so exercising both
// configurations requires a fresh module instance per test: reset the
// module registry, stub the env var, then dynamically import the component.
describe('SignIn', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.unstubAllEnvs())

  it('builds an absolute sign-in link when VITE_API_BASE_URL is set', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.alpinebrickexchange.com')
    const { default: SignIn } = await import('./SignIn.jsx')
    render(<SignIn />)
    expect(screen.getByRole('link', { name: /sign in with google/i }))
      .toHaveAttribute('href', 'https://api.alpinebrickexchange.com/api/v1/auth/google/start')
  })

  // The regression this guards: today's relative link, resolved by the dev
  // proxy, must survive unchanged when the env var is unset.
  it('falls back to a relative link when no base is set (current behaviour)', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '')
    const { default: SignIn } = await import('./SignIn.jsx')
    render(<SignIn />)
    expect(screen.getByRole('link', { name: /sign in with google/i }))
      .toHaveAttribute('href', '/api/v1/auth/google/start')
  })
})
