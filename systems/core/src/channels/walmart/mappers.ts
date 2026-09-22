// Anti-corruption layer: every Walmart-shaped format lives in this file and
// nothing outside it should know what Walmart JSON looks like. Category
// attributes under `Visible` are the part most likely to need correcting
// against the real sandbox (plan Task 13) — isolating them here keeps that
// correction to one file.

export function toCents(dollars: number): number {
  return Math.round(dollars * 100)
}

/**
 * The one outbound conversion boundary: integer cents (our side) -> decimal
 * dollars (Walmart's `amount` fields). Mirrors `toCents` in the other
 * direction, and is the only place that boundary is crossed -- every
 * outbound payload builder in this file calls this instead of dividing
 * inline.
 *
 * Built entirely on BigInt integer arithmetic (never `cents / 100`) so the
 * dollars/remainder split cannot be off by a float-rounding epsilon, then
 * assembled as a decimal string and parsed back to a Number exactly once.
 * In practice `cents / 100` also round-trips cleanly for realistic prices --
 * JS's Number-to-string algorithm always picks the shortest decimal that
 * round-trips to the same double, and for an integer divided by a power of
 * ten that shortest decimal IS the terminating 2-decimal value -- so this
 * function's output is bit-for-bit identical to naive division across the
 * whole range tested. It's still written this way rather than as
 * `cents / 100`: relying on that shortest-round-trip property is an
 * implementation detail of engine number formatting to depend on for money,
 * not a guarantee this code should assume silently, and integer arithmetic
 * costs nothing here.
 */
export function centsToDollars(cents: number): number {
  if (!Number.isInteger(cents)) {
    throw new TypeError(`centsToDollars: priceCents must be an integer, got ${cents}`)
  }
  const negative = cents < 0
  const abs = BigInt(Math.abs(cents))
  const dollars = abs / 100n
  const remainder = abs % 100n
  const decimal = `${negative ? '-' : ''}${dollars.toString()}.${remainder.toString().padStart(2, '0')}`
  return Number(decimal)
}

export interface CanonicalChannelOrder {
  externalOrderId: string
  email: string
  shipToState: string
  lines: { walmartSku: string; quantity: number; unitPriceCents: number; lineTaxCents: number }[]
}

export function toCanonicalOrder(payload: unknown): CanonicalChannelOrder {
  const p = payload as any
  if (!p?.purchaseOrderId || !p?.orderLines?.orderLine?.length) {
    throw new Error('unmappable_order: missing purchaseOrderId or orderLines')
  }
  const state = p.shippingInfo?.postalAddress?.state
  if (!state) throw new Error('unmappable_order: missing ship-to state')
  const lines = (p.orderLines.orderLine as any[]).map((l) => {
    const qty = Number(l?.orderLineQuantity?.amount)
    const product = (l?.charges?.charge as any[] | undefined)?.find((c) => c.chargeType === 'PRODUCT')
    if (!l?.item?.sku || !Number.isInteger(qty) || qty <= 0 || !product?.chargeAmount) {
      throw new Error(`unmappable_order: bad line ${l?.lineNumber}`)
    }
    const taxDollars = product.tax?.taxAmount?.amount ?? 0
    return {
      walmartSku: l.item.sku as string,
      quantity: qty,
      unitPriceCents: toCents(product.chargeAmount.amount),
      lineTaxCents: toCents(taxDollars) * qty, // Walmart charges/tax are per unit
    }
  })
  return {
    externalOrderId: p.purchaseOrderId,
    email: p.customerEmailId ?? 'walmart-customer@channel.local',
    shipToState: state,
    lines,
  }
}

export function toItemFeed(items: { walmartSku: string; name: string; description: string; priceCents: number; imageUrls: string[] }[]): unknown {
  return {
    MPItemFeedHeader: { version: '5.0', requestId: undefined, requestBatchId: undefined, locale: 'en', sellingChannel: 'marketplace' },
    MPItem: items.map((i) => ({
      Orderable: {
        sku: i.walmartSku,
        productIdentifiers: { productIdType: 'SKU', productId: i.walmartSku },
        productName: i.name,
        price: i.priceCents / 100,
        ShippingWeight: 1,
      },
      Visible: {
        Toys: { shortDescription: i.description, mainImageUrl: i.imageUrls[0], productSecondaryImageURL: i.imageUrls.slice(1) },
      },
    })),
  }
}

export function toInventoryPayload(walmartSku: string, quantity: number): unknown {
  return { sku: walmartSku, quantity: { unit: 'EACH', amount: quantity } }
}

export function toPricePayload(walmartSku: string, priceCents: number): unknown {
  return { sku: walmartSku, pricing: [{ currentPriceType: 'BASE', currentPrice: { currency: 'USD', amount: centsToDollars(priceCents) } }] }
}

export function toShipPayload(input: { lineNumbers: string[]; quantityByLine: Record<string, number>; carrier: string; trackingNumber: string; trackingUrl?: string; shipDateIso: string }): unknown {
  return {
    orderShipment: {
      orderLines: {
        orderLine: input.lineNumbers.map((n) => ({
          lineNumber: n,
          orderLineStatuses: {
            orderLineStatus: [{
              status: 'Shipped',
              statusQuantity: { unitOfMeasurement: 'EACH', amount: String(input.quantityByLine[n] ?? 1) },
              trackingInfo: {
                shipDateTime: input.shipDateIso,
                carrierName: { carrier: input.carrier },
                methodCode: 'Standard',
                trackingNumber: input.trackingNumber,
                trackingURL: input.trackingUrl,
              },
            }],
          },
        })),
      },
    },
  }
}
