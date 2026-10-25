import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CollapsibleProps {
  label: string
  children: ReactNode
  defaultOpen?: boolean
  /** Remember open/closed across page loads. */
  storageKey?: string
  className?: string
}

function readStorage(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === 'true'
  } catch {
    return fallback
  }
}

function writeStorage(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    /* noop */
  }
}

export function Collapsible({ label, children, defaultOpen = false, storageKey, className }: CollapsibleProps) {
  const [open, setOpen] = useState(() => (storageKey ? readStorage(storageKey, defaultOpen) : defaultOpen))

  useEffect(() => {
    if (storageKey) writeStorage(storageKey, open)
  }, [open, storageKey])

  return (
    <div className={cn('flex flex-col', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 self-start rounded py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200', open && 'rotate-180')} aria-hidden />
        {label}
      </button>

      {/* Animating grid rows from 0fr to 1fr opens to the content's natural height without measuring it. */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-in-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
        inert={!open}
      >
        <div className="overflow-hidden">
          <div className="px-1 pt-2 pb-1">{children}</div>
        </div>
      </div>
    </div>
  )
}
