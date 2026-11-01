import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { PeerStateData } from '@rendezvu/protocol'
import { useAudioLevel } from '@/hooks/use-audio-level'
import { resumeSharedAudioContext } from '@/lib/audio-context'
import { describeMediaError } from '@/lib/media-errors'
import { playScreenShareStart, playScreenShareStop } from '@/lib/sounds'
import type { SignalingClient } from '@/services/signaling/client'
import { useMeetStore } from '@/stores/meet'
import { usePeerStore } from '@/stores/peer'

/**
 * Everything the call footer does: mic, camera, flip and screen share, plus
 * telling the room about it. The state goes out as `peer-state` whenever it
 * changes, so no handler has to remember to send it.
 */
// How long a live mic may stay muted by the system before it counts as interrupted.
const MIC_MUTED_GRACE_MS = 3_000

export function useCallControls(client: SignalingClient | null, roomId: string) {
  const inRoom = usePeerStore((s) => s.inRoom)
  const joinCount = usePeerStore((s) => s.joinCount)
  const localStream = usePeerStore((s) => s.localStream)
  const screenTrack = usePeerStore((s) => s.screenTrack)
  const isMuted = useMeetStore((s) => s.isMuted)
  const isVideoOff = useMeetStore((s) => s.isVideoOff)
  const { speaking } = useAudioLevel(localStream, !isMuted)
  const [deviceError, setDeviceError] = useState<string | null>(null)
  // A device or the screen picker is opening. Its button waits.
  const [micBusy, setMicBusy] = useState(false)
  const [cameraBusy, setCameraBusy] = useState(false)
  const [shareBusy, setShareBusy] = useState(false)
  // Whether to turn the camera back on when the share ends.
  const cameraBeforeShare = useRef(false)
  const isSharing = screenTrack !== null

  // Intent flips only once the device is really running, as in the lobby.
  const turnCameraOn = useCallback(async () => {
    setCameraBusy(true)
    const result = await usePeerStore.getState().enableCamera()
    setCameraBusy(false)
    if (result.status === 'ok') useMeetStore.getState().setVideoOff(false)
    else if (result.status === 'failed') setDeviceError(describeMediaError('camera', result.error))
  }, [])

  const stopSharing = useCallback(
    async (restoreCamera: boolean) => {
      const restore = restoreCamera && cameraBeforeShare.current
      cameraBeforeShare.current = false
      if (!usePeerStore.getState().screenTrack) return
      usePeerStore.getState().stopScreenShare()
      playScreenShareStop()
      if (restore) await turnCameraOn()
    },
    [turnCameraOn],
  )

  const handleMicToggle = async () => {
    setDeviceError(null)
    const peer = usePeerStore.getState()
    if (!useMeetStore.getState().isMuted) {
      peer.disableMic()
      useMeetStore.getState().setMuted(true)
      return
    }
    resumeSharedAudioContext()
    setMicBusy(true)
    const result = await peer.enableMic()
    setMicBusy(false)
    if (result.status === 'ok') useMeetStore.getState().setMuted(false)
    else if (result.status === 'failed') setDeviceError(describeMediaError('mic', result.error))
  }

  const handleCameraToggle = async () => {
    setDeviceError(null)
    // While sharing, the camera button means "back to my camera".
    if (usePeerStore.getState().screenTrack) {
      await stopSharing(false)
      await turnCameraOn()
      return
    }
    if (!useMeetStore.getState().isVideoOff) {
      usePeerStore.getState().disableCamera()
      useMeetStore.getState().setVideoOff(true)
      return
    }
    await turnCameraOn()
  }

  const handleScreenShare = async () => {
    if (usePeerStore.getState().screenTrack) {
      await stopSharing(true)
      return
    }
    setDeviceError(null)
    const cameraOn = !useMeetStore.getState().isVideoOff
    cameraBeforeShare.current = cameraOn
    // Camera off before the picker opens. Afterwards, its black placeholder
    // could land on the sender after the screen and everyone would see black.
    if (cameraOn) {
      usePeerStore.getState().disableCamera()
      useMeetStore.getState().setVideoOff(true)
    }
    setShareBusy(true)
    const result = await usePeerStore.getState().startScreenShare()
    setShareBusy(false)
    if (result.status === 'ok') {
      playScreenShareStart()
      return
    }
    if (result.status === 'failed') toast.error('Could not share your screen.')
    // Closed the picker, or it failed: back to how things were.
    if (cameraBeforeShare.current) {
      cameraBeforeShare.current = false
      await turnCameraOn()
    }
  }

  const handleFlip = async () => {
    if (!(await usePeerStore.getState().switchCamera())) toast.error('Could not switch camera.')
  }

  // The browser's own "Stop sharing" bar ends the track without our button.
  useEffect(() => {
    if (!screenTrack) return
    const onEnded = () => {
      if (usePeerStore.getState().screenTrack === screenTrack) void stopSharing(true)
    }
    screenTrack.addEventListener('ended', onEnded)
    return () => screenTrack.removeEventListener('ended', onEnded)
  }, [screenTrack, stopSharing])

  // A device can stop on its own: unplugged, permission revoked, taken by
  // another app. Treat it as switched off, so the room is told and the sender
  // gets a placeholder instead of a dead track.
  useEffect(() => {
    if (!localStream) return
    const interrupted = (track: MediaStreamTrack) => {
      // Already replaced or switched off: nothing to undo.
      if (!usePeerStore.getState().localStream?.getTracks().includes(track)) return
      if (track.kind === 'audio') {
        usePeerStore.getState().disableMic()
        useMeetStore.getState().setMuted(true)
        toast('Microphone was interrupted. Click to re-enable.')
      } else {
        usePeerStore.getState().disableCamera()
        useMeetStore.getState().setVideoOff(true)
        toast('Camera was interrupted. Click to re-enable.')
      }
    }

    const cleanups = localStream.getTracks().map((track) => {
      const onEnded = () => interrupted(track)
      track.addEventListener('ended', onEnded)
      // Some systems mute a mic another app took instead of ending it. Muted
      // for a while while still live means the same. The camera has no such
      // rule: phones mute it whenever the tab is in the background.
      let muteTimer: ReturnType<typeof setTimeout> | undefined
      const onMute = () => {
        clearTimeout(muteTimer)
        muteTimer = setTimeout(() => {
          if (track.muted && track.readyState === 'live') interrupted(track)
        }, MIC_MUTED_GRACE_MS)
      }
      const onUnmute = () => clearTimeout(muteTimer)
      if (track.kind === 'audio') {
        track.addEventListener('mute', onMute)
        track.addEventListener('unmute', onUnmute)
      }
      return () => {
        clearTimeout(muteTimer)
        track.removeEventListener('ended', onEnded)
        track.removeEventListener('mute', onMute)
        track.removeEventListener('unmute', onUnmute)
      }
    })

    // Waking from sleep, some browsers update readyState without firing
    // `ended`. Coming back to the tab is the moment to look once.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      for (const track of localStream.getTracks()) {
        if (track.readyState === 'ended' || (track.kind === 'audio' && track.muted)) interrupted(track)
      }
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      cleanups.forEach((cleanup) => cleanup())
    }
  }, [localStream])

  // The full state, whenever any part of it changes. Sent once after every
  // join too: on arrival it covers a toggle made while the join was on its
  // way, and after a reconnect it restores what the server forgot.
  const lastSent = useRef<{ joinCount: number; json: string } | null>(null)
  useEffect(() => {
    if (!client || !inRoom) {
      lastSent.current = null
      return
    }
    const state: PeerStateData = {
      audio: !isMuted,
      video: !isVideoOff,
      speaking: !isMuted && speaking,
      screenSharing: isSharing,
    }
    const json = JSON.stringify(state)
    if (lastSent.current?.joinCount === joinCount && lastSent.current.json === json) return
    lastSent.current = { joinCount, json }
    client.send<PeerStateData>('peer-state', state, { room: roomId })
  }, [client, inRoom, joinCount, roomId, isMuted, isVideoOff, speaking, isSharing])

  return {
    isMuted,
    isVideoOff,
    isSharing,
    speaking,
    micBusy,
    cameraBusy,
    shareBusy,
    deviceError,
    clearDeviceError: () => setDeviceError(null),
    handleMicToggle,
    handleCameraToggle,
    handleScreenShare,
    handleFlip,
  }
}
