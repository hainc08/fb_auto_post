/**
 * Next run time of a schedule, computed in the schedule's own timezone
 * (default Asia/Ho_Chi_Minh), independent of the server clock's timezone.
 *
 * The time of day, weekday and day of month all come from `startDate` as seen
 * in that timezone. No run happens before `startDate` or after `endDate`.
 */

export type Frequency = 'ONCE' | 'DAILY' | 'WEEKLY' | 'MONTHLY';

export interface ScheduleTiming {
  frequency: Frequency;
  startDate: Date;
  endDate?: Date | null;
  timezone?: string;
}

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

/** Offset of `tz` from UTC at instant `date`, in minutes (e.g. +420 for Vietnam). */
export function tzOffsetMinutes(tz: string, date: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(date)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)])
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

function toWall(date: Date, tz: string): WallClock {
  const shifted = new Date(date.getTime() + tzOffsetMinutes(tz, date) * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/** Wall-clock time in `tz` → UTC instant (second pass handles DST edges). */
function fromWall(w: WallClock, tz: string): Date {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const first = guess - tzOffsetMinutes(tz, new Date(guess)) * 60_000;
  return new Date(guess - tzOffsetMinutes(tz, new Date(first)) * 60_000);
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Add whole days to a calendar date (no timezone involved). */
function addDays(w: WallClock, days: number): WallClock {
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day + days));
  return { ...w, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * First run strictly after `after` (and not before startDate), or null when the
 * schedule has no run left (ONCE already passed, or past endDate).
 */
export function nextRunAt(s: ScheduleTiming, after: Date): Date | null {
  const tz = s.timezone || 'Asia/Ho_Chi_Minh';
  const start = s.startDate;
  let next: Date | null;

  if (start.getTime() > after.getTime()) {
    next = start;
  } else if (s.frequency === 'ONCE') {
    next = null;
  } else {
    const base = toWall(start, tz);
    const now = toWall(after, tz);
    const at = (w: WallClock) => fromWall({ ...w, hour: base.hour, minute: base.minute }, tz);
    next = null;

    if (s.frequency === 'DAILY') {
      for (let i = 0; i <= 1 && !next; i++) {
        const c = at(addDays(now, i));
        if (c.getTime() > after.getTime()) next = c;
      }
    } else if (s.frequency === 'WEEKLY') {
      const targetDow = new Date(Date.UTC(base.year, base.month - 1, base.day)).getUTCDay();
      for (let i = 0; i <= 7 && !next; i++) {
        const day = addDays(now, i);
        if (new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay() !== targetDow) continue;
        const c = at(day);
        if (c.getTime() > after.getTime()) next = c;
      }
    } else {
      // MONTHLY: same day of month, clamped to the month's last day (31 → 30/28…)
      for (let i = 0; i <= 2 && !next; i++) {
        const m = now.month - 1 + i;
        const year = now.year + Math.floor(m / 12);
        const month = (m % 12) + 1;
        const c = at({ ...now, year, month, day: Math.min(base.day, daysInMonth(year, month)) });
        if (c.getTime() > after.getTime()) next = c;
      }
    }
  }

  if (next && s.endDate && next.getTime() > s.endDate.getTime()) return null;
  return next;
}
