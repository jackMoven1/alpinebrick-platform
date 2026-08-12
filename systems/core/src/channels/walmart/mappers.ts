// Anti-corruption layer: every Walmart-shaped format lives in this file and
// nothing outside it should know what Walmart JSON looks like. Category
// attributes under `Visible` are the part most likely to need correcting
// against the real sandbox (plan Task 13) — isolating them here keeps that
// correction to one file.

export function toCents(dollars: number): number {
  return Math.round(dollars * 100)
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
  return { sku: walmartSku, pricing: [{ currentPriceType: 'BASE', currentPrice: { currency: 'USD', amount: priceCents / 100 } }] }
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
