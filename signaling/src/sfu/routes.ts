import type { IncomingMessage, ServerResponse } from 'node:http'
import { clientIp } from '../http/client-ip.ts'
import { watchClientGone } from '../http/client-gone.ts'
import { guardApiRequest } from '../http/guard.ts'
import { RateLimiter } from '../http/rate-limiter.ts'
import { BodyTooLargeError, readJson } from '../http/read-json.ts'
import { catchAsync, sendError, sendJson, sendText } from '../http/respond.ts'
import { isObject } from '../json.ts'
import { errorMessage, log } from '../log.ts'
import type { InstantRoomRegistry } from '../meets/instant-rooms.ts'
import { requireActiveRoom } from '../meets/room-access.ts'
import type { Hub } from '../signaling/hub.ts'
import { SfuUpstreamError, type CloudflareSfuClient, type SfuSubPath } from './cloudflare-sfu.ts'
import type { SfuSessionKind, SfuSessionRegistry } from './session-registry.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void

const PREFIX = '/sfu/sessions/'
// An SDP offer for several tracks runs to tens of KB, far past the 16 KiB default.
const MAX_SFU_BODY_BYTES = 256 * 1024
const NO_STORE = { 'Cache-Control': 'no-store' }

// Which method each sub-path accepts. Anything else under the prefix is a 404.
const SUB_PATHS: Record<SfuSubPath, 'POST' | 'PUT'> = {
  'tracks/new': 'POST',
  renegotiate: 'PUT',
  'tracks/update': 'PUT',
  'tracks/close': 'PUT',
}

export interface SfuDeps {
  sessions: SfuSessionRegistry
  hub: Hub
  rooms: InstantRoomRegistry
  /** Null when CF_CALLS_APP_ID / CF_CALLS_APP_TOKEN aren't set. */
  sfuClient: CloudflareSfuClient | null
  allowedOrigins: string[]
}

/**
 * Everything under /sfu/sessions/: a proxy to Cloudflare's Realtime API in
 * the shape partytracks expects. Media never passes through here, only the
 * control calls (create a session, offer/answer, close tracks). The proxy
 * exists to keep the app token secret and to enforce who may do what.
 */
export function sfuHandler(deps: SfuDeps): Handler {
  // /sessions/new is the one path every participant shares. A 10-person room
  // on one office network creates ~100 sessions in its first seconds, which a
  // single per-address bucket would refuse. So a tight bucket per peer stops
  // one client stuck in a retry loop, and a wide one per address remains as
  // the abuse backstop.
  const peerLimiter = new RateLimiter(30, 40)
  const addressLimiter = new RateLimiter(300, 400)

  return (req, res) => {
    if (!guardApiRequest(req, res, { allowedOrigins: deps.allowedOrigins, methods: 'POST, PUT, DELETE', maxBodyBytes: MAX_SFU_BODY_BYTES })) {
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!allowRate(req, res, url, peerLimiter, addressLimiter)) return
    if (!deps.sfuClient) {
      sendError(res, 503, 'SFU_UNAVAILABLE', 'Video calls are not configured on this server.')
      return
    }

    catchAsync(res, url.pathname, route(req, res, url, deps, deps.sfuClient))
  }
}

async function route(req: IncomingMessage, res: ServerResponse, url: URL, deps: SfuDeps, sfu: CloudflareSfuClient): Promise<void> {
  const [sessionId = '', ...rest] = url.pathname.slice(PREFIX.length).split('/')
  const subPath = rest.join('/')
  const peerId = url.searchParams.get('peerId') ?? ''

  if (sessionId === 'new' && subPath === '') {
    if (req.method !== 'POST') {
      sendText(res, 405, 'method not allowed')
      return
    }
    await createSession(res, url, deps, sfu)
    return
  }

  // Someone else's session gets the same 404 as a made-up one, so a guesser
  // learns nothing about which ids exist.
  const entry = sessionId ? deps.sessions.lookup(sessionId) : undefined
  if (!entry || entry.peerId !== peerId) {
    sendError(res, 404, 'SESSION_NOT_FOUND', 'session not found')
    return
  }
  if (!requireActiveRoom(res, deps.rooms, entry.roomId)) return

  if (subPath === '' && req.method === 'DELETE') {
    // Cloudflare has no session delete: a session ends when its connection
    // closes. This only stops the id from being used here again.
    deps.sessions.remove(sessionId)
    log('sfu_session_closed', { room: entry.roomId, peer: peerId, session: sessionId })
    res.writeHead(204, NO_STORE)
    res.end()
    return
  }

  const method = SUB_PATHS[subPath as SfuSubPath]
  if (!method || req.method !== method) {
    sendError(res, 404, 'NOT_FOUND', 'not found')
    return
  }

  let body: unknown
  try {
    body = await readJson(req, MAX_SFU_BODY_BYTES)
  } catch (err) {
    if (err instanceof BodyTooLargeError) sendText(res, 413, 'request body too large')
    else sendError(res, 400, 'INVALID_JSON', 'request body must be JSON')
    return
  }
  if (subPath === 'renegotiate' && !hasSessionDescription(body)) {
    sendError(res, 400, 'INVALID_REQUEST', 'sessionDescription with type and sdp is required')
    return
  }

  const ctx = { room: entry.roomId, peer: peerId, route: subPath }
  const clientGone = watchClientGone(res)
  try {
    const answer = await sfu.forward(method, sessionId, subPath as SfuSubPath, body, clientGone.signal)
    if (subPath === 'tracks/new' && isObject(body) && body.sessionDescription) {
      // Accepted, not live: the browser still has to apply the answer and
      // connect. It announces only after that, so a publish logged here with
      // no sfu_announce soon after means the browser never got there.
      const tracks = Array.isArray(body.tracks) ? body.tracks.length : 0
      log('sfu_publish_accepted', { room: entry.roomId, peer: peerId, session: sessionId, tracks })
    }
    // partytracks calls res.json() on every response, so an empty body becomes {}.
    res.writeHead(answer.status, { 'Content-Type': 'application/json', ...NO_STORE })
    res.end(answer.body || '{}')
  } catch (err) {
    sendUpstreamError(res, err, clientGone.signal.aborted, ctx)
  } finally {
    clientGone.release()
  }
}

