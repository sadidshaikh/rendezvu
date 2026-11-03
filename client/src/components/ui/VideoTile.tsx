import { useEffect, useRef, useState } from 'react'
import { Loader2, Mic, MicOff, Pin, PinOff } from 'lucide-react'
import { Avatar } from '@/components/ui/Avatar'
import { StreamVideo } from '@/components/ui/StreamVideo'
import { initialsOf } from '@/lib/avatar'
import { markFirstRemoteFrame } from '@/lib/ttfm'
import { cn } from '@/lib/utils'
import type { QualityGrade } from '@rendezvu/protocol'
import { QUALITY_LABEL, QualityDot } from './QualityDot'

// The sender already holds `speaking` for 280 ms. Holding again here keeps a
// `false` that arrives a moment early from making the outline flicker.
const REMOTE_HOLD_MS = 280

interface VideoTileProps {
  name: string
  isLocal?: boolean
  stream: MediaStream | null
  /** Whether this person says their video is on: camera on, or sharing. */
  wantsVideo: boolean
  muted: boolean
  speaking: boolean
  screenSharing?: boolean
  onPin?: () => void
  pinned?: boolean
  /** A thumbnail in the pin strip: initials, no badges. */
  compact?: boolean
  /** Their media is being repaired. The video stays on its last frame meanwhile. */
  reconnecting?: boolean
  /** Our connection to them. The dot shows only for medium and poor. */
  quality?: QualityGrade
}

/**
 * One person: their video once it is really playing, otherwise their avatar.
 * Badges show mic, sharing and speaking; the pin button makes them large.
 */
