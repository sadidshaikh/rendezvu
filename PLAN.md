# Rendezvu — Build Plan

Rendezvu lets someone share a booking link. Another person picks a time slot, and at that time they both meet on a video call in the browser.

We build it in two parts:

1. **The live call.** Joining a room, publishing your camera and mic, seeing and hearing everyone else, plus every in-call feature and the reliability work that keeps calls alive on real networks. This comes first.
2. **The product around it.** Accounts, booking pages, availability, calendar sync and email. This comes after the call works end to end.

Each phase below says what we build, **why it comes at that point**, what you'll learn, and how to check that it works. Every phase gets its own short design doc in `docs/` when we start it. This file is the map.

---

## 1. Where we end up

```
                     ┌───────────────────────────────┐
                     │  client/   React + Vite       │  call UI, lobby, devices,
                     │  (browser)                    │  WebRTC (publish/subscribe)
                     └───┬───────────┬───────────┬───┘
            WebSocket    │   HTTPS   │           │  WebRTC media (UDP, or TURN)
   room state, who's here│ /ice-servers, /sfu/*  │
                     ┌───▼───────────▼───┐   ┌───▼──────────────────────────┐
                     │ signaling/        │   │ Cloudflare Realtime          │
                     │ Node.js           ├──►│  • SFU: receives and forwards│
                     │ rooms, presence,  │   │    every media track         │
                     │ SFU proxy, TURN   │   │  • TURN: relay for blocked   │
                     └───────┬───────────┘   │    networks                  │
                             │ verifies JWT, └──────────────────────────────┘
                             │ asks "can this user join this room?"
                     ┌───────▼───────────┐
                     │ api/              │   added in Part 2
                     │ Spring Boot       │   auth, users, booking,
                     │ + Postgres        │   availability, calendar, email
                     └───────────────────┘
```

| Folder | Tech | Owner | Does |
|---|---|---|---|
| `client/` | React + Vite + TypeScript | Claude builds, you review | Call UI and all browser-side WebRTC |
| `signaling/` | Node.js + TypeScript (`ws`) | **You build**, Claude writes requirements and reviews | Rooms, presence, the message protocol, the Cloudflare proxy |
| `api/` | Java Spring Boot | **You build** (Part 2) | Everything that isn't the live call |
| `docs/` | Markdown | Both | One design doc per phase |

The folders are created when their first phase starts.

### Three ideas the whole design rests on

1. **The server never touches audio or video.** Media goes from your browser to Cloudflare's SFU, which forwards it to everyone else. The Node server only coordinates: who's in the room, which tracks each person publishes, and passing SDP to Cloudflare.
2. **Each person uploads their video once.** In MeetGreet (peer-to-peer) you'd upload one copy per person in the room. With an SFU you upload one copy and Cloudflare sends it on to everyone. That's what makes rooms of 10 people possible.
3. **Secrets stay on the server.** The Cloudflare tokens live only in Node. The browser asks Node, and Node asks Cloudflare. This is why the browser makes so many calls to *our* server instead of calling Cloudflare directly.

---

## 2. How a call works (the target)

You'll build every piece of this. Each step names the phase that builds it.

1. **Lobby** (Phase 2). The browser opens camera and mic and shows a preview. You type a name and pick devices.
2. **Connect** (Phase 1). The browser opens a WebSocket to Node. Node replies `welcome` with your peer id.
3. **Join** (Phase 1). The browser sends `join {room, name, audio, video}`. Node replies `joined` with the people already in the room and tells them `peer-joined`.
4. **TURN credentials** (Phase 3). The browser calls `POST /ice-servers`. Node gets short-lived credentials from Cloudflare.
5. **Publish** (Phase 4). The browser creates a Cloudflare session through Node, sends an SDP offer for its camera and mic, applies the answer, and connects to the SFU. Then it tells Node `sfu-announce {sessionId, tracks}`.
6. **Tell the room** (Phase 5). Node stores your track list and sends `sfu-tracks` to everyone else. It also replays the list to anyone who joins later.
7. **Subscribe** (Phase 5). Every other browser asks Cloudflare (through Node) for your tracks. Cloudflare sends an offer, the browser answers, and your video appears.
8. **During the call** (Phases 6–10). `peer-state` shares mute, camera and speaking status. Heartbeats, snapshots and repair keep the call alive. Video quality adapts to the network.
9. **Leave** (Phase 1, finished in Phase 9). The browser sends `leave`, closes its SFU sessions and stops its devices. Node tells the room `peer-left`.

