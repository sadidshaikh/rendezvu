import type { IceServer } from '@rendezvu/protocol'

/** Which TURN URLs to keep. Forcing TCP or TLS simulates a firewall that blocks UDP. */
export type RelayTransport = 'any' | 'udp' | 'tcp' | 'tls'

export interface RelayCheckResult {
  ok: boolean
  /** Why it failed, in plain words. */
  reason?: string
  local?: CandidateSummary
  remote?: CandidateSummary
  /** Round trip of a message through the relay, both directions. */
  roundTripMs?: number
  /** Relay candidates gathered by the first connection. Zero points at credentials or a blocked network. */
  relayCandidates: number
}

export interface CandidateSummary {
  type: string
  protocol?: string
  /** Browser to TURN server: udp, tcp or tls. */
  relayProtocol?: string
  url?: string
}

const CONNECT_TIMEOUT_MS = 15_000

/** Keeps only TURN URLs of the chosen transport. STUN entries are dropped: with relay-only they're unused. */
export function filterTurnUrls(servers: IceServer[], transport: RelayTransport): IceServer[] {
  const keep = (url: string) => {
    if (!url.startsWith('turn:') && !url.startsWith('turns:')) return false
    if (transport === 'any') return true
    if (transport === 'tls') return url.startsWith('turns:')
    return url.startsWith('turn:') && url.includes(`transport=${transport}`)
  }
  return servers.map((s) => ({ ...s, urls: s.urls.filter(keep) })).filter((s) => s.urls.length > 0)
}

/**
 * Connects two RTCPeerConnections to each other inside this tab, allowed to
 * use relay candidates only. If a data channel opens, media would flow
 * through Cloudflare's TURN servers too.
 */
export async function runRelayCheck(servers: IceServer[]): Promise<RelayCheckResult> {
  const config: RTCConfiguration = { iceServers: servers, iceTransportPolicy: 'relay' }
  const a = new RTCPeerConnection(config)
  const b = new RTCPeerConnection(config)
  let relayCandidates = 0

  // No signaling server needed: both ends are here, so candidates are handed straight across.
  a.onicecandidate = (e) => {
    if (e.candidate?.type === 'relay') relayCandidates++
    if (e.candidate) b.addIceCandidate(e.candidate).catch(() => {})
  }
  b.onicecandidate = (e) => {
    if (e.candidate) a.addIceCandidate(e.candidate).catch(() => {})
  }

  try {
    const channel = a.createDataChannel('relay-check')
    const echoed = new Promise<void>((resolve) => {
      b.ondatachannel = (e) => {
        e.channel.onmessage = (m) => e.channel.send(m.data)
      }
      channel.onmessage = () => resolve()
    })
    const opened = new Promise<void>((resolve) => {
      channel.onopen = () => resolve()
    })

    await a.setLocalDescription(await a.createOffer())
    await b.setRemoteDescription(a.localDescription!)
    await b.setLocalDescription(await b.createAnswer())
    await a.setRemoteDescription(b.localDescription!)

    const connected = await withTimeout(opened, CONNECT_TIMEOUT_MS)
    if (!connected) {
      return {
        ok: false,
        relayCandidates,
        reason:
          relayCandidates === 0
            ? 'No relay candidates were gathered. The credentials were rejected, or this network blocks the TURN server on every port tried.'
            : `Relay candidates were gathered but the connection didn't complete (ICE state: ${a.iceConnectionState}).`,
      }
    }

    const sentAt = performance.now()
    channel.send('ping')
    const roundTripMs = (await withTimeout(echoed, 5_000)) ? Math.round(performance.now() - sentAt) : undefined
    const { local, remote } = await selectedPair(a)
    return { ok: true, relayCandidates, local, remote, roundTripMs }
  } finally {
    a.close()
    b.close()
  }
}

async function selectedPair(pc: RTCPeerConnection): Promise<{ local?: CandidateSummary; remote?: CandidateSummary }> {
  const stats = await pc.getStats()
  const byId = new Map<string, Record<string, unknown>>()
  stats.forEach((s: Record<string, unknown>) => byId.set(s.id as string, s))

  // Chrome and Safari point at the pair from the transport; Firefox marks the pair itself.
  let pair: Record<string, unknown> | undefined
  for (const s of byId.values()) {
    if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') pair = byId.get(s.selectedCandidatePairId)
  }
  pair ??= [...byId.values()].find((s) => s.type === 'candidate-pair' && (s.selected === true || (s.nominated && s.state === 'succeeded')))
  if (!pair) return {}

  const summarize = (id: unknown): CandidateSummary | undefined => {
    const c = byId.get(id as string)
    if (!c) return undefined
    return {
      type: String(c.candidateType),
      protocol: c.protocol as string | undefined,
      relayProtocol: c.relayProtocol as string | undefined,
      url: c.url as string | undefined,
    }
  }
  return { local: summarize(pair.localCandidateId), remote: summarize(pair.remoteCandidateId) }
}

async function withTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([promise.then(() => true), timeout])
  } finally {
    clearTimeout(timer)
  }
}
