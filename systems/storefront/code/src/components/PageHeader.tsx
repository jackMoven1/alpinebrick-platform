import type { Ref } from 'react'

export function PageHeader({
  eyebrow,
  title,
  intro,
  headingRef,
}: {
  eyebrow: string
  title: string
  intro?: string
  /** For moving focus to the heading (it then takes tabIndex -1). */
  headingRef?: Ref<HTMLHeadingElement>
}) {
  return (
    <header className="max-w-3xl">
      <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
        {eyebrow}
      </span>
      <h1
        ref={headingRef}
        tabIndex={headingRef ? -1 : undefined}
        className="text-4xl sm:text-5xl font-black uppercase tracking-[0.05em] text-foreground"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        {title}
      </h1>
      {intro && <p className="mt-5 text-sm text-muted-foreground leading-relaxed">{intro}</p>}
    </header>
  )
}
