import type { IceServer, IceServersRequest, IceServersResponse } from '@rendezvu/protocol'
import { httpServerUri } from '@/lib/config'
import { parseApiError } from './http'
import { getOrCreatePresenceId } from '@/services/signaling/client'
import { authHeaders } from './room-token'

const FETCH_TIMEOUT_MS = 5_000
const MAX_ATTEMPTS = 3
// Credentials last 60 minutes. Refreshing at 45 leaves time to retry a failed refresh.
export const ICE_REFRESH_AFTER_MS = 45 * 60_000
const REFRESH_RETRY_MS = 60_000

/**
 * STUN and TURN servers for a room the server says is active. Retries with
 * backoff (0.5 s, then 1 s, each with jitter); throws the last error.
 */
export async function fetchIceServers(roomId: string): Promise<IceServer[]> {
  let lastError: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const base = 500 * 2 ** (attempt - 1)
      await new Promise((r) => setTimeout(r, base * (0.5 + Math.random() * 0.5)))
    }
    try {
      // With the tab's presence: a guest token is only good for the tab it was issued to.
      const body: IceServersRequest = { roomId, presenceId: getOrCreatePresenceId() }
      const res = await fetch(`${httpServerUri}/ice-servers`, {
        method: 'POST',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        // Read on every attempt: a guest's token arrives on admission.
        headers: { 'Content-Type': 'application/json', ...authHeaders(roomId) },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw await parseApiError(res)
      return ((await res.json()) as IceServersResponse).iceServers
    } catch (e) {
      lastError = e
      console.warn(`[ice] fetch attempt ${attempt + 1}/${MAX_ATTEMPTS} failed`, e)
    }
  }
  throw lastError
}

/**
 * Fetches fresh servers every 45 minutes until stopped. A failed refresh is
 * retried after a minute, while the old credentials are still valid.
 * Returns the stop function.
 */
export function startIceServerKeepalive(
  roomId: string,
  onRefresh: (servers: IceServer[]) => void,
  onError?: (error: unknown) => void,
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const schedule = (delay: number) => {
    timer = setTimeout(() => {
      fetchIceServers(roomId).then(
        (servers) => {
          if (stopped) return
          onRefresh(servers)
          schedule(ICE_REFRESH_AFTER_MS)
        },
        (error) => {
          if (stopped) return
          onError?.(error)
          schedule(REFRESH_RETRY_MS)
        },
      )
    }, delay)
  }

  schedule(ICE_REFRESH_AFTER_MS)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
