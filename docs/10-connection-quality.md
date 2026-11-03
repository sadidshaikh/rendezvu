# Phase 10: Connection quality

Status: **frontend built**; backend next. Backend: you · Frontend: Claude

## Goal

Everyone can see how good each connection is, without anything in the call changing because of it. Each tile gets a small dot when that person's connection is weak. Settings → Connection shows the numbers behind it: latency, loss, jitter, bitrate, resolution and route, plus recent interruptions and a **Copy report** button for support. Browsers also send a short quality report to the server every 10 s, so problems show up in the server log.

## What changed from the plan, and why

The plan, like the reference, also had **automatic quality changes**:
- lower the video sender's ceiling in three steps (900 → 500 → 200 kbps) when the uplink struggles
- pause video entirely to protect audio (`videoHeld`)

That part was built and then **removed** before committing. In testing, Chrome's own bandwidth estimate to Cloudflare from the test machine stayed around 70 kbps, below every level's budget. The ladder therefore stepped both people down and paused their video, on a call that was otherwise working.

Anything that changes what we send turns a wrong reading into a broken call. Measuring and showing can't. So Phase 10 keeps only the read-only half:
- The browser's congestion control still adapts bitrate within its default limits, as it always has.
- The numbers collected here are what a future, carefully tested ladder would use.

This is a deliberate difference from the reference.

## Concepts

**Where the numbers come from.** Phase 9 already polls every connection's `getStats()` every 2 s to watch byte flow. The same reports carry:

| Entry | Field | Meaning |
|---|---|---|
| `inbound-rtp` | `packetsReceived`, `packetsLost` | for loss |
| `inbound-rtp` | `jitter` | how unevenly packets arrive (s) |
| `inbound-rtp` | `frameWidth`, `frameHeight`, `framesPerSecond` | the video we receive |
| `outbound-rtp` / `inbound-rtp` | `bytesSent` / `bytesReceived` | for bitrate |
| the ICE pair in use (`transport.selectedCandidatePairId`) | `currentRoundTripTime` | latency to Cloudflare and back |
| that pair's local candidate | `candidateType` | the route |

Bitrate and loss are worked out **between two polls**, not since the call started, so a bad minute an hour ago doesn't keep a dot red.

**Grading a connection.** For each remote person, from our subscribe connection to them:

| Grade | Rule |
|---|---|
| good | RTT under 200 ms and loss under 2% |
| medium | RTT under 400 ms and loss under 5% |
| poor | anything worse, **or** their camera is on but 0 frames per second arrive |
| unknown | no RTT measured yet |

The dot shows only for medium (amber) and poor (red). A green dot on every tile would be noise. A subscribe connection that hasn't measured its own RTT yet borrows our publish connection's.

**Network pressure** is a coarser grade for the panel, saying how much headroom is left:

| Pressure | Loss | RTT |
|---|---|---|
| low | under 1% | under 150 ms |
| medium | under 3% | under 300 ms |
| high | under 8% | under 600 ms |
| severe | anything worse | |

**Direct or relayed.** `host` and `srflx` mean a direct path to Cloudflare. `relay` means through TURN (Phase 3). Relayed isn't a fault, since on strict networks it's the only path that works, but it adds a hop, which is worth knowing when latency is high.

**Reports to the server.** Every 5th poll (every 10 s), each browser sends `stats-report` with one entry per remote person. The dot updates every 2 s in the browser; the server only needs a coarse view. Phase 10 checks and logs the reports and keeps the latest per pair in memory. Phase 13 turns them into metrics and a dashboard.

---

## Backend requirements (you)

### 1. Shared types (`protocol/src/index.ts`, already added with the frontend)

```ts
// MsgType gets
| 'stats-report'

export type QualityGrade = 'good' | 'medium' | 'poor' | 'unknown'
export type NetworkPressure = 'low' | 'medium' | 'high' | 'severe' | 'unknown'
export type CandidateType = 'host' | 'srflx' | 'relay' | 'unknown'

export interface StatsReportPeer {
  peerId: string               // the other person
  quality: QualityGrade
  networkPressure: NetworkPressure
  roundTripTimeMs: number      // -1 = not measured yet
  packetLossPercent: number
  jitterMs: number
  outboundBitrateKbps: number  // our uplink (one stream to the SFU, the same in every entry)
  inboundBitrateKbps: number   // what we receive from this person
  candidateType: CandidateType
  frameWidth?: number
  frameHeight?: number
  framesPerSecond?: number
}

export interface StatsReportData { peers: StatsReportPeer[] }
```

