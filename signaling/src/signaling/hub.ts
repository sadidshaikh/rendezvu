import type { JoinData, JoinedData, PeerJoinedData, PeerLeftData } from '@rendezvu/protocol'
import { log } from '../log.ts'
import type { Peer } from './peer.ts'
import { Room } from './room.ts'

/** Every room with someone in it. The only place rooms are created and deleted. */
export class Hub {
  private readonly rooms = new Map<string, Room>()
  private readonly onRoomEmpty: (roomId: string) => void

  constructor(onRoomEmpty: (roomId: string) => void) {
    this.onRoomEmpty = onRoomEmpty
  }

  /** Callers have already checked that `roomId` may be joined. */
  join(peer: Peer, roomId: string, data: JoinData): void {
    // Leave whatever room this connection was in first, so the people there
    // see peer-left instead of a ghost. Rejoining the same room is the same
    // operation: everyone sees a clean leave and join.
    this.leave(peer)

    peer.name = data.name
    peer.audio = data.audio
    peer.video = data.video

    let room = this.rooms.get(roomId)
    if (!room) {
      room = new Room(roomId)
      this.rooms.set(roomId, room)
    }

    // Snapshot before adding, so the joiner never sees themselves.
    const existing = room.peerInfos()
    room.add(peer)
    peer.roomId = roomId
    log('join', { peer: peer.id, room: roomId, peers: existing.length + 1 })

    // joined first: the newcomer has the room list before anyone reacts to them.
    peer.send({ type: 'joined', room: roomId, data: { peers: existing } satisfies JoinedData })
    room.broadcastExcept(peer.id, {
      type: 'peer-joined',
      room: roomId,
      from: peer.id,
      data: { peerId: peer.id, name: peer.name, audio: peer.audio, video: peer.video } satisfies PeerJoinedData,
    })
  }

  /** Used by `leave`, by socket close, and by join. Safe to call when not in a room. */
  leave(peer: Peer): void {
    const roomId = peer.roomId
    if (!roomId) return
    peer.roomId = null

    const room = this.rooms.get(roomId)
    if (!room) return
    room.remove(peer.id)
    log('leave', { peer: peer.id, room: roomId })

    if (room.isEmpty()) {
      this.rooms.delete(roomId)
      this.onRoomEmpty(roomId)
      return
    }
    room.broadcastExcept(peer.id, {
      type: 'peer-left',
      room: roomId,
      from: peer.id,
      data: { peerId: peer.id } satisfies PeerLeftData,
    })
  }
}
