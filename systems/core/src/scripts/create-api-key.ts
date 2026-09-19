import { pathToFileURL } from 'node:url'
import { createApiKey } from '../auth/apikey.service.js'
import { prisma } from '../prisma.js'

export type ParsedExpiresDays =
  | { ok: true; value: number | null }
  | { ok: false; message: string }

/** Ten years. Generous for the legitimate cases (a long-lived MCP connector
 * key), and comfortably inside `Date`'s representable range, so nothing
 * accepted here can make the arithmetic below overflow. */
const MAX_EXPIRES_DAYS = 3650

/**
 * `expires-days` is optional -- omitted means "never expires" -- but when
 * given it must be a positive integer, not too large, and precise.
 *
 * Rejects: non-numeric input (`NaN`); non-integers; zero and negatives (a
 * negative is valid arithmetic, so without this check `createApiKey` would
 * silently mint an already-expired key -- the operator sees "API key
 * created" and a plausible-looking timestamp, and only discovers the
 * problem later as an unexplained 401); values beyond
 * `Number.MAX_SAFE_INTEGER`, where integer arithmetic stops being exact; and
 * anything above `MAX_EXPIRES_DAYS`. That last one matters because a large
 * but finite, perfectly integer, perfectly positive day count still
 * overflows `Date`'s representable range once multiplied out
 * (`Date.now() + n * 86_400_000`), producing an `Invalid Date` that reaches
 * Prisma and throws -- the exact raw-stack-trace failure this validation
 * exists to prevent, arrived at through a different input than the
 * non-numeric case. All of these are rejected here, before `createApiKey`
 * is ever called, with a one-line usage error instead of a thrown
 * exception.
 */
export function parseExpiresDays(raw: string | undefined): ParsedExpiresDays {
  if (raw === undefined) return { ok: true, value: null }
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n <= 0 || n > MAX_EXPIRES_DAYS) {
    return {
      ok: false,
      message: `expires-days must be a positive integer no greater than ${MAX_EXPIRES_DAYS}`,
    }
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
