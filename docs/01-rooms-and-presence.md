# Phase 1: Rooms and presence

Status: **built**. Server and client are done; the multi-device checks in "Done when" are next. Backend: you · Frontend: Claude

## Goal

Create a meeting, open its link on several devices, type a name, join, and see everyone else in the room appear and disappear live. There's no audio or video yet.

## Why this comes first

Everything later hangs off three facts the server must know at all times: **which rooms exist, who is in each one, and how to reach each person.** Media (Phase 4–5) only adds "and what each person is publishing". If presence is wrong, people see ghosts, miss each other, or join a dead room. Each of those looks like a media bug but isn't one.

Building it without media also keeps the feedback loop short. Two browser tabs, or a WebSocket client in the terminal, are enough to test every rule in this doc.

## Concepts

**Envelope.** Every WebSocket message, in both directions, is one JSON object of the same shape:

```ts
{ type: MsgType, room?: string, from?: string, to?: string, data?: T }
```

Unlike MeetGreet, where each message had its own top-level fields, the routing fields (`room`, `from`, `to`) always sit in the same place and the payload is always in `data`. With many message types and many peers, that consistency is what keeps the server's routing code small. The types are in `protocol/src/index.ts`.

**Peer id.** The server gives each WebSocket connection a random id and tells the browser in `welcome`. Everything about a person (their tile now, their tracks in Phase 5) is keyed by it. A new connection always gets a new id, including after a reconnect. Phase 8 handles that.

**Hub → Room → Peer.** Three types hold all live state, in memory:

| Type | Holds |
|---|---|
| `Hub` | `Map<roomCode, Room>`; the only place rooms are created and deleted |
| `Room` | its code and `Map<peerId, Peer>` |
| `Peer` | the socket, peer id, current room code (or none), name, audio, video |

New features extend these three. Don't create parallel maps elsewhere.

**Meeting code.** A meeting is identified by a code shaped `abc-defg-hij`. The server creates codes. The browser never makes one up.

**Instant room.** A meeting created on the spot with "New meeting". Each one is tracked in an **instant-room registry** with a lifetime:

```
created ──(first join)──► active ──(last person leaves)──► empty ──(someone joins)──► active
   │                         │                               │
   └─────── 12 h after creation, or 30 min empty ────────────┴──► closed (permanent)
```

The registry is separate from the Hub. The Hub knows who is connected *right now*. The registry knows whether a meeting code *may be used*. A room can be in the registry with nobody in the Hub (created, not joined yet), and the Hub never contains a room the registry would reject.

---

## Backend requirements (you)

### 1. Instant-room registry

An in-memory `Map<code, InstantRoom>` where each entry has `createdAt`, `activatedAt` (or null), `emptySince` (or null), `expiresAt` and `closed`.

| Operation | Behaviour |
|---|---|
| `create(code, now, ttl)` | Add an entry: `expiresAt = now + ttl` (`INSTANT_ROOM_TTL`, default 12h). A ttl ≤ 0 means 12h |
| `activateOrAllow(code, now)` | Used by **join**. Unknown → `UNKNOWN`. Closed, or expired now (mark it closed) → `EXPIRED`. Otherwise set `activatedAt` if it's null, clear `emptySince`, and allow |
| `allowActive(code, now)` | Used by **read-only checks** (room status now; TURN and SFU in Phases 3–4). Unknown → `UNKNOWN`. Closed, or expired now (mark it closed) → `EXPIRED`. Never joined → `NOT_STARTED`. Otherwise allow |
| `markEmpty(code, now)` | Called when the last peer leaves. Only for an existing, open, activated entry that isn't already empty: set `emptySince = now` |
| `markActive(code)` | Clear `emptySince` |

**Expired** means `now > expiresAt`, or `emptySince` is set and `now > emptySince + grace` (`INSTANT_ROOM_EMPTY_GRACE`, default 30m). Once an entry is closed, it stays closed.

Return the three outcomes as distinct errors or a small result type, so callers can turn them into the right error code.

*Why two "allow" operations:* joining is what starts a room. Checks such as "can this room get TURN credentials?" must not start a room that nobody has joined.

*Why a closed room says "expired" and not "unknown":* whichever check notices the expiry first marks the room closed. If closed rooms reported "unknown", whether you saw "no longer active" or "not available" would depend on whether the status page had already looked.

**Pruning:** every hour, remove entries that are closed or expired, so memory doesn't grow with every meeting ever created. After pruning, the code is unknown.

### 2. Shared HTTP request guard

Every JSON API route (not `/healthz` or `/ws`) runs these checks in order. Write it once as a function so `/ice-servers` and `/sfu/*` reuse it in later phases.

1. **CORS**
   - No `Origin` header (curl, server-to-server): continue.
   - `Origin` not in `ALLOWED_ORIGINS` (exact string match): `403`, plain text `origin not allowed`, stop.
   - Otherwise set:
     - `Access-Control-Allow-Origin: <origin>`
     - `Access-Control-Allow-Credentials: true`
     - `Vary: Origin`
     - `Access-Control-Allow-Methods: <route methods>, OPTIONS`
     - `Access-Control-Allow-Headers: Content-Type, Authorization`
