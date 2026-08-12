import { prisma } from '../prisma.js'
import { recordAudit } from '../audit.js'
import type { TaxPort } from '../ports/tax/tax.port.js'
import { createFlatRateTaxPort } from '../ports/tax/flat-rate.adapter.js'

export class OrderError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'OrderError'
  }
}

export interface OrderLineDto {
  variantId: string
  sku: string
  quantity: number
  unitPriceCents: number
  lineSubtotalCents: number
  discountCents: number
}

export interface OrderDto {
  id: string
  orderNumber: string
  status: string
  email: string
  shipToState: string
  subtotalCents: number
  discountCents: number
  taxCents: number
  totalCents: number
  taxRateBps: number
  taxJurisdiction: string
  lines: OrderLineDto[]
}

export interface PlaceOrderInput {
  email: string
  shipToState: string
  lines: { variantId: string; quantity: number }[]
  actorId?: string
}

const defaultTaxPort = createFlatRateTaxPort()

export function orderNumber(n: number): string {
  return `ABE-${String(n).padStart(6, '0')}`
}

function toDto(o: any): OrderDto {
  return {
    id: o.id,
    orderNumber: orderNumber(o.number),
    status: o.status,
    email: o.email,
    shipToState: o.shipToState,
    subtotalCents: o.subtotalCents,
    discountCents: o.discountCents,
    taxCents: o.taxCents,
    totalCents: o.totalCents,
    taxRateBps: o.taxRateBps,
    taxJurisdiction: o.taxJurisdiction,
    lines: o.lines.map((l: any) => ({
      variantId: l.variantId, sku: l.sku, quantity: l.quantity,
      unitPriceCents: l.unitPriceCents, lineSubtotalCents: l.lineSubtotalCents,
      discountCents: l.discountCents,
    })),
  }
}

export async function placeOrder(input: PlaceOrderInput, taxPort: TaxPort = defaultTaxPort): Promise<OrderDto> {
  if (input.lines.length === 0) throw new OrderError('empty_order', 'order must have at least one line')
  const actorId = input.actorId ?? 'system'

  const order = await prisma.$transaction(async (tx) => {
    // 1. Resolve every line against a published variant; snapshot price + sku.
    const resolved: { variantId: string; sku: string; quantity: number; unitPriceCents: number }[] = []
    for (const line of input.lines) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new OrderError('invalid_quantity', `quantity must be a positive integer for variant ${line.variantId}`)
      }
      const variant = await tx.variant.findFirst({
        where: { id: line.variantId, product: { status: 'published' } },
      })
      if (!variant) throw new OrderError('variant_not_found', `no published variant ${line.variantId}`)
      resolved.push({ variantId: variant.id, sku: variant.sku, quantity: line.quantity, unitPriceCents: variant.priceCents })
    }

    // 2. Reserve each line atomically: only reserve if enough is available RIGHT NOW.
    for (const line of resolved) {
      const affected = await tx.$executeRaw`
        UPDATE inventory SET reserved = reserved + ${line.quantity}
        WHERE variant_id = ${line.variantId} AND on_hand - reserved >= ${line.quantity}`
      if (affected === 0) throw new OrderError('insufficient_stock', `not enough stock for variant ${line.variantId}`)
    }

    // 3. Compute money from the snapshot; tax comes from the port.
    //    Tax base is the DISCOUNTED subtotal (Jack, 2026-08-11 — see Task 2), so
    //    each amountCents passed to the port must be net of that line's discount.
    //    This plan has no discount input, so every discount is 0 and the
    //    arithmetic is identical; the shape is written the correct way so the plan
    //    that introduces discounts changes values, not structure.
    const subtotalCents = resolved.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0)
    const discountCents = 0
    const tax = await taxPort.computeTax({
      shipToState: input.shipToState,
      // When discounts exist, subtract that line's discountCents here.
      lineItems: resolved.map((l) => ({ amountCents: l.unitPriceCents * l.quantity })),
    })

    return tx.order.create({
      data: {
        email: input.email,
        shipToState: input.shipToState.trim().toUpperCase(),
        status: 'pending',
        subtotalCents,
        discountCents,
        taxCents: tax.taxCents,
        totalCents: subtotalCents - discountCents + tax.taxCents,
        taxRateBps: tax.rateBps,
        taxJurisdiction: tax.jurisdiction,
        lines: {
          create: resolved.map((l) => ({
            variantId: l.variantId, sku: l.sku, quantity: l.quantity,
            unitPriceCents: l.unitPriceCents, lineSubtotalCents: l.unitPriceCents * l.quantity,
          })),
        },
      },
      include: { lines: true },
    })
  })

  await recordAudit({
    actorId, action: 'order.place', target: `order:${order.id}`,
    after: { status: order.status, totalCents: order.totalCents },
  })
  return toDto(order)
}

