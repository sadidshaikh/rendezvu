import { cn } from '@/lib/utils'

const BAR_COUNT = 20

interface MicLevelMeterProps {
  /** 0–1 */
  level: number
  active: boolean
  className?: string
}

/** A row of bars that light up from left to right with the mic level. */
export function MicLevelMeter({ level, active, className }: MicLevelMeterProps) {
  return (
    <div
      role="meter"
      aria-label="Microphone level"
      aria-valuenow={Math.round(level * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn('flex items-end gap-[2px]', className)}
    >
      {Array.from({ length: BAR_COUNT }, (_, i) => {
        const lit = active && level >= (i + 1) / BAR_COUNT
        return (
          <span
            key={i}
            className={cn('flex-1 rounded-sm transition-all duration-75', lit ? 'bg-primary' : 'bg-border')}
            style={{ height: `${40 + (i / BAR_COUNT) * 60}%` }}
          />
        )
      })}
    </div>
  )
}
