export default function Modal({ open, title, children, onClose, onConfirm, confirmLabel = 'Confirm', danger }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-card bg-white p-6 shadow-card">
        <h2 className="text-lg font-bold">{title}</h2>
        <div className="mt-3 text-sm text-gray-600">{children}</div>
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-pill px-4 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-100">Cancel</button>
          <button onClick={onConfirm} className={`rounded-pill px-4 py-2 text-sm font-semibold text-white ${danger ? 'bg-accent' : 'bg-ink'}`}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
