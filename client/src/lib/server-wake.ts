import { useEffect, useSyncExternalStore } from 'react'
import { httpServerUri } from '@/lib/config'

// A free-plan server sleeps after 15 quiet minutes. Starting again takes a
// minute or so, and after a long idle (the image is pulled again) up to a few. Asking early, the moment someone opens the site, hides most
// of that wait; saying so explains the rest.

export type ServerState = 'checking' | 'ready' | 'waking' | 'down'

const ATTEMPT_TIMEOUT_MS = 4_000
const RETRY_MS = 3_000
// Longer than even a slow cold start. Past it, something else is wrong.
const GIVE_UP_MS = 5 * 60_000

let state: ServerState = 'checking'
let running = false
// When the current wake-up began, so the notice can say how long it's been.
let wakeStartedAt = 0
const listeners = new Set<() => void>()

function setState(next: ServerState) {
  if (next === state) return
  state = next
  listeners.forEach((l) => l())
}

/** Only our server's own "ok" counts: while waking, the host serves a loading page instead. */
async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`${httpServerUri}/healthz`, { cache: 'no-store', signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) })
    return res.ok && (await res.text()).trim() === 'ok'
  } catch {
    return false
  }
}

/**
 * Starts (or restarts) waking the server. Safe to call often: one loop at a
 * time. `force`: a request just failed, so a "ready" from earlier is stale
 * (the server may have gone back to sleep since).
 */
export function wakeServer(force = false): void {
  if (force && state === 'ready' && !running) state = 'checking'
  if (running || state === 'ready') return
  running = true
  if (state === 'down') setState('checking')
  void (async () => {
    const startedAt = Date.now()
    wakeStartedAt = startedAt
    let first = true
    while (Date.now() - startedAt < GIVE_UP_MS) {
      if (await healthy()) {
        setState('ready')
        running = false
        return
      }
      // One miss could be a blip; it's "waking" from the second try on.
      if (!first) setState('waking')
      first = false
      await new Promise((r) => setTimeout(r, RETRY_MS))
    }
    setState('down')
    running = false
  })()
}

/** When the wake-up in progress began (ms since epoch). */
export function wakingSince(): number {
  return wakeStartedAt
}

/** The server's state, waking it on first use. */
export function useServerState(): ServerState {
  useEffect(() => {
    wakeServer()
  }, [])
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
  )
}
