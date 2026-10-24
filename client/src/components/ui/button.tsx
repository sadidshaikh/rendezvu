import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  [
    'press cursor-pointer inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl',
    'text-sm font-medium tracking-wide',
    'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40',
    "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0",
    'outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-1',
  ].join(' '),
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground shadow-sm hover:brightness-110',
        secondary: 'bg-surface-2 text-foreground border border-border hover:bg-surface-3',
        outline: 'border border-border bg-transparent text-foreground hover:bg-surface-2',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:brightness-110',
        ghost: 'hover:bg-surface-2 text-foreground',
        link: 'text-primary underline-offset-4 hover:underline shadow-none',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-8 rounded-lg px-3 text-xs',
        lg: 'h-11 px-6',
        icon: 'size-10',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button'
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />
}

export { Button, buttonVariants }
