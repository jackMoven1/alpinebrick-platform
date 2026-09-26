import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { mockClient } from 'aws-sdk-client-mock'
import { sdkStreamMixin } from '@smithy/util-stream'
import {
  S3Client, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand, NotFound,
} from '@aws-sdk/client-s3'
import { createS3StoragePort, s3ClientOptions, UPLOAD_URL_TTL_SECONDS } from '../src/ports/storage/s3.adapter.js'

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
  return createS3StoragePort(CONFIG, new S3Client(s3ClientOptions(CONFIG)))
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

  it('never asks the client to add a request checksum, so a real PUT is not rejected with BadDigest', async () => {
    // Deliberately NOT passing an injected client here -- this exercises the
    // adapter's own S3Client construction (createS3StoragePort(CONFIG) with
    // no second argument), which is what proves requestChecksumCalculation
    // is actually wired into the client the adapter builds, not just into a
    // client the test happens to construct correctly on its own.
    const uncachedPort = createS3StoragePort(CONFIG)
    const t = await uncachedPort.createUploadTarget('products/p1/i1/original.png', 'image/png')
    const url = new URL(t.uploadUrl)
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type')
    for (const key of url.searchParams.keys()) {
      expect(key.toLowerCase()).not.toMatch(/^x-amz-checksum-/)
      expect(key.toLowerCase()).not.toBe('x-amz-sdk-checksum-algorithm')
    }
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

  // Ruling R2a: only NotFound means "no object". An auth or permission error
  // must surface, or a wrong bucket/credential would read as "nothing uploaded".
  it('propagates a non-NotFound HEAD error from stat() instead of returning null', async () => {
    const denied = Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })
    s3.on(HeadObjectCommand).rejects(denied)
    await expect(port().stat('products/p1/i1/original.png')).rejects.toMatchObject({ name: 'AccessDenied' })
  })

  it('reports 0x0 for bytes that are not an image', async () => {
    const junk = Buffer.from('definitely not an image')
    s3.on(HeadObjectCommand).resolves({ ContentLength: junk.length, ContentType: 'image/png' })
    s3.on(GetObjectCommand).resolves({ Body: body(junk) as any })
    expect(await port().stat('k')).toMatchObject({ width: 0, height: 0 })
  })

  it('falls back to a full GET when the header is unparseable and the object is within the upload cap', async () => {
    // Bigger than HEADER_BYTES so the first ranged read alone cannot have
    // seen the whole object -- that is what makes a second, unranged GET
    // meaningful (and distinguishable from the small-file case below, where
    // the first read already covered everything).
    const junk = Buffer.alloc(70_000, 0x41)
    s3.on(HeadObjectCommand).resolves({ ContentLength: junk.length, ContentType: 'image/png' })
    // A fresh stream per call -- the mocked SDK response is read via
    // transformToByteArray(), which can only run once per stream instance,
    // so reusing a single .resolves() value across two GetObjectCommand
    // calls would itself throw "The stream has already been transformed."
    s3.on(GetObjectCommand).callsFake(() => ({ Body: body(junk) as any }))
    const st = await port().stat('k')
    expect(st).toMatchObject({ width: 0, height: 0, byteSize: junk.length })
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(2)
    expect(s3.commandCalls(GetObjectCommand)[0].args[0].input.Range).toBe('bytes=0-65535')
    expect(s3.commandCalls(GetObjectCommand)[1].args[0].input.Range).toBeUndefined()
  })

  it('does not fall back to a full GET when the object is over the 15 MB upload cap', async () => {
    const junk = Buffer.from('definitely not an image')
    const OVER_CAP = 15 * 1024 * 1024 + 1
    s3.on(HeadObjectCommand).resolves({ ContentLength: OVER_CAP, ContentType: 'image/png' })
    s3.on(GetObjectCommand).resolves({ Body: body(junk) as any })
    const st = await port().stat('k')
    expect(st).toMatchObject({ width: 0, height: 0, byteSize: OVER_CAP })
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(1)
  })

  it('skips the ranged GET entirely for a zero-byte object', async () => {
    s3.on(HeadObjectCommand).resolves({ ContentLength: 0, ContentType: 'image/png' })
    const st = await port().stat('k')
    expect(st).toEqual({ width: 0, height: 0, byteSize: 0, contentType: 'image/png' })
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(0)
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
