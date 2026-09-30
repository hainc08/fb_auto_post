import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { X, RefreshCw, Check, Undo2, AlertTriangle } from 'lucide-react';
import { postsApi, type CommentsPage, type CommentThread } from '../api';
import { useToast } from './Toast';
import { formatWhen } from './PostBits';

interface Props {
  postId: string;
  onClose: () => void;
  /** Counts changed (reply, handled, refresh): the list reloads */
  onChanged: () => void;
}

/** Comments of one published post, by Page: needs-reply first, reply as the Page, mark handled. */
export default function CommentsPanel({ postId, onClose, onChanged }: Props) {
  const toast = useToast();
  const [pages, setPages] = useState<CommentsPage[] | null>(null);
  const [onlyPending, setOnlyPending] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** Actions in flight (several can run at once; each key stays busy until its own request ends) */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const replying = [...busy].some((k) => k.startsWith('r:'));

  useEffect(() => {
    postsApi
      .comments(postId)
      .then((r) => setPages(r.data.pages))
      .catch((e) => toast.error(e.message));
  }, [postId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** Run one action; true when it succeeded */
  async function run(key: string, action: () => Promise<{ data: { pages: CommentsPage[] } }>, done?: string): Promise<boolean> {
    setBusy((b) => new Set(b).add(key));
    try {
      const res = await action();
      setPages(res.data.pages);
      onChanged();
      if (done) toast.success(done);
      return true;
    } catch (e: any) {
      toast.error(e.message);
      return false;
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(key);
        return next;
      });
    }
  }

  const pending = (pages ?? []).reduce((s, p) => s + p.unansweredCount, 0);
  const synced = (pages ?? []).map((p) => p.statsSyncedAt).filter((d): d is string => !!d).sort().pop() ?? null;

  function thread(p: CommentsPage, t: CommentThread) {
    const draft = drafts[t.id] ?? '';
    return (
      <li key={t.id} className={`comment-thread ${t.needsReply ? 'pending' : ''}`}>
        <div className="comment-head">
          <strong>{t.fromPage ? p.page.pageName : (t.authorName ?? 'Người xem')}</strong>
          <span className="muted">{formatWhen(t.commentedAt)}</span>
          {t.needsReply && <span className="badge badge-ready">Cần trả lời</span>}
          {t.handledAt && <span className="badge badge-draft">Đã xử lý</span>}
        </div>
        <p className="comment-body">{t.message || <em className="muted">(bình luận không có chữ)</em>}</p>
        {t.replies.map((r) => (
          <div key={r.id} className={`comment-reply ${r.fromPage ? 'from-page' : ''}`}>
            <strong>{r.fromPage ? p.page.pageName : (r.authorName ?? 'Người xem')}</strong> <span className="muted">{formatWhen(r.commentedAt)}</span>
            <p className="comment-body">{r.message}</p>
          </div>
        ))}
        <div className="comment-actions">
          {p.canReply && (
            <>
              <textarea
                className="form-textarea"
                rows={2}
                maxLength={2000}
                aria-label={`Trả lời ${t.authorName ?? 'bình luận'}`}
                placeholder="Trả lời bằng tên Page…"
                value={draft}
                onChange={(e) => setDrafts({ ...drafts, [t.id]: e.target.value })}
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                // One public reply at a time: no second send while any reply is in flight
                disabled={!draft.trim() || replying}
                onClick={async () => {
                  const ok = await run(`r:${t.id}`, () => postsApi.replyComment(postId, t.id, draft.trim()), 'Đã trả lời trên Facebook.');
                  if (ok) setDrafts((d) => ({ ...d, [t.id]: '' }));
                }}
              >
                {busy.has(`r:${t.id}`) ? <div className="spinner" /> : 'Trả lời'}
              </button>
            </>
          )}
          {!t.fromPage && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy.has(`h:${t.id}`)} onClick={() => void run(`h:${t.id}`, () => postsApi.markHandled(postId, t.id, !t.handledAt))}>
              {t.handledAt ? (
                <>
                  <Undo2 size={14} aria-hidden="true" /> Bỏ đánh dấu
                </>
              ) : (
                <>
                  <Check size={14} aria-hidden="true" /> Đã xử lý
                </>
              )}
            </button>
          )}
        </div>
      </li>
    );
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-panel comments-panel" role="dialog" aria-modal="true" aria-labelledby="comments-title">
        <header className="modal-head">
          <div>
            <h2 id="comments-title">Bình luận</h2>
            <p className="field-hint" style={{ margin: 0 }}>
              {pending ? `${pending} cần trả lời` : 'Không có bình luận chờ trả lời'} · {synced ? `cập nhật ${formatWhen(synced)}` : 'chưa đồng bộ'}
            </p>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy.has('refresh')} onClick={() => void run('refresh', () => postsApi.refreshComments(postId), 'Đã làm mới.')}>
              {busy.has('refresh') ? <div className="spinner" /> : <RefreshCw size={14} aria-hidden="true" />} Làm mới
            </button>
            <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Đóng">
              <X size={20} />
            </button>
          </div>
        </header>
        <div className="comments-body">
          <div className="segmented" role="radiogroup" aria-label="Lọc bình luận">
            <button type="button" role="radio" aria-checked={onlyPending} className={onlyPending ? 'active' : ''} onClick={() => setOnlyPending(true)}>
              Cần trả lời
            </button>
            <button type="button" role="radio" aria-checked={!onlyPending} className={!onlyPending ? 'active' : ''} onClick={() => setOnlyPending(false)}>
              Tất cả
            </button>
          </div>
          {!pages ? (
            <div className="loading-page"><div className="spinner spinner-lg" /></div>
          ) : pages.length === 0 ? (
            <p className="field-hint">Bài chưa được đăng lên Page nào.</p>
          ) : (
            pages.map((p) => {
              const shown = onlyPending ? p.threads.filter((t) => t.needsReply) : p.threads;
              return (
                <section key={p.targetId} className="comments-page" aria-label={`Bình luận trên ${p.page.pageName}`}>
                  {pages.length > 1 && <h3>{p.page.pageName}</h3>}
                  {!p.canRead && (
                    <p className="comments-note">
                      <AlertTriangle size={14} aria-hidden="true" /> {p.commentsError ?? 'Page chưa cấp quyền đọc bình luận.'} <Link to="/pages">Kênh Facebook</Link>
                    </p>
                  )}
                  {p.canRead && !p.canReply && (
                    <p className="comments-note">
                      <AlertTriangle size={14} aria-hidden="true" /> Muốn trả lời trong app: vào <Link to="/pages">Kênh Facebook</Link> → Đồng bộ Page và tick quyền quản lý bình luận.
                    </p>
                  )}
                  {shown.length ? (
                    <ul className="comment-list">{shown.map((t) => thread(p, t))}</ul>
                  ) : (
                    <p className="field-hint">{onlyPending ? 'Không có bình luận chờ trả lời.' : 'Chưa có bình luận.'}</p>
                  )}
                </section>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
