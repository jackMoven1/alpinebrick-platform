import {
  S3Client, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand, PutObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { imageSize } from 'image-size'
import type { AssetStoragePort, StoredObject, UploadTarget } from './storage.port.js'

export const UPLOAD_URL_TTL_SECONDS = 900
const HEADER_BYTES = 65_536

export interface S3StorageConfig {
  bucket: string; region: string; accessKeyId: string; secretAccessKey: string
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
  const s3 = client ?? new S3Client({
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  })
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
      let dims = dimensions(await readBytes(key, `bytes=0-${HEADER_BYTES - 1}`))
      if (!dims && byteSize > HEADER_BYTES) dims = dimensions(await readBytes(key))
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
