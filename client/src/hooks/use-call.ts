import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import type {
  ErrorData,
  IceServer,
  JoinData,
  JoinedData,
  KnockGrantedData,
  KnockRequestData,
  KnockResolvedData,
  PeerJoinedData,
  PeerLeftData,
  PeerStateData,
  RoomSnapshotData,
  SfuTracksData,
  StatsReportData,
  StatsReportPeer,
} from '@rendezvu/protocol'
import { playJoinCall, playKnock, playPeerJoined, playPeerLeft, playScreenShareStart, playScreenShareStop } from '@/lib/sounds'
import { fetchIceServers, startIceServerKeepalive } from '@/services/api/ice'
import { getRoomToken, saveGuestToken } from '@/services/api/room-token'
import type { SignalingClient } from '@/services/signaling/client'
import { CallReconciler } from '@/services/webrtc/call-reconciler'
import { SfuSession, type RepairInfo } from '@/services/webrtc/sfu-session'
import {
  gradeNetworkPressure,
  gradeQuality,
  startStatsMonitor,
  type FlowStall,
  type StatsMonitor,
  type TransportSample,
} from '@/services/webrtc/stats-monitor'
import { useMeetStore } from '@/stores/meet'
import { usePeerStore, type LocalStats, type PeerStats } from '@/stores/peer'

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
// The dot updates every 2 s poll; the server only needs a coarse view, so
// one small report per participant every 10 s.
const STATS_REPORT_EVERY_N_POLLS = 5

/** One console line per repair event: whether rung 1 fixes things, or everything ends up rebuilding. */
function describeRepair(info: RepairInfo): string {
  const what = info.stage === 'publish' ? `publish ${info.kind ?? ''}` : `subscribe ${info.sessionId?.slice(0, 8) ?? ''}`
  const track = info.trackName ? `/${info.trackName}` : ''
  return `${what.trim()}${track} rung=${info.rung} attempt=${info.attempt}`
}

/**
 * Drives one participant's time in a room: join once the signaling client is
 * connected, keep the roster in sync, fetch ICE servers once the server has
 * accepted the join, publish local media to the SFU, pull everyone else's,
 * and leave on cleanup. Local media belongs to the room page, which stops it
 * when the user leaves.
 */