export function VideoTile({
  name: rawName,
  isLocal = false,
  stream,
  wantsVideo,
  muted,
  speaking: speakingNow,
  screenSharing = false,
  onPin,
  pinned = false,
  compact = false,
  reconnecting = false,
  quality,
}: VideoTileProps) {
  const name = rawName || (isLocal ? 'You' : 'Participant')
  const label = isLocal ? `${name} (you)` : name

  // A track can end while the stream stays the same object (a device unplugged).
  const [liveVideo, setLiveVideo] = useState(() => hasLiveVideo(stream))
  useEffect(() => {
    const sync = () => setLiveVideo(hasLiveVideo(stream))
    const tracks = stream?.getVideoTracks() ?? []
    sync()
    tracks.forEach((t) => t.addEventListener('ended', sync))
    stream?.addEventListener('addtrack', sync)
    stream?.addEventListener('removetrack', sync)
    return () => {
      tracks.forEach((t) => t.removeEventListener('ended', sync))
      stream?.removeEventListener('addtrack', sync)
      stream?.removeEventListener('removetrack', sync)
    }
  }, [stream])

  // Shown only once this exact stream has played its first frame.
  const [playingStream, setPlayingStream] = useState<MediaStream | null>(null)
  const renderVideo = wantsVideo && liveVideo && stream !== null
  const showingVideo = renderVideo && playingStream === stream

  const [heldSpeaking, setHeldSpeaking] = useState(false)
  const holdTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    if (isLocal) return
    if (speakingNow) {
      clearTimeout(holdTimer.current)
      setHeldSpeaking(true)
    } else {
      holdTimer.current = setTimeout(() => setHeldSpeaking(false), REMOTE_HOLD_MS)
    }
    return () => clearTimeout(holdTimer.current)
  }, [isLocal, speakingNow])
  const speaking = !muted && (isLocal ? speakingNow : heldSpeaking)

  return (
    <div
      role="group"
      aria-label={speaking ? `${label}, speaking` : label}
      className={cn(
        'group tile-in relative h-full w-full overflow-hidden rounded-2xl border',
        'bg-[linear-gradient(160deg,hsl(var(--surface-2)),hsl(var(--surface-3)))] transition-[border-color,box-shadow] duration-150',
        speaking ? 'border-primary shadow-[inset_0_0_0_1px_hsl(var(--primary))]' : 'border-border',
        pinned && !speaking && 'ring-2 ring-primary/60',
      )}
    >
      {!showingVideo && (
        <div aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
          {compact ? (
            <Avatar name={name} style={{ width: 32, height: 32, fontSize: 12 }} />
          ) : (
            <Avatar
              name={name}
              style={{
                width: '22%',
                aspectRatio: '1/1',
                minWidth: 44,
                minHeight: 44,
                maxWidth: 108,
                maxHeight: 108,
                fontSize: 'clamp(16px, 3.8vw, 38px)',
              }}
            />
          )}
        </div>
      )}

      {renderVideo && (
        <StreamVideo
          stream={stream}
          fit={screenSharing ? 'contain' : 'adaptive'}
          onPlaying={() => {
            setPlayingStream(stream)
            if (!isLocal) markFirstRemoteFrame()
          }}
          visible={showingVideo}
          className={screenSharing ? 'bg-black' : undefined}
        />
      )}

      {reconnecting && (
        <div
          role="status"
          className={cn(
            'glass-pill absolute top-2.5 left-2.5 z-10 gap-1.5',
            compact ? 'size-6 justify-center p-0' : 'px-2 py-0.5 text-[12px]',
          )}
        >
          <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
          <span className={compact ? 'sr-only' : undefined}>Reconnecting…</span>
        </div>
      )}

      {!isLocal && wantsVideo && !showingVideo && !compact && !reconnecting && (
        <span role="status" className="absolute inset-x-0 bottom-10 text-center text-xs text-muted-foreground">
          Waiting for video…
        </span>
      )}

      {!compact && (
        <div className="absolute top-2.5 right-2.5 z-10 flex items-center gap-1.5">
          {(quality === 'medium' || quality === 'poor') && (
            <div
              title={QUALITY_LABEL[quality]}
              className="flex size-7 items-center justify-center rounded-full border border-white/25 bg-zinc-950/75 shadow-lg shadow-black/25 backdrop-blur-md"
            >
              <QualityDot quality={quality} />
            </div>
          )}
          <div
            role="img"
            aria-label={muted ? 'Microphone muted' : 'Microphone on'}
            className={cn(
              'flex size-7 items-center justify-center rounded-full border text-white shadow-lg shadow-black/25 backdrop-blur-md',
              muted ? 'border-red-300/35 bg-red-600/85' : 'border-white/25 bg-zinc-950/75',
            )}
          >
            {muted ? <MicOff className="size-3.5" strokeWidth={2.4} /> : <Mic className="size-3.5" strokeWidth={2.4} />}
          </div>
        </div>
      )}

      {onPin && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onPin()
          }}
          aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`}
          className={cn(
            'glass-pill absolute right-2.5 bottom-2.5 z-10 flex size-7 cursor-pointer items-center justify-center transition-opacity',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            // Always visible on touch screens, which have no hover.
            pinned ? 'text-primary' : 'text-foreground sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100',
          )}
        >
          {pinned ? <PinOff className="size-3.5" aria-hidden="true" /> : <Pin className="size-3.5" aria-hidden="true" />}
        </button>
      )}

      <div
        aria-hidden="true"
        className={cn(
          'glass-pill absolute bottom-2 left-2 gap-1 px-2 py-0.5',
          compact ? 'text-[10px]' : 'max-w-[calc(100%-3.5rem)] overflow-hidden text-[12px]',
        )}
      >
        {speaking && !compact && (
          <span className="flex h-3 shrink-0 items-end gap-[2px]">
            <span className="audio-bar" style={{ height: 8 }} />
            <span className="audio-bar" style={{ height: 10 }} />
            <span className="audio-bar" style={{ height: 7 }} />
          </span>
        )}
        {compact ? (
          <span>{initialsOf(name)}</span>
        ) : (
          <span className="min-w-0 truncate">{screenSharing ? `${label} • Screen` : label}</span>
        )}
      </div>
    </div>
  )
}

function hasLiveVideo(stream: MediaStream | null): boolean {
  return !!stream?.getVideoTracks().some((t) => t.readyState === 'live')
}
