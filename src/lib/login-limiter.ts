/**
 * Failed-login counter per `email|IP`, in process memory (reset on restart —
 * acceptable for a small internal team). 5 failures / 15 minutes ⇒ locked.
 */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max = 5,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = () => Date.now()
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  /** 0 when allowed, otherwise seconds until the oldest failure expires. */
  retryAfterSeconds(key: string): number {
    const list = this.recent(key);
    if (list.length < this.max) return 0;
    return Math.max(1, Math.ceil((list[0] + this.windowMs - this.now()) / 1000));
  }

  fail(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.failures.set(key, list);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}

export const loginLimiter = new LoginLimiter();
export const limiterKey = (email: string, ip: string | undefined) => `${email}|${ip ?? ''}`;