async function createSession(res: ServerResponse, url: URL, deps: SfuDeps, sfu: CloudflareSfuClient): Promise<void> {
  const roomId = url.searchParams.get('roomId') ?? ''
  const peerId = url.searchParams.get('peerId') ?? ''
  // `kind` is set by our client. Anything but "publish" is treated as a
  // subscribe session, which can't be announced to the room.
  const kind: SfuSessionKind = url.searchParams.get('kind') === 'publish' ? 'publish' : 'subscribe'
  if (!roomId || !peerId) {
    sendError(res, 400, 'PARAMS_REQUIRED', 'roomId and peerId are required')
    return
  }
  if (!requireActiveRoom(res, deps.rooms, roomId)) return
  // Until Phase 11's tokens, this is the ownership check: only a peer that is
  // connected and in this room right now can open sessions for it.
  if (!deps.hub.isInRoom(peerId, roomId)) {
    sendError(res, 403, 'NOT_IN_ROOM', 'Join the meeting first.')
    return
  }

  const clientGone = watchClientGone(res)
  try {
    const sessionId = await sfu.createSession(clientGone.signal)
    // The peer may have left while Cloudflare was answering; its sessions
    // were already dropped, and this one must not outlive it either.
    if (!deps.hub.isInRoom(peerId, roomId)) {
      sendError(res, 403, 'NOT_IN_ROOM', 'Join the meeting first.')
      return
    }
    deps.sessions.register(sessionId, roomId, peerId, kind)
    log('sfu_session', { room: roomId, peer: peerId, kind, session: sessionId })
    sendJson(res, 200, { sessionId }, NO_STORE)
  } catch (err) {
    sendUpstreamError(res, err, clientGone.signal.aborted, { room: roomId, peer: peerId, route: 'sessions/new' })
  } finally {
    clientGone.release()
  }
}

/**
 * Cloudflare's JSON error goes to the browser unchanged, because partytracks
 * reads `errorCode` from it to decide how to recover. Anything else (timeout,
 * network) becomes our own 502.
 */
function sendUpstreamError(
  res: ServerResponse,
  err: unknown,
  clientLeft: boolean,
  ctx: { room: string; peer: string; route: string },
): void {
  if (clientLeft) {
    log('sfu_error', { ...ctx, error: 'aborted' })
    return
  }
  const message = errorMessage(err)
  if (err instanceof SfuUpstreamError) {
    log('sfu_error', { ...ctx, status: err.status, error: message })
    if (isJson(err.body)) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...NO_STORE })
      res.end(err.body)
      return
    }
  } else {
    log('sfu_error', { ...ctx, error: message })
  }
  sendError(res, 502, 'SFU_UPSTREAM', 'Could not reach the video service.')
}

function allowRate(req: IncomingMessage, res: ServerResponse, url: URL, perPeer: RateLimiter, perAddress: RateLimiter): boolean {
  // Requests without a peerId skip the peer bucket; the address bucket still applies.
  const peerId = url.searchParams.get('peerId')
  const decisions = [
    peerId ? perPeer.take(`${url.pathname}|peer|${peerId}`) : { allowed: true as const },
    perAddress.take(`${url.pathname}|addr|${clientIp(req)}`),
  ]
  for (const decision of decisions) {
    if (!decision.allowed) {
      sendText(res, 429, 'rate limit exceeded', { 'Retry-After': String(decision.retryAfterSeconds) })
      return false
    }
  }
  return true
}

function hasSessionDescription(body: unknown): boolean {
  const desc = isObject(body) ? body.sessionDescription : undefined
  return isObject(desc) && typeof desc.type === 'string' && desc.type !== '' && typeof desc.sdp === 'string' && desc.sdp !== ''
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text)
    return text.trim() !== ''
  } catch {
    return false
  }
}
