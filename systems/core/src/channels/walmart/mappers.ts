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
 * dollars (Walmart's `amount`/`price` fields). Mirrors `toCents` in the
 * other direction; every outbound payload builder in this file calls this
 * instead of dividing inline.
 *
 * Built on BigInt integer arithmetic and a single string->Number parse
 * rather than `cents / 100` -- not because the division is wrong (it isn't:
 * both paths round the same exact rational to the same double, always, for
 * any integer `cents`), but so correctness doesn't rest on that fact staying
 * true unnoticed. The integer check below is the part that earns its keep.
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
        price: centsToDollars(i.priceCents),
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
