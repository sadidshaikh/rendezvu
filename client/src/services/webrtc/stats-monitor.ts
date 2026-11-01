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

export interface StatsMonitorOptions {
  /** Called on every poll, so connections created mid-call are picked up. */
  collect: () => Promise<StatsSource[]>
  onStall: (stall: FlowStall) => void
  onRecover: (stall: FlowStall) => void
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
  ssrc?: number
  kind?: string
  mediaType?: string
  bytesSent?: number
  bytesReceived?: number
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

    for (const source of sources) readSource(source, t, late)
    findVanished(live, t, late)
  }

  const readSource = (source: StatsSource, t: number, late: boolean) => {
    const liveOut = new Set(source.liveOutboundKinds)
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
        lastSeenAt: t,
        lastFlowAt: t,
        everFlowed: false,
        stalled: false,
        stalledSince: 0,
      }
      const flowing = prev !== undefined && bytes > prev.bytes
      record.bytes = bytes
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
