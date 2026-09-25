import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ChevronRight, Plus, Search } from 'lucide-react';

/** Breadcrumb trail per route: [section, page?, subpage?] */
const CRUMBS: Array<[RegExp, string[]]> = [
  [/^\/$/, ['Tổng quan', 'Bảng điều khiển']],
  [/^\/posts\/create/, ['Nội dung', 'Bài đăng', 'Tạo bài mới']],
  [/^\/posts/, ['Nội dung', 'Bài đăng']],
  [/^\/schedules/, ['Nội dung', 'Lịch đăng']],
  [/^\/pages/, ['Hệ thống', 'Kênh Facebook']],
  [/^\/settings/, ['Hệ thống', 'Cài đặt']],
];

export default function Topbar() {
  const location = useLocation();
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');

  const crumbs = CRUMBS.find(([re]) => re.test(location.pathname))?.[1] ?? [];
  const onCompose = location.pathname.startsWith('/posts/create');

  // Ctrl/Cmd + K focuses search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    navigate(q ? `/posts?q=${encodeURIComponent(q)}` : '/posts');
  }

  return (
    <header className="topbar">
      <nav className="topbar-crumbs" aria-label="Vị trí hiện tại">
        {crumbs.map((c, i) => (
          <span key={c} className="row" style={{ gap: 8 }}>
            {i > 0 && <ChevronRight size={14} color="#8A8E98" aria-hidden="true" />}
            {i === crumbs.length - 1 ? (
              <strong aria-current="page">{c}</strong>
            ) : c === 'Bài đăng' ? (
              <Link to="/posts" style={{ color: 'inherit' }}>{c}</Link>
            ) : (
              <span>{c}</span>
            )}
          </span>
        ))}
      </nav>

      <div className="topbar-spacer" />

      <form className="topbar-search" role="search" onSubmit={submit}>
        <Search size={16} aria-hidden="true" />
        <input
          ref={searchRef}
          type="search"
          placeholder="Tìm bài đăng…"
          aria-label="Tìm bài đăng"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <kbd>Ctrl K</kbd>
      </form>

      {!onCompose && (
        <Link to="/posts/create" className="btn btn-primary">
          <Plus size={16} strokeWidth={2.4} aria-hidden="true" /> Tạo bài mới
        </Link>
      )}
    </header>
  );
}
