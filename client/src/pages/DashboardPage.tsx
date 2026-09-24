import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, FileText, KeyRound, CheckCircle2, XCircle } from 'lucide-react';
import { analyticsApi, settingsApi, type PublicSettings } from '../api';
import { StatusBadge, PostThumb, formatWhen, postTitle } from '../components/PostBits';
import { useToast } from '../components/Toast';

interface OverviewStats {
  totalPosts: number;
  publishedPosts: number;
  failedPosts: number;
  scheduledPosts: number;
  readyPosts: number;
  thisMonthPosts: number;
  growth: number;
  totalPages: number;
  successRate: number;
}

interface RecentPost {
  id: string;
  caption: string | null;
  imageUrl: string | null;
  inputData: Record<string, string> | null;
  status: string;
  publishedAt: string | null;
  createdAt: string;
  page: { pageName: string; pageAvatar: string | null };
}

interface Todo {
  tone: 'warn' | 'info' | 'bad' | 'ok';
  title: string;
  detail: string;
  to?: string;
  action?: string;
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 11 ? 'Chào buổi sáng' : h < 14 ? 'Chào buổi trưa' : h < 18 ? 'Chào buổi chiều' : 'Chào buổi tối';
}

function buildTodos(stats: OverviewStats, settings: PublicSettings | null): Todo[] {
  const todos: Todo[] = [];
  if (stats.readyPosts > 0) {
    todos.push({ tone: 'info', title: `${stats.readyPosts} bài đang chờ bạn duyệt`, detail: 'Xem lại nội dung rồi đăng lên Page.', to: '/posts?status=READY', action: 'Duyệt' });
  }
  if (stats.failedPosts > 0) {
    todos.push({ tone: 'bad', title: `${stats.failedPosts} bài đăng bị lỗi`, detail: 'Sửa nội dung hoặc cấu hình rồi đăng lại.', to: '/posts?status=FAILED', action: 'Xem lỗi' });
  }
  if (stats.totalPages === 0) {
    todos.push({ tone: 'bad', title: 'Chưa kết nối Fanpage', detail: 'Cần Page ID + Page Access Token để đăng bài.', to: '/settings', action: 'Kết nối' });
  }
  if (settings) {
    const envKeys = [
      settings.geminiApiKey.source === 'env' && 'Gemini',
      settings.cfApiToken.source === 'env' && 'Cloudflare',
    ].filter(Boolean);
    const missing = [
      settings.geminiApiKey.source === 'none' && 'Gemini',
      settings.cfApiToken.source === 'none' && 'Cloudflare',
    ].filter(Boolean);
    if (missing.length) {
      todos.push({ tone: 'bad', title: `Thiếu khoá ${missing.join(', ')}`, detail: 'AI chưa viết bài / tạo ảnh được.', to: '/settings', action: 'Cài đặt' });
    }
    if (envKeys.length) {
      todos.push({ tone: 'warn', title: `${envKeys.join(', ')} đang dùng khoá tạm từ .env`, detail: 'Nên lưu khoá vào Cài đặt để được mã hoá.', to: '/settings', action: 'Cập nhật' });
    }
  }
  if (todos.length === 0) todos.push({ tone: 'ok', title: 'Mọi thứ đã sẵn sàng', detail: 'Không có việc gì cần xử lý.' });
  return todos;
}

const TODO_ICON = { warn: AlertTriangle, info: FileText, bad: XCircle, ok: CheckCircle2 };

