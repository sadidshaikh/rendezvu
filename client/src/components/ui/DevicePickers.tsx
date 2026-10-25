import type { AvailableDevices } from '@/hooks/use-media-devices'
import { supportsAudioOutputSelection } from '@/lib/audio-context'
import { cn } from '@/lib/utils'
import { usePeerStore } from '@/stores/peer'
import { DeviceSelect } from './DeviceSelect'

interface DevicePickersProps {
  devices: AvailableDevices
  /** Prefix for element ids, so two sets can be on the page at once. */
  idPrefix: string
  layout: 'grid' | 'stack'
}

export function hasAnyDevice({ audioInputs, videoInputs, audioOutputs }: AvailableDevices): boolean {
  return audioInputs.length > 0 || videoInputs.length > 0 || (supportsAudioOutputSelection() && audioOutputs.length > 0)
}

/** Mic, camera and (where supported) speaker selectors. */
export function DevicePickers({ devices, idPrefix, layout }: DevicePickersProps) {
  const localStream = usePeerStore((s) => s.localStream)
  const preferredAudioInputId = usePeerStore((s) => s.preferredAudioInputId)
  const preferredVideoInputId = usePeerStore((s) => s.preferredVideoInputId)
  const preferredAudioOutputId = usePeerStore((s) => s.preferredAudioOutputId)
  const setAudioInput = usePeerStore((s) => s.setAudioInput)
  const setVideoInput = usePeerStore((s) => s.setVideoInput)
  const setAudioOutput = usePeerStore((s) => s.setAudioOutput)
  const showSpeaker = supportsAudioOutputSelection() && devices.audioOutputs.length > 0
  const liveId = (track?: MediaStreamTrack) => track?.getSettings().deviceId

  return (
    <div className={cn('grid gap-3', layout === 'grid' ? 'grid-cols-1 gap-2 sm:grid-cols-2' : 'grid-cols-1')}>
      <DeviceSelect
        id={`${idPrefix}-mic`}
        label="Microphone"
        devices={devices.audioInputs}
        value={preferredAudioInputId}
        currentId={liveId(localStream?.getAudioTracks()[0])}
        onChange={(id) => void setAudioInput(id)}
      />
      <DeviceSelect
        id={`${idPrefix}-camera`}
        label="Camera"
        devices={devices.videoInputs}
        value={preferredVideoInputId}
        currentId={liveId(localStream?.getVideoTracks()[0])}
        onChange={(id) => void setVideoInput(id)}
      />
      {showSpeaker && (
        <DeviceSelect
          id={`${idPrefix}-speaker`}
          label="Speaker"
          devices={devices.audioOutputs}
          value={preferredAudioOutputId}
          onChange={(id) => void setAudioOutput(id)}
          className={layout === 'grid' ? 'sm:col-span-2' : undefined}
        />
      )}
    </div>
  )
}
