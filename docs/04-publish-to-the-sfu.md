# Phase 4: Publish to the SFU

Status: **built**. Frontend and backend are done; the real-network checks in "Done when" are next. Backend: you (items 2–7 written by Claude) · Frontend: Claude

## Goal

After joining, your browser sends your camera and mic to Cloudflare's SFU, through a TURN-capable connection from Phase 3. Cloudflare confirms it has your tracks, and your browser tells the room "my tracks are live, here are their names". As proof, the Diagnostics page pulls your own video back from Cloudflare and plays it.

Nobody else sees you yet. Pulling other people's tracks is Phase 5.

## Why this comes now

Publishing is half of a call, and it can be tested with one person. If it works alone (your video goes up, comes back from Cloudflare), then any problem in Phase 5 is in subscribing, not here. Splitting it this way halves the places a bug can hide.

## Concepts

**SFU.** A Selective Forwarding Unit is a server that receives each person's media once and forwards a copy to everyone else.

```
 Mesh (MeetGreet)                      SFU (Rendezvu)
 every pair connects directly          everyone connects to Cloudflare only

   A ─────── B                            A ──┐        ┌──► B
   │ ╲     ╱ │                                ▼        │
   │   ╲ ╱   │                         Cloudflare SFU ─┼──► C
   │   ╱ ╲   │                                ▲        │
   C ─────── D                            B ──┘        └──► A …
 A uploads 3 copies of its video       A uploads 1 copy, whatever the room size
```

With a mesh, each person uploads one copy per other person, and phones run out of upload bandwidth at about four people. With an SFU the upload stays at one copy.

**Session and track.** To Cloudflare:
- a **session** is one `RTCPeerConnection` between a browser and Cloudflare. It has a `sessionId`.
- a **track** is one media source inside a session (your mic, your camera), with a `trackName`.

`sessionId + trackName` is the address of a published track. That pair is all anyone needs to subscribe to it in Phase 5.

**Two directions, separate sessions.** Each browser has one **publish** session (sending only) and, from Phase 5, one **subscribe** session per remote person (receiving only). This phase creates only the publish session.

**The publish handshake.** Offer and answer go to Cloudflare, through our server, which adds the secret app token:

```
browser                          our server                     Cloudflare
  │ POST /sfu/sessions/new          │                               │
  │   ?roomId&peerId&kind=publish   │ POST /apps/{id}/sessions/new  │
  │────────────────────────────────►│──────────────────────────────►│
  │◄──────── {sessionId} ───────────│◄──────── {sessionId} ─────────│
  │                                 │                               │
  │ createOffer() for mic + camera  │                               │
  │ POST …/{sessionId}/tracks/new   │                               │
  │   {offer, tracks:[local…]}      │──────────────────────────────►│
  │◄──── {answer, tracks:[names]} ──│◄──────────────────────────────│
  │ setRemoteDescription(answer)    │                               │
  │                                 │                               │
  │══════ ICE + DTLS, then media: browser ⇄ Cloudflare (TURN if needed) ═══
  │                                 │                               │
  │ ws: sfu-announce                │                               │
  │   {sessionId, tracks:[names]}   │  (stored and shared in Phase 5)
  │────────────────────────────────►│                               │
```

**Why ICE candidates never pass through our server.** In MeetGreet each side sent its candidates to the other through the signaling server. Cloudflare's answer already lists its own addresses, and Cloudflare learns ours from the connection itself. So there are no `ice-candidate` messages at all.

**Accepted is not live.** A `200` on `tracks/new` only means Cloudflare accepted the offer. The browser still has to apply the answer and connect. If the server told the room at that moment, a fast subscriber could ask for a track that never actually arrives and stay stuck on a black tile. So only the **publisher** announces, and only after its own push is confirmed.

**partytracks.** A small library from Cloudflare that runs the offer/answer dance, batches tracks into one negotiation, retries, and swaps a track without renegotiating when you switch camera. It calls a fixed set of HTTP routes under a prefix we choose (`/sfu`), which is why our routes have the shapes below. It uses RxJS observables, so `rxjs` comes with it.

**The session is created lazily.** No Cloudflare session exists until there is a track to send. Cloudflare closes a session that stays idle with no connection for about 30 s, so creating one on join would break for anyone who joins with mic and camera off.

---

## Cloudflare setup (you)

If you didn't do Phase 3's optional step:

