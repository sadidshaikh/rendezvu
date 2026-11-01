export interface RepairLoopOptions {
  /** Highest rung to escalate to. Rung 1 is the cheapest retry. */
  maxRung: number
  /** Runs one attempt. A throw counts as a failed attempt. */
  repair: (rung: number, attempt: number) => void
  /** Attempts at each rung before moving up. */
  attemptsPerRung?: number
  baseDelayMs?: number
  maxDelayMs?: number
  /** False for a fixed wait, such as the grace before rebuilding a stalled connection. */
  jitter?: boolean
}

const DEFAULT_ATTEMPTS_PER_RUNG = 2
const DEFAULT_BASE_DELAY_MS = 1_000
const DEFAULT_MAX_DELAY_MS = 30_000
// After a repair works, the attempt count stays this long. Something that
// breaks again within it carries on up the ladder instead of starting over.
const STABLE_AFTER_MS = 60_000

/**
 * Escalating repair attempts for one thing that should work and doesn't: a
 * push with no confirmation, a pull with no track, a dead connection.
 *
 * Attempts are unlimited: the call is the deadline, and "works eventually"
 * beats "definitely doesn't". What stops a loop is its owner cancelling it,
 * when that person leaves or the call ends. Delays double up to a cap, so a
 * long call keeps trying at a steady rate.
 */
export class RepairLoop {
  private timer: ReturnType<typeof setTimeout> | null = null
  private attemptCount = 0
  private cancelled = false
  private settledAt: number | null = null
  private readonly opts: Required<RepairLoopOptions>

  constructor(opts: RepairLoopOptions) {
    this.opts = {
      attemptsPerRung: DEFAULT_ATTEMPTS_PER_RUNG,
      baseDelayMs: DEFAULT_BASE_DELAY_MS,
      maxDelayMs: DEFAULT_MAX_DELAY_MS,
      jitter: true,
      ...opts,
    }
  }

  get attempts(): number {
    return this.attemptCount
  }

  /** An attempt is pending or has run, and nothing has worked since. */
  get repairing(): boolean {
    return this.settledAt === null && (this.attemptCount > 0 || this.timer !== null)
  }

  /** The rung the next attempt runs at. */
  get nextRung(): number {
    return this.rungFor(this.attemptCount + 1)
  }

  /**
   * Arms the next attempt. Does nothing while one is pending, so several
   * signals for the same failure (an error, then a timeout) become one repair.
   */
  schedule(): void {
    if (this.cancelled || this.timer !== null) return
    if (this.settledAt !== null) {
      if (Date.now() - this.settledAt >= STABLE_AFTER_MS) this.attemptCount = 0
      this.settledAt = null
    }
    const attempt = this.attemptCount + 1
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.cancelled) return
      this.attemptCount = attempt
      try {
        this.opts.repair(this.rungFor(attempt), attempt)
      } catch (err) {
        // The next failure signal schedules again, one rung higher.
        console.warn('[repair] attempt threw', err)
      }
    }, this.delayFor(attempt))
  }

  /** It works again. Cancels what's pending but keeps the count for a minute. */
  settle(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.settledAt ??= Date.now()
  }

  /** Back to rung 1 straight away. */
  reset(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.attemptCount = 0
    this.settledAt = null
  }

  /** For good: the person left, or the call ended. */
  cancel(): void {
    this.cancelled = true
    this.reset()
  }

  private rungFor(attempt: number): number {
    return Math.min(Math.ceil(attempt / this.opts.attemptsPerRung), this.opts.maxRung)
  }

  /** Doubling up to the cap, randomised between half and all of it so a room doesn't retry in lockstep. */
  private delayFor(attempt: number): number {
    const capped = Math.min(this.opts.baseDelayMs * 2 ** (attempt - 1), this.opts.maxDelayMs)
    return this.opts.jitter ? Math.round(capped * (0.5 + Math.random() * 0.5)) : capped
  }
}
