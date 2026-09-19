import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { setProductStatus, AdminError } from '../src/admin/admin-catalog.service.js'
import { getProduct as publicGetProduct } from '../src/catalog/catalog.service.js'

let n = 0
async function make(status: 'draft' | 'published' | 'archived') {
  return prisma.product.create({
    data: { slug: `s-${status}-${n++}`, name: 'S', productType: 'resale', status },
  })
}

let actorId: string

beforeEach(async () => {
  await resetDb()
  const actor = await prisma.actor.create({ data: { type: 'human', name: 'test-admin' } })
  actorId = actor.id
})
afterAll(async () => { await prisma.$disconnect() })

describe('setProductStatus', () => {
  it('publishes a draft', async () => {
    const p = await make('draft')
    expect((await setProductStatus(p.id, 'published', actorId)).status).toBe('published')
  })

  // The success criterion for the whole slice, at the service level.
  it('makes a published product visible to the PUBLIC route', async () => {
    const p = await make('draft')
    expect(await publicGetProduct(p.id)).toBeNull()
    await setProductStatus(p.id, 'published', actorId)
    expect((await publicGetProduct(p.id))?.id).toBe(p.id)
  })

  it('unpublishes back to draft, hiding it from the public route again', async () => {
    const p = await make('published')
    await setProductStatus(p.id, 'draft', actorId)
    expect(await publicGetProduct(p.id)).toBeNull()
  })

  it('archives from draft and from published', async () => {
    const a = await make('draft')
    const b = await make('published')
    expect((await setProductStatus(a.id, 'archived', actorId)).status).toBe('archived')
    expect((await setProductStatus(b.id, 'archived', actorId)).status).toBe('archived')
  })

  it('restores an archived product to draft', async () => {
    const p = await make('archived')
    expect((await setProductStatus(p.id, 'draft', actorId)).status).toBe('draft')
  })

  // Republishing something withdrawn should be considered, not one click.
  it('refuses to publish straight from archived', async () => {
    const p = await make('archived')
    await expect(setProductStatus(p.id, 'published', actorId)).rejects.toThrow(AdminError)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('archived')
  })

  it('refuses a no-op transition', async () => {
    const p = await make('draft')
    await expect(setProductStatus(p.id, 'draft', actorId)).rejects.toThrow(AdminError)
  })

  it('rejects an unknown target status', async () => {
    const p = await make('draft')
    await expect(setProductStatus(p.id, 'bogus', actorId)).rejects.toThrow(AdminError)
  })

  it('rejects an unknown product', async () => {
    await expect(setProductStatus('nope', 'published', actorId)).rejects.toThrow(AdminError)
  })

  it('moves updatedAt forward', async () => {
    const p = await make('draft')
    const before = p.updatedAt.getTime()
    await new Promise(r => setTimeout(r, 5))
    const r = await setProductStatus(p.id, 'published', actorId)
    expect(r.updatedAt.getTime()).toBeGreaterThan(before)
  })
})
