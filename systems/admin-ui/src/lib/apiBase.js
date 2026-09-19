/**
 * Empty by default, so every request resolves against the console's own
 * origin -- which is what the Vite dev proxy expects (vite.config.js proxies
 * /api to core on localhost:4000) and preserves today's behaviour exactly.
 *
 * The console is deployed on its own domain, unrelated to core's
 * (`alpinebrick-admin.onrender.com` per spec §6.1) -- a relative path there
 * resolves against the console's own static host, which serves neither
 * `/api/v1/admin` nor `/api/v1/auth`. Set VITE_API_BASE_URL to core's
 * absolute origin (e.g. https://api.alpinebrickexchange.com) once the
 * console is deployed cross-origin.
 *
 * Same shape as VITE_ASSET_BASE_URL in systems/storefront/code/src/lib/images.ts
 * and systems/admin-ui/src/lib/imageUrl.js: empty default, trailing slash
 * stripped so joining never doubles a separator.
 */
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '')
