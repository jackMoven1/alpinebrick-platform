import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { imageUrl } from './images'

const here = dirname(fileURLToPath(import.meta.url))
const CORE_RESOLVER = join(here, '../../../../core/src/assets/image-url.ts')

/**
 * The resolver exists in two places by design: core needs it for the Walmart
 * item feed, this copy serves srcset, and the two packages cannot import each
 * other. This test reads core's copy and checks the grammar has not drifted.
 *
 * It is a source-level check on purpose. If it starts failing, fix whichever
 * copy is wrong — do NOT relax the assertions, because the whole point of
 * accepting the duplication was that drift would be caught.
 */
describe('resolver parity with core', () => {
  const coreSource = readFileSync(CORE_RESOLVER, 'utf8')

  it('core uses the same query parameter names', () => {
    expect(coreSource).toContain(`params.set('w', String(opts.width))`)
    expect(coreSource).toContain(`params.set('fmt', opts.format)`)
  })

  it('core strips trailing slashes from the base as this copy does', () => {
    expect(coreSource).toContain(`.replace(/\\/+$/, '')`)
  })

  it('core rejects a non-positive width as this copy does', () => {
    expect(coreSource).toContain('width must be a positive integer')
  })

  it('core appends the query string only when there is one', () => {
    expect(coreSource).toContain('${qs ? `?${qs}` : \'\'}')
  })

  it('this copy produces the documented shape', () => {
    expect(imageUrl('products/p/i/original.jpg', { width: 800, format: 'webp' }))
      .toContain('?w=800&fmt=webp')
  })
})
