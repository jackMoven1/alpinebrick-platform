import type { InputHTMLAttributes } from 'react'

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  id: string
  label: string
  error?: string
}

export function Input({ id, label, error, className = '', ...rest }: InputProps) {
  const errorId = `${id}-error`
  const describedBy = error ? errorId : undefined
  return (
    <div>
      <label
        htmlFor={id}
        className="block text-xs font-semibold uppercase tracking-[0.12em] text-foreground"
      >
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={describedBy}
        // --input-background (#1e1e1e) is a distinct surface from the page
        // background; inputs sit on it so the field edge reads without a shadow.
        className={`mt-2 block w-full rounded-md border border-border bg-[var(--input-background)] px-3 py-2 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${className}`.trim()}
        {...rest}
      />
      {error ? (
        <p id={errorId} role="alert" className="mt-1.5 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
