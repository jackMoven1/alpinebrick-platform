import type { ReactNode } from 'react'

type BadgeProps = {
  children: ReactNode
  tone?: 'primary' | 'accent'
}

export function Badge({ children, tone = 'primary' }: BadgeProps) {
  const tones: Record<NonNullable<BadgeProps['tone']>, string> = {
    primary: 'bg-primary text-primary-foreground',
    accent: 'bg-muted text-accent',
  }
  return (
    <span
      className={`inline-block px-2.5 py-1 text-xs font-bold uppercase tracking-[0.12em] ${tones[tone]}`}
    >
      {children}
    </span>
  )
}
