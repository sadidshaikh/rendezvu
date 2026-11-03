import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import type { CandidateType } from '@rendezvu/protocol'
import { cn } from '@/lib/utils'
import { LOSS_GOOD_PCT, LOSS_MEDIUM_PCT, RTT_GOOD_MS, RTT_MEDIUM_MS } from '@/services/webrtc/stats-monitor'
import { usePeerStore, type LocalStats, type MediaFlowEvent, type PeerStats } from '@/stores/peer'
import { PRESSURE_LABEL, QUALITY_LABEL, QualityDot } from './QualityDot'

type Tone = 'neutral' | 'good' | 'warning' | 'danger'

const JITTER_WARN_MS = 30
const JITTER_BAD_MS = 60

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'text-foreground',
  good: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  danger: 'text-red-600 dark:text-red-400',
}

// Relayed isn't a fault: on strict networks TURN is the only path that works.
const ROUTE: Record<CandidateType, { label: string; hint: string }> = {
  host: { label: 'Direct', hint: 'same network' },
  srflx: { label: 'Direct', hint: 'to the edge' },
  relay: { label: 'Relayed', hint: 'via TURN' },
  unknown: { label: '—', hint: 'still connecting' },
}

function toneFor(value: number, warn: number, bad: number): Tone {
  if (value < 0) return 'neutral'
  if (value >= bad) return 'danger'
  if (value >= warn) return 'warning'
  return 'good'
}

const rttText = (ms: number) => (ms < 0 ? '—' : String(Math.round(ms)))
const bitrateText = (kbps: number) => (kbps >= 1000 ? (kbps / 1000).toFixed(1) : String(Math.round(kbps)))
const bitrateUnit = (kbps: number) => (kbps >= 1000 ? 'Mbps' : 'kbps')
const durationText = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`)

function Readout({ label, value, unit, hint, tone = 'neutral' }: { label: string; value: string; unit?: string; hint?: string; tone?: Tone }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</span>
      <span className={cn('truncate text-sm font-medium tabular-nums', TONE_CLASS[tone])}>
        {value}
        {unit && <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">{unit}</span>}
      </span>
      {hint && <span className="truncate text-[10px] text-muted-foreground">{hint}</span>}
    </div>
  )
}

const card = 'flex flex-col gap-3 rounded-xl border border-[hsl(var(--border)/0.4)] bg-surface-2/60 px-4 py-3'

function PeerBlock({ name, stats }: { name: string; stats: PeerStats | undefined }) {
  if (!stats) {
    return (
      <div className={card}>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">{name}</span>
          <span className="text-xs text-muted-foreground">Measuring</span>
        </div>
      </div>
    )
  }
  return (
    <div className={card}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{name}</span>
        <QualityDot quality={stats.quality} withLabel />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Readout label="Latency" value={rttText(stats.roundTripTimeMs)} unit="ms" tone={toneFor(stats.roundTripTimeMs, RTT_GOOD_MS, RTT_MEDIUM_MS)} />
        <Readout label="Loss" value={stats.packetLossPercent.toFixed(1)} unit="%" tone={toneFor(stats.packetLossPercent, LOSS_GOOD_PCT, LOSS_MEDIUM_PCT)} />
        <Readout label="Jitter" value={String(Math.round(stats.jitterMs))} unit="ms" tone={toneFor(stats.jitterMs, JITTER_WARN_MS, JITTER_BAD_MS)} />
        <Readout label="Receiving" value={bitrateText(stats.inboundBitrateKbps)} unit={bitrateUnit(stats.inboundBitrateKbps)} />
        <Readout
          label="Video"
          value={stats.frameWidth && stats.frameHeight ? `${stats.frameWidth}×${stats.frameHeight}` : '—'}
          hint={stats.framesPerSecond !== undefined ? `${stats.framesPerSecond} fps` : undefined}
        />
        <Readout label="Route" value={ROUTE[stats.candidateType].label} hint={ROUTE[stats.candidateType].hint} />
      </div>
      <p className="text-[10px] text-muted-foreground">{PRESSURE_LABEL[stats.networkPressure]}</p>
    </div>
  )
}

function eventText(e: MediaFlowEvent): string {
  const who = e.direction === 'publish' ? 'Your' : e.peerName ? `${e.peerName}’s` : 'Their'
  return `${who} ${e.kind} ${e.outcome === 'stalled' ? 'stopped' : `came back after ${durationText(e.durationMs)}`}`
}

function agoText(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`
}

