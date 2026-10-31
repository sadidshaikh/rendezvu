import { useMemo, useState } from 'react'
import { Loader2, MicOff, MonitorUp, PhoneOff, Settings, Users } from 'lucide-react'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/button'
import { CameraButton } from '@/components/ui/CameraButton'
import { DeviceErrorNotice } from '@/components/ui/DeviceErrorNotice'
import { FlipCameraButton } from '@/components/ui/FlipCameraButton'
import { MicButton } from '@/components/ui/MicButton'
import { RemoteAudio } from '@/components/ui/RemoteAudio'
import { ScreenShareButton, canShareScreen } from '@/components/ui/ScreenShareButton'
import { SettingsPanel } from '@/components/ui/SettingsPanel'
import { ShareLinkButton } from '@/components/ui/ShareLinkButton'
import { StreamVideo } from '@/components/ui/StreamVideo'
import { useCallControls } from '@/hooks/use-call-controls'
import { useMediaDevices } from '@/hooks/use-media-devices'
import { cn } from '@/lib/utils'
import type { ConnState, SignalingClient } from '@/services/signaling/client'
import { usePeerStore } from '@/stores/peer'

interface MeetCallProps {
  meetCode: string
  userName: string
  client: SignalingClient | null
  connState: ConnState
  onLeave: () => void
}

interface Participant {
  id: string
  name: string
  audio: boolean
  speaking: boolean
  screenSharing: boolean
  isLocal: boolean
  /** Only a stream with a live video track; otherwise the tile shows the avatar. */
  video: MediaStream | null
}

/**
 * The in-call screen: a tile per person with their video, screen or avatar,
 * a hidden audio element per remote person, and the call controls. Tiles
 * follow each person's `peer-state`, so a camera turned off shows the avatar
 * rather than the black frames that keep its sender alive.
 */
export default function MeetCall({ meetCode, userName, client, connState, onLeave }: MeetCallProps) {
  const inRoom = usePeerStore((s) => s.inRoom)
  const peers = usePeerStore((s) => s.peers)
  const localStream = usePeerStore((s) => s.localStream)
  const screenTrack = usePeerStore((s) => s.screenTrack)
  const remoteStreams = usePeerStore((s) => s.remoteStreams)
  const controls = useCallControls(client, meetCode)
  const devices = useMediaDevices(localStream)
  const [showSettings, setShowSettings] = useState(false)

  const screenStream = useMemo(() => (screenTrack ? new MediaStream([screenTrack]) : null), [screenTrack])

  const participants: Participant[] = [
    {
      id: 'local',
      name: userName,
      audio: !controls.isMuted,
      speaking: controls.speaking,
      screenSharing: controls.isSharing,
      isLocal: true,
      video: screenStream ?? (controls.isVideoOff ? null : withVideo(localStream)),
    },
    ...[...peers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      audio: p.audio,
      speaking: p.audio && p.speaking,
      screenSharing: p.screenSharing,
      isLocal: false,
      // Their stated camera or share decides; the track alone can't tell
      // "camera off" from the black frames sent in its place.
      video: p.video || p.screenSharing ? withVideo(remoteStreams.get(p.id)) : null,
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
                className={cn('tile-in app-panel relative overflow-hidden rounded-2xl', p.speaking && 'speaking-ring')}
                style={{ aspectRatio: '16/9' }}
              >
                {p.video ? (
                  // A screen is shown whole; a face fills the tile.
                  <StreamVideo stream={p.video} className={p.screenSharing ? 'bg-black object-contain' : undefined} />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center bg-[linear-gradient(160deg,hsl(var(--surface-2)),hsl(var(--surface-3)))]">
                    <Avatar name={p.name} size="lg" />
                  </div>
                )}
                <div className="glass-pill absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)] gap-1.5 px-2.5 py-1 text-[13px]">
                  {!p.audio && <MicOff className="size-3.5 shrink-0 text-destructive" aria-label="Muted" />}
                  {p.screenSharing && <MonitorUp className="size-3.5 shrink-0 text-primary" aria-label="Sharing screen" />}
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

      {controls.deviceError && (
        <div className="mx-auto w-full max-w-md px-4">
          <DeviceErrorNotice
            message={controls.deviceError}
            onSettings={() => setShowSettings(true)}
            onDismiss={controls.clearDeviceError}
          />
        </div>
      )}

      <footer className="flex flex-wrap items-center justify-center gap-2 px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <MicButton onClick={controls.handleMicToggle} on={!controls.isMuted} busy={controls.micBusy} />
        <CameraButton onClick={controls.handleCameraToggle} on={!controls.isVideoOff} busy={controls.cameraBusy} />
        {devices.videoInputs.length >= 2 && !controls.isVideoOff && <FlipCameraButton onClick={controls.handleFlip} />}
        {canShareScreen() && (
          <ScreenShareButton onClick={controls.handleScreenShare} sharing={controls.isSharing} busy={controls.shareBusy} />
        )}
        <button
          type="button"
          onClick={() => setShowSettings((open) => !open)}
          aria-label="Settings"
          title="Settings"
          aria-expanded={showSettings}
          aria-controls="call-settings-panel"
          className="ctrl-btn ctrl-btn-on h-11 w-11"
        >
          <Settings className="h-4 w-4 sm:h-5 sm:w-5" aria-hidden="true" />
        </button>
        <Button variant="destructive" size="lg" onClick={onLeave} aria-label="Leave call" className="ml-2 rounded-full px-6">
          <PhoneOff />
          Leave
        </Button>
      </footer>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
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
