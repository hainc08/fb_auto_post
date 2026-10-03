import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PenLine, Send, Trash2, ExternalLink, Check, X, Plus, RotateCcw, CalendarClock, Eye, MessageCircle, ArrowLeft, Clapperboard } from 'lucide-react';
import { postsApi, domainsApi, assetUrl, type ContentDomain } from '../api';
import EditPostModal from '../components/EditPostModal';
import { useToast } from '../components/Toast';
import { formatWhen, pageInitials } from '../components/PostBits';
import PostListItem from '../components/PostListItem';
import PostFilters from '../components/PostFilters';
import CommentsPanel from '../components/CommentsPanel';
import SchedulePicker from '../components/SchedulePicker';
import ReelMaker from '../components/ReelMaker';
import type { MenuAction } from '../components/PostActionsMenu';
import { matchesFilters, statusCounts, engagementTotals, type TimeRange, type TargetSummary } from '../lib/post-display';
import { slotLabel } from '../components/ScheduleBits';

interface PostData {
  id: string;
  caption: string | null;
  imageUrl: string | null;
  videoUrl?: string | null;
  videoKind?: 'FEED' | 'REEL' | null;
  scheduleQueued?: boolean;
  approvedAt?: string | null;
  schedule?: { id: string; name: string } | null;
  hashtags: string[] | null;
  status: string;
  fbPostId: string | null;
  fbPermalink: string | null;
  publishedAt: string | null;
  scheduledAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  page: { id: string; pageName: string; pageAvatar: string | null };
  targets?: TargetSummary[];
  domain?: { id: string; name: string } | null;
  format?: { id: string; name: string } | null;
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
  { value: 'DRAFT', label: 'Nháp' },
  { value: 'READY', label: 'Chờ duyệt' },
  { value: 'SCHEDULED', label: 'Đã lên lịch' },
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
  scheduled: 'Hẹn giờ đăng',
  schedule_cancelled: 'Huỷ hẹn giờ',
  reel_rendered: 'Dựng Reel',
};

