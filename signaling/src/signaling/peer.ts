import { WebSocket } from 'ws'
import type { Envelope, PeerInfo } from '@rendezvu/protocol'
import { log } from '../log.ts'

// Messages waiting to be written to one connection. A healthy socket never gets
// near this; a phone on a bad network does, and without a limit the server
// would hold everything for it until the idle timeout.
const MAX_QUEUED = 32
// How long a critical message waits for room in a full queue before it's dropped.
const CRITICAL_WAIT_MS = 2_000
// One write not finishing for this long means the other end is gone.
const WRITE_TIMEOUT_MS = 10_000

/** One WebSocket connection: a participant, whether or not they're in a room yet. */
export class Peer {
  readonly id: string
  readonly socket: WebSocket
  /**
   * The browser tab behind this connection, the same across its reconnects.
   * Set on join; until then, and for clients that don't send one, it's the
   * peer id. Never sent to anyone else.
   */
  presenceId: string
  /**
   * The room this peer is asking to join, while it waits to be let in. A
   * waiting peer has no `roomId`, so every member-only message from it is ignored.
   */
  waitingIn: string | null = null
  /** The room this peer is in, or null before join and after leave. */
  roomId: string | null = null
  name = ''
  audio = false
  video = false
  screenSharing = false
  /** When this connection's last stats-report was accepted. */
  lastStatsReportAt = 0

  private readonly queue: string[] = []
  // Critical messages waiting for room in a full queue, oldest first. Each one
  // takes the next free slot, so messages still go out in the order sent.
  private readonly waiting: Array<() => void> = []
  private writing = false

  constructor(id: string, socket: WebSocket) {
    this.id = id
    this.presenceId = id
    this.socket = socket
    socket.once('close', () => {
      this.queue.length = 0
      // Let the waiters go now rather than time out and log a slow receiver.
      for (const take of this.waiting.splice(0)) take()
    })
  }

  info(): PeerInfo {
    return { id: this.id, name: this.name, audio: this.audio, video: this.video, screenSharing: this.screenSharing }
  }

  /** Critical: waits up to 2 s for room in the queue. Resolves once queued or dropped. */
  send(env: Envelope): Promise<void> {
    return this.sendRaw(JSON.stringify(env), env.type)
  }

  /** For broadcasts, which serialize once and send the same string to everyone. */
  sendRaw(payload: string, type: string): Promise<void> {
    if (!this.isOpen()) return Promise.resolve()
    if (this.waiting.length === 0 && this.queue.length < MAX_QUEUED) {
      this.enqueue(payload)
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const take = () => {
        clearTimeout(timer)
        this.enqueue(payload)
        resolve()
      }
      const timer = setTimeout(() => {
        this.waiting.splice(this.waiting.indexOf(take), 1)
        log('signaling_send_timeout', { peer: this.id, type })
        resolve()
      }, CRITICAL_WAIT_MS)
      this.waiting.push(take)
    })
  }

  /** Best effort: dropped at once if the queue is full. The next one replaces it anyway. */
  sendBestEffortRaw(payload: string): void {
    if (!this.isOpen() || this.waiting.length > 0 || this.queue.length >= MAX_QUEUED) return
    this.enqueue(payload)
  }

  private isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN
  }

  private enqueue(payload: string): void {
    if (!this.isOpen()) return
    this.queue.push(payload)
    if (!this.writing) void this.drain()
  }

  /** Writes one message at a time, so the queue holds what this receiver hasn't taken yet. */
  private async drain(): Promise<void> {
    this.writing = true
    while (this.queue.length > 0 && this.isOpen()) {
      const payload = this.queue.shift()!
      // A slot just freed up.
      this.waiting.shift()?.()
      if (!(await this.write(payload))) break
    }
    this.writing = false
  }

  /** Whether the write finished. The callback fires once the data reaches the OS, so a slow receiver delays it. */
  private write(payload: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        log('signaling_write_timeout', { peer: this.id })
        // The normal close path then runs leave.
        this.socket.terminate()
        resolve(false)
      }, WRITE_TIMEOUT_MS)
      // A write can still fail if the peer vanished a moment ago.
      this.socket.send(payload, (err) => {
        clearTimeout(timer)
        if (err) this.socket.terminate()
        resolve(!err)
      })
    })
  }
}
