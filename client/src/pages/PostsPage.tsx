import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search, PenLine, Send, Trash2, ExternalLink, Check, X, Plus, RotateCcw } from 'lucide-react';
import { postsApi, assetUrl } from '../api';
import EditPostModal from '../components/EditPostModal';
import { useToast } from '../components/Toast';
import { StatusBadge, PostThumb, formatWhen, postTitle, wordCount, pageInitials } from '../components/PostBits';

interface PostData {
  id: string;
  caption: string | null;
  imageUrl: string | null;
  hashtags: string[] | null;
  status: string;
  fbPostId: string | null;
  fbPermalink: string | null;
  publishedAt: string | null;
  scheduledAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  page: { id: string; pageName: string; pageAvatar: string | null };
  targets?: Array<{ status: TargetStatus }>;
}

type TargetStatus = 'PENDING' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED';

interface TargetData {
  id: string;
  status: TargetStatus;
  scheduledAt: string | null;
  publishedAt: string | null;
  fbPermalink: string | null;
  errorMessage: string | null;
  page: { id: string; pageName: string };
}

const TARGET_META: Record<TargetStatus, { label: string; cls: string }> = {
  PENDING: { label: 'Chờ đăng', cls: 'badge-scheduled' },
  PUBLISHING: { label: 'Đang đăng…', cls: 'badge-publishing' },
  PUBLISHED: { label: 'Đã đăng', cls: 'badge-published' },
  FAILED: { label: 'Lỗi', cls: 'badge-failed' },
};

const RETRY_INTERVAL_MINUTES = 2;

function countTargets(targets: Array<{ status: TargetStatus }> = []) {
  return {
    total: targets.length,
    published: targets.filter((t) => t.status === 'PUBLISHED').length,
    failed: targets.filter((t) => t.status === 'FAILED').length,
  };
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

const TABS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Tất cả' },
  { value: 'READY', label: 'Chờ duyệt' },
  { value: 'DRAFT', label: 'Nháp' },
  { value: 'PUBLISHED', label: 'Đã đăng' },
  { value: 'FAILED', label: 'Lỗi' },
];

const EDITABLE = ['DRAFT', 'READY', 'FAILED', 'SCHEDULED'];
const PUBLISHABLE = ['DRAFT', 'READY', 'FAILED'];
const BUSY = ['GENERATING', 'PUBLISHING'];
const HOOK_LENGTH = 125;

/** PostLog action → human wording for the history timeline */
const LOG_LABEL: Record<string, string> = {
  created: 'Tạo bài',
  edited: 'Chỉnh sửa',
  pipeline_started: 'Bắt đầu đăng',
  ai_generation_started: 'AI bắt đầu viết',
  ai_generation_completed: 'AI viết xong',
  image_generation_started: 'Bắt đầu tạo ảnh',
  image_generation_completed: 'Tạo ảnh xong',
  facebook_publish_started: 'Gửi lên Facebook',
  published: 'Đã đăng lên Page',
  failed: 'Đăng thất bại',
  image_generated: 'Tạo ảnh bằng AI',
  image_uploaded: 'Tải ảnh lên',
  image_removed: 'Gỡ ảnh',
  image_reused: 'Dùng ảnh đã lưu',
};

