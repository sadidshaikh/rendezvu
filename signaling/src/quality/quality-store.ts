import type { StatsReportPeer } from '@rendezvu/protocol'

export interface QualityEntry extends StatsReportPeer {
  roomId: string
  reporterId: string
  receivedAt: number
}

export interface QualityAggregate {
  good: number
  medium: number
  poor: number
  /** Over entries that have measured RTT. Null when none have. */
  avgRttMs: number | null
  avgLossPct: number | null
  relayed: number
  entries: number
}

/**
 * The latest report from each browser about each other person in its call.
 * Keyed by (reporter, remote): with the reporter alone, a report about one
 * person would overwrite the one about another. Phase 13 serves aggregate().
 */
export class QualityStore {
  private readonly entries = new Map<string, QualityEntry>()

  set(roomId: string, reporterId: string, peers: StatsReportPeer[], now = Date.now()): void {
    for (const p of peers) {
      this.entries.set(`${reporterId}|${p.peerId}`, { ...p, roomId, reporterId, receivedAt: now })
    }
  }

  /** A peer left: drop what it reported and what others reported about it. */
  removePeer(peerId: string): void {
    for (const [key, e] of this.entries) {
      if (e.reporterId === peerId || e.peerId === peerId) this.entries.delete(key)
    }
  }

  aggregate(): QualityAggregate {
    const agg: QualityAggregate = { good: 0, medium: 0, poor: 0, avgRttMs: null, avgLossPct: null, relayed: 0, entries: 0 }
    let rttSum = 0
    let rttCount = 0
    let lossSum = 0
    for (const e of this.entries.values()) {
      agg.entries++
      if (e.quality === 'good' || e.quality === 'medium' || e.quality === 'poor') agg[e.quality]++
      if (e.roundTripTimeMs >= 0) {
        rttSum += e.roundTripTimeMs
        rttCount++
      }
      lossSum += e.packetLossPercent
      if (e.candidateType === 'relay') agg.relayed++
    }
    if (rttCount > 0) agg.avgRttMs = rttSum / rttCount
    if (agg.entries > 0) agg.avgLossPct = lossSum / agg.entries
    return agg
  }
}
