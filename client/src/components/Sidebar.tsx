import { useEffect, useState } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, PenLine, FileText, CalendarDays, Layers, SlidersHorizontal, ChevronsUpDown } from 'lucide-react';
import { pagesApi, postsApi, settingsApi, getStoredUser, type PublicSettings } from '../api';

type Health = 'ok' | 'warn' | 'bad';

interface HealthRow {
  name: string;
  state: Health;
  label: string;
}

/** Configuration status only — no live API calls (they cost quota on every page load). */
function healthFrom(settings: PublicSettings | null, pageCount: number, postableCount: number): HealthRow[] {
  if (!settings) return [];
  const secret = (source: string): [Health, string] =>
    source === 'db' ? ['ok', 'Đã cấu hình'] : source === 'env' ? ['warn', 'Tạm từ .env'] : ['bad', 'Chưa có'];

  const [gState, gLabel] = secret(settings.geminiApiKey.source);
  const [cState, cLabel] = secret(settings.cfApiToken.source);
  return [
    { name: 'Gemini', state: gState, label: gLabel },
    { name: 'Cloudflare', state: cState, label: cLabel },
    {
      name: 'Facebook',
      state: pageCount === 0 || postableCount === 0 ? 'bad' : postableCount < pageCount ? 'warn' : 'ok',
      label: pageCount === 0 ? 'Chưa kết nối' : postableCount < pageCount ? `${postableCount}/${pageCount} Page đăng được` : `${pageCount} Page`,
    },
  ];
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(-2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

export default function Sidebar() {
  const location = useLocation();
  const user = getStoredUser();
  const [pages, setPages] = useState<any[]>([]);
  const [pending, setPending] = useState(0);
  const [settings, setSettings] = useState<PublicSettings | null>(null);

  // Refresh counts when navigating, so the badge follows edits/publishes
  useEffect(() => {
    pagesApi.list().then((r) => setPages(r.data.filter((p: any) => p.isActive))).catch(() => {});
    postsApi
      .list({ status: 'READY', limit: '1' })
      .then((r) => setPending(r.pagination?.total ?? 0))
      .catch(() => {});
    settingsApi.get().then((r) => setSettings(r.data)).catch(() => {});
  }, [location.pathname]);

  const page = pages[0];
  const health = healthFrom(settings, pages.length, pages.filter((p) => p.postable).length);
  const navClass = ({ isActive }: { isActive: boolean }) => `nav-item ${isActive ? 'active' : ''}`;

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <div className="logo-mark" aria-hidden="true" />
        <div className="logo-text">
          <strong>Auto Post</strong>
          <span>Nội dung Fanpage bằng AI</span>
        </div>
      </div>

      <Link to="/pages" className="page-switcher" aria-label="Quản lý Fanpage đang kết nối">
        {page?.pageAvatar ? (
          <img className="avatar" src={page.pageAvatar} alt="" />
        ) : (
          <span className="avatar">{page ? initials(page.pageName) : '?'}</span>
        )}
        <span className="ps-body">
          <span className="ps-name">{page?.pageName ?? 'Chưa có Fanpage'}</span>
          <span className="ps-meta">
            {page ? (pages.length > 1 ? `Fanpage · +${pages.length - 1} Page khác` : 'Fanpage · Đã kết nối') : 'Bấm để kết nối'}
          </span>
        </span>
        <ChevronsUpDown size={16} color="#62666F" aria-hidden="true" />
      </Link>

      <nav className="sidebar-nav" aria-label="Điều hướng chính">
        <div className="nav-group">
          <span className="nav-section-label">Tổng quan</span>
          <NavLink to="/" end className={navClass}>
            <LayoutDashboard className="nav-icon" strokeWidth={1.8} />
            <span className="nav-label">Bảng điều khiển</span>
          </NavLink>
        </div>

        <div className="nav-group">
          <span className="nav-section-label">Nội dung</span>
          <NavLink to="/posts/create" className={navClass}>
            <PenLine className="nav-icon" strokeWidth={1.8} />
            <span className="nav-label">Tạo bài</span>
          </NavLink>
          <NavLink to="/posts" end className={navClass}>
            <FileText className="nav-icon" strokeWidth={1.8} />
            <span className="nav-label">Bài đăng</span>
            {pending > 0 && (
              <span className="nav-count" aria-label={`${pending} bài chờ duyệt`}>
                {pending}
              </span>
            )}
          </NavLink>
          <NavLink to="/schedules" className={navClass}>
            <CalendarDays className="nav-icon" strokeWidth={1.8} />
            <span className="nav-label">Lịch đăng</span>
            <span className="nav-tag">Beta</span>
          </NavLink>
        </div>

        <div className="nav-group">
          <span className="nav-section-label">Hệ thống</span>
          <NavLink to="/pages" className={navClass}>
            <Layers className="nav-icon" strokeWidth={1.8} />
            <span className="nav-label">Kênh Facebook</span>
          </NavLink>
          <NavLink to="/settings" className={navClass}>
            <SlidersHorizontal className="nav-icon" strokeWidth={1.8} />
            <span className="nav-label">Cài đặt</span>
          </NavLink>
        </div>
      </nav>

      <div className="sidebar-footer">
        {health.length > 0 && (
          <Link to="/settings" className="health-card" style={{ color: 'inherit' }} aria-label="Tình trạng cấu hình, mở Cài đặt">
            <h2>Tình trạng cấu hình</h2>
            {health.map((h) => (
              <div key={h.name} className="health-row">
                <span className={`dot ${h.state}`} aria-hidden="true" />
                <span className="hr-name">{h.name}</span>
                <span className={`hr-state state-${h.state}`}>{h.label}</span>
              </div>
            ))}
          </Link>
        )}

        <div className="user-profile">
          <span className="avatar ink">{user?.name?.charAt(0)?.toUpperCase() || 'A'}</span>
          <div className="user-info">
            <span className="user-name">{user?.name || 'Admin'}</span>
            <span className="user-plan">Quản trị viên</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
