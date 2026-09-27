import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'
import { upsertCustomerFromCheckout, CONSENT_SOURCE } from '../src/customers/customers.service.js'

beforeEach(() => resetDb())
afterAll(() => prisma.$disconnect())

const T1 = new Date('2026-10-01T00:00:00Z')
const T2 = new Date('2026-10-05T00:00:00Z')

describe('upsertCustomerFromCheckout', () => {
  it('creates a customer with a normalised email and consent when ticked', async () => {
    const { id } = await upsertCustomerFromCheckout({ email: '  Buyer@Example.COM ', name: 'Ann Buyer', consent: true, at: T1 })
    const c = await prisma.customer.findUniqueOrThrow({ where: { id } })
    expect(c).toMatchObject({
      email: 'buyer@example.com', name: 'Ann Buyer', marketingConsent: true,
      marketingConsentAt: T1, marketingConsentSource: CONSENT_SOURCE, lastOrderAt: T1,
    })
  })

  it('finds the same customer by email and never revokes consent', async () => {
    const a = await upsertCustomerFromCheckout({ email: 'b@example.com', name: 'B', consent: true, at: T1 })
    const b = await upsertCustomerFromCheckout({ email: 'B@example.com', name: null, consent: false, at: T2 })
    expect(b.id).toBe(a.id)
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: a.id } })
    expect(c).toMatchObject({ name: 'B', marketingConsent: true, marketingConsentAt: T1, lastOrderAt: T2 })
  })

  it('turns consent on later without changing it when already on', async () => {
    await upsertCustomerFromCheckout({ email: 'c@example.com', name: null, consent: false, at: T1 })
    await upsertCustomerFromCheckout({ email: 'c@example.com', name: null, consent: true, at: T2 })
    await upsertCustomerFromCheckout({ email: 'c@example.com', name: null, consent: true, at: new Date('2026-11-01T00:00:00Z') })
    const c = await prisma.customer.findUniqueOrThrow({ where: { email: 'c@example.com' } })
    expect(c.marketingConsent).toBe(true)
    expect(c.marketingConsentAt).toEqual(T2)
  })
})
