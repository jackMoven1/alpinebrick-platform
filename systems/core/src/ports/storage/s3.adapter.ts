import {
  S3Client, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand, PutObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { imageSize } from 'image-size'
import type { AssetStoragePort, StoredObject, UploadTarget } from './storage.port.js'

export const UPLOAD_URL_TTL_SECONDS = 900
const HEADER_BYTES = 65_536

// Kept in sync with MAX_UPLOAD_BYTES in src/assets/image.service.ts (not
// imported directly: that module pulls in prisma.js and audit.js, and this
// low-level storage adapter has no business depending on the DB client or
// the service layer above it). Nothing this large should ever have been
// accepted at upload time; the check here is a second, independent guard so
// a corrupted or bypassed upload can't make stat() buffer an unbounded
// object into memory chasing dimensions it will never find.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024

export interface S3StorageConfig {
  bucket: string; region: string; accessKeyId: string; secretAccessKey: string
}

/**
 * Client construction options shared by the adapter's own S3Client and by
 * anything (tests included) that wants to build an equivalent client.
 *
 * requestChecksumCalculation defaults to 'WHEN_SUPPORTED' as of SDK 3.1141,
 * which makes every request -- including a presigned PUT nobody has sent a
 * body for yet -- carry an x-amz-checksum-crc32 / x-amz-sdk-checksum-algorithm
 * pair computed over an EMPTY body. A real upload's body then fails that
 * checksum and S3 rejects it with BadDigest. 'WHEN_REQUIRED' only adds a
 * checksum when a specific S3 API forces one, which PutObject does not.
 */
export function s3ClientOptions(config: S3StorageConfig) {
  return {
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED' as const,
  }
}

function dimensions(buf: Uint8Array): { width: number; height: number } | null {
  try {
    const d = imageSize(buf)
    return d.width && d.height ? { width: d.width, height: d.height } : null
  } catch {
    return null
  }
}

const isNotFound = (e: any) => e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404

/**
 * Private S3 bucket behind imgix (ADR-0002, decided 2026-09-25).
 *
 * stat() reads size and type from HEAD, then only the first 64 KB to find the
 * true dimensions. It never downloads a whole 15 MB photo unless the header
 * is somehow beyond that, which is the fallback. Bytes image-size cannot parse
 * report 0x0, and confirm rejects that as not_an_image.
 */
export function createS3StoragePort(config: S3StorageConfig, client?: S3Client): AssetStoragePort {
  const s3 = client ?? new S3Client(s3ClientOptions(config))
  const Bucket = config.bucket

  async function readBytes(Key: string, Range?: string): Promise<Uint8Array> {
    const res = await s3.send(new GetObjectCommand({ Bucket, Key, ...(Range ? { Range } : {}) }))
    return res.Body ? await (res.Body as any).transformToByteArray() : new Uint8Array()
  }

  return {
    async createUploadTarget(key: string, contentType: string): Promise<UploadTarget> {
      const uploadUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }),
        { expiresIn: UPLOAD_URL_TTL_SECONDS, signableHeaders: new Set(['content-type']) },
      )
      return { uploadUrl, expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000) }
    },

    async stat(key: string): Promise<StoredObject | null> {
      let head
      try {
        head = await s3.send(new HeadObjectCommand({ Bucket, Key: key }))
      } catch (e) {
        if (isNotFound(e)) return null
        throw e
      }
      const byteSize = head.ContentLength ?? 0
      let dims: { width: number; height: number } | null = null
      // A zero-byte object has no header to range over -- S3 answers a
      // 0-byte GET's Range request with 416 Range Not Satisfiable, not an
      // empty body, so skip straight to reporting 0x0 rather than sending a
      // request guaranteed to fail.
      if (byteSize > 0) {
        dims = dimensions(await readBytes(key, `bytes=0-${HEADER_BYTES - 1}`))
        // Only fall back to a full read within the same cap enforced at
        // upload time (image.service.ts's MAX_UPLOAD_BYTES) -- a presigned
        // PUT cannot itself cap the object size, so without this an object
        // larger than that, uploaded some other way, would make this method
        // buffer the whole thing into memory chasing dimensions a corrupt or
        // non-image object will never yield.
        if (!dims && byteSize > HEADER_BYTES && byteSize <= MAX_UPLOAD_BYTES) {
          dims = dimensions(await readBytes(key))
        }
      }
      return {
        width: dims?.width ?? 0,
        height: dims?.height ?? 0,
        byteSize,
        contentType: head.ContentType ?? 'application/octet-stream',
      }
    },

    async delete(key: string): Promise<void> {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket, Key: key }))
      } catch (e) {
        if (!isNotFound(e)) throw e
      }
    },
  }
}
