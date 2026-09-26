import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { mockClient } from 'aws-sdk-client-mock'
import { sdkStreamMixin } from '@smithy/util-stream'
import {
  S3Client, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand, NotFound,
} from '@aws-sdk/client-s3'
import { createS3StoragePort, UPLOAD_URL_TTL_SECONDS } from '../src/ports/storage/s3.adapter.js'

// A 1x1 PNG, the same fixture storage-local-adapter.test.ts uses.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const CONFIG = { bucket: 'test-bucket', region: 'us-west-2', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test' }
const body = (buf: Buffer) => sdkStreamMixin(Readable.from([buf]))

const s3 = mockClient(S3Client)
beforeEach(() => s3.reset())

function port() {
  return createS3StoragePort(CONFIG, new S3Client({ region: CONFIG.region, credentials: CONFIG }))
}

describe('S3 storage adapter', () => {
  it('presigns a PUT for exactly the key and content type, expiring in 15 minutes', async () => {
    const before = Date.now()
    const t = await port().createUploadTarget('products/p1/i1/original.png', 'image/png')
    const url = new URL(t.uploadUrl)
    expect(url.hostname).toContain('test-bucket')
    expect(url.pathname).toBe('/products/p1/i1/original.png')
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(UPLOAD_URL_TTL_SECONDS))
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type')
    expect(t.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 899_000)
    expect(UPLOAD_URL_TTL_SECONDS).toBe(900)
  })

  it('stats size and type from HEAD and true dimensions from a ranged GET', async () => {
    s3.on(HeadObjectCommand).resolves({ ContentLength: PNG_1X1.length, ContentType: 'image/png' })
    s3.on(GetObjectCommand).resolves({ Body: body(PNG_1X1) as any })
    const st = await port().stat('products/p1/i1/original.png')
    expect(st).toEqual({ width: 1, height: 1, byteSize: PNG_1X1.length, contentType: 'image/png' })
    const get = s3.commandCalls(GetObjectCommand)[0].args[0].input
    expect(get.Range).toBe('bytes=0-65535')
  })

  it('returns null for a missing object', async () => {
    s3.on(HeadObjectCommand).rejects(new NotFound({ message: 'nf', $metadata: {} }))
    expect(await port().stat('missing')).toBeNull()
  })

  it('reports 0x0 for bytes that are not an image', async () => {
    const junk = Buffer.from('definitely not an image')
    s3.on(HeadObjectCommand).resolves({ ContentLength: junk.length, ContentType: 'image/png' })
    s3.on(GetObjectCommand).resolves({ Body: body(junk) as any })
    expect(await port().stat('k')).toMatchObject({ width: 0, height: 0 })
  })

  it('deletes, and treats an absent object as success', async () => {
    s3.on(DeleteObjectCommand).resolves({})
    await port().delete('k')
    expect(s3.commandCalls(DeleteObjectCommand)[0].args[0].input).toEqual({ Bucket: 'test-bucket', Key: 'k' })
  })

  it('surfaces other delete errors', async () => {
    s3.on(DeleteObjectCommand).rejects(new Error('AccessDenied'))
    await expect(port().delete('k')).rejects.toThrow('AccessDenied')
  })
})
