# Phase 8: Signaling that survives disconnects

Status: **built**. Backend: Claude (on request) · Frontend: Claude

## Goal

The WebSocket can drop in the middle of a call: Wi-Fi blips, a phone switching to mobile data, a laptop lid closed for a moment, a server restart. When it does, the call carries on. A small "Connection interrupted. Trying to reconnect…" line appears, the browser reconnects on its own, and everyone ends up seeing and hearing everyone again. Nobody clicks Rejoin, and nobody sees the same person twice.

## Why this comes now

Every phase so far assumed that no message is ever lost. That holds on a laptop next to the router and breaks on real networks, especially phones. Today a dropped socket is the end of the call:

- `useSignaling` sets `client` to `null` when the socket closes. `useCall` takes that as "the call is over": it destroys the SFU session and stops publishing, even though the media connection to Cloudflare was fine.
- Nothing reconnects. The screen says "Lost connection to the server. Leave and rejoin to continue."
- Even with a reconnect, each `sfu-tracks` message is a one-time event. A person who missed one never pulls that publisher's media.

Phases 9 and 10 (media repair, quality) build on signaling that stays up, so this comes first.

## Concepts

**Signaling and media are separate pipes.** The WebSocket only carries small control messages: who is here, who publishes what, who is muted. Audio and video travel over separate connections straight to Cloudflare. When the WebSocket drops, those keep working: you still hear the others, and they still hear you. So the rule for a reconnect is to repair the control pipe and **leave the media alone**. Tearing down media to "start clean" turns a 2-second blip into a 10-second outage for everyone.

**Edge-triggered vs level-triggered.** This is the most important idea in the project.

| | Edge-triggered | Level-triggered |
|---|---|---|
| What's sent | What changed: "Alice joined", "Bob announced tracks" | The whole current state: "the room is Alice, Bob, Carol; Bob publishes these tracks" |
| Like | A doorbell: miss the ring and you never know someone came | Looking out the window: whenever you look, you see who's there |
| Missing one message | Wrong until the end of the call | Wrong until the next snapshot |

Everything so far is edges. They stay, because they're fast. Phase 8 adds the level: a **room snapshot** of everyone present and every stored track set. The server sends one after each join, on request (`sync`), and every 15 s to every room where someone publishes. The client treats a snapshot as the truth and corrects whatever it missed, without needing to know *which* message it missed.

**Making repeated messages harmless.** After a reconnect the client sends `join`, `peer-state` and `sfu-announce` again, and snapshots repeat the same state every 15 s. That's only safe if receiving the same thing twice changes nothing. Most of this is already true: `sfu-announce` replaces, never merges (Phase 5); `peer-state` is always the full state (Phase 6); the reconciler only pulls what's missing (Phase 5). Phase 8 adds the missing pieces: rejoining replaces your old entry, and snapshots replace the whole roster.

**Version numbers, so an old snapshot can't undo a newer change.** Snapshots and `sfu-tracks` can cross on the way:

```
server  v7 snapshot sent ──────────────┐
server  Bob announces → v8, sent ──┐   │
client  receives v8 (Bob's camera) ◄┘   │
client  receives v7 snapshot ◄──────────┘   (no Bob camera: would drop it)
```

Each room keeps a counter that goes up whenever its stored tracks change. `sfu-tracks` and snapshots carry it, and the client ignores anything older than the newest it has applied. Two exceptions:
- The replay on join carries **no** version. It sends stored sets in any order, and each one's stored version only says when *that* person last announced.
- After a reconnect the client resets its floor to 0. The room may have emptied and been recreated while it was away, and the new room's counter restarts at 1.

**presenceId: you, across reconnects.** Each connection gets a fresh peer id from the server. On its own, a reconnect therefore looks like a new person, while the old entry lingers until the server notices the dead socket (up to 60 s). That's the duplicate tile. So each browser tab makes a random `presenceId` once, keeps it in `sessionStorage`, and sends it with every `join`. Per tab and not per browser, so two tabs are still two people, as in testing. When a join arrives with a `presenceId` that's already in the room, the server removes the old entry first: the others get `peer-left` for the old id, then `peer-joined` for the new one.

**Who owns a Cloudflare session.** Every `/sfu` request is checked against the session's owner (Phase 4). The owner is currently the peer id, which a reconnect replaces. After a reconnect, renegotiating your own publish session, or pulling someone new, would be refused, and your re-announce would fail. So **the owner becomes the `presenceId`**, which survives the reconnect.

- The reference ties sessions to the signed-in user. Rendezvu has no sign-in until Phase 11, and `presenceId` is the stable identity it does have.
- It's also safer than the peer id. Everyone in a room sees everyone's peer id; nobody but the server ever sees your `presenceId`. The server must never send it to anyone else, or put it in full in a log.

