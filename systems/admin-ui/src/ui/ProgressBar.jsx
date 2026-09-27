export default function ProgressBar({ value = 0, label }) {
  const pct = Math.min(100, Math.max(0, Math.round(value)))
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className="h-2 w-full rounded-pill bg-gray-100"
    >
      <div className="h-2 rounded-pill bg-brand" style={{ width: `${pct}%` }} />
    </div>
  )
}
