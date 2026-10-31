# Phase 6: In-call controls and shared status

Status: **built**. Backend: Claude (on request) · Frontend: Claude

## Goal

During a call you can mute and unmute, turn the camera off and on, flip between front and back camera, switch mic, camera or speaker, and share your screen. Every change reaches everyone else within a second: they see a muted icon, your avatar instead of a frozen frame, your screen instead of your face, and a ring around your tile while you speak.

## Why this comes now

Phase 5 made the call work, but only with the media you joined with. Today, turning your camera off in the middle of a call would leave everyone looking at your last frame forever, because nothing tells them it was on purpose. These are the controls people touch every minute, so they come straight after the call itself.

## Concepts

**Swapping a track vs adding one.** A connection to Cloudflare has one *sender* per kind (audio, video). Two very different operations look similar from the outside:

| Operation | What happens | Cost |
|---|---|---|
| Swap the track on an existing sender (`replaceTrack`) | Same connection, same `trackName`, new pixels or samples | Instant. No SDP, no server call, nobody re-pulls |
| Add a sender for a new kind | New SDP offer, `tracks/new`, a new `sfu-announce`, everyone pulls the new track | 1–3 s, and every subscriber renegotiates |

`SfuSession` already does the first through the `BehaviorSubject` per kind (Phase 4). Phase 6 is about using it for every change after the first: mute, camera off, device switch, flip, screen share. The only time a kind is added mid-call is the first time it's turned on, for someone who joined with it off.

**Placeholders keep the sender alive.** Turning the camera off must stop the real camera (so its light goes out), but stopping the track that a sender is using leaves that sender with nothing. Remote viewers then freeze on the last frame, and turning the camera back on would need the slow path. So the sender gets a stand-in:

```
camera on    sender ◄── camera track
camera off   sender ◄── black canvas track  (camera stopped, light off)
camera on    sender ◄── new camera track    (black track stopped after the swap)
```

- Video: a black `<canvas>` at the camera's size (960×540, 24 fps) via `captureStream()`. Same size as the camera on purpose: some browsers refuse to swap between very different sizes without renegotiating.
- Audio: a silent track from the shared `AudioContext` (`createMediaStreamDestination()`).
- A placeholder lives exactly as long as it's the track being sent. It's stopped only *after* the next swap finishes. Stopping it earlier freezes viewers on its last frame, which is the bug this avoids.
- A placeholder only ever replaces an existing sender. It never starts a push, so nobody is announced a black track.

**Say it, don't guess it.** The black frames don't tell the others *why* the video is black: camera off, a slow network, or a broken connection all look alike. So the state travels separately, as `peer-state {audio, video, speaking, screenSharing}`, and the tiles follow it: `video: false` shows the avatar, `audio: false` shows the muted icon. The media and the message can arrive in either order; the tile only shows video when both agree.

**Screen share replaces the camera.** The screen goes out on the **same video sender** as the camera, swapped with `replaceTrack`; it isn't a third track. One video per person keeps every subscriber at one video pull per person, and starting a share is instant. While sharing, `video` is `false` and `screenSharing` is `true`, and tiles show video when either is true.

```
start share   camera on? → turn it off first (placeholder) → picker → sender ◄── screen
stop share    sender ◄── camera (if it was on before sharing) or placeholder
```

The camera goes off *before* the picker opens. Doing it after would let the placeholder swap land after the screen swap, and everyone would see black.

**Critical vs best-effort messages.** Phase 6 is the first time one person can send many messages a second (`speaking` flips each time they pause). Messages now come in two kinds:

| Kind | Examples | If the receiver is slow |
|---|---|---|
| Critical | `joined`, `peer-joined`, `peer-left`, `sfu-tracks`, `error` | Wait up to 2 s for room in the queue, then drop and log |
| Best effort | `peer-state` | Drop at once if the queue is full; the next one replaces it anyway |

Without a limit, one phone on a bad network makes the server hold every message for it in memory until the 60 s idle timeout.

**Stored again, not only sent.** As with tracks in Phase 5, the server keeps each person's latest `audio`, `video` and `screenSharing`, and `joined` / `peer-joined` carry them. A late joiner sees who is muted or sharing straight away, without anyone re-sending. `speaking` isn't stored: it's stale a second later.

---

## Backend requirements (you)

### 1. Shared types (`protocol/src/index.ts`)

```ts
// add to MsgType
| 'peer-state'

/** client → server → everyone else in the room. Each message is the full current state. */
export interface PeerStateData {
  audio: boolean
  video: boolean
  speaking?: boolean
  screenSharing: boolean
}

// add to PeerInfo and PeerJoinedData; missing means false
screenSharing?: boolean
```

I'll add these with the frontend, as before. `screenSharing` is optional in `PeerInfo` and `PeerJoinedData` so the server keeps compiling before item 2 is done; the server should always send it.

### 2. Store the state on the peer

