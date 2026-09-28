/**
 * The pending order from the last checkout attempt in this tab (spec §6).
 * Sent as previousOrderId so core releases its stock before reserving again.
 * sessionStorage: a new tab is a new attempt.
 */
export const PREVIOUS_ORDER_KEY = 'ab.previousOrderId'

function store(): Storage | null {
  try { return window.sessionStorage } catch { return null }
}

export function getPreviousOrderId(): string | null {
  try { return store()?.getItem(PREVIOUS_ORDER_KEY) ?? null } catch { return null }
}

export function setPreviousOrderId(id: string): void {
  try { store()?.setItem(PREVIOUS_ORDER_KEY, id) } catch { /* ignore */ }
}

export function clearPreviousOrderId(): void {
  try { store()?.removeItem(PREVIOUS_ORDER_KEY) } catch { /* ignore */ }
}