export function useCall({ client, roomId, enabled, userName, initialAudio, initialVideo, onRoomError }: Args) {
  // Read at join time only: changing these mid-call must not trigger a rejoin.
  const joinArgs = useRef({ userName, initialAudio, initialVideo })
  joinArgs.current = { userName, initialAudio, initialVideo }
  const onRoomErrorRef = useRef(onRoomError)
  onRoomErrorRef.current = onRoomError
  // Set while the effect runs: asks to join again after a deny.
  const askAgainRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!client || !enabled) return
    const store = usePeerStore.getState
    let disposed = false
    let iceRequested = false
    let stopIceKeepalive: (() => void) | null = null
    let sfu: SfuSession | null = null
    let stopPublishing: (() => void) | null = null
    let statsMonitor: StatsMonitor | null = null

    // Created before the join: the replay of everyone's tracks arrives right
    // after `joined`, long before the SFU session exists. It's recorded here
    // and acted on once the session is up.
    const reconciler = new CallReconciler({
      getSession: () => sfu,
      onTrack: (peerId, track) => {
        store().setRemoteTrack(peerId, track)
        // The publisher stopped it, or its connection died.
        track.addEventListener('ended', () => store().removeRemoteTrack(peerId, track), { once: true })
      },
      onTrackGone: (peerId, track) => store().removeRemoteTrack(peerId, track),
    })

    // After the ICE fetch, so the first connection already has TURN.
    const startSfu = () => {
      if (!client.getPeerId()) return
      const servers = store().iceServers
      sfu = new SfuSession({
        roomId,
        presenceId: client.getPresenceId(),
        // Only after `joined`, so a guest's token from knock-granted is already saved.
        token: getRoomToken(roomId),
        iceServers: servers.length > 0 ? servers : STUN_FALLBACK,
        // Sent only once Cloudflare confirms, so nobody subscribes to a track that isn't live.
        onLocalTracksChanged: (announcement) => client.send<SfuTracksData>('sfu-announce', announcement, { room: roomId }),
        onPublishTimeout: (kind) =>
          toast.warning(
            kind === 'video'
              ? "Your camera isn't reaching others yet. Reconnecting it now."
              : "Your microphone isn't reaching others yet. Reconnecting it now.",
            { id: `sfu-publish-timeout-${kind}` },
          ),
        onConnectionStateChange: (state) => console.info('[sfu] publish connection', state),
        onRepair: (info) => {
          if (!disposed) console.warn('[repair]', describeRepair(info))
        },
        onRepaired: (info) => {
          if (!disposed) console.info('[repaired]', describeRepair(info))
        },
        onRemoteHealth: (remoteSessionId, reconnecting) => {
          if (disposed) return
          const peerId = reconciler.peerForSession(remoteSessionId)
          if (peerId) store().setMediaReconnecting(peerId, reconnecting)
        },
      })
      const session = sfu
      // Device actions send placeholders through it from now on.
      store().setSfuSession(session)
      // Joining with both off publishes nothing and creates no Cloudflare session.
      const publishLive = (stream: MediaStream | null) => {
        if (stream) session.publish(stream)
      }
      publishLive(store().localStream)
      // A share started in the first moments of the call, before this session existed.
      const { screenTrack } = store()
      if (screenTrack) session.publish(new MediaStream([screenTrack]))
      // A device switch replaces localStream; publish swaps the track on the existing sender.
      stopPublishing = usePeerStore.subscribe((state, prev) => {
        if (state.localStream !== prev.localStream) publishLive(state.localStream)
      })
      // Pull everyone whose tracks were announced while we were getting here.
      reconciler.reconcile()
      let pollsSinceReport = 0
      statsMonitor = startStatsMonitor({
        collect: () => session.collectStats(),
        onStall: (stall) => {
          if (disposed || !stallMatters(stall)) return
          console.warn('[stats] stalled', stall.direction, stall.kind, `${stall.stalledForMs} ms`, stall.vanished ? '(vanished)' : '')
          recordFlow(stall, 'stalled')
          session.repairStalledFlow(stall.direction, stall.sessionId)
        },
        onRecover: (stall) => {
          if (disposed) return
          console.info('[stats] flowing again', stall.direction, stall.kind, `after ${stall.stalledForMs} ms`)
          if (stallMatters(stall)) recordFlow(stall, 'recovered')
          session.settleStalledFlow(stall.direction, stall.sessionId)
        },
        onPoll: (samples) => {
          if (disposed) return
          const report = applySamples(samples)
          pollsSinceReport++
          if (report.length > 0 && pollsSinceReport >= STATS_REPORT_EVERY_N_POLLS) {
            pollsSinceReport = 0
            client.send<StatsReportData>('stats-report', { peers: report }, { room: roomId })
          }
        },
      })
    }

    const recordFlow = (stall: FlowStall, outcome: 'stalled' | 'recovered') => {
      const peerId = stall.sessionId ? reconciler.peerForSession(stall.sessionId) : undefined
      store().recordFlowEvent({
        direction: stall.direction,
        kind: stall.kind,
        outcome,
        durationMs: stall.stalledForMs,
        peerName: peerId ? store().peers.get(peerId)?.name : undefined,
      })
    }

    /**
     * One poll into the store (the dots and the panel), and the entries for
     * the next stats-report. Our uplink is one stream to the SFU shared by
     * everyone, so it is reported once, not per person.
     */
    const applySamples = (samples: TransportSample[]): StatsReportPeer[] => {
      const pub = samples.find((s) => s.direction === 'publish')
      const local: LocalStats | null = pub
        ? { outboundBitrateKbps: pub.outboundKbps, roundTripTimeMs: pub.roundTripTimeMs, candidateType: pub.candidateType, timestamp: Date.now() }
        : null
      const stats = new Map<string, PeerStats>()
      const report: StatsReportPeer[] = []
      for (const s of samples) {
        if (s.direction !== 'subscribe' || !s.sessionId) continue
        const peerId = reconciler.peerForSession(s.sessionId)
        const peer = peerId ? store().peers.get(peerId) : undefined
        if (!peerId || !peer) continue
        // A subscribe connection that hasn't measured its own path yet borrows our uplink's.
        const rtt = s.roundTripTimeMs >= 0 ? s.roundTripTimeMs : (pub?.roundTripTimeMs ?? -1)
        const candidateType = s.candidateType !== 'unknown' ? s.candidateType : (pub?.candidateType ?? 'unknown')
        // Only a camera they say is on can be judged by its frame rate.
        const expectsFrames = peer.video && !peer.screenSharing
        const entry: PeerStats = {
          quality: gradeQuality(rtt, s.packetLossPercent, expectsFrames ? s.framesPerSecond : undefined),
          networkPressure: gradeNetworkPressure(rtt, s.packetLossPercent),
          roundTripTimeMs: rtt,
          packetLossPercent: s.packetLossPercent,
          jitterMs: s.jitterMs,
          inboundBitrateKbps: s.inboundKbps,
          candidateType,
          frameWidth: s.frameWidth,
          frameHeight: s.frameHeight,
          framesPerSecond: s.framesPerSecond,
        }
        stats.set(peerId, entry)
        report.push({
          peerId,
          quality: entry.quality,
          networkPressure: entry.networkPressure,
          roundTripTimeMs: entry.roundTripTimeMs,
          packetLossPercent: entry.packetLossPercent,
          jitterMs: entry.jitterMs,
          outboundBitrateKbps: pub?.outboundKbps ?? 0,
          inboundBitrateKbps: entry.inboundBitrateKbps,
          candidateType,
          frameWidth: entry.frameWidth,
          frameHeight: entry.frameHeight,
          framesPerSecond: entry.framesPerSecond,
        })
      }
      store().setStats(local, stats)
      return report
    }

    /**
     * Our own silence is already filtered by the monitor (only real devices
     * count). Someone else's silence could be a broken pull or a mute; the
     * byte counters look the same, so what they told the room decides.
     */
    const stallMatters = (stall: FlowStall): boolean => {
      if (stall.direction === 'publish') return true
      const peerId = stall.sessionId ? reconciler.peerForSession(stall.sessionId) : undefined
      const peer = peerId ? store().peers.get(peerId) : undefined
      if (!peer) return false
      return stall.kind === 'audio' ? peer.audio : peer.video || peer.screenSharing
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

    // Resolves a wait for the next `joined`, so a reconnect only re-sends
    // state once the server has put us back in the room.
    let joinedCount = 0
    let joinedWaiters: Array<{ after: number; resolve: () => void }> = []
    const waitForJoinedAfter = (after: number) =>
      joinedCount > after ? Promise.resolve() : new Promise<void>((resolve) => joinedWaiters.push({ after, resolve }))

    const handleJoined = (env: { data?: JoinedData }) => {
      store().setRoster(env.data?.peers ?? [])
      joinedCount++
      const ready = joinedWaiters.filter((w) => joinedCount > w.after)
      joinedWaiters = joinedWaiters.filter((w) => joinedCount <= w.after)
      ready.forEach((w) => w.resolve())
      if (!iceRequested) {
        iceRequested = true
        void loadIceServers()
      }
    }
    const handlePeerJoined = (env: { data?: PeerJoinedData }) => {
      const d = env.data
      if (!d) return
      store().addPeer({
        id: d.peerId,
        name: d.name,
        audio: d.audio,
        video: d.video,
        screenSharing: d.screenSharing,
      })
      playPeerJoined()
    }
    const handlePeerState = (env: { from?: string; data?: PeerStateData }) => {
      if (!env.from || !env.data) return
      const wasSharing = store().peers.get(env.from)?.screenSharing
      store().updatePeerState(env.from, env.data)
      // Unknown peers (undefined) make no sound.
      if (wasSharing === false && env.data.screenSharing) playScreenShareStart()
      else if (wasSharing === true && !env.data.screenSharing) playScreenShareStop()
    }
    const handlePeerLeft = (env: { data?: PeerLeftData }) => {
      if (!env.data) return
      const known = store().peers.has(env.data.peerId)
      store().removePeer(env.data.peerId)
      if (known) playPeerLeft()
      reconciler.removePeer(env.data.peerId)
      reconciler.reconcile()
    }
    const handleSfuTracks = (env: { from?: string; data?: SfuTracksData }) => {
      const d = env.data
      // Our own tracks are never sent to us; ignore one if it ever is.
      if (!env.from || !d || env.from === client.getPeerId()) return
      if (reconciler.setPeerTracks(env.from, d.sessionId, d.tracks.map((t) => t.trackName), d.version)) {
        reconciler.reconcile()
      }
    }
    // The whole room: corrects any join, leave or announcement we missed,
    // without having to know which one it was. Quietly: no sounds.
    const handleRoomSnapshot = (env: { data?: RoomSnapshotData }) => {
      const d = env.data
      if (!d) return
      const myId = client.getPeerId()
      store().syncRoster(d.peers.filter((p) => p.id !== myId))
      const entries = d.tracks
        .filter((t) => t.peerId !== myId)
        .map((t) => ({ peerId: t.peerId, sessionId: t.sessionId, trackNames: t.tracks.map((x) => x.trackName) }))
      if (reconciler.applySnapshot(entries, d.version)) reconciler.reconcile()
    }
    // Admission. Without a token our join is a knock: we wait, and see
    // nothing of the room until someone in it lets us in.
    const handleKnockPending = () => store().setAdmission('waiting')
    // The room's normal `joined` follows; the token makes every later request (and rejoin) ours.
    const handleKnockGranted = (env: { data?: KnockGrantedData }) => {
      if (env.data?.token) saveGuestToken(roomId, env.data.token)
      playJoinCall()
    }
    const handleKnockDenied = () => store().setAdmission('denied')
    // Members only: someone is waiting, or stopped waiting.
    const handleKnockRequest = (env: { data?: KnockRequestData }) => {
      const d = env.data
      if (!d?.peerId) return
      const known = store().knockRequests.some((r) => r.peerId === d.peerId)
      store().addKnockRequest({ peerId: d.peerId, name: d.name ?? '' })
      if (!known) playKnock()
    }
    const handleKnockResolved = (env: { data?: KnockResolvedData }) => {
      if (env.data?.peerId) store().removeKnockRequest(env.data.peerId)
    }

    const handleError = (env: { data?: ErrorData }) => {
      const d = env.data
      if (d?.code?.startsWith('ROOM_')) {
        onRoomErrorRef.current(d.message)
        return
      }
      if (d?.code === 'KNOCK_QUEUE_FULL') {
        onRoomErrorRef.current('This call has too many people waiting. Try again in a minute.')
        return
      }
      console.warn('signaling error:', d?.message)
    }

    client.on('joined', handleJoined)
    client.on('peer-joined', handlePeerJoined)
    client.on('peer-left', handlePeerLeft)
    client.on('peer-state', handlePeerState)
    client.on('sfu-tracks', handleSfuTracks)
    client.on('room-snapshot', handleRoomSnapshot)
    client.on('error', handleError)
    client.on('knock-pending', handleKnockPending)
    client.on('knock-granted', handleKnockGranted)
    client.on('knock-denied', handleKnockDenied)
    client.on('knock-request', handleKnockRequest)
    client.on('knock-resolved', handleKnockResolved)

    // Read the token on every join: a guest admitted earlier rejoins with it after a reconnect.
    const sendJoin = (audio: boolean, video: boolean) =>
      client.send<JoinData>(
        'join',
        {
          name: joinArgs.current.userName,
          audio,
          video,
          presenceId: client.getPresenceId(),
          token: getRoomToken(roomId) ?? undefined,
        },
        { room: roomId },
      )

    askAgainRef.current = () => {
      if (disposed || store().admission !== 'denied') return
      const media = useMeetStore.getState()
      store().setAdmission('waiting')
      sendJoin(!media.isMuted, !media.isVideoOff)
    }

    // Only the WebSocket dropped. The SFU session, our publish connection and
    // every pull carry on; tearing them down would turn a blip into an outage.
    // The server forgot us with the old connection, so: join again, then send
    // what it lost, then ask for the whole room.
    let reconnectGeneration = 0
    client.onReconnected = () => {
      if (disposed) return
      const generation = ++reconnectGeneration
      reconciler.resetDesired()
      const after = joinedCount
      const media = useMeetStore.getState()
      sendJoin(!media.isMuted, !media.isVideoOff)
      void waitForJoinedAfter(after).then(() => {
        // A newer drop started over; that sequence sends instead.
        if (disposed || generation !== reconnectGeneration) return
        // peer-state goes out by itself: useCallControls sends again on every join.
        const announcement = sfu?.currentAnnouncement()
        if (announcement) client.send<SfuTracksData>('sfu-announce', announcement, { room: roomId })
        client.send('sync', undefined, { room: roomId })
      })
    }

    sendJoin(joinArgs.current.initialAudio, joinArgs.current.initialVideo)

    return () => {
      disposed = true
      // First: a poll landing mid-teardown would ask for repairs.
      statsMonitor?.stop()
      stopIceKeepalive?.()
      stopPublishing?.()
      reconciler.dispose()
      if (store().sfuSession === sfu) store().setSfuSession(null)
      sfu?.destroy()
      client.off('joined', handleJoined)
      client.off('peer-joined', handlePeerJoined)
      client.off('peer-left', handlePeerLeft)
      client.off('peer-state', handlePeerState)
      client.off('sfu-tracks', handleSfuTracks)
      client.off('room-snapshot', handleRoomSnapshot)
      client.off('error', handleError)
      client.off('knock-pending', handleKnockPending)
      client.off('knock-granted', handleKnockGranted)
      client.off('knock-denied', handleKnockDenied)
      client.off('knock-request', handleKnockRequest)
      client.off('knock-resolved', handleKnockResolved)
      askAgainRef.current = () => {}
      client.onReconnected = undefined
      client.send('leave', undefined, { room: roomId })
      store().clearPeers()
    }
  }, [client, roomId, enabled])

  return { askAgain: () => askAgainRef.current() }
}
