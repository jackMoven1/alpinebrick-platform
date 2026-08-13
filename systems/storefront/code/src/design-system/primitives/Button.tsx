import type { ButtonHTMLAttributes } from 'react'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary'
}

export function Button({ variant = 'primary', className = '', ...rest }: ButtonProps) {
  const base =
    'inline-flex items-center justify-center rounded-md px-5 py-2.5 text-xs font-semibold uppercase tracking-[0.12em] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50'
  const variants: Record<NonNullable<ButtonProps['variant']>, string> = {
    primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
    secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/90',
  }
  return (
    <button
      type="button"
      className={`${base} ${variants[variant]} ${className}`.trim()}
      {...rest}
    />
  )
}
