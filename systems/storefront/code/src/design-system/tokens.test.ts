import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const tokens = readFileSync(join(here, 'tokens.css'), 'utf8')

describe('design tokens', () => {
  it('defines the identity-carrying values exactly', () => {
    expect(tokens).toContain('--background: #0f0f0f')
    expect(tokens).toContain('--foreground: #f0ede8')
    expect(tokens).toContain('--card: #181818')
    expect(tokens).toContain('--primary: #ffd100')
    expect(tokens).toContain('--muted-foreground: #8a8a8a')
    expect(tokens).toContain('--radius: 0.125rem')
  })

  // Pure white is reserved for the accent state (the "Added" confirmation).
  // If --foreground ever becomes #ffffff the whole palette reads wrong.
  it('never sets foreground to pure white', () => {
    expect(tokens).not.toMatch(/--foreground:\s*#fff/i)
  })

  it('reserves pure white for the accent token', () => {
    expect(tokens).toContain('--accent: #ffffff')
  })

  it('keeps a focus ring token for keyboard accessibility', () => {
    expect(tokens).toMatch(/--ring:/)
  })
})
