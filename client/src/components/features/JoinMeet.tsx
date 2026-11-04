import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { CalendarOff, Clock, Loader2, Settings } from 'lucide-react'
import { Avatar } from '@/components/ui/Avatar'
import { Link } from 'react-router'
import { ServerWakeNotice } from '@/components/ui/ServerWakeNotice'
import { Wordmark } from '@/components/ui/Wordmark'
import { useServerState, wakeServer } from '@/lib/server-wake'
import { Button } from '@/components/ui/button'
import { CameraButton } from '@/components/ui/CameraButton'
import { Collapsible } from '@/components/ui/Collapsible'
import { DeviceErrorNotice } from '@/components/ui/DeviceErrorNotice'
import { DevicePickers, hasAnyDevice } from '@/components/ui/DevicePickers'
import { FlipCameraButton } from '@/components/ui/FlipCameraButton'
import { Input } from '@/components/ui/input'
import { MicButton } from '@/components/ui/MicButton'
import { MicLevelMeter } from '@/components/ui/MicLevelMeter'
import { SettingsPanel } from '@/components/ui/SettingsPanel'
import { ShareLinkButton } from '@/components/ui/ShareLinkButton'
import { StreamVideo } from '@/components/ui/StreamVideo'
import { useAudioLevel } from '@/hooks/use-audio-level'
import { useMediaDevices } from '@/hooks/use-media-devices'
import { resumeSharedAudioContext } from '@/lib/audio-context'
import { playJoinCall } from '@/lib/sounds'
import { markJoinStarted } from '@/lib/ttfm'
import { describeMediaError } from '@/lib/media-errors'
import { meetCodePattern } from '@/lib/room-routes'
import { cn } from '@/lib/utils'
import { fetchRoomStatus, type LobbyRoomStatus } from '@/services/api/room'
import { getRoomToken } from '@/services/api/room-token'
import { useJoinMeetStore } from '@/stores/join-meet'
import { useMeetStore } from '@/stores/meet'
import { usePeerStore } from '@/stores/peer'

interface JoinMeetProps {
  meetCode: string
  /** Why the last join attempt was refused, shown in place of the join form. */
  roomError: string | null
  onJoin: (name: string) => void
}

