export function initialsOf(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean)
  const first = parts[0]
  if (!first) return '?'
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined
  return ((first[0] ?? '') + (last?.[0] ?? '')).toUpperCase()
}