1. In **Realtime → Serverless SFU**, create one app named `rendezvu`. One environment, so this app serves both local and deployed.
2. **App ID** → `CF_CALLS_APP_ID`, **App Secret** → `CF_CALLS_APP_TOKEN`, in `signaling/.env`.
3. Check it. A working app returns a `sessionId`:
   ```bash
   curl -s -X POST \
     -H "Authorization: Bearer $CF_CALLS_APP_TOKEN" \
     "https://rtc.live.cloudflare.com/v1/apps/$CF_CALLS_APP_ID/sessions/new"
   ```
   That session is never connected, so Cloudflare drops it on its own.

---

## Backend requirements (you)

### 1. Shared types (`protocol/src/index.ts`)

```ts
// add to MsgType
| 'sfu-announce'

export interface SfuTrackInfo { trackName: string; mid?: string }

/**
 * client → server `sfu-announce`: the FULL set of tracks I publish right now.
 * The server replaces, never merges. An empty `tracks` withdraws the session.
 * Phase 5 reuses this shape for server → client `sfu-tracks`.
 */
export interface SfuTracksData { sessionId: string; tracks: SfuTrackInfo[] }
```

I'll add these with the frontend, as in Phase 3.

### 2. Cloudflare Realtime client (`sfu/cloudflare-sfu.ts`)

A module that knows only Cloudflare, like the TURN client.

- Base: `https://rtc.live.cloudflare.com/v1/apps/{CF_CALLS_APP_ID}`, header `Authorization: Bearer {CF_CALLS_APP_TOKEN}`.
- `createSession(signal) → sessionId`: `POST /sessions/new`, read `sessionId` from the JSON.
- `forward(method, sessionId, subPath, body, signal) → {status, body}`: for `tracks/new`, `renegotiate`, `tracks/update`, `tracks/close`. Sends the browser's JSON body as is and returns Cloudflare's status and raw body.
- Any status ≥ 400 is an error that **keeps Cloudflare's status and raw body** (an error class with `status` and `body` fields), because the route forwards that body to the browser.
- A **15 s timeout** on every call (`AbortSignal.timeout(15_000)`), combined with the client-disconnect abort from Phase 3.
- Never log the app token. SDP is long and full of IP addresses: don't log it either.

### 3. Missing keys

If `CF_CALLS_APP_ID` or `CF_CALLS_APP_TOKEN` is empty: one startup warning (`CF_CALLS_APP_ID / CF_CALLS_APP_TOKEN not set; /sfu/* will return 503`), and every `/sfu/*` request gets `503 SFU_UNAVAILABLE` "Video calls are not configured on this server."

*Why not a fallback like TURN:* there is no free public SFU to fall back to. A clear error beats a call that silently sends nothing.

### 4. Session registry (`sfu/session-registry.ts`)

In memory: `sessionId → {roomId, peerId, kind, createdAt}`.

