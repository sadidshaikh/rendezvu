import type { IceServer } from '@rendezvu/protocol'

const BASE_URL = 'https://rtc.live.cloudflare.com/v1'
// Enough of Cloudflare's error body to see why it refused, without flooding the log.
const MAX_ERROR_BODY_CHARS = 500

/**
 * Mints short-lived STUN/TURN credentials from a Cloudflare TURN key. Knows
 * nothing about rooms or routes. The key id and API token never leave the
 * server; only the generated username and credential go to browsers.
 */
export class CloudflareTurnClient {
  private readonly keyId: string
  private readonly apiToken: string

  constructor(keyId: string, apiToken: string) {
    this.keyId = keyId
    this.apiToken = apiToken
  }

  async generateIceServers(ttlSeconds: number, signal?: AbortSignal): Promise<IceServer[]> {
    const url = `${BASE_URL}/turn/keys/${encodeURIComponent(this.keyId)}/credentials/generate-ice-servers`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: ttlSeconds }),
      signal,
    })
    // Success is 201 Created. Anything 400+ is an error; the body says why.
    if (res.status >= 400) {
      const body = (await res.text()).slice(0, MAX_ERROR_BODY_CHARS)
      throw new Error(`cf turn: ${res.status} ${body}`)
    }
    return readIceServers(await res.json())
  }
}

/** Validates Cloudflare's `{ iceServers: [...] }` and drops what browsers can't use. */
function readIceServers(body: unknown): IceServer[] {
  const list = isObject(body) ? body.iceServers : undefined
  if (!Array.isArray(list)) throw new Error('cf turn: response has no iceServers array')

  const servers: IceServer[] = []
  for (const entry of list) {
    if (!isObject(entry)) continue
    // RTCIceServer allows a single string; keep our shape an array.
    const raw = typeof entry.urls === 'string' ? [entry.urls] : entry.urls
    if (!Array.isArray(raw)) continue
    const urls = raw.filter((u): u is string => typeof u === 'string' && !isPort53(u))
    if (urls.length === 0) continue

    const server: IceServer = { urls }
    if (typeof entry.username === 'string') server.username = entry.username
    if (typeof entry.credential === 'string') server.credential = entry.credential
    servers.push(server)
  }
  if (servers.length === 0) throw new Error('cf turn: response has no usable ICE servers')
  return servers
}

/**
 * Browsers block port 53, so these candidates only time out during gathering.
 * Cloudflare's docs recommend filtering them.
 * Matches `stun:stun.cloudflare.com:53` and `turn:turn.cloudflare.com:53?transport=udp`.
 */
function isPort53(url: string): boolean {
  return /:53(\?|$)/.test(url)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
