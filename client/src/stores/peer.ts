import { create } from 'zustand'
import { toast } from 'sonner'
import type { IceServer, PeerInfo } from '@rendezvu/protocol'
import { setAudioOutputDevice } from '@/lib/audio-context'
import { getMicConstraints } from '@/lib/audio-constraints'
import { getDevicePreferences, setDevicePreference } from '@/lib/device-preferences'
import { describeMediaError } from '@/lib/media-errors'

/** One remote participant. Their media is in `remoteStreams`, keyed by the same id. */
export interface RemotePeer {
  id: string
  name: string
  audio: boolean
  video: boolean
}

/** `cancelled`: a newer action (or leaving) superseded this one; not an error. */
export type AcquireResult = { status: 'ok' } | { status: 'cancelled' } | { status: 'failed'; error: unknown }

const OK: AcquireResult = { status: 'ok' }
const CANCELLED: AcquireResult = { status: 'cancelled' }

const VIDEO_HINTS = { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24 } }

interface PeerState {
  /** True once the server has acknowledged our join with `joined`. */
  inRoom: boolean
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

  /**
   * Our own live tracks. Replaced with a new MediaStream on every change, so
   * anything holding the old one (a <video>, a level meter) re-renders.
   */
  localStream: MediaStream | null
  facingMode: 'user' | 'environment'
  preferredAudioInputId: string
  preferredVideoInputId: string
  preferredAudioOutputId: string

  setRoster: (peers: PeerInfo[]) => void
  addPeer: (peer: RemotePeer) => void
  removePeer: (id: string) => void
  setIceServers: (servers: IceServer[]) => void
  /** Replaces the participant's track of the same kind. */
  setRemoteTrack: (peerId: string, track: MediaStreamTrack) => void
  /** No-op if that track was already replaced. */
  removeRemoteTrack: (peerId: string, track: MediaStreamTrack) => void
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

  /** Stops every local track and forgets the room. */
  clearAll: () => void
}

function streamOf(tracks: MediaStreamTrack[]): MediaStream | null {
  return tracks.length > 0 ? new MediaStream(tracks) : null
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
    peers: new Map(),
    iceServers: [],
    remoteStreams: new Map(),
    localStream: null,
    facingMode: 'user',
    preferredAudioInputId: saved.audioInputId ?? '',
    preferredVideoInputId: saved.videoInputId ?? '',
    preferredAudioOutputId: saved.audioOutputId ?? '',

    setRoster: (peers) =>
      set({
        inRoom: true,
        peers: new Map(peers.map((p) => [p.id, { id: p.id, name: p.name, audio: p.audio, video: p.video }])),
      }),

    addPeer: (peer) =>
      set((state) => {
        const peers = new Map(state.peers)
        peers.set(peer.id, peer)
        return { peers }
      }),

    removePeer: (id) =>
      set((state) => {
        if (!state.peers.has(id)) return state
        const peers = new Map(state.peers)
        peers.delete(id)
        const remoteStreams = new Map(state.remoteStreams)
        remoteStreams.delete(id)
        return { peers, remoteStreams }
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

    clearPeers: () => set({ inRoom: false, peers: new Map(), remoteStreams: new Map(), iceServers: [] }),

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

    clearAll: () => {
      audioGeneration++
      videoGeneration++
      get().localStream?.getTracks().forEach((t) => t.stop())
      set({ inRoom: false, peers: new Map(), remoteStreams: new Map(), iceServers: [], localStream: null })
    },
  }
})
