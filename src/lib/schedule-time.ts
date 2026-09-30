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

// ─── Slot schedules (weekdays + times of day) ───

export const VN_TZ = 'Asia/Ho_Chi_Minh';
export const SLOT_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Enough to find a slot even for a schedule that posts once a week near its end date */
const MAX_DAYS_AHEAD = 400;

export interface SlotTiming {
  /** 0 = Sunday … 6 = Saturday, as seen in `timezone` */
  weekdays: number[];
  /** "HH:mm", 24 h */
  slots: string[];
  startDate?: Date | null;
  endDate?: Date | null;
  timezone?: string;
}

const dayOfWeek = (w: WallClock) => new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();

/** The next `count` slots strictly after `after`, within startDate…endDate, in order. */
export function nextSlots(t: SlotTiming, after: Date, count: number): Date[] {
  const tz = t.timezone || VN_TZ;
  const days = new Set(t.weekdays);
  const times = [...new Set(t.slots)]
    .filter((s) => SLOT_PATTERN.test(s))
    .sort()
    .map((s) => s.split(':').map(Number) as [number, number]);
  const out: Date[] = [];
  if (!days.size || !times.length || count <= 0) return out;

  const from = t.startDate && t.startDate.getTime() > after.getTime() ? t.startDate : after;
  const first = toWall(from, tz);
  for (let i = 0; i <= MAX_DAYS_AHEAD && out.length < count; i++) {
    const day = addDays(first, i);
    if (!days.has(dayOfWeek(day))) continue;
    for (const [hour, minute] of times) {
      const at = fromWall({ ...day, hour, minute }, tz);
      if (at.getTime() <= after.getTime()) continue;
      if (t.startDate && at.getTime() < t.startDate.getTime()) continue;
      if (t.endDate && at.getTime() > t.endDate.getTime()) return out;
      out.push(at);
      if (out.length === count) break;
    }
  }
  return out;
}

/** Weekday (0 = Sunday) and "HH:mm" of an instant, as seen in `tz`. */
export function wallTime(date: Date, tz: string = VN_TZ): { weekday: number; hhmm: string } {
  const w = toWall(date, tz);
  return { weekday: dayOfWeek(w), hhmm: `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}` };
}