---

## 3. Part 1: The live call

Phase 0 sets up the project. Phases 1–5 get a real multi-person call working, which is the first big milestone. Phases 6–14 turn it into something people can rely on.

### Phase 0: Project setup and accounts

**Build:**
- The `rendezvu/` repo with `client/`, `signaling/` and `docs/`.
- TypeScript in both projects, and shared message types (the protocol defined once, used by both sides).
- `.env` files and a config loader for ports, allowed origins and Cloudflare keys.
- Local HTTPS using one self-signed certificate for both the Vite dev server and Node, the same idea as MeetGreet.
- A Cloudflare account with a **Realtime SFU app** (app id + app token) and a **TURN key** (key id + API token).

**Why first:** Camera access needs HTTPS. Every later phase needs the config and the Cloudflare keys. Writing the message types once in TypeScript means a typo in a message name shows up as a compile error, not a silent bug during a call.

**You'll learn:** how the two processes find each other in dev and why secrets go in `.env` and never in the client bundle.

**Done when:** `npm run dev` starts both, `/healthz` returns `ok`, and the app loads on `https://localhost:3000` and on your phone over the LAN. ✅ Done (see `docs/00-setup.md`).

---

### Phase 1: Rooms and presence (signaling with no media)

**Build (Node, you):**
- `GET /ws` WebSocket upgrade. Each connection gets a random **peer id**, sent in `welcome`.
- A small domain model: `Hub` (all rooms) → `Room` (its peers) → `Peer` (one socket, name, media flags).
- Messages: `join`, `joined {peers}`, `peer-joined`, `peer-left`, `leave`, `error {code, message}`.
- Input checks: bad JSON, unknown type, missing or invalid room code.
- `ping` → `pong`, and close sockets that have sent nothing for 60 s, so dead connections leave the room within a minute.
- Origin checks on the WebSocket upgrade, plus a shared HTTP guard (CORS, rate limit, body size cap) that later endpoints reuse.
- Cleanup on disconnect: remove the peer, tell the room, delete empty rooms.
- `POST /meets/new` creates an **instant meeting** and returns a code shaped `abc-defg-hij` (3-4-3). The letters leave out look-alikes such as `l`, `o`, `0` and `1`.
- An instant-room registry in memory:
  - A room becomes active on its first join.
  - It expires 12 hours after creation, or after it has been empty for a grace period.
  - Joining an unknown or expired room gets `error` with `ROOM_UNAVAILABLE` or `ROOM_EXPIRED`.
- `GET /room/status?code=…`, so the lobby can say "this meeting has ended" before anyone tries to join.

**Build (client, Claude):** a home page with a "New meeting" button that calls `/meets/new`, and a room page at `/room/:meetCode` showing the participant list live.

**Why now:** This is the skeleton every other feature hangs on. MeetGreet only worked for two anonymous peers. A real app needs ids and names, because once there are three or more people, every track and every status message must say *whose* it is. Doing this before media means you can test it with just two browser tabs and the console.

**You'll learn:** connection lifecycle (open → join → leave/close), why cleanup must run on both `leave` and `close`, and why server-side state is the source of truth.

**Done when:** three tabs join the same room and each shows the other two. Closing a tab removes it from the others within a second. ✅ Done (see `docs/01-rooms-and-presence.md`).

---

### Phase 2: Local media and the lobby

**Build (client):**
- A lobby with camera preview, mic level meter, device selectors (camera, mic, speaker), and a name field.
- `getUserMedia` with fallbacks: if camera and mic together fail, try each alone, and explain `NotAllowedError`, `NotFoundError` and `NotReadableError` in plain words.
- A media store (Zustand) that holds local tracks and the user's intent ("mic on, camera off"). Everything later reads from it.

**Why now:** Before sending media anywhere, we need reliable local media. Most failed calls in real life are device problems, not network problems: permission denied, the camera in use by another app, no mic. Handling those first keeps them from being mistaken for SFU bugs later.

**You'll learn:** tracks vs streams, device ids, and why "what the user wants" (intent) is stored separately from "what's actually running" (live tracks).

