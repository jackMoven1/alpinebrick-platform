import { pathToFileURL } from 'node:url'
import { createApiKey } from '../auth/apikey.service.js'
import { prisma } from '../prisma.js'

export type ParsedExpiresDays =
  | { ok: true; value: number | null }
  | { ok: false; message: string }

/**
 * `expires-days` is optional -- omitted means "never expires" -- but when
 * given it must be a positive integer.
 *
 * A non-numeric value (or one large enough to overflow `Date`) becomes
 * `NaN`/`Invalid Date`, which at least fails loudly once it reaches Prisma.
 * A negative value does not: it is perfectly valid arithmetic, so without
 * this check `createApiKey` silently mints a key that is already expired.
 * The operator sees "API key created" and a plausible-looking timestamp, and
 * only discovers the problem later as an unexplained 401. Reject both
 * classes here, before `createApiKey` is ever called, with a one-line usage
 * error instead of letting either turn into a thrown exception.
 */
export function parseExpiresDays(raw: string | undefined): ParsedExpiresDays {
  if (raw === undefined) return { ok: true, value: null }
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, message: 'expires-days must be a positive integer' }
  }
  return { ok: true, value: n }
}

async function main() {
  const [actorName, keyName, expiresDays] = process.argv.slice(2)
  if (!actorName || !keyName) {
    console.error('usage: npm run create-api-key -- <actor-name> <key-name> [expires-days]')
    process.exit(1)
  }

  const parsed = parseExpiresDays(expiresDays)
  if (!parsed.ok) {
    console.error(`usage: ${parsed.message}`)
    process.exit(1)
  }

  const expiresAt = parsed.value !== null
    ? new Date(Date.now() + parsed.value * 86_400_000)
    : null

  const { plaintext, id } = await createApiKey({ actorName, keyName, expiresAt })

  console.log('')
  console.log('  API key created. This is the ONLY time the secret is shown.')
  console.log(`  id:      ${id}`)
  console.log(`  actor:   ${actorName}`)
  console.log(`  expires: ${expiresAt ? expiresAt.toISOString() : 'never'}`)
  console.log('')
  console.log(`  ${plaintext}`)
  console.log('')
  await prisma.$disconnect()
}

// Only run the CLI when this file is executed directly (tsx/node), not when
// it is imported -- by the test suite, for parseExpiresDays -- as a module.
const isMainModule = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMainModule) {
  main().catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
}
