import type { JoinData, JoinedData, PeerJoinedData, PeerLeftData, SfuTracksData } from '@rendezvu/protocol'
import { log } from '../log.ts'
import type { Peer } from './peer.ts'
import { Room } from './room.ts'

/** Every room with someone in it. The only place rooms are created and deleted. */
export class Hub {
  private readonly rooms = new Map<string, Room>()
  private readonly onRoomEmpty: (roomId: string) => void
  private readonly onPeerLeave: (peerId: string) => void

  /**
   * `onPeerLeave` runs whenever a peer leaves a room, for any reason, so
   * per-peer state elsewhere (SFU sessions) can't outlive the peer.
   */
  constructor(onRoomEmpty: (roomId: string) => void, onPeerLeave: (peerId: string) => void) {
    this.onRoomEmpty = onRoomEmpty
    this.onPeerLeave = onPeerLeave
  }

  /** Whether this peer is connected and in this room right now. */
  isInRoom(peerId: string, roomId: string): boolean {
    return this.rooms.get(roomId)?.has(peerId) ?? false
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

    // joined first: the newcomer has the room list before anyone reacts to them,
    // and knows whose tile each replayed track set belongs to.
    peer.send({ type: 'joined', room: roomId, data: { peers: existing } satisfies JoinedData })
    // sfu-tracks is an event; without this replay a late joiner would never
    // learn about tracks published before it arrived.
    const sets = room.trackSets()
    for (const [ownerId, data] of sets) {
      peer.send({ type: 'sfu-tracks', room: roomId, from: ownerId, data })
    }
    if (sets.length > 0) log('sfu_replay', { room: roomId, peer: peer.id, sets: sets.length })
    room.broadcastExcept(peer.id, {
      type: 'peer-joined',
      room: roomId,
      from: peer.id,
      data: { peerId: peer.id, name: peer.name, audio: peer.audio, video: peer.video } satisfies PeerJoinedData,
    })
  }

  /**
   * A peer's full confirmed track set, already validated as its own publish
   * session. Stored for later joiners and sent to everyone else. An empty set
   * withdraws that session, and is only sent if it changed something.
   */
  announceTracks(peer: Peer, data: SfuTracksData): void {
    const roomId = peer.roomId
    const room = roomId ? this.rooms.get(roomId) : undefined
    if (!roomId || !room) return

    if (data.tracks.length === 0) {
      if (!room.withdrawTracks(peer.id, data.sessionId)) return
      log('sfu_tracks_withdrawn', { room: roomId, peer: peer.id, session: data.sessionId })
    } else {
      room.setTracks(peer.id, data)
      log('sfu_tracks', {
        room: roomId,
        peer: peer.id,
        session: data.sessionId,
        tracks: data.tracks.length,
        receivers: room.othersThan(peer.id),
      })
    }
    room.broadcastExcept(peer.id, { type: 'sfu-tracks', room: roomId, from: peer.id, data })
  }

  /** Used by `leave`, by socket close, and by join. Safe to call when not in a room. */
  leave(peer: Peer): void {
    const roomId = peer.roomId
    if (!roomId) return
    peer.roomId = null

    const room = this.rooms.get(roomId)
    if (!room) return
    room.remove(peer.id)
    // No separate track message: peer-left already tells everyone to drop this peer's pulls.
    room.removeTracks(peer.id)
    log('leave', { peer: peer.id, room: roomId })
    this.onPeerLeave(peer.id)

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
