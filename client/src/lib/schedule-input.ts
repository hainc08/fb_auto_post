/** Pure helpers for the "Hẹn giờ đăng" field (no React, no DOM): tested from tests/schedule-input.test.ts. */

/** Times are entered and shown in Vietnam time, like slot schedules */
const VN_OFFSET_MS = 7 * 3600_000;
export const MIN_LEAD_MINUTES = 1;
export const MAX_AHEAD_DAYS = 90;

const two = (n: number) => String(n).padStart(2, '0');

/** A moment → value of <input type="datetime-local"> (Vietnam wall time) */
export function toInputValue(d: Date): string {
  const vn = new Date(d.getTime() + VN_OFFSET_MS);
  return `${vn.getUTCFullYear()}-${two(vn.getUTCMonth() + 1)}-${two(vn.getUTCDate())}T${two(vn.getUTCHours())}:${two(vn.getUTCMinutes())}`;
}

/** Value of the field (Vietnam wall time) → the moment; null when empty or not a real date */
export function fromInputValue(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - VN_OFFSET_MS);
  // 31 February rolls over to March: not what was typed
  return toInputValue(d) === m[0] ? d : null;
}

/** First suggestion: the next full hour that is at least 30 minutes away */
export function suggestedTime(now = new Date()): Date {
  return new Date(Math.ceil((now.getTime() + 30 * 60_000) / 3600_000) * 3600_000);
}

/** Why the field's value cannot be used (shown under the field); null = fine */
export function inputProblem(value: string, now = new Date()): string | null {
  const at = fromInputValue(value);
  if (!at) return 'Chọn ngày và giờ đăng.';
  if (at.getTime() < now.getTime() + MIN_LEAD_MINUTES * 60_000) return 'Giờ đăng phải sau hiện tại ít nhất 1 phút.';
  if (at.getTime() > now.getTime() + MAX_AHEAD_DAYS * 86_400_000) return `Chỉ hẹn được trong ${MAX_AHEAD_DAYS} ngày tới.`;
  return null;
}
