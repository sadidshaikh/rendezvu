import { MonitorUp, MonitorX } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ScreenShareButtonProps {
  onClick: () => void
  sharing: boolean
  busy?: boolean
}

/** Not an on/off toggle like the mic: not sharing is the normal state, so it isn't red. */
export function ScreenShareButton({ onClick, sharing, busy }: ScreenShareButtonProps) {
  const label = sharing ? 'Stop sharing' : 'Share screen'
  const Icon = sharing ? MonitorX : MonitorUp
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      title={label}
      aria-pressed={sharing}
      aria-busy={busy}
      className={cn('ctrl-btn h-11 w-11', sharing ? 'ctrl-btn-screen' : 'ctrl-btn-on')}
    >
      <Icon className="w-4 h-4 sm:w-5 sm:h-5" aria-hidden="true" />
    </button>
  )
}

export function canShareScreen(): boolean {
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function'
}