export default function PostsPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const q = params.get('q') ?? '';
  const domainFilter = params.get('domain') ?? '';
  const pageFilter = params.get('page') ?? '';
  const time = (params.get('time') ?? '') as TimeRange;
  const [domains, setDomains] = useState<ContentDomain[]>([]);
  const [posts, setPosts] = useState<PostData[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(params.get('selected'));
  const [detail, setDetail] = useState<any>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'publish' | 'delete' | null>(null);
  const [acting, setActing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  /** Inline "Duyệt & đăng" waiting for its second click */
  const [armed, setArmed] = useState<string | null>(null);
  const [commentsFor, setCommentsFor] = useState<string | null>(null);
  /** The "Hẹn giờ đăng" picker is open in the inspector */
  const [timing, setTiming] = useState(false);
  /** The "Tạo Reel từ bài" dialog is open for the selected post */
  const [reelOpen, setReelOpen] = useState(false);
  /** Reels need FFmpeg on the server; the button is hidden where there is none */
  const [reelAvailable, setReelAvailable] = useState(false);
  /** Post whose Reel is being made: followed here, so the result is reported even after the dialog is closed */
  const [reelWatch, setReelWatch] = useState<string | null>(null);

  useEffect(() => {
    if (!reelWatch) return;
    let stopped = false;
    const timer = setInterval(() => {
      postsApi
        .reelProgress(reelWatch)
        .then(({ data }) => {
          if (stopped || data.state === 'queued' || data.state === 'running') return;
          stopped = true;
          setReelWatch(null);
          if (data.state === 'done') {
            toast.success('Đã dựng xong Reel — xem thử rồi duyệt đăng như bài thường.');
            void load();
          } else if (data.state === 'failed') {
            toast.error(`Chưa dựng được Reel: ${data.error}`);
          }
        })
        .catch(() => {}); // a missed poll: the next one answers
    }, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [reelWatch]);
  /** Phones: the inspector is a full-screen sheet, opened by choosing a post */
  const [sheetOpen, setSheetOpen] = useState(!!params.get('selected'));
  const openPost = (id: string) => {
    setSelectedId(id);
    setSheetOpen(true);
  };

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    value ? next.set(key, value) : next.delete(key);
    next.delete('selected');
    setParams(next, { replace: true });
  };

  async function load() {
    try {
      const res = await postsApi.list({ limit: '50', ...(domainFilter && { domainId: domainFilter }) });
      setPosts(res.data);
    } catch (e: any) {
      toast.error(`Không tải được bài đăng: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    domainsApi.list(true).then((r) => setDomains(r.data)).catch(() => {});
    postsApi.reelStatus().then((r) => setReelAvailable(r.data.available)).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [domainFilter]);

  // Poll while something is being generated/published
  useEffect(() => {
    if (!posts.some((p) => BUSY.includes(p.status))) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [posts]);

  // Every filter but the status tab (tab counts and the overview follow search/Page/time)
  const filtered = useMemo(() => posts.filter((p) => matchesFilters(p, { q, pageId: pageFilter, time })), [posts, q, pageFilter, time]);
  const counts = useMemo(() => statusCounts(filtered), [filtered]);
  const pendingComments = useMemo(() => filtered.reduce((s, p) => s + engagementTotals(p.targets).unanswered, 0), [filtered]);
  const visible = useMemo(() => filtered.filter((p) => !status || p.status === status), [filtered, status]);
  const pageOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of posts) {
      for (const t of p.targets ?? []) if (t.page) seen.set(t.page.id, t.page.pageName);
      if (!p.targets?.length && p.page) seen.set(p.page.id, p.page.pageName);
    }
    return [...seen].map(([id, pageName]) => ({ id, pageName })).sort((a, b) => a.pageName.localeCompare(b.pageName, 'vi'));
  }, [posts]);

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
    setTiming(false);
    if (!selectedId) return setDetail(null);
    postsApi.get(selectedId).then((r) => setDetail(r.data)).catch(() => setDetail(null));
  }, [selectedId, selected?.status, selected?.scheduledAt, selected?.caption, selected?.imageUrl, selected?.videoUrl, selected?.videoKind, selected?.targets?.map((t) => t.status).join()]);

  async function publish(id: string) {
    setActing(true);
    try {
      const res = await postsApi.publish(id, { intervalMinutes: RETRY_INTERVAL_MINUTES });
      toast.success(res.data.pages > 1 ? `Đang đăng lên ${res.data.pages} Page.` : 'Đã đưa bài vào hàng đợi đăng.');
      await load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setActing(false);
    }
  }

  async function approve(id: string) {
    setActing(true);
    try {
      const res = await postsApi.approve(id);
      toast.success(`Đã duyệt — bài sẽ đăng lúc ${slotLabel(res.data.scheduledAt)}.`);
      await load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setActing(false);
    }
  }

  async function scheduleAt(id: string, iso: string) {
    setActing(true);
    try {
      const res = await postsApi.schedule(id, { scheduledAt: iso });
      toast.success(`Đã hẹn giờ — bài sẽ đăng lúc ${slotLabel(res.data.scheduledAt)}.`);
      setTiming(false);
      await load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setActing(false);
    }
  }

  async function cancelTimed(id: string) {
    setActing(true);
    try {
      await postsApi.cancelSchedule(id);
      toast.success('Đã huỷ hẹn giờ — bài quay lại "Chờ duyệt".');
      await load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setActing(false);
    }
  }

  /** Inspector buttons: first click asks, second click acts */
  function confirmPublish() {
    if (confirming !== 'publish') return setConfirming('publish');
    void publish(selectedId!).finally(() => setConfirming(null));
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

  async function remove(id: string) {
    setActing(true);
    try {
      await postsApi.delete(id);
      toast.success('Đã xoá bài đăng.');
      setPosts((list) => list.filter((p) => p.id !== id));
      if (selectedId === id) {
        setSelectedId(null);
        setSheetOpen(false);
      }
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setActing(false);
    }
  }

  function confirmRemove() {
    if (confirming !== 'delete') return setConfirming('delete');
    void remove(selectedId!).finally(() => setConfirming(null));
  }

  /** ⋯ menu: only actions the app supports today (plan Decision 4) */
  function rowActions(p: PostData): MenuAction[] {
    const live = (p.targets ?? []).some((t) => t.status === 'PUBLISHED');
    const a: MenuAction[] = [{ key: 'open', label: 'Xem chi tiết', icon: <Eye size={15} aria-hidden="true" />, onSelect: () => openPost(p.id) }];
    if (EDITABLE.includes(p.status) && !live) a.push({ key: 'edit', label: 'Sửa bài', icon: <PenLine size={15} aria-hidden="true" />, onSelect: () => setEditingId(p.id) });
    if (p.fbPermalink) a.push({ key: 'fb', label: 'Xem trên Facebook', icon: <ExternalLink size={15} aria-hidden="true" />, href: p.fbPermalink });
    if (live) a.push({ key: 'comments', label: 'Xem bình luận', icon: <MessageCircle size={15} aria-hidden="true" />, onSelect: () => setCommentsFor(p.id) });
    if (p.status === 'READY' && p.scheduleQueued) {
      a.push({ key: 'approve', label: 'Duyệt (đăng theo lịch)', icon: <CalendarClock size={15} aria-hidden="true" />, onSelect: () => void approve(p.id) });
    }
    if (p.status === 'READY' && !p.scheduleQueued && p.caption) {
      a.push({ key: 'publish', label: 'Duyệt & đăng', icon: <Send size={15} aria-hidden="true" />, confirmLabel: 'Bấm lần nữa để đăng công khai', onSelect: () => void publish(p.id) });
    }
    if (p.status === 'FAILED' && p.caption) {
      a.push({ key: 'retry', label: 'Đăng lại', icon: <RotateCcw size={15} aria-hidden="true" />, confirmLabel: 'Bấm lần nữa để đăng lại', onSelect: () => void publish(p.id) });
    }
    if (p.status !== 'PUBLISHING') {
      a.push({ key: 'delete', label: 'Xoá', icon: <Trash2 size={15} aria-hidden="true" />, danger: true, confirmLabel: 'Bấm lần nữa để xoá vĩnh viễn', onSelect: () => void remove(p.id) });
    }
    return a;
  }

  /** Posts waiting for approval: [Sửa] [Duyệt & đăng] right on the row */
  function rowInline(p: PostData) {
    if (p.status !== 'READY') return null;
    const stop = (fn: () => void) => (e: MouseEvent) => {
      e.stopPropagation();
      fn();
    };
    return (
      <>
        <button type="button" className="btn btn-secondary btn-sm" onClick={stop(() => setEditingId(p.id))}>Sửa</button>
        {p.scheduleQueued ? (
          <button type="button" className="btn btn-primary btn-sm" disabled={acting} onClick={stop(() => void approve(p.id))}>Duyệt</button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={acting || !p.caption}
            onClick={stop(() => {
              if (armed !== p.id) return setArmed(p.id);
              setArmed(null);
              void publish(p.id);
            })}
            onBlur={() => setArmed((a) => (a === p.id ? null : a))}
          >
            {armed === p.id ? 'Bấm lần nữa để đăng' : 'Duyệt & đăng'}
          </button>
        )}
      </>
    );
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
  /** A post waiting for a time the user picked (not a slot of a schedule) */
  const timed = !!detail && detail.status === 'SCHEDULED' && !detail.scheduleQueued;
  const canTime = !!detail && PUBLISHABLE.includes(detail.status) && !detail.scheduleQueued && !!detail.caption;

  return (
    <div className="split-view">
      <div className="split-main">
        <div className="posts-header">
          <div className="page-header" style={{ marginBottom: 0 }}>
            <h1>Bài đăng</h1>
            <p>Quản lý, duyệt và theo dõi nội dung Fanpage.</p>
          </div>
          <Link to="/posts/create" className="btn btn-primary"><Plus size={16} aria-hidden="true" /> Tạo bài mới</Link>
        </div>

        {!loading && posts.length > 0 && (
          <p className="posts-overview" aria-label="Tổng quan">
            <span><strong>{counts[''] ?? 0}</strong> bài</span>
            <span><strong>{counts.PUBLISHED ?? 0}</strong> đã đăng</span>
            <span className={counts.READY ? 'attention' : ''}><strong>{counts.READY ?? 0}</strong> chờ duyệt</span>
            {!!counts.SCHEDULED && <span><strong>{counts.SCHEDULED}</strong> đã lên lịch</span>}
            {!!counts.FAILED && <span className="danger"><strong>{counts.FAILED}</strong> lỗi</span>}
            {pendingComments > 0 && <span className="attention"><strong>{pendingComments}</strong> bình luận cần trả lời</span>}
          </p>
        )}

        <div className="filter-tabs" role="tablist" aria-label="Lọc theo trạng thái">
          {TABS.map((t) => (
            <button key={t.value} type="button" role="tab" className="filter-tab" aria-selected={status === t.value} onClick={() => setParam('status', t.value)}>
              {t.label}<span className="count">{counts[t.value] ?? 0}</span>
            </button>
          ))}
        </div>

        <PostFilters
          q={q}
          pageId={pageFilter}
          domainId={domainFilter}
          time={time}
          pages={pageOptions}
          domains={domains}
          onChange={(key, value) => setParam(key, value)}
        />

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
          <section className="card flush post-list" aria-label="Danh sách bài đăng">
            {visible.map((p) => (
              <PostListItem
                key={p.id}
                post={p}
                selected={p.id === selectedId}
                onSelect={() => openPost(p.id)}
                actions={rowActions(p)}
                inline={rowInline(p)}
                onComments={() => setCommentsFor(p.id)}
              />
            ))}
          </section>
        )}
        {!loading && visible.length > 0 && (
          <span className="muted" style={{ fontSize: 12.5 }}>Hiển thị {visible.length} / {posts.length} bài{posts.length === 50 ? ' (50 bài mới nhất)' : ''}</span>
        )}
      </div>

      <aside className={`inspector ${sheetOpen ? 'open' : ''}`} aria-label="Chi tiết bài đang chọn">
        <button type="button" className="btn btn-ghost btn-sm inspector-close" onClick={() => setSheetOpen(false)}>
          <ArrowLeft size={16} aria-hidden="true" /> Danh sách bài
        </button>
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
              {detail.videoUrl ? (
                <video className="fb-image fb-video" src={assetUrl(detail.videoUrl)!} controls muted preload="metadata" />
              ) : detail.imageUrl ? (
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
              {detail.scheduleQueued && (
                <div className="schedule-note">
                  <CalendarClock size={15} aria-hidden="true" />
                  <span>
                    Theo lịch <Link to={`/schedules/${detail.schedule?.id}`}>{detail.schedule?.name}</Link> · {slotLabel(detail.scheduledAt)}
                    {detail.status === 'SCHEDULED' ? ' · đã duyệt' : ''}
                  </span>
                </div>
              )}
              {detail.scheduleQueued && detail.status === 'READY' && (
                <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => void approve(selectedId!)} disabled={acting || !detail.caption}>
                  <CalendarClock size={16} aria-hidden="true" /> Duyệt — đăng lúc {slotLabel(detail.scheduledAt)}
                </button>
              )}
              {timed && (
                <div className="timed-note">
                  <CalendarClock size={15} aria-hidden="true" />
                  <span>Hẹn giờ đăng: <strong>{slotLabel(detail.scheduledAt)}</strong></span>
                </div>
              )}
              {(PUBLISHABLE.includes(detail.status) || timed) && (
                <button type="button" className={detail.scheduleQueued || timed ? 'btn btn-secondary btn-block' : 'btn btn-primary btn-lg btn-block'} onClick={confirmPublish} disabled={acting || !detail.caption}>
                  {acting && confirming === 'publish' ? <div className="spinner" /> : <Send size={16} aria-hidden="true" />}
                  {confirming === 'publish'
                    ? 'Bấm lần nữa để đăng công khai'
                    : detail.status === 'FAILED'
                      ? tally.total > 1 ? `Đăng lại ${tally.total - tally.published} Page chưa lên` : 'Đăng lại'
                      : timed ? 'Đăng ngay (bỏ hẹn giờ)'
                        : detail.scheduleQueued ? 'Đăng ngay (bỏ khung giờ)' : tally.total > 1 ? `Duyệt & đăng lên ${tally.total} Page` : 'Duyệt & đăng ngay'}
                </button>
              )}
              {(canTime || timed) &&
                (timing ? (
                  <SchedulePicker
                    initial={timed ? detail.scheduledAt : null}
                    busy={acting}
                    confirmLabel={timed ? 'Đổi giờ đăng' : 'Hẹn giờ đăng'}
                    onConfirm={(iso) => void scheduleAt(detail.id, iso)}
                    onCancel={() => setTiming(false)}
                  />
                ) : (
                  <button type="button" className="btn btn-secondary btn-block" onClick={() => setTiming(true)} disabled={acting}>
                    <CalendarClock size={15} aria-hidden="true" /> {timed ? 'Đổi giờ đăng' : 'Hẹn giờ đăng'}
                  </button>
                ))}
              {timed && (
                <button type="button" className="btn btn-ghost btn-block" onClick={() => void cancelTimed(detail.id)} disabled={acting}>
                  Huỷ hẹn giờ
                </button>
              )}
              {reelAvailable && EDITABLE.includes(detail.status) && !liveSomewhere && (
                <button type="button" className="btn btn-secondary btn-block" onClick={() => setReelOpen(true)} disabled={acting}>
                  <Clapperboard size={15} aria-hidden="true" /> {detail.inputData?.reelScript ? 'Sửa Reel' : 'Tạo Reel từ bài'}
                </button>
              )}
              {detail.status !== 'PUBLISHING' && (
                <button type="button" className="btn btn-danger btn-block" onClick={confirmRemove} disabled={acting}>
                  <Trash2 size={15} aria-hidden="true" />
                  {confirming === 'delete' ? 'Bấm lần nữa để xoá vĩnh viễn' : 'Xoá bài'}
                </button>
              )}
            </div>
          </>
        )}
      </aside>

      {commentsFor && <CommentsPanel postId={commentsFor} onClose={() => setCommentsFor(null)} onChanged={() => void load()} />}
      {reelOpen && detail && (
        <ReelMaker
          postId={detail.id}
          initialScript={detail.inputData?.reelScript}
          initialVoice={detail.inputData?.reelVoice}
          hasCaption={!!detail.caption}
          onClose={() => setReelOpen(false)}
          onStarted={() => setReelWatch(detail.id)}
        />
      )}
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