**Done when:** you can switch camera and mic in the lobby, see the meter move, deny permission and get a clear message, then join the room from Phase 1 with your name. ✅ Done (see `docs/02-local-media-and-lobby.md`).

---

### Phase 3: ICE servers and TURN

**Build (Node, you):**
- `POST /ice-servers {roomId}` calls Cloudflare's TURN API (`generate-ice-servers`, 1-hour TTL) and returns `{iceServers}`.
- A timeout on the Cloudflare call, and a STUN-only fallback if Cloudflare fails, so the call can still try.
- Only answer for a room that is active right now, using the room registry from Phase 1. This is why the client asks only after `joined`: an instant room becomes active on its first join.

**Build (client):** fetch ICE servers after `joined`, retry once, warn the user if it fails, and refresh before the credentials expire.

**Why now:** The next phase opens the first real WebRTC connection, and it needs these servers. TURN is the piece MeetGreet never had. It's how calls work on hotel Wi-Fi, office firewalls and strict mobile networks: the place where your phone's video went missing.

**You'll learn:** short-lived credentials, the STUN vs TURN difference in practice, and what happens when you force `iceTransportPolicy: 'relay'`.

**Done when:** a quick test page connects with `relay` only, and the selected candidate type shows `relay`. ✅ Built and passing on the laptop (see `docs/03-ice-servers-and-turn.md`). Mobile-data check waits for Phase 14.

---

### Phase 4: Publish to the SFU

**Build (Node, you):** the SFU proxy. Each route checks that the caller owns the session, then forwards to Cloudflare with the secret app token:

| Route | Forwards to Cloudflare | Purpose |
|---|---|---|
| `POST /sfu/sessions/new?roomId&peerId&kind` | `sessions/new` | Create a session; remember which peer and room own it |
| `POST /sfu/sessions/:id/tracks/new` | `tracks/new` | Publish (send offer, get answer) or subscribe (ask for remote tracks) |
| `PUT /sfu/sessions/:id/renegotiate` | `renegotiate` | Send the browser's answer back |
| `PUT /sfu/sessions/:id/tracks/update` | `tracks/update` | Change a track (used later) |
| `PUT /sfu/sessions/:id/tracks/close` | `tracks/close` | Stop a track |
| `DELETE /sfu/sessions/:id` | none | Forget the session |

Cloudflare's JSON errors are forwarded unchanged so the client can read them. Every response is valid JSON, even an empty `{}`.

**Build (client):** an `SfuSession` class that owns all `RTCPeerConnection` code. It creates the publish session, pushes camera and mic, and reports when Cloudflare has accepted them.

**Why now:** Publishing is half of a call and can be tested alone. A neat trick: subscribe to your *own* tracks and you'll see your video come back from Cloudflare, proving the full round trip without a second person.

**You'll learn:** what a "session" and a "track" are to an SFU, why the offer goes to Cloudflare instead of another person, and why ICE candidates never pass through our server (Cloudflare's answer already lists its addresses).

**Done when:** your video loops back through Cloudflare and `chrome://webrtc-internals` shows bytes going up. ✅ Built; the loopback passes (see `docs/04-publish-to-the-sfu.md`). Mobile-data check waits for Phase 14.

---

### Phase 5: Subscribe — the first real multi-person call

**Build (Node, you):**
- `sfu-announce {sessionId, tracks}` from a publisher. Store it on the room, **replacing** the old set, and send `sfu-tracks` to everyone else.
- On join, replay every stored `sfu-tracks` to the newcomer.
- On leave, drop that peer's tracks.

**Build (client):**
- On `sfu-tracks`, subscribe through a **separate subscribe session for each remote person**, so one person's problems can't break the others.
- Build each person's `MediaStream` from their audio and video and show it in a tile.

**Why now:** This completes the core loop. The announce happens only *after* Cloudflare confirms the publish, so nobody tries to pull a track that isn't live yet. Replaying on join is what lets a late joiner see people who were already there.

**You'll learn:** the difference between telling the room once (an event) and storing the current state so it can be resent (level-triggered state), which becomes the key idea in Phase 8.

**Done when:** three devices (one on mobile data) are in one call, everyone sees and hears everyone, and someone joining late sees all the existing people. ✅ Built; tested with tabs and a phone on Wi-Fi (see `docs/05-subscribe.md`). Mobile-data check waits for Phase 14.

