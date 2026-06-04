import { useRef, useState, useCallback } from 'react'

// Returns [status, trigger]. trigger(fn) debounces fn by `delay` ms and tracks
// 'idle' | 'saving' | 'saved' status for an inline indicator.
export function useAutoSave(delay = 1000) {
  const [status, setStatus] = useState('idle')
  const timer = useRef(null)
  const trigger = useCallback((saveFn) => {
    setStatus('saving')
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      await saveFn()
      setStatus('saved')
      setTimeout(() => setStatus('idle'), 1500)
    }, delay)
  }, [delay])
  return [status, trigger]
}
