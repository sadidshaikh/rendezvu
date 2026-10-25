import { Mic, MicOff } from 'lucide-react'
import { ControlButton } from './ControlButton'

interface MicButtonProps {
  onClick: () => void
  on: boolean
  busy?: boolean
  size?: 'sm' | 'md'
}

export function MicButton({ onClick, on, busy, size = 'md' }: MicButtonProps) {
  return (
    <ControlButton
      onClick={onClick}
      active={on}
      disabled={busy}
      activeIcon={Mic}
      inactiveIcon={MicOff}
      activeLabel="Mute microphone"
      inactiveLabel="Unmute microphone"
      size={size}
    />
  )
}
