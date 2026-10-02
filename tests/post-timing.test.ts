import { describe, it, expect } from 'vitest';
import { timedJobMayRun, timedProblem } from '../src/lib/post-timing';

const now = new Date('2026-10-03T01:00:00.000Z');
const plus = (ms: number) => new Date(now.getTime() + ms);

describe('timedProblem', () => {
  it('accepts a time between 30 seconds and 90 days ahead', () => {
    expect(timedProblem(plus(30_000), now)).toBeNull();
    expect(timedProblem(plus(90 * 86_400_000), now)).toBeNull();
  });

  it('refuses the past and "right now"', () => {
    expect(timedProblem(plus(-60_000), now)).toMatch(/ít nhất 1 phút/);
    expect(timedProblem(plus(29_000), now)).toMatch(/ít nhất 1 phút/);
  });

  it('refuses more than 90 days ahead', () => {
    expect(timedProblem(plus(90 * 86_400_000 + 1), now)).toMatch(/90 ngày/);
  });

  it('refuses an invalid date', () => {
    expect(timedProblem(new Date('nope'), now)).toMatch(/không hợp lệ/);
  });
});

describe('timedJobMayRun', () => {
  // Decided from the post alone (no database): the first attempt already took the post
  it('lets a retry go on while the post is being written or its Pages are being queued', async () => {
    expect(await timedJobMayRun({ id: 'no-such-post', status: 'GENERATING' }, now, 2)).toBe(true);
    expect(await timedJobMayRun({ id: 'no-such-post', status: 'PUBLISHING' }, now, 2)).toBe(true);
    expect(await timedJobMayRun({ id: 'no-such-post', status: 'PUBLISHING' }, now, 3)).toBe(true);
  });
});
