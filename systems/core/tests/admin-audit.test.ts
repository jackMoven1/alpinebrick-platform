import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createSession, SESSION_COOKIE } from '../src/auth/session.service.js'

const app = buildApp()
const ORIGIN = 'https://console.example'

beforeEach(async () => {
  await resetDb()
  process.env.ADMIN_CONSOLE_ORIGIN = ORIGIN
})
afterAll(async () => {
  delete process.env.ADMIN_CONSOLE_ORIGIN
  await prisma.$disconnect()
})

describe('admin writes are audited', () => {
  it('records the acting actor and the status transition', async () => {
    const actor = await prisma.actor.create({ data: { type: 'human', name: 'jack' } })
    const { token } = await createSession(actor.id)
    const p = await prisma.product.create({
      data: { slug: 'a', name: 'A', productType: 'resale', status: 'draft' },
    })

    await request(app)
      .post(`/api/v1/admin/products/${p.id}/status`)
      .set('Cookie', `${SESSION_COOKIE}=${token}`).set('Origin', ORIGIN)
      .send({ status: 'published' })
      .expect(200)

    const rows = await prisma.auditLog.findMany({ where: { action: 'product.status' } })
    expect(rows).toHaveLength(1)
    expect(rows[0].actorId).toBe(actor.id)
    expect(rows[0].target).toBe(`product:${p.id}`)
    expect((rows[0].before as any).status).toBe('draft')
    expect((rows[0].after as any).status).toBe('published')
  })

  // The change and its audit row must land together or not at all.
  it('writes no audit row when the transition is rejected', async () => {
    const actor = await prisma.actor.create({ data: { type: 'human', name: 'jack' } })
    const { token } = await createSession(actor.id)
    const p = await prisma.product.create({
      data: { slug: 'b', name: 'B', productType: 'resale', status: 'archived' },
    })

    await request(app)
      .post(`/api/v1/admin/products/${p.id}/status`)
      .set('Cookie', `${SESSION_COOKIE}=${token}`).set('Origin', ORIGIN)
      .send({ status: 'published' })
      .expect(409)

    expect(await prisma.auditLog.count()).toBe(0)
    expect((await prisma.product.findUnique({ where: { id: p.id } }))!.status).toBe('archived')
  })
})
