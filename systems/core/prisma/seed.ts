import { prisma } from '../src/prisma.js'

const PRODUCTS = [
  {
    slug: 'brick-builder-set', name: 'Brick Builder Set', productType: 'own_designed' as const,
    releaseType: 'standard' as const, status: 'published' as const,
    variant: { sku: 'BBS-STD', priceCents: 4999, onHand: 25 },
  },
  {
    slug: 'castle-mega-pack', name: 'Castle Mega Pack (Limited)', productType: 'resale' as const,
    releaseType: 'limited_run' as const, status: 'published' as const,
    variant: { sku: 'CMP-LTD', priceCents: 12999, onHand: 8 },
  },
]

export async function seed(): Promise<void> {
  await prisma.actor.upsert({
    where: { id: 'system' }, update: {},
    create: { id: 'system', type: 'human', name: 'system' },
  })
  for (const p of PRODUCTS) {
    await prisma.product.upsert({
      where: { slug: p.slug },
      update: {},
      create: {
        slug: p.slug, name: p.name, productType: p.productType,
        releaseType: p.releaseType, status: p.status,
        variants: {
          create: {
            sku: p.variant.sku, priceCents: p.variant.priceCents,
            inventory: { create: { onHand: p.variant.onHand } },
          },
        },
      },
    })
  }
}

// Allow `npm run seed` to execute it directly.
if (process.argv[1]?.endsWith('seed.ts')) {
  seed().then(() => prisma.$disconnect())
}
