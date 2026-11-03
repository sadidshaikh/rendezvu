# Phase 11: Admission, room access and hardening

Status: **frontend built**; backend next. Backend: you · Frontend: Claude

## Goal

A meeting link no longer means "anyone who has it is in". The person who created the meeting joins straight away. Anyone else who opens the link asks to join and waits on a "Waiting to be let in" screen. They see nothing of the call meanwhile: no names, no video. Everyone already in the call gets a prompt with **Admit** and **Deny**, and **Admit all** when several people are waiting. An admitted guest joins like anyone else; a denied guest is told so.

Behind this, the server stops trusting requests just because they come from a browser on the right page. Every `/sfu/*` and `/ice-servers` request must carry a token for that room. Without one it gets `401`, and a script hammering `sessions/new` gets `429` while the real call carries on.

## Why this comes now

The call itself is solid (Phases 4–10), so the next question is who may get in. Today:
- Anyone who learns a meeting code joins the call, sees everyone and is seen.
- `/sfu/sessions/new` only checks that the `presenceId` is in the room (Phase 8). A presence id joins with nothing more than a WebSocket, so anyone can create Cloudflare sessions, which are **billed to your account**.
- `/ice-servers` hands out TURN credentials (also billed) to anyone who names an active room.

Putting all of this behind **one room-access function** now means Spring Boot can replace the inside of that function later (Part 2: sign-in in Phase 16, booking guest links in Phase 20) without touching any call code.

## Concepts

**A token is a signed note, not a password lookup.** The server writes a small JSON note, "this browser may be in room `abc-defg-hij` as a host until 21:00", and signs it with a secret only the server knows. The browser shows the note back with each request. The server checks the signature and the expiry and reads the claims, without storing anything or looking anything up. If anyone changes one character of the note, the signature no longer matches.

This is a **JWT** (JSON Web Token) signed with **HS256** (HMAC-SHA256). The format is three base64url parts, `header.payload.signature`:

```
header   {"alg":"HS256","typ":"JWT"}
payload  {"room":"abc-defg-hij","role":"host","iat":1730000000,"exp":1730043200}
sig      HMAC-SHA256(secret, header + "." + payload)
```

HS256 is what Phase 16 uses too: Spring Boot will sign tokens with a shared secret and Node will verify them the same way. Only the issuer changes.

**Room-scoped.** Every token names exactly one room. A token for `abc-defg-hij` is useless in any other room, so a leaked token exposes one meeting for a few hours, not your whole account.

**Two kinds of token, for now:**

