import type { ReactNode } from 'react'

type CardProps = {
  children: ReactNode
  className?: string
}

export function Card({ children, className = '' }: CardProps) {
  return (
    <div
      className={`bg-card border border-border p-6 ${className}`.trim()}
    >
      {children}
    </div>
  )
}
