import type { PageInfo } from '../api';

/** One wording for a Page's publishing state, used on every screen. */
export function pageState(page: Pick<PageInfo, 'postable' | 'blockReason' | 'tokenStatus'>): { label: string; cls: string } {
  if (page.postable) {
    if (page.tokenStatus === 'UNCHECKED') return { label: 'Chưa kiểm tra', cls: 'badge-draft' };
    if (page.tokenStatus === 'ERROR') return { label: 'Chưa kiểm tra được', cls: 'badge-draft' };
    return { label: 'Đăng được', cls: 'badge-published' };
  }
  switch (page.blockReason) {
    case 'OTHER_APP':
      return { label: 'App cũ', cls: 'badge-warn' };
    case 'EXPIRED':
      return { label: 'Hết hạn', cls: 'badge-failed' };
    case 'REVOKED':
      return { label: 'Mất hiệu lực', cls: 'badge-failed' };
    case 'MISSING_PERMISSIONS':
      return { label: 'Thiếu quyền', cls: 'badge-warn' };
    default:
      return { label: 'Đã ngắt', cls: 'badge-draft' };
  }
}

export function PageStatusBadge({ page }: { page: Pick<PageInfo, 'postable' | 'blockReason' | 'tokenStatus'> }) {
  const state = pageState(page);
  return <span className={`badge ${state.cls}`}>{state.label}</span>;
}

/** Tell listeners (e.g. the app-wide banner) that Pages or the App ID changed. */
export const PAGES_CHANGED = 'autopost:pages-changed';
export const notifyPagesChanged = () => window.dispatchEvent(new Event(PAGES_CHANGED));

/** Active Pages that cannot publish because their token came from another app. */
export const staleAppPages = (pages: PageInfo[]) => pages.filter((p) => p.isActive && p.blockReason === 'OTHER_APP');
