import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '../src/prisma.js'
import { seed } from '../prisma/seed.js'
import { resetDb } from './helpers/db.js'

const REQUIRED_CATEGORIES = ['architecture', 'fantasy', 'space', 'ocean', 'nature']

describe('seed', () => {
  beforeAll(async () => { await resetDb(); await seed() })
  afterAll(async () => { await prisma.$disconnect() })

  it('seeds at least 8 published products', async () => {
    const n = await prisma.product.count({ where: { status: 'published' } })
    expect(n).toBeGreaterThanOrEqual(8)
  })

  it('covers every category collection', async () => {
    const all = await prisma.product.findMany()
    const seen = new Set(all.flatMap(p => p.categories as string[]))
    for (const c of REQUIRED_CATEGORIES) expect(seen).toContain(c)
  })

  it('uses lowercase kebab-case category slugs only', async () => {
    const all = await prisma.product.findMany()
    for (const c of all.flatMap(p => p.categories as string[])) {
      expect(c).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    }
  })

  it('includes a limited run so the Limited badge has a source', async () => {
    const n = await prisma.product.count({ where: { releaseType: 'limited_run' } })
    expect(n).toBeGreaterThanOrEqual(1)
  })

  // The limited-edition collection resolves through a category, not a
  // releaseType filter, so limited runs must carry that category too.
  it('gives every limited run the limited-edition category', async () => {
    const limited = await prisma.product.findMany({ where: { releaseType: 'limited_run' } })
    expect(limited.length).toBeGreaterThanOrEqual(1)
    for (const p of limited) {
      expect(p.categories as string[]).toContain('limited-edition')
    }
  })

  it('gives every product at least one variant and one image with alt text', async () => {
    const all = await prisma.product.findMany({ include: { variants: true } })
    for (const p of all) {
      expect(p.variants.length).toBeGreaterThanOrEqual(1)
      const imgs = p.imagesJson as { url: string; alt: string }[]
      expect(imgs.length).toBeGreaterThanOrEqual(1)
      for (const i of imgs) {
        expect(typeof i.url).toBe('string')
        expect(i.alt.length).toBeGreaterThan(0)
      }
    }
  })

  it('assigns every product both display positions', async () => {
    const all = await prisma.product.findMany()
    for (const p of all) {
      expect(p.homePosition).not.toBeNull()
      expect(p.collectionPosition).not.toBeNull()
    }
  })

  it('makes home positions unique so the order is unambiguous', async () => {
    const all = await prisma.product.findMany()
    const positions = all.map(p => p.homePosition)
    expect(new Set(positions).size).toBe(positions.length)
  })

  // Two columns are pointless if the seed sets them identically — the fixture
  // must be able to demonstrate that the orderings differ.
  it('does not order the home page and collections identically', async () => {
    const all = await prisma.product.findMany()
    const byHome = [...all].sort((a, b) => a.homePosition! - b.homePosition!).map(p => p.slug)
    const byColl = [...all].sort((a, b) => a.collectionPosition! - b.collectionPosition!).map(p => p.slug)
    expect(byHome).not.toEqual(byColl)
  })

  it('is idempotent', async () => {
    const before = await prisma.product.count()
    await seed()
    expect(await prisma.product.count()).toBe(before)
  })
})
