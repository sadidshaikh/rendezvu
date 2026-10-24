import { useEffect, useRef } from 'react'
import type { ErrorData, JoinData, JoinedData, PeerJoinedData, PeerLeftData } from '@rendezvu/protocol'
import type { SignalingClient } from '@/services/signaling/client'
import { usePeerStore } from '@/stores/peer'

interface Args {
  client: SignalingClient | null
  roomId: string
  enabled: boolean
  userName: string
  /** The server refused the room (expired, unknown). The call cannot continue. */
  onRoomError: (message: string) => void
}

/**
 * Drives one participant's time in a room: join once the signaling client is
 * connected, keep the roster in sync, and leave on cleanup.
 */
export function useCall({ client, roomId, enabled, userName, onRoomError }: Args) {
  // Read at join time only: renaming mid-call must not trigger a rejoin.
  const userNameRef = useRef(userName)
  userNameRef.current = userName
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

    client.send<JoinData>('join', { name: userNameRef.current, audio: false, video: false }, { room: roomId })

    return () => {
      client.off('joined', handleJoined)
      client.off('peer-joined', handlePeerJoined)
      client.off('peer-left', handlePeerLeft)
      client.off('error', handleError)
      client.send('leave', undefined, { room: roomId })
      store().clearAll()
    }
  }, [client, roomId, enabled])
}
