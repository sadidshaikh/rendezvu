import { loadConfig } from './config.ts'
import { log } from './log.ts'
import { InstantRoomRegistry } from './meets/instant-rooms.ts'
import { createMeetHandler, roomStatusHandler } from './meets/routes.ts'
import { createServer } from './server.ts'
import { CloudflareSfuClient } from './sfu/cloudflare-sfu.ts'
import { sfuHandler } from './sfu/routes.ts'
import { SfuSessionRegistry } from './sfu/session-registry.ts'
import { Hub } from './signaling/hub.ts'
import { attachSignaling } from './signaling/ws-handler.ts'
import { CloudflareTurnClient } from './turn/cloudflare-turn.ts'
import { iceServersHandler } from './turn/routes.ts'

const SHUTDOWN_TIMEOUT_MS = 10_000
const PRUNE_ROOMS_EVERY_MS = 60 * 60_000

const config = loadConfig()

const registry = new InstantRoomRegistry(config.instantRoomTtlMs, config.instantRoomEmptyGraceMs)
const sfuSessions = new SfuSessionRegistry()
const hub = new Hub(
  (roomId) => registry.markEmpty(roomId),
  // A peer's SFU sessions can't be used by anyone once it has left.
  (peerId) => {
    const removed = sfuSessions.removePeer(peerId)
    if (removed > 0) log('sfu_sessions_dropped', { peer: peerId, sessions: removed })
  },
)

const { turnKeyId, turnApiToken } = config.cloudflare
const turnClient = turnKeyId && turnApiToken ? new CloudflareTurnClient(turnKeyId, turnApiToken) : null
if (!turnClient) console.warn('CF_TURN_KEY_ID / CF_TURN_API_TOKEN not set; /ice-servers will return STUN only')

// No fallback here: there is no public SFU to fall back to, so /sfu/* says so with a 503.
const { callsAppId, callsAppToken } = config.cloudflare
const sfuClient = callsAppId && callsAppToken ? new CloudflareSfuClient(callsAppId, callsAppToken) : null
if (!sfuClient) console.warn('CF_CALLS_APP_ID / CF_CALLS_APP_TOKEN not set; /sfu/* will return 503')

const server = createServer(config, {
  '/meets/new': createMeetHandler(registry, config.allowedOrigins),
  '/room/status': roomStatusHandler(registry, config.allowedOrigins),
  '/ice-servers': iceServersHandler(registry, turnClient, config.allowedOrigins),
  '/sfu/sessions/': sfuHandler({ sessions: sfuSessions, hub, rooms: registry, sfuClient, allowedOrigins: config.allowedOrigins }),
})
const signaling = attachSignaling(server, { hub, registry, sfuSessions, allowedOrigins: config.allowedOrigins })

setInterval(() => {
  const removed = registry.prune()
  if (removed > 0) log('rooms_pruned', { removed })
}, PRUNE_ROOMS_EVERY_MS).unref()

server.listen(config.port, config.host, () => {
  const scheme = config.tls ? 'https' : 'http'
  console.log(`Signaling server listening on ${scheme}://localhost:${config.port}`)
})

// Hosting platforms send SIGTERM before replacing the process on a deploy.
function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`)
  signaling.closeAll()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
