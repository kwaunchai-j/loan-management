/**
 * In-memory failed-attempt limiter for login. Valid because the API runs as a single process
 * (design: one scheduler/process). Counts only failures; a success clears the key.
 */
export interface RateLimiterOptions {
  maxFailures: number;
  windowMs: number;
  now?: () => number;
}

export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(private readonly opts: RateLimiterOptions) {
    this.now = opts.now ?? Date.now;
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.opts.windowMs;
    const kept = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }

  /** Seconds the caller must wait, or 0 when allowed. */
  retryAfterSeconds(key: string): number {
    const kept = this.recent(key);
    if (kept.length < this.opts.maxFailures) return 0;
    const oldestRelevant = kept[kept.length - this.opts.maxFailures]!;
    return Math.max(1, Math.ceil((oldestRelevant + this.opts.windowMs - this.now()) / 1000));
  }

  recordFailure(key: string): void {
    const kept = this.recent(key);
    kept.push(this.now());
    this.failures.set(key, kept);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
