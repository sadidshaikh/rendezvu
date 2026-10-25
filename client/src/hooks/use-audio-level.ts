import { useEffect, useState } from 'react'
import { getSharedAudioContext } from '@/lib/audio-context'

const DEFAULT_THRESHOLD = 0.035
// Keeps "speaking" on through the short gaps between words.
const HOLD_MS = 280
const SAMPLE_EVERY_MS = 30

export interface AudioLevel {
  speaking: boolean
  /** 0–1, smoothed. */
  level: number
}

export function useAudioLevel(stream: MediaStream | null, active: boolean, threshold = DEFAULT_THRESHOLD): AudioLevel {
  const [speaking, setSpeaking] = useState(false)
  const [level, setLevel] = useState(0)

  useEffect(() => {
    const track = stream?.getAudioTracks()[0]
    const ctx = getSharedAudioContext()
    if (!active || !track || !ctx) {
      setSpeaking(false)
      setLevel(0)
      return
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})

    // Analyse a clone. Chromium can turn off hardware echo cancellation on a
    // track wired into an AudioContext; the clone takes that hit and the
    // original, the one that gets published, keeps it.
    const analysisTrack = track.clone()
    const source = ctx.createMediaStreamSource(new MediaStream([analysisTrack]))
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.6
    source.connect(analyser)

    const data = new Uint8Array(analyser.fftSize)
    let lastLoudAt = 0
    let current = false

    const sample = () => {
      analyser.getByteTimeDomainData(data)
      let sumSq = 0
      for (const byte of data) {
        const v = (byte - 128) / 128
        sumSq += v * v
      }
      const rms = Math.sqrt(sumSq / data.length)
      // Useful range is threshold..0.3; map it to 0–1.
      setLevel(Math.min(1, Math.max(0, (rms - threshold) / (0.3 - threshold))))
      const now = performance.now()
      if (rms > threshold) {
        lastLoudAt = now
        if (!current) {
          current = true
          setSpeaking(true)
        }
      } else if (current && now - lastLoudAt > HOLD_MS) {
        current = false
        setSpeaking(false)
      }
    }
    // A timer, not requestAnimationFrame: rAF stops in background tabs, which
    // would freeze speaking detection during a call.
    const timer = window.setInterval(sample, SAMPLE_EVERY_MS)

    return () => {
      clearInterval(timer)
      source.disconnect()
      analysisTrack.stop()
      setSpeaking(false)
      setLevel(0)
    }
  }, [stream, active, threshold])

  return { speaking, level }
}