export default function PostsPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const q = params.get('q') ?? '';
  const [posts, setPosts] = useState<PostData[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(params.get('selected'));
  const [detail, setDetail] = useState<any>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'publish' | 'delete' | null>(null);
  const [acting, setActing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    value ? next.set(key, value) : next.delete(key);
    next.delete('selected');
    setParams(next, { replace: true });
  };

  async function load() {
    try {
      const res = await postsApi.list({ limit: '50' });
      setPosts(res.data);
    } catch (e: any) {
      toast.error(`Không tải được bài đăng: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  // Poll while something is being generated/published
  useEffect(() => {
    if (!posts.some((p) => BUSY.includes(p.status))) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [posts]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { '': posts.length };
    for (const p of posts) c[p.status] = (c[p.status] ?? 0) + 1;
    return c;
  }, [posts]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return posts.filter((p) => (!status || p.status === status) && (!needle || (p.caption ?? '').toLowerCase().includes(needle)));
  }, [posts, status, q]);

  // Keep a valid selection
  useEffect(() => {
    if (loading) return;
    if (!selectedId || !visible.some((p) => p.id === selectedId)) setSelectedId(visible[0]?.id ?? null);
  }, [visible, loading]);

  // Selected post detail (preview + history)
  const selected = posts.find((p) => p.id === selectedId);
  useEffect(() => {
    setConfirming(null);
    setExpanded(false);
    if (!selectedId) return setDetail(null);
    postsApi.get(selectedId).then((r) => setDetail(r.data)).catch(() => setDetail(null));
  }, [selectedId, selected?.status, selected?.caption, selected?.imageUrl, selected?.targets?.map((t) => t.status).join()]);

  async function publish() {
    if (!selectedId) return;
    if (confirming !== 'publish') return setConfirming('publish');
    setActing(true);
    try {
      const res = await postsApi.publish(selectedId, { intervalMinutes: RETRY_INTERVAL_MINUTES });
      toast.success(res.data.pages > 1 ? `Đang đăng lên ${res.data.pages} Page.` : 'Đã đưa bài vào hàng đợi đăng.');
      await load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setActing(false);
      setConfirming(null);
    }
  }

  async function retryTarget(targetId: string) {
    if (!selectedId) return;
    setRetrying(targetId);
    try {
      await postsApi.retryTarget(selectedId, targetId);
      toast.success('Đang đăng lại lên Page này.');
      await load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setRetrying(null);
    }
  }

  async function remove() {
    if (!selectedId) return;
    if (confirming !== 'delete') return setConfirming('delete');
    setActing(true);
    try {
      await postsApi.delete(selectedId);
      toast.success('Đã xoá bài đăng.');
      setPosts((list) => list.filter((p) => p.id !== selectedId));
      setSelectedId(null);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setActing(false);
      setConfirming(null);
    }
  }

  function handleSaved(updated: PostData) {
    setPosts((list) => list.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)));
  }

  // Published: show exactly what went to Facebook. Posts published before `message`
  // existed had the full text written into `caption`, so fall back to it as-is.
  const targets: TargetData[] = detail?.targets ?? [];
  const tally = countTargets(targets);
  const liveSomewhere = tally.published > 0;
  const message = !detail
    ? ''
    : detail.status === 'PUBLISHED' || liveSomewhere
      ? (detail.message ?? detail.caption ?? '')
      : composeMessage(detail);

  return (
    <div className="split-view">
      <div className="split-main">
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="page-header" style={{ marginBottom: 0, flex: 1 }}>
            <h1>Bài đăng</h1>
            <p>Duyệt, chỉnh sửa và đăng bài lên Fanpage.</p>
          </div>
          <label className="topbar-search" style={{ width: 240, height: 38 }}>
            <Search size={15} aria-hidden="true" />
            <input type="search" placeholder="Tìm trong bài đăng" aria-label="Tìm trong bài đăng" value={q} onChange={(e) => setParam('q', e.target.value)} />
          </label>
        </div>

        <div className="row">
          <div className="filter-tabs" role="tablist" aria-label="Lọc theo trạng thái" style={{ flex: 1 }}>
            {TABS.map((t) => (
              <button key={t.value} type="button" role="tab" className="filter-tab" aria-selected={status === t.value} onClick={() => setParam('status', t.value)}>
                {t.label}<span className="count">· {counts[t.value] ?? 0}</span>
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="loading-page"><div className="spinner spinner-lg" /></div>
        ) : visible.length === 0 ? (
          <div className="card">
            <div className="empty-state">
              <h3>{posts.length === 0 ? 'Chưa có bài đăng' : 'Không có bài nào khớp bộ lọc'}</h3>
              <p>{posts.length === 0 ? 'Nhập một ý tưởng, AI sẽ viết bài và tạo ảnh cho bạn.' : 'Thử bỏ bộ lọc hoặc từ khoá tìm kiếm.'}</p>
              {posts.length === 0 && (
                <Link to="/posts/create" className="btn btn-primary"><Plus size={16} aria-hidden="true" /> Tạo bài đầu tiên</Link>
              )}
            </div>
          </div>
        ) : (
          <section className="card flush" aria-label="Danh sách bài đăng">
            {visible.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`post-row ${p.id === selectedId ? 'selected' : ''}`}
                aria-current={p.id === selectedId}
                onClick={() => setSelectedId(p.id)}
              >
                <PostThumb src={p.imageUrl} size={56} />
                <span className="post-main">
                  <span className={`post-title ${p.caption ? '' : 'empty'}`}>{postTitle(p.caption) || 'Chưa có nội dung'}</span>
                  {p.errorMessage && p.status === 'FAILED' ? (
                    <span className="post-meta error">{p.errorMessage}</span>
                  ) : (
                    <span className="post-meta">
                      {(p.targets?.length ?? 0) > 1 ? `${p.targets!.length} Page` : p.page?.pageName} · {wordCount(p.caption)} từ
                      {p.hashtags?.length ? ` · ${p.hashtags.map((h) => `#${h.replace(/^#+/, '')}`).join(' ')}` : ''}
                    </span>
                  )}
                </span>
                <span className="row" style={{ gap: 6, flexShrink: 0 }}>
                  {(p.targets?.length ?? 0) > 1 && ['PUBLISHED', 'FAILED', 'PUBLISHING'].includes(p.status) && (
                    <span className="badge badge-draft badge-pages" title="Số Page đã đăng thành công">
                      {countTargets(p.targets).published}/{p.targets!.length} Page
                    </span>
                  )}
                  <StatusBadge status={p.status} />
                </span>
                <span className="post-time">{formatWhen(p.publishedAt ?? p.createdAt)}</span>
              </button>
            ))}
          </section>
        )}
        {!loading && visible.length > 0 && (
          <span className="muted" style={{ fontSize: 12.5 }}>Hiển thị {visible.length} / {posts.length} bài{posts.length === 50 ? ' (50 bài mới nhất)' : ''}</span>
        )}
      </div>

      <aside className="inspector" aria-label="Chi tiết bài đang chọn">
        {!detail ? (
          <p className="inspector-empty">Chọn một bài trong danh sách để xem trước và thao tác.</p>
        ) : (
          <>
            <div className="row">
              <h2 className="card-title">Xem trước</h2>
              {EDITABLE.includes(detail.status) && !liveSomewhere && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditingId(detail.id)}>
                  <PenLine size={14} aria-hidden="true" /> Chỉnh sửa
                </button>
              )}
            </div>

            <article className="fb-card">
              <div className="fb-head">
                <span className="avatar">{pageInitials(detail.page?.pageName)}</span>
                <div>
                  <div className="fb-page">
                    {detail.page?.pageName}
                    {targets.length > 1 && <span className="muted" style={{ fontWeight: 400 }}> và {targets.length - 1} Page khác</span>}
                  </div>
                  <div className="fb-time">{detail.publishedAt ? formatWhen(detail.publishedAt) : 'Bản xem trước'} · Công khai</div>
                </div>
              </div>
              <div className="fb-body">
                {message ? (
                  expanded || message.length <= 260 ? (
                    <>
                      <mark className="fb-hook">{message.slice(0, HOOK_LENGTH)}</mark>
                      {message.slice(HOOK_LENGTH)}
                    </>
                  ) : (
                    <>
                      <mark className="fb-hook">{message.slice(0, HOOK_LENGTH)}</mark>
                      {message.slice(HOOK_LENGTH, 220)}…{' '}
                      <button type="button" className="fb-more" style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} onClick={() => setExpanded(true)}>
                        Xem thêm
                      </button>
                    </>
                  )
                ) : (
                  <span className="muted">Chưa có nội dung.</span>
                )}
              </div>
              {detail.imageUrl ? (
                <img className="fb-image" src={assetUrl(detail.imageUrl)!} alt="Ảnh đăng kèm bài" />
              ) : (
                <div className="fb-image placeholder">
                  {detail.status === 'PUBLISHED'
                    ? 'Ảnh đã đăng cùng bài — xem trên Facebook'
                    : detail.imagePrompt
                      ? 'Ảnh sẽ được AI tạo từ image prompt khi đăng'
                      : 'Bài không có ảnh'}
                </div>
              )}
            </article>
            <span className="field-hint" style={{ marginTop: -8 }}>Phần tô vàng là hook — người xem thấy trước khi bấm "Xem thêm".</span>

            {targets.length > 0 && (targets.length > 1 || targets[0].status !== 'PENDING') && (
              <div className="stack" style={{ gap: 10 }}>
                <div className="target-summary">
                  <span className="form-label" style={{ margin: 0 }}>
                    Trạng thái trên từng Page · {tally.published}/{tally.total} đã đăng{tally.failed ? ` · ${tally.failed} lỗi` : ''}
                  </span>
                  <span className="target-progress" aria-hidden="true">
                    <i className="ok" style={{ width: `${(tally.published / tally.total) * 100}%` }} />
                    <i className="bad" style={{ width: `${(tally.failed / tally.total) * 100}%` }} />
                  </span>
                </div>
                <ul className="target-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {targets.map((t) => (
                    <li key={t.id} className="target-row">
                      <span className="avatar" aria-hidden="true">{pageInitials(t.page.pageName)}</span>
                      <span className="name" title={t.page.pageName}>{t.page.pageName}</span>
                      <span className="actions">
                        {t.status === 'PUBLISHED' && t.fbPermalink && (
                          <a className="target-link" href={t.fbPermalink} target="_blank" rel="noreferrer">
                            Xem bài <ExternalLink size={12} aria-hidden="true" />
                          </a>
                        )}
                        {t.status === 'FAILED' && (
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => retryTarget(t.id)} disabled={!!retrying || detail.status === 'PUBLISHING' || detail.status === 'GENERATING'}>
                            {retrying === t.id ? <div className="spinner" /> : <RotateCcw size={13} aria-hidden="true" />} Đăng lại
                          </button>
                        )}
                        <span className={`badge ${TARGET_META[t.status].cls}`}>{TARGET_META[t.status].label}</span>
                      </span>
                      <span className={`detail ${t.status === 'FAILED' ? 'error' : ''}`}>
                        {t.status === 'PUBLISHED'
                          ? t.publishedAt ? `Đăng lúc ${timeOf(t.publishedAt)}${t.fbPermalink ? '' : ' · chưa lấy được link'}` : 'Đã đăng'
                          : t.status === 'FAILED'
                            ? t.errorMessage ?? 'Đăng thất bại'
                            : t.status === 'PUBLISHING'
                              ? 'Đang gửi lên Facebook…'
                              : t.errorMessage?.startsWith('Đang thử lại')
                                ? t.errorMessage
                                : t.scheduledAt && ['GENERATING', 'PUBLISHING'].includes(detail.status)
                                  ? `Dự kiến lúc ${timeOf(t.scheduledAt)}`
                                  : 'Chưa đăng'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {detail.status === 'FAILED' && detail.errorMessage && targets.length <= 1 && (
              <div className="test-result fail" style={{ margin: 0 }}>
                <div className="test-result-head"><X size={16} aria-hidden="true" /><span>{detail.errorMessage}</span></div>
              </div>
            )}

            {detail.logs?.length > 0 && (
              <div className="stack" style={{ gap: 10 }}>
                <span className="form-label" style={{ margin: 0 }}>Lịch sử</span>
                <ol className="timeline">
                  {detail.logs.slice(-6).map((log: any) => (
                    <li key={log.id}>
                      <span className={`tl-mark ${log.action === 'failed' ? 'fail' : 'done'}`}>
                        {log.action === 'failed' ? <X size={12} strokeWidth={3} aria-hidden="true" /> : <Check size={12} strokeWidth={3} aria-hidden="true" />}
                      </span>
                      <span className="tl-body"><strong>{LOG_LABEL[log.action] ?? log.action}</strong></span>
                      <span className="tl-time">{formatWhen(log.createdAt)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            <div className="spacer" />

            <div className="stack" style={{ gap: 8 }}>
              {detail.fbPermalink && targets.length <= 1 && (
                <a className="btn btn-secondary btn-block" href={detail.fbPermalink} target="_blank" rel="noreferrer">
                  <ExternalLink size={15} aria-hidden="true" /> Xem trên Facebook
                </a>
              )}
              {PUBLISHABLE.includes(detail.status) && (
                <button type="button" className="btn btn-primary btn-lg btn-block" onClick={publish} disabled={acting || !detail.caption}>
                  {acting && confirming === 'publish' ? <div className="spinner" /> : <Send size={16} aria-hidden="true" />}
                  {confirming === 'publish'
                    ? 'Bấm lần nữa để đăng công khai'
                    : detail.status === 'FAILED'
                      ? tally.total > 1 ? `Đăng lại ${tally.total - tally.published} Page chưa lên` : 'Đăng lại'
                      : tally.total > 1 ? `Duyệt & đăng lên ${tally.total} Page` : 'Duyệt & đăng ngay'}
                </button>
              )}
              {detail.status !== 'PUBLISHING' && (
                <button type="button" className="btn btn-danger btn-block" onClick={remove} disabled={acting}>
                  <Trash2 size={15} aria-hidden="true" />
                  {confirming === 'delete' ? 'Bấm lần nữa để xoá vĩnh viễn' : 'Xoá bài'}
                </button>
              )}
            </div>
          </>
        )}
      </aside>

      {editingId && <EditPostModal postId={editingId} onClose={() => setEditingId(null)} onSaved={handleSaved} />}
    </div>
  );
}

/** Same composition the publish worker uses (caption + hashtags + CTA). */
function composeMessage(post: any): string {
  let msg = (post.caption ?? '').trim();
  const tags: string[] = Array.isArray(post.hashtags) ? post.hashtags : [];
  if (tags.length) msg += `\n\n${tags.map((h) => `#${h.replace(/^#+/, '')}`).join(' ')}`;
  if (post.callToAction) msg += `\n\n👉 ${post.callToAction}`;
  return msg;
}