/** Plain text a participant can paste into a support message. */
function buildReport(local: LocalStats | null, peers: Array<{ name: string; stats?: PeerStats }>, events: MediaFlowEvent[]): string {
  const lines = ['Rendezvu connection report', new Date().toISOString(), '']
  lines.push(
    local
      ? `Your uplink: sending ${bitrateText(local.outboundBitrateKbps)} ${bitrateUnit(local.outboundBitrateKbps)}, latency ${rttText(local.roundTripTimeMs)} ms, route ${ROUTE[local.candidateType].label}`
      : 'Your uplink: not measured yet',
    '',
  )
  for (const { name, stats: s } of peers) {
    lines.push(
      s
        ? `${name}: ${QUALITY_LABEL[s.quality]}, latency ${rttText(s.roundTripTimeMs)} ms, loss ${s.packetLossPercent.toFixed(1)}%, ` +
            `jitter ${Math.round(s.jitterMs)} ms, receiving ${bitrateText(s.inboundBitrateKbps)} ${bitrateUnit(s.inboundBitrateKbps)}, ` +
            `${s.frameWidth ?? '?'}×${s.frameHeight ?? '?'} @ ${s.framesPerSecond ?? '?'} fps, route ${ROUTE[s.candidateType].label}`
        : `${name}: measuring`,
    )
  }
  if (events.length > 0) {
    lines.push('', 'Recent interruptions:')
    for (const e of events) lines.push(`  ${new Date(e.at).toISOString()} ${eventText(e)}`)
  }
  return lines.join('\n')
}

/**
 * The numbers behind the quality dots: what actually broke when someone says
 * "it froze". Everything comes from the stats monitor's 2 s poll.
 */
export function ConnectionDiagnostics() {
  const peers = usePeerStore((s) => s.peers)
  const peerStats = usePeerStore((s) => s.peerStats)
  const local = usePeerStore((s) => s.localStats)
  const events = usePeerStore((s) => s.mediaFlowEvents)
  const [copied, setCopied] = useState(false)

  const rows = [...peers.values()].map((p) => ({ id: p.id, name: p.name || 'Participant', stats: peerStats.get(p.id) }))
  // The poll's own clock: reading Date.now() during render would be impure.
  const now = local?.timestamp ?? events[0]?.at ?? 0

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(buildReport(local, rows, events))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // The clipboard needs permission and a secure page. Not worth an error here.
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className={card}>
        <span className="text-sm font-medium">Your connection</span>
        {local ? (
          <div className="grid grid-cols-3 gap-3">
            <Readout label="Sending" value={bitrateText(local.outboundBitrateKbps)} unit={bitrateUnit(local.outboundBitrateKbps)} />
            <Readout label="Latency" value={rttText(local.roundTripTimeMs)} unit="ms" tone={toneFor(local.roundTripTimeMs, RTT_GOOD_MS, RTT_MEDIUM_MS)} />
            <Readout label="Route" value={ROUTE[local.candidateType].label} hint={ROUTE[local.candidateType].hint} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Measuring. This fills in a few seconds after your camera or mic starts sending.</p>
        )}
      </div>

      {rows.length === 0 ? (
        <p className={cn(card, 'text-sm text-muted-foreground')}>No one else is here yet. Their numbers appear once someone joins.</p>
      ) : (
        rows.map((r) => <PeerBlock key={r.id} name={r.name} stats={r.stats} />)
      )}

      {events.length > 0 && (
        <div className={card}>
          <span className="text-sm font-medium">Recent interruptions</span>
          <ul className="flex flex-col gap-1.5">
            {events.map((e) => (
              <li key={e.id} className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className={e.outcome === 'stalled' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>{eventText(e)}</span>
                <span className="shrink-0 text-muted-foreground tabular-nums">{agoText(e.at, now)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button
        type="button"
        onClick={() => void copy()}
        className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-[hsl(var(--border)/0.4)] bg-surface-2/60 px-4 py-2.5 text-xs font-medium transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
        {copied ? 'Copied' : 'Copy report'}
      </button>
    </div>
  )
}
