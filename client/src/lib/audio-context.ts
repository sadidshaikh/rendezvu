// One AudioContext for the whole page, shared by every level meter.
// Browsers cap how many can exist, and iOS Safari only lets one run once it
// has been resumed inside a tap, so call resumeSharedAudioContext() from
// click handlers (Join, unmute).

type AudioContextWithSinkId = AudioContext & { setSinkId: (id: string) => Promise<void> }

let sharedCtx: AudioContext | null = null
// Kept so a recreated context gets the same output device.
let pendingSinkId: string | null = null

function getAudioCtor(): typeof AudioContext | null {
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
    null
  )
}

export function getSharedAudioContext(): AudioContext | null {
  const Ctor = getAudioCtor()
  if (!Ctor) return null
  if (!sharedCtx || sharedCtx.state === 'closed') {
    sharedCtx = new Ctor({ latencyHint: 'interactive', sampleRate: 48000 })
    if (pendingSinkId && 'setSinkId' in sharedCtx) {
      ;(sharedCtx as AudioContextWithSinkId).setSinkId(pendingSinkId).catch(() => {})
    }
  }
  return sharedCtx
}

/** Call synchronously inside a user-gesture handler. */
export function resumeSharedAudioContext(): void {
  const ctx = getSharedAudioContext()
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {})
}

/** Routes all AudioContext output to the given device. No-op where unsupported. */
export async function setAudioOutputDevice(deviceId: string): Promise<void> {
  pendingSinkId = deviceId
  const ctx = getSharedAudioContext()
  if (!ctx || !('setSinkId' in ctx)) return
  await (ctx as AudioContextWithSinkId).setSinkId(deviceId)
}

/** Chrome and Edge 110+. Firefox and Safari follow the system output. */
export function supportsAudioOutputSelection(): boolean {
  return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype
}