export default function DashboardPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [recent, setRecent] = useState<RecentPost[]>([]);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [idea, setIdea] = useState('');

  useEffect(() => {
    Promise.all([
      analyticsApi.overview().then((r) => {
        setStats(r.data.stats);
        setRecent(r.data.recentPosts);
      }),
      settingsApi.get().then((r) => setSettings(r.data)).catch(() => {}),
    ])
      .catch((e) => toast.error(`Không tải được số liệu: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading-page"><div className="spinner spinner-lg" /></div>;

  const today = new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
  const pageName = recent[0]?.page?.pageName;

  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="page-header" style={{ marginBottom: 0 }}>
        <div>
          <h1>{greeting()}, Admin</h1>
          <p style={{ textTransform: 'none' }}>
            {today.charAt(0).toUpperCase() + today.slice(1)}
            {pageName ? ` · Fanpage ${pageName}` : ''}
          </p>
        </div>
      </div>

      {stats && (
        <div className="stats-grid" style={{ marginBottom: 0 }}>
          <div className="stat-card">
            <span className="stat-label">Chờ bạn duyệt</span>
            <span className="stat-value">{stats.readyPosts}</span>
            <Link to="/posts?status=READY" className="stat-change" style={{ color: 'var(--primary-500)', fontWeight: 500 }}>Xem và duyệt →</Link>
          </div>
          <div className="stat-card">
            <span className="stat-label">Bài tạo tháng này</span>
            <span className="stat-value">{stats.thisMonthPosts}</span>
            <span className={`stat-change ${stats.growth > 0 ? 'positive' : stats.growth < 0 ? 'negative' : ''}`}>
              {stats.growth === 0 ? 'Bằng tháng trước' : `${stats.growth > 0 ? '+' : ''}${stats.growth}% so với tháng trước`}
            </span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Đã đăng</span>
            <span className="stat-value">{stats.publishedPosts}</span>
            <span className="stat-change">Tỷ lệ thành công {stats.successRate}%</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Đăng lỗi</span>
            <span className="stat-value">{stats.failedPosts}</span>
            <span className={`stat-change ${stats.failedPosts === 0 ? 'positive' : 'negative'}`}>
              {stats.failedPosts === 0 ? 'Không có lỗi' : 'Cần xử lý'}
            </span>
          </div>
        </div>
      )}

      <div className="dashboard-grid">
        <section className="card flush" aria-labelledby="recent-title">
          <div className="card-header">
            <h2 id="recent-title" className="card-title">Bài đăng gần đây</h2>
            <Link to="/posts" style={{ fontSize: 13, fontWeight: 500 }}>Xem tất cả</Link>
          </div>
          {recent.length === 0 ? (
            <div className="empty-state">
              <h3>Chưa có bài đăng</h3>
              <p>Nhập một ý tưởng, AI sẽ viết bài và tạo ảnh cho bạn.</p>
              <Link to="/posts/create" className="btn btn-primary">Tạo bài đầu tiên</Link>
            </div>
          ) : (
            recent.slice(0, 6).map((p) => (
              <button key={p.id} type="button" className="post-row" onClick={() => navigate(`/posts?selected=${p.id}`)}>
                <PostThumb src={p.imageUrl} />
                <span className="post-main">
                  <span className={`post-title ${p.caption ? '' : 'empty'}`}>{postTitle(p.caption) || 'Chưa có nội dung'}</span>
                  <span className="post-meta">
                    {p.inputData?.basicInfo ? `Ý tưởng: ${p.inputData.basicInfo}` : p.page?.pageName}
                  </span>
                </span>
                <StatusBadge status={p.status} />
                <span className="post-time">{formatWhen(p.publishedAt ?? p.createdAt)}</span>
              </button>
            ))
          )}
        </section>

        <div className="stack">
          {stats && (
            <section className="card stack" style={{ gap: 14 }} aria-labelledby="todo-title">
              <h2 id="todo-title" className="card-title">Cần xử lý</h2>
              {buildTodos(stats, settings).map((t) => {
                const Icon = TODO_ICON[t.tone];
                return (
                  <div key={t.title} className="todo-item">
                    <span className={`todo-icon ${t.tone}`}><Icon size={16} strokeWidth={2} aria-hidden="true" /></span>
                    <span className="todo-body">
                      <strong>{t.title}</strong>
                      <span>{t.detail}</span>
                    </span>
                    {t.to && <Link to={t.to} className="todo-action">{t.action}</Link>}
                  </div>
                );
              })}
            </section>
          )}

          <section className="card stack" style={{ gap: 12 }} aria-labelledby="quick-title">
            <h2 id="quick-title" className="card-title">Viết nhanh với AI</h2>
            <div>
              <label htmlFor="quick-idea" className="form-label">Ý tưởng bài viết</label>
              <textarea
                id="quick-idea"
                className="form-textarea"
                rows={4}
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                placeholder="VD: Dùng AI viết email từ chối lời mời họp một cách lịch sự"
              />
            </div>
            <div className="row">
              <span className="field-hint" style={{ margin: 0, flex: 1 }}>
                <KeyRound size={12} style={{ verticalAlign: -1 }} aria-hidden="true" /> Viết theo System prompt trong Cài đặt
              </span>
              <button
                type="button"
                className="btn btn-dark btn-sm"
                disabled={!idea.trim()}
                onClick={() => navigate('/posts/create', { state: { idea: idea.trim(), autoGenerate: true } })}
              >
                Viết bài
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
