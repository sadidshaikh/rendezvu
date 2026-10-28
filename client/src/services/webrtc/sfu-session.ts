import { BehaviorSubject, of, type Subscription } from 'rxjs'
import { PartyTracks } from 'partytracks/client'
import type { SfuTracksData } from '@rendezvu/protocol'
import { httpServerUri } from '@/lib/config'

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
  private readonly subTracks = new Map<string, PartyTracks>()
  // 'pub' or `sub:<remote session id>` → the live connection.
  private readonly peerConnections = new Map<string, RTCPeerConnection>()
  // Our own Cloudflare session ids, released with DELETE on destroy.
  private readonly ownSessionIds = new Set<string>()
  private readonly subscriptions: Subscription[] = []

  // kind → subject feeding that kind's push. A new value swaps the track on
  // the existing sender, with no renegotiation.
  private readonly localSubjects = new Map<string, BehaviorSubject<MediaStreamTrack>>()
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
   * Pulls one remote track. `onTrack` fires with the received track, and
   * again if partytracks has to rebuild the connection. Returns the unsubscribe.
   */
  subscribeTrack(remoteSessionId: string, trackName: string, onTrack: (track: MediaStreamTrack) => void): () => void {
    if (this.destroyed) return () => {}
    const sub = this.subscribeSession(remoteSessionId)
      .pull(of({ location: 'remote' as const, sessionId: remoteSessionId, trackName }))
      .subscribe({
        next: onTrack,
        error: (err) => console.error(`[sfu] pull ${remoteSessionId}/${trackName} failed`, err),
      })
    this.subscriptions.push(sub)
    return () => sub.unsubscribe()
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
    for (const sub of this.subscriptions) sub.unsubscribe()
    // Unsubscribing everything closes the peer connections (partytracks
    // shares them with refCount). Cloudflare ends a session when its
    // connection closes; the DELETE tells our server to forget it.
    for (const sessionId of this.ownSessionIds) {
      void fetch(`${SFU_PREFIX}/sessions/${encodeURIComponent(sessionId)}?${this.params}`, {
        method: 'DELETE',
        // Still sent if the page is closing.
        keepalive: true,
      }).catch(() => {})
    }
    this.peerConnections.clear()
  }

  private publishTrack(track: MediaStreamTrack): void {
    if (this.destroyed) return
    const subject = this.localSubjects.get(track.kind)
    if (subject) {
      if (subject.value !== track) subject.next(track)
      return
    }
    this.startPush(track)
  }

  private startPush(track: MediaStreamTrack): void {
    const kind = track.kind
    if (!this.pubWired) {
      // Subscribing here, not in the constructor, keeps the Cloudflare session
      // from existing before there is something to send.
      this.pubWired = true
      this.subscriptions.push(
        this.pubTracks.session$.subscribe(({ peerConnection, sessionId }) => {
          this.peerConnections.set('pub', peerConnection)
          this.ownSessionIds.add(sessionId)
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
      },
    })
    this.pushSubs.set(kind, sub)
  }

  private subscribeSession(remoteSessionId: string): PartyTracks {
    let tracks = this.subTracks.get(remoteSessionId)
    if (!tracks) {
      tracks = new PartyTracks({
        prefix: SFU_PREFIX,
        apiExtraParams: `${this.params}&kind=subscribe`,
        iceServers: this.iceServers,
      })
      this.subTracks.set(remoteSessionId, tracks)
      this.subscriptions.push(
        tracks.session$.subscribe(({ peerConnection, sessionId }) => {
          this.peerConnections.set(`sub:${remoteSessionId}`, peerConnection)
          this.ownSessionIds.add(sessionId)
        }),
      )
    }
    return tracks
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
