import { useEffect, useRef } from 'react'
import { usePeerStore } from '@/stores/peer'

type AudioWithSinkId = HTMLAudioElement & { setSinkId: (id: string) => Promise<void> }

/**
 * Plays one remote person's audio. Kept apart from their <video>, which stays
 * muted, so sound never depends on whether or where their tile is shown.
 */
export function RemoteAudio({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null)
  const outputId = usePeerStore((s) => s.preferredAudioOutputId)
  // The stream object changes whenever their video changes too. Re-attaching
  // the audio then would cause a small gap, so only the audio track counts.
  const audioTrack = stream.getAudioTracks()[0] ?? null

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.srcObject = audioTrack ? new MediaStream([audioTrack]) : null
    if (!audioTrack) return
    // Clicking Join usually counts as the user gesture browsers require for
    // sound. If playback is still blocked, try again on the next tap.
    el.play().catch(() => {
      const resume = () => el.play().catch(() => {})
      document.addEventListener('pointerdown', resume, { once: true })
    })
  }, [audioTrack])

  useEffect(() => {
    const el = ref.current
    // Chrome and Edge; Firefox and Safari follow the system output.
    if (!el || !outputId || !('setSinkId' in el)) return
    ;(el as AudioWithSinkId).setSinkId(outputId).catch((e) => console.warn('[audio] setSinkId failed', e))
  }, [outputId])

  return <audio ref={ref} autoPlay />
}
