// tests/square-payments-schema.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '../src/prisma.js'
import { resetDb } from './helpers/db.js'

beforeEach(async () => { await resetDb() })
afterAll(() => prisma.$disconnect())

const order = (data: Partial<Prisma.OrderUncheckedCreateInput> = {}) => prisma.order.create({
  data: {
    email: 'a@example.com', shipToState: 'MI', subtotalCents: 100, taxCents: 0, totalCents: 100,
    taxRateBps: 0, taxJurisdiction: 'none', ...data,
  },
})

describe('square payments schema', () => {
  it('gives orders the payment-attempt defaults', async () => {
    expect(await order()).toMatchObject({
      squarePaymentId: null, paymentAttemptAt: null, paymentAttemptCount: 0, quoteVersion: 0,
    })
  })

  it('keeps Square payment ids unique', async () => {
    await order({ squarePaymentId: 'sqpay_1' })
    await expect(order({ squarePaymentId: 'sqpay_1' })).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
  })

  it('de-duplicates payment events per provider, not globally', async () => {
    await prisma.paymentEvent.create({ data: { provider: 'square', eventId: 'e1', type: 'payment.updated' } })
    await prisma.paymentEvent.create({ data: { provider: 'stripe', eventId: 'e1', type: 'charge.refunded' } })
    await expect(prisma.paymentEvent.create({ data: { provider: 'square', eventId: 'e1', type: 'payment.updated' } }))
      .rejects.toMatchObject({ code: 'P2002' })
  })

  it('refuses negative attempt counters and quote versions', async () => {
    await expect(order({ paymentAttemptCount: -1 })).rejects.toThrow(/orders_payment_counters_nonnegative/)
    await expect(order({ quoteVersion: -1 })).rejects.toThrow(/orders_payment_counters_nonnegative/)
  })
})
