import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { pagesApi, type PageInfo } from '../api';
import { PAGES_CHANGED, staleAppPages } from './PageStatus';

const WARN_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
const names = (pages: PageInfo[]) => (pages.length <= 3 ? ` (${pages.map((p) => p.pageName).join(', ')})` : '');

/** The single most important Page problem, if any, as one sentence. */
function pageProblem(pages: PageInfo[]): { text: React.ReactNode; action: string } | null {
  const stale = staleAppPages(pages);
  if (stale.length) {
    return {
      text: <><strong>{stale.length} Page</strong> vẫn dùng token của Facebook App cũ nên đang bị chặn đăng{names(stale)}.</>,
      action: 'Đồng bộ ngay',
    };
  }
  const broken = pages.filter((p) => p.isActive && !p.postable);
  if (broken.length) {
    return {
      text: <><strong>{broken.length} Page</strong> không đăng được (token hết hạn, bị thu hồi hoặc thiếu quyền){names(broken)}. Bài hẹn giờ trên các Page này sẽ báo lỗi.</>,
      action: 'Đồng bộ lại',
    };
  }
  const soon = pages.filter(
    (p) => p.isActive && p.postable && p.tokenExpiresAt && new Date(p.tokenExpiresAt).getTime() - Date.now() < WARN_BEFORE_MS
  );
  if (soon.length) {
    const first = soon.map((p) => new Date(p.tokenExpiresAt!).getTime()).sort((a, b) => a - b)[0];
    return {
      text: <>Token của <strong>{soon.length} Page</strong> sẽ hết hạn từ {new Date(first).toLocaleDateString('vi-VN')}{names(soon)}. Đồng bộ lại để không gián đoạn.</>,
      action: 'Gia hạn',
    };
  }
  return null;
}

/**
 * Shown on every screen while connected Pages cannot publish (e.g. right after
 * the App ID changed) or their tokens are about to expire.
 */
export default function FacebookAppBanner() {
  const location = useLocation();
  const [pages, setPages] = useState<PageInfo[]>([]);

  useEffect(() => {
    const load = () =>
      pagesApi
        .list()
        .then((r) => setPages(r.data))
        .catch(() => setPages([]));
    load();
    window.addEventListener(PAGES_CHANGED, load);
    return () => window.removeEventListener(PAGES_CHANGED, load);
  }, [location.pathname]);

  const problem = pageProblem(pages);
  if (!problem || location.pathname === '/pages') return null;

  return (
    <div className="app-banner" role="status">
      <AlertTriangle size={16} aria-hidden="true" />
      <span>{problem.text}</span>
      <Link to="/pages?sync=1" className="btn btn-primary btn-sm">{problem.action}</Link>
    </div>
  );
}
