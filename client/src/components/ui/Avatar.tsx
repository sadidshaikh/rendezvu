import type { CSSProperties } from 'react'
import { initialsOf } from '@/lib/avatar'
import { cn } from '@/lib/utils'

type Size = 'xs' | 'sm' | 'md' | 'lg'

const SIZES: Record<Size, string> = {
  xs: 'size-8 text-[0.6875rem]',
  sm: 'size-9 text-xs',
  md: 'size-12 text-base',
  lg: 'size-16 text-xl',
}

interface AvatarProps {
  name: string
  size?: Size
  /** For tiles that scale the circle with the frame. Overrides `size`. */
  style?: CSSProperties
  className?: string
  /**
   * Avatars beside a visible name are decorative. Set a label where the
   * avatar stands alone, such as a tile with the camera off.
   */
  label?: string
}

export function Avatar({ name, size = 'sm', style, className, label }: AvatarProps) {
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const }

  return (
    <div
      {...a11y}
      style={style}
      className={cn(
        'font-display flex shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground',
        !style && SIZES[size],
        className,
      )}
    >
      {initialsOf(name)}
    </div>
  )
}
