import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import type {
  Envelope,
  ErrorData,
  JoinData,
  PeerStateData,
  StatsReportPeer,
  SfuTrackInfo,
  SfuTracksData,
  SignalingErrorCode,
} from '@rendezvu/protocol'
import { isObject } from '../json.ts'
import { log } from '../log.ts'
import type { InstantRoomRegistry } from '../meets/instant-rooms.ts'
import { isMeetCode } from '../meets/meet-code.ts'
import type { QualityStore } from '../quality/quality-store.ts'
import type { SfuSessionRegistry } from '../sfu/session-registry.ts'
import type { Hub } from './hub.ts'
import { Peer } from './peer.ts'

// The client pings every 15 s. Silence for this long means the other end is
// gone (lid closed, network dropped) without a proper close.
const READ_IDLE_TIMEOUT_MS = 60_000
// Signaling messages are small JSON. The library default (100 MiB) would let
// one client make the server buffer huge frames.
const MAX_MESSAGE_BYTES = 32 * 1024
// A peer publishes a handful of tracks at most (mic, camera, later a screen).
// Phase 5 replays the stored set to every later joiner, so junk stored once
// would be sent many times.
const MAX_ANNOUNCED_TRACKS = 8
const MAX_SFU_ID_LENGTH = 256
// An honest client reports every 10 s. Anything faster is dropped.
const STATS_REPORT_MIN_INTERVAL_MS = 5_000
// Rooms hold far fewer people; a longer list is junk.
const MAX_STATS_REPORT_PEERS = 16

interface Deps {
  hub: Hub
  registry: InstantRoomRegistry
  sfuSessions: SfuSessionRegistry
  quality: QualityStore
  allowedOrigins: string[]
}

export interface Signaling {
  /** Closes every socket with 1001 (going away) so browsers reconnect promptly after a deploy. */
  closeAll: () => void
}

export function attachSignaling(server: Server, deps: Deps): Signaling {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
  const allowedHosts = new Set(deps.allowedOrigins.map(hostOf).filter((h): h is string => h !== null))

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path !== '/ws') {
      rejectUpgrade(socket, 404, 'Not Found')
      return
    }
    // Browsers don't apply CORS to WebSockets, so without this any website
    // could open a socket here from a visitor's browser.
    if (!originAllowed(req, allowedHosts)) {
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, deps))
  })

  return {
    closeAll: () => {
      for (const ws of wss.clients) ws.close(1001, 'server shutting down')
    },
  }
}

function handleConnection(ws: WebSocket, deps: Deps): void {
  const { hub } = deps
  const peer = new Peer(randomBytes(8).toString('hex'), ws)
  log('ws_connect', { peer: peer.id })
  peer.send({ type: 'welcome', from: peer.id })

  let idleTimer = setTimeout(() => ws.terminate(), READ_IDLE_TIMEOUT_MS)
  const resetIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => ws.terminate(), READ_IDLE_TIMEOUT_MS)
  }

  ws.on('message', (raw: RawData) => {
    resetIdle()
    const env = parseEnvelope(raw)
    if (!env) {
      sendError(peer, 'invalid JSON')
      return
    }
    handleMessage(peer, env, deps)
  })

  ws.on('close', () => {
    clearTimeout(idleTimer)
    hub.leave(peer, 'disconnect')
    log('ws_disconnect', { peer: peer.id })
  })

  ws.on('error', (err) => log('ws_error', { peer: peer.id, error: err.message }))
}

function handleMessage(peer: Peer, env: Envelope, { hub, registry, sfuSessions, quality }: Deps): void {
  switch (env.type) {
    case 'join':
      handleJoin(peer, env, hub, registry)
      return
    case 'sfu-announce':
      handleSfuAnnounce(peer, env, hub, sfuSessions)
      return
    case 'peer-state':
      // Not in a room: a state message racing a leave is normal, not worth an error.
      if (peer.roomId) hub.updateState(peer, readPeerState(env.data))
      return
    case 'leave':
      hub.leave(peer, 'leave')
      return
    case 'sync':
      // Not in a room: same as peer-state, a race with leave, not an error.
      hub.sendSnapshot(peer)
      return
    case 'stats-report':
      handleStatsReport(peer, env, hub, quality)
      return
    case 'ping':
      peer.send({ type: 'pong' })
      return
    default:
      sendError(peer, `unknown message type: ${String(env.type)}`)
  }
}

