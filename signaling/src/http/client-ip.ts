import type { IncomingMessage } from 'node:http'

// The one header our hosting platform sets, overwriting whatever a client
// sent: `fly-client-ip` on Fly, `cf-connecting-ip` behind Cloudflare. Null
// means no proxy in front (development): the socket address is the truth.
let trustedHeader: string | null = null

/** Set once at startup from TRUSTED_IP_HEADER. */
export function setTrustedIpHeader(name: string | null): void {
  trustedHeader = name ? name.toLowerCase() : null
}

/**
 * The caller's address, for rate limits and the per-IP socket cap. Only the
 * configured header is believed: a client can send X-Forwarded-For itself,
 * and trusting it would give a script a fresh rate-limit bucket per request.
 */
export function clientIp(req: IncomingMessage): string {
  if (trustedHeader) {
    const value = header(req, trustedHeader)?.split(',')[0]?.trim()
    if (value) return value
  }
  return req.socket.remoteAddress ?? 'unknown'
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}
