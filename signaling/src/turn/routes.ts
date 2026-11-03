import type { IncomingMessage, ServerResponse } from 'node:http'
import type { IceServer, IceServersResponse } from '@rendezvu/protocol'
import { watchClientGone } from '../http/client-gone.ts'
import { guardApiRequest } from '../http/guard.ts'
import { RateLimiter } from '../http/rate-limiter.ts'
import { BodyTooLargeError, readJson } from '../http/read-json.ts'
import { catchAsync, sendError, sendJson, sendText } from '../http/respond.ts'
import { isObject } from '../json.ts'
import { errorMessage, log } from '../log.ts'
import { sendRefusal, type RoomAccess } from '../access/room-access.ts'
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
  access: RoomAccess,
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
    catchAsync(res, '/ice-servers', handle(req, res, access, turnClient))
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  access: RoomAccess,
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

  // A token for this room, and a room someone has joined. Stops anyone
  // farming TURN credentials (billed to us) from a meeting code alone.
  const decision = access.authorizeRequest(req, roomId, readPresenceId(body))
  if (!decision.ok) {
    sendRefusal(res, '/ice-servers', decision)
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
  const clientGone = watchClientGone(res)
  try {
    const signal = AbortSignal.any([clientGone.signal, AbortSignal.timeout(CLOUDFLARE_TIMEOUT_MS)])
    return await turnClient.generateIceServers(CREDENTIAL_TTL_SECONDS, signal)
  } catch (err) {
    if (clientGone.signal.aborted) {
      log('ice_error', { room: roomId, error: 'aborted' })
      return null
    }
    // The error holds Cloudflare's status and body, never the credentials.
    log('ice_error', { room: roomId, error: errorMessage(err) })
    return STUN_FALLBACK
  } finally {
    clientGone.release()
  }
}

function readPresenceId(body: unknown): string | undefined {
  const presenceId = isObject(body) ? body.presenceId : undefined
  return typeof presenceId === 'string' && presenceId.length <= 64 ? presenceId : undefined
}

function readRoomId(body: unknown): string | null {
  if (!isObject(body)) return null
  const roomId = body.roomId
  return typeof roomId === 'string' && roomId !== '' ? roomId : null
}
