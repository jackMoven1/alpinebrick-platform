import { prisma } from '../../src/prisma.js'
import { SHOP_SETTING_DEFAULTS } from '../../src/settings/defaults.js'

export async function resetDb() {
  // Order matters: children before parents.
  await prisma.adminSession.deleteMany()
  await prisma.apiKey.deleteMany()
  await prisma.auditLog.deleteMany()
  await prisma.orderLine.deleteMany()
  await prisma.order.deleteMany()
  await prisma.stripeEvent.deleteMany()
  await prisma.customer.deleteMany()
  await prisma.referralCode.deleteMany()
  await prisma.affiliatePartner.deleteMany()
  await prisma.channelEvent.deleteMany()
  await prisma.channelJob.deleteMany()
  await prisma.channelFeed.deleteMany()
  await prisma.channelSettlement.deleteMany()
  await prisma.channelListing.deleteMany()
  await prisma.inventory.deleteMany()
  await prisma.image.deleteMany()
  await prisma.variant.deleteMany()
  await prisma.product.deleteMany()
  await prisma.actor.deleteMany()

  // Settings are seeded by the migration, not by tests -- restore rather than
  // delete, so a test that edits one cannot leak into the next file.
  for (const [key, value] of Object.entries(SHOP_SETTING_DEFAULTS)) {
    await prisma.shopSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }
}

// placeOrder / cancelOrder audit as actor 'system'. resetDb deletes every
// actor, so tests that exercise orders must put it back.
export async function ensureSystemActor() {
  await prisma.actor.upsert({
    where: { id: 'system' },
    create: { id: 'system', type: 'agent', name: 'system' },
    update: {},
  })
}
