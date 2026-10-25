import { useState } from 'react'
import { Link } from 'react-router'
import { Check, Circle, Loader2, X } from 'lucide-react'
import type { ErrorData, IceServer, JoinData } from '@rendezvu/protocol'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { wsServerUri } from '@/lib/config'
import { cn } from '@/lib/utils'
import { fetchIceServers } from '@/services/api/ice'
import { createMeet } from '@/services/api/meet'
import { SignalingClient } from '@/services/signaling/client'
import { filterTurnUrls, runRelayCheck, type RelayCheckResult, type RelayTransport } from '@/services/webrtc/relay-check'

type StepState = 'idle' | 'running' | 'done' | 'failed'

interface Step {
  label: string
  state: StepState
  detail?: string
}

const STEP_LABELS = ['Create a meeting', 'Join it, so the room is active', 'Fetch ICE servers', 'Connect through the relay only']

const TRANSPORTS: { value: RelayTransport; label: string }[] = [
  { value: 'any', label: 'Any TURN transport' },
  { value: 'udp', label: 'UDP only' },
  { value: 'tcp', label: 'TCP only' },
  { value: 'tls', label: 'TLS only (turns:, port 443/5349)' },
]

const JOIN_TIMEOUT_MS = 8_000

/**
 * Diagnostic page that proves TURN works from the current network: it
 * goes through the same steps as a real call (meeting, join, /ice-servers),
 * then connects two peer connections in this tab with relay candidates only.
 */
