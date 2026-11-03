import type { Envelope, ErrorData, JoinData } from '@rendezvu/protocol'
import { wsServerUri } from '@/lib/config'
import { getRoomToken } from '@/services/api/room-token'
import { SignalingClient } from './client'

const JOIN_TIMEOUT_MS = 8_000

/**
 * For diagnostics: connects to signaling and joins with media off, resolving
 * once the server answers `joined`. The caller sends `leave` and disposes.
 */
export function joinRoom(code: string, name: string): Promise<SignalingClient> {
  return new Promise((resolve, reject) => {
    const client = new SignalingClient(wsServerUri)
    // Only until the join settles. A later `error` (say, for a message the
    // server doesn't know) must not tear down a connection the caller now owns.
    const settle = () => {
      clearTimeout(timer)
      client.off('joined', onJoined)
      client.off('error', onError)
      client.off('knock-pending', onKnockPending)
      client.onStateChange = undefined
    }
    const fail = (message: string) => {
      settle()
      client.dispose()
      reject(new Error(message))
    }
    const onJoined = () => {
      settle()
      resolve(client)
    }
    const onError = (env: Envelope<ErrorData>) => fail(env.data?.message ?? 'The server refused the join.')
    // The check created this room, so it holds its host token. Without one it would wait to be let in.
    const onKnockPending = () => fail('The server asked this check to knock: it has no host token for the room.')
    const timer = setTimeout(() => fail('Timed out joining the room.'), JOIN_TIMEOUT_MS)
    client.on('joined', onJoined)
    client.on('error', onError)
    client.on('knock-pending', onKnockPending)
    client.onStateChange = (state, attempt) => {
      if (state === 'connected') {
        // presenceId too, or the server can't match our /sfu requests to us.
        const token = getRoomToken(code) ?? undefined
        client.send<JoinData>('join', { name, audio: false, video: false, presenceId: client.getPresenceId(), token }, { room: code })
      }
      // A check reports the first failure instead of retrying like a call.
      if (state !== 'connected' && attempt > 0) fail('Could not reach the signaling server.')
    }
    client.connect()
  })
}
