import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import type {
  Envelope,
  ErrorData,
  JoinData,
  KnockAnswerData,
  KnockGrantedData,
  PeerStateData,
  StatsReportPeer,
  SfuTrackInfo,
  SfuTracksData,
  SignalingErrorCode,
} from '@rendezvu/protocol'
import type { RoomAccess } from '../access/room-access.ts'
import { clientIp } from '../http/client-ip.ts'
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
// A real client sends a handful of messages a second at most. A burst of 60,
// refilling at 30 a second, never touches it and stops a flood.
const WS_MESSAGE_BURST = 60
const WS_MESSAGES_PER_SECOND = 30
// One office behind a NAT is a few dozen tabs at most; a script opening
// sockets in a loop is not.
const MAX_SOCKETS_PER_IP = 20
const MAX_TOKEN_LENGTH = 2048

interface Deps {
  hub: Hub
  registry: InstantRoomRegistry
  sfuSessions: SfuSessionRegistry
  quality: QualityStore
  access: RoomAccess
  allowedOrigins: string[]
}

export interface Signaling {
  /** Closes every socket with 1001 (going away) so browsers reconnect promptly after a deploy. */
  closeAll: () => void
}

export function attachSignaling(server: Server, deps: Deps): Signaling {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
  const allowedHosts = new Set(deps.allowedOrigins.map(hostOf).filter((h): h is string => h !== null))
  const socketsPerIp = new Map<string, number>()
  // One log line per address every 10 s: a flood of refused sockets must not flood the log too.
  const refusedLoggedAt = new Map<string, number>()

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
    const ip = clientIp(req)
    const open = socketsPerIp.get(ip) ?? 0
    if (open >= MAX_SOCKETS_PER_IP) {
      const now = Date.now()
      if (now - (refusedLoggedAt.get(ip) ?? 0) > 10_000) {
        refusedLoggedAt.set(ip, now)
        log('ws_too_many_sockets', { ip })
      }
      rejectUpgrade(socket, 429, 'Too Many Requests')
      return
    }
    socketsPerIp.set(ip, open + 1)
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.once('close', () => {
        const left = (socketsPerIp.get(ip) ?? 1) - 1
        if (left > 0) socketsPerIp.set(ip, left)
        else socketsPerIp.delete(ip)
      })
      handleConnection(ws, deps)
    })
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

  // Token bucket: refills continuously, one message per token.
  let tokens = WS_MESSAGE_BURST
  let refilledAt = Date.now()
  const takeToken = () => {
    const now = Date.now()
    tokens = Math.min(WS_MESSAGE_BURST, tokens + ((now - refilledAt) / 1000) * WS_MESSAGES_PER_SECOND)
    refilledAt = now
    if (tokens < 1) return false
    tokens -= 1
    return true
  }

  // Messages already queued keep arriving while the close goes out; they're dropped unlogged.
  let limited = false
  ws.on('message', (raw: RawData) => {
    if (limited) return
    if (!takeToken()) {
      limited = true
      log('ws_rate_limited', { peer: peer.id })
      ws.close(1008, 'too many messages')
      return
    }
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
    hub.leaveWaiting(peer)
    log('ws_disconnect', { peer: peer.id })
  })

  ws.on('error', (err) => log('ws_error', { peer: peer.id, error: err.message }))
}

function handleMessage(peer: Peer, env: Envelope, deps: Deps): void {
  const { hub, sfuSessions, quality } = deps
  switch (env.type) {
    case 'join':
      handleJoin(peer, env, deps)
      return
    case 'knock-admit':
    case 'knock-deny':
      handleKnockAnswer(peer, env, deps)
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
      hub.leaveWaiting(peer)
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

/**
 * The token decides: a valid one for this room makes a member, anything
 * else is a knock. A client's own say-so (a flag, the page it's on) never does.
 */
function handleJoin(peer: Peer, env: Envelope, { hub, registry, access }: Deps): void {
  if (!env.room) {
    sendError(peer, 'join requires room')
    return
  }
  if (!isMeetCode(env.room)) {
    sendError(peer, 'invalid room')
    return
  }

  const data = readJoinData(env.data)
  const presenceId = data.presenceId ?? peer.id
  const decision = access.authorizeJoin(env.room, data.token, presenceId)
  if (decision.kind === 'refused') {
    sendError(peer, decision.message, decision.code)
    return
  }
  if (decision.kind === 'knock') {
    const result = hub.knock(peer, env.room, { ...data, presenceId })
    if (result === 'queue-full') sendError(peer, 'Too many people are waiting to join.', 'KNOCK_QUEUE_FULL')
    return
  }
  joinAsMember(peer, env.room, { ...data, presenceId }, hub, registry)
}

/** Into the room: what a token holder gets at once, and an admitted guest after its knock-granted. */
function joinAsMember(peer: Peer, roomId: string, data: JoinData & { presenceId: string }, hub: Hub, registry: InstantRoomRegistry): void {
  // A member's join is what starts the room's clock.
  const state = registry.activateOrAllow(roomId)
  if (state !== 'ok') {
    if (state === 'expired') sendError(peer, 'This meeting is no longer active.', 'ROOM_EXPIRED')
    else sendError(peer, 'This meeting is not available right now.', 'ROOM_UNAVAILABLE')
    return
  }
  hub.join(peer, roomId, data)
  // join() leaves the peer's previous room first. Rejoining a room you were
  // alone in empties it for a moment, which would start the empty-grace
  // countdown on a room that is in use.
  registry.markActive(roomId)
  log('ws_join', {
    peer: peer.id,
    // Enough to follow one tab across reconnects without logging a usable id.
    presence: peer.presenceId.slice(0, 8),
    room: roomId,
    name: data.name,
    audio: data.audio,
    video: data.video,
  })
}

/**
 * A member answered a knock. Ignored unless the sender is a member of a room
 * where that guest is waiting, so a guest can't let another guest in.
 */
function handleKnockAnswer(peer: Peer, env: Envelope, { hub, registry, access }: Deps): void {
  const d: Partial<KnockAnswerData> = isObject(env.data) ? env.data : {}
  const guestId = typeof d.peerId === 'string' ? d.peerId : ''
  const roomId = peer.roomId
  if (!guestId || !roomId) return
  const admitted = env.type === 'knock-admit'
  const guest = hub.answerKnock(peer, guestId, admitted)
  if (!guest) return
  if (!admitted) {
    guest.send({ type: 'knock-denied', room: roomId })
    return
  }
  // Token first, so every request the guest makes from `joined` on can carry it.
  const token = access.issueGuestToken(roomId, guest.presenceId)
  guest.send({ type: 'knock-granted', room: roomId, data: { token } satisfies KnockGrantedData })
  joinAsMember(
    guest,
    roomId,
    { name: guest.name, audio: guest.audio, video: guest.video, presenceId: guest.presenceId },
    hub,
    registry,
  )
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
  if (typeof d.token === 'string' && d.token.length <= MAX_TOKEN_LENGTH) join.token = d.token
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
