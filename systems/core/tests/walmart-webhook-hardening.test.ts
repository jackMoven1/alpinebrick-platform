import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import { walmartOrderFixture } from './helpers/walmart-fixtures.js'

process.env.WALMART_WEBHOOK_SECRET = 'test-secret'

// orders.ingest.ts's ingestWalmartOrder only ever throws ChannelError for
// the failure modes it anticipates (unmappable_order / unknown_sku /
// insufficient_stock) -- see tests/walmart-webhooks.test.ts for those. A
// genuine unexpected failure (a raw Prisma error is the realistic trigger --
// e.g. an oversized or odd field in a real Walmart payload hitting a column
// constraint) is a different, non-ChannelError throw the webhook route must
// also survive. Mocked here, module-scoped to this file only, so the rest
// of the suite still exercises the real ingest path (same pattern as
// tests/admin-catalog-failure.test.ts's mock of admin-catalog.service.ts).
vi.mock('../src/channels/walmart/orders.ingest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/channels/walmart/orders.ingest.js')>()
  return {
    ...actual,
    ingestWalmartOrder: vi.fn(async () => { throw new Error('unexpected db failure') }),
  }
})

// Wraps the real hashesEqual so its actual call arguments can be inspected,
// while still returning real results (so the 401/200 branching under test
// stays genuine, not stubbed away). Proves the webhook route hashes both
// sides to a fixed-length digest before comparing, rather than comparing
// WALMART_WEBHOOK_SECRET directly -- see webhooks.routes.ts's comment on why
// hashesEqual's equal-length precondition matters here.
vi.mock('../src/auth/tokens.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth/tokens.js')>()
  return { ...actual, hashesEqual: vi.fn(actual.hashesEqual) }
})

const { buildApp } = await import('../src/app.js')
const { hashesEqual } = (await import('../src/auth/tokens.js')) as unknown as {
  hashesEqual: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  hashesEqual.mockClear()
})

describe('walmart webhook: survives an unexpected (non-ChannelError) failure', () => {
  it('responds 500 INTERNAL_ERROR instead of crashing the process, and raises no unhandled rejection', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => rejections.push(reason)
    process.on('unhandledRejection', onRejection)
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const res = await request(buildApp())
        .post('/api/v1/channels/walmart/webhooks')
        .set('x-webhook-secret', 'test-secret')
        .send({ eventType: 'ORDER_CREATED', payload: walmartOrderFixture })

      expect(res.status).toBe(500)
      expect(res.body).toEqual({ code: 'INTERNAL_ERROR' })

      // Flush the microtask/macrotask queue: asyncHandler's .catch(next)
      // attaches synchronously, but this makes sure nothing was left
      // dangling before we assert on its absence.
      await new Promise((resolve) => setImmediate(resolve))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
      logSpy.mockRestore()
    }
  })
})

describe('walmart webhook: secret comparison hashes before comparing', () => {
  it('always compares fixed-length sha256-hex digests to hashesEqual, never the raw secret', async () => {
    const res = await request(buildApp())
      .post('/api/v1/channels/walmart/webhooks')
      .set('x-webhook-secret', 'x') // deliberately not the same length as 'test-secret'
      .send({ eventType: 'ORDER_CREATED', payload: walmartOrderFixture })

    expect(res.status).toBe(401) // 'x' still doesn't match -- only the args to hashesEqual are under test here
    expect(hashesEqual).toHaveBeenCalledTimes(1)
    const [a, b] = hashesEqual.mock.calls[0] as [string, string]
    expect(a).toHaveLength(64) // sha256 hex digest -- NOT 'x'.length (1)
    expect(b).toHaveLength(64) // NOT process.env.WALMART_WEBHOOK_SECRET's raw length (11)
  })
})
