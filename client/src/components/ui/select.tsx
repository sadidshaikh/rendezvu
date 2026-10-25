import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

function Select({ className, children, disabled, ...props }: React.ComponentProps<'select'>) {
  return (
    <div className="relative inline-block w-full">
      <select
        data-slot="select"
        disabled={disabled}
        className={cn(
          'field-control h-10 w-full cursor-pointer appearance-none rounded-xl border border-[hsl(var(--border-strong))] bg-surface px-3 py-2.5 pr-9 text-sm text-foreground outline-none',
          'hover:bg-surface-2 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
          '[&>option]:bg-[hsl(var(--popover))] [&>option]:text-[hsl(var(--popover-foreground))]',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground',
          disabled && 'opacity-50',
        )}
      />
    </div>
  )
}

export { Select }
