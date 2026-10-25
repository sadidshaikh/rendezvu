import { Video, VideoOff } from 'lucide-react'
import { ControlButton } from './ControlButton'

interface CameraButtonProps {
  onClick: () => void
  on: boolean
  busy?: boolean
  size?: 'sm' | 'md'
}

export function CameraButton({ onClick, on, busy, size = 'md' }: CameraButtonProps) {
  return (
    <ControlButton
      onClick={onClick}
      active={on}
      disabled={busy}
      activeIcon={Video}
      inactiveIcon={VideoOff}
      activeLabel="Turn camera off"
      inactiveLabel="Turn camera on"
      size={size}
    />
  )
}
