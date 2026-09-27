import { useEffect } from 'react'
import { Link } from 'react-router'
import { X } from 'lucide-react'
import CartPanel from './CartPanel'

export default function CartDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-[70]">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <aside role="dialog" aria-modal="true" aria-label="Cart"
        className="absolute right-0 top-0 h-full w-full max-w-md bg-background border-l border-border overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-black uppercase tracking-[0.12em]" style={{ fontFamily: 'var(--font-display)' }}>Your cart</h2>
          <button type="button" aria-label="Close cart" onClick={onClose} className="p-2 text-muted-foreground hover:text-foreground">
            <X size={18} aria-hidden />
          </button>
        </div>
        <CartPanel onNavigate={onClose} />
        <Link to="/cart" onClick={onClose} className="mt-6 block text-center text-xs uppercase tracking-[0.16em] text-muted-foreground hover:text-foreground">
          View full cart
        </Link>
      </aside>
    </div>
  )
}
