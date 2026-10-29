import type { Envelope, PeerInfo } from '@rendezvu/protocol'
import type { Peer } from './peer.ts'

/** The people currently connected to one meeting code. Created and deleted only by the Hub. */
export class Room {
  readonly id: string
  private readonly members = new Map<string, Peer>()

  constructor(id: string) {
    this.id = id
  }

  add(peer: Peer): void {
    this.members.set(peer.id, peer)
  }

  remove(peerId: string): void {
    this.members.delete(peerId)
  }

  has(peerId: string): boolean {
    return this.members.has(peerId)
  }

  isEmpty(): boolean {
    return this.members.size === 0
  }

  peerInfos(): PeerInfo[] {
    return [...this.members.values()].map((p) => p.info())
  }

  broadcastExcept(exceptId: string, env: Envelope): void {
    const payload = JSON.stringify(env)
    for (const peer of this.members.values()) {
      if (peer.id !== exceptId) peer.sendRaw(payload)
    }
  }
}
