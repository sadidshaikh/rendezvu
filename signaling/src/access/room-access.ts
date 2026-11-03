import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendError } from '../http/respond.ts'
import { log } from '../log.ts'
import type { InstantRoomRegistry } from '../meets/instant-rooms.ts'
import { roomAccessError } from '../meets/room-access.ts'
import { signRoomToken, verifyRoomToken, type RoomRole, type RoomTokenClaims } from './room-token.ts'

// An admitted guest's token. Long enough for any call, short enough that a leaked one goes stale.
const GUEST_TOKEN_TTL_MS = 2 * 60 * 60_000

export type JoinDecision =
  | { kind: 'member'; role: RoomRole }
  | { kind: 'knock' }
  | { kind: 'refused'; code: 'ROOM_UNAVAILABLE' | 'ROOM_EXPIRED'; message: string }

export type RequestDecision =
  | { ok: true; role: RoomRole }
  | { ok: false; status: number; code: string; message: string }

/**
 * The one place that decides who may be in a room. Today it reads our own
 * signed tokens and the instant-room registry. In Part 2 the inside becomes a
 * call to Spring Boot; the WebSocket handler and the routes don't change.
 */
export class RoomAccess {
  private readonly registry: InstantRoomRegistry
  private readonly secret: string
  private readonly hostTokenTtlMs: number

  constructor(registry: InstantRoomRegistry, secret: string, hostTokenTtlMs: number) {
    this.registry = registry
    this.secret = secret
    this.hostTokenTtlMs = hostTokenTtlMs
  }

  /** For whoever created the meeting. Not tied to a tab: it works in every tab of that browser. */
  issueHostToken(roomId: string): string {
    return signRoomToken(this.secret, { room: roomId, role: 'host' }, this.hostTokenTtlMs)
  }

  /** For an admitted guest, bound to the tab it was admitted in. */
  issueGuestToken(roomId: string, presenceId: string): string {
    return signRoomToken(this.secret, { room: roomId, role: 'guest', sub: presenceId }, GUEST_TOKEN_TTL_MS)
  }

  /**
   * A WebSocket join: a member, a knock, or refused. Only looks at the
   * room's state; the caller activates the room for a member's join, so a
   * knock never starts the room's clock.
   */
  authorizeJoin(roomId: string, token: unknown, presenceId: string): JoinDecision {
    const state = this.registry.peek(roomId)
    if (state === 'expired') return { kind: 'refused', code: 'ROOM_EXPIRED', message: 'This meeting is no longer active.' }
    if (state !== 'ok') return { kind: 'refused', code: 'ROOM_UNAVAILABLE', message: 'This meeting is not available right now.' }
    const claims = verifyRoomToken(this.secret, token)
    // A token that doesn't fit is treated like none: the browser asks to join.
    if (!claims || this.mismatch(claims, roomId, presenceId)) return { kind: 'knock' }
    return { kind: 'member', role: claims.role }
  }

  /**
   * An HTTP call for a room (/ice-servers, /sfu/sessions/new): the bearer
   * token must be good for this room (and tab), and the room active.
   */
  authorizeRequest(req: IncomingMessage, roomId: string, presenceId?: string): RequestDecision {
    const claims = this.readBearer(req)
    if (!claims) return unauthorized()
    const mismatch = this.mismatch(claims, roomId, presenceId)
    if (mismatch) return mismatch
    const state = this.registry.allowActive(roomId)
    if (state !== 'ok') return { ok: false, ...roomAccessError(state) }
    return { ok: true, role: claims.role }
  }

  /** The verified claims of the request's bearer token, or null. For routes that learn the room later. */
  readBearer(req: IncomingMessage): RoomTokenClaims | null {
    const header = req.headers.authorization
    const match = typeof header === 'string' ? /^Bearer (\S+)$/.exec(header) : null
    return match ? verifyRoomToken(this.secret, match[1]) : null
  }

  /** Null if the claims fit this room and tab; otherwise the 403 to send. */
  mismatch(claims: RoomTokenClaims, roomId: string, presenceId?: string): (RequestDecision & { ok: false }) | null {
    if (claims.room !== roomId) {
      return { ok: false, status: 403, code: 'FORBIDDEN_ROOM', message: 'This token is for another meeting.' }
    }
    // A guest token works only in the tab it was issued to.
    if (claims.role === 'guest' && claims.sub !== presenceId) {
      return { ok: false, status: 403, code: 'FORBIDDEN_ROOM', message: 'This token belongs to another tab.' }
    }
    return null
  }
}

/** Answers a refused HTTP call, and logs 401s and 403s (never the token). */
export function sendRefusal(res: ServerResponse, route: string, refusal: RequestDecision & { ok: false }): void {
  if (refusal.status === 401 || refusal.code === 'FORBIDDEN_ROOM') {
    log('http_unauthorized', { route, status: refusal.status, code: refusal.code })
  }
  sendError(res, refusal.status, refusal.code, refusal.message)
}

export function unauthorized(): RequestDecision & { ok: false } {
  return { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'A token for this meeting is required.' }
}