> **Milestone 1: a working group video call.**

---

### Phase 6: In-call controls and shared status

**Build:**
- Mic and camera toggles. Muting swaps in a silent placeholder track with `replaceTrack`, so the connection doesn't renegotiate every time.
- Switching devices during the call, flipping between front and back camera on phones, and choosing the speaker output.
- Screen share with `getDisplayMedia`, swapped onto the same video sender as the camera (no new track), with "stop sharing" detection.
- `peer-state {audio, video, speaking, screenSharing}` over the WebSocket, so others show "muted" or an avatar instead of a frozen frame.
- A bounded send queue per connection (Node, you). Room events (`joined`, `peer-joined`, `peer-left`, `sfu-tracks`) wait up to 2 s for space, then log `signaling_send_timeout`; `peer-state` is best effort and dropped if the queue is full. Today the WebSocket library buffers without limit until the 60 s idle timeout, so one slow phone would make the server hold every update sent to it. `peer-state` is the first message frequent enough for that to matter.

**Why now:** With the call working, these are the features people touch every minute. `replaceTrack` vs renegotiation is the key lesson: swapping a track is instant, while adding a new one needs a new SDP round trip.

**You'll learn:** when SDP must be renegotiated and when it doesn't, and why camera state goes over signaling instead of being guessed from the video.

**Done when:** toggling anything on one device updates every other device within a second, and screen share works from desktop Chrome, Firefox and Safari. ✅ Built; tested with tabs (see `docs/06-in-call-controls.md`). Device checks (Firefox, Safari, phones, unplugging) wait for your run.

---

### Phase 7: The call screen

**Build (client):**
- A responsive video grid that fits 1–10 people at any screen size.
- Pin a person to make them large. Highlight whoever is speaking, using an audio level meter.
- An avatar when the camera is off, a copy or share link, join, leave and screen-share sounds, and a leave button. (The time-left timer only exists for booked sessions, so it comes with bookings.)
- Leaving cleans up everything: stop devices, close sessions, cancel timers.

**Why now:** By now there's enough data (names, tracks, states) to build the real layout once instead of rebuilding it every phase.

**You'll learn:** why the remote `<video>` needs a **new** `MediaStream` object when a track arrives (adding to an existing one doesn't fire the event React relies on).

**Done when:** a 6-person call looks right on a laptop and a phone, and leaving leaves no camera light on and no open connections. ✅ Built; tested with tabs on laptop and phone sizes (see `docs/07-the-call-screen.md`). The 6-device check waits for your run.

---

### Phase 8: Signaling that survives disconnects

**Build (Node, you):**
- Heartbeat on the client side (the server half exists since Phase 1): two missed pongs mean the socket is dead, so close it and reconnect.
- **presenceId**: a stable id the browser keeps across reconnects in `sessionStorage`, so each tab is its own person. When it rejoins, the server replaces the old entry instead of showing a duplicate person.
- `sync` → `room-snapshot {version, peers, tracks}`: the whole room state with a version number. Sent on request and pushed on a timer every 15 s.
- Version numbers on `sfu-tracks`, so clients ignore stale updates.
- Cloudflare sessions owned by the `presenceId` instead of the peer id, so a reconnect can keep using them. Sessions of a socket that closed without `leave` are kept for 2 minutes.

**Build (client):**
- Reconnect with backoff and a "Reconnecting…" banner.
- After reconnecting: rejoin, wait for `joined`, re-send `peer-state` and `sfu-announce`, then `sync`. **Keep the SFU media running**; only the WebSocket dropped.
- A **reconciler**: it holds what the room says should be flowing, compares it with what we're subscribed to, and closes the gap by pulling missing tracks and dropping stale ones.

**Why now:** Until now, every message assumed nothing gets lost. On real networks, WebSockets drop often, especially on phones. If someone misses one `sfu-tracks` message, they'd never see that person. Snapshots fix this: whatever was missed, the next snapshot shows the true state and the reconciler catches up.

**You'll learn:** edge-triggered vs level-triggered design (the most important reliability idea in this project), heartbeats, and making repeated messages safe.

**Done when:** you turn Wi-Fi off for 10 seconds on one device, turn it back on, and the call recovers without anyone rejoining or seeing a duplicate person. ✅ Built; a forced signaling drop recovers in two tabs with no duplicate and no rebuilt publish connection (see `docs/08-signaling-that-survives-disconnects.md`). The real Wi-Fi-off check waits for your run.

