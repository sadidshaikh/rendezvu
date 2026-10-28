# Phase 3: ICE servers and TURN

Status: **built**. Frontend and backend are done; the real-network checks in "Done when" are next. Backend: you (written by Claude this phase) · Frontend: Claude

## Goal

After joining a room, the browser gets a short-lived set of STUN and TURN servers from our server, keeps it fresh for as long as the call lasts, and can prove it reaches Cloudflare's TURN relay. Phase 4 hands this set to every `RTCPeerConnection`.

## Why this comes now

Phase 4 opens the first real WebRTC connection, and every connection starts with "how can the two ends reach each other?". In MeetGreet you only had STUN, which is why your phone's video went missing: STUN tells a browser its public address, but on mobile networks, hotel Wi-Fi and office firewalls a direct connection is often impossible. TURN solves that by relaying the media through a server both sides can reach.

Getting TURN right *before* the SFU means that when Phase 4 fails to connect, you'll know it isn't the network path.

## Concepts

**ICE, STUN and TURN.** A browser collects **candidates**: addresses it might be reachable at. Then it tries pairs until one works.

| Candidate type | Comes from | Works when |
|---|---|---|
| `host` | the device's own network interfaces | both ends are on the same network |
| `srflx` (server reflexive) | asking a **STUN** server "what's my public address?" | the NAT lets outside traffic back in (many home routers) |
| `relay` | an allocation on a **TURN** server, which forwards packets | almost always, including over TCP/TLS on port 443 |

With an SFU the "other end" is Cloudflare's edge, not another person, but the rules are the same: the browser still has to reach it, and TURN is the fallback that gets through strict networks.

**Why our server hands out the credentials.** A TURN server relays anything for anyone who has credentials, and the relayed bandwidth is billed to us. So the long-lived **TURN key** (an id and an API token) never leaves the server. For each call, the server asks Cloudflare to mint a **username and password that expire in an hour**, and only those go to the browser. If one leaks, it's useless an hour later.

```
browser                         our server                       Cloudflare
   │  POST /ice-servers {roomId}   │                                  │
   │──────────────────────────────►│ is this room active right now?   │
   │                               │ POST …/generate-ice-servers      │
   │                               │   Bearer <TURN key API token>    │
   │                               │─────────────────────────────────►│
   │                               │◄──── {iceServers: [stun, turn…]} │
   │◄──── {iceServers: [...]} ─────│                                  │
   │                                                                  │
   │═════ later, in Phase 4: media relayed through turn.cloudflare.com ══════
```

