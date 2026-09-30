/** Pure display helpers for the Posts list (no React, no DOM): tested from tests/post-display.test.ts. */

export type TargetStatus = 'PENDING' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED';

export interface TargetSummary {
  status: TargetStatus;
  errorMessage?: string | null;
  page?: { id: string; pageName: string } | null;
}

export interface ListPost {
  status: string;
  caption: string | null;
  publishedAt: string | null;
  scheduledAt: string | null;
  createdAt: string;
  page?: { id: string } | null;
  targets?: TargetSummary[];
  domain?: { id: string } | null;
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Title = first line (cut at a sentence end or a word when long); preview = everything after it. */
export function splitCaption(caption: string | null | undefined, maxTitle = 110): { title: string; preview: string } {
  const text = (caption ?? '').trim();
  if (!text) return { title: '', preview: '' };
  const lines = text.split('\n');
  const firstIndex = lines.findIndex((l) => l.trim());
  const first = lines[firstIndex].trim();
  const after = lines.slice(firstIndex + 1).join(' ');
  if (first.length <= maxTitle) return { title: first, preview: collapse(after) };

  // A sentence end inside the limit (". ", "! ", "? ", "… ")
  const sentence = first.slice(0, maxTitle + 1).match(/^.*?[.!?…](?=\s|$)/);
  if (sentence && sentence[0].length >= 20) {
    return { title: sentence[0].trim(), preview: collapse(`${first.slice(sentence[0].length)} ${after}`) };
  }
  const cut = first.lastIndexOf(' ', maxTitle);
  const at = cut > 20 ? cut : maxTitle;
  return { title: `${first.slice(0, at).trim()}…`, preview: collapse(`${first.slice(at)} ${after}`) };
}

/** Multi-Page progress wording; null when a single Page (the status badge says it all). */
export function publishProgress(
  targets: TargetSummary[] | undefined
): { label: string; tone: 'success' | 'error' | 'progress' | 'neutral' } | null {
  if (!targets || targets.length <= 1) return null;
  const n = targets.length;
  const published = targets.filter((t) => t.status === 'PUBLISHED').length;
  const failed = targets.filter((t) => t.status === 'FAILED').length;
  const moving = targets.some((t) => t.status === 'PUBLISHING') || (published > 0 && published + failed < n);
  if (failed > 0 && !moving) return { label: `${published}/${n} thành công`, tone: 'error' };
  if (published === n) return { label: `Đã đăng ${n}/${n}`, tone: 'success' };
  if (moving) return { label: `Đang đăng ${published}/${n}`, tone: 'progress' };
  return { label: `${n} Page`, tone: 'neutral' };
}

/** Facebook / app error → a few words (the full text goes in a tooltip). */
export function shortError(message: string | null | undefined): string {
  const m = message ?? '';
  if (/App khác|app cũ|OTHER_APP/i.test(m)) return 'Token của App cũ';
  if (/token|expired|hết hạn|session/i.test(m)) return 'Token hết hạn';
  if (/permission|quyền/i.test(m)) return 'Thiếu quyền';
  return 'Đăng thất bại';
}

export function visibleTags(tags: string[] | null | undefined, max = 2): { shown: string[]; more: number } {
  const clean = (tags ?? []).map((t) => t.trim().replace(/^#+/, '')).filter(Boolean);
  return { shown: clean.slice(0, max).map((t) => `#${t}`), more: Math.max(0, clean.length - max) };
}

export type TimeRange = '' | 'today' | '7d' | '30d';
export const TIME_RANGES: Array<{ value: TimeRange; label: string }> = [
  { value: '', label: 'Mọi lúc' },
  { value: 'today', label: 'Hôm nay' },
  { value: '7d', label: '7 ngày qua' },
  { value: '30d', label: '30 ngày qua' },
];

/** From the start of the range onwards (posts scheduled ahead count as inside). */
export function inTimeRange(iso: string, range: TimeRange, now = new Date()): boolean {
  if (!range) return true;
  const start = new Date(now);
  if (range === 'today') start.setHours(0, 0, 0, 0);
  else start.setTime(now.getTime() - (range === '7d' ? 7 : 30) * 24 * 3600_000);
  return new Date(iso).getTime() >= start.getTime();
}

/** The time a post is "about": published, else its slot, else creation */
export const postTime = (p: ListPost) => p.publishedAt ?? p.scheduledAt ?? p.createdAt;

export function matchesFilters(p: ListPost, f: { q: string; pageId: string; time: TimeRange }, now = new Date()): boolean {
  const needle = f.q.trim().toLowerCase();
  if (needle && !(p.caption ?? '').toLowerCase().includes(needle)) return false;
  if (f.pageId && p.page?.id !== f.pageId && !p.targets?.some((t) => t.page?.id === f.pageId)) return false;
  return inTimeRange(postTime(p), f.time, now);
}

/** '' = all; one key per status present */
export function statusCounts(posts: ListPost[]): Record<string, number> {
  const c: Record<string, number> = { '': posts.length };
  for (const p of posts) c[p.status] = (c[p.status] ?? 0) + 1;
  return c;
}

/**
 * Page filter: shown for several Pages, and always while a Page is chosen, so it can be cleared
 * even when that Page is no longer among the loaded posts (domain filter, stale URL).
 */
export function pageFilterOptions(
  pages: Array<{ id: string; pageName: string }>,
  selectedId: string
): { show: boolean; options: Array<{ id: string; pageName: string }> } {
  const options = selectedId && !pages.some((p) => p.id === selectedId) ? [...pages, { id: selectedId, pageName: 'Page đã chọn' }] : pages;
  return { show: pages.length > 1 || !!selectedId, options };
}
