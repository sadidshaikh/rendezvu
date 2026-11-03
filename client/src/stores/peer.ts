import { create } from 'zustand'
import { toast } from 'sonner'
import type {
  CandidateType,
  IceServer,
  KnockRequestData,
  NetworkPressure,
  PeerInfo,
  PeerStateData,
  QualityGrade,
} from '@rendezvu/protocol'
import { setAudioOutputDevice } from '@/lib/audio-context'
import { getMicConstraints } from '@/lib/audio-constraints'
import { getDevicePreferences, setDevicePreference } from '@/lib/device-preferences'
import { describeMediaError } from '@/lib/media-errors'
import type { SfuSession } from '@/services/webrtc/sfu-session'

/** One remote participant. Their media is in `remoteStreams`, keyed by the same id. */
export interface RemotePeer {
  id: string
  name: string
  audio: boolean
  video: boolean
  screenSharing: boolean
  speaking: boolean
}

/** Our connection to one other person, from the last stats poll. */
export interface PeerStats {
  quality: QualityGrade
  networkPressure: NetworkPressure
  roundTripTimeMs: number
  packetLossPercent: number
  jitterMs: number
  inboundBitrateKbps: number
  candidateType: CandidateType
  frameWidth?: number
  frameHeight?: number
  framesPerSecond?: number
}

/** Our uplink: one stream to the SFU, shared by everyone. */
export interface LocalStats {
  outboundBitrateKbps: number
  roundTripTimeMs: number
  candidateType: CandidateType
  /** When this poll ran, for "x s ago" in the panel. */
  timestamp: number
}

/** A stall or recovery from the Phase 9 monitor, for "Recent interruptions". */
export interface MediaFlowEvent {
  id: number
  at: number
  direction: 'publish' | 'subscribe'
  kind: 'audio' | 'video'
  outcome: 'stalled' | 'recovered'
  durationMs: number
  peerName?: string
}

const MAX_FLOW_EVENTS = 10

/**
 * Where this tab stands on getting in. Null: not knocking (in the call, or
 * joining with a token). Waiting: asked to join, nobody has answered yet.
 * Denied: someone in the call said no.
 */
export type Admission = null | 'waiting' | 'denied'

/** `cancelled`: a newer action (or leaving) superseded this one; not an error. */
export type AcquireResult = { status: 'ok' } | { status: 'cancelled' } | { status: 'failed'; error: unknown }

const OK: AcquireResult = { status: 'ok' }
const CANCELLED: AcquireResult = { status: 'cancelled' }

const VIDEO_HINTS = { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24 } }

interface PeerState {
  /** True once the server has acknowledged our join with `joined`. */
  inRoom: boolean
  /**
   * Goes up on every `joined`, the first and each one after a reconnect.
   * Whatever the server forgot with the old connection (our `peer-state`) is
   * sent again when it changes.
   */
  joinCount: number
  peers: Map<string, RemotePeer>
  /** STUN/TURN servers for this call, fetched after `joined`. Empty until then, or if the fetch failed. */
  iceServers: IceServer[]
  /**
   * Each remote participant's received tracks, at most one per kind. A new
   * MediaStream on every change: adding a track to an existing stream from
   * JavaScript fires no event, so a <video> already showing it would never
   * notice. A new object changes the prop, and the element re-attaches.
   */
  remoteStreams: Map<string, MediaStream>
  /** People whose media is being repaired right now. Their tile shows "Reconnecting…". */
  mediaReconnecting: Set<string>
  peerStats: Map<string, PeerStats>
  localStats: LocalStats | null
  /** Newest first. */
  mediaFlowEvents: MediaFlowEvent[]
  admission: Admission
  /** People waiting to be let in. Only members are told. */
  knockRequests: KnockRequestData[]

  /**
   * Our own live tracks. Replaced with a new MediaStream on every change, so
   * anything holding the old one (a <video>, a level meter) re-renders.
   */
  localStream: MediaStream | null
  /** Our screen share, sent on the video sender in place of the camera. Never part of localStream. */
  screenTrack: MediaStreamTrack | null
  /**
   * The call's connection to the SFU, while in a call. Device actions use it
   * to send a placeholder before stopping a device.
   */
  sfuSession: SfuSession | null
  facingMode: 'user' | 'environment'
  preferredAudioInputId: string
  preferredVideoInputId: string
  preferredAudioOutputId: string

