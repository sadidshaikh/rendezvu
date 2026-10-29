import type { SfuSession } from './sfu-session'

export interface CallReconcilerOptions {
  /** Read live: the session doesn't exist yet when the first `sfu-tracks` arrive. */
  getSession: () => SfuSession | null
  /** A pulled track arrived for this participant (again, if the connection was rebuilt). */
  onTrack: (peerId: string, track: MediaStreamTrack) => void
  /** A track we were receiving is no longer wanted: the person left, unpublished, or moved session. */
  onTrackGone: (peerId: string, track: MediaStreamTrack) => void
}

interface DesiredTracks {
  sessionId: string
  trackNames: Set<string>
}

interface Pull {
  stop: () => void
  track?: MediaStreamTrack
  timer?: ReturnType<typeof setTimeout>
}

interface AppliedTracks {
  sessionId: string
  pulls: Map<string, Pull>
}

// A pull normally delivers its track in 1–3 s. Automatic repair is Phase 9;
// for now a pull that never delivers is at least visible in the console.
const PULL_WARN_AFTER_MS = 15_000

/**
 * Keeps what we pull in line with what the room says is published.
 *
 * `desired` comes from `sfu-tracks` and `peer-left`; `applied` is what we
 * have actually asked Cloudflare for. reconcile() closes the gap. Recording
 * messages as desired state, instead of pulling inside the message handler,
 * matters twice:
 * - the join replay arrives before our SFU session exists. It's recorded,
 *   and the reconcile right after the session is created acts on it.
 * - a person who rebuilds their publish connection announces a new session
 *   id. The old one is no longer desired, so its connection is closed rather
 *   than left pulling from a dead session.
 */
export class CallReconciler {
  private readonly opts: CallReconcilerOptions
  private readonly desired = new Map<string, DesiredTracks>()
  private readonly applied = new Map<string, AppliedTracks>()

  constructor(opts: CallReconcilerOptions) {
    this.opts = opts
  }

  /**
   * One participant's full current set, from `sfu-tracks`. An empty set
   * withdraws that session, and only that one: a late withdrawal of an old
   * session must not erase the newer set that replaced it.
   */
  setPeerTracks(peerId: string, sessionId: string, trackNames: string[]): void {
    if (trackNames.length === 0) {
      if (this.desired.get(peerId)?.sessionId === sessionId) this.desired.delete(peerId)
      return
    }
    this.desired.set(peerId, { sessionId, trackNames: new Set(trackNames) })
  }

  removePeer(peerId: string): void {
    this.desired.delete(peerId)
  }

  /** Which participant owns a remote publish session. */
  peerForSession(sessionId: string): string | undefined {
    for (const [peerId, d] of this.desired) {
      if (d.sessionId === sessionId) return peerId
    }
    return undefined
  }

  reconcile(): void {
    const session = this.opts.getSession()
    if (!session) return

    // Drop what's no longer wanted first, so a moved session is closed before its replacement opens.
    for (const [peerId, applied] of this.applied) {
      const desired = this.desired.get(peerId)
      if (!desired || desired.sessionId !== applied.sessionId) {
        for (const name of applied.pulls.keys()) this.stopPull(peerId, applied, name)
        session.unsubscribeSession(applied.sessionId)
        this.applied.delete(peerId)
        continue
      }
      for (const name of applied.pulls.keys()) {
        if (!desired.trackNames.has(name)) this.stopPull(peerId, applied, name)
      }
    }

    for (const [peerId, desired] of this.desired) {
      let applied = this.applied.get(peerId)
      if (!applied) {
        applied = { sessionId: desired.sessionId, pulls: new Map() }
        this.applied.set(peerId, applied)
      }
      for (const name of desired.trackNames) {
        if (!applied.pulls.has(name)) this.startPull(session, peerId, applied, name)
      }
    }
  }

  /** Stops the warning timers. The SfuSession's destroy() closes the connections themselves. */
  dispose(): void {
    for (const applied of this.applied.values()) {
      for (const pull of applied.pulls.values()) clearTimeout(pull.timer)
    }
    this.applied.clear()
    this.desired.clear()
  }

  private startPull(session: SfuSession, peerId: string, applied: AppliedTracks, trackName: string): void {
    const pull: Pull = { stop: () => {} }
    applied.pulls.set(trackName, pull)
    pull.timer = setTimeout(() => {
      console.warn(`[call] no track from ${peerId} (${trackName}) after ${PULL_WARN_AFTER_MS / 1000} s`)
    }, PULL_WARN_AFTER_MS)
    pull.stop = session.subscribeTrack(applied.sessionId, trackName, (track) => {
      // A pull stopped a moment ago can still deliver; it's no longer ours.
      if (applied.pulls.get(trackName) !== pull) return
      clearTimeout(pull.timer)
      if (pull.track && pull.track !== track) this.opts.onTrackGone(peerId, pull.track)
      pull.track = track
      this.opts.onTrack(peerId, track)
    })
  }

  private stopPull(peerId: string, applied: AppliedTracks, trackName: string): void {
    const pull = applied.pulls.get(trackName)
    if (!pull) return
    applied.pulls.delete(trackName)
    clearTimeout(pull.timer)
    pull.stop()
    if (pull.track) this.opts.onTrackGone(peerId, pull.track)
  }
}
