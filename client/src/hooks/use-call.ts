import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import type { ErrorData, IceServer, JoinData, JoinedData, PeerJoinedData, PeerLeftData, SfuTracksData } from '@rendezvu/protocol'
import { fetchIceServers, startIceServerKeepalive } from '@/services/api/ice'
import type { SignalingClient } from '@/services/signaling/client'
import { SfuSession } from '@/services/webrtc/sfu-session'
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

const ICE_RETRY_DELAY_MS = 1_000
// Only when /ice-servers was unreachable altogether (the server itself falls
// back to this on a Cloudflare failure). Without any STUN server the browser
// offers host candidates only, which can't reach Cloudflare from behind NAT.
const STUN_FALLBACK: IceServer[] = [{ urls: ['stun:stun.l.google.com:19302'] }]

/**
 * Drives one participant's time in a room: join once the signaling client is
 * connected, keep the roster in sync, fetch ICE servers once the server has
 * accepted the join, publish local media to the SFU, and leave on cleanup.
 * Local media belongs to the room page, which stops it when the user leaves.
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
    let disposed = false
    let iceRequested = false
    let stopIceKeepalive: (() => void) | null = null
    let sfu: SfuSession | null = null
    let stopPublishing: (() => void) | null = null

    // After the ICE fetch, so the first connection already has TURN.
    const startSfu = () => {
      const peerId = client.getPeerId()
      if (!peerId) return
      const servers = store().iceServers
      sfu = new SfuSession({
        roomId,
        peerId,
        iceServers: servers.length > 0 ? servers : STUN_FALLBACK,
        // Sent only once Cloudflare confirms, so nobody subscribes to a track that isn't live.
        onLocalTracksChanged: (announcement) => client.send<SfuTracksData>('sfu-announce', announcement, { room: roomId }),
        onPublishTimeout: () =>
          toast.warning("Your camera or microphone isn't reaching the call yet.", { id: 'sfu-publish-timeout' }),
        onConnectionStateChange: (state) => console.info('[sfu] publish connection', state),
      })
      const session = sfu
      // Joining with both off publishes nothing and creates no Cloudflare session.
      const publishLive = (stream: MediaStream | null) => {
        if (stream) session.publish(stream)
      }
      publishLive(store().localStream)
      // A device switch replaces localStream; publish swaps the track on the existing sender.
      stopPublishing = usePeerStore.subscribe((state, prev) => {
        if (state.localStream !== prev.localStream) publishLive(state.localStream)
      })
    }

    // Only after `joined`: the server hands out TURN credentials for rooms
    // that are active right now, and an instant room becomes active on its
    // first join. Asking from the lobby would be refused.
    const loadIceServers = async () => {
      let servers: IceServer[] | null = null
      let lastError: unknown
      // fetchIceServers already retries; one more round with jitter so a
      // short API blip doesn't cost TURN for the whole call.
      for (let attempt = 0; attempt < 2 && !servers; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, ICE_RETRY_DELAY_MS * (1 + Math.random() * 0.5)))
        if (disposed) return
        try {
          servers = await fetchIceServers(roomId)
        } catch (e) {
          lastError = e
        }
      }
      if (disposed) return
      if (servers) {
        store().setIceServers(servers)
      } else {
        // Without TURN, people on strict networks can't connect at all, so
        // this is said out loud rather than only logged.
        console.warn('[ice] fetch failed, continuing without TURN', lastError)
        toast.warning('Could not reach the connection relay. The call may not work on restrictive networks.')
      }
      startSfu()
      stopIceKeepalive = startIceServerKeepalive(
        roomId,
        (fresh) => {
          if (disposed) return
          store().setIceServers(fresh)
          sfu?.updateIceServers(fresh)
        },
        (error) => console.warn('[ice] refresh failed', error),
      )
    }

    const handleJoined = (env: { data?: JoinedData }) => {
      store().setRoster(env.data?.peers ?? [])
      if (!iceRequested) {
        iceRequested = true
        void loadIceServers()
      }
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
      disposed = true
      stopIceKeepalive?.()
      stopPublishing?.()
      sfu?.destroy()
      client.off('joined', handleJoined)
      client.off('peer-joined', handlePeerJoined)
      client.off('peer-left', handlePeerLeft)
      client.off('error', handleError)
      client.send('leave', undefined, { room: roomId })
      store().clearPeers()
    }
  }, [client, roomId, enabled])
}