function handleJoin(peer: Peer, env: Envelope, hub: Hub, registry: InstantRoomRegistry): void {
  if (!env.room) {
    sendError(peer, 'join requires room')
    return
  }
  if (!isMeetCode(env.room)) {
    sendError(peer, 'invalid room')
    return
  }

  const access = registry.activateOrAllow(env.room)
  if (access === 'expired') {
    sendError(peer, 'This meeting is no longer active.', 'ROOM_EXPIRED')
    return
  }
  if (access !== 'ok') {
    sendError(peer, 'This meeting is not available right now.', 'ROOM_UNAVAILABLE')
    return
  }

  const data = readJoinData(env.data)
  hub.join(peer, env.room, { ...data, presenceId: data.presenceId ?? peer.id })
  // join() leaves the peer's previous room first. Rejoining a room you were
  // alone in empties it for a moment, which would start the empty-grace
  // countdown on a room that is in use.
  registry.markActive(env.room)
  log('ws_join', {
    peer: peer.id,
    // Enough to follow one tab across reconnects without logging a usable id.
    presence: peer.presenceId.slice(0, 8),
    room: env.room,
    name: data.name,
    audio: data.audio,
    video: data.video,
  })
}

/**
 * The full set of tracks this peer has published, sent once Cloudflare has
 * confirmed them. Stored on the room and passed to everyone else in it.
 */
function handleSfuAnnounce(peer: Peer, env: Envelope, hub: Hub, sfuSessions: SfuSessionRegistry): void {
  if (!peer.roomId) {
    sendError(peer, 'join a room before announcing tracks', 'NOT_IN_ROOM')
    return
  }
  const data = readSfuTracks(env.data)
  // The session must be this tab's own publish session. Otherwise a peer
  // could announce someone else's tracks under its own name.
  if (!data || !sfuSessions.isPublishSessionOf(data.sessionId, peer.presenceId)) {
    sendError(peer, 'invalid sfu-announce')
    return
  }
  hub.announceTracks(peer, data)
}

/**
 * How one browser sees its connection to each other person. Nobody else
 * sees it, but it's logged and kept, so it's checked like everything else.
 * Logged only when something is wrong: healthy reports would be most of the log.
 */
function handleStatsReport(peer: Peer, env: Envelope, hub: Hub, quality: QualityStore): void {
  // Not in a room: a report racing a leave, as with peer-state.
  const roomId = peer.roomId
  if (!roomId) return
  const now = Date.now()
  if (now - peer.lastStatsReportAt < STATS_REPORT_MIN_INTERVAL_MS) return
  const data = isObject(env.data) ? env.data : {}
  if (!Array.isArray(data.peers) || data.peers.length > MAX_STATS_REPORT_PEERS) return
  peer.lastStatsReportAt = now

  const entries: StatsReportPeer[] = []
  for (const raw of data.peers as unknown[]) {
    const entry = readStatsEntry(raw)
    // Only about someone else who is in this call right now.
    if (!entry || entry.peerId === peer.id || !hub.isPeerInRoom(entry.peerId, roomId)) continue
    entries.push(entry)
  }
  if (entries.length === 0) return
  quality.set(roomId, peer.id, entries, now)

  const worst = entries.some((e) => e.quality === 'poor') ? 'poor' : entries.some((e) => e.quality === 'medium') ? 'medium' : null
  if (!worst) return
  log('stats_report', {
    room: roomId,
    peer: peer.id,
    peers: entries.length,
    worst,
    max_rtt_ms: Math.max(...entries.map((e) => e.roundTripTimeMs)),
    max_loss_pct: Math.max(...entries.map((e) => e.packetLossPercent)),
    relay: entries.filter((e) => e.candidateType === 'relay').length,
  })
}

const QUALITY_GRADES = ['good', 'medium', 'poor', 'unknown'] as const
const NETWORK_PRESSURES = ['low', 'medium', 'high', 'severe', 'unknown'] as const
const CANDIDATE_TYPES = ['host', 'srflx', 'relay', 'unknown'] as const