### 2. Handling `stats-report`

- **Not in a room:** ignore it silently, as with `peer-state`.
- **Rate:** at most one per peer every **5 s**. Drop extras silently; an honest client sends one every 10 s.
- **Validation.** Nobody else sees a report, but it's written to logs and kept in memory.
  - `peers` must be an array of at most **16** entries; otherwise drop the whole report
  - each entry's `peerId` must be **another member of the same room**; skip entries that aren't
  - enums outside their lists become `'unknown'`
  - numbers must be finite and are clamped:

    | Field | Range |
    |---|---|
    | `roundTripTimeMs` | −1 or 0–60 000 |
    | `packetLossPercent` | 0–100 |
    | `jitterMs` | 0–10 000 |
    | bitrates | 0–100 000 |
    | `frameWidth` / `frameHeight` | whole numbers 0–8192, else left out |
    | `framesPerSecond` | 0–120 |
- **Store** (`signaling/src/quality/quality-store.ts`):
  - the latest entry per **(reporter, remote)** pair, with the time it arrived
  - when a peer leaves, entries where it is either the reporter or the remote are removed
  - `aggregate()`: counts of good, medium and poor; average RTT (ignoring −1); average loss; how many entries are relayed
  - Phase 13 serves this; nothing reads it yet.
- **Log:** one line per report, only when the worst grade is medium or poor:

  ```
  stats_report room=<code> peer=<id> peers=3 worst=poor max_rtt_ms=640 max_loss_pct=7.5 relay=1
  ```

  Healthy reports aren't logged: four healthy people would add 24 lines a minute that say nothing.

### 3. Deliberate differences from the reference

- **No automatic quality changes and no `videoHeld`** (see the top of this doc).
- **The store is keyed by (reporter, remote).** The reference keys it by reporter only, so in a room of three each report overwrites the one about the other person.
- **One compact log line, only for problems.** The reference logs every report, with a group of fields per remote.
- **Loss over the last poll,** not since the call started.
- **No `/stats` endpoint yet:** it arrives with the ops token in Phase 13.

---

## Frontend (Claude)

- **Stats monitor:**
  - `onPoll(samples)`, one sample per connection: outbound and inbound kbps, loss since the last poll, RTT and route of the pair in use, inbound jitter, and received width, height and fps
  - `gradeQuality` and `gradeNetworkPressure`
- **Peer store:** `localStats`, `peerStats: Map<peerId, PeerStats>`, and `mediaFlowEvents`, the last 10 stalls and recoveries from Phase 9.
- **`useCall`:** fills the store on every poll, sends `stats-report` every 5th one (only when there are entries), and records flow events.
- **`VideoTile`:** the quality dot for medium and poor, with the grade as its label.
- **Settings → Connection** (`ConnectionDiagnostics`), only in a call:
  - your uplink: sending bitrate, latency, route
  - one block per person: quality, latency, loss, jitter, receiving bitrate, resolution and fps, route, pressure
  - recent interruptions
  - **Copy report**, which copies all of it as plain text
- Nothing in this phase changes what is sent: no `setParameters`, and the sender keeps the browser's defaults.

## Done when

1. In a call between two devices, Settings → Connection fills in within a few seconds, with plausible latency, bitrate, resolution and route for each person. **Copy report** gives readable text.
2. On a throttled connection (macOS Network Link Conditioner with loss or latency added), that person's dot turns amber or red for the others, and their panel numbers move.
3. A normal call looks and sounds exactly as before Phase 10: the video sender's encodings are the browser's defaults (`chrome://webrtc-internals`).
4. The server log shows `stats_report … worst=poor` while someone is throttled, and nothing for healthy calls.

## Testing the server without the client

```
# After joining a room with someone else in it:
A>  {"type":"stats-report","data":{"peers":[{"peerId":"<B>","quality":"poor","networkPressure":"high","roundTripTimeMs":640,"packetLossPercent":7.5,"jitterMs":40,"outboundBitrateKbps":180,"inboundBitrateKbps":220,"candidateType":"relay"}]}}
server log:  stats_report … worst=poor max_rtt_ms=640 …
A>  the same again within 5 s           → dropped, no log
A>  an entry with "peerId":"nobody"     → that entry skipped
```
