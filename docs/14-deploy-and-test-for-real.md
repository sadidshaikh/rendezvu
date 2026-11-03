# Phase 14: Deploy and test for real

Status: **frontend built**; backend and deployment next. Hosting: Fly.io + Cloudflare Pages + a custom domain (chosen). Backend and deployment: you · Frontend: Claude

## Goal

Rendezvu runs on the public internet with real HTTPS, and anyone with the link can use it. You create a meeting at `https://<your-site>`, send the link to a friend on another network, and the call works. Deploys are a `git push`. A deploy, a crash or a quiet night never strands people in a broken meeting. Nobody can run up a bill on your Cloudflare account. Then the app is tried for real: real phones, real mobile data, strict networks, ten people. That's where the remaining bugs live.

Because this is a resume project that strangers will click on, three things matter more than usual:
- **The first click must work.** No minute-long cold start while a recruiter waits.
- **It must not cost a surprise.** Every billed service has a ceiling we control.
- **It must look finished:** your own domain if you want one, and a page that says what happens to people's video.

## What it costs

Rendezvu is three separate pieces, and each has its own price.

| Piece | What it needs | Notes |
|---|---|---|
| **Client** (the React build) | Static file hosting with HTTPS | ~27 MB, the largest file 13.5 MB (MediaPipe's WASM) |
| **Signaling server** (Node) | One process that stays up, holds WebSockets for hours, and keeps rooms in memory | Must be **exactly one instance**, always on |
| **Media** (Cloudflare Realtime SFU and TURN) | Your existing Cloudflare app and key | Billed per GB that Cloudflare sends out |

Prices below were checked on **3 November 2026**. They change often, so confirm each one on the provider's own page when you sign up.

### Client: free, no catch

| Host | Free plan | Fits? |
|---|---|---|
| **Cloudflare Pages** | Unlimited bandwidth, 500 builds a month, files up to 25 MiB each | ✅ The 13.5 MB WASM fits. Same account as the SFU. **Recommended.** |
| Netlify, Vercel | Generous free plans | ✅ Either works too |
| GitHub Pages | Free | ⚠️ No custom headers, so no CSP or cache control |

### Media: free up to 1,000 GB a month

Cloudflare's first **1,000 GB of egress a month is free, shared between the SFU and TURN**, then **$0.05 per GB**.

What that buys at our bitrates (900 kbps video plus audio, Phase 10):
- Each person *receives* about 0.45 GB an hour per other person on screen.
- A 2-person hour is about 0.9 GB of egress in total, a 4-person hour about 5.4 GB.
- So the free 1,000 GB covers roughly **1,100 two-person call-hours** or **185 four-person call-hours** a month.

A resume project won't come near that, but a script abusing it could, which is why this phase adds a hard daily cap (below).

### Signaling server: the only real cost

The server is the hard part. Many "free" hosts put an idle app to sleep and start it again on the next request. For a WebSocket server that keeps its rooms in memory, that means:
1. **A cold start** of up to a minute for the first visitor.
2. **Lost state on sleep:** every meeting code created earlier stops working.

| Host | Price | WebSockets | Sleeps? | Verdict |
|---|---|---|---|---|
| **Render Free** | $0 | ✅ | After 15 min with no traffic; about 1 min to wake | ⚠️ Works, but the first visitor waits a minute, and links from yesterday are dead. Fine for a demo you introduce in person. |
| **Koyeb Free** | $0, one instance | ✅ | After 60 min idle | ⚠️ Same problem, a little later |
| **Oracle Cloud Always Free** | $0 for a small Arm VM | ✅ (it's a whole VM) | Never | ⚠️ Truly free and always on, but signup needs a card and often fails with "out of capacity". You run the OS, TLS and updates yourself. Recent reports say the free Arm allowance was cut in 2026. Good DevOps practice, risky as the only plan. |
| Google Cloud Run | Free tier | ✅, but every connection is cut after at most 60 min | Scales to zero | ❌ Wrong shape: several instances, cut-off sockets |
| **Fly.io** | **≈ $2.20/month** (shared-cpu-1x, 256 MB, always on). No free tier for new accounts. | ✅ | Never | ✅ **Recommended.** Cheapest always-on option, TLS and a `*.fly.dev` name included, deploys from a Dockerfile. |
| Railway Hobby | $5/month (credits included) | ✅ | No | ✅ Simple, a bit more |
| Render Starter | $7/month | ✅ | No | ✅ Simple, more again |
| Hetzner CX/CAX | ≈ €4.50–5.50 + €0.50 IPv4 | ✅ | No | ⚠️ Cheap, but its smallest plans were often unavailable in autumn 2026, and you manage the server |

### Recommendation

| Piece | Choice | Monthly |
|---|---|---|
| Client | Cloudflare Pages | $0 |
| Server | Fly.io, 1 × shared-cpu-1x 256 MB, plus a 1 GB volume for room state | ≈ $2.20 + ≈ $0.15 |
| Media | Cloudflare SFU and TURN | $0 under 1,000 GB |
| Domain (needed by Part 2, see below) | e.g. `rendezvu.dev` through Cloudflare Registrar, which sells at cost | ≈ $1/month (≈ $10–15 a year) |
| **Total** | | **≈ $2.50/month**, or ≈ $3.50 with a domain |

- **If it must be $0:** Cloudflare Pages plus Render Free, keeping in mind the 1-minute wake-up and links dying while idle. Everything in this doc works there too, because the server ships as a plain Dockerfile; only the platform file differs.
- **Moving later is cheap:** the Dockerfile runs unchanged on Fly, Render, Railway, Koyeb or any VM.

### Planning for Part 2: Spring Boot and Postgres

Part 2 (Phases 15–24) adds a Spring Boot API (`api/`) and a Postgres database (accounts, bookings, availability). Nothing of it is deployed now, but two choices made in this phase decide how easily it slots in later.

**What it adds to the bill:**

| Piece | Option | Monthly | Notes |
|---|---|---|---|
| Spring Boot API | Fly.io machine, 1 GB | ≈ $6.70 | Comfortable for the JVM |
| | Fly.io machine, 512 MB | ≈ $3.70 | Works with tuning: heap capped near 256 MB, Tomcat threads cut to about 50 |
| Postgres | **Neon Free** | $0 | 0.5 GB storage and 100 compute-hours a month; sleeps after 5 min idle and wakes in well under a second, which suits a low-traffic API. **Recommended to start.** |
| | Supabase Free | $0 | 500 MB, but the whole project pauses after a week without activity, and someone has to resume it |
| | Fly Managed Postgres, or Neon/Supabase paid | $20+ | Later, only if real usage needs it |

**Two ways to run the whole thing:**

| | All on Fly + Neon | One VPS with Docker Compose |
|---|---|---|
| What | Node (256 MB) + Spring Boot (512 MB–1 GB) on Fly, Postgres on Neon, client on Pages | Node, Spring Boot, Postgres and Caddy (TLS) on one small VM, client on Pages |
| Monthly | **≈ $6–9** | ≈ €5–6 (e.g. a 4 GB Arm VM), or $0 on Oracle Always Free if you get capacity |
| You manage | Nothing below the app | The OS, updates, backups, TLS renewal, the firewall |
| Resume angle | Managed platforms, CI/CD, secrets | Linux and Docker operations as well |
| Risk | Prices creeping up | The cheapest VPS plans were often sold out in 2026; backups are on you |

**Recommendation:** start Phase 14 on Fly (Node only, ≈ $2.50) and add Spring Boot as a second Fly app with Neon in Phase 15, for about **$6–9 a month all in**. Everything ships as Docker images, so moving all of it to one VPS later is a weekend's work if the bill matters more than the time.

**The two choices to make now:**
- **Buy a custom domain** (≈ $10–15 a year). Part 2's refresh tokens live in an `HttpOnly` cookie set by the API. Between `*.pages.dev` and `*.fly.dev`, that cookie is *third-party*, and Safari and Chrome block third-party cookies, so sign-in would silently fail. Under one domain they're same-site and work:
  - `rendezvu.dev` → the client (Pages)
  - `signal.rendezvu.dev` → Node (Fly)
  - `api.rendezvu.dev` → Spring Boot (Fly, Phase 15)
- **One region for everything.** Put the Fly region and, later, the Neon region in the same place (e.g. both in Frankfurt, or Mumbai and Singapore). Node will ask Spring Boot "may this user join this room?" in Part 2 (the `RoomAccess` swap from Phase 11). Over Fly's private network (`http://rendezvu-api.internal:8080`) that's a millisecond away, never leaves Fly, and needs no public endpoint.

## Concepts

**One server, on purpose.** Rooms, waiting lists, SFU session ownership and the quality store all live in one process's memory (Phases 1, 8, 10, 11). Two instances would each hold half the rooms, and two people in the "same" meeting could land on different ones and never meet. So it's **exactly one machine, never auto-scaled**. A single small machine handles thousands of WebSockets; signaling is tiny. Sharing state across instances (Redis) is a real design, and a later one.

**A deploy restarts the one server.** That's a moment with no server. What happens:
1. The platform sends `SIGTERM`. Phase 1's shutdown closes every socket with `1001`.
2. Phase 8 clients show the banner and reconnect within a few seconds.
3. Media to Cloudflare keeps flowing the whole time (Phase 8).
4. On reconnect, each tab rejoins with its token (Phase 11), still valid because `ROOM_TOKEN_SECRET` is fixed.

Two things must survive the restart:
- **The meeting codes themselves** (the instant-room registry): otherwise the rejoin is refused as `ROOM_UNAVAILABLE` and every deploy ends every call. So the registry is saved to a small file on a **persistent volume**: on shutdown, and every 30 s as a backstop for a crash. It's loaded again on start.
- **SFU session ownership** isn't saved. After a restart, `/sfu` calls on old sessions get `404`, and Phase 9's repair rebuilds those connections with new sessions within seconds. People may see a short freeze during a deploy; that's acceptable. Deploy when it's quiet.

**HTTPS everywhere, terminated by the platform.** Browsers only allow camera access on HTTPS, and WebSockets from an HTTPS page must be `wss://`.
- Fly and Pages terminate TLS and hand our server plain HTTP, so `TLS_CERT_FILE` / `TLS_KEY_FILE` stay unset in production.
- Phase 0's self-signed certs are for local development only.

**Which client IP to believe.** Rate limits per address (Phases 4 and 11) and the 20-sockets-per-IP cap depend on knowing the real client address.
- Behind a proxy, every request arrives from the proxy, and the real address is in a header the proxy sets.
- But `clientIp()` today believes *any* of `CF-Connecting-IP`, `X-Real-IP` and `X-Forwarded-For`, and a client can send those itself. A script could put a random address in each request and get a fresh rate-limit bucket every time.
- In production we name **the one header our platform sets**, overwriting whatever the client sent: `Fly-Client-IP` on Fly, `CF-Connecting-IP` behind Cloudflare. We ignore the others.
- In development, with no proxy, the socket address is the truth.

**Origins.** The client lives at, say, `https://rendezvu.pages.dev` and the server at `https://rendezvu-signal.fly.dev`, two different origins.
- The server's `ALLOWED_ORIGINS` must list the client's origin exactly. It's already checked on HTTP (CORS) and on the WebSocket upgrade (Phase 1).
- The client is built with `VITE_SERVER_DOMAIN=rendezvu-signal.fly.dev`, which `config.ts` already reads.
- With a custom domain, `rendezvu.dev` and `signal.rendezvu.dev` replace both.

**Secrets live in the platform, never in git.** Fly secrets (`fly secrets set …`) hold these four: `CF_CALLS_APP_ID`, `CF_CALLS_APP_TOKEN`, `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`. Add `ROOM_TOKEN_SECRET` to them. The client has no secrets: everything in a Vite build is public.

**A ceiling on the bill.** Phase 11's tokens and rate limits stop casual abuse. A determined script that keeps admitting itself into its own meetings could still create sessions all day. So the server counts Cloudflare sessions created per UTC day.
- Above `SFU_DAILY_SESSION_CAP` (default **2,000**, far beyond any real day for this project), `/sfu/sessions/new` answers `503 SFU_DAILY_CAP` until midnight UTC, and logs it once.
- Why sessions and not gigabytes: media never passes through our server, so it can't count bytes. Sessions are what it *can* count.
- Also set up spending or usage alerts in your Cloudflare dashboard, if your account offers them, as a second line.

**Caching.**
- Vite names every built file by its content (`index-D8DQfxg3.js`), so those files can be cached for a year: a new build means new names.
- The MediaPipe WASM and the model have fixed names, so they're cached for a day and revalidated.
- `index.html` must never be cached, or people keep loading old builds.

This lives in a `_headers` file that Pages reads.

**Single-page routing.** `/room/abc-defg-hij` isn't a file; React Router handles it in the browser. Pages serves `index.html` for unknown paths when there's no `404.html`. We keep that and add an explicit `_redirects` rule, so it stays true if someone adds a 404 page later.

**A content-security policy.** A public site should tell the browser exactly what it may load, so an injected script has nowhere to send data:

```
default-src 'self';
script-src 'self' 'wasm-unsafe-eval';
worker-src 'self' blob:;
connect-src 'self' https://<server> wss://<server>;
img-src 'self' blob: data:;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src https://fonts.gstatic.com;
media-src 'self' blob:;
frame-ancestors 'none';
base-uri 'self';
form-action 'self'
```

- `'wasm-unsafe-eval'` allows WebAssembly (MediaPipe, RNNoise) without allowing JavaScript `eval`.
- `blob:` workers are the Phase 12 worker clock.
- `'unsafe-inline'` styles cover React's `style={…}` attributes.
- Plus `Permissions-Policy: camera=(self), microphone=(self), display-capture=(self)` and `Referrer-Policy: strict-origin-when-cross-origin`.
- Tested against a local build served with these headers: MediaPipe and RNNoise both run, with no violations. `'wasm-unsafe-eval'` is enough; no `eval` is needed.

**Where to run.** Signaling latency only affects joining and toggles; media goes to Cloudflare's nearest location wherever the server is. Pick the Fly region nearest most of your users (Mumbai `bom` for India, Frankfurt `fra` for Europe, Virginia `iad` for the US).

**What "for real" adds that local testing can't.**
- **Different networks:** a phone on mobile data and a laptop on home Wi-Fi go through real NATs.
- **Strict networks:** some office and university networks block UDP; only TURN over TCP or TLS on port 443 gets through. That's the one path we've never exercised.
- **Network switches:** walking out of Wi-Fi range mid-call.
- **Safari and iOS:** different codecs, autoplay rules and audio-session behaviour.
- **Many people:** ten tiles, ten subscribe connections per person.

**Measuring without Phase 13.** The targets below include time to first media (TTFM). Phase 13's metrics are deferred, so the client logs one console line per call for now:

```
[ttfm] 1840 ms (join clicked → first remote frame playing)
```

The clock starts at the Join click, or when a waiting guest is let in. If you're alone, it restarts when someone else arrives: time spent alone in the room isn't connection time. (Without that, the first person in measured their own patience: 9.4 s in testing, against 2.5 s with it.)

For "p95 under 3 s" you collect these from about 20 joins and take the second-worst.

---

## Backend requirements (you)

### 1. A Dockerfile (`signaling/Dockerfile`, built from the repo root)

- `node:24-slim`
- copy the root `package.json`, `package-lock.json`, `protocol/` and `signaling/`
- `npm ci --workspace signaling --omit=dev`
- `CMD ["node", "signaling/src/index.ts"]`

Node 24 runs the TypeScript directly, as in development, so there's no build step. It runs as the `node` user, not root, and `EXPOSE 8080`. Add a `.dockerignore` for `client/`, `node_modules`, `certs`, `.env*` and `docs`.

### 2. Fly config (`signaling/fly.toml`)

- `app = "rendezvu-signal"` (any free name), with your chosen region
- `[http_service]`:
  - `internal_port = 8080`
  - `force_https = true`
  - `auto_stop_machines = "off"`
  - `auto_start_machines = false`
  - `min_machines_running = 1`
- `[checks]` on `GET /healthz`
- `[mounts]`: a 1 GB volume `rendezvu_state` at `/data`
- `kill_signal = "SIGTERM"`, `kill_timeout = "15s"`, so the existing shutdown can close sockets cleanly
- `[env]`:
  - `HOST=0.0.0.0`
  - `TRUSTED_IP_HEADER=fly-client-ip`
  - `STATE_DIR=/data`
  - `ALLOWED_ORIGINS=https://<client-origin>`
- **One machine.** Deploy with `fly deploy --ha=false`; never run `fly scale count 2`.

### 3. Config additions (`signaling/src/config.ts`)

- **`TRUSTED_IP_HEADER`** (optional): when set, `clientIp()` uses only that header (lower-cased), falling back to the socket address if it's missing. When unset, the socket address only. Today's "believe any of three headers" behaviour goes away.
- **`STATE_DIR`** (optional): where the room registry is saved. Unset means nothing is saved, as in development.
- **`SFU_DAILY_SESSION_CAP`** (default `2000`; `0` turns the cap off).
- **A startup line** listing the effective config without any secret values:

  ```
  config port=8080 origins=https://rendezvu.pages.dev trusted_ip_header=fly-client-ip state_dir=/data turn=on sfu=on token_secret=set
  ```

- **In production, a missing `ROOM_TOKEN_SECRET` must stop the server from starting.** Phase 11's random fallback would silently break every reconnect after a deploy. Treat "production" as `STATE_DIR` being set, or add `NODE_ENV=production`, whichever you prefer.

### 4. Saving the room registry

- `InstantRoomRegistry.toJSON()` and `fromJSON()`: code, `createdAt`, `activatedAt`, `expiresAt` and `closed`. Leave out `emptySince`, and treat every loaded active room as "empty since load", so the normal empty-grace applies if nobody comes back.
- **Write it:**
  - to `${STATE_DIR}/rooms.json` on `SIGTERM` (before closing sockets) and every 30 s
  - via a temporary file and `rename`, so a crash mid-write never leaves half a file
- **Read it on start.** A missing or unreadable file means start empty and log `state_load_failed`, never crash.
- **Log** `state_saved rooms=N` (on shutdown only, not every 30 s) and `state_loaded rooms=N`.

### 5. The daily SFU cap

- A counter of `/sfu/sessions/new` successes, reset at 00:00 UTC.
- At the cap, answer `503 {code: "SFU_DAILY_CAP"}` before calling Cloudflare. Log `sfu_daily_cap_reached sessions=N` once a day.
- The client already treats a failed session as "repair later" (Phase 9), so a capped server degrades to "no new video until tomorrow", never a crash.

### 6. CI and deploys (`.github/workflows/`)

- **`ci.yml`, on every push and pull request:** `npm ci`, `npm run typecheck`, `npm run build`.
- **`deploy-signaling.yml`, on push to `main` when `signaling/**` or `protocol/**` changes:** `superfly/flyctl-actions`, then `fly deploy --remote-only --ha=false`, with `FLY_API_TOKEN` as a repository secret.
- **The client** deploys through Cloudflare Pages' own Git integration (no workflow):
  - root directory: the repo root (the npm workspaces need it); build command `npm ci && npm run build -w client`; output `client/dist`
  - environment `VITE_SERVER_DOMAIN=<server host>`, `VITE_SERVER_SECURE=true`
  - every pull request gets a preview URL; add each preview origin you want to test to `ALLOWED_ORIGINS`

### 7. Deliberate differences from the reference

- **Fly.io and Cloudflare Pages** rather than the reference's own deploy setup (Phase 13 dashboards come later).
- **The room registry is saved to a volume** across restarts.
- **One trusted IP header** instead of trusting several.
- **A daily cap on SFU sessions.**

---

## Frontend (Claude)

- **`client/public/_headers`:** the CSP above (with the server origin filled in at build time from `VITE_SERVER_DOMAIN`, by a tiny Vite plugin), `Permissions-Policy`, `Referrer-Policy`, `X-Content-Type-Options: nosniff`, and the cache rules:
  - `/assets/*` immutable for a year
  - `/mediapipe/*` and `/models/*` for a day
  - `/index.html` `no-cache`
- **`client/public/_redirects`:** `/* /index.html 200`.
- **`[ttfm]` console line:** from the Join click to the first remote video frame actually playing (`VideoTile`'s `onPlaying`), once per call.
- **A "Video and privacy" note** in the lobby footer, a short page saying:
  - audio and video travel through Cloudflare's network
  - nothing is recorded or stored
  - meeting codes expire after 12 hours
  - your name is only seen by people in the call
- **A server-unreachable message in the lobby:** if `/room/status` can't be reached at all, "Can't reach the Rendezvu server right now. Try again in a minute." instead of a spinner forever.
- **Production build check:** `npm run build` with `VITE_SERVER_DOMAIN` set produces no `localhost` reference anywhere in `dist/`.

## Deploying, step by step

1. **Cloudflare:** you already have the account, the SFU app and the TURN key.
2. **Fly:**
   - install `flyctl`, then `fly auth signup`
   - add a card; you'll pay about $2–3 a month
   - from the repo root, `fly launch --no-deploy --config signaling/fly.toml --dockerfile signaling/Dockerfile`
   - `fly volumes create rendezvu_state --size 1 --region <region>`
   - `fly secrets set CF_CALLS_APP_ID=… CF_CALLS_APP_TOKEN=… CF_TURN_KEY_ID=… CF_TURN_API_TOKEN=… ROOM_TOKEN_SECRET=$(openssl rand -hex 32)`
   - `fly deploy --ha=false`
   - `curl https://<app>.fly.dev/healthz` → `ok`
3. **Pages:**
   - Cloudflare dashboard → Workers & Pages → Create → Pages → connect the GitHub repo, with the build settings from item 6
   - first deploy → `https://<project>.pages.dev`
4. **Wire them together:**
   - `fly secrets set ALLOWED_ORIGINS=https://<project>.pages.dev` (or put it in `fly.toml`)
   - redeploy the client if you changed `VITE_SERVER_DOMAIN`
5. **Domain** (optional for Phase 14, needed for Part 2's sign-in cookies):
   - buy it in Cloudflare Registrar
   - Pages → Custom domains → `rendezvu.dev`
   - `fly certs add signal.rendezvu.dev`, plus the CNAME it asks for
   - update `ALLOWED_ORIGINS` and `VITE_SERVER_DOMAIN`
6. **GitHub:** add `FLY_API_TOKEN` (`fly tokens create deploy`) as a repository secret.

## Testing for real

Phases 6–12 each left a check that needs real devices; they're collected here.

| # | Test | Phases | Pass |
|---|---|---|---|
| 1 | Smoke: create, join from a second browser, admit, talk for a minute | all | video and audio both ways |
| 2 | The production page with DevTools open: CSP violations, `localhost` references, 404s on `/mediapipe` or `/models` | 12, 14 | none |
| 3 | Two people on **different networks** (home Wi-Fi + phone on mobile data) for 15 minutes | 5–9 | no freeze longer than 6 s |
| 4 | Walk the phone out of Wi-Fi range mid-call | 8, 9 | recovers by itself |
| 5 | A **strict network** (office or university Wi-Fi, or a firewall rule blocking outbound UDP): Settings → Connection shows **Relayed** | 3, 10 | call works over TURN |
| 6 | Turn Wi-Fi off for 10 s on a laptop | 8 | back without rejoining, no duplicate tile |
| 7 | Block UDP for 5 s, then 40 s (`pfctl`, see doc 9) | 9 | freeze then recovery, rebuild only for 40 s |
| 8 | Unplug a camera; revoke the mic permission mid-call | 6, 9, 12 | toast, avatar, no crash |
| 9 | Safari on a Mac, Firefox, iPhone Safari, Android Chrome in one call | 2, 6, 7 | all see and hear each other; share works where supported |
| 10 | Four mixed devices, then **ten people** (friends, or tabs across several machines) | 7 | grid fits, sound clear, no runaway CPU |
| 11 | Blur on a real face; noise suppression with loud typing; blur on a slow phone | 12 | looks right, typing gone, guard turns blur off on a weak phone |
| 12 | Deploy mid-call (`fly deploy`) | 8, 14 | banner, back within ~15 s, the meeting code still works |
| 13 | `curl` checks against production: `/sfu/sessions/new` without a token → `401`; 50 quick ones → `429` | 11 | as expected |
| 14 | 20 joins, collecting the `[ttfm]` lines | 14 | p95 under 3 s |

## Done when

1. The app is live at a public HTTPS address, the server is one always-on Fly machine, and pushing to `main` deploys both.
2. Every row of the test table passes, or has a written reason and an issue to fix.
3. TTFM p95 is under 3 s over 20 joins. No frozen video lasts more than 6 s in the 15-minute cross-network call.
4. A deploy during a call doesn't end the meeting: everyone is back within about 15 s with the same link.
5. The bill after the first month is what this doc estimates. The Cloudflare dashboard shows realtime egress well under 1,000 GB.

> **Milestone 2: the live call is done.** It works, it recovers, it shows its connection quality, and it's live for anyone to use.

## Sources (checked 3 November 2026)

- Cloudflare Realtime pricing: <https://developers.cloudflare.com/realtime/sfu/pricing/>
- Cloudflare Pages limits: <https://developers.cloudflare.com/pages/platform/limits/>
- Render free web services: <https://render.com/docs/free>, and the WebSocket change: <https://render.com/changelog/free-web-services-now-remain-active-while-receiving-websocket-messages>
- Render pricing: <https://render.com/pricing>
- Fly.io pricing: <https://fly.io/docs/about/pricing/>
- Railway plans: <https://docs.railway.com/pricing/plans>
- Koyeb idle sleep: <https://community.koyeb.com/t/deployment-keeps-sleeping/3300>
- Cloud Run WebSockets (60-minute limit): <https://docs.cloud.google.com/run/docs/triggering/websockets>
- Oracle Always Free changes: <https://terminalbytes.com/oracle-cloud-free-tier-changes-2026>
- Hetzner 2026 prices and availability: <https://www.bitdoze.com/hetzner-cloud-cost-optimized-plans>
- Fly.io RAM price change (October 2026): <https://www.buildmvpfast.com/blog/fly-io-pricing-2026-ram-increase-vs-hetzner>
- Neon free plan: <https://www.bytebase.com/blog/postgres-hosting-options-pricing-comparison.md>
- Supabase free plan: <https://supabase.com/pricing>
- Spring Boot memory in small containers: <https://dev.to/jamilxt/your-spring-boot-app-works-locally-but-gets-oom-killed-in-docker-why-44dh>
