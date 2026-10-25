import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ControlButtonProps {
  onClick: () => void
  active: boolean
  activeIcon: LucideIcon
  inactiveIcon: LucideIcon
  activeLabel: string
  inactiveLabel: string
  size?: 'sm' | 'md'
  disabled?: boolean
  className?: string
}

/** Round on/off toggle. "Off" is red so a muted mic is always obvious. */
export function ControlButton({
  onClick,
  active,
  activeIcon: ActiveIcon,
  inactiveIcon: InactiveIcon,
  activeLabel,
  inactiveLabel,
  size = 'md',
  disabled,
  className,
}: ControlButtonProps) {
  const dim = size === 'sm' ? 'h-10 w-10' : 'h-11 w-11'
  const iconSize = size === 'sm' ? 'w-4 h-4' : 'w-4 h-4 sm:w-5 sm:h-5'
  const label = active ? activeLabel : inactiveLabel
  const Icon = active ? ActiveIcon : InactiveIcon

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={active}
      aria-busy={disabled}
      className={cn('ctrl-btn', dim, active ? 'ctrl-btn-on' : 'ctrl-btn-off', className)}
    >
      <Icon className={iconSize} aria-hidden="true" />
    </button>
  )
}
