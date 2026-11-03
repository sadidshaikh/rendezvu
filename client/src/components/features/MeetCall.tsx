import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Loader2, Monitor, PhoneOff, Settings } from 'lucide-react'
import { CameraButton } from '@/components/ui/CameraButton'
import { ConnectionBanner } from '@/components/ui/ConnectionBanner'
import { DeviceErrorNotice } from '@/components/ui/DeviceErrorNotice'
import { FlipCameraButton } from '@/components/ui/FlipCameraButton'
import { MicButton } from '@/components/ui/MicButton'
import { RemoteAudio } from '@/components/ui/RemoteAudio'
import { ScreenShareButton, canShareScreen } from '@/components/ui/ScreenShareButton'
import { KnockPrompt } from '@/components/ui/KnockPrompt'
import { SettingsPanel } from '@/components/ui/SettingsPanel'
import { ShareLinkButton } from '@/components/ui/ShareLinkButton'
import { VideoGrid } from '@/components/ui/VideoGrid'
import { VideoTile } from '@/components/ui/VideoTile'
import { useCallControls } from '@/hooks/use-call-controls'
import { useMediaDevices } from '@/hooks/use-media-devices'
import { playLeaveCall } from '@/lib/sounds'
import type { ConnState, SignalingClient } from '@/services/signaling/client'
import { usePeerStore } from '@/stores/peer'

const LOCAL_TILE_ID = 'local'

interface MeetCallProps {
  meetCode: string
  userName: string
  client: SignalingClient | null
  connState: ConnState
  reconnectAttempt: number
  onLeave: () => void
}

/**
 * The in-call screen: a grid that fits everyone, a tile per person following
 * their `peer-state`, a hidden audio element per remote person, and the
 * call controls.
 */
