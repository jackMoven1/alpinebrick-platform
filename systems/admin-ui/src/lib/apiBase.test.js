import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// import.meta.env is read once at module evaluation, so exercising both
// configurations requires a fresh module instance per test: reset the
// module registry, stub the env var, then dynamically import.
describe('API_BASE_URL', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.unstubAllEnvs())

  it('defaults to empty string, so the dev proxy keeps working unchanged', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '')
    const { API_BASE_URL } = await import('./apiBase.js')
    expect(API_BASE_URL).toBe('')
  })

  it('uses a configured base with a trailing slash stripped', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.alpinebrickexchange.com/')
    const { API_BASE_URL } = await import('./apiBase.js')
    expect(API_BASE_URL).toBe('https://api.alpinebrickexchange.com')
  })
})
