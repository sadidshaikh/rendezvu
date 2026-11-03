import type { CandidateType, NetworkPressure, QualityGrade } from '@rendezvu/protocol'

export type FlowDirection = 'publish' | 'subscribe'
export type FlowKind = 'audio' | 'video'

/** One connection's stats for one poll, from SfuSession.collectStats(). */
export interface StatsSource {
  /** 'pub' or `sub:<remote session id>`. Stable across polls. */
  id: string
  direction: FlowDirection
  /** The remote publisher's session id, for subscribe sources. */
  sessionId?: string
  report: RTCStatsReport
  /**
   * Publish only: kinds with a real, live device behind them. A muted mic or
   * a camera that's off is silence by choice and must never count as a stall.
   */
  liveOutboundKinds: FlowKind[]
}

/** A stream that had been flowing and went silent, or one that came back. */
export interface FlowStall {
  sourceId: string
  direction: FlowDirection
  sessionId?: string
  kind: FlowKind
  /** Silence when detected; on recovery, how long the outage lasted. */
  stalledForMs: number
  /** It left the stats report entirely instead of going quiet in place. */
  vanished?: boolean
}

/** One connection's numbers at one poll. Rates and loss cover the time since the previous poll. */
export interface TransportSample {
  sourceId: string
  direction: FlowDirection
  sessionId?: string
  outboundKbps: number
  inboundKbps: number
  /** Share of inbound packets lost since the last poll, not since the call started. */
  packetLossPercent: number
  /** Of the ICE pair in use. -1 until measured. */
  roundTripTimeMs: number
  /** Inbound, the worst stream. */
  jitterMs: number
  candidateType: CandidateType
  /** Received video. */
  frameWidth?: number
  frameHeight?: number
  framesPerSecond?: number
}

export interface StatsMonitorOptions {
  /** Called on every poll, so connections created mid-call are picked up. */
  collect: () => Promise<StatsSource[]>
  onStall: (stall: FlowStall) => void
  onRecover: (stall: FlowStall) => void
  /** Once per poll, one sample per connection. */
  onPoll?: (samples: TransportSample[]) => void
}

export interface StatsMonitor {
  stop: () => void
}

const POLL_MS = 2_000
// Three polls in a row with nothing. One empty poll is normal (a gap between
// keyframes, a busy CPU); six seconds on a stream that was flowing is not.
const STALL_AFTER_MS = 6_000
// Background tabs slow timers down, to once a minute in some browsers. A gap
// that long wasn't watched, so it restarts the silence clocks instead of
// counting as silence. Otherwise a background tab rebuilds healthy connections.
const LATE_POLL_MS = POLL_MS * 3

interface StreamRecord {
  sourceId: string
  direction: FlowDirection
  sessionId?: string
  kind: FlowKind
  bytes: number
  /** The report's own clock for `bytes`, so a late poll still gives the right rate. */
  statsTs: number
  packetsReceived: number
  packetsLost: number
  /** The poll that last saw this stream in a report. */
  lastSeenAt: number
  /** The poll that last saw its bytes go up. */
  lastFlowAt: number
  /**
   * Only a stream that once flowed can stall. One that never delivered is a
   * dead pull, which SfuSession catches with its own timer.
   */
  everFlowed: boolean
  stalled: boolean
  stalledSince: number
}

interface RtpStats {
  type: string
  timestamp: number
  ssrc?: number
  kind?: string
  mediaType?: string
  bytesSent?: number
  bytesReceived?: number
  packetsReceived?: number
  packetsLost?: number
  jitter?: number
  frameWidth?: number
  frameHeight?: number
  framesPerSecond?: number
}

interface PairStats {
  type: string
  state?: string
  nominated?: boolean
  currentRoundTripTime?: number
  localCandidateId?: string
  selectedCandidatePairId?: string
  candidateType?: string
}

/**
 * Turns stats reports into "is media flowing right now", per stream. Reports
 * facts and takes no action: it never touches a connection, and whether a
 * remote silence matters is for the caller to judge against what that person
 * says they're sending.
 */
