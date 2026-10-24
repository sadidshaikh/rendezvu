import type { IncomingMessage, ServerResponse } from 'node:http'
import { clientIp } from './client-ip.ts'
import type { RateLimiter } from './rate-limiter.ts'
import { sendText } from './respond.ts'

const DEFAULT_MAX_BODY_BYTES = 16 * 1024

export interface GuardOptions {
  allowedOrigins: string[]
  /** Methods the route accepts, e.g. "POST" or "GET, POST". Used for CORS. */
  methods: string
  limiter?: RateLimiter
  maxBodyBytes?: number
}

/**
 * Checks every JSON API request goes through, in order: CORS, preflight,
 * rate limit, body size. Returns false when it has already answered the
 * request, in which case the route must stop.
 */
export function guardApiRequest(req: IncomingMessage, res: ServerResponse, opts: GuardOptions): boolean {
  const origin = req.headers.origin
  if (origin) {
    if (!opts.allowedOrigins.includes(origin)) {
      sendText(res, 403, 'origin not allowed')
      return false
    }
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', `${opts.methods}, OPTIONS`)
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return false
  }

  if (opts.limiter) {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const decision = opts.limiter.take(`${path}|${clientIp(req)}`)
    if (!decision.allowed) {
      sendText(res, 429, 'rate limit exceeded', { 'Retry-After': String(decision.retryAfterSeconds) })
      return false
    }
  }

  const length = Number(req.headers['content-length'] ?? 0)
  if (length > (opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)) {
    sendText(res, 413, 'request body too large')
    return false
  }

  return true
}
