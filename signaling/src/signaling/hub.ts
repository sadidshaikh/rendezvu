import type {
  JoinData,
  JoinedData,
  KnockRequestData,
  KnockResolvedData,
  PeerJoinedData,
  PeerLeftData,
  PeerStateData,
  RoomSnapshotData,
  SfuTracksData,
} from '@rendezvu/protocol'
import { log } from '../log.ts'
import type { Peer } from './peer.ts'
import { Room } from './room.ts'

// How often a room with publishers gets the whole picture again. Fixes anything
// a dropped best-effort message or a missed event left wrong, within 15 s.
const SNAPSHOT_EVERY_MS = 15_000
// Beyond this many guests waiting in one room, the next knock is refused.
const MAX_WAITING = 20
// A tab that was denied can ask again after this long; sooner, it's denied again.
const DENIED_COOLDOWN_MS = 10_000

export type KnockResult = 'waiting' | 'denied' | 'queue-full'

/**
 * Why a peer left its room, which decides what happens to its SFU sessions:
 * - `leave`: it said so (the leave message, or joining another room). Drop them now.
 * - `disconnect`: its socket closed without saying. It may be back in a moment.
 * - `replaced`: the same tab reconnected and took its place. The sessions carry on.
 * - `rejoin`: the same connection joined the same room again.
 */
export type LeaveReason = 'leave' | 'disconnect' | 'replaced' | 'rejoin'

export interface HubEvents {
  onRoomEmpty: (roomId: string) => void
  /** Runs whenever a peer leaves a room, for any reason, so per-peer state elsewhere can follow. */
  onPeerLeave: (peer: Peer, reason: LeaveReason) => void
  /** Runs once a peer is in its room. */
  onPeerJoin: (peer: Peer, roomId: string) => void
}

/** Every room with someone in it. The only place rooms are created and deleted. */
export class Hub {
  private readonly rooms = new Map<string, Room>()
  private readonly events: HubEvents
  private snapshotTimer: ReturnType<typeof setInterval> | null = null
  // `${roomId}|${presenceId}` → when that tab was last denied.
  private readonly deniedAt = new Map<string, number>()

  constructor(events: HubEvents) {
    this.events = events
  }

  /** One timer for the whole server, not one per room. */
  startSnapshots(): void {
    if (this.snapshotTimer) return
    this.snapshotTimer = setInterval(() => this.broadcastSnapshots(), SNAPSHOT_EVERY_MS)
    this.snapshotTimer.unref()
  }

  stopSnapshots(): void {
    if (this.snapshotTimer) clearInterval(this.snapshotTimer)
    this.snapshotTimer = null
  }

  /** Whether this connection is a member of this room right now. */
  isPeerInRoom(peerId: string, roomId: string): boolean {
    return this.rooms.get(roomId)?.has(peerId) ?? false
  }

  /** Whether some connection from this browser tab is in this room right now. */
  isPresenceInRoom(presenceId: string, roomId: string): boolean {
    return this.rooms.get(roomId)?.findByPresence(presenceId) !== undefined
  }

  /** Callers have already checked that `roomId` may be joined. */
  join(peer: Peer, roomId: string, data: JoinData & { presenceId: string }): void {
    // Leave whatever room this connection was in first, so the people there
    // see peer-left instead of a ghost. Rejoining a room is the same
    // operation: everyone sees a clean leave and join.
    this.leave(peer, peer.roomId === roomId ? 'rejoin' : 'leave')
    // Waiting somewhere (or here, and now joining with a token): not any more.
    this.leaveWaiting(peer)

    peer.presenceId = data.presenceId
    peer.name = data.name
    peer.audio = data.audio
    peer.video = data.video
    // A share can't be running before you join.
    peer.screenSharing = false

    let room = this.rooms.get(roomId)
    if (!room) {
      room = new Room(roomId)
      this.rooms.set(roomId, room)
    }

    // The same tab is still here on its old connection: that one went quiet
    // without closing (Wi-Fi gone, lid closed) and the browser gave up on it
    // first. Done before the `existing` list, so the newcomer never sees it.
    const old = room.findByPresence(peer.presenceId)
    if (old) this.replace(room, old, peer)

    // Taken before adding, so the joiner never sees themselves.
    const existing = room.peerInfos()
    room.add(peer)
    peer.roomId = roomId
    log('join', { peer: peer.id, room: roomId, peers: existing.length + 1 })
    this.events.onPeerJoin(peer, roomId)

    // joined first: the newcomer has the room list before anyone reacts to them,
    // and knows whose tile each replayed track set belongs to.
    peer.send({ type: 'joined', room: roomId, data: { peers: existing } satisfies JoinedData })
    // sfu-tracks is an event; without this replay a late joiner would never
    // learn about tracks published before it arrived. No version: the snapshot
    // right after carries it.
    const sets = room.trackSets()
    for (const [ownerId, data] of sets) {
      peer.send({ type: 'sfu-tracks', room: roomId, from: ownerId, data })
    }
    if (sets.length > 0) log('sfu_replay', { room: roomId, peer: peer.id, sets: sets.length })
    this.sendSnapshot(peer)
    room.broadcastExcept(peer.id, {
      type: 'peer-joined',
      room: roomId,
      from: peer.id,
      data: {
        peerId: peer.id,
        name: peer.name,
        audio: peer.audio,
        video: peer.video,
        screenSharing: peer.screenSharing,
      } satisfies PeerJoinedData,
    })
    // The knock broadcast went out before this member was here.
    for (const guest of room.waiting()) {
      peer.send({ type: 'knock-request', room: roomId, from: guest.id, data: knockRequestOf(guest) })
    }
  }