---

### Phase 9: Media that survives problems

**Build (client):**
- Watch each connection's state and **media byte flow**, using `getStats` every few seconds.
- A repair ladder for each direction:
  - **Rung 1**: retry the publish or subscribe.
  - **Rung 2**: rebuild that session.
  - Short blips get a grace period first, so a 2-second dip doesn't tear down a working connection.
- Dead-track detection: we subscribed, there was no error, but no media arrived. Repair it.
- **Generations**: every async operation remembers which session it belongs to. A slow answer from an old session can't overwrite the new one.
- Leaving cancels everything, so no late callback can restart the camera after leave.
- Handle a camera unplug, a permission revoked mid-call, and the tab going to the background.

**Why now:** Phase 8 made the *signaling* reliable. This phase does the same for *media*. Real calls fail quietly: video freezes while the connection still says "connected". Byte flow is the truth, not connection state.

**You'll learn:** why "connected" doesn't mean "working", how to make async code safe against stale results, and why leaving the call is the point where all pending work gets cancelled.

**Done when:** blocking UDP for 5 seconds freezes and then recovers on its own, toggling the camera fast ends in the last state you chose, and leaving during setup leaves nothing running. ✅ Built; tested in headless tabs with injected faults (a hung pull, frozen stats, a sender that stops, fast toggles, leaving 22 ms after joining; see `docs/09-media-that-survives-problems.md`). The real UDP-blocking check waits for your run.

---

### Phase 10: Adaptive video quality

**Build (client):**
- A sender quality ladder: **900 kbps / 24 fps → 500 kbps / 20 fps → 200 kbps / 15 fps**.
  - Step down after 6 s of high latency or low bandwidth.
  - Step back up one level after 20 s of healthy readings.
- Audio-first: under severe pressure at the lowest level, pause your video (only if your mic is on). The others are told `videoHeld` and show your avatar instead of a frozen image.
- A quality dot for each person, and a diagnostics panel: RTT, packet loss, jitter, bitrate, resolution, and candidate type (direct or relay).

**Build (Node, you):** accept `stats-report` from browsers for monitoring.

**Why now:** On weak connections, people would rather hear clearly than see blurry video that keeps freezing. This builds on the stats loop from Phase 9.

**You'll learn:** `RTCRtpSender.setParameters`, congestion signals, and hysteresis (wait before stepping down and longer before stepping up, so quality doesn't flip back and forth).

**Done when:** throttling your network in DevTools lowers quality step by step, audio stays clear, and quality comes back after the throttle is removed.

---

### Phase 11: Admission, room access and hardening

**Build (Node, you):**
- Guest admission: a guest without a token sends `join` with `needsAdmit: true`, then `knock`. People in the room get `knock-request` and can admit or deny. Admit sends the guest `knock-granted` with a room-scoped token. The room doesn't see the guest until they're admitted.
- A **room access check** behind one function: is this room active right now, and may this user join it? For now this uses a temporary dev token from Node. In Part 2 it becomes a real check against Spring Boot.
- Every `/sfu/*` and `/ice-servers` request needs a valid token.
- Rate limits for each peer and each IP on `/sfu/sessions/new`, request size limits, an origin allowlist, and timeouts on every Cloudflare call.

**Build (client):** a knocking screen for guests, and admit/deny/admit-all prompts for people in the room.

**Why now:** The call is solid, so now we decide who can get in. Doing this behind a token check now means Spring Boot can plug in later without touching call code. It also protects the Cloudflare bill: without limits, anyone could create sessions on your account.

**You'll learn:** room-scoped tokens, why rate limits are per peer *and* per IP (a group behind one office NAT vs one runaway client), and where trust boundaries sit.

**Done when:** a guest waits until admitted, a request without a token gets `401`, and a script hammering `sessions/new` gets `429` while the real call continues.

---

### Phase 12: Background blur and noise suppression

**Build (client):**
- Background blur and background effects using MediaPipe segmentation, processed on a canvas and published with `replaceTrack`.
- Noise suppression with an AudioWorklet (and WASM).
- A settings panel with toggles that remembers your choices. If the effect fails to load, fall back to the raw track and never crash the call.