`Peer` gets `screenSharing = false` next to `audio` and `video`. `info()` and the `peer-joined` payload include it. `join` still sets only `audio` and `video` (a share can't be running before you join) and resets `screenSharing` to `false`.

### 3. `peer-state` on the WebSocket

- Not in a room → ignore it silently. (A state message racing a leave is normal, not an error worth sending back.)
- Read each field as a boolean; anything else counts as `false`. Unknown fields are ignored (`videoHeld` arrives in Phase 10).
- Store `audio`, `video`, `screenSharing` on the peer.
- Send to everyone else in the room, **best effort**:
  `{type: 'peer-state', room, from: <sender id>, data: {audio, video, speaking, screenSharing}}`
- Log `peer_state` only when `audio`, `video` or `screenSharing` changed. A speaking-only change is not logged: it would be most of the log.

### 4. A bounded send queue per connection

Replaces `Peer.sendRaw` writing straight to the socket.

- Each peer has a queue of at most **32** messages and writes them one at a time, waiting for each write to finish (the `ws.send` callback).
- `send` / `sendRaw` (critical): if the queue is full, wait up to **2 s** for space. Still full → drop the message and log `signaling_send_timeout peer=… type=…`. The connection stays open.
- `sendBestEffort`: if the queue is full, drop the message at once. No log.
- A single write that takes longer than **10 s** means the connection is dead → `terminate()` it. The normal close path then runs `leave`.
- `broadcastExcept` waits for all receivers **in parallel**, so one slow phone delays the room by at most 2 s, not 2 s per slow person. Add `broadcastExceptBestEffort` for `peer-state`.
- Order is kept: a message waiting for space takes the next free slot before anything sent after it, critical or best effort. Healthy receivers never wait at all, since each has its own queue.
- Messages to a closed socket are dropped, as now.

### 5. Logs

```
peer_state room=<code> peer=<id> audio=true video=false screen=true
signaling_send_timeout peer=<id> type=sfu-tracks
signaling_write_timeout peer=<id>          # one write stuck for 10 s; the connection is cut
```

### 6. Deliberate differences from the reference

- The reference server can also forward a `peer-state` to one person (`to`), but its client never sends one. Left out until something needs it.
- The reference client re-sends its state whenever the person count goes up. Here the server's stored state (item 2) already reaches every newcomer in `joined`, so the client doesn't.

### 7. Not in this phase

- `videoHeld` (video paused by the quality ladder): Phase 10.
- Re-sending state after a signaling reconnect: Phase 8.
- Join, leave and screen-share sounds: Phase 7, with the rest of the call screen.

---

## Frontend (Claude)

- **`SfuSession.sendPlaceholder(kind)`**: swaps a placeholder onto the existing sender of that kind; does nothing if that kind was never pushed. `publish(stream)` stays the path for real devices, which may start a push, and stops the placeholder it replaces.
- **Placeholders** (`lib/placeholder-tracks.ts`): `createBlackVideoTrack()` and `createSilentAudioTrack()`, created on demand and stopped after they're replaced.
- **Store actions** (the Phase 2 ones, now call-aware):
  - `disableMic` / `disableCamera`: send the placeholder first, then stop the device.
  - `enableMic` / `enableCamera`, `setAudioInput` / `setVideoInput`, `switchCamera`: the new track goes out through `publish` as today.
  - `startScreenShare` / `stopScreenShare`: `getDisplayMedia({video: true, audio: false, selfBrowserSurface: 'exclude'})`, `screenTrack` in the store, the camera restored on stop if it was on before. The browser's own "Stop sharing" button ends the track, which runs the same stop path.
  - The existing generation counters keep a slow picker or device request from overwriting a newer choice.
- **Sending state:** one effect in `useCallControls` that watches mic, camera, share and `speaking`, and sends the full state whenever it differs from the last one sent (and once on arrival). No handler has to remember to send it. `speaking` comes from the existing `useAudioLevel` on the local mic (threshold 0.035, 280 ms hold), is only sent when it changes, and is `false` while muted.
- **Receiving state:** `peer-state` updates that person in the roster; `joined` / `peer-joined` already carry the stored fields.
- **Device interrupted:** if the mic or camera track ends on its own (unplugged, permission revoked, another app took it), treat it as turned off: placeholder, state sent, and a toast "Camera was interrupted. Click to re-enable."
- **Call footer:** mic, camera, flip (only with the camera on and two or more cameras), screen share (hidden where `getDisplayMedia` doesn't exist, like phones), settings (mic, camera and speaker pickers, reusing the lobby panel), leave. Clicking the camera while sharing stops the share and turns the camera on.
- **Tiles:** video when `video || screenSharing` and a live video track exists, otherwise the avatar. Muted icon from `audio`. A ring while `speaking`. Your own tile shows your screen while you share.

## Done when

1. Muting on one device shows the muted icon on every other device within a second, and the sound stops. Unmuting brings both back.
2. Turning the camera off shows the avatar everywhere within a second (no frozen frame), and the camera light goes off. Turning it on brings the video back, with no new `sfu_tracks` line in the server log (a swap, not a new track).
3. Someone who joined with the camera off turns it on: one new `sfu_tracks … tracks=2`, and everyone sees them.
4. Switching mic or camera in settings, and flipping the camera on a phone, changes what others see and hear without a gap of more than a moment.
5. Screen share works from desktop Chrome, Firefox and Safari. Others see the screen in that person's tile; stopping (from our button or the browser's bar) brings back the camera if it was on before, or the avatar.
6. A late joiner sees who is muted, has the camera off, or is sharing, straight away.
7. Unplugging the camera or mic mid-call: the toast appears and the others see the matching state.
8. While someone talks, their tile has a ring on the other devices.

## Testing the server without the client

```
# A and B in one room (wscat). A changes state:
A> {"type":"peer-state","data":{"audio":false,"video":true,"speaking":false,"screenSharing":true}}
B< {"type":"peer-state","from":"<A>","data":{"audio":false,"video":true,"speaking":false,"screenSharing":true}}

# C joins later: A's stored state is in joined.
C< {"type":"joined","data":{"peers":[{"id":"<A>","audio":false,"video":true,"screenSharing":true,…}, …]}}
```
