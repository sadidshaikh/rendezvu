import type { NetworkPressure, QualityGrade } from '@rendezvu/protocol'
import { cn } from '@/lib/utils'

export const QUALITY_LABEL: Record<QualityGrade, string> = {
  good: 'Good connection',
  medium: 'Unstable connection',
  poor: 'Poor connection',
  unknown: 'Measuring',
}

export const PRESSURE_LABEL: Record<NetworkPressure, string> = {
  low: 'Plenty of headroom',
  medium: 'Some network pressure',
  high: 'High network pressure',
  severe: 'Severe network pressure',
  unknown: 'Measuring network pressure',
}

const DOT_CLASS: Record<QualityGrade, string> = {
  good: 'bg-emerald-500',
  medium: 'bg-amber-500',
  poor: 'bg-red-500',
  unknown: 'bg-muted-foreground/50',
}

interface QualityDotProps {
  quality: QualityGrade
  withLabel?: boolean
  className?: string
}

/** A coloured dot for one connection's grade, optionally with its label. */
export function QualityDot({ quality, withLabel = false, className }: QualityDotProps) {
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', DOT_CLASS[quality])} />
      {withLabel ? (
        <span className="text-xs text-muted-foreground">{QUALITY_LABEL[quality]}</span>
      ) : (
        <span className="sr-only">{QUALITY_LABEL[quality]}</span>
      )}
    </span>
  )
}
