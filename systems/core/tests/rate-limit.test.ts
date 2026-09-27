import { describe, it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createRateLimiter } from '../src/lib/rate-limit.js'

describe('createRateLimiter', () => {
  it('allows `limit` requests per window per IP, then 429s until the window resets', async () => {
    let t = 0
    const app = express()
    app.get('/', createRateLimiter({ limit: 2, windowMs: 60_000, now: () => t }), (_req, res) => { res.json({ ok: true }) })
    expect((await request(app).get('/')).status).toBe(200)
    expect((await request(app).get('/')).status).toBe(200)
    const blocked = await request(app).get('/')
    expect(blocked.status).toBe(429)
    expect(blocked.body.code).toBe('rate_limited')
    expect(blocked.headers['retry-after']).toBe('60')
    t = 60_000
    expect((await request(app).get('/')).status).toBe(200)
  })
})