/** Null without a usable peer id. Enums outside their lists become 'unknown'; numbers are clamped. */
function readStatsEntry(raw: unknown): StatsReportPeer | null {
  if (!isObject(raw) || typeof raw.peerId !== 'string' || raw.peerId === '' || raw.peerId.length > 64) return null
  const rtt = finite(raw.roundTripTimeMs)
  const entry: StatsReportPeer = {
    peerId: raw.peerId,
    quality: oneOf(raw.quality, QUALITY_GRADES),
    networkPressure: oneOf(raw.networkPressure, NETWORK_PRESSURES),
    // -1 means "not measured yet".
    roundTripTimeMs: rtt === null || rtt < 0 ? -1 : round1(clamp(rtt, 0, 60_000)),
    packetLossPercent: round1(clamp(finite(raw.packetLossPercent) ?? 0, 0, 100)),
    jitterMs: round1(clamp(finite(raw.jitterMs) ?? 0, 0, 10_000)),
    outboundBitrateKbps: round1(clamp(finite(raw.outboundBitrateKbps) ?? 0, 0, 100_000)),
    inboundBitrateKbps: round1(clamp(finite(raw.inboundBitrateKbps) ?? 0, 0, 100_000)),
    candidateType: oneOf(raw.candidateType, CANDIDATE_TYPES),
  }
  const width = wholeUpTo(raw.frameWidth, 8192)
  const height = wholeUpTo(raw.frameHeight, 8192)
  const fps = finite(raw.framesPerSecond)
  if (width !== null) entry.frameWidth = width
  if (height !== null) entry.frameHeight = height
  if (fps !== null) entry.framesPerSecond = round1(clamp(fps, 0, 120))
  return entry
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | 'unknown' {
  return allowed.includes(value as T) ? (value as T) : 'unknown'
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function wholeUpTo(value: unknown, max: number): number | null {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max ? (value as number) : null
}

/** Null unless every field is present and within bounds. An empty track list is valid: it withdraws the session. */
function readSfuTracks(data: unknown): SfuTracksData | null {
  if (!isObject(data) || !isSfuId(data.sessionId) || !Array.isArray(data.tracks)) return null
  if (data.tracks.length > MAX_ANNOUNCED_TRACKS) return null
  const tracks: SfuTrackInfo[] = []
  for (const t of data.tracks as unknown[]) {
    if (!isObject(t) || !isSfuId(t.trackName)) return null
    tracks.push(typeof t.mid === 'string' ? { trackName: t.trackName, mid: t.mid } : { trackName: t.trackName })
  }
  return { sessionId: data.sessionId, tracks }
}

function isSfuId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SFU_ID_LENGTH
}

/** Anything but `true` counts as false. Unknown fields are dropped, so only these four are passed on. */
function readPeerState(data: unknown): PeerStateData {
  const d = isObject(data) ? data : {}
  return {
    audio: d.audio === true,
    video: d.video === true,
    speaking: d.speaking === true,
    screenSharing: d.screenSharing === true,
  }
}

const MAX_NAME_LENGTH = 40

/**
 * Names are shown on everyone's screen and written to logs. The lobby's
 * maxLength only limits honest browsers, so the rule is enforced here: no
 * control characters (newlines, terminal escapes), at most 40 code points so
 * an emoji is never cut in half.
 */
function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // A control character between words becomes a space ("Alice\nSmith" → "Alice Smith").
  const chars = [...raw.replace(/[\p{Cc}\s]+/gu, ' ').trim()]
  return chars.slice(0, MAX_NAME_LENGTH).join('').trim()
}

// A UUID from the browser, but any id of reasonable length and plain
// characters will do. It's never echoed to anyone, so the rule only keeps logs
// and map keys sane.
const PRESENCE_ID = /^[A-Za-z0-9-]{8,64}$/

/** Missing or malformed fields fall back to an empty name, media off and no presence id. */
function readJoinData(data: unknown): JoinData {
  const d = isObject(data) ? data : {}
  const join: JoinData = {
    name: cleanName(d.name),
    audio: d.audio === true,
    video: d.video === true,
  }
  if (typeof d.presenceId === 'string' && PRESENCE_ID.test(d.presenceId)) join.presenceId = d.presenceId
  return join
}

function parseEnvelope(raw: RawData): Envelope | null {
  try {
    const value: unknown = JSON.parse(raw.toString())
    return isObject(value) ? (value as unknown as Envelope) : null
  } catch {
    return null
  }
}

function sendError(peer: Peer, message: string, code?: SignalingErrorCode): void {
  const data: ErrorData = code ? { message, code } : { message }
  peer.send({ type: 'error', data })
}

function originAllowed(req: IncomingMessage, allowedHosts: Set<string>): boolean {
  const origin = req.headers.origin
  if (!origin) return true // not a browser
  const host = hostOf(origin)
  if (!host) return false
  // Same host as the server itself is always fine, as with any same-origin request.
  return allowedHosts.has(host) || host === req.headers.host?.toLowerCase()
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase()
  } catch {
    return null
  }
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}
