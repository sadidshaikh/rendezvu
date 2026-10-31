import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

interface ShareLinkButtonProps {
  url: string
  /** Shown instead of "Share" / "Copy", such as the meet code in the call header. */
  label?: string
  className?: string
}

/** Shares the meeting link with the OS share sheet where there is one, otherwise copies it. */
export function ShareLinkButton({ url, label, className }: ShareLinkButtonProps) {
  const [copied, setCopied] = useState(false)
  const canShare = typeof navigator !== 'undefined' && 'share' in navigator
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current)
  }, [])

  const handleClick = async () => {
    try {
      if (canShare) {
        await navigator.share({ title: 'Join my Rendezvu call', url })
      } else {
        await navigator.clipboard.writeText(url)
        setCopied(true)
        if (resetTimer.current) clearTimeout(resetTimer.current)
        resetTimer.current = setTimeout(() => setCopied(false), 1500)
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast.error('Could not share')
    }
  }

  const Icon = copied ? Check : canShare ? Share2 : Copy

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={copied ? 'Link copied' : canShare ? 'Share meeting link' : 'Copy meeting link'}
      className={cn(
        'press glass-pill shrink-0 gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        className,
      )}
    >
      {label ? (
        <>
          <span className="meet-code text-sm text-foreground">{label}</span>
          <Icon className={cn('size-3.5', copied && 'text-primary')} aria-hidden="true" />
        </>
      ) : (
        <>
          <Icon className={cn('size-3.5', copied && 'text-primary')} aria-hidden="true" />
          {copied ? 'Copied' : canShare ? 'Share' : 'Copy'}
        </>
      )}
    </button>
  )
}
