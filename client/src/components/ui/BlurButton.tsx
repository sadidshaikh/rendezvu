import { Aperture, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePeerStore } from '@/stores/peer'

/**
 * Quick blur on and off (Medium), next to the camera. Not red when off: no
 * blur is the normal state. Settings → Effects has the other strengths.
 */
export function BlurButton() {
  const effect = usePeerStore((s) => s.backgroundEffect)
  const busy = usePeerStore((s) => s.backgroundBusy)
  const on = effect !== 'off'
  const label = on ? 'Turn background effect off' : 'Blur background'
  const Icon = busy ? Loader2 : Aperture
  return (
    <button
      type="button"
      onClick={() => void usePeerStore.getState().setBackgroundEffect(on ? 'off' : 'blur-medium')}
      disabled={busy}
      aria-label={label}
      title={label}
      aria-pressed={on}
      aria-busy={busy}
      className={cn('ctrl-btn size-11', on ? 'ctrl-btn-screen' : 'ctrl-btn-on')}
    >
      <Icon className={cn('size-4 sm:size-5', busy && 'animate-spin')} aria-hidden="true" />
    </button>
  )
}
