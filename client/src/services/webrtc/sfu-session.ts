import { BehaviorSubject, of, type Subscription } from 'rxjs'
import { PartyTracks } from 'partytracks/client'
import type { SfuTracksData } from '@rendezvu/protocol'
import { httpServerUri } from '@/lib/config'
import { createBlackVideoTrack, createSilentAudioTrack } from '@/lib/placeholder-tracks'
import { RepairLoop } from './repair-loop'
import type { FlowDirection, FlowKind, StatsSource } from './stats-monitor'

/** One repair attempt, or a repair that worked. For the console; later for telemetry. */
export interface RepairInfo {
  stage: FlowDirection
  /** 1 = retry in place. 2 = rebuild that connection with a fresh Cloudflare session. */
  rung: number
  attempt: number
  kind?: string
  /** The remote publisher's session, for subscribe repairs. */
  sessionId?: string
  trackName?: string
}

export interface SfuSessionOptions {
  roomId: string
  /** This tab's id, the same across reconnects. The server ties our Cloudflare sessions to it. */
  presenceId: string
  iceServers: RTCIceServer[]
  /**
   * The full set of tracks Cloudflare has confirmed for our publish session.
   * Fires on the first confirmation and on every real change, never for a
   * push that was only accepted. An empty set withdraws a session that is
   * being rebuilt. The caller sends it as `sfu-announce`.
   */
  onLocalTracksChanged?: (announcement: SfuTracksData) => void
  /** A push got no confirmation within the repair window. The repair has already started. */
  onPublishTimeout?: (kind: string) => void
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void
  onRepair?: (info: RepairInfo) => void
  onRepaired?: (info: RepairInfo) => void
  /** Whether a repair is running for one remote publisher's media. For the tile badge. */
  onRemoteHealth?: (remoteSessionId: string, reconnecting: boolean) => void
}

/** Our subscribe connection to one remote publisher. Replaced as a whole by a rebuild. */
interface RemoteConnection {
  tracks: PartyTracks
  /** Callbacks from an older connection to the same publisher check this and stop. */
  generation: number
  /** session$ and the connection state. The pulls themselves are in `pulls`. */
  subscriptions: Subscription[]
  /** Our own Cloudflare session id for this connection, once created. */
  sessionId?: string
}

/** One remote track we want. Outlives retries and rebuilds; only unsubscribing ends it. */
interface Pull {
  remoteSessionId: string
  trackName: string
  onTrack: (track: MediaStreamTrack) => void
  sub?: Subscription
  /** The dead-pull timer: no track within the repair window. */
  timer?: ReturnType<typeof setTimeout>
  arrived: boolean
}

const SFU_PREFIX = `${httpServerUri}/sfu`
// How long a push may go unconfirmed, or a pull without a track, before it's
// repaired. Setups normally take 1–3 s; this grows on slow networks (see repairWindow).
const MIN_REPAIR_WINDOW_MS = 15_000
const MAX_REPAIR_WINDOW_MS = 60_000
const SETUP_SAMPLES = 40
// A stalled stream gets this long to come back by itself before its connection
// is rebuilt. Phones switching networks recover; a rebuild would only add to it.
const STALL_GRACE_MS = 20_000
// One connection is rebuilt at most this often, however many signals ask.
const REBUILD_EVERY_MS = 30_000
// A rebuilt publish session is released a moment later, after the withdrawal
// naming it has reached the server.
const RETIRE_DELAY_MS = 5_000

/**
 * Everything between this browser and Cloudflare's SFU. The only code that
 * touches RTCPeerConnection for calls.
 *
 * One publish session (send only) carries all our tracks. Each remote
 * publisher we pull from gets its own subscribe session, so renegotiating or
 * rebuilding one person's connection can never disturb another's.
 *
 * Anything that stops working gets repaired, more firmly each time, for as
 * long as the session lives: retry the one track, then rebuild that
 * connection. destroy() cancels every repair before closing anything.
 */
export class SfuSession {
  private readonly opts: SfuSessionOptions
  private readonly params: string
  // partytracks keeps a reference to this array and reads it whenever it
  // builds a new connection, so refreshed credentials are swapped in place.
  private readonly iceServers: RTCIceServer[]
  // 'pub' or `sub:<remote session id>` → the live connection.
  private readonly peerConnections = new Map<string, RTCPeerConnection>()
  private destroyed = false

