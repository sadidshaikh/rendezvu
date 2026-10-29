# Phase 5: Subscribe, the first real multi-person call

Status: **frontend built**; backend next. Backend: you · Frontend: Claude

## Goal

Everyone in a room sees and hears everyone else. When you publish, the server tells the room which tracks are yours. Every other browser pulls them from Cloudflare and shows them in your tile. Someone who joins late gets told about everyone who was already there.

> **Milestone 1: a working group video call.**

## Why this comes now

Phase 4 proved one direction: your media reaches Cloudflare and can come back. The loopback already pulled a track by `sessionId + trackName`. The only thing missing for a real call is *telling other people* those two values, so they can do the same pull. That is a signaling job, which is exactly what the Node server is for.

## Concepts

**The full loop.**

```
Alice                      our server                        Bob
  │ publish (Phase 4)          │                               │
  │ ws: sfu-announce           │                               │
  │   {sessionId, tracks}      │  store as Alice's tracks      │
  │───────────────────────────►│  (replacing any old set)      │
  │                            │ ws: sfu-tracks, from: Alice   │
  │                            │──────────────────────────────►│
  │                            │                               │ pull each track (subscribe
  │                            │                               │ session for Alice, Phase 4 code)
  │                            │                               │
  │══════ Alice's media ══► Cloudflare SFU ══► Bob's subscribe session ═══►│ tile + audio
  │                            │                               │
  │                            │            Carol joins later  │
  │                            │ joined, then replay:          │
  │                            │ sfu-tracks from Alice, ───────────────────► Carol pulls too
  │                            │ sfu-tracks from Bob   ───────────────────►
```

**An event vs stored state.** `sfu-tracks` is an *event*: it reaches whoever is in the room at that moment. If that were all, Carol, who joined later, would never learn about Alice's tracks. So the server also *stores* each peer's current set and replays it to every newcomer. The same thing gets sent in two situations: as an update when it changes, and as a replay when someone arrives. Phase 8 builds on this idea (periodic snapshots heal a lost message).

**Replace, never merge.** Each announcement is the publisher's *full* current set. The server overwrites the stored set. If it merged, a track the publisher stopped would live on in the stored copy and be replayed to newcomers forever, and they would pull a track that no longer exists.

**Desired vs applied, on the client.** Each browser keeps two lists:

| List | Means | Changed by |
|---|---|---|
| desired | what the room says each person publishes | `sfu-tracks`, `peer-left` |
| applied | what we have actually asked Cloudflare to pull | the reconciler |

`reconcile()` compares them: it pulls what's desired but not applied, and drops what's applied but no longer desired. Two reasons this beats "pull on every message":
- **Order.** The replay arrives right after `joined`, *before* our SFU session exists (we first fetch ICE servers). An event handler would have nothing to pull with and drop the message. With desired state, the message is recorded and the reconcile after the session is created picks it up.
- **A new session replaces an old one.** If Alice's browser rebuilds its publish connection, she announces under a new `sessionId`. The reconciler sees the old session is no longer desired, closes our subscribe session to it, and pulls from the new one. A plain handler would leave the old pull running forever, paying for a dead connection.

**One subscribe session per person.** Already built into `SfuSession` in Phase 4: renegotiating Carol's tracks can never disturb Alice's. It costs one more connection per person, which is fine at this size.

**Audio has its own element.** Each remote person gets a hidden `<audio>` element, separate from their `<video>`:
- the `<video>` stays muted, so when a tile is hidden or reshuffled (later phases: pagination, spotlight) the sound never stops
- the speaker picker from Phase 2 applies to `<audio>` with `setSinkId`
- browsers only play sound after a user gesture. Clicking **Join now** is that gesture, so playback starts without a prompt

Our own audio is never played back to us: no echo.

---

## Backend requirements (you)

### 1. Shared types (`protocol/src/index.ts`)

```ts
// add to MsgType
| 'sfu-tracks'
```

`sfu-tracks` reuses `SfuTracksData` from Phase 4. The envelope's `from` is the publisher's peer id. I'll add this with the frontend, as before.

### 2. Store tracks on the room

`Room` gets `tracks: Map<peerId, SfuTracksData>`, with:
- `setTracks(peerId, data)`: replace the stored set.
- `withdrawTracks(peerId, sessionId)`: delete it **only if** the stored `sessionId` matches. Returns whether anything changed.
  - *Why the check:* a slow withdrawal from an old session can arrive after the announcement of the new one. Without the check, it would erase the new set and the publisher would vanish for everyone.
- `removeTracks(peerId)`: on leave.
- `trackSets()`: every stored set with its peer id, for the replay.

### 3. `sfu-announce` stores and broadcasts

After the Phase 4 checks pass:
- `tracks` not empty → `room.setTracks`, then send everyone **except the sender**:
  `{type: 'sfu-tracks', room, from: <sender id>, data: {sessionId, tracks}}`