**Noticing a dead connection: heartbeats.** A connection that died quietly (Wi-Fi gone, lid closed) doesn't close; it just goes silent. The client already pings every 15 s. Now it also counts answers: if two pings in a row get no `pong`, it closes the socket itself and reconnects. That's at most 45 s to notice, often less, because the browser closes the socket by itself when the network interface changes. The server keeps its 60 s idle timeout for the other direction.

**Reconnect timing: backoff with jitter.** Waits between attempts double, with a cap: about 1 s, 2 s, 4 s, 8 s, then 16 s each time. Each wait is randomised between half and the full value. After a server restart every browser reconnects at once; the randomness spreads them out instead of hitting the server in one wave. There's no limit on attempts: a phone moving from Wi-Fi to mobile data can need a minute, and the call shouldn't give up while the network is coming back. A connection that was working waits 2 s before its first attempt, which covers a server deploy closing sockets on purpose (Phase 1's `1001`).

**What the client does after reconnecting, in order:**

```
welcome (new peer id)
  → join {name, audio, video, presenceId}      server replaces the old entry
  → wait for joined                            the server ignores peer-state and refuses
                                               sfu-announce from someone not in the room
  → peer-state (full current state)
  → sfu-announce (current track set)           if publishing; the server dropped it with the old entry
  → sync                                       → room-snapshot: who's here, who publishes what
```

During this, the SFU session, the publish connection, and every pull stay as they are. Until the snapshot arrives, the reconciler pulls anything new it hears about, but **doesn't drop** anything. Its view of the room is half-rebuilt during the gap, and dropping on that basis would cut pulls that are still working.

---

## Backend requirements (you)

### 1. Shared types (`protocol/src/index.ts`)

```ts
// add to MsgType
| 'sync' | 'room-snapshot'

// JoinData gets
presenceId?: string

// SfuTracksData gets (server → client only; never on sfu-announce, never on the join replay)
version?: number

export interface RoomSnapshotPeerTracks {
  peerId: string
  sessionId: string
  tracks: SfuTrackInfo[]
}

/** server → client. The whole room: everyone present (including you) and every stored track set. */
export interface RoomSnapshotData {
  version: number
  peers: PeerInfo[]
  tracks: RoomSnapshotPeerTracks[]
}
```

I'll add these with the frontend, as before.

### 2. presenceId on join

- Read `presenceId` from `join` data. Accept 8–64 characters of `[A-Za-z0-9-]`. Anything else, or missing, means "use the peer id as the presence id". The rest of the server then works the same either way.
- Store it on `Peer`. It's never put in `PeerInfo`, `peer-joined`, snapshots or any other outgoing message.
- In `Hub.join`, before taking the `existing` snapshot: if another member of the room has the same `presenceId`, that's the same tab reconnecting.
  - Remove that old peer from the room and drop its stored tracks.
  - Set the old peer's `roomId` to `null`, so its socket closing later does nothing.
  - Send `peer-left` for the old id to everyone except the old and new peer.
  - Close the old socket with code `1000` and reason `replaced by reconnect`.
  - Log `peer_replaced room=… old=… new=…`.
- The `ws_join` log gets `presence=<first 8 characters>`. That's enough to follow one tab across reconnects, without writing a usable id to the log.

### 3. Cloudflare sessions belong to the presence

- `SfuSessionRegistry` records `presenceId` as the owner instead of `peerId`. Everything that used `peerId` for ownership changes to it: `register`, the `byPeer` index (now by presence), `isPublishSessionOf`, and the owner check on `/sfu/sessions/:id/*`.
- `/sfu` requests carry `presenceId=` instead of `peerId=`. Room membership becomes `hub.isPresenceInRoom(presenceId, roomId)`. The per-peer rate limit keys on it too.
- `sfu-announce` checks `isPublishSessionOf(sessionId, peer.presenceId)`.
- **When sessions are dropped:**
  - On an explicit `leave` message: straight away, as now.
  - On a socket that closed without `leave`: after a **2-minute** grace, unless that presence has joined a room again by then. The browser's connections to Cloudflare survive a signaling blip, so their sessions have to as well.
  - Log `sfu_sessions_dropped presence=<8 chars> sessions=N reason=leave|timeout`.

### 4. Room version

- `Room` gets `version = 0`. It goes up by one on every change to stored tracks: `setTracks`, a withdrawal that removed something, and `removeTracks` when there was a set to remove.
- The `sfu-tracks` broadcast from `announceTracks` carries the version the write landed at.
- The join replay sends stored sets **without** `version`.

### 5. Snapshots

- `Room.snapshot()` returns `{version, peers, tracks}`:
  - `peers` is every member, the joiner included.
  - `tracks` has one entry per stored set whose owner is still a member, sorted by `peerId` so logs and tests compare.
- **After join:** `joined`, then the replay, then `room-snapshot` to the joiner, then `peer-joined` to the others.
- **`sync`:** if the peer is in a room, send it a snapshot (critical). If not, ignore it silently, as with `peer-state`.
- **Timer:** one 15 s timer for the whole server, not one per room. On each tick, for every room where at least one person publishes, send the snapshot to every member, the publisher included, **best effort**. A room where nobody publishes stays quiet: join and leave already keep its roster right. Stop the timer on shutdown.

### 6. Logs

```
ws_join peer=<id> presence=1a2b3c4d room=<code> …
peer_replaced room=<code> old=<id> new=<id>
sfu_sessions_dropped presence=1a2b3c4d sessions=2 reason=timeout
```

No log line per snapshot or per `sync`: they're routine, and four people in one room for an hour would add 240 lines.

### 7. Deliberate differences from the reference

- Sessions are owned by `presenceId`, not a signed-in user (see Concepts). Sign-in arrives in Phase 11.
- The 2-minute grace before dropping sessions. The reference never drops them on disconnect; its registry keeps one entry per user.

### 8. Not in this phase

- Repairing media itself (ICE restart, rebuilding a dead publish or pull): Phase 9. If Cloudflare drops our media during the blip, Phase 8 doesn't fix that.
- Knock and admit state surviving a reconnect: Phase 11.

---

## Frontend (Claude)

- **`SignalingClient`:**
  - states `connecting | connected | reconnecting`
  - backoff with jitter (1 s doubling to 16 s, randomised 50–100%, no limit) and the 2 s wait after a working connection
  - pong counting (two missed → close and reconnect)
  - `presenceId` from `sessionStorage` (`rendezvu.presenceId`, made with `crypto.randomUUID()`)
  - `onReconnected`, fired on `welcome` after a reconnect
- **`useSignaling`:** `client` stays the **same object** from the first `welcome` until the page leaves the call. Today it becomes `null` on every drop, which is what tears the call down. It also returns `connState` and the attempt number.
- **`SfuSession`:**
  - `/sfu` requests carry `presenceId=` instead of `peerId=`
  - `currentAnnouncement()` returns the last set it announced, to send again after a reconnect
- **Reconnect handler in `useCall`:** follows the order in Concepts. `join` carries the current mic and camera (not the lobby's), and `presenceId`. A generation counter makes a second drop during the sequence cancel the first.
- **Version-aware reconciler:**
  - `setPeerTracks(…, version)` and `applySnapshot(entries, version)` ignore anything older than the newest applied
  - `resetDesired()` on reconnect: clears what it wants, resets the floor, and holds off dropping until the next snapshot
- **Snapshot handler:**
  - the roster becomes exactly the snapshot's peers minus us: add the missing, remove the gone, update mic, camera and sharing; `speaking` stays as it is
  - corrections don't play join or leave sounds
- **Sending state again:** the peer store counts joins. `useCallControls` sends `peer-state` again after each one, so a reconnect re-sends the full state.
- **`ConnectionBanner`:** a quiet line above the grid: a spinner and "Connection interrupted. Trying to reconnect…" while reconnecting, nothing once connected. The grid, tiles and controls stay usable. It replaces today's "Lost connection to the server" screen. Leave still works during a reconnect.

## Done when

1. Turn Wi-Fi off on one laptop for 10 s, then on. Within about 20 s of Wi-Fi returning, everyone sees and hears that person again, and that person sees and hears everyone. Nobody clicks anything. No room shows two tiles for one person.
2. The same with a phone switching from Wi-Fi to mobile data mid-call.
3. Restart the signaling server mid-call. All browsers show the banner, reconnect within about 20 s, and the call carries on. Audio keeps flowing throughout.
4. Server log for one reconnect: one `ws_join` with the same `presence=` as before, then either `peer_replaced` (the server hadn't noticed the drop) or a `leave` before it (it had). There's no `sfu_sessions_dropped … reason=timeout`, and the person's `sfu_tracks` line reappears.
5. In `chrome://webrtc-internals`, a 10 s signaling drop doesn't close or recreate the publish connection.
6. Two tabs of the same browser in one room are still two people.
7. Leaving normally still drops the sessions straight away (`reason=leave`).

## Testing the server without the client

```
# A joins with a presenceId, then reconnects on a new socket with the same one.
A1> {"type":"join","room":"<code>","data":{"name":"A","presenceId":"tab-a-0001"}}
A2> {"type":"join","room":"<code>","data":{"name":"A","presenceId":"tab-a-0001"}}
B<  {"type":"peer-left","from":"<A1>",…}   then  {"type":"peer-joined","from":"<A2>",…}
A1  closed: 1000 replaced by reconnect

# Any member asks for the state.
B>  {"type":"sync"}
B<  {"type":"room-snapshot","data":{"version":3,"peers":[…],"tracks":[…]}}
```
