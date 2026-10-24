# Rendezvu

Book a time, then meet face to face in the browser. Rendezvu is a scheduling app with built-in group video calls that run on an SFU, with TURN as the fallback for restrictive networks.

> Work in progress. The live call is being built first. See [PLAN.md](PLAN.md) for the full roadmap and [docs/](docs/) for each phase's design.

## Stack

| Part | Tech |
|---|---|
| `client/` | React 19, Vite, TypeScript, Tailwind CSS, Zustand |
| `signaling/` | Node.js 24 (runs TypeScript directly), `ws` |
| `protocol/` | Shared TypeScript types for every message and endpoint |
| Media | Cloudflare Realtime SFU and TURN |
| `api/` (planned) | Spring Boot and Postgres: accounts, booking, calendar, email |

## Run locally

Requires Node 24.

```bash
npm install
cp signaling/.env.example signaling/.env
npm run dev                         # client on http://localhost:3000, server on http://localhost:8080
```

Open http://localhost:3000. Browsers treat `localhost` as secure, so camera and mic work without HTTPS.

### Testing from a phone on the same Wi-Fi

A phone opens the app by IP address, and browsers only allow the camera on an IP address over HTTPS. So you need a local certificate (requires OpenSSL):

1. `npm run certs`. This creates `certs/`, and Vite switches to HTTPS automatically.
2. In `signaling/.env`, set:
   - `TLS_CERT_FILE=../certs/cert.pem`
   - `TLS_KEY_FILE=../certs/key.pem`
   - add `https://<your-lan-ip>:3000` to `ALLOWED_ORIGINS`
3. On the phone, open `https://<your-lan-ip>:8080/healthz` and accept the warning.
4. Then open `https://<your-lan-ip>:3000` and accept its warning.

To go back to HTTP, delete `certs/` and empty the two `TLS_` lines.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Client and signaling server with reload on change |
| `npm run typecheck` | Type-checks every workspace |
| `npm run build` | Production build of the client into `client/dist` |
| `npm run certs` | Creates the local dev certificate (`-- --force` to regenerate) |
