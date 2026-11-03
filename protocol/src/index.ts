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
  | 'sfu-announce'
  | 'sfu-tracks'
  | 'peer-state'
  | 'sync'
  | 'room-snapshot'
  | 'stats-report'

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
  /** Missing means false. */
  screenSharing?: boolean
}

/** client → server, `room` set on the envelope. */
export interface JoinData {
  name: string
  audio: boolean
  video: boolean
  /**
   * The same for every connection this browser tab makes, so a reconnect
   * replaces the tab's old entry instead of adding a second person. Never
   * sent on to anyone else: it also proves which Cloudflare sessions are ours.
   */
  presenceId?: string
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
  /** Missing means false. */
  screenSharing?: boolean
}

/**
 * client → server → everyone else in the room, `from` set to the sender.
 * Always the full current state, never a change. The server stores audio,
 * video and screenSharing so `joined` and `peer-joined` carry them.
 */
export interface PeerStateData {
  audio: boolean
  video: boolean
  speaking?: boolean
  screenSharing: boolean
}

/** server → everyone else in the room when a peer leaves or disconnects. */
export interface PeerLeftData {
  peerId: string
}

/** Codes the client acts on. Errors without a code are informational. */
export type SignalingErrorCode = 'ROOM_UNAVAILABLE' | 'ROOM_EXPIRED' | 'NOT_IN_ROOM'

export interface ErrorData {
  message: string
  code?: SignalingErrorCode
}

/** One published track, addressed by its Cloudflare session plus this name. */
export interface SfuTrackInfo {
  trackName: string
  mid?: string
}

/**
 * client → server `sfu-announce`: the FULL set of tracks this peer publishes
 * right now, sent only after Cloudflare has confirmed them. The server
 * replaces, never merges; an empty `tracks` withdraws the session.
 * Also server → client `sfu-tracks`, with `from` naming the publisher: sent
 * to the room on every change, and replayed to each newcomer after `joined`.
 */
export interface SfuTracksData {
  sessionId: string
  tracks: SfuTrackInfo[]
  /**
   * server → client only: the room version this change landed at, so it can
   * be ordered against a snapshot. Missing on the join replay, which sends
   * stored sets in no particular order.
   */
  version?: number
}

export interface RoomSnapshotPeerTracks {
  peerId: string
  sessionId: string
  tracks: SfuTrackInfo[]
}

/**
 * server → client `room-snapshot`: the whole room, everyone present
 * (including the receiver) and every stored track set. Sent after `joined`,
 * in reply to `sync`, and every 15 s to rooms where someone publishes. Any
 * message the client missed, the next snapshot corrects.
 */
export interface RoomSnapshotData {
  version: number
  peers: PeerInfo[]
  tracks: RoomSnapshotPeerTracks[]
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

/** One STUN or TURN server, in the shape RTCPeerConnection takes. */
export interface IceServer {
  urls: string[]
  username?: string
  credential?: string
}

/** Body of `POST /ice-servers`. */
export interface IceServersRequest {
  roomId: string
}

/** Response of `POST /ice-servers`. TURN credentials in it expire after an hour. */
export interface IceServersResponse {
  iceServers: IceServer[]
}

// ─── Connection quality (Phase 10) ─────────────────────────────────────────

export type QualityGrade = 'good' | 'medium' | 'poor' | 'unknown'
export type NetworkPressure = 'low' | 'medium' | 'high' | 'severe' | 'unknown'
/** host or srflx: a direct path. relay: through TURN. */
export type CandidateType = 'host' | 'srflx' | 'relay' | 'unknown'

/** How one browser sees its connection to one other person. */
export interface StatsReportPeer {
  /** The other person. */
  peerId: string
  quality: QualityGrade
  networkPressure: NetworkPressure
  /** -1 until measured. */
  roundTripTimeMs: number
  packetLossPercent: number
  jitterMs: number
  /** Our uplink: one stream to the SFU, the same in every entry. */
  outboundBitrateKbps: number
  /** What we receive from this person. */
  inboundBitrateKbps: number
  candidateType: CandidateType
  frameWidth?: number
  frameHeight?: number
  framesPerSecond?: number
}

/** client → server, every 10 s while in a call with others. */
export interface StatsReportData {
  peers: StatsReportPeer[]
}
