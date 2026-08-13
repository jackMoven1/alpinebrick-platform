import { prisma } from '../../src/prisma.js'

export async function resetDb() {
  // Order matters: children before parents.
  await prisma.auditLog.deleteMany()
  await prisma.orderLine.deleteMany()
  await prisma.order.deleteMany()
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
}
