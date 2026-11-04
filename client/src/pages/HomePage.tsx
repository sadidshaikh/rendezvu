import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { Keyboard } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NewMeetingButton } from '@/components/ui/NewMeetingButton'
import { ServerWakeNotice } from '@/components/ui/ServerWakeNotice'
import { Wordmark } from '@/components/ui/Wordmark'
import { useServerState } from '@/lib/server-wake'
import { meetCodePattern, normalizeMeetCodeInput, roomPath } from '@/lib/room-routes'

export default function HomePage() {
  const navigate = useNavigate()
  const [codeInput, setCodeInput] = useState('')
  const [codeError, setCodeError] = useState<string | null>(null)
  const server = useServerState()

  const handleJoin = (e: FormEvent) => {
    e.preventDefault()
    const code = normalizeMeetCodeInput(codeInput)
    if (!meetCodePattern.test(code)) {
      setCodeError('Enter a meeting code like abc-defg-hij, or paste the meeting link.')
      return
    }
    navigate(roomPath(code))
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
        <Wordmark />
        <Link to="/privacy" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          Video and privacy
        </Link>
      </header>

      <main className="page-enter mx-auto grid w-full max-w-6xl flex-1 items-center gap-12 px-5 pt-6 pb-16 sm:px-8 lg:grid-cols-[1.15fr_0.85fr]">
        <div>
          <p className="label-caps">Video meetings, in the browser</p>
          <h1 className="font-display mt-5 max-w-xl text-[clamp(2.7rem,5.4vw,4.4rem)] leading-[1.02] text-balance">
            Meet people <span className="display-accent">where they are.</span>
          </h1>
          <p className="mt-6 max-w-md text-lg leading-relaxed text-muted-foreground">
            Start a meeting and share the link. People who open it ask to join, and you let them in. No app, no account.
          </p>

          <div className="mt-8 max-w-xl empty:hidden">
            <ServerWakeNotice state={server} />
          </div>

          <div className="mt-3 flex max-w-xl flex-col gap-3 sm:flex-row sm:items-start">
            <NewMeetingButton size="lg" className="h-12 px-6" disabled={server === 'waking'} />
            <form onSubmit={handleJoin} className="flex flex-1 flex-col gap-1.5" noValidate>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Keyboard className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <label htmlFor="meet-code" className="sr-only">
                    Meeting code or link
                  </label>
                  <Input
                    id="meet-code"
                    placeholder="Enter a code or link"
                    value={codeInput}
                    onChange={(e) => {
                      setCodeInput(e.target.value)
                      setCodeError(null)
                    }}
                    aria-invalid={codeError ? true : undefined}
                    aria-describedby={codeError ? 'meet-code-error' : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    className="h-12 pl-9"
                  />
                </div>
                <Button type="submit" variant="secondary" size="lg" className="h-12" disabled={!codeInput.trim()}>
                  Join
                </Button>
              </div>
              {codeError && (
                <p id="meet-code-error" className="text-xs text-destructive">
                  {codeError}
                </p>
              )}
            </form>
          </div>

          <ol className="mt-12 grid max-w-xl gap-4 border-t border-border pt-6 sm:grid-cols-3">
            {STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-3">
                <span className="font-display flex size-7 shrink-0 items-center justify-center rounded-full border border-primary/40 text-sm text-primary">
                  {i + 1}
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-semibold">{step.title}</span>
                  <span className="text-xs leading-relaxed text-muted-foreground">{step.body}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>

        <TableForTwo />
      </main>
    </div>
  )
}

const STEPS = [
  { title: 'Start', body: 'One click makes a private room.' },
  { title: 'Share', body: 'Send the link however you like.' },
  { title: 'Let them in', body: 'Guests wait until you admit them.' },
]

/** Decoration only: two people, two circles, one table. Hidden below lg and from screen readers. */
function TableForTwo() {
  return (
    <div aria-hidden="true" className="relative hidden aspect-square w-full max-w-md justify-self-end lg:block">
      <div className="absolute inset-[6%] rounded-full border border-border" />
      <div className="absolute inset-[18%] rounded-full border border-dashed border-border-strong/40" />
      <div className="experience-card absolute top-[22%] left-[6%] flex w-[52%] flex-col gap-3 p-4 -rotate-3">
        <div className="flex aspect-video items-end rounded-lg bg-[linear-gradient(150deg,hsl(var(--accent)),hsl(var(--surface-3)))] p-2">
          <span className="glass-pill px-2 py-0.5 text-[11px]">Amara</span>
        </div>
        <div className="h-1.5 w-2/3 rounded-full bg-surface-3" />
      </div>
      <div className="experience-card absolute right-[6%] bottom-[20%] flex w-[52%] flex-col gap-3 p-4 rotate-2">
        <div className="flex aspect-video items-end rounded-lg bg-[linear-gradient(150deg,hsl(var(--primary)/0.85),hsl(20_45%_30%))] p-2">
          <span className="glass-pill px-2 py-0.5 text-[11px]">Dev</span>
        </div>
        <div className="h-1.5 w-1/2 rounded-full bg-surface-3" />
      </div>
      <div className="absolute top-[12%] right-[14%] size-14 rounded-full bg-primary" />
      <div className="absolute bottom-[10%] left-[18%] size-10 rounded-full border-2 border-foreground" />
    </div>
  )
}
