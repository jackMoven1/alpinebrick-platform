import { useId, type ReactNode } from 'react'
import type { QuoteRequest } from '../../lib/api/checkout'
import { Button } from '../../design-system/primitives'

/** All 50 states + DC. AK and HI are offered so core can refuse them with the spec copy. */
export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const

export const EMPTY_QUOTE_REQUEST: QuoteRequest = {
  email: '', name: '', address: { line1: '', line2: '', city: '', state: '', postalCode: '' },
}

/** The fields core can name in CheckoutError.field, as core spells them. */
export type AddressField = 'email' | 'name' | 'address.line1' | 'address.line2' | 'address.city' | 'address.state' | 'address.postalCode'
export type FieldErrors = Partial<Record<AddressField, string>>

const input = 'w-full rounded-md border border-border px-3 py-2 text-sm'

function Field({ label, error, children }: { label: string; error?: string; children: (describedBy?: string) => ReactNode }) {
  const errorId = useId()
  return (
    <div className="text-sm">
      <label className="block">
        <span className="mb-1 block">{label}</span>
        {children(error ? errorId : undefined)}
      </label>
      {error && <p id={errorId} role="alert" className="mt-1 text-destructive">{error}</p>}
    </div>
  )
}

/** Spec §2 step 2: email, name and a US shipping address, before any payment form. */
export default function AddressForm({ value, onChange, onSubmit, busy, errors = {} }: {
  value: QuoteRequest
  onChange: (next: QuoteRequest) => void
  onSubmit: () => void
  busy: boolean
  /** Per-field copy for what core refused, shown next to the field. */
  errors?: FieldErrors
}) {
  const setAddress = (patch: Partial<QuoteRequest['address']>) => onChange({ ...value, address: { ...value.address, ...patch } })
  const a11y = (field: AddressField, describedBy?: string) => ({
    'aria-invalid': errors[field] ? true : undefined,
    'aria-describedby': describedBy,
  })
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); onSubmit() }}>
      <Field label="Email" error={errors.email}>
        {(d) => (
          <input className={input} type="email" required autoComplete="email" value={value.email} {...a11y('email', d)}
            onChange={(e) => onChange({ ...value, email: e.target.value })} />
        )}
      </Field>
      <Field label="Full name" error={errors.name}>
        {(d) => (
          <input className={input} required autoComplete="name" value={value.name} {...a11y('name', d)}
            onChange={(e) => onChange({ ...value, name: e.target.value })} />
        )}
      </Field>
      <Field label="Address line 1" error={errors['address.line1']}>
        {(d) => (
          <input className={input} required autoComplete="address-line1" value={value.address.line1} {...a11y('address.line1', d)}
            onChange={(e) => setAddress({ line1: e.target.value })} />
        )}
      </Field>
      <Field label="Address line 2 (optional)" error={errors['address.line2']}>
        {(d) => (
          <input className={input} autoComplete="address-line2" value={value.address.line2} {...a11y('address.line2', d)}
            onChange={(e) => setAddress({ line2: e.target.value })} />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="City" error={errors['address.city']}>
          {(d) => (
            <input className={input} required autoComplete="address-level2" value={value.address.city} {...a11y('address.city', d)}
              onChange={(e) => setAddress({ city: e.target.value })} />
          )}
        </Field>
        <Field label="State" error={errors['address.state']}>
          {(d) => (
            <select className={input} required autoComplete="address-level1" value={value.address.state} {...a11y('address.state', d)}
              onChange={(e) => setAddress({ state: e.target.value })}>
              <option value="">Choose…</option>
              {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
        </Field>
        <Field label="ZIP code" error={errors['address.postalCode']}>
          {(d) => (
            <input className={input} required inputMode="numeric" autoComplete="postal-code" pattern="\d{5}(-\d{4})?"
              value={value.address.postalCode} {...a11y('address.postalCode', d)}
              onChange={(e) => setAddress({ postalCode: e.target.value })} />
          )}
        </Field>
      </div>
      <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Calculating…' : 'Continue to payment'}</Button>
    </form>
  )
}
