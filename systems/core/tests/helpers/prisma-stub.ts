/**
 * Stubs one call to a Prisma delegate method, then falls back to the real
 * implementation. `prisma.order` (and every other delegate) is Proxy-backed:
 * `vi.spyOn(prisma.order, 'findMany').mockRestore()` -- called directly, or
 * indirectly through `vi.restoreAllMocks()` -- leaves the property `undefined`
 * for the rest of the file instead of putting the real implementation back
 * (discovered in tests/checkout-sweep.test.ts, Task 5).
 *
 * This never touches vi's mock registry: it swaps the property for a plain
 * function and swaps it back itself, so nothing here is ever a target of
 * `vi.restoreAllMocks()`. Always call the returned restore function, in a
 * `finally`, even on a failing assertion.
 */
export function stubDelegateOnce<T extends object>(delegate: T, method: keyof T, value: unknown): () => void {
  const original = delegate[method]
  let used = false
  delegate[method] = (async (...args: unknown[]) => {
    if (!used) {
      used = true
      return value
    }
    return (original as (...a: unknown[]) => unknown).apply(delegate, args)
  }) as unknown as T[keyof T]
  return () => { delegate[method] = original }
}
