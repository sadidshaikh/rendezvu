import { log } from '../log.ts'

/**
 * A ceiling on Cloudflare sessions created per UTC day. Tokens and rate
 * limits stop casual abuse; this stops a determined script from running up
 * the bill. Media never passes through us, so sessions (not gigabytes) are
 * what the server can count.
 */
export class DailySessionCap {
  private readonly cap: number
  private day = ''
  private count = 0
  private warned = false

  /** 0 means no cap. */
  constructor(cap: number) {
    this.cap = cap
  }

  /** Whether another session may be created today. */
  allows(now = new Date()): boolean {
    this.rollOver(now)
    if (this.cap === 0 || this.count < this.cap) return true
    if (!this.warned) {
      this.warned = true
      log('sfu_daily_cap_reached', { sessions: this.count })
    }
    return false
  }

  /** A session was created. */
  record(now = new Date()): void {
    this.rollOver(now)
    this.count++
  }

  private rollOver(now: Date): void {
    const day = now.toISOString().slice(0, 10)
    if (day === this.day) return
    this.day = day
    this.count = 0
    this.warned = false
  }
}
