import type { Envelope, ErrorData, JoinData } from '@rendezvu/protocol'
import { wsServerUri } from '@/lib/config'
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
    const timer = setTimeout(() => fail('Timed out joining the room.'), JOIN_TIMEOUT_MS)
    client.on('joined', onJoined)
    client.on('error', onError)
    client.onStateChange = (state) => {
      if (state === 'connected') client.send<JoinData>('join', { name, audio: false, video: false }, { room: code })
      if (state === 'disconnected') fail('Could not reach the signaling server.')
    }
    client.connect()
  })
}
