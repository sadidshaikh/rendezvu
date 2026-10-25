import { useEffect, useState } from 'react'

export interface MediaDeviceSummary {
  deviceId: string
  label: string
}

export interface AvailableDevices {
  audioInputs: MediaDeviceSummary[]
  videoInputs: MediaDeviceSummary[]
  audioOutputs: MediaDeviceSummary[]
}

const EMPTY: AvailableDevices = { audioInputs: [], videoInputs: [], audioOutputs: [] }

async function enumerate(): Promise<AvailableDevices> {
  if (!navigator.mediaDevices?.enumerateDevices) return EMPTY
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    // Before permission is granted, browsers list placeholder entries with an
    // empty deviceId. They can't be selected, so they're left out.
    const of = (kind: MediaDeviceKind, fallback: string) =>
      all
        .filter((d) => d.kind === kind && d.deviceId)
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `${fallback} ${i + 1}` }))
    return {
      audioInputs: of('audioinput', 'Microphone'),
      videoInputs: of('videoinput', 'Camera'),
      audioOutputs: of('audiooutput', 'Speaker'),
    }
  } catch {
    return EMPTY
  }
}

/**
 * Lists cameras, mics and speakers, refreshed when a device is plugged in or
 * removed. Pass the local stream as `refreshKey`: ids and labels only appear
 * after permission is granted, and not every browser fires `devicechange` then.
 */
export function useMediaDevices(refreshKey?: unknown): AvailableDevices {
  const [devices, setDevices] = useState<AvailableDevices>(EMPTY)

  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      enumerate().then((d) => {
        if (!cancelled) setDevices(d)
      })
    }
    refresh()
    navigator.mediaDevices?.addEventListener('devicechange', refresh)
    return () => {
      cancelled = true
      navigator.mediaDevices?.removeEventListener('devicechange', refresh)
    }
  }, [refreshKey])

  return devices
}