- `tracks` empty → `room.withdrawTracks(peer.id, sessionId)`. Broadcast the empty set only if it changed something, so the others drop their pulls.
- Log `sfu_tracks peer=… room=… session=… tracks=2 receivers=3`.

### 4. Replay on join

In `Hub.join`, in this order:
1. `joined` to the newcomer (as now).
2. One `sfu-tracks` to the newcomer for **every stored set** in the room, each with `from` set to its owner.
3. `peer-joined` to everyone else (as now).

*Why `joined` first:* the newcomer needs the roster before tracks arrive, so it knows whose tile each set belongs to.

Log `sfu_replay peer=… room=… sets=2`.

### 5. Leave

In `Hub.leave`, call `room.removeTracks(peer.id)` before broadcasting `peer-left`. No separate track message: `peer-left` already tells every client to drop that person's pulls.

### 6. Pulls only from the same room (a deliberate addition)

In the `tracks/new` route, every track with `location: "remote"` names a `sessionId` to pull from. Check that each one is a **publish** session registered in the **same room** as the session making the request. Otherwise → `403 TRACK_NOT_IN_ROOM` "That track is not in this meeting."

*Why:* Cloudflare lets any session in our app pull any other session's track, across all rooms. Session ids are long and random, but they do travel to every participant's browser. This check means a leaked id from one meeting can't be used to watch another. One registry lookup per track.

The reference doesn't check this. Your call, but it's a few lines.

### 7. Logs

```
sfu_tracks room=<code> peer=<id> session=<id> tracks=2 receivers=3
sfu_tracks_withdrawn room=<code> peer=<id> session=<id>
sfu_replay room=<code> peer=<id> sets=2
```

### 8. Not in this phase

- Room versions and periodic snapshots that heal a lost `sfu-tracks`: Phase 8.
- Mute and camera changes mid-call (`peer-state`): Phase 6.
- Re-announcing after a signaling reconnect: Phase 9.

---

## Frontend (Claude)

- **`SfuSession`** gains `unsubscribeSession(remoteSessionId)`: stops every pull from that person, closes that subscribe connection, and releases the session on our server (`DELETE`).
- **`services/webrtc/call-reconciler.ts`, `CallReconciler`.**
  - `setPeerTracks(peerId, sessionId, trackNames)` and `removePeer(peerId)` update *desired*.
  - `reconcile()` closes the gap: new pulls through `subscribeTrack`, dropped sessions through `unsubscribeSession`. It does nothing until the `SfuSession` exists, and runs again right after it's created.
  - `peerForSession(sessionId)`: which person an arriving track belongs to.
- **Peer store:** `remoteStreams: Map<peerId, MediaStream>`.
  - Each arriving track replaces the one of the same kind, in a **new** `MediaStream` object. Adding a track to an existing stream from JavaScript fires no event, so a `<video>` already showing that stream would never notice. A new object changes the React prop and the element re-attaches.
  - A track that ends is removed the same way.
  - Cleared with the roster on leave.
- **`useCall`:** `sfu-tracks` → `setPeerTracks` + `reconcile`. `peer-left` → `removePeer` + `reconcile`. After `SfuSession` is created → `reconcile`. A pull that delivers no track within 15 s logs a warning (automatic repair is Phase 9).
- **`MeetCall` tiles:** a remote tile shows the person's video when their stream has a live video track, otherwise their avatar, as now.
- **`RemoteAudio`:** one hidden `<audio>` per remote person with an audio track. It follows the speaker picked in settings (`setSinkId`, in browsers that support it). If the browser still blocks playback, it retries on the next click or tap.

## Done when

1. Two tabs in one room, both with camera and mic on: each sees and hears the other. (Use headphones, or two devices, to avoid feedback.)
2. A third tab joining late sees and hears both, without anyone re-publishing.
3. Someone joining with the camera off and the mic on: others hear them, and their tile shows the avatar.
4. Someone leaves: their tile disappears, and the server logs `sfu_session_closed` for the subscribe sessions the others had opened to them.
5. Someone reloads the page (new peer id, new session): the others drop the old pull and show the new one. No frozen tile.
6. Three devices, one of them a phone on mobile data, in one call: everyone sees and hears everyone.
7. `chrome://webrtc-internals`: one publish connection, plus one subscribe connection per other person, all `connected`, with bytes flowing.
8. A `tracks/new` that pulls a session from another room → `403 TRACK_NOT_IN_ROOM`. *(Backend 6)*

## Testing the server without the client

Two browser tabs are the real test. To check the replay and the room check on their own:

```
# Tab A joins and publishes (camera on). Then connect B with wscat and join the same room:
> {"type":"join","room":"<code>","data":{"name":"B"}}
< {"type":"joined", ...}
< {"type":"sfu-tracks","from":"<A's peer id>","data":{"sessionId":"…","tracks":[…]}}   ← the replay
```
