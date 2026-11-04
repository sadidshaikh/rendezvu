import { Link } from 'react-router'
import { cn } from '@/lib/utils'

/**
 * The name, in the display serif with a terracotta dot: two people meeting
 * (the same two circles as the favicon). Links home.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <Link to="/" className={cn('inline-flex items-center gap-2 text-foreground', className)} aria-label="Rendezvu home">
      <svg viewBox="0 0 32 20" className="h-4 w-auto shrink-0" aria-hidden="true">
        <circle cx="9.5" cy="10" r="7" className="fill-primary" />
        <circle cx="22.5" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
      <span className="font-display text-xl tracking-tight">rendezvu</span>
    </Link>
  )
}