export default function MeetCall({ meetCode, userName, client, connState, reconnectAttempt, onLeave }: MeetCallProps) {
  const inRoom = usePeerStore((s) => s.inRoom)
  const peers = usePeerStore((s) => s.peers)
  const localStream = usePeerStore((s) => s.localStream)
  const screenTrack = usePeerStore((s) => s.screenTrack)
  const remoteStreams = usePeerStore((s) => s.remoteStreams)
  const mediaReconnecting = usePeerStore((s) => s.mediaReconnecting)
  const peerStats = usePeerStore((s) => s.peerStats)
  const controls = useCallControls(client, meetCode)
  const devices = useMediaDevices(localStream)
  const [showSettings, setShowSettings] = useState(false)
  const [pinnedId, setPinnedId] = useState<string | null>(null)

  // While sharing, our own tile shows the screen.
  const screenStream = useMemo(() => (screenTrack ? new MediaStream([screenTrack]) : null), [screenTrack])

  const remotePeers = [...peers.values()]
  const alone = remotePeers.length === 0
  const participantCount = remotePeers.length + 1

  // A pin only counts while that person is here, so someone leaving unpins
  // them. Pinning yourself only means something with others around.
  const pin = pinnedId === LOCAL_TILE_ID ? (alone ? null : pinnedId) : pinnedId && peers.has(pinnedId) ? pinnedId : null
  // Two people: the other person large, you as a thumbnail.
  const focusId = pin ?? (remotePeers.length === 1 ? remotePeers[0]!.id : null)
  const togglePin = (id: string) => setPinnedId(pin === id ? null : id)

  const handleLeave = () => {
    playLeaveCall()
    onLeave()
  }

  return (
    <div className="call-stage flex h-dvh w-full flex-col overflow-hidden text-foreground">
      {/* The picker previews this screen, call included. Covering it keeps the
          call out of its own preview and out of the share's first frames. */}
      {controls.shareBusy && <div className="fixed inset-0 z-[999] bg-background" aria-hidden="true" />}

      {controls.deviceError && (
        <div className="mx-auto w-full max-w-md shrink-0 px-4 pt-3">
          <DeviceErrorNotice
            message={controls.deviceError}
            onSettings={() => setShowSettings(true)}
            onDismiss={controls.clearDeviceError}
          />
        </div>
      )}

      <header className="z-20 flex shrink-0 items-center justify-between gap-3 px-4 pt-4 pb-2">
        <ShareLinkButton url={window.location.href} label={meetCode} className="min-w-0" />
        <div className="flex items-center gap-2">
          {controls.isSharing && (
            <div className="glass-pill gap-1.5 px-3 py-1.5 text-xs font-medium text-primary">
              <Monitor className="size-3.5 shrink-0" aria-hidden="true" />
              Presenting
            </div>
          )}
          <div className="glass-pill px-3 py-1.5 text-xs text-muted-foreground">
            {inRoom ? `${participantCount} ${participantCount === 1 ? 'participant' : 'participants'}` : '–'}
          </div>
        </div>
      </header>

      <ConnectionBanner connState={connState} reconnectAttempt={reconnectAttempt} />
      <KnockPrompt client={client} roomId={meetCode} />

      <main className="flex min-h-0 flex-1 flex-col px-3">
        {!inRoom ? (
          <Centered>
            <div role="status" className="flex items-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Joining…
            </div>
          </Centered>
        ) : (
          <VideoGrid gap={8} tileAspect={16 / 9} focusKey={focusId}>
            <VideoTile
              key={LOCAL_TILE_ID}
              isLocal
              name={userName}
              stream={screenStream ?? localStream}
              wantsVideo={controls.isSharing || !controls.isVideoOff}
              muted={controls.isMuted}
              speaking={controls.speaking}
              screenSharing={controls.isSharing}
              onPin={alone ? undefined : () => togglePin(LOCAL_TILE_ID)}
              pinned={pin === LOCAL_TILE_ID}
              compact={focusId !== null && focusId !== LOCAL_TILE_ID}
            />
            {remotePeers.map((p) => (
              <VideoTile
                key={p.id}
                name={p.name}
                stream={remoteStreams.get(p.id) ?? null}
                // Their stated camera or share decides; the track alone can't
                // tell "camera off" from the black frames sent in its place.
                wantsVideo={p.video || p.screenSharing}
                quality={peerStats.get(p.id)?.quality}
                muted={!p.audio}
                speaking={p.speaking}
                screenSharing={p.screenSharing}
                onPin={() => togglePin(p.id)}
                pinned={pin === p.id}
                reconnecting={mediaReconnecting.has(p.id)}
                compact={focusId !== null && focusId !== p.id}
              />
            ))}
          </VideoGrid>
        )}
      </main>

      {inRoom && alone && (
        <div className="flex shrink-0 justify-center px-4 py-2">
          <p className="glass-pill px-4 py-2 text-xs text-muted-foreground">Share the code above to invite someone</p>
        </div>
      )}

      {/* Sound for everyone else, independent of their tiles. Our own audio is never played back. */}
      {[...remoteStreams].map(([peerId, stream]) => (
        <RemoteAudio key={peerId} stream={stream} />
      ))}

      <footer className="flex shrink-0 justify-center py-3" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
        <div className="glass-pill gap-2 px-2 py-2 shadow-xl shadow-[hsl(var(--shadow-color))]/25">
          <MicButton onClick={controls.handleMicToggle} on={!controls.isMuted} busy={controls.micBusy} />
          <CameraButton onClick={controls.handleCameraToggle} on={!controls.isVideoOff} busy={controls.cameraBusy} />
          <button
            type="button"
            onClick={() => setShowSettings((open) => !open)}
            aria-label="Audio and video settings"
            title="Audio and video settings"
            aria-expanded={showSettings}
            aria-controls="call-settings-panel"
            className="ctrl-btn ctrl-btn-on size-11"
          >
            <Settings className="size-4 sm:size-5" aria-hidden="true" />
          </button>
          {devices.videoInputs.length >= 2 && !controls.isVideoOff && <FlipCameraButton onClick={controls.handleFlip} />}
          {canShareScreen() && (
            <ScreenShareButton onClick={controls.handleScreenShare} sharing={controls.isSharing} busy={controls.shareBusy} />
          )}
          <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
          <button
            type="button"
            onClick={handleLeave}
            aria-label="Leave call"
            className="ctrl-btn ctrl-btn-off h-11 gap-1.5 rounded-full px-4 text-sm font-semibold sm:px-5"
          >
            <PhoneOff className="size-4 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">Leave</span>
          </button>
        </div>
      </footer>

      {showSettings && <SettingsPanel inCall onClose={() => setShowSettings(false)} />}
    </div>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center">{children}</div>
}
