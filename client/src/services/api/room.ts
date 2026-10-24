import type { RoomStatus, RoomStatusResult } from '@rendezvu/protocol'
import { httpServerUri } from '@/lib/config'

export interface LobbyRoomStatus extends Omit<RoomStatusResult, 'status'> {
  /** 'unavailable' means the server answered with an error, not a status. */
  status: RoomStatus | 'unavailable'
}

export async function fetchRoomStatus(code: string): Promise<LobbyRoomStatus> {
  try {
    const res = await fetch(`${httpServerUri}/room/status?code=${encodeURIComponent(code)}`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return { status: 'unavailable' }
    return (await res.json()) as RoomStatusResult
  } catch {
    // Network error or timeout: fail open so a server hiccup doesn't keep
    // people out of the lobby. The join itself is still checked by the server.
    return { status: 'open' }
  }
}
