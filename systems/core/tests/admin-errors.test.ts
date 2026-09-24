import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import { AdminError, mapUniqueViolation } from '../src/admin/admin-errors.js'
import { AdminError as ReExported } from '../src/admin/admin-catalog.service.js'

const p2002 = (target: unknown) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'x', meta: { target } })

describe('AdminError', () => {
  it('carries fields and details', () => {
    const e = new AdminError('VALIDATION_ERROR', 'bad', { name: 'required' }, { onHand: 1 })
    expect([e.code, e.fields, e.details]).toEqual(['VALIDATION_ERROR', { name: 'required' }, { onHand: 1 }])
  })
  it('is the same class through the old import path', () => {
    expect(ReExported).toBe(AdminError)
  })
})

describe('mapUniqueViolation', () => {
  it('maps a slug collision', () => {
    expect(mapUniqueViolation(p2002(['slug']))).toMatchObject({ code: 'SLUG_TAKEN', fields: { slug: 'already in use' } })
  })
  it('maps a sku collision, including by constraint name', () => {
    expect(mapUniqueViolation(p2002('variants_sku_key'))).toMatchObject({ code: 'SKU_TAKEN' })
  })
  it('passes anything else through untouched', () => {
    const other = new Error('x')
    expect(mapUniqueViolation(other)).toBe(other)
  })
})
