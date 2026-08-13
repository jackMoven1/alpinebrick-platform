import { readFile, stat as fsStat, unlink } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { imageSize } from 'image-size'
import type { AssetStoragePort, StoredObject, UploadTarget } from './storage.port.js'

const UPLOAD_WINDOW_MS = 15 * 60 * 1000

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

export function createLocalStoragePort(
  rootDir: string,
  publicBaseUrl: string,
): AssetStoragePort {
  // Keys originate in the database, but a traversal here would read or write
  // outside the storage root, so resolve and check rather than trusting them.
  function pathFor(key: string): string {
    const full = resolve(rootDir, key)
    const rootResolved = resolve(rootDir)
    if (full !== rootResolved && !full.startsWith(rootResolved + sep)) {
      throw new Error(`invalid key: ${key}`)
    }
    return full
  }

  return {
    async createUploadTarget(key: string): Promise<UploadTarget> {
      pathFor(key)
      return {
        uploadUrl: `${publicBaseUrl.replace(/\/+$/, '')}/${key}`,
        expiresAt: new Date(Date.now() + UPLOAD_WINDOW_MS),
      }
    },

    async stat(key: string): Promise<StoredObject | null> {
      const path = pathFor(key)
      let byteSize: number
      try {
        byteSize = (await fsStat(path)).size
      } catch {
        return null
      }
      const buf = await readFile(path)
      const dims = imageSize(buf)
      const ext = key.split('.').pop()?.toLowerCase() ?? ''
      return {
        width: dims.width ?? 0,
        height: dims.height ?? 0,
        byteSize,
        contentType: CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream',
      }
    },

    async delete(key: string): Promise<void> {
      try {
        await unlink(pathFor(key))
      } catch (err: any) {
        // Absent is the desired end state, so treat it as success. Anything
        // else -- permissions, a traversal rejection -- must still surface.
        if (err?.code !== 'ENOENT') throw err
      }
    },
  }
}
