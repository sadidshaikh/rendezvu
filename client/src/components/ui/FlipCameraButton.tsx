import { SwitchCamera } from 'lucide-react'

interface FlipCameraButtonProps {
  onClick: () => void
  size?: 'sm' | 'md'
}

export function FlipCameraButton({ onClick, size = 'md' }: FlipCameraButtonProps) {
  const dim = size === 'sm' ? 'h-10 w-10' : 'h-11 w-11'
  const iconSize = size === 'sm' ? 'w-4 h-4' : 'w-4 h-4 sm:w-5 sm:h-5'

  return (
    <button type="button" onClick={onClick} aria-label="Switch camera" title="Switch camera" className={`ctrl-btn ctrl-btn-on ${dim}`}>
      <SwitchCamera className={iconSize} aria-hidden="true" />
    </button>
  )
}
