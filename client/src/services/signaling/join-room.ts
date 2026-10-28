import type { ErrorData, JoinData } from '@rendezvu/protocol'
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
    const fail = (message: string) => {
      clearTimeout(timer)
      client.dispose()
      reject(new Error(message))
    }
    const timer = setTimeout(() => fail('Timed out joining the room.'), JOIN_TIMEOUT_MS)
    client.on('joined', () => {
      clearTimeout(timer)
      resolve(client)
    })
    client.on<ErrorData>('error', (env) => fail(env.data?.message ?? 'The server refused the join.'))
    client.onStateChange = (state) => {
      if (state === 'connected') client.send<JoinData>('join', { name, audio: false, video: false }, { room: code })
      if (state === 'disconnected') fail('Could not reach the signaling server.')
    }
    client.connect()
  })
}
