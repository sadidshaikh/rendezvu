import { useEffect, useState } from 'react'
import { CalendarOff, Clock, Loader2 } from 'lucide-react'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ShareLinkButton } from '@/components/ui/ShareLinkButton'
import { meetCodePattern } from '@/lib/room-routes'
import { fetchRoomStatus, type LobbyRoomStatus } from '@/services/api/room'
import { useJoinMeetStore } from '@/stores/join-meet'

interface JoinMeetProps {
  meetCode: string
  /** Why the last join attempt was refused, shown in place of the join form. */
  roomError: string | null
  onJoin: (name: string) => void
}

export default function JoinMeet({ meetCode, roomError, onJoin }: JoinMeetProps) {
  const { userName, setUserName } = useJoinMeetStore()
  const [roomStatus, setRoomStatus] = useState<LobbyRoomStatus | null>(null)
  const [statusChecked, setStatusChecked] = useState(false)
  const canJoinMeet = meetCodePattern.test(meetCode)

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
        if (!cancelled) setRoomStatus(status)
      })
      .finally(() => {
        if (!cancelled) setStatusChecked(true)
      })
    return () => {
      cancelled = true
    }
  }, [canJoinMeet, meetCode])

  const joinName = userName.trim()
  const handleJoin = () => {
    if (!joinName || !canJoinMeet) return
    onJoin(joinName)
  }

  const previewName = joinName || 'You'
  const blocked = !canJoinMeet
    ? { title: 'This room is not available', body: 'Check the meeting link or ask the host for a new one.' }
    : roomError
      ? { title: 'This room is not available', body: roomError }
      : roomStatus && roomStatus.status !== 'open' && roomStatus.status !== 'unavailable'
        ? statusCopy(roomStatus)
        : null

  return (
    <main className="call-stage relative flex flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl items-start px-4 py-6 sm:items-center sm:py-10 lg:py-16">
        <div className="grid w-full grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-5">
          {/* Preview: camera arrives in Phase 2, until then the camera-off look */}
          <div className="lg:col-span-3">
            <div className="tile-in app-panel relative w-full overflow-hidden rounded-2xl" style={{ aspectRatio: '16/9' }}>
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
              <div className="glass-pill absolute bottom-3 left-3 px-2.5 py-1 text-[13px]">{previewName}</div>
            </div>
          </div>

          <div className="flex flex-col justify-center lg:col-span-2">
            <div className="app-panel rounded-2xl p-5 sm:p-6">
              <h1 className="font-display text-3xl">Ready to join?</h1>
              <p className="mt-2 mb-5 text-sm text-muted-foreground">
                Make yourself comfortable. Check your devices, then join the conversation.
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
                    Join now
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
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
