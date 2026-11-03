import { randomBytes } from 'node:crypto'

export interface Config {
  port: number
  host: string
  allowedOrigins: string[]
  /** null means plain HTTP, which is what production uses behind the platform's TLS. */
  tls: { certFile: string; keyFile: string } | null
  instantRoomTtlMs: number
  instantRoomEmptyGraceMs: number
  /**
   * Signs room tokens (Phase 11). Random per start when ROOM_TOKEN_SECRET is
   * unset, which means tokens stop working on every restart.
   */
  roomTokenSecret: string
  /** The one client-IP header the platform sets (lower-case), or null to use the socket address. */
  trustedIpHeader: string | null
  /** Where the room registry is saved across restarts, or null to keep nothing (development). */
  stateDir: string | null
  /** Cloudflare sessions allowed per UTC day; 0 means no cap. */
  sfuDailySessionCap: number
  /** Deployed: NODE_ENV=production or a STATE_DIR. Stricter about missing secrets. */
  production: boolean
  cloudflare: {
    turnKeyId: string
    turnApiToken: string
    callsAppId: string
    callsAppToken: string
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const stateDir = env.STATE_DIR?.trim() || null
  const production = env.NODE_ENV === 'production' || stateDir !== null
  const certFile = env.TLS_CERT_FILE ?? ''
  const keyFile = env.TLS_KEY_FILE ?? ''
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new Error('Set both TLS_CERT_FILE and TLS_KEY_FILE, or neither')
  }

  return {
    port: parsePort(env.PORT ?? '8080'),
    host: env.HOST || '0.0.0.0',
    allowedOrigins: splitCsv(env.ALLOWED_ORIGINS ?? 'http://localhost:3000'),
    tls: certFile ? { certFile, keyFile } : null,
    instantRoomTtlMs: parseDuration('INSTANT_ROOM_TTL', env.INSTANT_ROOM_TTL || '12h'),
    instantRoomEmptyGraceMs: parseDuration('INSTANT_ROOM_EMPTY_GRACE', env.INSTANT_ROOM_EMPTY_GRACE || '30m'),
    roomTokenSecret: readTokenSecret(env.ROOM_TOKEN_SECRET, production),
    trustedIpHeader: env.TRUSTED_IP_HEADER?.trim().toLowerCase() || null,
    stateDir,
    sfuDailySessionCap: parseCount('SFU_DAILY_SESSION_CAP', env.SFU_DAILY_SESSION_CAP ?? '2000'),
    production,
    cloudflare: {
      turnKeyId: env.CF_TURN_KEY_ID ?? '',
      turnApiToken: env.CF_TURN_API_TOKEN ?? '',
      callsAppId: env.CF_CALLS_APP_ID ?? '',
      callsAppToken: env.CF_CALLS_APP_TOKEN ?? '',
    },
  }
}

const MIN_SECRET_LENGTH = 32

function readTokenSecret(value: string | undefined, production: boolean): string {
  if (value && value.length >= MIN_SECRET_LENGTH) return value
  if (value) throw new Error(`ROOM_TOKEN_SECRET must be at least ${MIN_SECRET_LENGTH} characters`)
  // Deployed, a random secret would sign everyone out on every deploy, with
  // nothing in the log to say why. Refusing to start is the clearer failure.
  if (production) throw new Error('ROOM_TOKEN_SECRET is required in production')
  console.warn('ROOM_TOKEN_SECRET not set; using a random one. Room tokens stop working when the server restarts.')
  return randomBytes(32).toString('hex')
}

function parseCount(name: string, value: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number ≥ 0, got "${value}"`)
  return n
}

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be 1-65535, got "${value}"`)
  }
  return port
}

function splitCsv(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean)
}

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const

/** Parses durations like "500ms", "45s", "30m", "12h" or "1h30m" into milliseconds. */
function parseDuration(name: string, value: string): number {
  const parts = [...value.matchAll(/(\d+)(ms|s|m|h)/g)]
  if (parts.length === 0 || parts.map((p) => p[0]).join('') !== value) {
    throw new Error(`${name} must be a duration like 30m or 1h30m, got "${value}"`)
  }
  return parts.reduce((total, [, amount, unit]) => total + Number(amount) * UNIT_MS[unit as keyof typeof UNIT_MS], 0)
}
