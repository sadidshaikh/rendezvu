import * as React from 'react'
import { cn } from '@/lib/utils'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'field-control w-full rounded-xl border border-[hsl(var(--border-strong))] bg-surface px-3 py-2.5 text-sm text-foreground outline-none',
        'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        'placeholder:text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
