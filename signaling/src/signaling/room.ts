import type { Envelope, PeerInfo, RoomSnapshotData, SfuTracksData } from '@rendezvu/protocol'
import type { Peer } from './peer.ts'

/** The people currently connected to one meeting code. Created and deleted only by the Hub. */
export class Room {
  readonly id: string
  private readonly members = new Map<string, Peer>()
  /**
   * Guests asking to join (Phase 11). Kept apart from members: they're in no
   * roster, snapshot or broadcast, and don't keep the room "in use". Room
   * state rather than a one-time broadcast, so a member who joins later is
   * still told who is waiting.
   */
  private readonly waitingList = new Map<string, Peer>()
  // Each publisher's current track set, replayed to everyone who joins later.
  private readonly tracks = new Map<string, SfuTracksData>()
  /**
   * Goes up by one on every change to the stored track sets. Clients ignore
   * anything older than what they've already applied, so a snapshot that was
   * overtaken in flight by a newer sfu-tracks can't undo it.
   */
  private _version = 0

  constructor(id: string) {
    this.id = id
  }

  get version(): number {
    return this._version
  }

  add(peer: Peer): void {
    this.members.set(peer.id, peer)
  }

  remove(peerId: string): void {
    this.members.delete(peerId)
  }

  has(peerId: string): boolean {
    return this.members.has(peerId)
  }

  /** The member connected from this browser tab, if any. */
  findByPresence(presenceId: string): Peer | undefined {
    for (const peer of this.members.values()) if (peer.presenceId === presenceId) return peer
    return undefined
  }

  /**
   * Replaces the stored set: each announcement is the publisher's full current
   * set, never a delta. Returns the version this write landed at.
   */
  setTracks(peerId: string, data: SfuTracksData): number {
    this.tracks.set(peerId, data)
    return ++this._version
  }

  /**
   * Forgets the set only if it still belongs to `sessionId`. A late withdrawal
   * of an old session must not erase the set that replaced it. Returns the new
   * version, or null if nothing changed.
   */
  withdrawTracks(peerId: string, sessionId: string): number | null {
    if (this.tracks.get(peerId)?.sessionId !== sessionId) return null
    this.tracks.delete(peerId)
    return ++this._version
  }

  removeTracks(peerId: string): void {
    if (this.tracks.delete(peerId)) this._version++
  }

  /** Every stored set with its owner, for the replay to a newcomer. Stored sets carry no version. */
  trackSets(): Array<[peerId: string, data: SfuTracksData]> {
    return [...this.tracks]
  }

  /** Whether anyone here is publishing. Rooms where nobody is get no periodic snapshots. */
  hasPublishers(): boolean {
    return this.tracks.size > 0
  }

  /**
   * The whole room as it stands: every member, the asker included, and every
   * stored set whose owner is still here. Sorted so logs and tests compare.
   */
  snapshot(): RoomSnapshotData {
    const tracks = [...this.tracks]
      .filter(([peerId]) => this.members.has(peerId))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([peerId, data]) => ({ peerId, sessionId: data.sessionId, tracks: data.tracks }))
    return { version: this._version, peers: this.peerInfos(), tracks }
  }

  /** How many people a broadcast from this peer reaches. */
  othersThan(peerId: string): number {
    return this.members.size - (this.members.has(peerId) ? 1 : 0)
  }

  addWaiting(peer: Peer): void {
    this.waitingList.set(peer.id, peer)
  }

  removeWaiting(peerId: string): boolean {
    return this.waitingList.delete(peerId)
  }

  getWaiting(peerId: string): Peer | undefined {
    return this.waitingList.get(peerId)
  }

  findWaitingByPresence(presenceId: string): Peer | undefined {
    for (const peer of this.waitingList.values()) if (peer.presenceId === presenceId) return peer
    return undefined
  }

  waiting(): Peer[] {
    return [...this.waitingList.values()]
  }

  /** No members and nobody waiting: the Hub can forget the room. */
  isUnused(): boolean {
    return this.members.size === 0 && this.waitingList.size === 0
  }

  /** No members. Waiting guests don't count. */
  isEmpty(): boolean {
    return this.members.size === 0
  }

  peerInfos(): PeerInfo[] {
    return [...this.members.values()].map((p) => p.info())
  }

  /**
   * Critical. Every receiver waits in parallel, so one slow phone holds the
   * broadcast up by at most 2 s, not 2 s per slow person.
   */
  async broadcastExcept(exceptId: string, env: Envelope): Promise<void> {
    const payload = JSON.stringify(env)
    await Promise.all(this.othersThanList(exceptId).map((peer) => peer.sendRaw(payload, env.type)))
  }

  /** Best effort, for messages the next one replaces (peer-state). */
  broadcastExceptBestEffort(exceptId: string, env: Envelope): void {
    const payload = JSON.stringify(env)
    for (const peer of this.othersThanList(exceptId)) peer.sendBestEffortRaw(payload)
  }

  /** Critical, to every member (knock prompts). Waiting guests never get member messages. */
  async broadcast(env: Envelope): Promise<void> {
    const payload = JSON.stringify(env)
    await Promise.all([...this.members.values()].map((peer) => peer.sendRaw(payload, env.type)))
  }

  /** Best effort to everyone, sender included (periodic snapshots). */
  broadcastBestEffort(env: Envelope): void {
    const payload = JSON.stringify(env)
    for (const peer of this.members.values()) peer.sendBestEffortRaw(payload)
  }

  private othersThanList(exceptId: string): Peer[] {
    return [...this.members.values()].filter((p) => p.id !== exceptId)
  }
}
