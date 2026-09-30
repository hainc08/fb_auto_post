import type { QueuedPost } from '../api';

/** 0 = Chủ nhật … 6 = Thứ bảy; shown Monday first */
export const WEEKDAY_SHORT = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** "T2, T4, T6 · 08:00, 19:30" · "Mỗi ngày · 08:00" */
export function describeSlots(weekdays: number[] | null, slots: string[] | null): string {
  const days = weekdays ?? [];
  const dayText = days.length === 7 ? 'Mỗi ngày' : WEEKDAY_ORDER.filter((d) => days.includes(d)).map((d) => WEEKDAY_SHORT[d]).join(', ');
  return `${dayText || 'Chưa chọn ngày'} · ${(slots ?? []).join(', ') || 'chưa có giờ'}`;
}

/** "T6 25/09 19:30" in Vietnam time */
export function slotLabel(iso: string | null): string {
  if (!iso) return 'Chưa có khung giờ';
  const vn = new Date(new Date(iso).getTime() + 7 * 3600_000);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${WEEKDAY_SHORT[vn.getUTCDay()]} ${two(vn.getUTCDate())}/${two(vn.getUTCMonth() + 1)} ${two(vn.getUTCHours())}:${two(vn.getUTCMinutes())}`;
}

export function queueStatus(p: Pick<QueuedPost, 'status'>): { label: string; cls: string } {
  switch (p.status) {
    case 'DRAFT':
    case 'GENERATING':
      return { label: 'AI đang viết', cls: 'badge-generating' };
    case 'READY':
      return { label: 'Chờ duyệt', cls: 'badge-ready' };
    case 'SCHEDULED':
      return { label: 'Đã duyệt', cls: 'badge-scheduled' };
    default:
      return { label: 'AI viết lỗi', cls: 'badge-failed' };
  }
}
