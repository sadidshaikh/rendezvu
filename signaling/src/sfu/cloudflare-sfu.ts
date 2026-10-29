import { isObject } from '../json.ts'

const BASE_URL = 'https://rtc.live.cloudflare.com/v1/apps'
// Every Cloudflare call is bounded. A slow answer usually arrives in 1-2 s.
const TIMEOUT_MS = 15_000

/** The session sub-paths the browser may reach, all forwarded as they are. */
export type SfuSubPath = 'tracks/new' | 'renegotiate' | 'tracks/update' | 'tracks/close'

export interface SfuResponse {
  status: number
  /** Cloudflare's raw body: JSON, or empty. */
  body: string
}

/**
 * Cloudflare refused or failed. Keeps the status and the raw body, because
 * the route forwards that body to the browser unchanged: partytracks reads
 * `errorCode` from it to decide whether to recreate the session.
 */
export class SfuUpstreamError extends Error {
  readonly status: number
  readonly body: string

  constructor(status: number, body: string, message: string) {
    super(message)
    this.status = status
    this.body = body
  }
}

/**
 * Talks to Cloudflare's Realtime SFU API with the app token. Knows nothing
 * about rooms, peers or HTTP routes. The token never leaves the server, and
 * nothing here logs it or the SDP (long, and full of IP addresses).
 */
export class CloudflareSfuClient {
  private readonly appId: string
  private readonly appToken: string

  constructor(appId: string, appToken: string) {
    this.appId = appId
    this.appToken = appToken
  }

  /** Creates an empty session; Cloudflare closes it if no connection arrives. */
  async createSession(signal?: AbortSignal): Promise<string> {
    const res = await this.request('POST', 'sessions/new', undefined, signal)
    const sessionId = parseObject(res.body)?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new SfuUpstreamError(res.status, res.body, 'cf sfu: sessions/new returned no sessionId')
    }
    return sessionId
  }

  /** Sends the browser's JSON to one of the session's sub-paths and returns Cloudflare's answer. */
  forward(method: 'POST' | 'PUT', sessionId: string, subPath: SfuSubPath, body: unknown, signal?: AbortSignal): Promise<SfuResponse> {
    return this.request(method, `sessions/${encodeURIComponent(sessionId)}/${subPath}`, body, signal)
  }

  private async request(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<SfuResponse> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const res = await fetch(`${BASE_URL}/${encodeURIComponent(this.appId)}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.appToken}`,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      // A followed redirect would surface to partytracks as status 0, which
      // it handles by reloading the page. Treat one as an error instead.
      redirect: 'manual',
    })
    const text = await res.text()
    const route = path.replace(/^sessions\/[^/]+\//, '')
    if (res.status >= 300) {
      throw new SfuUpstreamError(res.status, text, `cf sfu: ${route} ${res.status} ${text.slice(0, 300)}`)
    }
    // Cloudflare can report a failure inside a 2xx body (renegotiate does).
    // Raised like any other error so it is logged; the body still goes to
    // the browser unchanged.
    const errorCode = parseObject(text)?.errorCode
    if (typeof errorCode === 'string' && errorCode !== '') {
      throw new SfuUpstreamError(res.status, text, `cf sfu: ${route} ${errorCode} ${text.slice(0, 300)}`)
    }
    return { status: res.status, body: text }
  }
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return isObject(value) ? value : null
  } catch {
    return null
  }
}
