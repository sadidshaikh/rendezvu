# Phase 9: Media that survives problems

Status: **built**. Backend: none this phase · Frontend: Claude

## Goal

Media problems fix themselves while the call keeps going. If someone's video freezes, the browser notices within seconds and tries to repair it, more firmly each time, and never gives up while the call lasts. A short network blip doesn't trigger that repair. Unplugging a camera, revoking a permission or putting the tab in the background never leaves a dead tile. Leaving the call stops all of this at once, so nothing restarts a camera or a connection after you've gone.

## Why this comes now

Phase 8 made the *signaling* survive problems. The media connections to Cloudflare still assume nothing goes wrong once they're up:

- A push that never gets confirmed shows a toast ("Your camera or microphone isn't reaching the call yet") and then nothing else happens. `onPublishTimeout` even says "Repair arrives in Phase 9."
- A pull that errors is logged and forgotten. That person stays an avatar for the rest of the call.
- A pull that Cloudflare accepted but that never delivers media has no timer at all. It just hangs.
- Video that froze at minute four looks exactly like healthy video. Nothing measures whether media is still flowing.

Phase 10 (adapting quality) needs the same numbers this phase collects, so this comes first.

## Concepts

**"Connected" doesn't mean "working".** `RTCPeerConnection.connectionState` reports whether ICE (the network path) is up. It can say `connected` while no video arrives: Cloudflare stopped forwarding a track, a renegotiation dropped a transceiver, the publisher's encoder stalled. In the other direction, a 3-second Wi-Fi dip can flip it to `disconnected` and back with nothing for us to do. The only reliable signal is **bytes moving**. So the call watches byte counters, and treats connection state as a hint.

**Measuring byte flow with `getStats()`.** Every 2 seconds the call asks each of its connections for a stats report. The two entries that matter:

| Stats entry | Field | Meaning |
|---|---|---|
| `outbound-rtp` (publish) | `bytesSent` | Bytes we've sent for one stream so far |
| `inbound-rtp` (subscribe) | `bytesReceived` | Bytes we've received for one stream so far |

