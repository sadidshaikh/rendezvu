export type SfuSessionKind = 'publish' | 'subscribe'

export interface SfuSessionEntry {
  roomId: string
  peerId: string
  kind: SfuSessionKind
  createdAt: number
}

/**
 * Which peer, in which room, created each Cloudflare session. Every /sfu
 * request after the first is checked against this, so a session can only be
 * used by the peer that created it, and only while that peer is in the room.
 */
export class SfuSessionRegistry {
  private readonly sessions = new Map<string, SfuSessionEntry>()
  private readonly byPeer = new Map<string, Set<string>>()

  register(sessionId: string, roomId: string, peerId: string, kind: SfuSessionKind, now = Date.now()): void {
    this.sessions.set(sessionId, { roomId, peerId, kind, createdAt: now })
    let ids = this.byPeer.get(peerId)
    if (!ids) {
      ids = new Set()
      this.byPeer.set(peerId, ids)
    }
    ids.add(sessionId)
  }

  lookup(sessionId: string): SfuSessionEntry | undefined {
    return this.sessions.get(sessionId)
  }

  remove(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    this.sessions.delete(sessionId)
    const ids = this.byPeer.get(entry.peerId)
    ids?.delete(sessionId)
    if (ids?.size === 0) this.byPeer.delete(entry.peerId)
  }

  /**
   * The peer left or disconnected. Its sessions die with it: Cloudflare ends
   * them when the browser's connection closes, and nobody else may use them.
   * Returns how many were dropped.
   */
  removePeer(peerId: string): number {
    const ids = this.byPeer.get(peerId)
    if (!ids) return 0
    for (const id of ids) this.sessions.delete(id)
    this.byPeer.delete(peerId)
    return ids.size
  }

  /** For `sfu-announce`: a peer may only announce its own publish session. */
  isPublishSessionOf(sessionId: string, peerId: string): boolean {
    const entry = this.sessions.get(sessionId)
    return entry?.peerId === peerId && entry.kind === 'publish'
  }
}
