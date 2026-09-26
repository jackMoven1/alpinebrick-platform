import type { AssetStoragePort } from './storage.port.js'
import { createLocalStoragePort } from './local.adapter.js'
import { createS3StoragePort } from './s3.adapter.js'

const S3_KEYS = ['ASSET_S3_BUCKET', 'ASSET_S3_REGION', 'ASSET_S3_ACCESS_KEY_ID', 'ASSET_S3_SECRET_ACCESS_KEY'] as const

/**
 * Picks the storage adapter at startup. S3 with any setting missing throws,
 * naming each key: a deploy that meant to use S3 must never silently write
 * to a filesystem Render wipes on the next deploy.
 */
export function createStoragePort(env: NodeJS.ProcessEnv = process.env): AssetStoragePort {
  const kind = env.ASSET_STORAGE
  if (!kind) {
    return createLocalStoragePort(
      env.ASSET_STORAGE_DIR ?? './var/assets',
      env.ASSET_PUBLIC_BASE_URL ?? 'http://localhost:4000/assets',
    )
  }
  if (kind !== 's3') throw new Error(`ASSET_STORAGE must be "s3" or unset, got "${kind}"`)
  const missing = S3_KEYS.filter((k) => !env[k])
  if (missing.length) throw new Error(`ASSET_STORAGE=s3 but missing: ${missing.join(', ')}`)
  return createS3StoragePort({
    bucket: env.ASSET_S3_BUCKET!, region: env.ASSET_S3_REGION!,
    accessKeyId: env.ASSET_S3_ACCESS_KEY_ID!, secretAccessKey: env.ASSET_S3_SECRET_ACCESS_KEY!,
  })
}
