import { Loader2, MicOff, PhoneOff, Users } from 'lucide-react'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/button'
import { RemoteAudio } from '@/components/ui/RemoteAudio'
import { ShareLinkButton } from '@/components/ui/ShareLinkButton'
import { StreamVideo } from '@/components/ui/StreamVideo'
import { useAudioLevel } from '@/hooks/use-audio-level'
import { cn } from '@/lib/utils'
import type { ConnState } from '@/services/signaling/client'
import { useMeetStore } from '@/stores/meet'
import { usePeerStore } from '@/stores/peer'

interface MeetCallProps {
  meetCode: string
  userName: string
  connState: ConnState
  onLeave: () => void
}

interface Participant {
  id: string
  name: string
  audio: boolean
  isLocal: boolean
  /** Only a stream with a live video track; otherwise the tile shows the avatar. */
  video: MediaStream | null
}

/**
 * The in-call screen: a tile per person with their video or avatar, plus a
 * hidden audio element per remote person. Mic icons show the state each
 * person joined with, until live updates arrive in Phase 6.
 */
export default function MeetCall({ meetCode, userName, connState, onLeave }: MeetCallProps) {
  const inRoom = usePeerStore((s) => s.inRoom)
  const peers = usePeerStore((s) => s.peers)
  const localStream = usePeerStore((s) => s.localStream)
  const remoteStreams = usePeerStore((s) => s.remoteStreams)
  const isMuted = useMeetStore((s) => s.isMuted)
  const isVideoOff = useMeetStore((s) => s.isVideoOff)
  const { speaking } = useAudioLevel(localStream, !isMuted)

  const participants: Participant[] = [
    { id: 'local', name: userName, audio: !isMuted, isLocal: true, video: isVideoOff ? null : withVideo(localStream) },
    ...[...peers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      audio: p.audio,
      isLocal: false,
      video: withVideo(remoteStreams.get(p.id)),
    })),
  ]

  return (
    <main className="call-stage flex min-h-screen flex-1 flex-col">
      <header className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <span className="meet-code truncate text-sm text-muted-foreground">{meetCode}</span>
          <ShareLinkButton url={window.location.href} />
        </div>
        <span className="glass-pill gap-1.5 px-3 py-1.5 text-xs text-muted-foreground">
          <Users className="size-3.5" aria-hidden="true" />
          {inRoom ? participants.length : '–'}
        </span>
      </header>

      <section className="flex flex-1 items-center justify-center px-4 pb-4 sm:px-6">
        {connState === 'disconnected' ? (
          <StatusMessage title="Lost connection to the server" body="Leave and rejoin to continue." />
        ) : !inRoom ? (
          <div role="status" className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Joining…
          </div>
        ) : (
          <ul className="grid w-full max-w-5xl grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Participants">
            {participants.map((p) => (
              <li
                key={p.id}
                className={cn('tile-in app-panel relative overflow-hidden rounded-2xl', p.isLocal && speaking && 'speaking-ring')}
                style={{ aspectRatio: '16/9' }}
              >
                {p.video ? (
                  <StreamVideo stream={p.video} />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center bg-[linear-gradient(160deg,hsl(var(--surface-2)),hsl(var(--surface-3)))]">
                    <Avatar name={p.name} size="lg" />
                  </div>
                )}
                <div className="glass-pill absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)] gap-1.5 px-2.5 py-1 text-[13px]">
                  {!p.audio && <MicOff className="size-3.5 shrink-0 text-destructive" aria-label="Muted" />}
                  <span className="min-w-0 truncate">{p.name || 'Guest'}</span>
                  {p.isLocal && <span className="text-muted-foreground">(You)</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Sound for everyone else, independent of their tiles. Our own audio is never played back. */}
      {[...remoteStreams].map(([peerId, stream]) => (
        <RemoteAudio key={peerId} stream={stream} />
      ))}

      <footer className="flex justify-center px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <Button variant="destructive" size="lg" onClick={onLeave} aria-label="Leave call" className="rounded-full px-6">
          <PhoneOff />
          Leave
        </Button>
      </footer>
    </main>
  )
}

function StatusMessage({ title, body }: { title: string; body: string }) {
  return (
    <div role="alert" className="experience-card max-w-sm p-6 text-center">
      <p className="font-semibold text-foreground">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </div>
  )
}

function withVideo(stream: MediaStream | null | undefined): MediaStream | null {
  return stream?.getVideoTracks().some((t) => t.readyState === 'live') ? stream : null
}