- `register(sessionId, roomId, peerId, kind)`, `lookup(sessionId)`, `remove(sessionId)`.
- `removePeer(peerId)`: drops every session of that peer. Call it when a peer leaves or disconnects (from the Hub's leave path).
  - *Addition:* the reference keeps sessions until `DELETE`. Dropping them on leave means a session can't be used by anyone once its owner has gone, which matters here because ownership is checked by peer id (next section).

### 5. Routes

One handler for the prefix `/sfu/sessions/` (the server's route table is exact-match today, so add prefix support, or match `/sfu/sessions/` in `createServer` before the exact routes).

| Route | Cloudflare | Notes |
|---|---|---|
| `POST /sfu/sessions/new?roomId&peerId&kind` | `POST /sessions/new` | Creates and registers the session. Returns `{"sessionId": "…"}` |
| `POST /sfu/sessions/:id/tracks/new` | `POST …/tracks/new` | Publish now; subscribe in Phase 5 |
| `PUT /sfu/sessions/:id/renegotiate` | `PUT …/renegotiate` | Body must have `sessionDescription.type` and `.sdp`, else `400` |
| `PUT /sfu/sessions/:id/tracks/update` | `PUT …/tracks/update` | Pass through |
| `PUT /sfu/sessions/:id/tracks/close` | `PUT …/tracks/close` | Pass through |
| `DELETE /sfu/sessions/:id` | none | `registry.remove`, `204`. Cloudflare has no session delete; a session ends when its connection closes |
| anything else under the prefix | | `404` |

partytracks adds `apiExtraParams` to **every** request, so every route sees `?roomId&peerId&kind`.

**In order, for every request:**

| Step | Rule |
|---|---|
| Guard | `guardApiRequest` with `methods: 'POST, PUT, DELETE'`, **no** limiter (see rate limits), and `maxBodyBytes` **256 KiB**: an SDP offer for several tracks is far bigger than the 16 KiB default |
| Rate limit | Per peer and per address, below |
| Keys | Missing → `503 SFU_UNAVAILABLE` |
| Create only | `roomId` and `peerId` required, else `400`. `registry.allowActive(roomId)` → `403` via `roomAccessError` (Phase 3). The peer must be connected and in that room right now (ask the Hub), else `403 NOT_IN_ROOM` "Join the meeting first." |
| Every other route | Session not in the registry, or its `peerId` ≠ the request's `peerId` → `404 SESSION_NOT_FOUND`. Its room must still pass `allowActive`, else `403` |
| Body | Read with `readJson` (Phase 3). Invalid JSON → `400` |
| Cloudflare error | Body is valid JSON → forward it **as is** with `502` and `Content-Type: application/json`. Otherwise `502` with `{"error": "…", "code": "SFU_UPSTREAM"}` |
| Success | Cloudflare's JSON. An empty body becomes `{}` |
| All responses | `Cache-Control: no-store` |

*Why forward Cloudflare's error JSON unchanged:* partytracks reads `errorCode` from it (for example `session_error`) to decide whether to recreate the session. Wrapping it as plain text makes `res.json()` throw, and the library loses the information it needs to recover.

*Why every response must be JSON, even `{}`:* partytracks calls `res.json()` on every response, including ones with nothing to say. An empty body throws.

*Why `404` and not `403` for someone else's session:* it doesn't confirm to a guesser that the session exists.

**Ownership, for now.** Without tokens, a session belongs to the `peerId` that created it, and that peer had to be in the room. This is weaker than it looks: peer ids are visible to everyone in the same room, so a roommate who also learned your session id (Phase 5 shares it) could close your tracks. Outsiders can't. Phase 11 adds signed tokens to every `/sfu/*` call, which closes this. Write the check as one function so Phase 11 replaces only that.

### 6. Rate limits

| Bucket | Key | Limit | Why |
|---|---|---|---|
| Per peer | `path \| peer \| peerId` | 30/min, burst 40 | Catches one browser stuck in a retry loop |
| Per address | `path \| addr \| ip` | 300/min, burst 400 | The abuse backstop, wide enough for a group behind one NAT |

*Why not the usual single per-address limit:* `/sfu/sessions/new` is the one route everyone shares, and a 10-person room on one office network makes ~100 sessions in the first seconds (one publish plus one subscribe per other person, each). A 60/min address bucket would refuse a real meeting. A per-peer bucket stops the runaway client without punishing its neighbours.

Requests without a `peerId` skip the peer bucket and fall back to the address bucket.

### 7. `sfu-announce` on the WebSocket

Phase 4 only **validates and logs** it. Storing it and telling the room is Phase 5.

- Must be in a room, else `error` `NOT_IN_ROOM` "join a room before announcing tracks".
- `sessionId`: a string, 1–256 characters. `tracks`: an array of at most **8**. Each `trackName`: a string, 1–256 characters. Anything else → `error` "invalid sfu-announce".
- *Addition:* the `sessionId` must be in the SFU registry as **this peer's** publish session. Otherwise someone could announce another person's tracks under their own name. Cheap, since the registry already exists.
- Log `sfu_announce peer=… room=… session=… tracks=2`.

*Why bound it:* in Phase 5 the stored set is replayed to every later joiner, so junk stored once is sent many times.

### 8. Logs

```
sfu_session room=<code> peer=<id> kind=publish session=<id>
sfu_error room=<code> peer=<id> route=tracks/new status=400 error="…"
sfu_announce room=<code> peer=<id> session=<id> tracks=2
```

Log `publish accepted` on a successful `tracks/new` with a `sessionDescription`, with the track count. If a publish is accepted but no `sfu_announce` follows within a few seconds, the browser never confirmed the connection, which is a real client failure worth seeing.

### 9. Suggested layout

```
signaling/src/
  sfu/cloudflare-sfu.ts      createSession(), forward(); knows only Cloudflare
  sfu/session-registry.ts    sessionId → {roomId, peerId, kind}
  sfu/routes.ts              sfuHandler(registry, hub, rooms, sfuClient, allowedOrigins)
  server.ts                  prefix routing for /sfu/sessions/
  signaling/ws-handler.ts    sfu-announce validation
  index.ts                   wire it, the missing-keys warning, removePeer on leave
```

### 10. Not in this phase

- Storing announcements and sending `sfu-tracks` to the room: Phase 5.
- Subscribe sessions: Phase 5 (the routes already support them).
- Signed tokens on `/sfu/*`: Phase 11.

---

## Frontend (Claude)

- **Dependencies:** `partytracks` and `rxjs`.
- **`services/webrtc/sfu-session.ts`, `SfuSession`.** The only place that touches `RTCPeerConnection` for calls.
  - Options: `roomId`, `peerId`, `iceServers`, `onLocalTracksChanged`, `onPublishTimeout`, `onConnectionStateChange`.
  - One publish `PartyTracks` with prefix `${API}/sfu` and `apiExtraParams` `roomId…&peerId…&kind=publish`.
  - `publish(stream)`: pushes each track. A second track of the same kind replaces the first through the existing sender, with no renegotiation (camera switching in the lobby pickers already works this way locally).
  - On each push confirmation: record `{sessionId, trackName}` for that kind, then call `onLocalTracksChanged` with the **full** current set. Skip it if nothing changed.
  - A push not confirmed within **15 s**: `onPublishTimeout(kind)`. The automatic repair comes in Phase 9; for now it's a visible warning.
  - `updateIceServers(servers)`: from the Phase 3 keepalive, applied with `setConfiguration`. partytracks keeps a reference to the ICE server array it was given, so the session swaps the array's contents in place, and a connection partytracks rebuilds later also gets the fresh credentials.
  - `subscribeTrack(sessionId, trackName, onTrack)`: one subscribe session per remote publisher. The loopback uses it now; Phase 5 uses it for other people.
  - `destroy()`: unsubscribe every push, close the connection, `DELETE` the session.
- **In `useCall`, after `joined` and the ICE fetch:**
  1. Create `SfuSession` with the stored ICE servers. If `/ice-servers` was unreachable altogether, use the Google STUN server, because with no STUN at all the browser can't reach Cloudflare from behind a NAT.
  2. Publish whatever is live in `localStream`, and publish again whenever `localStream` changes (a device switch swaps the track on the same sender). Joining with both off publishes nothing and creates no Cloudflare session (in-call toggles arrive in Phase 6).
  3. `onLocalTracksChanged` → `send('sfu-announce', announcement)`.
  4. `onPublishTimeout` → toast "Your camera or microphone isn't reaching the call yet."
  5. Leave or unmount → `destroy()`.
- **Diagnostics page: an SFU loopback step.** Turn on the camera, publish it, then open a separate subscribe session and pull your **own** track back by `sessionId + trackName`. Show the returned video beside the local one, with bytes sent and received from `getStats`. That proves the full round trip through Cloudflare with one device. The subscribe part is the exact code Phase 5 uses for other people, so Phase 5 starts from code that already works.

## Done when

1. The `curl` above returns a `sessionId`.
2. Join with the camera and mic on: the Network tab shows `sessions/new` then `tracks/new`, both `200`, and the server logs `sfu_session` and then `sfu_announce … tracks=2`.
3. Join with both off: no `/sfu/*` requests at all.
4. `chrome://webrtc-internals` shows the publish connection `connected`, with `bytesSent` rising for audio and video.
5. Diagnostics loopback: your own video comes back from Cloudflare, on your laptop and on your phone over mobile data.
6. Requests to someone else's session, a made-up session or a room you're not in get `404` / `403`. A request with a bad SDP gets Cloudflare's JSON error with `502`.
7. With no `CF_CALLS_*` keys: the startup warning, and `/sfu/*` → `503`. The call itself still joins.
8. Leave: the publish connection closes, the server logs the `DELETE`, and the registry no longer has the session.

## Testing the server without the client

A real publish needs a browser to make the SDP offer. These check everything around it:

```bash
# a room someone has joined (wscat as in Phase 1), and that joiner's peer id from `welcome`
curl -s -X POST "http://localhost:8080/sfu/sessions/new?roomId=$CODE&peerId=$PEER&kind=publish"   # {"sessionId":"…"}
curl -s -X POST "http://localhost:8080/sfu/sessions/new?roomId=$CODE&peerId=nobody&kind=publish"  # 403 NOT_IN_ROOM
curl -s -X PUT  "http://localhost:8080/sfu/sessions/made-up/renegotiate?peerId=$PEER" \
  -H 'Content-Type: application/json' --data '{}'                                                 # 404 SESSION_NOT_FOUND
curl -s -X POST "http://localhost:8080/sfu/sessions/$SID/tracks/new?roomId=$CODE&peerId=$PEER" \
  -H 'Content-Type: application/json' \
  --data '{"sessionDescription":{"type":"offer","sdp":"bad"},"tracks":[]}'                         # 502 with Cloudflare's error JSON
```
