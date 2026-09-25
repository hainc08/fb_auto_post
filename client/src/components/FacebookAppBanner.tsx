import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { pagesApi, type PageInfo } from '../api';
import { PAGES_CHANGED, staleAppPages } from './PageStatus';

/**
 * Shown on every screen while some connected Pages still hold tokens from
 * another Facebook App (typically right after the App ID was changed).
 */
export default function FacebookAppBanner() {
  const location = useLocation();
  const [stale, setStale] = useState<PageInfo[]>([]);

  useEffect(() => {
    const load = () =>
      pagesApi
        .list()
        .then((r) => setStale(staleAppPages(r.data)))
        .catch(() => setStale([]));
    load();
    window.addEventListener(PAGES_CHANGED, load);
    return () => window.removeEventListener(PAGES_CHANGED, load);
  }, [location.pathname]);

  if (stale.length === 0 || location.pathname === '/pages') return null;

  return (
    <div className="app-banner" role="status">
      <AlertTriangle size={16} aria-hidden="true" />
      <span>
        <strong>{stale.length} Page</strong> vẫn dùng token của Facebook App cũ nên đang bị chặn đăng
        {stale.length <= 3 ? ` (${stale.map((p) => p.pageName).join(', ')})` : ''}.
      </span>
      <Link to="/pages?sync=1" className="btn btn-primary btn-sm">Đồng bộ ngay</Link>
    </div>
  );
}
