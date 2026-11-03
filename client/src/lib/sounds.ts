import { getSharedAudioContext } from './audio-context'

// Short sine tones made on the spot: nothing to download, no delay before the
// first play. Each sound plays only if the shared AudioContext is already
// running, which it is once the user has clicked Join.

function runningContext(): AudioContext | null {
  const ctx = getSharedAudioContext()
  return ctx?.state === 'running' ? ctx : null
}

/** One tone with a linear fade-out, `startOffset` seconds from now. */
function tone(ctx: AudioContext, freq: number, gainPeak: number, duration: number, startOffset = 0) {
  const t = ctx.currentTime + startOffset
  const osc = ctx.createOscillator()
  const env = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  osc.connect(env)
  env.connect(ctx.destination)
  env.gain.setValueAtTime(gainPeak, t)
  env.gain.linearRampToValueAtTime(0, t + duration)
  osc.start(t)
  osc.stop(t + duration + 0.01)
}

// Two tabs of one browser in the same room both react to the same event and
// would play the same sound a few milliseconds apart. localStorage is shared
// between them, so the first tab notes the time and the other skips. Best
// effort: a rare double play is harmless.
const DEDUP_MS = 600
const STORAGE_PREFIX = 'rendezvu:sfx:'

function playOnce(key: string, play: (ctx: AudioContext) => void): void {
  const ctx = runningContext()
  if (!ctx) return
  try {
    const now = Date.now()
    const last = Number(localStorage.getItem(STORAGE_PREFIX + key) ?? 0)
    if (now - last < DEDUP_MS) return
    localStorage.setItem(STORAGE_PREFIX + key, String(now))
  } catch {
    // Storage blocked (private mode, settings): play without the check.
  }
  play(ctx)
}

// "You joined" and "someone joined" share a key, so in a two-tab test the
// joiner's chime and the other tab's chime count as one.

/** Two rising tones: you joined. */
export function playJoinCall(): void {
  playOnce('peer-presence', (c) => {
    tone(c, 392, 0.14, 0.12, 0)
    tone(c, 523, 0.14, 0.16, 0.11)
  })
}

/** A short rising blip: someone joined. */
export function playPeerJoined(): void {
  playOnce('peer-presence', (c) => {
    tone(c, 440, 0.14, 0.12, 0)
    tone(c, 554, 0.12, 0.14, 0.1)
  })
}

/** A short falling blip: someone left. */
export function playPeerLeft(): void {
  playOnce('peer-left', (c) => {
    tone(c, 554, 0.1, 0.1, 0)
    tone(c, 370, 0.08, 0.12, 0.09)
  })
}

/** One low tone: you left. */
export function playLeaveCall(): void {
  playOnce('leave-call', (c) => tone(c, 370, 0.14, 0.18))
}

/** Three rising tones: a share started (yours or someone else's). */
export function playScreenShareStart(): void {
  playOnce('screen-share-start', (c) => {
    tone(c, 392, 0.1, 0.1, 0)
    tone(c, 494, 0.1, 0.12, 0.09)
    tone(c, 587, 0.09, 0.14, 0.18)
  })
}

/** Two falling tones: a share stopped. */
export function playScreenShareStop(): void {
  playOnce('screen-share-stop', (c) => {
    tone(c, 494, 0.1, 0.1, 0)
    tone(c, 392, 0.08, 0.14, 0.09)
  })
}

/** Two even taps: someone is asking to join. */
export function playKnock(): void {
  playOnce('knock', (c) => {
    tone(c, 659, 0.12, 0.08, 0)
    tone(c, 659, 0.12, 0.08, 0.16)
  })
}
