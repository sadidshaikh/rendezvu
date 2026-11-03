import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CreateMeetResponse, RoomStatusResult } from '@rendezvu/protocol'
import type { RoomAccess } from '../access/room-access.ts'
import { guardApiRequest } from '../http/guard.ts'
import { RateLimiter } from '../http/rate-limiter.ts'
import { sendError, sendJson, sendText } from '../http/respond.ts'
import { log } from '../log.ts'
import type { InstantRoomRegistry } from './instant-rooms.ts'
import { generateMeetCode, isMeetCode } from './meet-code.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void

/**
 * POST /meets/new: creates an instant meeting and returns its code, plus a
 * host token so its creator joins without knocking.
 */
export function createMeetHandler(registry: InstantRoomRegistry, access: RoomAccess, allowedOrigins: string[]): Handler {
  const limiter = new RateLimiter(12, 24)
  return (req, res) => {
    if (!guardApiRequest(req, res, { allowedOrigins, methods: 'POST', limiter })) return
    if (req.method !== 'POST') {
      sendText(res, 405, 'method not allowed')
      return
    }

    let code: string
    try {
      code = generateMeetCode()
    } catch {
      sendText(res, 500, 'could not create meet')
      return
    }
    registry.create(code)
    log('meet_created', { room: code })

    const body: CreateMeetResponse = { meetCode: code, hostToken: access.issueHostToken(code) }
    sendJson(res, 200, body, { 'Cache-Control': 'no-store' })
  }
}

/** GET /room/status?code=…: whether the lobby should offer to join. */
export function roomStatusHandler(registry: InstantRoomRegistry, allowedOrigins: string[]): Handler {
  const limiter = new RateLimiter(60, 120)
  return (req, res) => {
    if (!guardApiRequest(req, res, { allowedOrigins, methods: 'GET', limiter })) return
    if (req.method !== 'GET') {
      sendText(res, 405, 'method not allowed')
      return
    }

    const code = new URL(req.url ?? '/', 'http://localhost').searchParams.get('code')
    if (!isMeetCode(code)) {
      sendError(res, 400, 'INVALID_CODE', 'invalid room code')
      return
    }

    // Only a room that has clearly ended is reported as such. Unknown and
    // not-yet-joined codes are "open": the join itself is the real check.
    const body: RoomStatusResult =
      registry.allowActive(code) === 'expired'
        ? { status: 'ended', message: 'This room is no longer active.' }
        : { status: 'open' }
    sendJson(res, 200, body)
  }
}
