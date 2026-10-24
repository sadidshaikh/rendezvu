import type { IncomingMessage } from 'node:http'

/**
 * The caller's address. Behind a hosting platform every request arrives from
 * the platform's proxy, so the forwarding headers come first; without them
 * every user would share the proxy's IP (and one rate-limit bucket).
 */
export function clientIp(req: IncomingMessage): string {
  for (const name of ['cf-connecting-ip', 'x-real-ip']) {
    const value = header(req, name)?.trim()
    if (value) return value
  }
  const first = header(req, 'x-forwarded-for')?.split(',')[0]?.trim()
  if (first) return first
  return req.socket.remoteAddress ?? 'unknown'
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}
