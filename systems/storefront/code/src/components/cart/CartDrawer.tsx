import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router'
import { X } from 'lucide-react'
import CartPanel from './CartPanel'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Portalled to document.body: the header <nav> has backdrop-filter, which
 * makes it the containing block for position:fixed descendants -- rendered
 * inside it, `fixed inset-0` was only as tall as the 64px header.
 *
 * Modal behaviour: focus moves to Close on open, Tab/Shift+Tab wrap inside the
 * dialog, Escape closes, and focus returns to whatever opened it.
 */
export default function CartDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key !== 'Tab' || !dialogRef.current) return
      const stops = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (stops.length === 0) { e.preventDefault(); return }
      const first = stops[0]
      const last = stops[stops.length - 1]
      const active = document.activeElement
      const inside = active instanceof Node && dialogRef.current.contains(active)
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (opener?.isConnected) opener.focus()
    }
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-[70]">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <aside ref={dialogRef} role="dialog" aria-modal="true" aria-label="Cart"
        className="absolute right-0 top-0 h-full w-full max-w-md bg-background border-l border-border overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-black uppercase tracking-[0.12em]" style={{ fontFamily: 'var(--font-display)' }}>Your cart</h2>
          <button ref={closeRef} type="button" aria-label="Close cart" onClick={onClose} className="p-2 text-muted-foreground hover:text-foreground">
            <X size={18} aria-hidden />
          </button>
        </div>
        <CartPanel onNavigate={onClose} />
        <Link to="/cart" onClick={onClose} className="mt-6 block text-center text-xs uppercase tracking-[0.16em] text-muted-foreground hover:text-foreground">
          View full cart
        </Link>
      </aside>
    </div>,
    document.body,
  )
}
