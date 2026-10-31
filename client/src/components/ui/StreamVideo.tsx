import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/** `adaptive` crops a camera unless that would cut away too much of it. */
export type VideoFit = 'cover' | 'contain' | 'adaptive'

interface StreamVideoProps {
  stream: MediaStream
  fit?: VideoFit
  /** Fires once the first frame is on screen. Until then a <video> shows black. */
  onPlaying?: () => void
  /** Hidden still plays, so the frame is ready the moment it's shown. */
  visible?: boolean
  className?: string
}

// A 4:3 webcam in a 16:9 tile keeps 75% of its frame when cropped and looks
// natural. An upright phone keeps about 32%: a zoomed-in chin.
const MIN_VISIBLE_COVER_FRACTION = 0.7

export function resolveVideoFit(videoW: number, videoH: number, tileW: number, tileH: number): 'cover' | 'contain' {
  if (videoW <= 0 || videoH <= 0 || tileW <= 0 || tileH <= 0) return 'cover'
  const ratio = videoW / videoH / (tileW / tileH)
  return Math.min(ratio, 1 / ratio) >= MIN_VISIBLE_COVER_FRACTION ? 'cover' : 'contain'
}

/** Plays a stream's video, always muted: sound goes through RemoteAudio, and our own must never play back. */
export function StreamVideo({ stream, fit = 'cover', onPlaying, visible = true, className }: StreamVideoProps) {
  const ref = useRef<HTMLVideoElement>(null)
  const [resolvedFit, setResolvedFit] = useState<'cover' | 'contain'>(fit === 'contain' ? 'contain' : 'cover')

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // A new stream object each time, so the element always picks up a track
    // that was added to or removed from the one it was given.
    const attach = () => {
      const tracks = stream.getVideoTracks()
      el.srcObject = tracks.length > 0 ? new MediaStream(tracks) : null
      if (!el.srcObject || !el.paused) return
      el.play().catch(() => {
        // Autoplay blocked: try again on the next tap.
        document.addEventListener('pointerdown', () => el.play().catch(() => {}), { once: true })
      })
    }
    attach()
    stream.addEventListener('addtrack', attach)
    stream.addEventListener('removetrack', attach)
    return () => {
      stream.removeEventListener('addtrack', attach)
      stream.removeEventListener('removetrack', attach)
    }
  }, [stream])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const sync = () =>
      setResolvedFit(fit === 'adaptive' ? resolveVideoFit(el.videoWidth, el.videoHeight, el.clientWidth, el.clientHeight) : fit)
    sync()
    // The camera's size can change mid-call (a phone turned sideways), and so can the tile's.
    el.addEventListener('loadedmetadata', sync)
    el.addEventListener('resize', sync)
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    return () => {
      el.removeEventListener('loadedmetadata', sync)
      el.removeEventListener('resize', sync)
      observer.disconnect()
    }
  }, [fit])

  return (
    <video
      ref={ref}
      autoPlay
      muted
      playsInline
      onPlaying={onPlaying}
      style={{ visibility: visible ? 'visible' : 'hidden' }}
      className={cn(
        'pointer-events-none absolute inset-0 h-full w-full',
        resolvedFit === 'contain' ? 'object-contain' : 'object-cover',
        className,
      )}
    />
  )
}
