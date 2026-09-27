import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { createProduct } from '../src/admin/product-write.service.js'
import { createVariant, updateVariant } from '../src/admin/variant-write.service.js'
import { parseVariantInput } from '../src/admin/product-input.js'

let actorId: string
beforeEach(async () => {
  await resetDb()
  actorId = (await prisma.actor.create({ data: { type: 'human', name: 't' } })).id
})
afterAll(() => prisma.$disconnect())

describe('variant weight and dimensions', () => {
  it('parses the four optional fields, null clearing', () => {
    expect(parseVariantInput({ weightGrams: 850, lengthMm: null }, 'patch')).toEqual({ weightGrams: 850, lengthMm: null })
    expect(() => parseVariantInput({ widthMm: 0 }, 'patch')).toThrow()
    expect(() => parseVariantInput({ heightMm: 1.5 }, 'patch')).toThrow()
  })

  it('creates and edits them, and the admin DTO returns them', async () => {
    const p = await createProduct({ name: 'Castle', productType: 'resale' }, actorId)
    const created = await createVariant(p.id, { sku: 'C-1', priceCents: 1000, weightGrams: 900, lengthMm: 380, widthMm: 260, heightMm: 70 }, actorId)
    expect(created.variants[0]).toMatchObject({ weightGrams: 900, lengthMm: 380, widthMm: 260, heightMm: 70 })
    const edited = await updateVariant(created.variants[0].id, { weightGrams: 950, heightMm: null }, actorId)
    expect(edited.variants[0]).toMatchObject({ weightGrams: 950, lengthMm: 380, heightMm: null })
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'variant.update' } })
    expect(audit.after).toEqual({ weightGrams: 950, heightMm: null })
  })
})
