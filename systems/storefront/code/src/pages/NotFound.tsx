import { Link } from 'react-router'

export default function NotFound() {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-32 text-center">
      <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
        404
      </span>
      <h1
        className="text-4xl sm:text-5xl font-black uppercase tracking-[0.05em] text-foreground"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        Page not found
      </h1>
      <p className="mt-5 text-sm text-muted-foreground">
        That page does not exist, or the set has been retired.
      </p>
      <Link
        to="/"
        className="inline-flex items-center justify-center mt-10 px-6 py-3 text-xs font-semibold uppercase tracking-[0.16em] rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        Back to the catalogue
      </Link>
    </div>
  )
}
