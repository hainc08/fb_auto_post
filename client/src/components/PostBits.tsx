import { ImageIcon } from 'lucide-react';
import { assetUrl } from '../api';

/** One place for status wording, so every screen says the same thing. */
export const STATUS_META: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Nháp', cls: 'badge-draft' },
  GENERATING: { label: 'Đang tạo…', cls: 'badge-generating' },
  READY: { label: 'Chờ duyệt', cls: 'badge-ready' },
  SCHEDULED: { label: 'Đã lên lịch', cls: 'badge-scheduled' },
  PUBLISHING: { label: 'Đang đăng…', cls: 'badge-publishing' },
  PUBLISHED: { label: 'Đã đăng', cls: 'badge-published' },
  FAILED: { label: 'Lỗi', cls: 'badge-failed' },
};

export function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, cls: 'badge-draft' };
  return <span className={`badge ${meta.cls}`}>{meta.label}</span>;
}

export function PostThumb({ src, size = 52 }: { src?: string | null; size?: number }) {
  if (src) return <img className="post-thumb" src={assetUrl(src)!} alt="" style={{ width: size, height: size }} />;
  return (
    <span className="post-thumb" style={{ width: size, height: size }} aria-hidden="true">
      <ImageIcon size={20} strokeWidth={1.8} />
    </span>
  );
}

/** "Hôm nay 15:26" · "Hôm qua 09:10" · "21/09 18:00" */
export function formatWhen(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return `Hôm nay ${time}`;
  if (days === 1) return `Hôm qua ${time}`;
  return `${d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })} ${time}`;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** The hook = first line/sentence of the caption, used as the row title. */
export function postTitle(caption?: string | null): string {
  const text = (caption ?? '').trim();
  if (!text) return '';
  return text.split('\n').find((l) => l.trim())!.trim();
}

export const wordCount = (text?: string | null) => (text ?? '').trim().split(/\s+/).filter(Boolean).length;

export const pageInitials = (name?: string | null) =>
  (name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(-2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