export function startStatsMonitor(opts: StatsMonitorOptions): StatsMonitor {
  // `${sourceId}|${in|out}|${ssrc}` → bookkeeping.
  const streams = new Map<string, StreamRecord>()
  let stopped = false
  let polling = false
  let lastPollAt = 0

  const poll = async () => {
    if (stopped || polling) return
    polling = true
    try {
      await pollOnce()
    } finally {
      polling = false
    }
  }

  const pollOnce = async () => {
    let sources: StatsSource[]
    try {
      sources = await opts.collect()
    } catch {
      // A connection closing under us rejects getStats(). The next poll reads the live set.
      return
    }
    if (stopped) return

    const t = Date.now()
    const late = lastPollAt > 0 && t - lastPollAt > LATE_POLL_MS
    lastPollAt = t

    // Forget connections that went away (person left, connection rebuilt), so
    // their last streams don't age into stalls nobody is waiting for.
    const live = new Map(sources.map((s) => [s.id, s]))
    for (const [key, r] of streams) if (!live.has(r.sourceId)) streams.delete(key)

    const samples = sources.map((source) => readSource(source, t, late))
    findVanished(live, t, late)
    if (samples.length > 0) opts.onPoll?.(samples)
  }

  const readSource = (source: StatsSource, t: number, late: boolean): TransportSample => {
    const liveOut = new Set(source.liveOutboundKinds)
    let outBits = 0
    let inBits = 0
    let received = 0
    let lost = 0
    let jitterMs = 0
    let frameWidth: number | undefined
    let frameHeight: number | undefined
    let framesPerSecond: number | undefined
    source.report.forEach((raw: unknown) => {
      const s = raw as RtpStats
      const outbound = s.type === 'outbound-rtp'
      if (!outbound && s.type !== 'inbound-rtp') return
      const kind = s.kind ?? s.mediaType
      if (kind !== 'audio' && kind !== 'video') return
      const bytes = outbound ? s.bytesSent : s.bytesReceived
      if (typeof bytes !== 'number') return

      const key = `${source.id}|${outbound ? 'out' : 'in'}|${s.ssrc ?? 0}`
      const prev = streams.get(key)
      const record: StreamRecord = prev ?? {
        sourceId: source.id,
        direction: source.direction,
        sessionId: source.sessionId,
        kind,
        bytes,
        statsTs: s.timestamp,
        packetsReceived: s.packetsReceived ?? 0,
        packetsLost: s.packetsLost ?? 0,
        lastSeenAt: t,
        lastFlowAt: t,
        everFlowed: false,
        stalled: false,
        stalledSince: 0,
      }
      const flowing = prev !== undefined && bytes > prev.bytes
      if (prev) {
        // bytes × 8 / ms is kilobits per second.
        const ms = s.timestamp > prev.statsTs ? s.timestamp - prev.statsTs : POLL_MS
        const kbps = flowing ? ((bytes - prev.bytes) * 8) / ms : 0
        if (outbound) outBits += kbps
        else {
          inBits += kbps
          received += Math.max(0, (s.packetsReceived ?? 0) - prev.packetsReceived)
          lost += Math.max(0, (s.packetsLost ?? 0) - prev.packetsLost)
        }
      }
      if (!outbound) {
        if (typeof s.jitter === 'number') jitterMs = Math.max(jitterMs, s.jitter * 1000)
        if (kind === 'video') {
          frameWidth = s.frameWidth ?? frameWidth
          frameHeight = s.frameHeight ?? frameHeight
          framesPerSecond = s.framesPerSecond ?? framesPerSecond
        }
      }
      record.bytes = bytes
      record.statsTs = s.timestamp
      record.packetsReceived = s.packetsReceived ?? 0
      record.packetsLost = s.packetsLost ?? 0
      record.lastSeenAt = t
      streams.set(key, record)

      if (flowing) {
        record.lastFlowAt = t
        record.everFlowed = true
        if (record.stalled) {
          record.stalled = false
          opts.onRecover(stallOf(record, t - record.stalledSince))
        }
        return
      }
      // Muted or camera off: hold the clock so silence by choice never adds up.
      if (outbound && !liveOut.has(kind)) {
        record.lastFlowAt = t
        if (record.stalled) {
          record.stalled = false
          opts.onRecover(stallOf(record, t - record.stalledSince))
        }
        return
      }
      if (late) {
        record.lastFlowAt = t
        return
      }
      if (record.everFlowed && !record.stalled && t - record.lastFlowAt >= STALL_AFTER_MS) {
        record.stalled = true
        record.stalledSince = t
        opts.onStall(stallOf(record, t - record.lastFlowAt))
      }
    })

    const { rttMs, candidateType } = readPath(source.report)
    return {
      sourceId: source.id,
      direction: source.direction,
      sessionId: source.sessionId,
      outboundKbps: round(outBits),
      inboundKbps: round(inBits),
      packetLossPercent: received + lost > 0 ? round((lost / (received + lost)) * 100) : 0,
      roundTripTimeMs: rttMs,
      jitterMs: round(jitterMs),
      candidateType,
      frameWidth,
      frameHeight,
      framesPerSecond: framesPerSecond === undefined ? undefined : Math.round(framesPerSecond),
    }
  }

  /**
   * A stream can leave the report entirely: the SFU stopped forwarding it, or
   * a renegotiation dropped it. Without this sweep that's the one failure the
   * monitor would never see; the tile just keeps its last frame.
   */
  const findVanished = (live: Map<string, StatsSource>, t: number, late: boolean) => {
    for (const [key, r] of streams) {
      if (r.lastSeenAt === t || !r.everFlowed) continue
      // Browsers give a stream a new ssrc after a renegotiation or a device
      // switch. Another current stream of the same kind on the same connection
      // means it was replaced, not lost.
      const replaced = [...streams.values()].some(
        (o) => o !== r && o.lastSeenAt === t && o.sourceId === r.sourceId && o.direction === r.direction && o.kind === r.kind,
      )
      if (replaced) {
        streams.delete(key)
        // A stalled stream whose connection was rebuilt comes back as a new one.
        if (r.stalled) opts.onRecover(stallOf(r, t - r.stalledSince))
        continue
      }
      if (r.stalled) continue
      const source = live.get(r.sourceId)
      if (late || (r.direction === 'publish' && !source?.liveOutboundKinds.includes(r.kind))) {
        r.lastFlowAt = t
        continue
      }
      if (t - r.lastFlowAt < STALL_AFTER_MS) continue
      r.stalled = true
      r.stalledSince = t
      opts.onStall({ ...stallOf(r, t - r.lastFlowAt), vanished: true })
    }
  }

  const timer = setInterval(() => void poll(), POLL_MS)

  return {
    stop() {
      stopped = true
      clearInterval(timer)
      streams.clear()
    },
  }
}

