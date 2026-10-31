import { BehaviorSubject, of, type Subscription } from 'rxjs'
import { PartyTracks } from 'partytracks/client'
import type { SfuTracksData } from '@rendezvu/protocol'
import { httpServerUri } from '@/lib/config'
import { createBlackVideoTrack, createSilentAudioTrack } from '@/lib/placeholder-tracks'

export interface SfuSessionOptions {
  roomId: string
  peerId: string
  iceServers: RTCIceServer[]
  /**
   * The full set of tracks Cloudflare has confirmed for our publish session.
   * Fires on the first confirmation and on every real change, never for a
   * push that was only accepted. The caller sends it as `sfu-announce`.
   */
  onLocalTracksChanged?: (announcement: SfuTracksData) => void
  /** A push got no confirmation within PUSH_ACK_TIMEOUT_MS. Repair arrives in Phase 9. */
  onPublishTimeout?: (kind: string) => void
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void
}

/** Our subscribe session for one remote publisher, and every pull running on it. */
interface RemoteSubscription {
  tracks: PartyTracks
  subscriptions: Subscription[]
  /** Our own Cloudflare session id for this connection, once created. */
  sessionId?: string
}

const SFU_PREFIX = `${httpServerUri}/sfu`
// A push normally confirms in 1–3 s. partytracks retries internally forever,
// so a push that can't reach Cloudflare looks just like a slow one; only the
// missing confirmation tells them apart.
const PUSH_ACK_TIMEOUT_MS = 15_000

/**
 * Everything between this browser and Cloudflare's SFU. The only code that
 * touches RTCPeerConnection for calls.
 *
 * One publish session (send only) carries all our tracks. Each remote
 * publisher we pull from gets its own subscribe session, so renegotiating one
 * person's tracks can never disturb another's.
 */
export class SfuSession {
  private readonly opts: SfuSessionOptions
  private readonly params: string
  // partytracks keeps a reference to this array and reads it whenever it
  // builds a new connection, so refreshed credentials are swapped in place.
  private readonly iceServers: RTCIceServer[]
  private readonly pubTracks: PartyTracks
  // Remote publisher's session id → our subscribe connection to it.
  private readonly remotes = new Map<string, RemoteSubscription>()
  // 'pub' or `sub:<remote session id>` → the live connection.
  private readonly peerConnections = new Map<string, RTCPeerConnection>()
  // Our publish session ids, released with DELETE on destroy.
  private readonly pubSessionIds = new Set<string>()
  private readonly pubSubscriptions: Subscription[] = []

  // kind → subject feeding that kind's push. A new value swaps the track on
  // the existing sender, with no renegotiation.
  private readonly localSubjects = new Map<string, BehaviorSubject<MediaStreamTrack>>()
  // kind → the stand-in being sent while that device is off. Lives exactly as
  // long as it is the track being sent.
  private readonly placeholders = new Map<string, MediaStreamTrack>()
  private readonly pushSubs = new Map<string, Subscription>()
  private readonly ackTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // kind → what Cloudflare confirmed for it.
  private readonly published = new Map<string, { sessionId: string; trackName: string }>()
  private lastPubSessionId: string | null = null
  private lastAnnouncedJson = ''
  private pubWired = false
  private destroyed = false

  constructor(opts: SfuSessionOptions) {
    this.opts = opts
    this.iceServers = [...opts.iceServers]
    this.params = `roomId=${encodeURIComponent(opts.roomId)}&peerId=${encodeURIComponent(opts.peerId)}`
    // Constructing PartyTracks makes no request. The Cloudflare session is
    // created on the first push: an idle session with no connection is closed
    // by Cloudflare after ~30 s, which would break joining with media off.
    this.pubTracks = new PartyTracks({
      prefix: SFU_PREFIX,
      apiExtraParams: `${this.params}&kind=publish`,
      iceServers: this.iceServers,
    })
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
    if (this.destroyed) return
    const subject = this.localSubjects.get(kind)
    if (!subject || this.placeholders.has(kind)) return
    const track = kind === 'audio' ? createSilentAudioTrack() : createBlackVideoTrack()
    if (!track) return
    this.placeholders.set(kind, track)
    subject.next(track)
  }

  /**
   * Pulls one remote track. `onTrack` fires with the received track, and
   * again if partytracks has to rebuild the connection. Returns the unsubscribe.
   */
  subscribeTrack(remoteSessionId: string, trackName: string, onTrack: (track: MediaStreamTrack) => void): () => void {
    if (this.destroyed) return () => {}
    const remote = this.remoteFor(remoteSessionId)
    const sub = remote.tracks
      .pull(of({ location: 'remote' as const, sessionId: remoteSessionId, trackName }))
      .subscribe({
        next: onTrack,
        error: (err) => console.error(`[sfu] pull ${remoteSessionId}/${trackName} failed`, err),
      })
    remote.subscriptions.push(sub)
    return () => sub.unsubscribe()
  }

