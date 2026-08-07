/**
 * Counts failed attempts per key within a sliding window, so the login endpoint
 * can't be brute-forced at wire speed.
 *
 * In-memory on purpose: a shared secret guarding one user's machine doesn't justify
 * a dependency or a table, and a restart clearing the counters is not a meaningful
 * weakness when the window is minutes long. Only failures count - succeeding
 * shouldn't push you toward a lockout.
 */
export type LimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export class AttemptLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Whether this key may attempt again, and how long to wait if not. */
  check(key: string, now = Date.now()): LimitDecision {
    this.prune(now);
    const hit = this.hits.get(key);
    if (!hit || hit.count < this.max) return { allowed: true };
    return { allowed: false, retryAfterSeconds: Math.ceil((hit.resetAt - now) / 1000) };
  }

  /** Record a failure, starting a fresh window if the previous one has expired. */
  fail(key: string, now = Date.now()): void {
    this.prune(now);
    const hit = this.hits.get(key);
    if (!hit) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    hit.count += 1;
  }

  /** Forget a key's failures, called after a successful attempt. */
  succeed(key: string): void {
    this.hits.delete(key);
  }

  /**
   * Drop expired entries. Without this the map grows with every distinct source
   * address, which would turn the defence into a memory leak.
   */
  private prune(now: number): void {
    for (const [key, hit] of this.hits) {
      if (hit.resetAt <= now) this.hits.delete(key);
    }
  }
}
