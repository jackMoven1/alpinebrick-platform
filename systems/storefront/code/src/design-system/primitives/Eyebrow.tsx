import type { ReactNode } from 'react'

type EyebrowProps = {
  children: ReactNode
  className?: string
}

export function Eyebrow({ children, className = '' }: EyebrowProps) {
  return (
    <span
      className={`text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground ${className}`.trim()}
    >
      {children}
    </span>
  )
}
