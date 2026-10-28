import { Check, Circle, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export type StepState = 'idle' | 'running' | 'done' | 'failed'

export interface Step {
  label: string
  state: StepState
  detail?: string
}

export const idleSteps = (labels: string[]): Step[] => labels.map((label) => ({ label, state: 'idle' }))

/** The numbered progress list on the diagnostics page. */
export function CheckSteps({ steps }: { steps: Step[] }) {
  return (
    <ol className="app-panel flex flex-col divide-y divide-border rounded-2xl" aria-label="Steps">
      {steps.map((s) => (
        <li key={s.label} className="flex items-start gap-3 px-5 py-3.5">
          <StepIcon state={s.state} />
          <div className="min-w-0">
            <p className={cn('text-sm', s.state === 'idle' ? 'text-muted-foreground' : 'text-foreground')}>{s.label}</p>
            {s.detail && <p className="mt-0.5 text-xs break-words text-muted-foreground">{s.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  )
}

function StepIcon({ state }: { state: StepState }) {
  const cls = 'mt-0.5 size-4 shrink-0'
  if (state === 'running') return <Loader2 className={cn(cls, 'animate-spin text-muted-foreground')} aria-label="Running" />
  if (state === 'done') return <Check className={cn(cls, 'text-success')} aria-label="Done" />
  if (state === 'failed') return <X className={cn(cls, 'text-destructive')} aria-label="Failed" />
  return <Circle className={cn(cls, 'text-border')} aria-label="Not started" />
}
