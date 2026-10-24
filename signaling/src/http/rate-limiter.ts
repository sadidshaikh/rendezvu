interface Bucket {
  tokens: number
  seen: number
}

export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number }

const IDLE_BUCKET_MS = 10 * 60_000
const PRUNE_EVERY_MS = 60_000

/**
 * Token bucket per key. Each key may make `burst` requests at once, then
 * refills at `perMinute`. Rejections say how long to wait, which turns a
 * rejection into backpressure a client can obey instead of retrying into.
 */
export class RateLimiter {
  private readonly ratePerMs: number
  private readonly burst: number
  private readonly buckets = new Map<string, Bucket>()
  private lastPrune = 0

  constructor(perMinute: number, burst: number) {
    this.ratePerMs = perMinute / 60_000
    this.burst = burst
  }

  take(key: string, now = Date.now()): RateDecision {
    this.prune(now)

    const bucket = this.buckets.get(key)
    if (!bucket) {
      this.buckets.set(key, { tokens: this.burst - 1, seen: now })
      return { allowed: true }
    }

    bucket.tokens = Math.min(this.burst, bucket.tokens + (now - bucket.seen) * this.ratePerMs)
    bucket.seen = now

    if (bucket.tokens < 1) {
      const waitMs = (1 - bucket.tokens) / this.ratePerMs + 1000
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) }
    }
    bucket.tokens -= 1
    return { allowed: true }
  }

  private prune(now: number): void {
    if (now - this.lastPrune < PRUNE_EVERY_MS) return
    this.lastPrune = now
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.seen > IDLE_BUCKET_MS) this.buckets.delete(key)
    }
  }
}
