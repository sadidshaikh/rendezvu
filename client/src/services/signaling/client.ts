import type { Envelope, MsgType } from '@rendezvu/protocol'

export type ConnState = 'connecting' | 'connected' | 'disconnected'

type Handler = (env: Envelope) => void

// The server closes sockets that send nothing for 60 s, so a quiet but
// healthy connection pings well inside that window.
const PING_MS = 15_000

/**
 * Owns the one WebSocket a participant keeps open for the whole call.
 * Components subscribe to message types with on()/off() and never touch the
 * socket directly. The connection counts as established only after the
 * server's `welcome`, which carries this connection's peer id.
 */
export class SignalingClient {
  private ws: WebSocket | null = null
  private handlers = new Map<MsgType, Set<Handler>>()
  private peerId: string | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private readonly url: string

  onStateChange?: (state: ConnState) => void

  constructor(url: string) {
    this.url = url
  }

  connect(): void {
    if (this.disposed) return
    const ws = new WebSocket(this.url)
    this.ws = ws
    this.onStateChange?.('connecting')

    ws.onopen = () => this.startHeartbeat()

    ws.onmessage = (ev) => {
      let env: Envelope
      try {
        env = JSON.parse(ev.data as string) as Envelope
      } catch (err) {
        console.error('signaling: bad message', err)
        return
      }
      if (env.type === 'pong') return
      if (env.type === 'welcome') {
        this.peerId = env.from ?? null
        if (!this.peerId) {
          ws.close()
          return
        }
        this.onStateChange?.('connected')
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

    ws.onclose = () => {
      if (this.ws !== ws) return
      this.stopHeartbeat()
      this.ws = null
      this.peerId = null
      if (!this.disposed) this.onStateChange?.('disconnected')
    }
  }

  dispose(): void {
    this.disposed = true
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

  getPeerId(): string | null {
    return this.peerId
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.pingTimer = setInterval(() => this.send('ping'), PING_MS)
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }
}