export default function JoinMeet({ meetCode, roomError, onJoin }: JoinMeetProps) {
  const { userName, setUserName } = useJoinMeetStore()
  // Without a token for this room, joining is asking: someone inside lets you in.
  const [hasToken] = useState(() => getRoomToken(meetCode) !== null)
  const [roomStatus, setRoomStatus] = useState<LobbyRoomStatus | null>(null)
  const [statusChecked, setStatusChecked] = useState(false)
  // Bumped to ask for the room's status again, once a sleeping server is up.
  const [statusAttempt, setStatusAttempt] = useState(0)
  const server = useServerState()
  useEffect(() => {
    if (server === 'ready' && roomStatus?.status === 'unreachable') setStatusAttempt((n) => n + 1)
  }, [server, roomStatus?.status])
  const [deviceError, setDeviceError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  // A device is opening (the permission prompt may be up). Its button waits.
  const [micBusy, setMicBusy] = useState(false)
  const [cameraBusy, setCameraBusy] = useState(false)
  const canJoinMeet = meetCodePattern.test(meetCode)

  const localStream = usePeerStore((s) => s.localStream)
  const enableMic = usePeerStore((s) => s.enableMic)
  const disableMic = usePeerStore((s) => s.disableMic)
  const enableCamera = usePeerStore((s) => s.enableCamera)
  const disableCamera = usePeerStore((s) => s.disableCamera)
  const switchCamera = usePeerStore((s) => s.switchCamera)
  const { isMuted, isVideoOff, toggleMute, toggleVideo } = useMeetStore()
  const devices = useMediaDevices(localStream)
  const { speaking, level } = useAudioLevel(localStream, !isMuted)

  useEffect(() => {
    setRoomStatus(null)
    setStatusChecked(false)
    if (!canJoinMeet) {
      setStatusChecked(true)
      return
    }
    let cancelled = false
    fetchRoomStatus(meetCode)
      .then((status) => {
        if (cancelled) return
        setRoomStatus(status)
        if (status.status === 'unreachable') wakeServer(true)
      })
      .finally(() => {
        if (!cancelled) setStatusChecked(true)
      })
    return () => {
      cancelled = true
    }
  }, [canJoinMeet, meetCode, statusAttempt])

  // Intent flips only once the device is really running, so the button never
  // says "on" with nothing behind it.
  const handleMicToggle = async () => {
    setDeviceError(null)
    if (!isMuted) {
      disableMic()
      toggleMute()
      return
    }
    resumeSharedAudioContext()
    setMicBusy(true)
    const result = await enableMic()
    setMicBusy(false)
    if (result.status === 'ok') toggleMute()
    else if (result.status === 'failed') setDeviceError(describeMediaError('mic', result.error))
  }

  const handleCameraToggle = async () => {
    setDeviceError(null)
    if (!isVideoOff) {
      disableCamera()
      toggleVideo()
      return
    }
    setCameraBusy(true)
    const result = await enableCamera()
    setCameraBusy(false)
    if (result.status === 'ok') toggleVideo()
    else if (result.status === 'failed') setDeviceError(describeMediaError('camera', result.error))
  }

  const handleFlip = async () => {
    if (!(await switchCamera())) toast.error('Could not switch camera.')
  }

  const joinName = userName.trim()
  const handleJoin = () => {
    if (!joinName || !canJoinMeet) return
    // Inside the click, so iOS lets the shared AudioContext run.
    resumeSharedAudioContext()
    // A guest hears it on being let in instead, and its clock starts there.
    if (hasToken) {
      playJoinCall()
      markJoinStarted()
    }
    onJoin(joinName)
  }

  const previewName = joinName || 'You'
  const blocked = !canJoinMeet
    ? { title: 'This room is not available', body: 'Check the meeting link or ask the host for a new one.' }
    : roomError
      ? { title: 'This room is not available', body: roomError }
      : roomStatus && roomStatus.status !== 'open' && roomStatus.status !== 'unavailable' && roomStatus.status !== 'unreachable'
        ? statusCopy(roomStatus)
        : null

  return (
    <main className="call-stage relative flex flex-1 flex-col overflow-y-auto">
      <header className="mx-auto flex w-full max-w-5xl items-center px-4 pt-5">
        <Wordmark />
      </header>
      <div className="mx-auto flex w-full max-w-5xl flex-1 items-start px-4 py-6 sm:items-center sm:py-10 lg:py-14">
        <div className="grid w-full grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <div
              className={cn('tile-in app-panel relative w-full overflow-hidden rounded-2xl', speaking && 'speaking-ring')}
              style={{ aspectRatio: '16/9' }}
            >
              <button
                type="button"
                onClick={() => setShowSettings((open) => !open)}
                aria-expanded={showSettings}
                aria-controls="call-settings-panel"
                aria-label="Open settings"
                className="ctrl-btn ctrl-btn-on absolute top-2.5 right-2.5 z-10 h-8 w-8"
              >
                <Settings className="h-4 w-4" />
              </button>

              {isVideoOff || !localStream ? (
                <div className="absolute inset-0 flex items-center justify-center bg-[linear-gradient(160deg,hsl(var(--surface-2)),hsl(var(--surface-3)))]">
                  <Avatar
                    name={previewName}
                    label={previewName}
                    style={{
                      width: '22%',
                      aspectRatio: '1/1',
                      minWidth: 64,
                      minHeight: 64,
                      maxWidth: 120,
                      maxHeight: 120,
                      fontSize: 'clamp(20px, 4.5vw, 44px)',
                    }}
                  />
                </div>
              ) : (
                <StreamVideo stream={localStream} />
              )}

              <div className="glass-pill absolute bottom-3 left-3 max-w-[30%] px-2.5 py-1 text-[13px]">
                <span className="min-w-0 truncate">{previewName}</span>
              </div>

              {!isMuted && (
                <div className="absolute bottom-[4.5rem] left-1/2 h-5 w-32 -translate-x-1/2">
                  <MicLevelMeter level={level} active={speaking} />
                </div>
              )}

              <div className="glass-pill absolute bottom-3 left-1/2 -translate-x-1/2 gap-1.5 px-1.5 py-1.5">
                <MicButton onClick={handleMicToggle} on={!isMuted} busy={micBusy} size="sm" />
                <CameraButton onClick={handleCameraToggle} on={!isVideoOff} busy={cameraBusy} size="sm" />
                {devices.videoInputs.length >= 2 && !isVideoOff && <FlipCameraButton onClick={handleFlip} size="sm" />}
              </div>
            </div>

            {hasAnyDevice(devices) && (
              <Collapsible label="Audio & video settings" storageKey="rendezvu:join-devices-open" className="mt-3">
                <DevicePickers devices={devices} idPrefix="join" layout="grid" />
              </Collapsible>
            )}
          </div>

          <div className="flex flex-col justify-center lg:col-span-2">
            <div className="app-panel rounded-2xl p-5 sm:p-6">
              <h1 className="font-display text-3xl">Ready to join?</h1>
              <p className="mt-2 mb-5 text-sm text-muted-foreground">
                Make yourself comfortable. Check your devices, then join the conversation.
              </p>
              {deviceError && (
                <DeviceErrorNotice
                  message={deviceError}
                  onSettings={() => setShowSettings(true)}
                  onDismiss={() => setDeviceError(null)}
                />
              )}
              <p role="status" className="mb-4 text-xs text-muted-foreground">
                {isMuted ? 'Microphone off' : 'Microphone on'} · {isVideoOff ? 'Camera off' : 'Camera on'}
              </p>

              <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-2/80 px-4 py-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="label-caps">Meeting code</span>
                  <span className="meet-code truncate text-sm text-foreground">{meetCode || '—'}</span>
                </div>
                <ShareLinkButton url={window.location.href} />
              </div>

              {!statusChecked ? (
                <div role="status" className="mt-6 flex items-center justify-center gap-3 py-6 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Checking your meeting room…
                </div>
              ) : blocked ? (
                <RoomStatusCard {...blocked} />
              ) : (
                <div className="mt-4 flex flex-col gap-3">
                  {roomStatus?.status === 'unreachable' && <ServerWakeNotice state={server === 'checking' ? 'waking' : server === 'ready' ? 'down' : server} />}
                  <label htmlFor="join-name" className="sr-only">
                    Your name
                  </label>
                  <Input
                    id="join-name"
                    placeholder="Your name"
                    value={userName}
                    onChange={(e) => setUserName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                    autoComplete="name"
                    maxLength={40}
                  />
                  <Button onClick={handleJoin} disabled={!joinName} size="lg" className="w-full">
                    {hasToken ? 'Join now' : 'Ask to join'}
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    {hasToken
                      ? 'Check your camera and microphone before joining.'
                      : 'Someone in the call will need to let you in.'}{' '}
                    <Link to="/privacy" className="underline underline-offset-2 hover:text-foreground">
                      Video and privacy
                    </Link>
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </main>
  )
}

function statusCopy(status: LobbyRoomStatus): { title: string; body: string; tooEarly?: boolean } {
  const tooEarly = status.status === 'too_early'
  const opensAt = status.opensAt
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(status.opensAt))
    : null
  return {
    tooEarly,
    title: tooEarly ? 'This room is not open yet' : 'This room is not available',
    body:
      status.message ||
      (tooEarly && opensAt ? `You can join from ${opensAt}.` : 'Check the meeting link or ask the host for a new one.'),
  }
}

function RoomStatusCard({ title, body, tooEarly }: { title: string; body: string; tooEarly?: boolean }) {
  const Icon = tooEarly ? Clock : CalendarOff
  return (
    <div className="mt-4 rounded-xl border border-border bg-surface-2 p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">{body}</p>
        </div>
      </div>
    </div>
  )
}
