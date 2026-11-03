import { createHmac, timingSafeEqual } from 'node:crypto'
import { isObject } from '../json.ts'
import { isMeetCode } from '../meets/meet-code.ts'

export type RoomRole = 'host' | 'guest'

/** What a valid token says. Guests carry the presence id they were admitted with. */
export interface RoomTokenClaims {
  room: string
  role: RoomRole
  sub?: string
  iat: number
  exp: number
}

// Allows for a browser whose clock runs a little fast or slow.
const CLOCK_SKEW_S = 30
// Far longer than any token we issue; a longer one is junk.
const MAX_TOKEN_LENGTH = 2048
const HEADER = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))

/**
 * A JWT signed with HS256: header.payload.signature, each base64url. The same
 * format Spring Boot will issue in Phase 16, so only the issuer changes.
 */
export function signRoomToken(
  secret: string,
  claims: { room: string; role: RoomRole; sub?: string },
  ttlMs: number,
  now = Date.now(),
): string {
  const iat = Math.floor(now / 1000)
  const payload = base64url(JSON.stringify({ ...claims, iat, exp: iat + Math.floor(ttlMs / 1000) }))
  return `${HEADER}.${payload}.${sign(secret, `${HEADER}.${payload}`)}`
}

/** The claims, or null for anything malformed, wrongly signed, expired or not about a room. */
export function verifyRoomToken(secret: string, token: unknown, now = Date.now()): RoomTokenClaims | null {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, payload, signature] = parts as [string, string, string]

  // Exactly HS256. Accepting the header's own choice is how "alg: none" tokens get in.
  const head = parseJson(header)
  if (!isObject(head) || head.alg !== 'HS256') return null

  const expected = Buffer.from(sign(secret, `${header}.${payload}`))
  const given = Buffer.from(signature)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null

  const body = parseJson(payload)
  if (!isObject(body)) return null
  const { room, role, sub, iat, exp } = body
  if (typeof room !== 'string' || !isMeetCode(room)) return null
  if (role !== 'host' && role !== 'guest') return null
  if (typeof iat !== 'number' || typeof exp !== 'number') return null
  if (exp + CLOCK_SKEW_S < Math.floor(now / 1000)) return null
  if (sub !== undefined && typeof sub !== 'string') return null
  if (role === 'guest' && !sub) return null
  return { room, role, iat, exp, ...(sub ? { sub } : {}) }
}

function sign(secret: string, input: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url')
}

function base64url(text: string): string {
  return Buffer.from(text).toString('base64url')
}

function parseJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}
