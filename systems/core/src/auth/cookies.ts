/**
 * Reads one cookie from a raw Cookie header without cookie-parser, so this
 * works in tests that mount a router standalone rather than building the app.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim()
      // A malformed percent-escape (e.g. `%zz`) throws URIError. Fall back to
      // the raw value -- same behaviour as the `cookie` package -- rather
      // than letting a client-supplied header crash the request.
      try {
        return decodeURIComponent(raw)
      } catch {
        return raw
      }
    }
  }
  return undefined
}
