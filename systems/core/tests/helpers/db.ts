import { prisma } from '../../src/prisma.js'

export async function resetDb() {
  // Order matters: children before parents.
  await prisma.auditLog.deleteMany()
  await prisma.orderLine.deleteMany()
  await prisma.order.deleteMany()
  await prisma.inventory.deleteMany()
  await prisma.variant.deleteMany()
  await prisma.product.deleteMany()
  await prisma.actor.deleteMany()
}
