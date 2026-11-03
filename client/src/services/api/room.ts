import type { RoomStatus, RoomStatusResult } from '@rendezvu/protocol'
import { httpServerUri } from '@/lib/config'

export interface LobbyRoomStatus extends Omit<RoomStatusResult, 'status'> {
  /**
   * 'unavailable': the server answered with an error, not a status.
   * 'unreachable': no answer at all (down, deploying, offline).
   */
  status: RoomStatus | 'unavailable' | 'unreachable'
}

export async function fetchRoomStatus(code: string): Promise<LobbyRoomStatus> {
  try {
    const res = await fetch(`${httpServerUri}/room/status?code=${encodeURIComponent(code)}`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return { status: 'unavailable' }
    return (await res.json()) as RoomStatusResult
  } catch {
    // Network error or timeout. The lobby says so but still lets people try:
    // a server mid-deploy is usually back by the time they click Join.
    return { status: 'unreachable' }
  }
}