These are running totals, so one reading says nothing. Two readings 2 s apart do: if the total grew, media flowed between them. Each stream is tracked by connection, direction and `ssrc` (the RTP stream's id).

**A stall is silence that lasts.** One poll with no new bytes is normal: a gap between video keyframes, a busy CPU. Three in a row is not. A stream that **had been flowing** and then moved no bytes for **6 s** is a stall. "Had been flowing" matters: a pull that never delivered anything at all is a different problem (a dead pull, below), and counting it as a stall too would repair it twice.

Two more cases count as stalls:
- **A stream vanished** from the stats report entirely, rather than going quiet in place.
- But not when the same connection now reports another stream of the **same kind**. Browsers replace a stream's `ssrc` after a renegotiation or a device switch; that's a replacement, not a loss.

**Silence that's meant.** A stalled stream only matters if media was supposed to be on it:
- **Our own publish:** only kinds with a real device behind them count. A muted mic or a camera that's off is silence by choice. (Placeholders do send a little, but nobody needs them repaired.)
- **Someone else's stream:** their silence could be a broken pull, or they muted. The byte counters look identical. So the stall goes up to `useCall`, which checks that person's declared state (`peer-state`): audio must be on for an audio stall to count; camera or screen share on for a video stall.

**Grace before repair.** A stall that has just been noticed is often already recovering: a phone switching networks, a laptop waking up. Replacing a connection that is about to come back turns a 5-second freeze into a 15-second one. So a confirmed stall waits **20 s** before it rebuilds anything. If bytes move again during that time, the repair is cancelled.

**The repair ladder.** Each thing that can break gets its own `RepairLoop`. A repair attempt is a **rung**, and each rung is more drastic than the last:

| Rung | What it does | Cost |
|---|---|---|
| 1 | **Retry in place**: re-push or re-pull that one track on the same Cloudflare session | One HTTP request, nothing else disturbed |
| 2 | **Rebuild**: throw that direction's connection away and make a new one with a fresh Cloudflare session, then push or pull everything it carried again | A few seconds of nothing for that one person or direction |

Rung 1 runs twice, then rung 2 from then on. Which ladder is used depends on what went wrong:

| What went wrong | Noticed by | Ladder |
|---|---|---|
| A push got no confirmation within the repair window | timer per push | rung 1 ×2, then rung 2 (rebuild the publish connection) |
| A push errored | partytracks `error` | same |
| A pull delivered no track within the repair window (**dead pull**) | timer per pull | rung 1 ×2, then rung 2 (rebuild that person's subscribe connection) |
| A pull errored | partytracks `error` | same |
| A connection went `failed` | `peerConnectionState$` | straight to rung 2: retrying a track over a dead connection can't work |
| A stream that was flowing stalled | stats | rung 2 after the 20 s grace |

Only one person or one direction is ever rebuilt, never "the call". Each remote person already has their own subscribe connection (Phase 5), so rebuilding Bob's can't disturb Carol's.

**Never give up.** Attempts are unlimited. The call itself is the deadline. Stopping after five tries would trade "it works eventually" for "it definitely doesn't", which is the wrong trade. What keeps the loops bounded is that **leaving, or that person leaving, cancels them**.

**Backoff with jitter, again.** The wait before attempt *n* is 1 s doubling, capped at 30 s, then randomised between half and all of it (the same reasoning as Phase 8's reconnect). When Cloudflare has a hiccup, every browser in the room notices within the same 2-second poll; without the randomness they'd all retry in lockstep.

**Settled, not reset.** When the thing works again the loop **settles**: its pending timer is cancelled, but the attempt count is kept for **60 s**. If it breaks again within that minute, it carries on up the ladder instead of starting from rung 1. A connection that keeps breaking every 30 s doesn't get two cheap retries every time. After a full minute of working, the count goes back to zero.

**At most one rebuild per connection per 30 s.** A connection can fail on several signals at once (stalled, then `failed`, then a push error). Rebuilding it three times in a row helps nothing and creates three Cloudflare sessions. A rebuild asked for less than 30 s after the last one of the same connection is held back until the 30 s are up. Several requests in that window collapse into one.

**How long counts as "never arrived"?** Setting up a push or pull takes a few HTTP round trips plus ICE, typically 1–3 s, much slower on a bad network. The repair window starts at **15 s**. The session also remembers how long its last 40 setups took. The window becomes **twice the slowest 5%** of those setups (the 95th percentile), never below 15 s or above 60 s. On a slow network the timers stretch by themselves, instead of repairing setups that were about to finish.

**Generations: a slow answer can't overwrite a new connection.** Everything here is asynchronous, and old work can finish late. A rebuild replaces the publish connection, then the old connection's push confirms 2 s later and its callback announces the **old** session's tracks. Everyone pulls tracks that no longer exist. The fix is a counter:

```ts
const generation = this.publishGeneration      // remembered when the push starts
// … later, in any callback of that push:
if (generation !== this.publishGeneration) return   // a rebuild happened since: not ours any more
```

Every rebuild increments the counter first. The publish connection has one counter; each remote person's subscribe connection has its own. The peer store already does the same for devices (`audioGeneration`, `videoGeneration`), which is why toggling the camera quickly ends in the last state you chose: a camera that finishes opening under an old generation stops its own track.

**A rebuild has to be announced.** A new publish connection means a new Cloudflare session and new track names. The others are pulling the old ones.
1. Before rebuilding, the session withdraws the old set: `sfu-announce` with an empty track list.
2. Once each re-push is confirmed, the new set is announced as normal.
3. The others' reconcilers see a new `sessionId`, drop the old pulls and pull the new ones (Phase 5 already handles this).

The old session is released with `DELETE` as well, so its id can't be used again.

**Leaving cancels everything.** Leaving is when stray work does damage: a repair timer that fires after leave rebuilds a Cloudflare session for nobody (and turns the camera light back on). So `SfuSession.destroy()` cancels every repair loop, timer and deferred rebuild **before** closing anything. Every callback also checks `destroyed`, and `useCall` stops the stats monitor first. The same applies to one person leaving: their pull loops are cancelled with their subscribe connection.

**Devices that stop by themselves.** Phase 6 already handles a camera or mic whose track **ends** (unplugged, permission revoked, taken by another app): it's treated as switched off, the room is told, and a toast offers to turn it back on. Two gaps remain:
- **A mic that goes silent without ending.** Some systems mark the track `muted` instead, for example when another app takes the device. If it stays muted for **3 s** while still live, it's treated like an ended mic. The camera doesn't get this rule: phones mute the camera whenever the tab goes to the background and unmute it on return, which is normal.
- **Events that never arrived.** Waking from sleep, some browsers update `readyState` without firing `ended`. So when the tab becomes visible again (`visibilitychange`), the call checks the tracks once: a camera that has ended, or a mic that has ended or is muted, goes the same way as above.

**Background tabs.** Browsers slow timers down in background tabs, so the 2 s poll can run every 10 s or even once a minute. Gaps between polls would then look like long silences, and a background tab would rebuild healthy connections. So **a poll that comes more than 3× late doesn't count as silence**: it restarts each stream's silence clock instead of judging it. The reference doesn't do this. It's one line, and it removes a whole class of false repairs.

**What people see.**
- **A remote tile** whose person has a repair running (a stall that counts, a dead pull, a failed connection) shows a small "Reconnecting…" badge. The video stays on its last frame. The badge goes when media flows again.
- **Your own publish:** after a push timeout, the toast reads "Your camera isn't reaching others yet. Reconnecting it now." (or "microphone"), since something now really does reconnect it.
- Repairs are logged to the browser console, `[repair]` for attempts and `[repaired]` for recoveries, with the direction, rung, attempt and track. That's how to tell "rung 1 fixes things" from "everything ends up rebuilding".

---

## Backend requirements

None. Rebuilds use the routes that already exist:
- A rebuild creates a new session with `POST /sfu/sessions/new`, owned by the same `presenceId` (Phase 8).
- The old session is released with `DELETE /sfu/sessions/:id`.
- The re-announce is an ordinary `sfu-announce`.

The rate limits already fit: 30 sessions a minute per tab, with a burst of 40, is far more than one rebuild per connection per 30 s.

In the server log, one publish rebuild looks like this:

```
sfu_tracks_withdrawn room=<code> peer=<id> session=<old> version=…
sfu_session_closed   room=<code> presence=1a2b3c4d session=<old>
sfu_session          room=<code> presence=1a2b3c4d kind=publish session=<new>
sfu_publish_accepted room=<code> presence=1a2b3c4d session=<new> tracks=…
sfu_tracks           room=<code> peer=<id> session=<new> tracks=2 …
```

---

## Frontend (Claude)

- **`services/webrtc/repair-loop.ts`:**
  - `RepairLoop` with `schedule()` (does nothing while an attempt is pending, so several signals collapse into one), `settle()`, `reset()` and `cancel()`
  - rungs from `attemptsPerRung` and `maxRung`; delays 1 s doubling to 30 s with 50–100% jitter
  - the attempt count is kept for 60 s after settling
- **`services/webrtc/stats-monitor.ts`:**
  - `startStatsMonitor({ collect, onStall, onRecover })`, polling every 2 s
  - per-stream byte deltas; a stall after 6 s of silence on a stream that had flowed
  - vanished streams; `ssrc` replacement; publish kinds without a live device ignored
  - polls more than 3× late restart the silence clocks
  - reports facts only, never touches a connection
- **`SfuSession`:**
  - `collectStats()`: one report per live connection, each with its `sessionId`, and for publish the kinds with a real device behind them
  - push ladder and pull ladder (rung 1 re-push or re-pull, rung 2 rebuild)
  - `failed` connections go to rung 2
  - `repairStalledFlow(direction, sessionId?)` and `settleStalledFlow(…)` for the 20 s grace
  - the 30 s rebuild throttle; the adaptive repair window
  - `publishGeneration` and a generation per remote session; every callback checks its generation and `destroyed`
  - a publish rebuild withdraws, releases the old session and pushes the **current** track of each kind (real or placeholder), so a camera turned off meanwhile stays off
  - `subscribeTrack` keeps the pull's record inside the session, so rung 2 can pull everything again, and calls `onTrack` again with the new track
  - `destroy()` and `unsubscribeSession()` cancel their loops before closing
  - options `onRepair(info)` and `onRepaired(info)`, plus `onRemoteHealth(remoteSessionId, reconnecting)` for the tile badge
- **`useCall`:**
  - starts the stats monitor after the SFU session and stops it first on cleanup
  - judges remote stalls against the peer store's declared state
  - maps sessions to people with `reconciler.peerForSession`
  - logs `[repair]` and `[repaired]`
- **Peer store:** `mediaReconnecting: Set<peerId>`, set and cleared by `useCall`.
- **`VideoTile`:** the "Reconnecting…" badge.
- **`useCallControls`:** the 3 s mic `mute` rule and the `visibilitychange` check, through the same handler as `ended`.
- The publish-timeout toast text changes as above.

## Deliberate differences from the reference

- **No telemetry.** The reference sends repair counts and stalls to Sentry and a metrics endpoint. Rendezvu has neither, so they go to the console. The events are the same, so wiring them up later is one function.
- **No audio/video sync check.** The reference measures how far audio and video playout drift apart, and only reports it; it never acts on it. Without telemetry there's nowhere to report it, so it waits.
- **Late polls don't count as silence** (see Background tabs). The reference has no such rule.

## Not in this phase

- **Connection quality** (round-trip time, loss, the quality dot on tiles) and lowering video quality when the network struggles: Phase 10. The stats monitor built here is what it reads.
- **ICE restart** as a cheaper rung between retry and rebuild. The reference doesn't have it either, and partytracks owns the negotiation an ICE restart would need.

## Done when

1. **Short block:** block UDP for 5 s mid-call (see below). Video freezes, then comes back by itself. The console shows a stall and a recovery, but **no rebuild**, and the server log shows no new `sfu_session`.
2. **Long block:** block UDP for 40 s. Rebuilds happen and get logged, and within about 30 s of unblocking, everyone sees and hears everyone again. Nobody clicks anything.
3. **Fast toggling:** click the camera button 6 times quickly. The camera ends in the state of the last click, the room shows the same state, and no camera light stays on when the final state is off.
4. **Leaving during setup:** click Leave within a second of Join. The camera light goes off. In `chrome://webrtc-internals` every connection is closed, and the Network tab shows no `/sfu` request afterwards.
5. **Unplugging a camera mid-call** shows the toast and an avatar to the others. Plugging it back in and clicking the camera button brings the video back.
6. **Background tab:** put a call tab in the background for 2 minutes and bring it back. No `[repair]` lines in its console, and the call is still fine.
7. **A person leaving while their pull is repairing:** no more `[repair]` lines for them after they've gone.

## Blocking UDP on macOS

Cloudflare's media runs over UDP. Signaling and page loads are TCP, so they keep working.

```sh
# block all UDP (needs sudo)
echo "block drop quick proto udp all" | sudo pfctl -ef -
# … wait 5 s (or 40 s) …
# undo: reload the normal rules and turn the firewall back off
sudo pfctl -f /etc/pf.conf && sudo pfctl -d
```

macOS's Network Link Conditioner, with a profile at 100% packet loss, works too. It drops TCP as well, so the Phase 8 banner shows up alongside.