  /** From `joined`: everyone else in the room. */
  setRoster: (peers: PeerInfo[]) => void
  /** From `room-snapshot`: the room as it is now, minus us. Adds, removes and updates without counting as a join. */
  syncRoster: (peers: PeerInfo[]) => void
  addPeer: (peer: PeerInfo) => void
  removePeer: (id: string) => void
  /** From `peer-state`: the person's full current state. */
  updatePeerState: (id: string, state: PeerStateData) => void
  setSfuSession: (session: SfuSession | null) => void
  setIceServers: (servers: IceServer[]) => void
  /** Replaces the participant's track of the same kind. */
  setRemoteTrack: (peerId: string, track: MediaStreamTrack) => void
  /** No-op if that track was already replaced. */
  removeRemoteTrack: (peerId: string, track: MediaStreamTrack) => void
  setMediaReconnecting: (peerId: string, reconnecting: boolean) => void
  /** One poll's numbers. Only people still in the room are kept. */
  setStats: (local: LocalStats | null, peers: Map<string, PeerStats>) => void
  recordFlowEvent: (event: Omit<MediaFlowEvent, 'id' | 'at'>) => void
  setAdmission: (admission: Admission) => void
  addKnockRequest: (request: KnockRequestData) => void
  removeKnockRequest: (peerId: string) => void
  /** Forgets the room's participants, their media and ICE servers. Local media is untouched. */
  clearPeers: () => void

  enableMic: () => Promise<AcquireResult>
  disableMic: () => void
  enableCamera: () => Promise<AcquireResult>
  disableCamera: () => void
  switchCamera: () => Promise<boolean>
  setAudioInput: (deviceId: string) => Promise<void>
  setVideoInput: (deviceId: string) => Promise<void>
  setAudioOutput: (deviceId: string) => Promise<void>
  /** `cancelled` also covers closing the picker. */
  startScreenShare: () => Promise<AcquireResult>
  /** Placeholder on the sender, then stops the share. The caller restores the camera if it was on. */
  stopScreenShare: () => void

  /** Stops every local track and forgets the room. */
  clearAll: () => void
}

function streamOf(tracks: MediaStreamTrack[]): MediaStream | null {
  return tracks.length > 0 ? new MediaStream(tracks) : null
}

function remotePeer(p: PeerInfo): RemotePeer {
  return {
    id: p.id,
    name: p.name,
    audio: p.audio,
    video: p.video,
    screenSharing: p.screenSharing ?? false,
    speaking: false,
  }
}

/**
 * The roster as `peers` says, keeping each known person's `speaking` (it
 * isn't stored on the server) and dropping the media of anyone gone.
 */
function rosterFrom(
  state: Pick<PeerState, 'peers' | 'remoteStreams' | 'mediaReconnecting' | 'peerStats'>,
  peers: PeerInfo[],
) {
  const next = new Map(peers.map((p) => [p.id, { ...remotePeer(p), speaking: state.peers.get(p.id)?.speaking ?? false }]))
  const remoteStreams = new Map([...state.remoteStreams].filter(([id]) => next.has(id)))
  const mediaReconnecting = new Set([...state.mediaReconnecting].filter((id) => next.has(id)))
  const peerStats = new Map([...state.peerStats].filter(([id]) => next.has(id)))
  return { peers: next, remoteStreams, mediaReconnecting, peerStats }
}

function errorName(error: unknown): string {
  return error instanceof DOMException ? error.name : ''
}

function onlyTrack(media: MediaStream, kind: 'audio' | 'video'): MediaStreamTrack {
  const [track, ...extra] = kind === 'audio' ? media.getAudioTracks() : media.getVideoTracks()
  extra.forEach((t) => t.stop())
  if (!track) throw new DOMException(`no ${kind} track`, 'NotFoundError')
  return track
}

