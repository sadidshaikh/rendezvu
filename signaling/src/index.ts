import { RoomAccess } from './access/room-access.ts'
import { loadConfig } from './config.ts'
import { errorMessage, log } from './log.ts'
import { InstantRoomRegistry } from './meets/instant-rooms.ts'
import { createMeetHandler, roomStatusHandler } from './meets/routes.ts'
import { createServer } from './server.ts'
import { setTrustedIpHeader } from './http/client-ip.ts'
import { loadRooms, saveRooms } from './meets/room-state.ts'
import { CloudflareSfuClient } from './sfu/cloudflare-sfu.ts'
import { DailySessionCap } from './sfu/daily-cap.ts'
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
// The room registry is written this often as a backstop for a crash; a
// normal deploy also writes it on SIGTERM.
const SAVE_ROOMS_EVERY_MS = 30_000

const config = loadConfig()
setTrustedIpHeader(config.trustedIpHeader)

const registry = new InstantRoomRegistry(config.instantRoomTtlMs, config.instantRoomEmptyGraceMs)
const access = new RoomAccess(registry, config.roomTokenSecret, config.instantRoomTtlMs)
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
  '/meets/new': createMeetHandler(registry, access, config.allowedOrigins),
  '/room/status': roomStatusHandler(registry, config.allowedOrigins),
  '/ice-servers': iceServersHandler(access, turnClient, config.allowedOrigins),
  '/sfu/sessions/': sfuHandler({
    sessions: sfuSessions,
    hub,
    rooms: registry,
    access,
    dailyCap: new DailySessionCap(config.sfuDailySessionCap),
    sfuClient,
    allowedOrigins: config.allowedOrigins,
  }),
})
const signaling = attachSignaling(server, { hub, registry, sfuSessions, quality, access, allowedOrigins: config.allowedOrigins })

setInterval(() => {
  const removed = registry.prune()
  if (removed > 0) log('rooms_pruned', { removed })
}, PRUNE_ROOMS_EVERY_MS).unref()

// The effective settings, never a secret's value: enough to tell from the log
// that production is configured the way you meant.
log('config', {
  port: config.port,
  origins: config.allowedOrigins.join(','),
  trusted_ip_header: config.trustedIpHeader ?? 'none',
  state_dir: config.stateDir ?? 'none',
  sfu_daily_cap: config.sfuDailySessionCap,
  turn: turnClient ? 'on' : 'off',
  sfu: sfuClient ? 'on' : 'off',
  production: config.production,
})

const stateDir = config.stateDir
const persist = async (reason: 'interval' | 'shutdown') => {
  if (!stateDir) return
  try {
    const rooms = await saveRooms(stateDir, registry)
    if (reason === 'shutdown') log('state_saved', { rooms })
  } catch (err) {
    log('state_save_failed', { error: errorMessage(err) })
  }
}

// Meeting codes from before a deploy or crash keep working: the rejoin of
// every reconnecting tab is accepted instead of refused as unavailable.
if (stateDir) await loadRooms(stateDir, registry)
if (stateDir) setInterval(() => void persist('interval'), SAVE_ROOMS_EVERY_MS).unref()

server.listen(config.port, config.host, () => {
  const scheme = config.tls ? 'https' : 'http'
  console.log(`Signaling server listening on ${scheme}://localhost:${config.port}`)
})

// Hosting platforms send SIGTERM before replacing the process on a deploy.
let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`${signal} received, shutting down`)
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref()
  // Before closing sockets: the reconnects that follow need these rooms.
  await persist('shutdown')
  hub.stopSnapshots()
  signaling.closeAll()
  server.close(() => process.exit(0))
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
