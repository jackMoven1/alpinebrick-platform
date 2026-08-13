export interface StoredObject {
  width: number
  height: number
  byteSize: number
  contentType: string
}

export interface UploadTarget {
  uploadUrl: string
  expiresAt: Date
}

/**
 * Where image bytes live.
 *
 * Implemented today by the local filesystem adapter; a CDN adapter implements
 * the same three methods once a provider is chosen (ADR-0002). Nothing above
 * this interface knows which is in use, which is why the provider decision --
 * a spend commitment -- does not block building the ingestion path.
 */
export interface AssetStoragePort {
  /** A short-lived destination the client PUTs bytes to directly. */
  createUploadTarget(key: string, contentType: string): Promise<UploadTarget>
  /** Real metadata read from the stored object, or null if it is not there. */
  stat(key: string): Promise<StoredObject | null>
  /** Removes the object. Absent objects are not an error. */
  delete(key: string): Promise<void>
}
