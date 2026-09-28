import { createHmac, timingSafeEqual } from 'node:crypto'
import { WebhookSignatureError } from './payments.port.js'

/**
 * Square's scheme (https://developer.squareup.com/docs/webhooks/step3validate):
 * base64 HMAC-SHA256, keyed with the subscription's signature key, over the
 * notification URL followed by the raw request body. Computed over bytes, so
 * the body is never re-encoded.
 */
export function squareSignature(notificationUrl: string, rawBody: Buffer, signatureKey: string): string {
  return createHmac('sha256', signatureKey)
    .update(Buffer.concat([Buffer.from(notificationUrl, 'utf8'), rawBody]))
    .digest('base64')
}

/**
 * Constant-time check (plan decision 1): square@46.0.0's
 * WebhooksHelper.verifySignature compares with ===. `notificationUrl` comes
 * from config, never from request headers (spec §3) -- behind Render's proxy
 * a URL rebuilt from the request would not be the one Square signed.
 */
export function verifySquareSignature(rawBody: Buffer, signature: string, signatureKey: string, notificationUrl: string): void {
  const expected = Buffer.from(squareSignature(notificationUrl, rawBody, signatureKey), 'utf8')
  const given = Buffer.from(signature, 'utf8')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new WebhookSignatureError()
}