  // ── Publish ──
  private pubTracks: PartyTracks
  /** Goes up on every publish rebuild. A callback from before one does nothing. */
  private pubGeneration = 0
  private pubWired = false
  private readonly pubSubscriptions: Subscription[] = []
  // Our current publish session ids, released with DELETE on destroy or rebuild.
  private readonly pubSessionIds = new Set<string>()
  private readonly retireTimers = new Map<ReturnType<typeof setTimeout>, string[]>()
  // kind → subject feeding that kind's push. A new value swaps the track on
  // the existing sender, with no renegotiation.
  private readonly localSubjects = new Map<string, BehaviorSubject<MediaStreamTrack>>()
  // kind → the track that should be going out now: a device, the screen, or a
  // placeholder. A retry or rebuild pushes this, never the track it started with.
  private readonly currentTracks = new Map<string, MediaStreamTrack>()
  // kind → the stand-in being sent while that device is off. Lives exactly as
  // long as it is the track being sent.
  private readonly placeholders = new Map<string, MediaStreamTrack>()
  private readonly pushSubs = new Map<string, Subscription>()
  private readonly ackTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // kind → what Cloudflare confirmed for it.
  private readonly published = new Map<string, { sessionId: string; trackName: string }>()
  private lastPubSessionId: string | null = null
  private lastAnnouncedJson = ''

  // ── Subscribe ──
  // Remote publisher's session id → our subscribe connection to it.
  private readonly remotes = new Map<string, RemoteConnection>()
  private remoteGeneration = 0
  // `${remote session id}/${trackName}` → the pull.
  private readonly pulls = new Map<string, Pull>()
  private readonly remoteHealth = new Map<string, boolean>()

  // ── Repair ──
  private readonly pushRepairs = new Map<string, RepairLoop>()
  private readonly pullRepairs = new Map<string, RepairLoop>()
  // 'pub' | `sub:<id>` → repair for a connection that went `failed`.
  private readonly connRepairs = new Map<string, RepairLoop>()
  // 'pub' | `sub:<id>` → the grace, then rebuild, for a stalled stream.
  private readonly flowRepairs = new Map<string, RepairLoop>()
  private readonly lastRebuildAt = new Map<string, number>()
  private readonly deferredRebuilds = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly setupDurations: number[] = []

  constructor(opts: SfuSessionOptions) {
    this.opts = opts
    this.iceServers = [...opts.iceServers]
    // presenceId, not the peer id, proves the sessions are ours: it survives a
    // signaling reconnect, and nobody else in the room ever sees it.
    this.params = [
      `roomId=${encodeURIComponent(opts.roomId)}`,
      `presenceId=${encodeURIComponent(opts.presenceId)}`,
    ].join('&')
    this.pubTracks = this.newPubTracks()
  }

  get publishPeerConnection(): RTCPeerConnection | undefined {
    return this.peerConnections.get('pub')
  }

  subscribePeerConnection(remoteSessionId: string): RTCPeerConnection | undefined {
    return this.peerConnections.get(`sub:${remoteSessionId}`)
  }

  /** Pushes every live track in the stream. Safe to call again with the same or a changed stream. */
  publish(stream: MediaStream): void {
    for (const track of stream.getTracks()) {
      if (track.readyState === 'live') this.publishTrack(track)
    }
  }

  /**
   * The device of this kind is about to stop (mic muted, camera off, share
   * ended). Sends silence or black frames on the existing sender instead, so
   * the connection stays as it is and turning the device back on is a swap,
   * not a new track. Does nothing if this kind was never pushed: nobody is
   * announced a placeholder.
   */
  sendPlaceholder(kind: 'audio' | 'video'): void {
    if (this.destroyed || !this.currentTracks.has(kind) || this.placeholders.has(kind)) return
    const track = kind === 'audio' ? createSilentAudioTrack() : createBlackVideoTrack()
    if (!track) return
    this.placeholders.set(kind, track)
    this.currentTracks.set(kind, track)
    // No subject while a retry is between teardown and push: the push picks it up.
    this.localSubjects.get(kind)?.next(track)
  }

  /**
   * Pulls one remote track. `onTrack` fires with the received track, and
   * again with a new one whenever a repair rebuilds the connection. Returns
   * the unsubscribe.
   */
  subscribeTrack(remoteSessionId: string, trackName: string, onTrack: (track: MediaStreamTrack) => void): () => void {
    if (this.destroyed) return () => {}
    const key = `${remoteSessionId}/${trackName}`
    const existing = this.pulls.get(key)
    if (existing) this.stopPull(key, existing)
    const pull: Pull = { remoteSessionId, trackName, onTrack, arrived: false }
    this.pulls.set(key, pull)
    this.startPull(pull)
    return () => this.stopPull(key, pull)
  }

