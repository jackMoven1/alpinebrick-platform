export default function ProgressBar({ value = 0 }) {
  return (
    <div className="h-2 w-full rounded-pill bg-gray-100">
      <div className="h-2 rounded-pill bg-brand" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  )
}