  /**
   * A join without a valid token: the guest goes on the room's waiting list
   * and every member is asked. The guest learns nothing about the room.
   * Callers have already checked that the code may be joined.
   */
  knock(peer: Peer, roomId: string, data: JoinData & { presenceId: string }, now = Date.now()): KnockResult {
    this.leave(peer, 'leave')
    this.leaveWaiting(peer)
    peer.presenceId = data.presenceId
    peer.name = data.name
    peer.audio = data.audio
    peer.video = data.video
    peer.screenSharing = false

    for (const [key, at] of this.deniedAt) if (now - at >= DENIED_COOLDOWN_MS) this.deniedAt.delete(key)
    const deniedKey = `${roomId}|${data.presenceId}`
    const denied = this.deniedAt.get(deniedKey)
    if (denied !== undefined && now - denied < DENIED_COOLDOWN_MS) {
      peer.send({ type: 'knock-denied', room: roomId })
      return 'denied'
    }
    this.deniedAt.delete(deniedKey)

    let room = this.rooms.get(roomId)
    if (!room) {
      room = new Room(roomId)
      this.rooms.set(roomId, room)
    }
    // The same tab knocking again on a new connection: one entry, not two.
    const old = room.findWaitingByPresence(data.presenceId)
    if (old) {
      this.leaveWaiting(old)
      old.socket.close(1000, 'replaced by reconnect')
    }
    if (room.waiting().length >= MAX_WAITING) {
      if (room.isUnused()) this.rooms.delete(roomId)
      return 'queue-full'
    }

    room.addWaiting(peer)
    peer.waitingIn = roomId
    log('knock', { room: roomId, peer: peer.id, presence: data.presenceId.slice(0, 8) })
    peer.send({ type: 'knock-pending', room: roomId })
    room.broadcast({ type: 'knock-request', room: roomId, from: peer.id, data: knockRequestOf(peer) })
    return 'waiting'
  }

  /**
   * A member answered a knock. Returns the guest, taken off the waiting list,
   * or null if `member` isn't in a room where `guestId` is waiting. The
   * caller admits the guest (token, then join) or tells it no.
   */
  answerKnock(member: Peer, guestId: string, admitted: boolean, now = Date.now()): Peer | null {
    const roomId = member.roomId
    const room = roomId ? this.rooms.get(roomId) : undefined
    const guest = room?.getWaiting(guestId)
    if (!roomId || !room || !guest) return null
    room.removeWaiting(guest.id)
    guest.waitingIn = null
    if (!admitted) this.deniedAt.set(`${roomId}|${guest.presenceId}`, now)
    log(admitted ? 'knock_admitted' : 'knock_denied', { room: roomId, guest: guest.id, by: member.id })
    this.resolveKnock(room, guest.id, admitted ? 'admitted' : 'denied')
    return guest
  }

  /** A waiting guest stopped waiting: its socket closed, it left, or it joined. Safe to call when not waiting. */
  leaveWaiting(peer: Peer): void {
    const roomId = peer.waitingIn
    if (!roomId) return
    peer.waitingIn = null
    const room = this.rooms.get(roomId)
    if (!room || !room.removeWaiting(peer.id)) return
    this.resolveKnock(room, peer.id, 'left')
    if (room.isUnused()) this.rooms.delete(roomId)
  }

  private resolveKnock(room: Room, peerId: string, outcome: KnockResolvedData['outcome']): void {
    room.broadcast({ type: 'knock-resolved', room: room.id, data: { peerId, outcome } satisfies KnockResolvedData })
  }

