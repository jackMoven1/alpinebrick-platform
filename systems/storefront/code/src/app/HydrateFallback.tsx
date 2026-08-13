/**
 * Rendered while route loaders resolve on the very first load.
 *
 * React Router v7 data routers treat the initial render as hydration. Without a
 * HydrateFallback the router renders NOTHING until every loader settles — a
 * blank page for the user, and a router that never paints in tests.
 */
export default function HydrateFallback() {
  return (
    <div
      className="min-h-[60vh] grid place-items-center"
      role="status"
      aria-live="polite"
    >
      <span className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        Loading…
      </span>
    </div>
  )
}
