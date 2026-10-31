export type SfuSessionKind = 'publish' | 'subscribe'

export interface SfuSessionEntry {
  roomId: string
  /** The browser tab that created it. Survives signaling reconnects, unlike the peer id. */
  presenceId: string
  kind: SfuSessionKind
  createdAt: number
}

/**
 * Which browser tab, in which room, created each Cloudflare session. Every
 * /sfu request after the first is checked against this, so a session can only
 * be used by the tab that created it.
 *
 * Owned by presence, not by connection: the browser's connections to
 * Cloudflare outlive a signaling blip, so the sessions behind them have to as
 * well, and the reconnected tab must still be allowed to use them.
 */
export class SfuSessionRegistry {
  private readonly sessions = new Map<string, SfuSessionEntry>()
  private readonly byPresence = new Map<string, Set<string>>()
  // Presences whose socket closed without a leave, waiting to see if they come back.
  private readonly pendingDrops = new Map<string, ReturnType<typeof setTimeout>>()

  register(sessionId: string, roomId: string, presenceId: string, kind: SfuSessionKind, now = Date.now()): void {
    this.sessions.set(sessionId, { roomId, presenceId, kind, createdAt: now })
    let ids = this.byPresence.get(presenceId)
    if (!ids) {
      ids = new Set()
      this.byPresence.set(presenceId, ids)
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
    const ids = this.byPresence.get(entry.presenceId)
    ids?.delete(sessionId)
    if (ids?.size === 0) this.byPresence.delete(entry.presenceId)
  }

  /**
   * Drops this tab's sessions, except those in `keepRoomId` if given. Nobody
   * may use them afterwards; Cloudflare ends them itself once the browser's
   * connection closes. Returns how many were dropped.
   */
  removePresence(presenceId: string, keepRoomId?: string): number {
    if (keepRoomId === undefined) this.cancelDrop(presenceId)
    const ids = this.byPresence.get(presenceId)
    if (!ids) return 0
    let dropped = 0
    for (const id of [...ids]) {
      if (keepRoomId !== undefined && this.sessions.get(id)?.roomId === keepRoomId) continue
      this.remove(id)
      dropped++
    }
    return dropped
  }

  /**
   * Drops this tab's sessions after `delayMs`, unless `cancelDrop` runs first
   * (it joined again). A second call restarts the wait, so the grace always
   * counts from the latest disconnect.
   */
  scheduleDrop(presenceId: string, delayMs: number, onDropped: (count: number) => void): void {
    this.cancelDrop(presenceId)
    if (!this.byPresence.has(presenceId)) return
    const timer = setTimeout(() => {
      this.pendingDrops.delete(presenceId)
      onDropped(this.removePresence(presenceId))
    }, delayMs)
    timer.unref()
    this.pendingDrops.set(presenceId, timer)
  }

  cancelDrop(presenceId: string): void {
    const timer = this.pendingDrops.get(presenceId)
    if (timer) clearTimeout(timer)
    this.pendingDrops.delete(presenceId)
  }

  /** For `sfu-announce`: a tab may only announce its own publish session. */
  isPublishSessionOf(sessionId: string, presenceId: string): boolean {
    const entry = this.sessions.get(sessionId)
    return entry?.presenceId === presenceId && entry.kind === 'publish'
  }
}
