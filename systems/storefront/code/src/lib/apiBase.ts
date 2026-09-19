/**
 * Empty by default, so every request resolves against the storefront's own
 * origin -- which is what the Vite dev proxy expects (vite.config.ts proxies
 * /api to core on localhost:4000) and preserves today's behaviour exactly.
 *
 * The storefront is deployed on its own domain, unrelated to core's
 * (`www.alpinebrickexchange.com` vs `api.alpinebrickexchange.com`) -- a
 * relative path there resolves against the storefront's own static host,
 * which matches the SPA fallback rewrite in render.yaml (`source: /*` ->
 * `/index.html`) and returns the storefront's own HTML where JSON is
 * expected. Set VITE_API_BASE_URL to core's absolute origin so `catalog.ts`
 * resolves its BASE against it instead.
 *
 * Mirrors systems/admin-ui/src/lib/apiBase.js exactly: empty default,
 * trailing slash stripped so joining never doubles a separator. Same shape
 * as VITE_ASSET_BASE_URL in systems/storefront/code/src/lib/images.ts.
 */
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '')
