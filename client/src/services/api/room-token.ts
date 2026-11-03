// Room tokens let this browser into one room without knocking.
//
// - Host token: from creating the meeting. In localStorage, so it works in
//   every tab and after a reload, for the 12 h the room lives.
// - Guest token: from being admitted. In sessionStorage, because the server
//   binds it to this tab's presence id: another tab couldn't use it anyway.
//
// Storage can be blocked (private windows, strict settings). Then a host
// simply has to knock from another tab, and nothing breaks.

const KEY_PREFIX = 'rendezvu.roomToken.'

function read(storage: Storage, code: string): string | null {
  try {
    return storage.getItem(KEY_PREFIX + code)
  } catch {
    return null
  }
}

function write(storage: Storage, code: string, token: string): void {
  try {
    storage.setItem(KEY_PREFIX + code, token)
  } catch {
    // Blocked storage: the token works for this page only.
  }
}

// Kept in memory as well, for when storage is blocked.
const memory = new Map<string, string>()

/** This tab's token for the room: a guest token first, then a host token. */
export function getRoomToken(code: string): string | null {
  return memory.get(code) ?? read(sessionStorage, code) ?? read(localStorage, code)
}

export function saveHostToken(code: string, token: string): void {
  memory.set(code, token)
  write(localStorage, code, token)
}

export function saveGuestToken(code: string, token: string): void {
  memory.set(code, token)
  write(sessionStorage, code, token)
}

/** `Authorization` for the room's HTTP calls, or nothing without a token. */
export function authHeaders(code: string): Record<string, string> {
  const token = getRoomToken(code)
  return token ? { Authorization: `Bearer ${token}` } : {}
}
