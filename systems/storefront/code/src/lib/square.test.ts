import { describe, it, expect, vi, afterEach } from 'vitest'

const tags = () => document.head.querySelectorAll('script[data-square-sdk]')
async function fresh() {
  vi.resetModules()
  return import('./square')
}
function setEnv(environment = 'sandbox') {
  vi.stubEnv('VITE_SQUARE_APPLICATION_ID', 'sandbox-sq0idb-test')
  vi.stubEnv('VITE_SQUARE_LOCATION_ID', 'LONLINE')
  vi.stubEnv('VITE_SQUARE_ENVIRONMENT', environment)
}
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  tags().forEach((s) => s.remove())
  delete (window as { Square?: unknown }).Square
})

describe('squareConfig / loadSquare', () => {
  it('is null unless all three settings are present and the environment is known', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('VITE_SQUARE_APPLICATION_ID', 'x')
    let m = await fresh()
    expect(m.squareConfig()).toBeNull()
    expect(m.loadSquare()).toBeNull()
    setEnv('live')
    m = await fresh()
    expect(m.squareConfig()).toBeNull()
  })

  it('injects the sandbox script once and resolves window.Square', async () => {
    setEnv()
    const m = await fresh()
    expect(m.squareConfig()).toEqual({ applicationId: 'sandbox-sq0idb-test', locationId: 'LONLINE', environment: 'sandbox' })
    const a = m.loadSquare()!
    const b = m.loadSquare()!
    expect(tags()).toHaveLength(1)
    expect((tags()[0] as HTMLScriptElement).src).toBe('https://sandbox.web.squarecdn.com/v1/square.js')
    const square = { payments: vi.fn() }
    ;(window as { Square?: unknown }).Square = square
    tags()[0].dispatchEvent(new Event('load'))
    expect(await a).toBe(square)
    expect(await b).toBe(square)
  })

  it('uses Square’s production host in production', async () => {
    setEnv('production')
    const m = await fresh()
    void m.loadSquare()
    expect((tags()[0] as HTMLScriptElement).src).toBe('https://web.squarecdn.com/v1/square.js')
  })

  it('turns a failed load into null, removes the tag, and tries again next time', async () => {
    setEnv()
    const m = await fresh()
    const p = m.loadSquare()!
    tags()[0].dispatchEvent(new Event('error'))
    expect(await p).toBeNull()
    expect(tags()).toHaveLength(0)
    void m.loadSquare()
    expect(tags()).toHaveLength(1)
  })

  it('treats a load without window.Square as a failure: null, tag removed, retried next time', async () => {
    setEnv()
    const m = await fresh()
    const p = m.loadSquare()!
    tags()[0].dispatchEvent(new Event('load'))
    expect(await p).toBeNull()
    expect(tags()).toHaveLength(0)
    void m.loadSquare()
    expect(tags()).toHaveLength(1)
  })

  it('trims and lower-cases the environment', async () => {
    setEnv('  Production ')
    const m = await fresh()
    expect(m.squareConfig()).toEqual({ applicationId: 'sandbox-sq0idb-test', locationId: 'LONLINE', environment: 'production' })
  })

  it('warns once when the environment is set but is neither sandbox nor production', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setEnv('live')
    const m = await fresh()
    expect(m.squareConfig()).toBeNull()
    expect(m.squareConfig()).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('VITE_SQUARE_ENVIRONMENT')
  })

  it('does not warn when the environment is simply unset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const m = await fresh()
    expect(m.squareConfig()).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('gives up on a script that never loads: null after the timeout, tag removed, retried next time', async () => {
    vi.useFakeTimers()
    setEnv()
    const m = await fresh()
    const p = m.loadSquare()!
    let result: unknown = 'pending'
    void p.then((r) => { result = r })
    await vi.advanceTimersByTimeAsync(m.SQUARE_LOAD_TIMEOUT_MS - 1)
    expect(result).toBe('pending')
    expect(tags()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toBeNull()
    expect(tags()).toHaveLength(0)
    expect(m.SQUARE_LOAD_TIMEOUT_MS).toBe(15_000)
    void m.loadSquare()
    expect(tags()).toHaveLength(1)
  })

  it('a script that loads in time is not failed by the timeout later', async () => {
    vi.useFakeTimers()
    setEnv()
    const m = await fresh()
    const p = m.loadSquare()!
    const square = { payments: vi.fn() }
    ;(window as { Square?: unknown }).Square = square
    tags()[0].dispatchEvent(new Event('load'))
    expect(await p).toBe(square)
    await vi.advanceTimersByTimeAsync(m.SQUARE_LOAD_TIMEOUT_MS)
    expect(tags()).toHaveLength(1)
    expect(m.loadSquare()).toBe(p)
  })

  it('only ever points at Square’s two CDN hosts', async () => {
    const m = await fresh()
    expect(Object.values(m.SQUARE_SCRIPT_URLS).map((u) => new URL(u).host).sort())
      .toEqual(['sandbox.web.squarecdn.com', 'web.squarecdn.com'])
  })
})
