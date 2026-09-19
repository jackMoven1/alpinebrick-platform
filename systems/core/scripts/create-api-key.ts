import { createApiKey } from '../src/auth/apikey.service.js'
import { prisma } from '../src/prisma.js'

async function main() {
  const [actorName, keyName, expiresDays] = process.argv.slice(2)
  if (!actorName || !keyName) {
    console.error('usage: npm run create-api-key -- <actor-name> <key-name> [expires-days]')
    process.exit(1)
  }
  const expiresAt = expiresDays
    ? new Date(Date.now() + Number(expiresDays) * 86_400_000)
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

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