  /**
   * The whole room, to one member. Critical: it's the answer to `sync`, which
   * a client sends because it knows it may have missed something.
   */
  sendSnapshot(peer: Peer): void {
    const roomId = peer.roomId
    const room = roomId ? this.rooms.get(roomId) : undefined
    if (!roomId || !room) return
    peer.send({ type: 'room-snapshot', room: roomId, data: room.snapshot() satisfies RoomSnapshotData })
  }

  /**
   * A peer's full confirmed track set, already validated as its own publish
   * session. Stored for later joiners and sent to everyone else with the
   * version it landed at. An empty set withdraws that session, and is only
   * sent if it changed something.
   */
  announceTracks(peer: Peer, data: SfuTracksData): void {
    const roomId = peer.roomId
    const room = roomId ? this.rooms.get(roomId) : undefined
    if (!roomId || !room) return

    let version: number
    if (data.tracks.length === 0) {
      const v = room.withdrawTracks(peer.id, data.sessionId)
      if (v === null) return
      version = v
      log('sfu_tracks_withdrawn', { room: roomId, peer: peer.id, session: data.sessionId, version })
    } else {
      version = room.setTracks(peer.id, data)
      log('sfu_tracks', {
        room: roomId,
        peer: peer.id,
        session: data.sessionId,
        tracks: data.tracks.length,
        receivers: room.othersThan(peer.id),
        version,
      })
    }
    room.broadcastExcept(peer.id, {
      type: 'sfu-tracks',
      room: roomId,
      from: peer.id,
      data: { ...data, version } satisfies SfuTracksData,
    })
  }

  /**
   * A peer's full mic, camera and share state. Stored so `joined` and
   * `peer-joined` carry it to later joiners; `speaking` is passed on but not
   * stored, since it's stale a second later.
   */
  updateState(peer: Peer, state: PeerStateData): void {
    const roomId = peer.roomId
    const room = roomId ? this.rooms.get(roomId) : undefined
    if (!roomId || !room) return

    const changed =
      peer.audio !== state.audio || peer.video !== state.video || peer.screenSharing !== state.screenSharing
    peer.audio = state.audio
    peer.video = state.video
    peer.screenSharing = state.screenSharing
    // Speaking-only changes would be most of the log.
    if (changed) {
      log('peer_state', {
        room: roomId,
        peer: peer.id,
        audio: state.audio,
        video: state.video,
        screen: state.screenSharing,
      })
    }
    room.broadcastExceptBestEffort(peer.id, { type: 'peer-state', room: roomId, from: peer.id, data: state })
  }

  /** Used by `leave`, by socket close, and by join. Safe to call when not in a room. */
  leave(peer: Peer, reason: LeaveReason): void {
    const roomId = peer.roomId
    if (!roomId) return
    peer.roomId = null

    const room = this.rooms.get(roomId)
    if (!room) return
    room.remove(peer.id)
    // No separate track message: peer-left already tells everyone to drop this peer's pulls.
    room.removeTracks(peer.id)
    log('leave', { peer: peer.id, room: roomId, reason })
    this.events.onPeerLeave(peer, reason)

    if (room.isEmpty()) {
      // Guests may still be waiting: they keep the Hub's room, not the meeting's clock.
      if (room.isUnused()) this.rooms.delete(roomId)
      this.events.onRoomEmpty(roomId)
      return
    }
    room.broadcastExcept(peer.id, {
      type: 'peer-left',
      room: roomId,
      from: peer.id,
      data: { peerId: peer.id } satisfies PeerLeftData,
    })
  }

  /**
   * Takes `old` out of the room for `next`, the same tab on a new connection.
   * The room never empties here, since `next` is about to join it.
   */
  private replace(room: Room, old: Peer, next: Peer): void {
    room.remove(old.id)
    room.removeTracks(old.id)
    // Its socket closing later must not leave anything or start a session grace.
    old.roomId = null
    log('peer_replaced', { room: room.id, old: old.id, new: next.id })
    this.events.onPeerLeave(old, 'replaced')
    // `next` isn't a member yet, so this reaches everyone except old and new.
    room.broadcastExcept(next.id, {
      type: 'peer-left',
      room: room.id,
      from: old.id,
      data: { peerId: old.id } satisfies PeerLeftData,
    })
    old.socket.close(1000, 'replaced by reconnect')
  }

  /**
   * Best effort: a newer snapshot replaces this one in 15 s. Rooms where nobody
   * publishes stay quiet, since join and leave already keep their roster right.
   */
  private broadcastSnapshots(): void {
    for (const room of this.rooms.values()) {
      if (!room.hasPublishers()) continue
      room.broadcastBestEffort({ type: 'room-snapshot', room: room.id, data: room.snapshot() })
    }
  }
}

function knockRequestOf(guest: Peer): KnockRequestData {
  return { peerId: guest.id, name: guest.name }
}
