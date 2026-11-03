// Time to first media: from clicking Join (or being let in) to the first
// frame of someone else's video actually playing. One console line per call,
// for measuring by hand until Phase 13's metrics exist.

let startedAt: number | null = null

/** Join clicked, or a waiting guest let in. Starts the clock for this call. */
export function markJoinStarted(): void {
  startedAt = performance.now()
}

/**
 * Someone joined while we were still waiting for any remote video. Time
 * spent alone in the room isn't connection time, so the clock starts over
 * from their arrival.
 */
export function markPeerArrived(): void {
  if (startedAt !== null) startedAt = performance.now()
}

/** A remote video played its first frame. Only the first one per call counts. */
export function markFirstRemoteFrame(): void {
  if (startedAt === null) return
  console.info(`[ttfm] ${Math.round(performance.now() - startedAt)} ms (join → first remote frame playing)`)
  startedAt = null
}
