import { useEffect, useRef } from 'react'
import type { ErrorData, JoinData, JoinedData, PeerJoinedData, PeerLeftData } from '@rendezvu/protocol'
import type { SignalingClient } from '@/services/signaling/client'
import { usePeerStore } from '@/stores/peer'

interface Args {
  client: SignalingClient | null
  roomId: string
  enabled: boolean
  userName: string
  /** Mic and camera as the user left them in the lobby. Sent with `join`. */
  initialAudio: boolean
  initialVideo: boolean
  /** The server refused the room (expired, unknown). The call cannot continue. */
  onRoomError: (message: string) => void
}

/**
 * Drives one participant's time in a room: join once the signaling client is
 * connected, keep the roster in sync, and leave on cleanup. Local media
 * belongs to the room page, which stops it when the user leaves.
 */
export function useCall({ client, roomId, enabled, userName, initialAudio, initialVideo, onRoomError }: Args) {
  // Read at join time only: changing these mid-call must not trigger a rejoin.
  const joinArgs = useRef({ userName, initialAudio, initialVideo })
  joinArgs.current = { userName, initialAudio, initialVideo }
  const onRoomErrorRef = useRef(onRoomError)
  onRoomErrorRef.current = onRoomError

  useEffect(() => {
    if (!client || !enabled) return
    const store = usePeerStore.getState

    const handleJoined = (env: { data?: JoinedData }) => {
      store().setRoster(env.data?.peers ?? [])
    }
    const handlePeerJoined = (env: { data?: PeerJoinedData }) => {
      const d = env.data
      if (!d) return
      store().addPeer({ id: d.peerId, name: d.name, audio: d.audio, video: d.video })
    }
    const handlePeerLeft = (env: { data?: PeerLeftData }) => {
      if (env.data) store().removePeer(env.data.peerId)
    }
    const handleError = (env: { data?: ErrorData }) => {
      const d = env.data
      if (d?.code?.startsWith('ROOM_')) {
        onRoomErrorRef.current(d.message)
        return
      }
      console.warn('signaling error:', d?.message)
    }

    client.on('joined', handleJoined)
    client.on('peer-joined', handlePeerJoined)
    client.on('peer-left', handlePeerLeft)
    client.on('error', handleError)

    const a = joinArgs.current
    client.send<JoinData>('join', { name: a.userName, audio: a.initialAudio, video: a.initialVideo }, { room: roomId })

    return () => {
      client.off('joined', handleJoined)
      client.off('peer-joined', handlePeerJoined)
      client.off('peer-left', handlePeerLeft)
      client.off('error', handleError)
      client.send('leave', undefined, { room: roomId })
      store().clearPeers()
    }
  }, [client, roomId, enabled])
}
