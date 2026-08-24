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

beforeEach(async () => { await resetDb() })
afterAll(async () => { await prisma.$disconnect() })

describe('setProductStatus', () => {
  it('publishes a draft', async () => {
    const p = await make('draft')
    expect((await setProductStatus(p.id, 'published')).status).toBe('published')
  })

  // The success criterion for the whole slice, at the service level.
  it('makes a published product visible to the PUBLIC route', async () => {
    const p = await make('draft')
    expect(await publicGetProduct(p.id)).toBeNull()
    await setProductStatus(p.id, 'published')
    expect((await publicGetProduct(p.id))?.id).toBe(p.id)
  })

  it('unpublishes back to draft, hiding it from the public route again', async () => {
    const p = await make('published')
    await setProductStatus(p.id, 'draft')
    expect(await publicGetProduct(p.id)).toBeNull()
  })

  it('archives from draft and from published', async () => {
    const a = await make('draft')
    const b = await make('published')
    expect((await setProductStatus(a.id, 'archived')).status).toBe('archived')
    expect((await setProductStatus(b.id, 'archived')).status).toBe('archived')
  })

  it('restores an archived product to draft', async () => {
    const p = await make('archived')
    expect((await setProductStatus(p.id, 'draft')).status).toBe('draft')
  })

  // Republishing something withdrawn should be considered, not one click.
  it('refuses to publish straight from archived', async () => {
    const p = await make('archived')
    await expect(setProductStatus(p.id, 'published')).rejects.toThrow(AdminError)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('archived')
  })

  it('refuses a no-op transition', async () => {
    const p = await make('draft')
    await expect(setProductStatus(p.id, 'draft')).rejects.toThrow(AdminError)
  })

  it('rejects an unknown target status', async () => {
    const p = await make('draft')
    await expect(setProductStatus(p.id, 'bogus')).rejects.toThrow(AdminError)
  })

  it('rejects an unknown product', async () => {
    await expect(setProductStatus('nope', 'published')).rejects.toThrow(AdminError)
  })

  it('moves updatedAt forward', async () => {
    const p = await make('draft')
    const before = p.updatedAt.getTime()
    await new Promise(r => setTimeout(r, 5))
    const r = await setProductStatus(p.id, 'published')
    expect(r.updatedAt.getTime()).toBeGreaterThan(before)
  })
})
