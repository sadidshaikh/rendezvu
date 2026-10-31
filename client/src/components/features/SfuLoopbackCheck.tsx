import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { SfuTracksData } from '@rendezvu/protocol'
import { Button } from '@/components/ui/button'
import { StreamVideo } from '@/components/ui/StreamVideo'
import { describeMediaError } from '@/lib/media-errors'
import { fetchIceServers } from '@/services/api/ice'
import { createMeet } from '@/services/api/meet'
import type { SignalingClient } from '@/services/signaling/client'
import { joinRoom } from '@/services/signaling/join-room'
import { SfuSession } from '@/services/webrtc/sfu-session'
import { CheckSteps, idleSteps, type Step, type StepState } from './CheckSteps'

const STEP_LABELS = [
  'Create a meeting',
  'Join it, so the room is active',
  'Fetch ICE servers',
  'Turn on the camera',
  'Publish it to Cloudflare',
  'Pull it back from Cloudflare',
  'Media flowing both ways',
]

const PUBLISH_TIMEOUT_MS = 20_000
const PULL_TIMEOUT_MS = 20_000
const MEASURE_AFTER_MS = 3_000

interface FlowStats {
  bytesSent: number
  bytesReceived: number
  publishCandidate: string
  subscribeCandidate: string
}

interface Resources {
  client: SignalingClient | null
  sfu: SfuSession | null
  camera: MediaStream | null
}

/**
 * Publishes the camera to Cloudflare, then pulls that same track back through
 * a separate subscribe session. Proves the whole SFU round trip (our /sfu
 * proxy, Cloudflare, ICE/TURN, media) with a single device.
 */
export function SfuLoopbackCheck() {
  const [running, setRunning] = useState(false)
  const [live, setLive] = useState(false)
  const [steps, setSteps] = useState<Step[]>(() => idleSteps(STEP_LABELS))
  const [local, setLocal] = useState<MediaStream | null>(null)
  const [returned, setReturned] = useState<MediaStream | null>(null)
  const [stats, setStats] = useState<FlowStats | null>(null)
  const res = useRef<Resources>({ client: null, sfu: null, camera: null })

  const update = (index: number, state: StepState, detail?: string) =>
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, state, detail } : s)))

  const stop = () => {
    const r = res.current
    r.sfu?.destroy()
    r.client?.send('leave')
    r.client?.dispose()
    r.camera?.getTracks().forEach((t) => t.stop())
    res.current = { client: null, sfu: null, camera: null }
    setLive(false)
    setLocal(null)
    setReturned(null)
  }

  useEffect(() => stop, [])

  const run = async () => {
    stop()
    setRunning(true)
    setSteps(idleSteps(STEP_LABELS))
    setStats(null)
    let step = 0
    try {
      update(step, 'running')
      const { meetCode } = await createMeet()
      update(step, 'done', meetCode)

      step = 1
      update(step, 'running')
      const client = await joinRoom(meetCode, 'SFU check')
      res.current.client = client
      const peerId = client.getPeerId()
      if (!peerId) throw new Error('No peer id from the server.')
      update(step, 'done', `peer ${peerId}`)

      step = 2
      update(step, 'running')
      const servers = await fetchIceServers(meetCode)
      const turnCount = servers.flatMap((s) => s.urls).filter((u) => u.startsWith('turn')).length
      update(step, 'done', turnCount > 0 ? `${turnCount} TURN URLs` : 'STUN only (fine on an open network; run the TURN check for strict ones)')

      step = 3
      update(step, 'running')
      let camera: MediaStream
      try {
        camera = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360 } })
      } catch (e) {
        throw new Error(describeMediaError('camera', e))
      }
      res.current.camera = camera
      setLocal(camera)
      update(step, 'done', camera.getVideoTracks()[0]?.label || 'camera on')

      step = 4
      update(step, 'running', 'Up to 20 s')
      const announcement = await new Promise<SfuTracksData>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Cloudflare never confirmed the track. Are the /sfu routes implemented? Check the server log for sfu_error.')), PUBLISH_TIMEOUT_MS)
        const sfu = new SfuSession({
          roomId: meetCode,
          presenceId: client.getPresenceId(),
          iceServers: servers,
          onLocalTracksChanged: (a) => {
            clearTimeout(timer)
            // The same announce a call sends, so the server's validation is exercised too.
            client.send<SfuTracksData>('sfu-announce', a, { room: meetCode })
            resolve(a)
          },
        })
        res.current.sfu = sfu
        sfu.publish(camera)
      })
      const published = announcement.tracks[0]
      if (!published) throw new Error('Cloudflare confirmed no tracks.')
      update(step, 'done', `session ${short(announcement.sessionId)} · track ${short(published.trackName)}`)

      step = 5
      update(step, 'running', 'Up to 20 s')
      const sfu = res.current.sfu
      if (!sfu) throw new Error('The check was stopped.')
      const track = await new Promise<MediaStreamTrack>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No track came back from Cloudflare.')), PULL_TIMEOUT_MS)
        sfu.subscribeTrack(announcement.sessionId, published.trackName, (t) => {
          clearTimeout(timer)
          resolve(t)
        })
      })
      setReturned(new MediaStream([track]))
      setLive(true)
      update(step, 'done', 'Track received')

      step = 6
      update(step, 'running', 'Measuring for 3 s')
      await new Promise((r) => setTimeout(r, MEASURE_AFTER_MS))
      const measured = await measure(sfu, announcement.sessionId)
      setStats(measured)
      const flowing = measured.bytesSent > 0 && measured.bytesReceived > 0
      update(
        step,
        flowing ? 'done' : 'failed',
        flowing
          ? `${kb(measured.bytesSent)} sent · ${kb(measured.bytesReceived)} received`
          : 'Connected, but no video bytes yet. Check chrome://webrtc-internals.',
      )
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // A missing route without CORS headers surfaces as a bare network error.
      const hint = step >= 4 && e instanceof TypeError ? ' Are the /sfu routes implemented, and is the server running?' : ''
      update(step, 'failed', message + hint)
      stop()
    } finally {
      setRunning(false)
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <h2 className="font-display text-2xl">SFU loopback</h2>
        <p className="text-sm text-muted-foreground">
          Publishes your camera to Cloudflare, then pulls the same track back through a second connection. If the right
          video moves, your media made the full trip through the SFU.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button onClick={run} disabled={running} size="lg" aria-busy={running}>
          {running && <Loader2 className="animate-spin" aria-hidden="true" />}
          {running ? 'Checking…' : 'Run loopback'}
        </Button>
        {live && !running && (
          <Button variant="outline" size="lg" onClick={stop}>
            Stop
          </Button>
        )}
      </div>

      <CheckSteps steps={steps} />

      {(local || returned) && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <VideoPane label="Your camera" stream={local} />
          <VideoPane label="Back from Cloudflare" stream={returned} />
        </div>
      )}

      {stats && (
        <section className="app-panel rounded-2xl p-5">
          <h3 className="label-caps mb-3">Video flow</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Sent</dt>
            <dd className="meet-code">{kb(stats.bytesSent)}</dd>
            <dt className="text-muted-foreground">Received</dt>
            <dd className="meet-code">{kb(stats.bytesReceived)}</dd>
            <dt className="text-muted-foreground">Publish path</dt>
            <dd className="meet-code">{stats.publishCandidate}</dd>
            <dt className="text-muted-foreground">Subscribe path</dt>
            <dd className="meet-code">{stats.subscribeCandidate}</dd>
          </dl>
        </section>
      )}
    </section>
  )
}

