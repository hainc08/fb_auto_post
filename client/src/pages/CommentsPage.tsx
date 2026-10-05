import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ExternalLink, MessageCircle, RefreshCw, Sparkles, ThumbsUp } from 'lucide-react';
import { commentsApi, assetUrl, type CommentsHubPage, type CommentsHubPost } from '../api';
import { useToast } from '../components/Toast';
import CommentsBoard from '../components/CommentsBoard';
import { PostThumb, formatWhen, pageInitials, postTitle } from '../components/PostBits';
import { announceCommentsChanged } from '../lib/comments-events';

/** "Bình luận": choose a Page → its published posts with their counts → the comments of one post. */
export default function CommentsPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const pageId = params.get('page');
  const postId = params.get('post');
  const [pages, setPages] = useState<CommentsHubPage[] | null>(null);
  const [posts, setPosts] = useState<CommentsHubPost[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'pending'>('all');
  const [refreshing, setRefreshing] = useState(false);

  /** Change the address (the page reads everything it shows from it, so a reload or a shared link lands on the same view) */
  function go(next: { page?: string | null; post?: string | null }, replace = false) {
    const p = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) p.set(key, value);
      else p.delete(key);
    }
    setParams(p, { replace });
  }

  const loadPages = () =>
    commentsApi.overview().then((r) => {
      setPages(r.data.pages);
      return r.data.pages;
    });
  const loadPosts = (id: string, f: 'all' | 'pending') => commentsApi.posts(id, f).then((r) => setPosts(r.data));

  useEffect(() => {
    loadPages()
      .then((list) => {
        // no Page in the address: start on the one with the most comments waiting
        if (!pageId && list.length) go({ page: [...list].sort((a, b) => b.unanswered - a.unanswered)[0].id }, true);
      })
      .catch((e) => {
        toast.error(e.message);
        setPages([]);
      });
  }, []);

  useEffect(() => {
    if (!pageId) return;
    setPosts(null);
    loadPosts(pageId, filter).catch((e) => {
      toast.error(e.message);
      setPosts([]);
    });
  }, [pageId, filter]);

  /** Counts changed (a reply, "Đã xử lý", a refresh): the tiles and the list follow, quietly */
  const reload = () => {
    void loadPages().catch(() => {});
    if (pageId) void loadPosts(pageId, filter).catch(() => {});
  };

  async function refreshPage() {
    if (!pageId) return;
    setRefreshing(true);
    try {
      const { data } = await commentsApi.refresh(pageId);
      toast.success(`Đã làm mới ${data.synced} bài. Gợi ý AI (nếu có) sẽ hiện sau ít giây.`);
      reload();
      announceCommentsChanged();
      // AI drafts are written after the sync answers
      setTimeout(reload, 10_000);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setRefreshing(false);
    }
  }

  const current = pages?.find((p) => p.id === pageId) ?? null;
  const inList = posts?.find((p) => p.postId === postId) ?? null;
  /** The open post as last seen in the list: it keeps its title when the filtered list no longer holds it */
  const [opened, setOpened] = useState<CommentsHubPost | null>(null);
  useEffect(() => {
    if (inList) setOpened(inList);
  }, [inList]);
  const selected = inList ?? (opened?.postId === postId ? opened : null);

  if (pages && pages.length === 0) {
    return (
      <div className="comments-hub">
        <div className="page-header">
          <h1>Bình luận</h1>
          <p>Chưa có Page nào đang kết nối. Vào <Link to="/pages">Kênh Facebook</Link> để kết nối Page trước.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`comments-hub ${postId ? 'has-post' : ''}`}>
      <div className="page-header">
        <h1>Bình luận</h1>
        <p>Chọn Page, chọn bài, rồi đọc và trả lời bình luận ngay tại đây. Chỉ gồm các bài do app đăng.</p>
      </div>

      {current && (
        <div className="stats-grid hub-stats">
          <div className="stat-card">
            <span className="stat-label">Cần trả lời</span>
            <span className="stat-value">{current.unanswered}</span>
            <span className={`stat-change ${current.unanswered ? 'negative' : 'positive'}`}>{current.unanswered ? 'bình luận đang chờ' : 'Đã trả lời hết'}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Gợi ý AI chờ duyệt</span>
            <span className="stat-value">{current.drafts}</span>
            {current.autoReply ? (
              <span className="stat-change">AI đang soạn trả lời cho Page này</span>
            ) : (
              <Link to="/pages" className="stat-change" style={{ color: 'var(--primary-500)', fontWeight: 500 }}>Bật AI trả lời ở Kênh Facebook →</Link>
            )}
          </div>
          <div className="stat-card">
            <span className="stat-label">Bài có bình luận</span>
            <span className="stat-value">{current.postsWithComments}<small> / {current.posts}</small></span>
            <span className="stat-change">{current.comments} bình luận tất cả</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Cập nhật</span>
            <span className="stat-value hub-synced">{current.syncedAt ? formatWhen(current.syncedAt) : 'Chưa đồng bộ'}</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refreshPage()} disabled={refreshing} style={{ alignSelf: 'flex-start' }}>
              {refreshing ? <div className="spinner" /> : <RefreshCw size={14} aria-hidden="true" />} Làm mới Page
            </button>
          </div>
        </div>
      )}

      {current && !current.tokenValid && (
        <p className="comments-note">
          <AlertTriangle size={14} aria-hidden="true" /> Token của Page này chưa dùng được với Facebook App hiện tại nên bình luận không được cập nhật. <Link to="/pages">Đồng bộ Page</Link>
        </p>
      )}
      {current && current.tokenValid && !current.canRead && (
        <p className="comments-note">
          <AlertTriangle size={14} aria-hidden="true" /> Page chưa cấp quyền đọc bình luận. <Link to="/pages">Đồng bộ Page</Link> và tick đủ quyền.
        </p>
      )}

      <div className="hub-grid">
        <nav className="hub-pages card flush" aria-label="Chọn Page">
          <h2 className="hub-title">Page</h2>
          {!pages ? (
            <div className="loading-page" style={{ minHeight: 120 }}><div className="spinner" /></div>
          ) : (
            <ul>
              {pages.map((p) => (
                <li key={p.id}>
                  <button type="button" className={`hub-page ${p.id === pageId ? 'active' : ''}`} aria-current={p.id === pageId} onClick={() => go({ page: p.id, post: null })}>
                    <span className="hub-avatar" aria-hidden="true">{p.pageAvatar ? <img src={p.pageAvatar} alt="" /> : pageInitials(p.pageName)}</span>
                    <span className="hub-page-name">{p.pageName}</span>
                    {p.unanswered > 0 && <span className="nav-count" aria-label={`${p.unanswered} bình luận cần trả lời`}>{p.unanswered}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>

        <section className="hub-posts card flush" aria-label="Bài đăng của Page">
          <div className="hub-posts-head">
            <h2 className="hub-title">Bài đăng</h2>
            <div className="segmented" role="radiogroup" aria-label="Lọc bài">
              <button type="button" role="radio" aria-checked={filter === 'all'} className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
                Tất cả
              </button>
              <button type="button" role="radio" aria-checked={filter === 'pending'} className={filter === 'pending' ? 'active' : ''} onClick={() => setFilter('pending')}>
                Cần trả lời
              </button>
            </div>
          </div>
          {!pageId || !posts ? (
            <div className="loading-page" style={{ minHeight: 160 }}><div className="spinner" /></div>
          ) : posts.length === 0 ? (
            <p className="field-hint hub-empty">{filter === 'pending' ? 'Không có bài nào đang chờ trả lời bình luận.' : 'Page này chưa có bài nào do app đăng.'}</p>
          ) : (
            <ul className="hub-post-list">
              {posts.map((p) => (
                <li key={p.targetId}>
                  <button type="button" className={`hub-post ${p.postId === postId ? 'active' : ''}`} aria-current={p.postId === postId} onClick={() => go({ post: p.postId })}>
                    <PostThumb src={assetUrl(p.imageUrl)} size={44} video={p.hasVideo} />
                    <span className="hub-post-text">
                      <span className="hub-post-title">{postTitle(p.caption) || 'Bài không có chữ'}</span>
                      <span className="hub-post-meta">
                        <span>{p.publishedAt ? formatWhen(p.publishedAt) : ''}</span>
                        <span><ThumbsUp size={12} aria-hidden="true" /> {p.reactionCount ?? '–'}</span>
                        <span><MessageCircle size={12} aria-hidden="true" /> {p.commentCount ?? '–'}</span>
                        {p.draftCount > 0 && (
                          <span className="hub-drafts"><Sparkles size={12} aria-hidden="true" /> {p.draftCount} gợi ý</span>
                        )}
                      </span>
                    </span>
                    {p.unansweredCount > 0 && <span className="badge badge-ready">{p.unansweredCount} chờ</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="hub-board card" aria-label="Bình luận của bài">
          {postId && pageId ? (
            <>
              <button type="button" className="back-link hub-back" onClick={() => go({ post: null })}>
                <ArrowLeft size={15} aria-hidden="true" /> Danh sách bài
              </button>
              <div className="hub-board-head">
                <h2 className="hub-title">{selected ? postTitle(selected.caption) || 'Bài không có chữ' : 'Bình luận của bài'}</h2>
                {selected?.fbPermalink && (
                  <a href={selected.fbPermalink} target="_blank" rel="noreferrer" className="link-btn">
                    Xem trên Facebook <ExternalLink size={12} aria-hidden="true" />
                  </a>
                )}
              </div>
              {/* driven by the address, not by the list: a post that leaves the filtered list stays open while it is worked on */}
              <CommentsBoard key={`${postId}:${pageId}`} postId={postId} pageId={pageId} onChanged={reload} />
            </>
          ) : (
            <div className="hub-empty hub-choose">
              <MessageCircle size={28} strokeWidth={1.5} aria-hidden="true" />
              <p>Chọn một bài ở cột bên để xem và trả lời bình luận.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