export default function TurnCheckPage() {
  const [transport, setTransport] = useState<RelayTransport>('any')
  const [running, setRunning] = useState(false)
  const [steps, setSteps] = useState<Step[]>(STEP_LABELS.map((label) => ({ label, state: 'idle' })))
  const [servers, setServers] = useState<IceServer[] | null>(null)
  const [result, setResult] = useState<RelayCheckResult | null>(null)

  const update = (index: number, state: StepState, detail?: string) =>
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, state, detail } : s)))

  const run = async () => {
    setRunning(true)
    setSteps(STEP_LABELS.map((label) => ({ label, state: 'idle' })))
    setServers(null)
    setResult(null)
    let client: SignalingClient | null = null
    let step = 0
    try {
      update(step, 'running')
      const { meetCode } = await createMeet()
      update(step, 'done', meetCode)

      step = 1
      update(step, 'running')
      client = await joinRoom(meetCode)
      update(step, 'done', `peer ${client.getPeerId()}`)

      step = 2
      update(step, 'running')
      const fetched = await fetchIceServers(meetCode)
      setServers(fetched)
      const urls = fetched.flatMap((s) => s.urls)
      const turnCount = urls.filter((u) => u.startsWith('turn')).length
      if (turnCount === 0) {
        update(step, 'failed', 'Only STUN came back, so the server fell back. Check CF_TURN_KEY_ID / CF_TURN_API_TOKEN and the server log for ice_error.')
        return
      }
      const port53 = urls.some((u) => /:53(\?|$)/.test(u))
      update(step, 'done', `${turnCount} TURN URLs${port53 ? ' · port 53 URLs present (the server should filter them)' : ''}`)

      step = 3
      const chosen = filterTurnUrls(fetched, transport)
      if (chosen.length === 0) {
        update(step, 'failed', `No TURN URLs match “${transport}”.`)
        return
      }
      update(step, 'running', 'Up to 15 s')
      const outcome = await runRelayCheck(chosen)
      setResult(outcome)
      update(step, outcome.ok ? 'done' : 'failed', outcome.ok ? `Connected via ${outcome.local?.relayProtocol ?? '?'}` : outcome.reason)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // A 404 without CORS headers surfaces as a bare network error.
      const hint = step === 2 && e instanceof TypeError ? ' Is POST /ice-servers implemented, and is the server running?' : ''
      update(step, 'failed', message + hint)
    } finally {
      client?.send('leave')
      client?.dispose()
      setRunning(false)
    }
  }

  return (
    <main className="page-enter mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-2">
        <span className="label-caps">Diagnostics</span>
        <h1 className="font-display text-3xl">TURN check</h1>
        <p className="text-sm text-muted-foreground">
          Runs the steps a call would, then connects two peer connections in this tab using relay candidates only. If they
          connect, media can flow through Cloudflare’s TURN servers from this network.
        </p>
      </header>

      <section className="app-panel flex flex-col gap-4 rounded-2xl p-5 sm:flex-row sm:items-end">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label htmlFor="turn-transport" className="text-xs text-muted-foreground">
            Relay transport
          </label>
          <Select id="turn-transport" value={transport} onChange={(e) => setTransport(e.target.value as RelayTransport)} disabled={running}>
            {TRANSPORTS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </div>
        <Button onClick={run} disabled={running} size="lg" aria-busy={running}>
          {running && <Loader2 className="animate-spin" aria-hidden="true" />}
          {running ? 'Checking…' : 'Run check'}
        </Button>
      </section>

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

      {result?.ok && (
        <section className="app-panel rounded-2xl p-5">
          <h2 className="label-caps mb-3">Selected candidate pair</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Local</dt>
            <dd className="meet-code">{result.local?.type ?? '?'}</dd>
            <dt className="text-muted-foreground">Remote</dt>
            <dd className="meet-code">{result.remote?.type ?? '?'}</dd>
            <dt className="text-muted-foreground">Browser → TURN</dt>
            <dd className="meet-code">{result.local?.relayProtocol ?? '?'}</dd>
            {result.local?.url && (
              <>
                <dt className="text-muted-foreground">TURN URL</dt>
                <dd className="meet-code min-w-0 break-all">{result.local.url}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Round trip</dt>
            <dd className="meet-code">{result.roundTripMs !== undefined ? `${result.roundTripMs} ms` : '?'}</dd>
            <dt className="text-muted-foreground">Relay candidates</dt>
            <dd className="meet-code">{result.relayCandidates}</dd>
          </dl>
        </section>
      )}

      {servers && (
        <section className="app-panel rounded-2xl p-5">
          <h2 className="label-caps mb-3">ICE servers from /ice-servers</h2>
          <ul className="flex flex-col gap-3 text-xs">
            {servers.map((s, i) => (
              <li key={i} className="flex flex-col gap-1">
                {s.urls.map((u) => (
                  <span key={u} className="meet-code break-all">
                    {u}
                  </span>
                ))}
                <span className="text-muted-foreground">{s.username ? 'with short-lived credentials' : 'no credentials'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Link to="/" className="text-sm text-primary">
        Back to Rendezvu
      </Link>
    </main>
  )
}

function StepIcon({ state }: { state: StepState }) {
  const cls = 'mt-0.5 size-4 shrink-0'
  if (state === 'running') return <Loader2 className={cn(cls, 'animate-spin text-muted-foreground')} aria-label="Running" />
  if (state === 'done') return <Check className={cn(cls, 'text-success')} aria-label="Done" />
  if (state === 'failed') return <X className={cn(cls, 'text-destructive')} aria-label="Failed" />
  return <Circle className={cn(cls, 'text-border')} aria-label="Not started" />
}

/** Connects to signaling and joins, resolving once the server answers `joined`. */
function joinRoom(code: string): Promise<SignalingClient> {
  return new Promise((resolve, reject) => {
    const client = new SignalingClient(wsServerUri)
    const fail = (message: string) => {
      clearTimeout(timer)
      client.dispose()
      reject(new Error(message))
    }
    const timer = setTimeout(() => fail('Timed out joining the room.'), JOIN_TIMEOUT_MS)
    client.on('joined', () => {
      clearTimeout(timer)
      resolve(client)
    })
    client.on<ErrorData>('error', (env) => fail(env.data?.message ?? 'The server refused the join.'))
    client.onStateChange = (state) => {
      if (state === 'connected') client.send<JoinData>('join', { name: 'TURN check', audio: false, video: false }, { room: code })
      if (state === 'disconnected') fail('Could not reach the signaling server.')
    }
    client.connect()
  })
}
