import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createSession } from '../src/auth/session.service.js'
import { SESSION_COOKIE } from '../src/auth/session.service.js'

const app = buildApp()

beforeEach(resetDb)
afterAll(() => prisma.$disconnect())

/**
 * Enumerated from the mounted router rather than hand-listed. The realistic
 * failure is not a broken check -- it is an endpoint added later by someone who
 * did not think about auth. Built this way, that fails here on the commit that
 * introduces it.
 */
function mountedAdminRoutes(): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = []
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) {
          out.push({ method: m, path: prefix + layer.route.path })
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        const src = layer.regexp?.source ?? ''
        const seg = src
          .replace('^\\/', '/').replace('\\/?(?=\\/|$)', '')
          .replace(/\\\//g, '/').replace(/\$$/, '')
        walk(layer.handle.stack, prefix + (seg === '/' ? '' : seg))
      }
    }
  }
  walk((app as any)._router.stack, '')
  return out.filter(r => r.path.startsWith('/api/v1/admin'))
}

describe('admin route auth coverage', () => {
  it('finds both admin routers mounted', () => {
    const routes = mountedAdminRoutes()
    expect(routes.length).toBeGreaterThan(0)
    // Guards the trap in spec 5.1: images mounts FIRST and must be covered.
    expect(routes.some(r => r.path.startsWith('/api/v1/admin/images'))).toBe(true)
    expect(routes.some(r => r.path.startsWith('/api/v1/admin/products'))).toBe(true)
  })

  it('every mounted admin route rejects an unauthenticated request', async () => {
    const routes = mountedAdminRoutes()
    const failures: string[] = []
    for (const r of routes) {
      const path = r.path.replace(/:[A-Za-z]+/g, 'x')
      const res = await (request(app) as any)[r.method](path).send({})
      if (res.status !== 401) failures.push(`${r.method.toUpperCase()} ${path} -> ${res.status}`)
    }
    expect(failures).toEqual([])
  })

  it('accepts a valid session cookie', async () => {
    const actor = await prisma.actor.create({ data: { type: 'human', name: 'jack' } })
    const { token } = await createSession(actor.id)
    const res = await request(app)
      .get('/api/v1/admin/products')
      .set('Cookie', `${SESSION_COOKIE}=${token}`)
    expect(res.status).toBe(200)
  })

  // The regression that would take the storefront down.
  it('leaves the public catalog routes unauthenticated', async () => {
    const res = await request(app).get('/api/v1/catalog/products')
    expect(res.status).toBe(200)
  })

  it('leaves health unauthenticated', async () => {
    expect((await request(app).get('/health')).status).toBe(200)
  })
})