2. **Preflight:** an `OPTIONS` request gets `204` and stops.
3. **Rate limit:** a token bucket keyed by `"<path>|<client ip>"`. Over the limit: `429`, header `Retry-After: <whole seconds, at least 1>`, plain text `rate limit exceeded`.
4. **Body cap:** 16 KiB. Reject anything larger with `413`.

After the guard, a wrong method gets `405` and plain text `method not allowed`.

**Token bucket** (`perMinute`, `burst`):
- A new key starts with `burst − 1` tokens and the request is allowed.
- On each request, refill `elapsed seconds × perMinute/60` tokens, capped at `burst`.
- Below 1 token: reject, with `Retry-After = (1 − tokens) / rate + 1` seconds.
- Otherwise take one token.
- Drop buckets not seen for 10 minutes.

*Why per path and IP:* one noisy client shouldn't be able to block everyone, and limits differ per route.

**Client IP**, in order:
1. `CF-Connecting-IP`
2. `X-Real-IP`
3. The first entry of `X-Forwarded-For`
4. The socket's remote address

*Why:* once deployed, every request comes through the platform's proxy. Without these headers, every user would share the proxy's IP and one rate-limit bucket.

**JSON errors** use the shape `{ "error": "<message>", "code": "<CODE>" }` (`ApiError` in protocol).

### 3. `POST /meets/new`

- Guard: methods `POST`, rate limit **12/min, burst 24**.
- Generate a code:
  1. Take 10 random bytes from `crypto.randomBytes`.
  2. Map each byte to `alphabet[byte % 32]`, where the alphabet is `abcdefghijkmnpqrstuvwxyz23456789`.
  3. Insert dashes after characters 3 and 7: `abc-defg-hij`.
- Register it: `registry.create(code, now, ttl)`.
- Respond `200` with `{ "meetCode": "abc-defg-hij" }` (`CreateMeetResponse`) and the headers `Content-Type: application/json` and `Cache-Control: no-store`.
- If generation fails: `500`, plain text `could not create meet`.

*Why that alphabet:* it has no `l`, `o`, `0` or `1`, so a code read aloud or typed from a screenshot can't be misread. It has exactly 32 characters and 256 is divisible by 32, so `byte % 32` is perfectly uniform with no bias. 32¹⁰ ≈ 10¹⁵ codes, so guessing a live one is hopeless.

### 4. `GET /room/status?code=<code>`

- Guard: methods `GET`, rate limit **60/min, burst 120**.
- If `code` doesn't match `^[a-z2-9]{3}-[a-z2-9]{4}-[a-z2-9]{3}$`: `400` with `{ "error": "invalid room code", "code": "INVALID_CODE" }`.
- Otherwise `200` with a `RoomStatusResult`, from `allowActive`:
  - `EXPIRED` → `{ "status": "ended", "message": "This room is no longer active." }`
  - Anything else, including unknown and not yet joined → `{ "status": "open" }`

*Why "open" for an unknown code:* the page uses this only to avoid showing a lobby for a meeting that has clearly ended. The real check happens on join. In Part 2, booked meetings add `too_early` (with `opensAt`) and `cancelled`.

### 5. WebSocket `GET /ws`

Use `ws` in `noServer` mode and handle the HTTP server's `upgrade` event yourself:
- Path isn't `/ws`: reply `404` and destroy the socket.
- An `Origin` header whose **host** (scheme stripped) isn't one of the hosts in `ALLOWED_ORIGINS`, and isn't the server's own `Host`: reply `403` and destroy the socket.
- No `Origin` header (a terminal client): allow.
- Messages larger than **32 KiB** close the socket. The `ws` default is 100 MiB.

*Why check Origin on WebSockets:* browsers don't apply CORS to WebSockets. Without this check, any website could open a socket to your server using a visitor's browser.

**On connect:**
1. Create a `Peer` with id = 8 random bytes as hex (16 characters).
2. Send `{ "type": "welcome", "from": "<peerId>" }`.

**Idle timeout:** if nothing has been received for **60 s**, terminate the socket. Terminate, not close: a dead peer can't answer a close handshake, and that would leave it in the room for another 30 s. The client sends `ping` every 15 s, so a healthy connection never hits this. A dead one (laptop lid closed, network gone) is cleaned up within a minute instead of staying in the room forever.

**Every message received:**
- Not valid JSON: send `error` with message `invalid JSON`. Keep the connection open.
- Dispatch on `type`.
- Unknown types get `error` with message `unknown message type: <type>`.

| `type` | Server does |
|---|---|
| `join` | See below |
| `leave` | Leave the current room (see "Leaving"). Not in a room: do nothing |
| `ping` | Reply `{ "type": "pong" }` |

**Join** (`room` on the envelope; `data: JoinData`):

1. Check the room, returning `error` and stopping on failure:
   - `room` is missing or empty → message `join requires room`.
   - `room` doesn't match the code regex → message `invalid room`.
2. Check access with `registry.activateOrAllow(room, now)` (2 s timeout once this becomes a network call):

   | Result | `error` code | Message |
   |---|---|---|
   | `EXPIRED` | `ROOM_EXPIRED` | This meeting is no longer active. |
   | anything else | `ROOM_UNAVAILABLE` | This meeting is not available right now. |

