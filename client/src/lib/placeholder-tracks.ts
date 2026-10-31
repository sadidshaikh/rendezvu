import { getSharedAudioContext } from './audio-context'

// The camera's size and rate. Some browsers refuse to swap between very
// different sizes on one sender without renegotiating.
const WIDTH = 960
const HEIGHT = 540
const FRAME_RATE = 24

/** Black frames, sent while the camera is off so the video sender stays alive. */
export function createBlackVideoTrack(): MediaStreamTrack | null {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = WIDTH
    canvas.height = HEIGHT
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, WIDTH, HEIGHT)
    }
    return canvas.captureStream(FRAME_RATE).getVideoTracks()[0] ?? null
  } catch {
    return null
  }
}

/** Silence, sent while muted so the audio sender stays alive. */
export function createSilentAudioTrack(): MediaStreamTrack | null {
  try {
    return getSharedAudioContext()?.createMediaStreamDestination().stream.getAudioTracks()[0] ?? null
  } catch {
    return null
  }
}
