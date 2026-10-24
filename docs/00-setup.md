# Phase 0: Project setup

Status: **done**

## What's in the repo

```
rendezvu/
├── package.json        npm workspaces + root scripts (dev, typecheck, build, certs)
├── scripts/
│   └── generate-cert.mjs   self-signed cert for localhost + LAN IPs → certs/
├── certs/              (git-ignored) shared by client and server in development
├── protocol/           @rendezvu/protocol: shared types, no runtime code
│   └── src/index.ts
├── signaling/          @rendezvu/signaling: Node server
│   ├── .env.example
│   └── src/
│       ├── index.ts    entry: load config, start server, graceful shutdown
│       ├── config.ts   reads and validates environment variables
│       └── server.ts   HTTP(S) server; only /healthz for now
├── client/             @rendezvu/client: React app
│   ├── vite.config.ts  port 3000, HTTPS when certs/ exists
│   ├── .env.example
│   └── src/
│       ├── main.tsx    router: / and /room/:meetCode
│       ├── index.css   Tailwind + design tokens (light and dark)
│       ├── lib/config.ts   where the server is (httpServerUri, wsServerUri)
│       └── pages/      HomePage, RoomPage (placeholders)
└── docs/               one design doc per phase
```

## Decisions and why

**npm workspaces.** One `npm install` sets up all three packages, and `client` and `signaling` both depend on `@rendezvu/protocol` as if it were a published package. `npm run dev` at the root starts both servers.

**The protocol package holds types only.** Both sides use `import type { Envelope } from '@rendezvu/protocol'`. Type imports are erased when the code runs, so the package never has to be built or bundled. Don't add constants or functions there. If a value is needed at runtime, each side defines its own.

**Node runs TypeScript directly.** Node 24 strips types natively, so `node src/index.ts` works with no build step, in development and in production. In return, the code must use only *erasable* syntax: no `enum`, no `namespace`, no constructor parameter properties (`constructor(private x: string)`). `erasableSyntaxOnly` in `tsconfig.json` makes the compiler enforce this. Relative imports include the extension: `import { loadConfig } from './config.ts'`. `npm run typecheck` runs `tsc` for type errors only.

**Config comes from environment variables.** Hosting platforms inject config that way. Locally, `node --env-file-if-exists=.env` loads `signaling/.env`. `config.ts` validates everything at startup, so a typo in `PORT` or a duration fails immediately instead of mid-call. The variable names are the final ones, including Cloudflare's, so the deploy config won't change later.

**Plain HTTP by default; HTTPS only for phone testing.** Camera access needs a secure context.
- **Your laptop:** `http://localhost` already counts as secure, so the default setup is plain HTTP.
- **A phone on the LAN:** it uses an IP address, which needs HTTPS. Then you run `npm run certs` and set `TLS_CERT_FILE` and `TLS_KEY_FILE`. Vite switches to HTTPS on its own when `certs/` exists.
- **Production:** the hosting platform terminates TLS and forwards plain HTTP to Node, so the `TLS_` variables stay empty there too.

The same code runs in all three places.

**The client finds the server from two build variables.**
- `VITE_SERVER_DOMAIN` (host[:port]) and `VITE_SERVER_SECURE` (`true` for https/wss) build `httpServerUri` and `wsServerUri`.
- In development they default to the page's own host on port 8080, so a phone opening `https://<lan-ip>:3000` reaches `https://<lan-ip>:8080` with no extra config.

**Graceful shutdown.** Platforms send `SIGTERM` before replacing the process on a deploy. The server stops accepting connections and exits, or is forced to exit after 10 seconds. Phase 1 will close WebSockets here too.

**Default ports:** 3000 for the client and 8080 for the server. `ALLOWED_ORIGINS` defaults to the client's origin.

## Deployment notes (for Phase 14)

- **Client:** a static build (`npm run build` → `client/dist`). The host must rewrite unknown paths to `index.html` so `/room/abc-defg-hij` loads the app. Set `VITE_SERVER_DOMAIN` and `VITE_SERVER_SECURE=true` at build time.
- **Signaling:** any host that supports long-lived WebSockets and Node 24. Start with `npm start -w signaling`. Set `PORT` (most hosts do), `ALLOWED_ORIGINS` (the client's public URL) and the Cloudflare variables. Health check path: `/healthz`.
- **One process.** Room state lives in memory, so run a single instance.

## Done when

- `npm run typecheck` passes.
- `npm run dev` starts both servers.
- `http://localhost:8080/healthz` returns `ok`.
- `http://localhost:3000` and `http://localhost:3000/room/abc-defg-hij` load.
- With certificates set up (see README), the same pages work over HTTPS from a phone on the LAN.