| | Host token | Guest token |
|---|---|---|
| Issued by | `POST /meets/new`, to whoever creates the meeting | the server, when someone in the call admits a guest |
| Claims | `room`, `role: "host"` | `room`, `role: "guest"`, `sub: <presenceId>` |
| Lives | 12 h (the instant room's lifetime) | 2 h |
| Kept in the browser | `localStorage`, per room, so it works in every tab and after a reload | `sessionStorage`, per room: only this tab |
| Bound to a tab | no | yes: `sub` must match the presence id the tab joins with |

The host token is the **temporary dev token** from the plan. It stands in for "this person is signed in and owns the meeting" until real sign-in exists. The guest token is bound to the tab's `presenceId` (Phase 8): a Phase 8 reconnect keeps the same presence id, so an admitted guest stays admitted, while a token copied into another browser doesn't work there.

**Knocking is joining without a token.** The plan had a separate `knock` message after `join {needsAdmit: true}`. That leaves the server trusting a client's flag, and leaves a window between the two messages. Instead, **the server decides from the token**:
- `join` with a valid token for this room: a member, exactly as today.
- `join` without one, or with one that doesn't verify: the browser is put in the room's **waiting list**, and that *is* the knock.

A waiting guest isn't a member:
- They get `knock-pending` and nothing else: no `joined`, no roster, no track replay, no snapshots, no `peer-state`.
- Members don't get `peer-joined` for them, only a `knock-request {peerId, name}`.

The reference sends the roster and tracks to a guest who is still knocking. Here the room's contents stay private until someone says yes.

**Answering a knock.** Any **member** can answer. A waiting guest can't, or two guests could let each other in.
- **Admit** (`knock-admit {peerId}`): the server mints a guest token bound to the guest's presence and sends `knock-granted {token}`. It then runs the normal join: `joined`, replay, snapshot to the guest, and `peer-joined` to everyone else.
- **Deny** (`knock-deny {peerId}`): the guest gets `knock-denied` and leaves the waiting list. The reference only hides the prompt on the denier's own screen and leaves the guest waiting forever; here the guest is told.
- Either way, every member gets **`knock-resolved {peerId, outcome}`**, so the prompt disappears on everyone's screen, not just on the screen of whoever clicked. The same happens with `outcome: 'left'` when a waiting guest closes the tab.

**Late members still see the queue.** A guest can knock before anyone is in the call, or while the host's tab is reloading. The waiting list is room state, not a one-time broadcast, so every member who joins is sent a `knock-request` for each guest still waiting. This is the reference's fix for "the guest arrived first and waited out the whole call".

**Limits on knocking.**
- At most **20** guests wait in one room. One more gets an error, `KNOCK_QUEUE_FULL`.
- A denied tab can ask again only after **10 s**. Sooner, it just gets `knock-denied` again, so nobody can flood a call with prompts.
- A knock needs the room to exist and not have expired, but it doesn't start the room's clock. Only a member's join does.

**One function decides room access.** Everything that asks "may this browser be here?" goes through `signaling/src/access/room-access.ts`:

```ts
// WebSocket join: member, waiting, or refused.
authorizeJoin(roomId, token, presenceId): { kind: 'member'; role: 'host' | 'guest' } | { kind: 'knock' } | { kind: 'refused'; code }
// /sfu and /ice-servers: is this token good for this room (and this tab)?
authorizeRequest(roomId, token, presenceId?): { ok: true; role } | { ok: false; status: 401 | 403; code }
```

Both combine the token check with the room's state from Phase 1 (does it exist, has it expired). In Part 2, the inside becomes a call to Spring Boot ("may user X join booking Y now?"). The WebSocket handler and the HTTP routes don't change.

**401 or 403.**
- **`401 Unauthorized`:** we don't know who you are. The token is missing, malformed, wrongly signed or expired.
- **`403 Forbidden`:** we know who you are, and the answer is no. A valid token for another room, or a guest token used with another tab's presence id.

The difference tells a client whether getting a new token could help.

**Trust boundaries.** Everything the browser sends is a claim. The server trusts only:
- its own secret: a token's signature proves the server issued it
- its own state: who is in the room, which sessions belong to which presence (Phase 4 and 8)
- the request's shape after validation: names, sizes, numbers

The meeting code, `presenceId`, `peerId`, a `needsAdmit` flag or the page a request comes from prove nothing on their own. The token is what turns "a browser that knows the code" into "a browser the host let in".

**Rate limits per tab *and* per address** (Phase 4 already has both on `/sfu/*`, keyed by presence since Phase 8):
- **Per tab:** a burst of 40, then 30 a minute. This stops one runaway client, for example a retry loop, without touching anyone else.
- **Per address:** a burst of 400, then 300 a minute. This is the abuse backstop. It has to be wide, because ten people behind one office NAT share one IP and together create about 100 sessions in their first seconds.

A per-address limit alone would cut off that office; a per-tab limit alone would let a script with many fake presence ids through. The token check now comes **after** the rate limits, so guessing tokens is rate-limited too.

**What's already hardened, and what's new.**
- **Since Phases 1–4:**
  - the origin allowlist on HTTP and WebSocket
  - request-size limits (16 KiB by default, 256 KiB for SDP)
  - 32 KiB WebSocket messages
  - the 60 s WebSocket idle timeout
  - timeouts on every Cloudflare call (15 s for the SFU, 8 s for TURN)
  - rate limits on every route
- **New in Phase 11:**
  - tokens on `/sfu/*` and `/ice-servers`
  - a **message rate per WebSocket**: a burst of 60, then 30 a second. Beyond that the socket is closed with `1008` (policy violation). A real client sends a handful a second at most: `peer-state` when speaking changes, plus pings.
  - at most **20 WebSockets per IP address** at once

---

## Backend requirements (you)

### 1. Shared types (`protocol/src/index.ts`)

```ts
// MsgType gets
| 'knock-pending' | 'knock-request' | 'knock-admit' | 'knock-deny'
| 'knock-granted' | 'knock-denied' | 'knock-resolved'

// JoinData gets
token?: string                 // host or guest token for this room; missing → knock

// CreateMeetResponse gets (optional in the type, so a server without admission still typechecks; always set it)
hostToken?: string

/** server → members: someone is waiting. Also replayed to members who join later. */
export interface KnockRequestData { peerId: string; name: string }
/** member → server: knock-admit and knock-deny. */
export interface KnockAnswerData { peerId: string }
/** server → the admitted guest, right before its `joined`. */
export interface KnockGrantedData { token: string }
/** server → members: a knock ended, close its prompt. */
export interface KnockResolvedData { peerId: string; outcome: 'admitted' | 'denied' | 'left' }

// SignalingErrorCode gets
| 'KNOCK_QUEUE_FULL'
```

`knock-pending` and `knock-denied` carry no data. I'll add these with the frontend, as before.

### 2. Tokens (`signaling/src/access/room-token.ts`)

- `signRoomToken({room, role, sub?}, ttlMs)` and `verifyRoomToken(token)`, HS256 with `node:crypto` (`createHmac`, `timingSafeEqual`). No library needed.
- **Verify:**
  - exactly three parts
  - the header's `alg` is exactly `HS256` (reject `none` and anything else)
  - a constant-time signature comparison
  - `exp` in the future, with 30 s allowed for clock skew
  - `room` a valid meeting code, and `role` either `host` or `guest`
  - anything else → invalid
- **Secret:** a new env var, `ROOM_TOKEN_SECRET`, at least 32 characters. If it's not set, generate a random one at startup and warn: tokens then stop working whenever the server restarts, which is fine for development. Add it to `signaling/.env.example`.
- **Lifetimes:** host 12 h (the instant room's TTL), guest 2 h.

### 3. Room access (`signaling/src/access/room-access.ts`)

`authorizeJoin` and `authorizeRequest` as in Concepts, using the token plus the instant-room registry. The rules:
- **Host token:** `room` matches → allowed.
- **Guest token:** `room` matches **and** `sub === presenceId` → allowed; a different presence → `403`.
- **No token or an invalid one:**
  - on `join` → knock
  - on HTTP → `401`
- **The room doesn't exist or has expired:** refused with today's `ROOM_UNAVAILABLE` / `ROOM_EXPIRED`, before any token check. A knock never activates the room; a member's join does, as `activateOrAllow` does now.

### 4. Waiting list and knock messages

- `Room` gets a **waiting list**: `Map<peerId, Peer>`, kept apart from `members`. Waiting peers aren't in `peerInfos()`, snapshots or broadcasts, and don't count for the room being empty.
- **`join`** goes through `authorizeJoin`:
  - **member:** as today, plus a `knock-request` for each waiting guest, sent after `peer-joined`
  - **knock:**
    - the room's waiting list is full (20) → `error KNOCK_QUEUE_FULL`
    - this presence was denied less than 10 s ago → `knock-denied`
    - otherwise: replace any waiting entry with the same presence (a reconnect: send `knock-resolved {left}` for the old id), add the peer to the list, send it `knock-pending`, and send members `knock-request {peerId, name}`
  - log `knock room=… peer=… presence=<8>`
- **`knock-admit` / `knock-deny`:**
  - ignored unless the sender is a **member** of a room where `peerId` is waiting
  - **admit:**
    - mint a guest token bound to the guest's `presenceId`
    - send the guest `knock-granted {token}`
    - remove it from the waiting list and run the normal member join for it: `joined`, replay, snapshot, `peer-joined`, and the knock replay
    - log `knock_admitted room=… guest=… by=…`
  - **deny:**
    - send the guest `knock-denied` and remove it from the waiting list
    - remember the presence as denied for 10 s
    - log `knock_denied …`
  - either way, send every member `knock-resolved {peerId, outcome}`
- **A waiting peer's socket closes:** remove it from the waiting list and send members `knock-resolved {left}`.
- **Everything else from a waiting peer is ignored:** `peer-state`, `sfu-announce`, `sync`, `stats-report`. Only `ping`, `leave` and `join` work.
- **`leave` from a waiting peer:** the same as its socket closing.

### 5. HTTP routes

- **`POST /meets/new`:** also returns `hostToken`, signed for the new room.
- **`/ice-servers`:** reads `Authorization: Bearer <token>` and runs `authorizeRequest(roomId, token)`. `401` and `403` as in Concepts; the response body uses the usual `{error, code}`, with codes `UNAUTHORIZED` and `FORBIDDEN_ROOM`.
- **`/sfu/sessions/new`:** the same, with the request's `presenceId`.
- **The other `/sfu/sessions/:id/*` routes:** the token's room must equal the session's room (and for a guest, `sub` must equal its presence).
- **Order in each handler:**
  1. guard (origin, method, size)
  2. rate limit
  3. **token**
  4. the room and ownership checks that exist today
- The CORS preflight already allows the `Authorization` header (`guard.ts`).

### 6. WebSocket hardening

- **Message rate:** a token bucket per socket, with a burst of 60 refilling at 30 a second. When it's empty, close with `1008 "too many messages"` and log `ws_rate_limited peer=…`.
- **Connections per IP:** at most 20 open sockets per address (`clientIp` already reads the proxy's forwarding headers). The 21st upgrade is answered `429` and closed.

### 7. Logs

```
knock room=<code> peer=<id> presence=1a2b3c4d
knock_admitted room=<code> guest=<id> by=<id>
knock_denied room=<code> guest=<id> by=<id>
http_unauthorized route=/sfu/sessions/new status=401 code=UNAUTHORIZED
ws_rate_limited peer=<id>
```

Never log a token, not even part of one.

### 8. Deliberate differences from the reference

- **Host tokens:** the meeting's creator gets a dev host token from `/meets/new`. The reference uses the signed-in user; sign-in is Phase 16.
- **No separate `knock` message:** joining without a valid token is the knock, so the server never trusts a `needsAdmit` flag.
- **Waiting guests see nothing of the room** until admitted. The reference sends them the roster, the track replay and snapshots.
- **Deny is real:** the guest is told, and can ask again after 10 s. The reference's deny only hides the prompt locally.
- **`knock-resolved`** closes the prompt on every member's screen.
- **Guest tokens are bound to `presenceId`** rather than the peer id, so a Phase 8 reconnect keeps the admission.

### 9. Not in this phase

- Sign-in, accounts and the host role surviving across browsers: Phase 16.
- Booking guest links that skip the knock: Phase 20.
- Removing someone from a call, or locking a room: not planned yet.

---

## Frontend (Claude)

- **Tokens (`services/api/room-token.ts`):**
  - `getRoomToken(code)` reads sessionStorage, then localStorage
  - `saveHostToken(code, token)` and `saveGuestToken(code, token)`
  - all wrapped in try/catch, since storage can be blocked
- **Creating a meeting:** keeps `hostToken` from `/meets/new`.
- **`join`** carries the token, on the first join and after a Phase 8 reconnect.
- **HTTP:**
  - `fetchIceServers` and the ICE keep-alive send `Authorization: Bearer …`
  - `SfuSession` gets a `token` option, passed to partytracks' `headers`, and sends it on its own `DELETE`s too
  - after admission, the token arrives before `joined`, so ICE and SFU requests always have it
- **Lobby:** without a token for this room, the button reads **Ask to join**, with a line saying someone in the call will need to let you in.
- **`useCall` and the peer store:**
  - `admission: 'member' | 'waiting' | 'denied'`
  - `knock-pending` → waiting
  - `knock-granted` → save the guest token (the normal `joined` follows)
  - `knock-denied` → denied
  - `knockRequests: KnockRequestData[]`, from `knock-request` and `knock-resolved`
- **Waiting screen (`KnockingScreen`):**
  - your own preview, "Waiting to be let in…" with a spinner, and **Cancel**
  - after a deny: "You weren't let in" with **Ask again** (sends `join` again) and **Back**
  - the call screen isn't mounted until you're a member
- **Prompts in the call (`KnockPrompt`):**
  - one waiting: "*Name* wants to join", with **Admit** and **Deny**
  - several: "*3 people* want to join", with **Admit all** and a list that expands, each with Admit and Deny
  - a short knock sound when a new request arrives, deduplicated across tabs like the other sounds (Phase 7)
- **Errors:** `KNOCK_QUEUE_FULL` shows "This call has too many people waiting. Try again in a minute."

## Done when

1. Create a meeting in one browser: you join straight away.
2. Open the link in another browser, or a private window: the lobby says **Ask to join**. After clicking it, you wait, and the call shows nobody's name or video.
3. The host sees "*Name* wants to join". **Admit** brings the guest in, and everyone sees them. **Deny** tells the guest, who can ask again after 10 s.
4. Two guests waiting: **Admit all** lets both in, and the prompt closes for every member, not just the one who clicked.
5. A guest knocks before the host has joined. When the host joins, the prompt appears.
6. An admitted guest's Wi-Fi drops for 10 s: they reconnect and are back in without knocking again (Phase 8 plus the guest token).
7. `curl -X POST "https://localhost:8080/sfu/sessions/new?roomId=<code>&presenceId=x"` with no token → `401`. With a token for another room → `403`.
8. A script that hammers `sessions/new` with a valid token and its own presence id gets `429` after 40 requests, and a call running alongside is unaffected. Run it from another device, or stay under the address burst of 400.
9. A script that sends 100 WebSocket messages at once is disconnected with `1008`.
10. The server log has `knock`, `knock_admitted` and `knock_denied` lines, and no token anywhere.

## Testing the server without the client

```
G>  {"type":"join","room":"<code>","data":{"name":"Guest","presenceId":"guest-tab-0001"}}
G<  {"type":"knock-pending"}
H<  {"type":"knock-request","from":"<G>","data":{"peerId":"<G>","name":"Guest"}}
H>  {"type":"knock-admit","data":{"peerId":"<G>"}}
G<  {"type":"knock-granted","data":{"token":"eyJ…"}}   then joined, the replay, the snapshot
H<  {"type":"knock-resolved","data":{"peerId":"<G>","outcome":"admitted"}}   then peer-joined

curl -s -o /dev/null -w "%{http_code}" -X POST "https://localhost:8080/sfu/sessions/new?roomId=<code>&presenceId=x"   → 401
```
