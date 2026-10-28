import type { IncomingMessage, ServerResponse } from 'node:http'
import type { IceServer, IceServersResponse } from '@rendezvu/protocol'
import { guardApiRequest } from '../http/guard.ts'
import { RateLimiter } from '../http/rate-limiter.ts'
import { BodyTooLargeError, readJson } from '../http/read-json.ts'
import { sendError, sendJson, sendText } from '../http/respond.ts'
import { log } from '../log.ts'
import type { InstantRoomRegistry } from '../meets/instant-rooms.ts'
import { roomAccessError } from '../meets/room-access.ts'
import type { CloudflareTurnClient } from './cloudflare-turn.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void

const CREDENTIAL_TTL_SECONDS = 3600
// Longer than the client's 5 s on purpose: the client gives up first and retries.
const CLOUDFLARE_TIMEOUT_MS = 8000
// Keeps calls on easy networks (same Wi-Fi, most home routers) working when
// Cloudflare is down or the keys are missing. Strict networks need TURN.
const STUN_FALLBACK: IceServer[] = [{ urls: ['stun:stun.l.google.com:19302'] }]

/**
 * POST /ice-servers {roomId}: fresh STUN/TURN credentials for an active room.
 * `turnClient` is null when the Cloudflare keys aren't set; every caller then
 * gets the STUN fallback.
 */
export function iceServersHandler(
  registry: InstantRoomRegistry,
  turnClient: CloudflareTurnClient | null,
  allowedOrigins: string[],
): Handler {
  const limiter = new RateLimiter(60, 120)
  return (req, res) => {
    if (!guardApiRequest(req, res, { allowedOrigins, methods: 'POST', limiter })) return
    if (req.method !== 'POST') {
      sendText(res, 405, 'method not allowed')
      return
    }
    // The server calls routes synchronously, so an async failure has to be caught here.
    handle(req, res, registry, turnClient).catch((err: unknown) => {
      log('http_error', { path: '/ice-servers', error: err instanceof Error ? err.message : String(err) })
      if (!res.headersSent) sendText(res, 500, 'internal error')
      else res.end()
    })
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  registry: InstantRoomRegistry,
  turnClient: CloudflareTurnClient | null,
): Promise<void> {
  let body: unknown
  try {
    body = await readJson(req)
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendText(res, 413, 'request body too large')
      return
    }
    body = null // invalid JSON: answered as a missing roomId below
  }
  const roomId = readRoomId(body)
  if (!roomId) {
    sendError(res, 400, 'ROOM_REQUIRED', 'roomId is required')
    return
  }

  // Only a room someone has joined. Stops anyone farming TURN credentials
  // (billed to us) from codes that were created but never used.
  const access = registry.allowActive(roomId)
  if (access !== 'ok') {
    const refusal = roomAccessError(access)
    sendError(res, refusal.status, refusal.code, refusal.message)
    return
  }

  const iceServers = turnClient ? await fromCloudflare(turnClient, roomId, res) : STUN_FALLBACK
  if (!iceServers) return // the client left; nobody to answer
  log('ice_servers', { room: roomId, source: iceServers === STUN_FALLBACK ? 'fallback' : 'cloudflare' })

  const response: IceServersResponse = { iceServers }
  // Every response holds fresh credentials, so nothing may cache it.
  sendJson(res, 200, response, { 'Cache-Control': 'no-store' })
}

/**
 * Cloudflare's servers, or the STUN fallback if Cloudflare fails or times out.
 * Null when the client disconnected first: that's not a Cloudflare failure,
 * and there's no one to send the fallback to.
 */
async function fromCloudflare(
  turnClient: CloudflareTurnClient,
  roomId: string,
  res: ServerResponse,
): Promise<IceServer[] | null> {
  // 'close' before the response is finished means the client went away.
  const clientGone = new AbortController()
  const onClose = () => {
    if (!res.writableFinished) clientGone.abort()
  }
  res.on('close', onClose)
  try {
    const signal = AbortSignal.any([clientGone.signal, AbortSignal.timeout(CLOUDFLARE_TIMEOUT_MS)])
    return await turnClient.generateIceServers(CREDENTIAL_TTL_SECONDS, signal)
  } catch (err) {
    if (clientGone.signal.aborted) {
      log('ice_error', { room: roomId, error: 'aborted' })
      return null
    }
    // The error holds Cloudflare's status and body, never the credentials.
    log('ice_error', { room: roomId, error: err instanceof Error ? err.message : String(err) })
    return STUN_FALLBACK
  } finally {
    res.off('close', onClose)
  }
}

function readRoomId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const roomId = (body as Record<string, unknown>).roomId
  return typeof roomId === 'string' && roomId !== '' ? roomId : null
}