export async function getOrder(id: string): Promise<OrderDto | null> {
  const o = await prisma.order.findUnique({ where: { id }, include: { lines: true } })
  return o ? toDto(o) : null
}

async function loadOrderForUpdate(tx: any, orderId: string) {
  const order = await tx.order.findUnique({ where: { id: orderId }, include: { lines: true } })
  if (!order) throw new OrderError('order_not_found', `no order ${orderId}`)
  return order
}

export async function markOrderPaid(orderId: string, actorId = 'system'): Promise<OrderDto> {
  const updated = await prisma.$transaction(async (tx) => {
    const order = await loadOrderForUpdate(tx, orderId)
    if (order.status !== 'pending') {
      throw new OrderError('invalid_transition', `cannot mark ${order.status} order as paid`)
    }
    return tx.order.update({ where: { id: orderId }, data: { status: 'paid' }, include: { lines: true } })
  })
  await recordAudit({ actorId, action: 'order.paid', target: `order:${orderId}`, before: { status: 'pending' }, after: { status: 'paid' } })
  return toDto(updated)
}

export async function fulfillOrder(orderId: string, actorId = 'system'): Promise<OrderDto> {
  const updated = await prisma.$transaction(async (tx) => {
    const order = await loadOrderForUpdate(tx, orderId)
    if (order.status !== 'paid') {
      throw new OrderError('invalid_transition', `cannot fulfill a ${order.status} order`)
    }
    for (const line of order.lines) {
      const affected = await tx.$executeRaw`
        UPDATE inventory SET on_hand = on_hand - ${line.quantity}, reserved = reserved - ${line.quantity}
        WHERE variant_id = ${line.variantId} AND reserved >= ${line.quantity} AND on_hand >= ${line.quantity}`
      if (affected === 0) throw new OrderError('inventory_conflict', `cannot decrement stock for variant ${line.variantId}`)
    }
    return tx.order.update({ where: { id: orderId }, data: { status: 'fulfilled' }, include: { lines: true } })
  })
  await recordAudit({ actorId, action: 'order.fulfilled', target: `order:${orderId}`, before: { status: 'paid' }, after: { status: 'fulfilled' } })
  return toDto(updated)
}

export async function cancelOrder(orderId: string, actorId = 'system'): Promise<OrderDto> {
  const updated = await prisma.$transaction(async (tx) => {
    const order = await loadOrderForUpdate(tx, orderId)
    if (order.status !== 'pending' && order.status !== 'paid') {
      throw new OrderError('invalid_transition', `cannot cancel a ${order.status} order`)
    }
    for (const line of order.lines) {
      await tx.$executeRaw`
        UPDATE inventory SET reserved = reserved - ${line.quantity}
        WHERE variant_id = ${line.variantId} AND reserved >= ${line.quantity}`
    }
    return tx.order.update({ where: { id: orderId }, data: { status: 'cancelled' }, include: { lines: true } })
  })
  await recordAudit({ actorId, action: 'order.cancelled', target: `order:${orderId}`, after: { status: 'cancelled' } })
  return toDto(updated)
}
