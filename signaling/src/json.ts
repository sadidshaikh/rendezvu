/** A plain JSON object: not null, not an array. For checking parsed input. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
