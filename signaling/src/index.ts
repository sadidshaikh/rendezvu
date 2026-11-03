import { loadConfig } from './config.ts'
import { log } from './log.ts'
import { InstantRoomRegistry } from './meets/instant-rooms.ts'
import { createMeetHandler, roomStatusHandler } from './meets/routes.ts'
import { createServer } from './server.ts'
import { CloudflareSfuClient } from './sfu/cloudflare-sfu.ts'
import { sfuHandler } from './sfu/routes.ts'
import { QualityStore } from './quality/quality-store.ts'
import { SfuSessionRegistry } from './sfu/session-registry.ts'
import { Hub } from './signaling/hub.ts'
import { attachSignaling } from './signaling/ws-handler.ts'
import { CloudflareTurnClient } from './turn/cloudflare-turn.ts'
import { iceServersHandler } from './turn/routes.ts'

const SHUTDOWN_TIMEOUT_MS = 10_000
const PRUNE_ROOMS_EVERY_MS = 60 * 60_000
// How long a tab whose socket closed without a leave keeps its SFU sessions.
// A phone moving between networks can take a minute to get back.
const SFU_SESSION_GRACE_MS = 2 * 60_000

const config = loadConfig()

const registry = new InstantRoomRegistry(config.instantRoomTtlMs, config.instantRoomEmptyGraceMs)
const sfuSessions = new SfuSessionRegistry()
const quality = new QualityStore()
const logDropped = (presenceId: string, sessions: number, reason: 'leave' | 'timeout') => {
  if (sessions > 0) log('sfu_sessions_dropped', { presence: presenceId.slice(0, 8), sessions, reason })
}
const hub = new Hub({
  onRoomEmpty: (roomId) => registry.markEmpty(roomId),
  onPeerLeave: (peer, reason) => {
    // Whatever the reason, its connection numbers no longer describe anyone's call.
    quality.removePeer(peer.id)
    // A tab that said goodbye gets nothing back. One that vanished may be
    // reconnecting, and its media to Cloudflare is still flowing meanwhile.
    if (reason === 'leave') logDropped(peer.presenceId, sfuSessions.removePresence(peer.presenceId), 'leave')
    else if (reason === 'disconnect') {
      sfuSessions.scheduleDrop(peer.presenceId, SFU_SESSION_GRACE_MS, (n) => logDropped(peer.presenceId, n, 'timeout'))
    }
  },
  onPeerJoin: (peer, roomId) => {
    sfuSessions.cancelDrop(peer.presenceId)
    // Sessions left behind in another room can't be used here.
    logDropped(peer.presenceId, sfuSessions.removePresence(peer.presenceId, roomId), 'leave')
  },
})
hub.startSnapshots()

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
const signaling = attachSignaling(server, { hub, registry, sfuSessions, quality, allowedOrigins: config.allowedOrigins })

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
  hub.stopSnapshots()
  signaling.closeAll()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
