export function PageHeader({
  eyebrow,
  title,
  intro,
}: {
  eyebrow: string
  title: string
  intro?: string
}) {
  return (
    <header className="max-w-3xl">
      <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
        {eyebrow}
      </span>
      <h1
        className="text-4xl sm:text-5xl font-black uppercase tracking-[0.05em] text-foreground"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        {title}
      </h1>
      {intro && <p className="mt-5 text-sm text-muted-foreground leading-relaxed">{intro}</p>}
    </header>
  )
}