async function openMic(deviceId: string): Promise<MediaStreamTrack> {
  const constraints = getMicConstraints()
  try {
    const audio = deviceId ? { ...constraints, deviceId: { exact: deviceId } } : constraints
    return onlyTrack(await navigator.mediaDevices.getUserMedia({ audio }), 'audio')
  } catch (e) {
    // The saved mic was unplugged: use the default one.
    if (!deviceId || errorName(e) !== 'OverconstrainedError') throw e
    return onlyTrack(await navigator.mediaDevices.getUserMedia({ audio: constraints }), 'audio')
  }
}

/**
 * Retries with simpler constraints:
 * - OverconstrainedError: the saved camera no longer exists.
 * - NotReadableError / NotFoundError: old Android devices throw these while the
 *   previous track still holds the hardware, or for size hints they can't meet.
 */
async function openCamera(constraints: MediaTrackConstraints): Promise<MediaStreamTrack> {
  const open = async (video: MediaTrackConstraints | true) =>
    onlyTrack(await navigator.mediaDevices.getUserMedia({ video }), 'video')
  const facing = constraints.facingMode
  const loose: MediaTrackConstraints | true = facing ? { facingMode: facing } : true

  try {
    return await open(constraints)
  } catch (e) {
    const name = errorName(e)
    if (name === 'OverconstrainedError') return open(loose)
    if (name !== 'NotReadableError' && name !== 'NotFoundError') throw e
    try {
      return await open(loose)
    } catch {
      return open(true)
    }
  }
}

/** Everything about the room and the call's connections, as it is before joining. */
const EMPTY_ROOM = {
  peers: new Map<string, RemotePeer>(),
  remoteStreams: new Map<string, MediaStream>(),
  mediaReconnecting: new Set<string>(),
  peerStats: new Map<string, PeerStats>(),
  localStats: null,
  mediaFlowEvents: [] as MediaFlowEvent[],
  admission: null as Admission,
  knockRequests: [] as KnockRequestData[],
  iceServers: [] as IceServer[],
}