**Why only after `joined`.** The server only answers for a room that is **active right now** (Phase 1's `allowActive`). An instant room becomes active on its first `join`, so a browser that asked from the lobby would be refused. It also means a random visitor can't farm TURN credentials from a meeting code that was never used.

**Why a STUN fallback instead of an error.** If Cloudflare is slow or down, refusing would stop every call. Answering with a public STUN server lets calls on friendly networks (the same Wi-Fi, most home routers) still connect. Only the strict-network users lose out, and the browser warns them.

**Why refresh at 45 minutes.** Credentials last 60 minutes. A connection that's already relaying keeps working, but new connections in the same call need valid credentials: subscribing to someone who joins at minute 70, or an ICE restart after a network change (Phase 9). Refreshing at 45 minutes leaves a 15-minute margin for a failed refresh to be retried.

---

## Cloudflare setup (you)

1. Sign in at `dash.cloudflare.com` (a free account works).
2. Open **Realtime → TURN Server** and create a TURN key named `rendezvu`. Rendezvu has one environment, so this one key serves both your machine and the deployed app.
3. It shows two values:
   - **Turn Token ID** → `CF_TURN_KEY_ID`
   - **API Token** → `CF_TURN_API_TOKEN`. It's shown **once**, so copy it now.
4. Add both to `signaling/.env`. They're already listed in `.env.example`. When you deploy, the same two values go into the host's environment variables.
5. Check the key from a terminal. A working key returns `201` and an `iceServers` array:
   ```bash
   curl -s -X POST \
     -H "Authorization: Bearer $CF_TURN_API_TOKEN" \
     -H "Content-Type: application/json" \
     --data '{"ttl": 3600}' \
     "https://rtc.live.cloudflare.com/v1/turn/keys/$CF_TURN_KEY_ID/credentials/generate-ice-servers"
   ```
6. Optional now, needed in Phase 4: in **Realtime → Serverless SFU**, create one app named `rendezvu`. Its **App ID** and **App Secret** go in `CF_CALLS_APP_ID` and `CF_CALLS_APP_TOKEN`.

TURN and the SFU bill by data relayed, with a monthly free allowance. Check the Realtime overview page for the current numbers. A personal project's testing stays well inside it.

---

## Backend requirements (you)

### 1. Shared types (`protocol/src/index.ts`)

```ts
export interface IceServer {
  urls: string[]
  username?: string
  credential?: string
}
export interface IceServersRequest { roomId: string }
export interface IceServersResponse { iceServers: IceServer[] }
```

### 2. Cloudflare TURN client

A small module that knows nothing about rooms or HTTP routes.

- `generateIceServers(ttlSeconds, signal): Promise<IceServer[]>`
- `POST https://rtc.live.cloudflare.com/v1/turn/keys/{CF_TURN_KEY_ID}/credentials/generate-ice-servers`
  - headers: `Authorization: Bearer {CF_TURN_API_TOKEN}`, `Content-Type: application/json`
  - body: `{"ttl": 3600}`
  - success is `201 Created`. Treat any status ≥ 400 as an error, and include the status and Cloudflare's response body in the error message.
- The response is `{"iceServers": [...]}`, an **array**: one entry for STUN, one for TURN with `username` and `credential`. Return the array.
- **Drop URLs on port 53** (`stun:stun.cloudflare.com:53`, `turn:turn.cloudflare.com:53?transport=udp`). Browsers block port 53, so those candidates just time out. Cloudflare's docs recommend filtering them. Remove any entry whose `urls` ends up empty.
  - *Deviation:* the reference passes them through. Filtering costs one line and saves a gathering timeout, so I recommend it. Your call.
- Never log the `username` or `credential`.

### 3. `POST /ice-servers`

| Step | Rule |
|---|---|
| Guard | `guardApiRequest` with `methods: 'POST'`, a limiter of **60/min, burst 120**, the default 16 KiB body cap |
| Method | Not POST → `405` |
| Body | Read and parse the JSON body (a small `readJson(req)` helper in `http/`, which the SFU routes reuse in Phase 4). Invalid JSON, or a missing or empty `roomId` → `400 ROOM_REQUIRED` "roomId is required" |
| Room | `registry.allowActive(roomId)`. Anything but `ok` → `403` with the code and message below |
| Cloudflare | Call the TURN client with **ttl 3600** and an **8 s timeout** (`AbortSignal.timeout(8000)`) |
| Success | `200 {"iceServers": [...]}` and `Cache-Control: no-store` (each response holds fresh credentials and must never be cached) |
| Cloudflare failed | Still `200`, with `{"iceServers": [{"urls": ["stun:stun.l.google.com:19302"]}]}`, and log the failure |

Room refusals. These codes and messages are shared with the SFU routes in Phase 4, so write the mapping once, for example `roomAccessError(access)` next to the registry:

| `allowActive` result | Code | Message |
|---|---|---|
| `not-started` | `ROOM_NOT_STARTED` | This meeting has not started yet. |
| `expired` | `ROOM_EXPIRED` | This meeting is no longer active. |
| `unknown` | `ROOM_NOT_FOUND` | This meeting is not active. |

*Why `200` with STUN on failure, not `502`:* the client can't do anything better with an error. A usable answer keeps easy-network calls working, and the logs still show the outage.

*Why the client's own timeout is shorter (5 s) than the server's (8 s):* the client retries. A server that waited longer than the client would keep calling Cloudflare for requests nobody is waiting for any more. That's harmless, but the order matters: the client gives up first and asks again.

### 4. Missing keys

If `CF_TURN_KEY_ID` or `CF_TURN_API_TOKEN` is empty:
- log a warning once at startup: `CF_TURN_KEY_ID / CF_TURN_API_TOKEN not set; /ice-servers will return STUN only`
- skip the Cloudflare call and return the STUN fallback straight away

So `npm run dev` works for a fresh clone without Cloudflare keys, and calls on one machine or one Wi-Fi still connect.

### 5. Logs

```
ice_servers room=<code> source=cloudflare
ice_servers room=<code> source=fallback
ice_error room=<code> error="cf turn: 401 {...}"
```

A client that disconnects mid-request aborts the call. Log that as `ice_error … error=aborted`, not as a Cloudflare failure.

### 6. Suggested layout

```
signaling/src/
  http/read-json.ts         readJson(req): Promise<unknown>, used again by /sfu/* in Phase 4
  meets/room-access.ts      roomAccessError(access) → {status, code, message}
  turn/cloudflare-turn.ts   generateIceServers(); knows only Cloudflare
  turn/routes.ts            iceServersHandler(registry, turnClient, allowedOrigins)
  index.ts                  wire '/ice-servers'
```

### 7. Not in this phase

- **Checking that the caller is in the room.** Anyone who knows an active code can get credentials, as in the reference. The SFU routes check session ownership in Phase 4, and signed tokens on every call API arrive in Phase 11.
- **Revoking credentials** on leave. They expire on their own within the hour.
- **Caching credentials** between callers. Each caller gets their own, so one leaked password can't be shared across a room.

---

## Frontend (Claude)

- **`services/api/ice.ts`**
  - `fetchIceServers(roomId)`: up to 3 attempts, each with a 5 s timeout, waiting about 0.5 s and then 1 s between them (with jitter).
  - `startIceServerKeepalive(roomId, onRefresh, onError)`: fetches again every 45 minutes. If a refresh fails, it tries again after 1 minute while the old credentials are still valid.
- **In `useCall`, after `joined`:**
  1. Fetch ICE servers. If every attempt fails, wait about 1 s and run the whole fetch once more.
  2. If that also fails, the call continues without TURN, and a warning toast says: "Could not reach the connection relay. The call may not work on restrictive networks."
  3. Store the servers in the peer store (`iceServers`). In Phase 4, `SfuSession` reads them from there.
  4. Start the keepalive, and stop it when the call ends.
- **A TURN check page at `/turn-check`.** It's part of the normal build, so it works on the deployed site too, which is where a phone on mobile data tests it best. It's loaded on demand, so it costs the main bundle nothing. It creates a meeting, joins it, fetches ICE servers, and connects two `RTCPeerConnection`s to each other inside one tab with `iceTransportPolicy: 'relay'`. Then it shows the selected candidate pair from `getStats()`. `relay` on both sides proves that the credentials work and that Cloudflare relays your traffic. It's the only way to test TURN before Phase 4 has an SFU, so it goes beyond what the reference has.

## Done when

1. `curl` from the setup section returns `201` with TURN URLs.
2. After joining a room, the browser's Network tab shows `POST /ice-servers` → `200`, with `turn:` URLs and no `:53` URLs.
3. `POST /ice-servers` for a code that was created but never joined → `403 ROOM_NOT_STARTED`. For a made-up code → `403 ROOM_NOT_FOUND`.
4. With a wrong `CF_TURN_API_TOKEN`: the response is `200` with only the Google STUN URL, the server logs `ice_error`, and the browser shows nothing (STUN came back, so nothing is wrong from its point of view).
5. With no keys at all: the startup warning appears, and the response is STUN only.
6. 120 quick requests succeed, then `429`.
7. `/turn-check` shows `relay` for the selected candidate pair, on your laptop and on your phone over mobile data.

## Testing the server without the client

```bash
# create a meeting, then join it once (wscat, see Phase 1) so it's active
CODE=$(curl -s -X POST http://localhost:8080/meets/new | sed -E 's/.*"meetCode":"([^"]+)".*/\1/')

curl -s -X POST http://localhost:8080/ice-servers \
  -H 'Content-Type: application/json' \
  --data "{\"roomId\":\"$CODE\"}"
```
