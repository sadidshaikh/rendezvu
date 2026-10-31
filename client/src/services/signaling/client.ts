import type { Envelope, MsgType } from '@rendezvu/protocol'

export type ConnState = 'connecting' | 'connected' | 'reconnecting'

type Handler = (env: Envelope) => void

// The server closes sockets that send nothing for 60 s, so a quiet but
// healthy connection pings well inside that window.
const PING_MS = 15_000
// A connection that died quietly (Wi-Fi gone, lid closed) doesn't close; it
// just stops answering. Two pings in a row without a pong means it's dead.
const MAX_MISSED_PONGS = 2
// A working connection that closes waits this long before the first attempt,
// which covers a server deploy closing sockets on purpose.
const GRACE_MS = 2_000
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 16_000
const PRESENCE_ID_KEY = 'rendezvu.presenceId'

/**
 * One id per browser tab, kept across reconnects in sessionStorage. Per tab,
 * not per browser, so two tabs in one room are still two people.
 */
function getOrCreatePresenceId(): string {
  try {
    const existing = sessionStorage.getItem(PRESENCE_ID_KEY)
    if (existing) return existing
    const id = crypto.randomUUID()
    sessionStorage.setItem(PRESENCE_ID_KEY, id)
    return id
  } catch {
    // Storage blocked: still unique, just not kept across a page reload.
    return crypto.randomUUID()
  }
}

/**
 * Owns the one WebSocket a participant keeps open for the whole call, and
 * reopens it whenever it drops, for as long as the call lasts. Components
 * subscribe to message types with on()/off() and never touch the socket.
 * A connection counts as established only after the server's `welcome`,
 * which carries this connection's peer id (a new one on every reconnect).
 */
export class SignalingClient {
  private ws: WebSocket | null = null
  private handlers = new Map<MsgType, Set<Handler>>()
  private peerId: string | null = null
  private readonly presenceId = getOrCreatePresenceId()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private missedPongs = 0
  private attempt = 0
  // Until the first welcome, failures are "still connecting", not a reconnect.
  private everConnected = false
  private disposed = false
  // Gives up on the current socket now, without waiting for its close event.
  private abandon: (() => void) | null = null
  private readonly url: string

  onStateChange?: (state: ConnState, attempt: number) => void
  /** A connection is back after a drop. The room has to be joined again. */
  onReconnected?: () => void

  constructor(url: string) {
    this.url = url
  }

  connect(): void {
    if (this.disposed) return
    const ws = new WebSocket(this.url)
    this.ws = ws
    let established = false
    if (this.attempt === 0) this.onStateChange?.('connecting', 0)

    ws.onopen = () => this.startHeartbeat()

    ws.onmessage = (ev) => {
      let env: Envelope
      try {
        env = JSON.parse(ev.data as string) as Envelope
      } catch (err) {
        console.error('signaling: bad message', err)
        return
      }
      if (env.type === 'pong') {
        this.missedPongs = 0
        return
      }
      if (env.type === 'welcome') {
        this.peerId = env.from ?? null
        if (!this.peerId) {
          ws.close()
          return
        }
        established = true
        const reconnected = this.everConnected
        this.everConnected = true
        this.attempt = 0
        this.onStateChange?.('connected', 0)
        if (reconnected) this.onReconnected?.()
      }
      this.handlers.get(env.type)?.forEach((handler) => {
        try {
          handler(env)
        } catch (err) {
          console.error(`signaling: ${env.type} handler failed`, err)
        }
      })
    }

    // onerror always fires before onclose, so onclose is the single exit path.
    ws.onerror = () => {}

    const closed = () => {
      if (this.ws !== ws) return
      this.abandon = null
      this.stopHeartbeat()
      this.ws = null
      this.peerId = null
      if (this.disposed) return
      if (established) {
        this.onStateChange?.('reconnecting', this.attempt)
        this.retryTimer = setTimeout(() => this.scheduleReconnect(), GRACE_MS)
      } else {
        this.scheduleReconnect()
      }
    }
    ws.onclose = closed
    this.abandon = () => {
      ws.close()
      closed()
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.stopHeartbeat()
    this.ws?.close()
    this.ws = null
    this.peerId = null
  }

  send<T>(type: MsgType, data?: T, extra?: Omit<Envelope, 'type' | 'data'>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const env: Envelope<T> = { type, ...extra, data }
    this.ws.send(JSON.stringify(env))
  }

  on<T>(type: MsgType, handler: (env: Envelope<T>) => void): void {
    let set = this.handlers.get(type)
    if (!set) {
      set = new Set()
      this.handlers.set(type, set)
    }
    set.add(handler as Handler)
  }

  off<T>(type: MsgType, handler: (env: Envelope<T>) => void): void {
    this.handlers.get(type)?.delete(handler as Handler)
  }

  /** This connection's id. Changes on every reconnect; null while disconnected. */
  getPeerId(): string | null {
    return this.peerId
  }

  /** This tab's id. The same across reconnects. */
  getPresenceId(): string {
    return this.presenceId
  }

  /**
   * About 1, 2, 4, 8, then 16 s, each randomised between half and all of it
   * so a server restart doesn't bring every browser back in one wave. No
   * limit: a phone moving from Wi-Fi to mobile data can need a minute.
   */
  private scheduleReconnect(): void {
    if (this.disposed) return
    const base = Math.min(BACKOFF_BASE_MS * 2 ** this.attempt, BACKOFF_MAX_MS)
    const delay = base * (0.5 + Math.random() * 0.5)
    this.attempt++
    this.onStateChange?.(this.everConnected ? 'reconnecting' : 'connecting', this.attempt)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.pingTimer = setInterval(() => {
      const ws = this.ws
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      if (this.missedPongs >= MAX_MISSED_PONGS) {
        // On a dead network the close event can take a minute to come, so
        // the reconnect starts now and the old socket's event is ignored.
        this.abandon?.()
        return
      }
      this.missedPongs++
      this.send('ping')
    }, PING_MS)
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    this.missedPongs = 0
  }
}