**Why now:** These are optional extras that run on top of the media pipeline, so they come once that pipeline is stable.

**You'll learn:** processing video frames in the browser, AudioWorklets, and why effects need a fallback path.

**Done when:** blur and noise suppression toggle mid-call with no renegotiation, and blocking the model file falls back to normal video.

---

### Phase 13: Observability

**Build (Node, you):**
- Prometheus metrics: active rooms and peers, WebSocket reconnects, SFU request durations and errors by route, and TURN fetch failures.
- Accept `client-metric` from browsers: time to first media (TTFM), setup phases (ICE gathering, publish connected, subscribe connected, first frame), call attempts (success, timeout, error), repair attempts and recoveries.
- Labels stay bounded: never room ids or user ids.
- Structured logs, and Sentry for errors.

**Build (client):** send those metrics, report Sentry errors tagged with the call stage, and add a debug log you can turn on.

**Why now:** Before anyone else uses the app, you need to see when calls fail and why. Without this, "the call didn't work" is all you'll ever hear.

**You'll learn:** which measurements only the browser can take, histogram design, and why high-cardinality labels break Prometheus.

**Done when:** a Grafana dashboard shows TTFM p95, connection success rate and repair counts for a test call.

**Then:** use the setup-phase timings to work through the [optimisation backlog](#8-optimisation-backlog).

---

### Phase 14: Deploy and test for real

**Build:**
- Deployment: the client on a static host, Node on a host that supports WebSockets, and real TLS. One environment: the same Cloudflare TURN key and SFU app as local development.
- Run on real devices and real networks:
  - 2 people on different networks for 15 minutes
  - switching between Wi-Fi and mobile data
  - 4 mixed desktop and mobile devices
  - 10 people
- Targets: TTFM p95 under 3 s, connection success at least 99.5%, and no frozen video lasting more than 6 s.
- Optional, if you ask for it later: automated browser call tests with fake camera input.

**Why now:** Local testing hides real network behaviour. This is where you find the bugs that only show up on mobile data or behind strict NATs.

**Done when:** the targets hold on the deployed app with real devices.

> **Milestone 2: the live call is done.** It works, it recovers, it adapts to the network, and you can measure it.

---

## 4. Part 2: The product (Spring Boot)

Only an outline for now. Each phase gets a design doc when we reach it.

| Phase | Build | Why it's at this point |
|---|---|---|
| 15. Spring Boot base | `api/` project, Postgres, migrations, error format, config | Foundation for everything below |
| 16. Accounts and auth | Google sign-in, access JWTs (HS256) plus refresh tokens. Spring signs them; Node verifies them with the same shared secret | Replaces the Phase 11 dev token without changing call code |
| 17. Booked meetings | Each booking gets a meeting code. Node's room access check asks Spring whether a booked room is open right now. Instant rooms stay in Node's registry | Booked calls open at their scheduled time |
| 18. Event types and availability | Meeting types (e.g. 30 min), weekly hours, time zones | What people can book |
| 19. Booking | Public booking page, open slots, temporary slot holds while someone books, confirm, cancel, reschedule | The core of the product |
| 20. Guest links | A booking email includes a link with a guest token that gives access to only that room at that time | Lets booked guests skip the knock screen |
| 21. Calendar sync | Google Calendar: block busy times and add bookings as events | So bookings don't clash with real life |
| 22. Email | Confirmations and reminders through an outbox table and a background worker | Reliable email even if the mail provider is down |
| 23. Plans and limits | Free and paid tiers: call length, room size, features | How the product earns money |
| 24. Dashboard and site | Bookings list, setup checklist, landing page, pricing, legal pages | Everything a signed-in user sees outside a call |

---

## 5. Final message protocol (reference)

Built up phase by phase. Shared as TypeScript types between `client/` and `signaling/`.

| Message | Direction | Phase | Purpose |
|---|---|---|---|
| `welcome` | server → client | 1 | Your peer id |
| `join` / `joined` | client ↔ server | 1 | Enter a room / who's already here |
| `peer-joined` / `peer-left` | server → room | 1 | Someone arrived or left |
| `leave` | client → server | 1 | Leave on purpose |
| `error` | server → client | 1 | `{code, message}` |
| `sfu-announce` | client → server | 5 | The complete set of tracks I publish now |
| `sfu-tracks` | server → room | 5 | Someone's tracks are ready to pull |
| `peer-state` | client ↔ room | 6 | Mute, camera, speaking, screen share, video held |
| `ping` / `pong` | client ↔ server | 8 | Heartbeat |
| `sync` / `room-snapshot` | client ↔ server | 8 | Full room state with a version number |
| `stats-report` | client → server | 10 | Connection quality |
| `knock`, `knock-request`, `knock-admit`, `knock-granted` | mixed | 11 | Guest admission |
| `client-metric` | client → server | 13 | Browser-only measurements |

## 6. Live-call feature checklist (Part 1 is done when all are checked)

- [ ] Lobby: preview, mic meter, device selection, name, permission errors
- [ ] Rooms with readable codes, a new meeting button, a share link
- [ ] Group calls up to 10 people through the SFU, with TURN fallback
- [ ] Mic, camera, flip camera, speaker output, device switching mid-call
- [ ] Screen share
- [ ] Grid, pin, speaking indicator, avatars, call timer
- [ ] Remote status: muted, camera off, sharing, video held
- [ ] WebSocket reconnect without dropping media; no duplicate people
- [ ] Room snapshots and a reconciler; late joiners always see everyone
- [ ] Media repair ladder, dead-track detection, grace periods, stale-result safety
- [ ] Adaptive quality ladder with audio-first mode
- [ ] Quality dots and a diagnostics panel
- [ ] Guest knock and admit
- [ ] Tokens on every call API; rate limits; origin checks
- [ ] Background blur and effects, noise suppression
- [ ] Metrics, error tracking, dashboards
- [ ] Deployed and tested on real devices and networks

## 7. How we work

- **Same behaviour as the app we're modelling.** Every design doc writes down the exact behaviour we're matching: message shapes, error codes, timings, limits and thresholds. Rendezvu's own stack choices (Node and Spring Boot instead of one server) are the only intended differences.
- **One phase at a time.** Each starts with a design doc in `docs/` (for example `docs/01-rooms-and-presence.md`) and ends when its "Done when" check passes.
- **Backend (`signaling/`, later `api/`): you write it.** Claude writes the requirements and the message shapes, answers questions and reviews your code.
- **Frontend (`client/`): Claude builds it, you review it.** You decide what the call should do; Claude handles the details.
- **No phase gets skipped.** Each one fixes a problem you'll have just seen in the previous phase, which is what makes the "why" obvious.

## 8. Optimisation backlog

Things that work but could be faster. None is scheduled yet; each waits for real numbers (Phase 13's setup-phase timings, or temporary console timings before that) so we fix the slowest step, not the one we guess.

### Video takes a few seconds to appear after someone joins (seen in Phase 5)

Everything after a join runs one step at a time, and each step is a round trip of 100–800 ms:

```
Publisher                                       Subscriber
1. join → joined
2. /ice-servers      (our server asks Cloudflare for TURN)
3. sessions/new
4. tracks/new        (push)
5. connect to Cloudflare (ICE + DTLS)
6. confirmed → sfu-announce ───────────────►  7. sfu-tracks arrives
                                              8. sessions/new  (a new connection for this person)
                                              9. tracks/new (pull) + renegotiate
                                             10. connect to Cloudflare (ICE + DTLS)
                                             11. first full video frame
```

| Suspect | Why it costs time | Possible fix | Trade-off |
|---|---|---|---|
| Steps 8–10: a new subscribe connection per person | The subscriber connects from scratch for each publisher; probably the biggest share | Open a subscribe connection right after joining, before anyone announces; or one shared subscribe connection for everyone | A shared connection loses Phase 5's isolation (one person's renegotiation can disturb another's) |
| Step 2: `/ice-servers` blocks everything | Our server calls Cloudflare's TURN API on every join, and nothing starts until it answers | Reuse credentials per room on the server for their lifetime; or start with STUN and add TURN when it arrives | Starting without TURN fails at first on strict networks |
| Step 6: wait for the confirmation | Deliberate: nobody pulls a track that isn't live yet | Keep | Pulling earlier only fails and retries |
| Step 11: first full video frame | Cloudflare has to ask the publisher for one | Measure first (`framesDecoded` and the time to the first frame in `getStats()`) | Usually small |

**First step when we pick this up:** temporary console timings for steps 1–11 in development, one join, then fix the slowest one or two.