  /**
   * Stops every pull from one remote publisher, cancels their repairs, closes
   * our connection to it and releases that subscribe session. For a person
   * who left, or whose publish session was replaced by a new one.
   */
  unsubscribeSession(remoteSessionId: string): void {
    for (const [key, pull] of this.pulls) {
      if (pull.remoteSessionId === remoteSessionId) this.stopPull(key, pull)
    }
    const connKey = `sub:${remoteSessionId}`
    this.cancelLoop(this.connRepairs, connKey)
    this.cancelLoop(this.flowRepairs, connKey)
    this.cancelDeferredRebuild(connKey)
    this.lastRebuildAt.delete(connKey)
    const remote = this.remotes.get(remoteSessionId)
    if (remote) this.disposeRemote(remoteSessionId, remote)
    if (this.remoteHealth.get(remoteSessionId)) this.opts.onRemoteHealth?.(remoteSessionId, false)
    this.remoteHealth.delete(remoteSessionId)
  }

  /** Fresh TURN credentials: live connections get them now, rebuilt ones read the shared array. */
  updateIceServers(servers: RTCIceServer[]): void {
    if (this.destroyed) return
    this.iceServers.splice(0, this.iceServers.length, ...servers)
    for (const pc of this.peerConnections.values()) {
      try {
        pc.setConfiguration({ ...pc.getConfiguration(), iceServers: servers })
      } catch (err) {
        console.warn('[sfu] could not update ICE servers', err)
      }
    }
  }

  /**
   * The set last announced, to send again after a signaling reconnect: the
   * server dropped it with our old connection. Null if nothing is published.
   */
  currentAnnouncement(): SfuTracksData | null {
    return this.lastAnnouncedJson ? (JSON.parse(this.lastAnnouncedJson) as SfuTracksData) : null
  }

  /**
   * One stats report per live connection, for the stats monitor. Reports, not
   * connections, leave this class. A connection that is closed or whose
   * getStats() fails is left out.
   */
  async collectStats(): Promise<StatsSource[]> {
    if (this.destroyed) return []
    const read = async (id: string, pc: RTCPeerConnection): Promise<StatsSource | null> => {
      if (pc.connectionState === 'closed') return null
      try {
        const report = await pc.getStats()
        if (id === 'pub') return { id, direction: 'publish', report, liveOutboundKinds: this.liveOutboundKinds() }
        return { id, direction: 'subscribe', sessionId: id.slice(4), report, liveOutboundKinds: [] }
      } catch {
        return null
      }
    }
    const sources = await Promise.all([...this.peerConnections].map(([id, pc]) => read(id, pc)))
    return sources.filter((s): s is StatsSource => s !== null)
  }

  /**
   * A stream that was flowing went silent. Waits STALL_GRACE_MS for it to
   * come back by itself; if it doesn't, rebuilds that connection only.
   */
  repairStalledFlow(direction: FlowDirection, remoteSessionId?: string): void {
    if (this.destroyed) return
    if (direction === 'publish') {
      if (!this.pubWired) return
      this.flowRepair('pub', 'publish', () => this.rebuildPublish()).schedule()
      return
    }
    if (!remoteSessionId || !this.remotes.has(remoteSessionId)) return
    this.flowRepair(`sub:${remoteSessionId}`, 'subscribe', () => this.rebuildRemote(remoteSessionId)).schedule()
    this.emitRemoteHealth(remoteSessionId)
  }

  /** Bytes are moving again: cancels the grace, or records that the rebuild worked. */
  settleStalledFlow(direction: FlowDirection, remoteSessionId?: string): void {
    const key = direction === 'publish' ? 'pub' : remoteSessionId ? `sub:${remoteSessionId}` : null
    if (!key) return
    const loop = this.flowRepairs.get(key)
    if (!loop?.repairing) return
    if (loop.attempts > 0) this.opts.onRepaired?.({ stage: direction, rung: 2, attempt: loop.attempts, sessionId: remoteSessionId })
    loop.settle()
    this.cancelDeferredRebuild(key)
    if (remoteSessionId) this.emitRemoteHealth(remoteSessionId)
  }

