import { describe, it, expect } from 'vitest';
import { nextRunAt, tzOffsetMinutes } from '../src/lib/schedule-time';

// 2026-09-25 09:30 in Vietnam (UTC+7) = 02:30Z. Friday.
const START = new Date('2026-09-25T02:30:00Z');
const iso = (d: Date | null) => d?.toISOString() ?? null;

describe('tzOffsetMinutes', () => {
  it('knows Vietnam is UTC+7 whatever the server timezone', () => {
    expect(tzOffsetMinutes('Asia/Ho_Chi_Minh', START)).toBe(420);
    expect(tzOffsetMinutes('UTC', START)).toBe(0);
  });
});

describe('nextRunAt', () => {
  it('first run is startDate when it is still in the future', () => {
    expect(iso(nextRunAt({ frequency: 'DAILY', startDate: START }, new Date('2026-09-24T00:00:00Z')))).toBe(START.toISOString());
  });

  it('ONCE runs once and never again (no yearly repeat)', () => {
    expect(nextRunAt({ frequency: 'ONCE', startDate: START }, START)).toBeNull();
  });

  it('DAILY keeps 09:30 Vietnam time, including right after midnight UTC', () => {
    expect(iso(nextRunAt({ frequency: 'DAILY', startDate: START }, START))).toBe('2026-09-26T02:30:00.000Z');
    // 23:00Z on the 26th is already 06:00 on the 27th in Vietnam → 09:30 that same VN day
    expect(iso(nextRunAt({ frequency: 'DAILY', startDate: START }, new Date('2026-09-26T23:00:00Z')))).toBe('2026-09-27T02:30:00.000Z');
  });

  it('WEEKLY returns the same weekday a week later', () => {
    expect(iso(nextRunAt({ frequency: 'WEEKLY', startDate: START }, START))).toBe('2026-10-02T02:30:00.000Z');
  });

  it('MONTHLY clamps day 31 to the last day of shorter months', () => {
    const jan31 = new Date('2026-01-31T02:30:00Z');
    expect(iso(nextRunAt({ frequency: 'MONTHLY', startDate: jan31 }, jan31))).toBe('2026-02-28T02:30:00.000Z');
    expect(iso(nextRunAt({ frequency: 'MONTHLY', startDate: jan31 }, new Date('2026-02-28T03:00:00Z')))).toBe('2026-03-31T02:30:00.000Z');
  });

  it('stops after endDate', () => {
    const endDate = new Date('2026-09-26T00:00:00Z');
    expect(nextRunAt({ frequency: 'DAILY', startDate: START, endDate }, START)).toBeNull();
  });
});
