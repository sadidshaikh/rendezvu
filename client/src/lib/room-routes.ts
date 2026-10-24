const ROOM_PREFIX = '/room'

/** Same shape the server accepts: abc-defg-hij. */
export const meetCodePattern = /^[a-z2-9]{3}-[a-z2-9]{4}-[a-z2-9]{3}$/

export function roomPath(meetCode: string): string {
  return `${ROOM_PREFIX}/${meetCode}`
}

/**
 * Accepts what people actually paste: a bare code, a /room/<code> path, or a
 * full link (with or without the scheme). Returns the lowercase code, or ''
 * for empty input. Callers still validate with meetCodePattern.
 */
export function normalizeMeetCodeInput(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''

  try {
    const looksLikeUrl = trimmed.includes('://') || trimmed.includes('.') || trimmed.includes('/')
    if (looksLikeUrl) {
      const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
      return codeFromSegments(url.pathname.split('/').filter(Boolean))
    }
  } catch {
    // Not a URL; fall through to plain path parsing.
  }

  return codeFromSegments(trimmed.split('/').filter(Boolean))
}

function codeFromSegments(segments: string[]): string {
  if (segments[0]?.toLowerCase() === 'room') return (segments[1] ?? '').toLowerCase()
  return (segments[0] ?? '').toLowerCase()
}
