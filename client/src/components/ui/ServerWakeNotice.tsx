import { Loader2 } from 'lucide-react'
import { wakeServer, type ServerState } from '@/lib/server-wake'
import { Button } from './button'

/** Nothing while the server answers; a short explanation while it starts or if it doesn't. */
export function ServerWakeNotice({ state }: { state: ServerState }) {
  if (state === 'waking') {
    return (
      <div role="status" className="flex items-center gap-2.5 rounded-lg border border-border bg-surface-2/70 px-3 py-2.5 text-sm">
        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
        <span>Starting the server… This can take up to a minute after a quiet spell.</span>
      </div>
    )
  }
  if (state === 'down') {
    return (
      <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm">
        <span>Can’t reach the Rendezvu server right now.</span>
        <Button variant="outline" size="sm" onClick={() => wakeServer(true)}>
          Try again
        </Button>
      </div>
    )
  }
  return null
}