  /** Cancels every repair first, then stops every push and pull, closes the connections and releases our sessions. */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const loops of [this.pushRepairs, this.pullRepairs, this.connRepairs, this.flowRepairs]) {
      for (const loop of loops.values()) loop.cancel()
      loops.clear()
    }
    for (const timer of this.deferredRebuilds.values()) clearTimeout(timer)
    this.deferredRebuilds.clear()
    for (const timer of this.ackTimers.values()) clearTimeout(timer)
    this.ackTimers.clear()

    for (const sub of this.pushSubs.values()) sub.unsubscribe()
    this.pushSubs.clear()
    for (const track of this.placeholders.values()) track.stop()
    this.placeholders.clear()
    for (const sub of this.pubSubscriptions) sub.unsubscribe()
    for (const sessionId of this.pubSessionIds) this.releaseSession(sessionId)
    for (const [timer, ids] of this.retireTimers) {
      clearTimeout(timer)
      ids.forEach((id) => this.releaseSession(id))
    }
    this.retireTimers.clear()

    for (const pull of this.pulls.values()) {
      clearTimeout(pull.timer)
      pull.sub?.unsubscribe()
    }
    this.pulls.clear()
    for (const [id, remote] of this.remotes) this.disposeRemote(id, remote)
    this.peerConnections.clear()
  }

  // ── Publish ──────────────────────────────────────────────────────────────

  private newPubTracks(): PartyTracks {
    // Constructing PartyTracks makes no request. The Cloudflare session is
    // created on the first push: an idle session with no connection is closed
    // by Cloudflare after ~30 s, which would break joining with media off.
    return new PartyTracks({
      prefix: SFU_PREFIX,
      apiExtraParams: `${this.params}&kind=publish`,
      iceServers: this.iceServers,
    })
  }

  private publishTrack(track: MediaStreamTrack): void {
    if (this.destroyed) return
    const kind = track.kind
    this.currentTracks.set(kind, track)
    const subject = this.localSubjects.get(kind)
    if (subject) {
      if (subject.value !== track) subject.next(track)
    } else if (!this.pushSubs.has(kind)) {
      this.startPush(kind, track)
    }
    // Replaced by a real device. partytracks finishes the swap on its own; a
    // stopped placeholder in the meantime only means a moment of nothing.
    const placeholder = this.placeholders.get(kind)
    if (placeholder && placeholder !== track) {
      placeholder.stop()
      this.placeholders.delete(kind)
    }
  }

  /** Subscribing here, not in the constructor, keeps the Cloudflare session from existing before there is something to send. */
  private wirePublish(): void {
    this.pubWired = true
    this.pubSubscriptions.push(
      this.pubTracks.session$.subscribe(({ peerConnection, sessionId }) => {
        this.peerConnections.set('pub', peerConnection)
        this.pubSessionIds.add(sessionId)
      }),
      this.pubTracks.peerConnectionState$.subscribe((state) => {
        this.opts.onConnectionStateChange?.(state)
        this.onConnectionState('pub', 'publish', state, () => this.rebuildPublish())
      }),
    )
  }

  /** One kind's push, with its confirmation timer. Re-run as is by a retry. */
  private startPush(kind: string, track: MediaStreamTrack): void {
    if (this.destroyed) return
    if (!this.pubWired) this.wirePublish()
    const generation = this.pubGeneration
    const startedAt = Date.now()
    let confirmed = false

    // partytracks retries a failing push internally forever, so a push that
    // can't reach Cloudflare looks just like a slow one. Only the missing
    // confirmation tells them apart.
    this.ackTimers.set(
      kind,
      setTimeout(() => {
        if (generation !== this.pubGeneration || this.destroyed) return
        this.ackTimers.delete(kind)
        this.opts.onPublishTimeout?.(kind)
        this.pushRepair(kind).schedule()
      }, this.repairWindow()),
    )

    const subject = new BehaviorSubject(track)
    this.localSubjects.set(kind, subject)
    const sub = this.pubTracks.push(subject.asObservable()).subscribe({
      // Cloudflare confirmed the track. Also fires again, with a new session
      // id, if partytracks rebuilt the connection itself and pushed again.
      next: (meta) => {
        if (generation !== this.pubGeneration || this.destroyed) return
        this.clearAckTimer(kind)
        if (!meta.sessionId || !meta.trackName) return
        if (!confirmed) {
          confirmed = true
          this.recordSetup(startedAt)
        }
        this.published.set(kind, { sessionId: meta.sessionId, trackName: meta.trackName })
        this.lastPubSessionId = meta.sessionId
        this.settlePushRepair(kind)
        this.settleConnection('pub', 'publish')
        this.emitLocalTracksChanged()
      },
      error: (err) => {
        if (generation !== this.pubGeneration || this.destroyed) return
        console.error(`[sfu] push ${kind} failed`, err)
        // A failed push is finished for good. Drop it, so the retry (or the
        // next publish of this kind) starts over instead of feeding a dead subject.
        this.teardownPush(kind)
        this.published.delete(kind)
        this.pushRepair(kind).schedule()
      },
    })
    this.pushSubs.set(kind, sub)
  }

  private teardownPush(kind: string): void {
    this.clearAckTimer(kind)
    this.pushSubs.get(kind)?.unsubscribe()
    this.pushSubs.delete(kind)
    this.localSubjects.delete(kind)
  }

  private pushRepair(kind: string): RepairLoop {
    let loop = this.pushRepairs.get(kind)
    if (!loop) {
      loop = new RepairLoop({
        maxRung: 2,
        repair: (rung, attempt) => {
          if (this.destroyed) return
          this.opts.onRepair?.({ stage: 'publish', rung, attempt, kind })
          if (rung >= 2) this.rebuildPublish()
          else this.repush(kind)
        },
      })
      this.pushRepairs.set(kind, loop)
    }
    return loop
  }

  private settlePushRepair(kind: string): void {
    const loop = this.pushRepairs.get(kind)
    if (!loop?.repairing) return
    this.opts.onRepaired?.({ stage: 'publish', rung: loop.nextRung, attempt: loop.attempts, kind })
    loop.settle()
  }

  /** Rung 1: the same push again, on the same Cloudflare session, with whatever track should be going out now. */
  private repush(kind: string): void {
    const track = this.currentTracks.get(kind)
    if (!track || track.readyState !== 'live') {
      // Turned off while we waited: nothing to repair.
      this.pushRepairs.get(kind)?.reset()
      return
    }
    this.teardownPush(kind)
    this.startPush(kind, track)
  }

  /**
   * Rung 2: a new publish connection with a fresh Cloudflare session. The old
   * set is withdrawn first so nobody keeps pulling names that are about to
   * stop existing, then every kind is pushed again with its current track,
   * and the new set is announced as each is confirmed.
   */
  private rebuildPublish(): void {
    if (this.destroyed) return
    if (this.deferRebuild('pub', () => this.rebuildPublish())) return
    console.info('[sfu] rebuilding the publish connection')
    const previous = this.currentAnnouncement()
    if (previous) this.opts.onLocalTracksChanged?.({ sessionId: previous.sessionId, tracks: [] })
    this.lastAnnouncedJson = ''

    this.pubGeneration++
    for (const kind of [...this.pushSubs.keys()]) this.teardownPush(kind)
    this.localSubjects.clear()
    for (const sub of this.pubSubscriptions.splice(0)) sub.unsubscribe()
    this.pubWired = false
    this.peerConnections.delete('pub')
    this.published.clear()
    this.lastPubSessionId = null
    this.retire([...this.pubSessionIds])
    this.pubSessionIds.clear()

    this.pubTracks = this.newPubTracks()
    for (const [kind, track] of this.currentTracks) {
      if (track.readyState === 'live') this.startPush(kind, track)
    }
  }

  /** Released after the withdrawal naming them has had time to reach the server. */
  private retire(sessionIds: string[]): void {
    if (sessionIds.length === 0) return
    const timer = setTimeout(() => {
      this.retireTimers.delete(timer)
      sessionIds.forEach((id) => this.releaseSession(id))
    }, RETIRE_DELAY_MS)
    this.retireTimers.set(timer, sessionIds)
  }

  /** Kinds with a real, live, enabled source behind them: a device or the screen, not a placeholder. */
  private liveOutboundKinds(): FlowKind[] {
    const kinds: FlowKind[] = []
    for (const [kind, track] of this.currentTracks) {
      if (kind !== 'audio' && kind !== 'video') continue
      if (this.placeholders.get(kind) === track) continue
      if (track.readyState === 'live' && track.enabled) kinds.push(kind)
    }
    return kinds
  }

  private emitLocalTracksChanged(): void {
    const sessionId = this.lastPubSessionId
    if (!sessionId) return
    // After a rebuild, kinds re-confirm one at a time under the new session.
    // Announce only those already confirmed there; the rest follow shortly.
    const tracks = [...this.published.values()]
      .filter((p) => p.sessionId === sessionId)
      .map((p) => ({ trackName: p.trackName }))
      .sort((a, b) => a.trackName.localeCompare(b.trackName))
    if (tracks.length === 0) return
    const announcement: SfuTracksData = { sessionId, tracks }
    // Confirmations repeat on every track swap with the same names.
    const json = JSON.stringify(announcement)
    if (json === this.lastAnnouncedJson) return
    this.lastAnnouncedJson = json
    this.opts.onLocalTracksChanged?.(announcement)
  }

  private clearAckTimer(kind: string): void {
    const timer = this.ackTimers.get(kind)
    if (timer) clearTimeout(timer)
    this.ackTimers.delete(kind)
  }

  // ── Subscribe ────────────────────────────────────────────────────────────

  private remoteFor(remoteSessionId: string): RemoteConnection {
    const existing = this.remotes.get(remoteSessionId)
    if (existing) return existing
    const remote: RemoteConnection = {
      tracks: new PartyTracks({
        prefix: SFU_PREFIX,
        apiExtraParams: `${this.params}&kind=subscribe`,
        iceServers: this.iceServers,
      }),
      generation: ++this.remoteGeneration,
      subscriptions: [],
    }
    const connKey = `sub:${remoteSessionId}`
    remote.subscriptions.push(
      remote.tracks.session$.subscribe(({ peerConnection, sessionId }) => {
        if (this.remotes.get(remoteSessionId) !== remote) return
        this.peerConnections.set(connKey, peerConnection)
        remote.sessionId = sessionId
      }),
      remote.tracks.peerConnectionState$.subscribe((state) => {
        if (this.remotes.get(remoteSessionId) !== remote) return
        this.onConnectionState(connKey, 'subscribe', state, () => this.rebuildRemote(remoteSessionId))
        this.emitRemoteHealth(remoteSessionId)
      }),
    )
    this.remotes.set(remoteSessionId, remote)
    return remote
  }

  /** One pull, with its dead-pull timer. Re-run as is by a retry and by a rebuild. */
  private startPull(pull: Pull): void {
    if (this.destroyed) return
    const key = `${pull.remoteSessionId}/${pull.trackName}`
    const remote = this.remoteFor(pull.remoteSessionId)
    const generation = remote.generation
    const startedAt = Date.now()
    // A callback from a pull that was retried, rebuilt or stopped since does nothing.
    const stale = () =>
      this.destroyed || this.pulls.get(key) !== pull || this.remotes.get(pull.remoteSessionId)?.generation !== generation
    let delivered = false

    // partytracks gives no signal for "Cloudflare accepted the pull, but no
    // media ever came": the observable just never emits. Only this timer sees it.
    pull.timer = setTimeout(() => {
      if (stale()) return
      pull.timer = undefined
      console.warn(`[sfu] no track ${key} after ${Math.round((Date.now() - startedAt) / 1000)} s`)
      this.pullRepair(pull).schedule()
      this.emitRemoteHealth(pull.remoteSessionId)
    }, this.repairWindow())

    pull.sub = remote.tracks.pull(of({ location: 'remote' as const, sessionId: pull.remoteSessionId, trackName: pull.trackName })).subscribe({
      next: (track) => {
        if (stale()) return
        clearTimeout(pull.timer)
        pull.timer = undefined
        if (!delivered) {
          delivered = true
          this.recordSetup(startedAt)
        }
        pull.arrived = true
        this.settlePullRepair(pull)
        this.settleConnection(`sub:${pull.remoteSessionId}`, 'subscribe', pull.remoteSessionId)
        this.emitRemoteHealth(pull.remoteSessionId)
        pull.onTrack(track)
      },
      error: (err) => {
        if (stale()) return
        clearTimeout(pull.timer)
        pull.timer = undefined
        console.error(`[sfu] pull ${key} failed`, err)
        // An errored pull is finished for good: without a repair this track never comes.
        this.pullRepair(pull).schedule()
        this.emitRemoteHealth(pull.remoteSessionId)
      },
    })
  }

  private stopPull(key: string, pull: Pull): void {
    if (this.pulls.get(key) !== pull) return
    this.pulls.delete(key)
    clearTimeout(pull.timer)
    pull.sub?.unsubscribe()
    this.cancelLoop(this.pullRepairs, key)
    this.emitRemoteHealth(pull.remoteSessionId)
  }

  private pullRepair(pull: Pull): RepairLoop {
    const key = `${pull.remoteSessionId}/${pull.trackName}`
    let loop = this.pullRepairs.get(key)
    if (!loop) {
      loop = new RepairLoop({
        maxRung: 2,
        repair: (rung, attempt) => {
          if (this.destroyed || this.pulls.get(key) !== pull) return
          this.opts.onRepair?.({ stage: 'subscribe', rung, attempt, sessionId: pull.remoteSessionId, trackName: pull.trackName })
          if (rung >= 2) this.rebuildRemote(pull.remoteSessionId)
          else this.repull(pull)
        },
      })
      this.pullRepairs.set(key, loop)
    }
    return loop
  }

  private settlePullRepair(pull: Pull): void {
    const loop = this.pullRepairs.get(`${pull.remoteSessionId}/${pull.trackName}`)
    if (!loop?.repairing) return
    this.opts.onRepaired?.({
      stage: 'subscribe',
      rung: loop.nextRung,
      attempt: loop.attempts,
      sessionId: pull.remoteSessionId,
      trackName: pull.trackName,
    })
    loop.settle()
  }

  /** Rung 1: the same pull again, on the same subscribe connection. */
  private repull(pull: Pull): void {
    clearTimeout(pull.timer)
    pull.sub?.unsubscribe()
    this.startPull(pull)
  }

  /**
   * Rung 2: a new subscribe connection to this one publisher, with a fresh
   * Cloudflare session, then every track we want from them pulled again.
   * Nobody else's connection is touched.
   */
  private rebuildRemote(remoteSessionId: string): void {
    if (this.destroyed) return
    if (this.deferRebuild(`sub:${remoteSessionId}`, () => this.rebuildRemote(remoteSessionId))) return
    console.info(`[sfu] rebuilding the connection to ${remoteSessionId.slice(0, 8)}`)
    const mine = [...this.pulls.values()].filter((p) => p.remoteSessionId === remoteSessionId)
    // Stopped first: their subscriptions hold the old connection open.
    for (const pull of mine) {
      clearTimeout(pull.timer)
      pull.sub?.unsubscribe()
    }
    const old = this.remotes.get(remoteSessionId)
    if (old) this.disposeRemote(remoteSessionId, old)
    for (const pull of mine) this.startPull(pull)
  }

  /**
   * Unsubscribing everything closes the connection (partytracks shares it
   * with refCount), and Cloudflare ends a session when its connection closes.
   */
  private disposeRemote(remoteSessionId: string, remote: RemoteConnection): void {
    if (this.remotes.get(remoteSessionId) === remote) {
      this.remotes.delete(remoteSessionId)
      this.peerConnections.delete(`sub:${remoteSessionId}`)
    }
    for (const sub of remote.subscriptions) sub.unsubscribe()
    if (remote.sessionId) this.releaseSession(remote.sessionId)
  }

  /** Shows the tile badge while anything for this publisher is being repaired. Fires only on change. */
  private emitRemoteHealth(remoteSessionId: string): void {
    if (this.destroyed) return
    const connKey = `sub:${remoteSessionId}`
    let reconnecting = !!this.connRepairs.get(connKey)?.repairing || !!this.flowRepairs.get(connKey)?.repairing
    for (const [key, loop] of this.pullRepairs) {
      if (key.startsWith(`${remoteSessionId}/`) && loop.repairing) reconnecting = true
    }
    if ((this.remoteHealth.get(remoteSessionId) ?? false) === reconnecting) return
    this.remoteHealth.set(remoteSessionId, reconnecting)
    this.opts.onRemoteHealth?.(remoteSessionId, reconnecting)
  }

  // ── Repair, both directions ──────────────────────────────────────────────

  /** `failed` goes straight to a rebuild: retrying a track over a dead connection can't work. */
  private onConnectionState(key: string, stage: FlowDirection, state: RTCPeerConnectionState, rebuild: () => void): void {
    if (this.destroyed) return
    if (state === 'connected') {
      const loop = this.connRepairs.get(key)
      if (loop?.repairing) {
        this.opts.onRepaired?.({ stage, rung: 2, attempt: loop.attempts, sessionId: key === 'pub' ? undefined : key.slice(4) })
        loop.settle()
        this.cancelDeferredRebuild(key)
      }
      return
    }
    if (state !== 'failed') return
    let loop = this.connRepairs.get(key)
    if (!loop) {
      loop = new RepairLoop({
        maxRung: 1,
        attemptsPerRung: 1,
        repair: (_rung, attempt) => {
          if (this.destroyed) return
          this.opts.onRepair?.({ stage, rung: 2, attempt, sessionId: key === 'pub' ? undefined : key.slice(4) })
          rebuild()
        },
      })
      this.connRepairs.set(key, loop)
    }
    loop.schedule()
  }

  private flowRepair(key: string, stage: FlowDirection, rebuild: () => void): RepairLoop {
    let loop = this.flowRepairs.get(key)
    if (!loop) {
      loop = new RepairLoop({
        maxRung: 1,
        attemptsPerRung: 1,
        baseDelayMs: STALL_GRACE_MS,
        maxDelayMs: STALL_GRACE_MS,
        jitter: false,
        repair: (_rung, attempt) => {
          if (this.destroyed) return
          this.opts.onRepair?.({ stage, rung: 2, attempt, sessionId: key === 'pub' ? undefined : key.slice(4) })
          rebuild()
        },
      })
      this.flowRepairs.set(key, loop)
    }
    return loop
  }

  /**
   * Media arrived or was confirmed on this connection, so a rebuild that ran
   * for it worked. A stall still in its grace is left alone: one track
   * arriving doesn't mean the stalled one came back.
   */
  private settleConnection(key: string, stage: FlowDirection, remoteSessionId?: string): void {
    const conn = this.connRepairs.get(key)
    if (conn?.repairing && conn.attempts > 0) {
      this.opts.onRepaired?.({ stage, rung: 2, attempt: conn.attempts, sessionId: remoteSessionId })
      conn.settle()
    }
    const flow = this.flowRepairs.get(key)
    if (flow?.repairing && flow.attempts > 0) {
      this.opts.onRepaired?.({ stage, rung: 2, attempt: flow.attempts, sessionId: remoteSessionId })
      flow.settle()
    }
  }

  /**
   * At most one rebuild per connection per REBUILD_EVERY_MS. One asked for
   * sooner runs when the time is up, and several such requests become one.
   * Returns true if this one was put off.
   */
  private deferRebuild(key: string, rebuild: () => void): boolean {
    const remaining = (this.lastRebuildAt.get(key) ?? -Infinity) + REBUILD_EVERY_MS - Date.now()
    if (remaining <= 0) {
      this.cancelDeferredRebuild(key)
      this.lastRebuildAt.set(key, Date.now())
      return false
    }
    if (!this.deferredRebuilds.has(key)) {
      this.deferredRebuilds.set(
        key,
        setTimeout(() => {
          this.deferredRebuilds.delete(key)
          if (!this.destroyed) rebuild()
        }, remaining),
      )
    }
    return true
  }

  private cancelDeferredRebuild(key: string): void {
    const timer = this.deferredRebuilds.get(key)
    if (timer !== undefined) clearTimeout(timer)
    this.deferredRebuilds.delete(key)
  }

  private cancelLoop(loops: Map<string, RepairLoop>, key: string): void {
    loops.get(key)?.cancel()
    loops.delete(key)
  }

  /**
   * How long a push or pull may take before it's repaired: twice the slowest
   * 5% of recent setups, within 15–60 s. On a slow network the timers stretch
   * instead of repairing setups that were about to finish.
   */
  private repairWindow(): number {
    const sorted = [...this.setupDurations].sort((a, b) => a - b)
    const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
    return Math.min(MAX_REPAIR_WINDOW_MS, Math.max(MIN_REPAIR_WINDOW_MS, p95 * 2))
  }

  private recordSetup(startedAt: number): void {
    this.setupDurations.push(Date.now() - startedAt)
    if (this.setupDurations.length > SETUP_SAMPLES) this.setupDurations.shift()
  }

  /** Tells our server to forget one of our sessions, so its id can't be used again. */
  private releaseSession(sessionId: string): void {
    void fetch(`${SFU_PREFIX}/sessions/${encodeURIComponent(sessionId)}?${this.params}`, {
      method: 'DELETE',
      // Still sent if the page is closing.
      keepalive: true,
    }).catch(() => {})
  }
}
