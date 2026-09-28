import { describe, it, expect } from 'vitest';
import { LoginLimiter, limiterKey } from '../src/lib/login-limiter';

describe('LoginLimiter', () => {
  it('blocks after 5 failures within 15 minutes, then frees up', () => {
    let now = 1_000_000;
    const limiter = new LoginLimiter(5, 15 * 60_000, () => now);
    const key = limiterKey('a@b.c', '1.2.3.4');
    for (let i = 0; i < 4; i++) limiter.fail(key);
    expect(limiter.retryAfterSeconds(key)).toBe(0);
    limiter.fail(key);
    expect(limiter.retryAfterSeconds(key)).toBe(15 * 60);
    now += 10 * 60_000;
    expect(limiter.retryAfterSeconds(key)).toBe(5 * 60);
    now += 5 * 60_000 + 1;
    expect(limiter.retryAfterSeconds(key)).toBe(0);
  });

  it('a success resets the count; keys are per email and IP', () => {
    const limiter = new LoginLimiter(2, 60_000, () => 0);
    limiter.fail(limiterKey('a@b.c', 'ip1'));
    limiter.fail(limiterKey('a@b.c', 'ip1'));
    expect(limiter.retryAfterSeconds(limiterKey('a@b.c', 'ip2'))).toBe(0);
    expect(limiter.retryAfterSeconds(limiterKey('a@b.c', 'ip1'))).toBeGreaterThan(0);
    limiter.reset(limiterKey('a@b.c', 'ip1'));
    expect(limiter.retryAfterSeconds(limiterKey('a@b.c', 'ip1'))).toBe(0);
  });
});
