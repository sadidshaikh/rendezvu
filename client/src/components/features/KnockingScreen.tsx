import { Loader2 } from 'lucide-react'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/button'
import { StreamVideo } from '@/components/ui/StreamVideo'
import { useMeetStore } from '@/stores/meet'
import { usePeerStore } from '@/stores/peer'

interface KnockingScreenProps {
  meetCode: string
  userName: string
  denied: boolean
  onAskAgain: () => void
  /** Stops waiting: back out of the room. */
  onCancel: () => void
}

/**
 * Shown while this tab has asked to join and nobody in the call has answered,
 * or after someone said no. The call itself isn't mounted: until we're let in,
 * the server tells us nothing about the room, so there's nothing to show.
 */
export function KnockingScreen({ meetCode, userName, denied, onAskAgain, onCancel }: KnockingScreenProps) {
  const localStream = usePeerStore((s) => s.localStream)
  const isVideoOff = useMeetStore((s) => s.isVideoOff)
  const showVideo = localStream !== null && !isVideoOff && localStream.getVideoTracks().length > 0

  return (
    <main className="call-stage flex min-h-dvh flex-1 items-center justify-center p-4 sm:p-6">
      <div className="experience-card flex w-full max-w-md flex-col items-center gap-5 p-6 text-center sm:p-8">
        <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-border bg-surface-2">
          {showVideo ? (
            <StreamVideo stream={localStream} />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <Avatar name={userName || 'You'} style={{ width: 72, height: 72, fontSize: 26 }} />
            </div>
          )}
        </div>

        {denied ? (
          <>
            <div className="flex flex-col gap-2">
              <h1 tabIndex={-1} ref={(el) => el?.focus()} className="font-display text-2xl outline-none">
                You weren’t let in
              </h1>
              <p className="text-sm text-muted-foreground">
                Someone in the call declined your request. You can ask again in a few seconds.
              </p>
            </div>
            <div className="flex w-full flex-col gap-2 sm:flex-row">
              <Button className="flex-1" onClick={onAskAgain}>
                Ask again
              </Button>
              <Button className="flex-1" variant="outline" onClick={onCancel}>
                Back
              </Button>
            </div>
          </>
        ) : (
          <>
            <div role="status" className="flex flex-col gap-2">
              <h1 className="flex items-center justify-center gap-2.5 font-display text-2xl">
                <Loader2 className="size-5 shrink-0 animate-spin" aria-hidden="true" />
                Waiting to be let in
              </h1>
              <p className="text-sm text-muted-foreground">
                Someone in <span className="meet-code text-foreground">{meetCode}</span> will let you in soon.
              </p>
            </div>
            <Button variant="outline" className="w-full" onClick={onCancel}>
              Cancel
            </Button>
          </>
        )}
      </div>
    </main>
  )
}
