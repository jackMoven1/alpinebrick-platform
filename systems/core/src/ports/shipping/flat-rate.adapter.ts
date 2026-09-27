import type { ShippingPort } from './shipping.port.js'
import { getShopSettings, type ShopSettings } from '../../settings/shop-settings.service.js'

/** $X per order, free at or above the threshold (both from ShopSetting). */
export function createFlatRateShippingPort(
  readSettings: () => Promise<ShopSettings> = () => getShopSettings(),
): ShippingPort {
  return {
    async quote({ subtotalCents }) {
      const s = await readSettings()
      if (s.freeThresholdCents !== null && subtotalCents >= s.freeThresholdCents) {
        return [{ displayName: 'Free shipping', amountCents: 0 }]
      }
      return [{ displayName: 'Standard shipping', amountCents: s.flatRateCents }]
    },
  }
}
