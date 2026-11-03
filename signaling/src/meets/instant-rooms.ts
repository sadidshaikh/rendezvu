/** Outcome of an access check. Anything but 'ok' refuses the caller. */
export type RoomAccess = 'ok' | 'unknown' | 'not-started' | 'expired'

interface InstantRoom {
  createdAt: number
  activatedAt: number | null
  emptySince: number | null
  expiresAt: number
  closed: boolean
}

const DEFAULT_TTL_MS = 12 * 60 * 60_000

/** One room as saved to disk across a restart. */
export interface SavedRoom {
  code: string
  createdAt: number
  activatedAt: number | null
  expiresAt: number
}

/**
 * Which instant-meeting codes may be used, and for how long.
 *
 * Separate from the Hub on purpose: the Hub knows who is connected right now,
 * this knows whether a code is valid at all. A room can be here with nobody
 * connected (created, not joined yet), and the Hub never holds a room this
 * registry would refuse.
 *
 *   created ──first join──► active ──last leaves──► empty ──join──► active
 *      └──── ttl after creation, or emptyGrace while empty ────► closed (for good)
 */
export class InstantRoomRegistry {
  private readonly rooms = new Map<string, InstantRoom>()
  private readonly ttlMs: number
  private readonly emptyGraceMs: number

  constructor(ttlMs: number, emptyGraceMs: number) {
    this.ttlMs = ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS
    this.emptyGraceMs = emptyGraceMs
  }

  create(code: string, now = Date.now()): void {
    this.rooms.set(code, {
      createdAt: now,
      activatedAt: null,
      emptySince: null,
      expiresAt: now + this.ttlMs,
      closed: false,
    })
  }

  /** For joins. Joining is what starts a room, so this activates it. */
  activateOrAllow(code: string, now = Date.now()): RoomAccess {
    const room = this.rooms.get(code)
    if (!room) return 'unknown'
    if (room.closed) return 'expired'
    if (this.expired(room, now)) {
      room.closed = true
      return 'expired'
    }
    room.activatedAt ??= now
    room.emptySince = null
    return 'ok'
  }

  /**
   * For a knock: may this code be joined at all (created or active, not
   * expired)? Read-only, so a guest waiting alone doesn't start the room.
   */
  peek(code: string, now = Date.now()): RoomAccess {
    const room = this.rooms.get(code)
    if (!room) return 'unknown'
    if (room.closed) return 'expired'
    if (this.expired(room, now)) {
      room.closed = true
      return 'expired'
    }
    return 'ok'
  }

  /** For read-only checks (status, TURN, SFU). Never starts a room. */
  allowActive(code: string, now = Date.now()): RoomAccess {
    const room = this.rooms.get(code)
    if (!room) return 'unknown'
    if (room.closed) return 'expired'
    if (room.activatedAt === null) return 'not-started'
    if (this.expired(room, now)) {
      room.closed = true
      return 'expired'
    }
    return 'ok'
  }

  /** The last person left. Starts the empty-grace countdown. */
  markEmpty(code: string, now = Date.now()): void {
    const room = this.rooms.get(code)
    if (!room || room.closed || room.activatedAt === null || room.emptySince !== null) return
    room.emptySince = now
  }

  markActive(code: string): void {
    const room = this.rooms.get(code)
    if (room) room.emptySince = null
  }

  /** What survives a restart: every room still usable, without the empty-room clocks. */
  snapshot(now = Date.now()): SavedRoom[] {
    const saved: SavedRoom[] = []
    for (const [code, room] of this.rooms) {
      if (room.closed || this.expired(room, now)) continue
      saved.push({ code, createdAt: room.createdAt, activatedAt: room.activatedAt, expiresAt: room.expiresAt })
    }
    return saved
  }

  /**
   * Rooms saved before a restart. A room that had started counts as empty
   * from now: if nobody comes back, the normal empty-grace closes it.
   */
  restore(saved: SavedRoom[], now = Date.now()): number {
    let restored = 0
    for (const r of saved) {
      if (this.rooms.has(r.code) || r.expiresAt <= now) continue
      this.rooms.set(r.code, {
        createdAt: r.createdAt,
        activatedAt: r.activatedAt,
        emptySince: r.activatedAt === null ? null : now,
        expiresAt: r.expiresAt,
        closed: false,
      })
      restored++
    }
    return restored
  }

  /** Drops entries that can never be used again, so memory doesn't grow forever. */
  prune(now = Date.now()): number {
    let removed = 0
    for (const [code, room] of this.rooms) {
      if (room.closed || this.expired(room, now)) {
        this.rooms.delete(code)
        removed++
      }
    }
    return removed
  }

  private expired(room: InstantRoom, now: number): boolean {
    if (now > room.expiresAt) return true
    return room.emptySince !== null && now > room.emptySince + this.emptyGraceMs
  }
}
