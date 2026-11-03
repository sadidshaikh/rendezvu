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
import type { BackgroundProcessor } from '@/lib/effects/background'
import type { NoiseSuppressor } from '@/lib/effects/noise'
import { readEffectPreferences, saveEffectPreferences, type BackgroundEffect } from '@/lib/effects/preferences'
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
   * The device tracks. With an effect on, localStream holds the processed
   * track instead, and these are what turning the effect off swaps back to.
   * Unplugging ends these, never the processed ones, so they're what to watch.
   */
  rawCameraTrack: MediaStreamTrack | null
  rawMicTrack: MediaStreamTrack | null
  backgroundEffect: BackgroundEffect
  /** The picture behind you with 'image', as an object URL. For this page only. */
  backgroundImageUrl: string | null
  noiseSuppression: boolean
  /** An effect is starting (the first time, its model is loading). */
  backgroundBusy: boolean
  noiseBusy: boolean
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
  /**
   * Saved, and applied now if the camera is on. Resolves to whether that
   * effect is really on: false after a fallback to the plain camera.
   */
  setBackgroundEffect: (effect: BackgroundEffect, image?: File) => Promise<boolean>
  setNoiseSuppression: (on: boolean) => Promise<boolean>

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

  // What goes out, raw or processed. Stops nothing: raw tracks are stopped by
  // whatever replaces them, processed ones by their effect's stop().
  const sendAudio = (track: MediaStreamTrack | null) => {
    const current = get().localStream
    set({ localStream: streamOf([...(track ? [track] : []), ...(current?.getVideoTracks() ?? [])]) })
  }
  const sendVideo = (track: MediaStreamTrack | null) => {
    const current = get().localStream
    set({ localStream: streamOf([...(current?.getAudioTracks() ?? []), ...(track ? [track] : [])]) })
  }

  // ── Effects ──
  // Camera and effect changes run one at a time per kind, so a toggle during
  // a slow model load can't interleave with it: the last one queued wins.
  let videoTasks: Promise<unknown> = Promise.resolve()
  let audioTasks: Promise<unknown> = Promise.resolve()
  const runVideo = <T,>(task: () => Promise<T>): Promise<T> => {
    const run = videoTasks.then(task, task)
    videoTasks = run.catch(() => {})
    return run
  }
  const runAudio = <T,>(task: () => Promise<T>): Promise<T> => {
    const run = audioTasks.then(task, task)
    audioTasks = run.catch(() => {})
    return run
  }
  let backgroundProcessor: BackgroundProcessor | null = null
  let noiseSuppressor: NoiseSuppressor | null = null
  let backgroundImage: HTMLImageElement | null = null

  const BLUR_PX: Record<string, number> = { 'blur-subtle': 8, 'blur-medium': 14, 'blur-strong': 22 }

  const backgroundUnavailable = (reason: 'slow' | 'error') => {
    set({ backgroundEffect: 'off' })
    saveEffectPreferences({ background: 'off' })
    toast.error(
      reason === 'slow' ? 'Background blur was turned off to keep your call smooth.' : "Background blur isn't available on this device.",
      { id: 'effect-background' },
    )
  }
  const noiseUnavailable = () => {
    set({ noiseSuppression: false })
    saveEffectPreferences({ noiseSuppression: false })
    toast.error("Noise suppression isn't available, using your normal microphone.", { id: 'effect-noise' })
  }

  /** The current effect on `raw`: its processor and output, or null (off, or it failed and said so). */
  const startBackground = async (raw: MediaStreamTrack) => {
    const effect = get().backgroundEffect
    if (effect === 'off') return null
    set({ backgroundBusy: true })
    let processor: BackgroundProcessor | null = null
    try {
      const { BackgroundProcessor } = await import('@/lib/effects/background')
      processor = new BackgroundProcessor({
        blurPx: BLUR_PX[effect],
        image: effect === 'image' ? (backgroundImage ?? undefined) : undefined,
        onFailure: (reason) => {
          // Only the one in use: an old one failing changes nothing.
          if (processor !== backgroundProcessor) return
          backgroundProcessor = null
          const rawTrack = get().rawCameraTrack
          if (rawTrack?.readyState === 'live') sendVideo(rawTrack)
          backgroundUnavailable(reason)
        },
      })
      const track = await processor.start(raw)
      return { processor, track }
    } catch (err) {
      console.warn('[effects] background effect failed to start', err)
      processor?.stop()
      backgroundUnavailable('error')
      return null
    } finally {
      set({ backgroundBusy: false })
    }
  }

  const startNoise = async (raw: MediaStreamTrack) => {
    if (!get().noiseSuppression) return null
    set({ noiseBusy: true })
    let suppressor: NoiseSuppressor | null = null
    try {
      const { NoiseSuppressor } = await import('@/lib/effects/noise')
      suppressor = new NoiseSuppressor(() => {
        if (suppressor !== noiseSuppressor) return
        noiseSuppressor = null
        const rawTrack = get().rawMicTrack
        if (rawTrack?.readyState === 'live') sendAudio(rawTrack)
        noiseUnavailable()
      })
      const track = await suppressor.start(raw)
      return { suppressor, track }
    } catch (err) {
      console.warn('[effects] noise suppression failed to start', err)
      suppressor?.stop()
      noiseUnavailable()
      return null
    } finally {
      set({ noiseBusy: false })
    }
  }

  /**
   * A new camera track (turned on, switched, flipped): with the saved effect
   * applied before anything is sent, so a chosen blur never shows the real
   * background first. False if a newer camera action came in meanwhile.
   */
  const applyCamera = (raw: MediaStreamTrack, generation: number) =>
    runVideo(async () => {
      if (generation !== videoGeneration) {
        raw.stop()
        return false
      }
      const started = await startBackground(raw)
      if (generation !== videoGeneration) {
        started?.processor.stop()
        raw.stop()
        return false
      }
      const previousRaw = get().rawCameraTrack
      const previous = backgroundProcessor
      backgroundProcessor = started?.processor ?? null
      set({ rawCameraTrack: raw })
      sendVideo(started?.track ?? raw)
      // After the swap, so the sender is never left holding a stopped track.
      previous?.stop()
      if (previousRaw && previousRaw !== raw) previousRaw.stop()
      return true
    })

  const applyMic = (raw: MediaStreamTrack, generation: number) =>
    runAudio(async () => {
      if (generation !== audioGeneration) {
        raw.stop()
        return false
      }
      const started = await startNoise(raw)
      if (generation !== audioGeneration) {
        started?.suppressor.stop()
        raw.stop()
        return false
      }
      const previousRaw = get().rawMicTrack
      const previous = noiseSuppressor
      noiseSuppressor = started?.suppressor ?? null
      set({ rawMicTrack: raw })
      sendAudio(started?.track ?? raw)
      previous?.stop()
      if (previousRaw && previousRaw !== raw) previousRaw.stop()
      return true
    })

  /** Camera off (or leaving): its effect and its device track go together. */
  const stopCamera = () => {
    backgroundProcessor?.stop()
    backgroundProcessor = null
    get().rawCameraTrack?.stop()
    set({ rawCameraTrack: null })
    sendVideo(null)
  }
  const stopMic = () => {
    noiseSuppressor?.stop()
    noiseSuppressor = null
    get().rawMicTrack?.stop()
    set({ rawMicTrack: null })
    sendAudio(null)
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
    rawCameraTrack: null,
    rawMicTrack: null,
    backgroundEffect: readEffectPreferences().background,
    backgroundImageUrl: null,
    noiseSuppression: readEffectPreferences().noiseSuppression,
    backgroundBusy: false,
    noiseBusy: false,
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
        return (await applyMic(track, generation)) ? OK : CANCELLED
      } catch (error) {
        return generation === audioGeneration ? { status: 'failed', error } : CANCELLED
      }
    },

    disableMic: () => {
      audioGeneration++
      // Silence first: stopping the track a sender is using leaves it with nothing.
      get().sfuSession?.sendPlaceholder('audio')
      stopMic()
    },

    enableCamera: async () => {
      const generation = ++videoGeneration
      try {
        const track = await openCamera(cameraConstraints())
        return (await applyCamera(track, generation)) ? OK : CANCELLED
      } catch (error) {
        return generation === videoGeneration ? { status: 'failed', error } : CANCELLED
      }
    },

    disableCamera: () => {
      videoGeneration++
      // Black frames first, or everyone freezes on the last one. While sharing,
      // the sender carries the screen, which must keep going.
      if (!get().screenTrack) get().sfuSession?.sendPlaceholder('video')
      stopCamera()
    },

    switchCamera: async () => {
      if (!get().localStream?.getVideoTracks().length) return false
      const generation = ++videoGeneration
      const nextFacing = get().facingMode === 'user' ? 'environment' : 'user'
      try {
        const track = await openCamera({ facingMode: { ideal: nextFacing }, ...VIDEO_HINTS })
        if (!(await applyCamera(track, generation))) return false
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
        await applyMic(track, generation)
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
        await applyCamera(track, generation)
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

    setBackgroundEffect: async (effect, image) => {
      if (effect === 'image') {
        if (!image) return false
        const url = URL.createObjectURL(image)
        try {
          const { loadBackgroundImage } = await import('@/lib/effects/background')
          backgroundImage = await loadBackgroundImage(url)
        } catch {
          URL.revokeObjectURL(url)
          toast.error("That picture can't be used. Try a JPEG or PNG.", { id: 'effect-background' })
          return false
        }
        const previousUrl = get().backgroundImageUrl
        if (previousUrl) URL.revokeObjectURL(previousUrl)
        set({ backgroundImageUrl: url })
      }
      set({ backgroundEffect: effect })
      saveEffectPreferences({ background: effect })

      return runVideo(async () => {
        const raw = get().rawCameraTrack
        // Camera off: saved, and applied when it comes on.
        if (!raw) return get().backgroundEffect === effect
        // A newer choice is queued behind this one; it does the work.
        if (get().backgroundEffect !== effect) return false
        if (effect === 'off') {
          const previous = backgroundProcessor
          backgroundProcessor = null
          sendVideo(raw)
          previous?.stop()
          return true
        }
        const started = await startBackground(raw)
        if (!started) {
          // Fell back: the plain camera, and whatever effect ran before goes too.
          const previous = backgroundProcessor
          backgroundProcessor = null
          if (get().rawCameraTrack === raw) sendVideo(raw)
          previous?.stop()
          return false
        }
        // The camera went off or changed while the effect loaded.
        if (get().rawCameraTrack !== raw || get().backgroundEffect !== effect) {
          started.processor.stop()
          return false
        }
        const previous = backgroundProcessor
        backgroundProcessor = started.processor
        sendVideo(started.track)
        previous?.stop()
        return true
      })
    },

    setNoiseSuppression: async (on) => {
      set({ noiseSuppression: on })
      saveEffectPreferences({ noiseSuppression: on })
      return runAudio(async () => {
        const raw = get().rawMicTrack
        if (!raw) return get().noiseSuppression === on
        if (get().noiseSuppression !== on) return false
        if (!on) {
          const previous = noiseSuppressor
          noiseSuppressor = null
          sendAudio(raw)
          previous?.stop()
          return true
        }
        if (noiseSuppressor) return true
        const started = await startNoise(raw)
        if (!started) return false
        if (get().rawMicTrack !== raw || !get().noiseSuppression) {
          started.suppressor.stop()
          return false
        }
        noiseSuppressor = started.suppressor
        sendAudio(started.track)
        return true
      })
    },

    clearAll: () => {
      audioGeneration++
      videoGeneration++
      backgroundProcessor?.stop()
      backgroundProcessor = null
      noiseSuppressor?.stop()
      noiseSuppressor = null
      get().rawCameraTrack?.stop()
      get().rawMicTrack?.stop()
      get().localStream?.getTracks().forEach((t) => t.stop())
      get().screenTrack?.stop()
      set({
        rawCameraTrack: null,
        rawMicTrack: null,
        inRoom: false,
        ...EMPTY_ROOM,
        localStream: null,
        screenTrack: null,
        sfuSession: null,
      })
    },
  }
})