function stallOf(r: StreamRecord, ms: number): FlowStall {
  return { sourceId: r.sourceId, direction: r.direction, sessionId: r.sessionId, kind: r.kind, stalledForMs: Math.round(ms) }
}

/** RTT and route of the ICE pair in use: named on the transport (Chrome), or the nominated one (Firefox). */
function readPath(report: RTCStatsReport): { rttMs: number; candidateType: CandidateType } {
  let pair: PairStats | undefined
  report.forEach((raw: unknown) => {
    const s = raw as PairStats
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId)
  })
  if (!pair) {
    report.forEach((raw: unknown) => {
      const s = raw as PairStats
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || !pair)) pair = s
    })
  }
  const rtt = pair?.currentRoundTripTime
  const local = pair?.localCandidateId ? (report.get(pair.localCandidateId) as PairStats | undefined) : undefined
  const type = local?.candidateType
  return {
    rttMs: typeof rtt === 'number' && Number.isFinite(rtt) ? round(rtt * 1000) : -1,
    candidateType: type === 'host' || type === 'srflx' || type === 'relay' ? type : type === 'prflx' ? 'srflx' : 'unknown',
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}

// The same boundaries colour the numbers in the diagnostics panel, so a red
// latency there and a red dot on the tile never disagree.
export const RTT_GOOD_MS = 200
export const RTT_MEDIUM_MS = 400
export const LOSS_GOOD_PCT = 2
export const LOSS_MEDIUM_PCT = 5

/**
 * For the tile dot. `videoFps` only when that person says their camera is on
 * (and not held): 0 frames arriving then is poor whatever the network says.
 */
export function gradeQuality(rttMs: number, lossPercent: number, videoFps?: number): QualityGrade {
  if (videoFps !== undefined && videoFps <= 0) return 'poor'
  if (rttMs < 0) return 'unknown'
  if (rttMs < RTT_GOOD_MS && lossPercent < LOSS_GOOD_PCT) return 'good'
  if (rttMs < RTT_MEDIUM_MS && lossPercent < LOSS_MEDIUM_PCT) return 'medium'
  return 'poor'
}

/** How much headroom is left, for the diagnostics panel. */
export function gradeNetworkPressure(rttMs: number, lossPercent: number): NetworkPressure {
  if (rttMs < 0) return 'unknown'
  if (lossPercent < 1 && rttMs < 150) return 'low'
  if (lossPercent < 3 && rttMs < 300) return 'medium'
  if (lossPercent < 8 && rttMs < 600) return 'high'
  return 'severe'
}