3. Store `name`, `audio` and `video` from `data` on the peer. A missing `data` means an empty name and both flags `false`.
4. If the peer is already in a room, the same one or a different one, leave it first (with the full "Leaving" behaviour). Afterwards, call `registry.markActive(room)`: leaving a room you were alone in empties it for a moment, and that would otherwise start the empty-grace countdown on a room that is in use.
5. Get or create the `Room` in the Hub.
6. Build `peers` from everyone in the room **before adding the joiner**. Joiners never see themselves.
7. Add the peer and set its current room.
8. Send the joiner `{ "type": "joined", "room": "<code>", "data": { "peers": [...] } }`. Each entry is a `PeerInfo`: `{ id, name, audio, video }`.
9. Send every other peer in the room `{ "type": "peer-joined", "room": "<code>", "from": "<joinerId>", "data": { "peerId", "name", "audio", "video" } }`.

Send `joined` before `peer-joined`. The newcomer should have the room list before anyone starts reacting to them.

**Leaving**, used by `leave`, by socket close, and by join step 4:

1. If the peer has no current room, stop. This makes leave-then-close safe: the second call does nothing.
2. Clear the peer's room, and remove the peer from the `Room`.
3. If the room is now empty:
   - delete it from the Hub
   - call `registry.markEmpty(code, now)`
4. Send every remaining peer `{ "type": "peer-left", "room": "<code>", "from": "<peerId>", "data": { "peerId" } }`.

**Sending:** only write to sockets whose `readyState` is `OPEN`. A failed write to one peer must never stop a broadcast to the others.

**Shutdown:** on `SIGTERM`, close every WebSocket with code `1001` (going away) before the server closes, so browsers reconnect quickly after a deploy.

### 6. Suggested layout

```
signaling/src/
├── index.ts               (exists) wire everything together
├── config.ts              (exists)
├── server.ts              (exists) add routing for the new endpoints
├── http/
│   ├── guard.ts           CORS + preflight + rate limit + body cap
│   ├── rate-limiter.ts    token bucket
│   └── client-ip.ts
├── meets/
│   ├── meet-code.ts       generator + regex
│   ├── instant-rooms.ts   the registry
│   └── routes.ts          POST /meets/new, GET /room/status
└── signaling/
    ├── hub.ts             rooms map, join, leave
    ├── room.ts
    ├── peer.ts
    └── ws-handler.ts      upgrade checks, welcome, idle timer, message dispatch
```

Import shared types with `import type { Envelope, JoinData, ... } from '@rendezvu/protocol'`.

### 7. Not in this phase

| Feature | Phase |
|---|---|
| Reconnect detection on the client, `presenceId` (no duplicates after a reconnect), `sync` / `room-snapshot` | 8 |
| `peer-state` (mute, camera, speaking) | 6 |
| `sfu-tracks` replay on join | 5 |
| Guest knock/admit, tokens | 11 |
| Name validation (length limit, trimming) | 11 |

---

## Frontend (Claude)

- **Signaling client.** A small class that owns the WebSocket:
  - connects to `wsServerUri` and waits for `welcome` to learn its peer id
  - sends envelopes and lets components subscribe to message types
  - sends `ping` every 15 s
- **Home page.**
  - **New meeting** calls `POST /meets/new` and opens `/room/<code>`. While it waits, the button shows "Creating…". If it fails: "Could not create meeting. Please try again."
  - **Join** with a code or a pasted link. Accepts `abc-defg-hij`, `/room/abc-defg-hij` or a full URL.
- **Room page.**
  1. Checks `/room/status` and shows "This room is no longer active." for an ended room.
  2. Otherwise asks for a name and joins.
  3. Shows the live participant list.
  - If the server refuses the join (`ROOM_EXPIRED`, `ROOM_UNAVAILABLE`), the page goes back to the lobby and shows the server's message in place of the join form.
  - **Leave** sends `leave` and shows "You've left the call" with a Rejoin button.

## Done when

1. **New meeting** on a laptop opens `/room/<code>`.
2. The same link joins from a second tab and from a phone. Each shows the others by name, within a second.
3. Closing a tab removes that person from the others within a second. Killing the phone's Wi-Fi removes it within about 60 s.
4. Joining a made-up code such as `abc-defg-hij` fails with "This meeting is not available right now."
5. `curl -X POST http://localhost:8080/meets/new` works 24 times quickly and then returns `429` with `Retry-After`.
6. A request with `Origin: https://evil.example` gets `403` from `/meets/new` and from the `/ws` upgrade.
7. With `INSTANT_ROOM_EMPTY_GRACE=10s`: empty a room, wait 10 s, try to join → "This meeting is no longer active."

## Testing the server without the client

```bash
# create a meeting
curl -s -X POST http://localhost:8080/meets/new

# two terminals, each:
npx wscat -c ws://localhost:8080/ws
> {"type":"join","room":"<code>","data":{"name":"Asha","audio":true,"video":true}}
> {"type":"ping"}
> {"type":"leave"}
```
