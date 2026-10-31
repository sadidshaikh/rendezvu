import { Loader2 } from 'lucide-react'
import type { ConnState } from '@/services/signaling/client'

interface ConnectionBannerProps {
  connState: ConnState
  reconnectAttempt: number
}

/**
 * A quiet line above the grid while signaling reconnects. Media keeps
 * flowing meanwhile, so the call stays on screen and usable underneath.
 * The space is kept when empty, so the grid doesn't jump.
 */
export function ConnectionBanner({ connState, reconnectAttempt }: ConnectionBannerProps) {
  const reconnecting = connState === 'reconnecting'
  return (
    <div className="flex min-h-7 shrink-0 items-center justify-center px-3">
      <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-muted-foreground">
        {reconnecting && (
          <>
            <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
            <span>Connection interrupted. Trying to reconnect…</span>
            <span className="sr-only">Attempt {reconnectAttempt}</span>
          </>
        )}
      </div>
    </div>
  )
}
