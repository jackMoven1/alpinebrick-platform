import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createLocalStoragePort } from '../src/ports/storage/local.adapter.js'

// A 1x1 red PNG, base64. Small enough to inline, real enough for a header read.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let root: string

beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'abx-assets-')) })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

describe('local storage adapter', () => {
  it('creates an upload target that expires in the future', async () => {
    const port = createLocalStoragePort(root, 'http://localhost:4000/assets')
    const target = await port.createUploadTarget('products/p1/i1/original.png', 'image/png')
    expect(target.uploadUrl).toContain('products/p1/i1/original.png')
    expect(target.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('stats a stored object and reads its REAL dimensions', async () => {
    const port = createLocalStoragePort(root, 'http://localhost:4000/assets')
    const key = 'products/p2/i2/original.png'
    const path = join(root, key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, PNG_1X1)

    const stat = await port.stat(key)
    expect(stat).not.toBeNull()
    expect(stat!.width).toBe(1)
    expect(stat!.height).toBe(1)
    expect(stat!.contentType).toBe('image/png')
    expect(stat!.byteSize).toBe(PNG_1X1.byteLength)
  })

  // Confirm must be able to tell "uploaded" from "never arrived".
  it('returns null for a key that was never uploaded', async () => {
    const port = createLocalStoragePort(root, 'http://localhost:4000/assets')
    expect(await port.stat('products/p3/nope/original.png')).toBeNull()
  })

  it('deletes an object', async () => {
    const port = createLocalStoragePort(root, 'http://localhost:4000/assets')
    const key = 'products/p4/i4/original.png'
    const path = join(root, key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, PNG_1X1)
    await port.delete(key)
    expect(await port.stat(key)).toBeNull()
  })

  // Keys come from the database, but a traversal would still be catastrophic.
  it('refuses a key that escapes the storage root', async () => {
    const port = createLocalStoragePort(root, 'http://localhost:4000/assets')
    await expect(port.stat('../../etc/passwd')).rejects.toThrow(/invalid key/i)
  })

  it('deleting a key that does not exist is not an error', async () => {
    const port = createLocalStoragePort(root, 'http://localhost:4000/assets')
    await expect(port.delete('products/p5/gone/original.png')).resolves.toBeUndefined()
  })
})
