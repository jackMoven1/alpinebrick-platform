/** Shop setting keys (spec 2026-09-27 §3). The migration seeds these rows. */
export const SETTING_KEYS = {
  flatRateCents: 'shipping.flat_rate_cents',
  freeThresholdCents: 'shipping.free_threshold_cents',
  sessionMinutes: 'checkout.session_minutes',
} as const

/** Must match the INSERT in migration 20260927120000_revenue_loop_checkout. */
export const SHOP_SETTING_DEFAULTS: Readonly<Record<string, number | null>> = {
  'shipping.flat_rate_cents': 995,
  'shipping.free_threshold_cents': 15000,
  'checkout.session_minutes': 30,
}
