import { useState } from 'react'
import { Link } from 'react-router'
import { Loader2 } from 'lucide-react'
import type { IceServer } from '@rendezvu/protocol'
import { CheckSteps, idleSteps, type Step, type StepState } from '@/components/features/CheckSteps'
import { SfuLoopbackCheck } from '@/components/features/SfuLoopbackCheck'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { fetchIceServers } from '@/services/api/ice'
import { createMeet } from '@/services/api/meet'
import type { SignalingClient } from '@/services/signaling/client'
import { joinRoom } from '@/services/signaling/join-room'
import { filterTurnUrls, runRelayCheck, type RelayCheckResult, type RelayTransport } from '@/services/webrtc/relay-check'

const STEP_LABELS = ['Create a meeting', 'Join it, so the room is active', 'Fetch ICE servers', 'Connect through the relay only']

const TRANSPORTS: { value: RelayTransport; label: string }[] = [
  { value: 'any', label: 'Any TURN transport' },
  { value: 'udp', label: 'UDP only' },
  { value: 'tcp', label: 'TCP only' },
  { value: 'tls', label: 'TLS only (turns:, port 443/5349)' },
]

/**
 * Diagnostics. The TURN check proves the relay works from the current
 * network: it goes through the same steps as a real call (meeting, join,
 * /ice-servers), then connects two peer connections in this tab with relay
 * candidates only. The SFU loopback below proves the round trip through
 * Cloudflare's SFU.
 */
export default function TurnCheckPage() {
  const [transport, setTransport] = useState<RelayTransport>('any')
  const [running, setRunning] = useState(false)
  const [steps, setSteps] = useState<Step[]>(() => idleSteps(STEP_LABELS))
  const [servers, setServers] = useState<IceServer[] | null>(null)
  const [result, setResult] = useState<RelayCheckResult | null>(null)

  const update = (index: number, state: StepState, detail?: string) =>
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, state, detail } : s)))

  const run = async () => {
    setRunning(true)
    setSteps(idleSteps(STEP_LABELS))
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
      client = await joinRoom(meetCode, 'TURN check')
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

      <CheckSteps steps={steps} />

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

      <SfuLoopbackCheck />

      <Link to="/" className="text-sm text-primary">
        Back to Rendezvu
      </Link>
    </main>
  )
}