function VideoPane({ label, stream }: { label: string; stream: MediaStream | null }) {
  return (
    <figure className="flex flex-col gap-2">
      <div className="relative aspect-video max-w-full overflow-hidden rounded-xl bg-surface-3">
        {stream && <StreamVideo stream={stream} />}
      </div>
      <figcaption className="text-xs text-muted-foreground">{label}</figcaption>
    </figure>
  )
}

async function measure(sfu: SfuSession, sessionId: string): Promise<FlowStats> {
  const pub = sfu.publishPeerConnection
  const sub = sfu.subscribePeerConnection(sessionId)
  const [pubStats, subStats] = await Promise.all([pub?.getStats(), sub?.getStats()])
  return {
    bytesSent: sumVideo(pubStats, 'outbound-rtp', 'bytesSent'),
    bytesReceived: sumVideo(subStats, 'inbound-rtp', 'bytesReceived'),
    publishCandidate: selectedCandidate(pubStats),
    subscribeCandidate: selectedCandidate(subStats),
  }
}

function sumVideo(report: RTCStatsReport | undefined, type: string, field: 'bytesSent' | 'bytesReceived'): number {
  let total = 0
  report?.forEach((s) => {
    if (s.type === type && s.kind === 'video') total += (s[field] as number | undefined) ?? 0
  })
  return total
}

/** "relay (udp)" or "srflx (udp)": the local side of the pair the connection chose. */
function selectedCandidate(report: RTCStatsReport | undefined): string {
  if (!report) return '?'
  let pairId: string | undefined
  report.forEach((s) => {
    if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId as string
  })
  let pair: Record<string, unknown> | undefined
  report.forEach((s) => {
    if (s.type === 'candidate-pair' && (s.id === pairId || (!pairId && s.nominated && s.state === 'succeeded'))) pair = s
  })
  const local = pair ? report.get(pair.localCandidateId as string) : undefined
  if (!local) return '?'
  const protocol = (local.relayProtocol ?? local.protocol) as string | undefined
  return `${local.candidateType as string}${protocol ? ` (${protocol})` : ''}`
}

const short = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id)
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`
