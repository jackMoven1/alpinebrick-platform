import { describe, it, expect } from 'vitest'
import { createStoragePort } from '../src/ports/storage/index.js'

const FULL = {
  ASSET_STORAGE: 's3', ASSET_S3_BUCKET: 'b', ASSET_S3_REGION: 'us-west-2',
  ASSET_S3_ACCESS_KEY_ID: 'a', ASSET_S3_SECRET_ACCESS_KEY: 's',
}

describe('createStoragePort', () => {
  it('uses local storage when ASSET_STORAGE is unset', () => {
    expect(() => createStoragePort({})).not.toThrow()
  })
  it('builds an S3 port when fully configured', () => {
    const p = createStoragePort(FULL)
    expect(typeof p.createUploadTarget).toBe('function')
  })
  it('refuses to start half-configured, naming every missing key', () => {
    const { ASSET_S3_BUCKET, ASSET_S3_SECRET_ACCESS_KEY, ...partial } = FULL
    expect(() => createStoragePort(partial)).toThrow(/ASSET_S3_BUCKET.*ASSET_S3_SECRET_ACCESS_KEY/)
  })
  it('rejects an unknown ASSET_STORAGE value', () => {
    expect(() => createStoragePort({ ASSET_STORAGE: 'r2' })).toThrow(/ASSET_STORAGE/)
  })
})
