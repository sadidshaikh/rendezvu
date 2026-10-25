// `window.chrome` exists in Chrome, Edge, Brave and other Chromium browsers,
// not in Firefox or Safari.
function isChromium(): boolean {
  return 'chrome' in window
}

const BASE = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  // 48 kHz is what WebRTC uses internally. Asking for it avoids a resample,
  // which adds latency and makes echo cancellation worse.
  sampleRate: { ideal: 48000 },
  // Mono is enough for voice and halves what echo cancellation has to process.
  channelCount: { ideal: 1 },
  // Lowest capture latency keeps the echo canceller's reference aligned.
  // lib.dom.d.ts leaves `latency` out even though the spec has it.
  latency: { ideal: 0 },
} satisfies Record<string, unknown>

// Chrome's own names for the same features, plus a high-pass filter for room
// rumble. Other browsers ignore unknown keys.
const CHROMIUM_HINTS: Record<string, unknown> = {
  googEchoCancellation: true,
  googNoiseSuppression: true,
  googHighpassFilter: true,
  googAudioMirroring: false,
}

export function getMicConstraints(): MediaTrackConstraints {
  return { ...BASE, ...(isChromium() ? CHROMIUM_HINTS : {}) } as MediaTrackConstraints
}
