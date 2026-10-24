import { Loader2, PhoneOff, Users } from 'lucide-react'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/button'
import { ShareLinkButton } from '@/components/ui/ShareLinkButton'
import type { ConnState } from '@/services/signaling/client'
import { usePeerStore } from '@/stores/peer'

interface MeetCallProps {
  meetCode: string
  userName: string
  connState: ConnState
  onLeave: () => void
}

/** The in-call screen. For now every tile is the camera-off view; media arrives in Phases 4–5. */
export default function MeetCall({ meetCode, userName, connState, onLeave }: MeetCallProps) {
  const inRoom = usePeerStore((s) => s.inRoom)
  const peers = usePeerStore((s) => s.peers)
  const participants = [{ id: 'local', name: userName, isLocal: true }, ...[...peers.values()].map((p) => ({ ...p, isLocal: false }))]

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
                className="tile-in app-panel relative overflow-hidden rounded-2xl"
                style={{ aspectRatio: '16/9' }}
              >
                <div className="absolute inset-0 flex items-center justify-center bg-[linear-gradient(160deg,hsl(var(--surface-2)),hsl(var(--surface-3)))]">
                  <Avatar name={p.name} size="lg" />
                </div>
                <div className="glass-pill absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)] gap-1.5 px-2.5 py-1 text-[13px]">
                  <span className="truncate">{p.name || 'Guest'}</span>
                  {p.isLocal && <span className="text-muted-foreground">(You)</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

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
