import { WebSocket } from 'ws'
import type { Envelope, PeerInfo } from '@rendezvu/protocol'

/** One WebSocket connection: a participant, whether or not they're in a room yet. */
export class Peer {
  readonly id: string
  readonly socket: WebSocket
  /** The room this peer is in, or null before join and after leave. */
  roomId: string | null = null
  name = ''
  audio = false
  video = false

  constructor(id: string, socket: WebSocket) {
    this.id = id
    this.socket = socket
  }

  info(): PeerInfo {
    return { id: this.id, name: this.name, audio: this.audio, video: this.video }
  }

  send(env: Envelope): void {
    this.sendRaw(JSON.stringify(env))
  }

  /** For broadcasts, which serialize once and send the same string to everyone. */
  sendRaw(payload: string): void {
    if (this.socket.readyState !== WebSocket.OPEN) return
    // A write can still fail if the peer vanished a moment ago. That must never
    // stop the caller, which is often looping over a whole room.
    this.socket.send(payload, (err) => {
      if (err) this.socket.terminate()
    })
  }
}
