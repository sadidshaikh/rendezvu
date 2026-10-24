type Fields = Record<string, string | number | boolean | null | undefined>

/** One line per event: `2026-10-24T10:00:00.000Z join peer=ab12 room=abc-defg-hij`. */
export function log(event: string, fields: Fields = {}): void {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
  console.log([new Date().toISOString(), event, ...parts].join(' '))
}
