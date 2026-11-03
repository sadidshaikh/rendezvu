import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { Keyboard, Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NewMeetingButton } from '@/components/ui/NewMeetingButton'
import { meetCodePattern, normalizeMeetCodeInput, roomPath } from '@/lib/room-routes'

export default function HomePage() {
  const navigate = useNavigate()
  const [codeInput, setCodeInput] = useState('')
  const [codeError, setCodeError] = useState<string | null>(null)

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
      <header className="mx-auto flex w-full max-w-6xl items-center px-5 py-5 sm:px-8">
        <span className="font-brand text-xl font-semibold tracking-tight">Rendezvu</span>
      </header>

      <main className="page-enter mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-5 pb-20 sm:px-8">
        <p className="inline-flex w-fit items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-success" /> Scheduling + video, together
        </p>
        <h1 className="font-display mt-7 max-w-2xl text-[clamp(2.6rem,5vw,4.1rem)] leading-[1.06] text-balance">
          Meet face to face, <span className="text-primary">right in your browser.</span>
        </h1>
        <p className="mt-6 max-w-md text-lg leading-relaxed text-muted-foreground">
          Start a meeting and share the link. Whoever opens it joins the call, no app or account needed.
        </p>

        <div className="mt-9 flex max-w-xl flex-col gap-3 sm:flex-row sm:items-start">
          <NewMeetingButton size="lg" className="h-12 px-6" />
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

        <div className="mt-12 flex max-w-xl items-center gap-3 border-t border-border pt-5 text-sm text-muted-foreground">
          <Video className="size-5 shrink-0 text-primary" />
          <span>Booking pages are coming next. Every booking will get its own private room.</span>
        </div>
        <Link to="/privacy" className="mt-4 inline-block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
          Video and privacy
        </Link>
      </main>
    </div>
  )
}
