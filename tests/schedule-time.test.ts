import { describe, it, expect } from 'vitest';
import { nextRunAt, nextSlots, tzOffsetMinutes, wallTime } from '../src/lib/schedule-time';

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

describe('nextSlots', () => {
  // Friday 2026-09-25 10:00 in Vietnam = 03:00Z
  const FRI_10H = new Date('2026-09-25T03:00:00Z');
  const isoAll = (ds: Date[]) => ds.map((d) => d.toISOString());

  it('returns the next slots on the chosen weekdays, in Vietnam time', () => {
    // Mon(1), Wed(3), Fri(5) at 08:00 and 19:30
    const got = nextSlots({ weekdays: [1, 3, 5], slots: ['19:30', '08:00'] }, FRI_10H, 4);
    expect(isoAll(got)).toEqual([
      '2026-09-25T12:30:00.000Z', // Fri 19:30
      '2026-09-28T01:00:00.000Z', // Mon 08:00
      '2026-09-28T12:30:00.000Z', // Mon 19:30
      '2026-09-30T01:00:00.000Z', // Wed 08:00
    ]);
  });

  it('never returns a slot at or before `after`', () => {
    const at = new Date('2026-09-25T12:30:00Z'); // exactly Fri 19:30
    expect(nextSlots({ weekdays: [5], slots: ['19:30'] }, at, 1)[0].toISOString()).toBe('2026-10-02T12:30:00.000Z');
  });

  it('respects startDate and endDate', () => {
    const t = { weekdays: [0, 1, 2, 3, 4, 5, 6], slots: ['09:00'], startDate: new Date('2026-09-27T02:00:00Z'), endDate: new Date('2026-09-28T16:59:00Z') };
    expect(isoAll(nextSlots(t, FRI_10H, 5))).toEqual(['2026-09-27T02:00:00.000Z', '2026-09-28T02:00:00.000Z']);
  });

  it('returns nothing without weekdays or valid slots', () => {
    expect(nextSlots({ weekdays: [], slots: ['09:00'] }, FRI_10H, 3)).toEqual([]);
    expect(nextSlots({ weekdays: [1], slots: ['25:00', 'x'] }, FRI_10H, 3)).toEqual([]);
  });

  it('crosses midnight UTC correctly (23:30 Vietnam is 16:30Z the same day)', () => {
    expect(nextSlots({ weekdays: [5], slots: ['23:30'] }, FRI_10H, 1)[0].toISOString()).toBe('2026-09-25T16:30:00.000Z');
  });
});

describe('wallTime', () => {
  it('gives weekday and HH:mm as seen in Vietnam', () => {
    expect(wallTime(new Date('2026-09-25T17:15:00Z'))).toEqual({ weekday: 6, hhmm: '00:15' }); // Sat 00:15 in Vietnam
  });
});
