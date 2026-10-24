// Wire types shared by the client and the signaling server.
//
// Types only: this package must never export runtime values, so both sides
// can import it with `import type` and nothing from here ends up in a build.
// Each phase adds its messages here; see docs/ for the design behind them.

// ─── WebSocket messages ────────────────────────────────────────────────────

export type MsgType =
  | 'welcome'
  | 'join'
  | 'joined'
  | 'leave'
  | 'peer-joined'
  | 'peer-left'
  | 'error'
  | 'ping'
  | 'pong'

/**
 * Every WebSocket message, in both directions, is one JSON envelope.
 * `room` is set on room-scoped messages, `from` names the peer a message
 * is about (or the receiver's own id, in `welcome`), and `data` carries the
 * type-specific payload.
 */
export interface Envelope<T = unknown> {
  type: MsgType
  room?: string
  from?: string
  to?: string
  data?: T
}

/** A participant as other participants see them. */
export interface PeerInfo {
  id: string
  name: string
  audio: boolean
  video: boolean
}

/** client → server, `room` set on the envelope. */
export interface JoinData {
  name: string
  audio: boolean
  video: boolean
}

/** server → joining client: everyone already in the room (never yourself). */
export interface JoinedData {
  peers: PeerInfo[]
}

/** server → everyone else in the room when a peer joins. */
export interface PeerJoinedData {
  peerId: string
  name: string
  audio: boolean
  video: boolean
}

/** server → everyone else in the room when a peer leaves or disconnects. */
export interface PeerLeftData {
  peerId: string
}

/** Codes the client acts on. Errors without a code are informational. */
export type SignalingErrorCode = 'ROOM_UNAVAILABLE' | 'ROOM_EXPIRED'

export interface ErrorData {
  message: string
  code?: SignalingErrorCode
}

// ─── HTTP API ──────────────────────────────────────────────────────────────

/** Response of `POST /meets/new`. */
export interface CreateMeetResponse {
  meetCode: string
}

export type RoomStatus = 'open' | 'too_early' | 'ended' | 'cancelled' | 'not_found'

/** Response of `GET /room/status?code=…`. */
export interface RoomStatusResult {
  status: RoomStatus
  message?: string
  /** ISO time; set when status is `too_early`. */
  opensAt?: string
  /** ISO time; set when status is `open` and the room has a fixed end. */
  closesAt?: string
}

/** Body of every JSON error response from the HTTP API. */
export interface ApiError {
  error: string
  code?: string
}
