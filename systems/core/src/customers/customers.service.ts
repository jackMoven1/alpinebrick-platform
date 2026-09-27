import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'

/** The storefront checkbox label, verbatim (spec §6, D8). */
export const CONSENT_WORDING = 'Email me about new sets and restocks'
/** Recorded with the consent so the exact wording agreed to is on file. */
export const CONSENT_SOURCE = `storefront_checkout: "${CONSENT_WORDING}"`

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Find-or-create by email (D3). Consent only ever goes false -> true, and the
 * first opt-in's timestamp is kept (spec §3).
 *
 * The upsert is on the unique email, so two webhooks for the same new
 * customer cannot create two rows. Consent is a separate conditional
 * UPDATE (`marketingConsent: false` in the WHERE), so a repeat opt-in never
 * moves the original timestamp.
 */
export async function upsertCustomerFromCheckout(
  input: { email: string; name: string | null; consent: boolean; at?: Date },
  db: Pick<Prisma.TransactionClient, 'customer'> = prisma,
): Promise<{ id: string }> {
  const email = normalizeEmail(input.email)
  const at = input.at ?? new Date()
  const consent = { marketingConsent: true, marketingConsentAt: at, marketingConsentSource: CONSENT_SOURCE }
  const customer = await db.customer.upsert({
    where: { email },
    create: { email, name: input.name, lastOrderAt: at, ...(input.consent ? consent : {}) },
    update: { lastOrderAt: at, ...(input.name ? { name: input.name } : {}) },
    select: { id: true },
  })
  if (input.consent) {
    await db.customer.updateMany({ where: { id: customer.id, marketingConsent: false }, data: consent })
  }
  return customer
}
