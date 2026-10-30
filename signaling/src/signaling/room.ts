import type { Envelope, PeerInfo, SfuTracksData } from '@rendezvu/protocol'
import type { Peer } from './peer.ts'

/** The people currently connected to one meeting code. Created and deleted only by the Hub. */
export class Room {
  readonly id: string
  private readonly members = new Map<string, Peer>()
  // Each publisher's current track set, replayed to everyone who joins later.
  private readonly tracks = new Map<string, SfuTracksData>()

  constructor(id: string) {
    this.id = id
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

  /** Replaces the stored set: each announcement is the publisher's full current set, never a delta. */
  setTracks(peerId: string, data: SfuTracksData): void {
    this.tracks.set(peerId, data)
  }

  /**
   * Forgets the set only if it still belongs to `sessionId`. A late withdrawal
   * of an old session must not erase the set that replaced it. Returns whether
   * anything changed.
   */
  withdrawTracks(peerId: string, sessionId: string): boolean {
    if (this.tracks.get(peerId)?.sessionId !== sessionId) return false
    this.tracks.delete(peerId)
    return true
  }

  removeTracks(peerId: string): void {
    this.tracks.delete(peerId)
  }

  /** Every stored set with its owner, for the replay to a newcomer. */
  trackSets(): Array<[peerId: string, data: SfuTracksData]> {
    return [...this.tracks]
  }

  /** How many people a broadcast from this peer reaches. */
  othersThan(peerId: string): number {
    return this.members.size - (this.members.has(peerId) ? 1 : 0)
  }

  isEmpty(): boolean {
    return this.members.size === 0
  }

  peerInfos(): PeerInfo[] {
    return [...this.members.values()].map((p) => p.info())
  }

  broadcastExcept(exceptId: string, env: Envelope): void {
    const payload = JSON.stringify(env)
    for (const peer of this.members.values()) {
      if (peer.id !== exceptId) peer.sendRaw(payload)
    }
  }
}