  /**
   * Stops every pull from one remote publisher, closes our connection to it
   * and releases that subscribe session. For a person who left, or whose
   * publish session was replaced by a new one.
   */
  unsubscribeSession(remoteSessionId: string): void {
    const remote = this.remotes.get(remoteSessionId)
    if (!remote) return
    this.remotes.delete(remoteSessionId)
    this.peerConnections.delete(`sub:${remoteSessionId}`)
    this.closeRemote(remote)
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

  /** Stops every push and pull, closes the connections, and releases our sessions on the server. */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const timer of this.ackTimers.values()) clearTimeout(timer)
    this.ackTimers.clear()
    for (const sub of this.pushSubs.values()) sub.unsubscribe()
    for (const track of this.placeholders.values()) track.stop()
    this.placeholders.clear()
    for (const sub of this.pubSubscriptions) sub.unsubscribe()
    for (const sessionId of this.pubSessionIds) this.releaseSession(sessionId)
    for (const remote of this.remotes.values()) this.closeRemote(remote)
    this.remotes.clear()
    this.peerConnections.clear()
  }

  /**
   * Unsubscribing everything closes the connection (partytracks shares it
   * with refCount), and Cloudflare ends a session when its connection closes.
   */
  private closeRemote(remote: RemoteSubscription): void {
    for (const sub of remote.subscriptions) sub.unsubscribe()
    if (remote.sessionId) this.releaseSession(remote.sessionId)
  }

  /** Tells our server to forget one of our sessions, so its id can't be used again. */
  private releaseSession(sessionId: string): void {
    void fetch(`${SFU_PREFIX}/sessions/${encodeURIComponent(sessionId)}?${this.params}`, {
      method: 'DELETE',
      // Still sent if the page is closing.
      keepalive: true,
    }).catch(() => {})
  }

  private publishTrack(track: MediaStreamTrack): void {
    if (this.destroyed) return
    const subject = this.localSubjects.get(track.kind)
    if (subject) {
      if (subject.value !== track) subject.next(track)
    } else {
      this.startPush(track)
    }
    // Replaced by a real device. partytracks finishes the swap on its own; a
    // stopped placeholder in the meantime only means a moment of nothing.
    this.placeholders.get(track.kind)?.stop()
    this.placeholders.delete(track.kind)
  }

  private startPush(track: MediaStreamTrack): void {
    const kind = track.kind
    if (!this.pubWired) {
      // Subscribing here, not in the constructor, keeps the Cloudflare session
      // from existing before there is something to send.
      this.pubWired = true
      this.pubSubscriptions.push(
        this.pubTracks.session$.subscribe(({ peerConnection, sessionId }) => {
          this.peerConnections.set('pub', peerConnection)
          this.pubSessionIds.add(sessionId)
        }),
        this.pubTracks.peerConnectionState$.subscribe((state) => this.opts.onConnectionStateChange?.(state)),
      )
    }

    this.ackTimers.set(
      kind,
      setTimeout(() => {
        this.ackTimers.delete(kind)
        this.opts.onPublishTimeout?.(kind)
      }, PUSH_ACK_TIMEOUT_MS),
    )

    const subject = new BehaviorSubject(track)
    this.localSubjects.set(kind, subject)
    const sub = this.pubTracks.push(subject.asObservable()).subscribe({
      // Cloudflare confirmed the track. Also fires again, with a new session
      // id, if partytracks rebuilt the connection and pushed again.
      next: (meta) => {
        this.clearAckTimer(kind)
        if (!meta.sessionId || !meta.trackName) return
        this.published.set(kind, { sessionId: meta.sessionId, trackName: meta.trackName })
        this.lastPubSessionId = meta.sessionId
        this.emitLocalTracksChanged()
      },
      error: (err) => {
        console.error(`[sfu] push ${kind} failed`, err)
        // A failed push is finished for good. Drop it, so the next publish of
        // this kind starts over instead of feeding a dead subject.
        this.clearAckTimer(kind)
        this.pushSubs.get(kind)?.unsubscribe()
        this.pushSubs.delete(kind)
        this.localSubjects.delete(kind)
        this.published.delete(kind)
        this.placeholders.get(kind)?.stop()
        this.placeholders.delete(kind)
      },
    })
    this.pushSubs.set(kind, sub)
  }

  private remoteFor(remoteSessionId: string): RemoteSubscription {
    let remote = this.remotes.get(remoteSessionId)
    if (!remote) {
      const created: RemoteSubscription = {
        tracks: new PartyTracks({
          prefix: SFU_PREFIX,
          apiExtraParams: `${this.params}&kind=subscribe`,
          iceServers: this.iceServers,
        }),
        subscriptions: [],
      }
      created.subscriptions.push(
        created.tracks.session$.subscribe(({ peerConnection, sessionId }) => {
          this.peerConnections.set(`sub:${remoteSessionId}`, peerConnection)
          created.sessionId = sessionId
        }),
      )
      this.remotes.set(remoteSessionId, created)
      remote = created
    }
    return remote
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
}
