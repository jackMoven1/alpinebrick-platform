import { createContext, useContext, useState, useCallback } from 'react'

const ToastCtx = createContext(null)
export function useToast() { return useContext(ToastCtx) }

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const push = useCallback((message, tone = 'success') => {
    const id = Math.random().toString(36).slice(2)
    setToasts((t) => [...t, { id, message, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2500)
  }, [])
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={`rounded-card px-4 py-2 text-sm text-white shadow-card ${t.tone === 'error' ? 'bg-accent' : 'bg-ink'}`}>{t.message}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}
