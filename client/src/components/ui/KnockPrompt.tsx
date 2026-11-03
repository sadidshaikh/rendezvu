import { useState } from 'react'
import { ChevronDown, UserPlus } from 'lucide-react'
import type { KnockAnswerData, KnockRequestData } from '@rendezvu/protocol'
import type { SignalingClient } from '@/services/signaling/client'
import { usePeerStore } from '@/stores/peer'
import { Avatar } from './Avatar'
import { Button } from './button'

interface KnockPromptProps {
  client: SignalingClient | null
  roomId: string
}

/**
 * People waiting to be let in, for everyone already in the call. Any member
 * can answer; the server then tells every member, so the prompt closes on
 * all screens, not only on the one that clicked.
 */
export function KnockPrompt({ client, roomId }: KnockPromptProps) {
  const requests = usePeerStore((s) => s.knockRequests)
  const [expanded, setExpanded] = useState(false)
  if (requests.length === 0) return null

  const answer = (type: 'knock-admit' | 'knock-deny', peerId: string) => {
    client?.send<KnockAnswerData>(type, { peerId }, { room: roomId })
    // Closed at once here; knock-resolved closes it everywhere else.
    usePeerStore.getState().removeKnockRequest(peerId)
  }
  const admitAll = () => {
    requests.forEach((r) => answer('knock-admit', r.peerId))
    setExpanded(false)
  }

  const nameOf = (r: KnockRequestData) => r.name || 'Someone'
  const single = requests.length === 1 ? requests[0] : null

  return (
    <section
      aria-label="People waiting to join"
      className="experience-card fixed top-16 right-3 left-3 z-40 mx-auto flex max-w-sm flex-col gap-3 p-4 shadow-2xl sm:left-auto"
    >
      <div role="status" className="flex items-center gap-3">
        {single ? (
          <Avatar name={nameOf(single)} style={{ width: 36, height: 36, fontSize: 14 }} />
        ) : (
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <UserPlus className="size-4" aria-hidden="true" />
          </div>
        )}
        <p className="min-w-0 flex-1 text-sm">
          {single ? (
            <>
              <span className="font-medium">{nameOf(single)}</span> wants to join
            </>
          ) : (
            <>
              <span className="font-medium">{requests.length} people</span> want to join
            </>
          )}
        </p>
      </div>

      {single ? (
        <div className="flex gap-2">
          <Button size="sm" className="flex-1" onClick={() => answer('knock-admit', single.peerId)} aria-label={`Admit ${nameOf(single)}`}>
            Admit
          </Button>
          <Button size="sm" variant="outline" className="flex-1" onClick={() => answer('knock-deny', single.peerId)} aria-label={`Deny ${nameOf(single)}`}>
            Deny
          </Button>
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <Button size="sm" className="flex-1" onClick={admitAll}>
              Admit all
            </Button>
            <Button size="sm" variant="outline" className="flex-1" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
              View all
              <ChevronDown className={`size-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
            </Button>
          </div>
          {expanded && (
            <ul className="flex max-h-60 flex-col gap-2 overflow-y-auto">
              {requests.map((r) => (
                <li key={r.peerId} className="flex items-center gap-2">
                  <Avatar name={nameOf(r)} style={{ width: 28, height: 28, fontSize: 11 }} />
                  <span className="min-w-0 flex-1 truncate text-sm">{nameOf(r)}</span>
                  <Button size="sm" onClick={() => answer('knock-admit', r.peerId)} aria-label={`Admit ${nameOf(r)}`}>
                    Admit
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => answer('knock-deny', r.peerId)} aria-label={`Deny ${nameOf(r)}`}>
                    Deny
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