export const usePeerStore = create<PeerState>()((set, get) => {
  const saved = getDevicePreferences()
  // Opening a device is async and the permission prompt can stay open for a
  // long time. Every action on a device bumps its generation. A request that
  // finishes under an older generation owns nothing: it stops its track.
  let audioGeneration = 0
  let videoGeneration = 0

  const replaceAudio = (track: MediaStreamTrack | null) => {
    const current = get().localStream
    current?.getAudioTracks().forEach((t) => t.stop())
    set({ localStream: streamOf([...(track ? [track] : []), ...(current?.getVideoTracks() ?? [])]) })
  }
  const replaceVideo = (track: MediaStreamTrack | null) => {
    const current = get().localStream
    current?.getVideoTracks().forEach((t) => t.stop())
    set({ localStream: streamOf([...(current?.getAudioTracks() ?? []), ...(track ? [track] : [])]) })
  }
  const cameraConstraints = (): MediaTrackConstraints => {
    const { preferredVideoInputId, facingMode } = get()
    return preferredVideoInputId
      ? { deviceId: { exact: preferredVideoInputId }, ...VIDEO_HINTS }
      : { facingMode, ...VIDEO_HINTS }
  }

  return {
    inRoom: false,
    joinCount: 0,
    peers: new Map(),
    iceServers: [],
    remoteStreams: new Map(),
    mediaReconnecting: new Set(),
    peerStats: new Map(),
    localStats: null,
    mediaFlowEvents: [],
    admission: null,
    knockRequests: [],
    localStream: null,
    screenTrack: null,
    sfuSession: null,
    facingMode: 'user',
    preferredAudioInputId: saved.audioInputId ?? '',
    preferredVideoInputId: saved.videoInputId ?? '',
    preferredAudioOutputId: saved.audioOutputId ?? '',

    // A member now. The server replays everyone still waiting right after
    // `joined`, so the list starts over rather than keeping stale entries.
    setRoster: (peers) =>
      set((state) => ({
        ...rosterFrom(state, peers),
        inRoom: true,
        joinCount: state.joinCount + 1,
        admission: null,
        knockRequests: [],
      })),

    syncRoster: (peers) => set((state) => rosterFrom(state, peers)),

    addPeer: (peer) =>
      set((state) => {
        const peers = new Map(state.peers)
        peers.set(peer.id, remotePeer(peer))
        return { peers }
      }),

    updatePeerState: (id, { audio, video, speaking, screenSharing }) =>
      set((state) => {
        const current = state.peers.get(id)
        if (!current) return state
        const peers = new Map(state.peers)
        peers.set(id, { ...current, audio, video, screenSharing, speaking: speaking ?? false })
        return { peers }
      }),

    setSfuSession: (sfuSession) => set({ sfuSession }),

    removePeer: (id) =>
      set((state) => {
        if (!state.peers.has(id)) return state
        const peers = new Map(state.peers)
        peers.delete(id)
        const remoteStreams = new Map(state.remoteStreams)
        remoteStreams.delete(id)
        const mediaReconnecting = new Set(state.mediaReconnecting)
        mediaReconnecting.delete(id)
        const peerStats = new Map(state.peerStats)
        peerStats.delete(id)
        return { peers, remoteStreams, mediaReconnecting, peerStats }
      }),

    setIceServers: (iceServers) => set({ iceServers }),

    setRemoteTrack: (peerId, track) =>
      set((state) => {
        const kept = state.remoteStreams.get(peerId)?.getTracks().filter((t) => t.kind !== track.kind) ?? []
        const remoteStreams = new Map(state.remoteStreams)
        remoteStreams.set(peerId, new MediaStream([...kept, track]))
        return { remoteStreams }
      }),

    removeRemoteTrack: (peerId, track) =>
      set((state) => {
        const current = state.remoteStreams.get(peerId)
        if (!current?.getTracks().includes(track)) return state
        const kept = current.getTracks().filter((t) => t !== track)
        const remoteStreams = new Map(state.remoteStreams)
        if (kept.length > 0) remoteStreams.set(peerId, new MediaStream(kept))
        else remoteStreams.delete(peerId)
        return { remoteStreams }
      }),

    setMediaReconnecting: (peerId, reconnecting) =>
      set((state) => {
        if (state.mediaReconnecting.has(peerId) === reconnecting) return state
        if (reconnecting && !state.peers.has(peerId)) return state
        const mediaReconnecting = new Set(state.mediaReconnecting)
        if (reconnecting) mediaReconnecting.add(peerId)
        else mediaReconnecting.delete(peerId)
        return { mediaReconnecting }
      }),

    setStats: (localStats, stats) =>
      set((state) => ({ localStats, peerStats: new Map([...stats].filter(([id]) => state.peers.has(id))) })),

    recordFlowEvent: (event) =>
      set((state) => ({
        mediaFlowEvents: [{ ...event, id: (state.mediaFlowEvents[0]?.id ?? 0) + 1, at: Date.now() }, ...state.mediaFlowEvents].slice(
          0,
          MAX_FLOW_EVENTS,
        ),
      })),

    setAdmission: (admission) => set({ admission }),

    addKnockRequest: (request) =>
      set((state) => ({
        knockRequests: [...state.knockRequests.filter((r) => r.peerId !== request.peerId), request],
      })),

    removeKnockRequest: (peerId) =>
      set((state) =>
        state.knockRequests.some((r) => r.peerId === peerId)
          ? { knockRequests: state.knockRequests.filter((r) => r.peerId !== peerId) }
          : state,
      ),

    clearPeers: () => set({ inRoom: false, ...EMPTY_ROOM }),

    enableMic: async () => {
      const generation = ++audioGeneration
      try {
        const track = await openMic(get().preferredAudioInputId)
        if (generation !== audioGeneration) {
          track.stop()
          return CANCELLED
        }
        replaceAudio(track)
        return OK
      } catch (error) {
        return generation === audioGeneration ? { status: 'failed', error } : CANCELLED
      }
    },

    disableMic: () => {
      audioGeneration++
      // Silence first: stopping the track a sender is using leaves it with nothing.
      get().sfuSession?.sendPlaceholder('audio')
      replaceAudio(null)
    },

    enableCamera: async () => {
      const generation = ++videoGeneration
      try {
        const track = await openCamera(cameraConstraints())
        if (generation !== videoGeneration) {
          track.stop()
          return CANCELLED
        }
        replaceVideo(track)
        return OK
      } catch (error) {
        return generation === videoGeneration ? { status: 'failed', error } : CANCELLED
      }
    },

    disableCamera: () => {
      videoGeneration++
      // Black frames first, or everyone freezes on the last one. While sharing,
      // the sender carries the screen, which must keep going.
      if (!get().screenTrack) get().sfuSession?.sendPlaceholder('video')
      replaceVideo(null)
    },

    switchCamera: async () => {
      if (!get().localStream?.getVideoTracks().length) return false
      const generation = ++videoGeneration
      const nextFacing = get().facingMode === 'user' ? 'environment' : 'user'
      try {
        const track = await openCamera({ facingMode: { ideal: nextFacing }, ...VIDEO_HINTS })
        if (generation !== videoGeneration) {
          track.stop()
          return false
        }
        replaceVideo(track)
        set({ facingMode: nextFacing })
        return true
      } catch (e) {
        console.error('switchCamera failed', e)
        return false
      }
    },

    setAudioInput: async (deviceId) => {
      const generation = ++audioGeneration
      setDevicePreference('audioInputId', deviceId)
      set({ preferredAudioInputId: deviceId })
      // Mic off: the choice is saved and used next time it's turned on.
      if (!get().localStream?.getAudioTracks().length) return
      try {
        const track = await openMic(deviceId)
        if (generation !== audioGeneration) {
          track.stop()
          return
        }
        replaceAudio(track)
      } catch (e) {
        if (generation === audioGeneration) toast.error(describeMediaError('mic', e))
      }
    },

    setVideoInput: async (deviceId) => {
      const generation = ++videoGeneration
      setDevicePreference('videoInputId', deviceId)
      set({ preferredVideoInputId: deviceId })
      if (!get().localStream?.getVideoTracks().length) return
      try {
        const track = await openCamera({ deviceId: { exact: deviceId }, ...VIDEO_HINTS })
        if (generation !== videoGeneration) {
          track.stop()
          return
        }
        replaceVideo(track)
      } catch (e) {
        if (generation === videoGeneration) toast.error(describeMediaError('camera', e))
      }
    },

    setAudioOutput: async (deviceId) => {
      setDevicePreference('audioOutputId', deviceId)
      set({ preferredAudioOutputId: deviceId })
      try {
        await setAudioOutputDevice(deviceId)
      } catch (e) {
        console.warn('setAudioOutput failed', e)
        toast.error('Could not switch audio output. Check browser permissions.')
      }
    },

    startScreenShare: async () => {
      if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
        return { status: 'failed', error: new DOMException('Screen sharing is not supported', 'NotSupportedError') }
      }
      const generation = ++videoGeneration
      try {
        // 'exclude' leaves this tab out of Chrome's picker: sharing it would show the call inside itself.
        const media = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false,
          selfBrowserSurface: 'exclude',
        } as DisplayMediaStreamOptions)
        const track = onlyTrack(media, 'video')
        if (generation !== videoGeneration) {
          track.stop()
          return CANCELLED
        }
        set({ screenTrack: track })
        // The same video sender as the camera: a swap, or the first video push.
        get().sfuSession?.publish(new MediaStream([track]))
        return OK
      } catch (error) {
        // NotAllowedError: the picker was closed.
        if (generation !== videoGeneration || errorName(error) === 'NotAllowedError') return CANCELLED
        return { status: 'failed', error }
      }
    },

    stopScreenShare: () => {
      const track = get().screenTrack
      if (!track) return
      videoGeneration++
      get().sfuSession?.sendPlaceholder('video')
      track.stop()
      set({ screenTrack: null })
    },

    clearAll: () => {
      audioGeneration++
      videoGeneration++
      get().localStream?.getTracks().forEach((t) => t.stop())
      get().screenTrack?.stop()
      set({
        inRoom: false,
        ...EMPTY_ROOM,
        localStream: null,
        screenTrack: null,
        sfuSession: null,
      })
    },
  }
})
