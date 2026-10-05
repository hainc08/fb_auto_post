import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Check, Undo2, AlertTriangle, Sparkles, Send } from 'lucide-react';
import { postsApi, type CommentsPage, type CommentsView, type CommentThread } from '../api';
import { useToast } from './Toast';
import { formatWhen } from './PostBits';
import { announceCommentsChanged } from '../lib/comments-events';

interface Props {
  postId: string;
  /** Only this Page's comments (the "Bình luận" page works one Page at a time); default: every Page the post is on */
  pageId?: string;
  /** Counts changed (reply, handled, refresh, drafts): whoever shows them reloads */
  onChanged: () => void;
  /** Change it to fetch the comments again (the Page was refreshed elsewhere); replies being typed are kept */
  refreshKey?: number;
}

/** Comments of one published post, by Page: needs-reply first, reply as the Page, AI drafts, mark handled. */
export default function CommentsBoard({ postId, pageId, onChanged, refreshKey = 0 }: Props) {
  const toast = useToast();
  const [all, setAll] = useState<CommentsPage[] | null>(null);
  /** This post is left out of AI reply drafts */
  const [autoReplyOff, setAutoReplyOff] = useState(false);
  /** "Gửi N gợi ý" posts publicly: asked twice */
  const [armed, setArmed] = useState(false);
  const show = (view: CommentsView) => {
    setAll(view.pages);
    setAutoReplyOff(view.autoReplyOff);
  };
  const [onlyPending, setOnlyPending] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** Actions in flight (several can run at once; each key stays busy until its own request ends) */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const replying = [...busy].some((k) => k.startsWith('r:'));
  const pages = all && pageId ? all.filter((p) => p.page.id === pageId) : all;

  useEffect(() => {
    postsApi
      .comments(postId)
      .then((r) => show(r.data))
      .catch((e) => toast.error(e.message));
  }, [postId, refreshKey]);

  /** Run one action; true when it succeeded */
  async function run(key: string, action: () => Promise<{ data: CommentsView }>, done?: string): Promise<boolean> {
    setBusy((b) => new Set(b).add(key));
    try {
      const res = await action();
      show(res.data);
      onChanged();
      announceCommentsChanged();
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

  /** Post every waiting AI draft (the ones edited here are sent one by one with "Trả lời") */
  async function sendDrafts() {
    if (!armed) return setArmed(true);
    setArmed(false);
    setBusy((b) => new Set(b).add('r:all'));
    try {
      // exactly what is on screen: a draft the sync wrote meanwhile is not sent unread
      const { data } = await postsApi.sendDrafts(postId, sendable.map((t) => ({ commentId: t.id, reply: t.draftReply! })));
      show(data);
      // Facebook gave no clear answer for one: its text goes back in its box, to send by hand after a look at Facebook
      const unsure = data.uncertain;
      if (unsure) setDrafts((d) => ({ ...d, [unsure.commentId]: unsure.reply }));
      onChanged();
      announceCommentsChanged();
      if (data.failed) toast.error(`Đã gửi ${data.sent} câu rồi dừng: ${data.failed}`);
      else toast.success(data.sent ? `Đã gửi ${data.sent} câu trả lời trên Facebook.` : 'Không còn gợi ý nào để gửi.');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete('r:all');
        return next;
      });
    }
  }

  const pending = (pages ?? []).reduce((s, p) => s + p.unansweredCount, 0);
  const synced = (pages ?? []).map((p) => p.statsSyncedAt).filter((d): d is string => !!d).sort().pop() ?? null;
  /** A draft changed in its box: "Gửi N gợi ý" would post it as the AI wrote it, so it is left to its own "Trả lời" button */
  const edited = (t: CommentThread) => drafts[t.id] !== undefined && drafts[t.id] !== t.draftReply;
  /** Drafts "Gửi N gợi ý" sends: on Pages that may answer, untouched, at most 20 at a time (the server's limit) */
  const sendable = (pages ?? []).filter((p) => p.canReply).flatMap((p) => p.threads.filter((t) => t.draftReply && !edited(t))).slice(0, 20);
  const draftCount = sendable.length;
  const hasEdited = (pages ?? []).some((p) => p.canReply && p.threads.some((t) => t.draftReply && edited(t)));
  const anyAuto = (pages ?? []).some((p) => p.autoReply);

  function thread(p: CommentsPage, t: CommentThread) {
    // The AI draft fills the box until the member types something else
    const draft = drafts[t.id] ?? t.draftReply ?? '';
    const fromAi = !!t.draftReply && draft === t.draftReply;
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
              <div className="comment-reply-box">
                {fromAi && (
                  <span className="draft-chip">
                    <Sparkles size={12} aria-hidden="true" /> AI gợi ý — sửa nếu cần rồi gửi
                  </span>
                )}
                <textarea
                  className="form-textarea"
                  rows={2}
                  maxLength={2000}
                  aria-label={`Trả lời ${t.authorName ?? 'bình luận'}`}
                  placeholder="Trả lời bằng tên Page…"
                  value={draft}
                  onChange={(e) => setDrafts({ ...drafts, [t.id]: e.target.value })}
                />
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                // One public reply at a time: no second send while any reply is in flight
                disabled={!draft.trim() || replying}
                onClick={async () => {
                  const ok = await run(`r:${t.id}`, () => postsApi.replyComment(postId, t.id, draft.trim()), 'Đã trả lời trên Facebook.');
                  if (ok) setDrafts(({ [t.id]: _sent, ...rest }) => rest);
                }}
              >
                {busy.has(`r:${t.id}`) ? <div className="spinner" /> : 'Trả lời'}
              </button>
            </>
          )}
          {t.draftReply && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy.has(`d:${t.id}`)}
              onClick={async () => {
                const ok = await run(`d:${t.id}`, () => postsApi.discardDraft(postId, t.id));
                if (ok) setDrafts(({ [t.id]: _dropped, ...rest }) => rest);
              }}
            >
              Bỏ gợi ý
            </button>
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
    <div className="comments-board">
      <div className="comments-toolbar">
        <p className="field-hint" style={{ margin: 0 }}>
          {pending ? `${pending} cần trả lời` : 'Không có bình luận chờ trả lời'} · {synced ? `cập nhật ${formatWhen(synced)}` : 'chưa đồng bộ'}
        </p>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {draftCount > 0 && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={replying || hasEdited}
              title={hasEdited ? 'Bạn đang sửa một gợi ý: gửi câu đó bằng nút "Trả lời" trước' : undefined}
              onClick={() => void sendDrafts()}
              onBlur={() => setArmed(false)}
            >
              {busy.has('r:all') ? <div className="spinner" /> : <Send size={14} aria-hidden="true" />}
              {armed ? `Bấm lần nữa: gửi ${draftCount} câu lên Facebook` : `Gửi ${draftCount} gợi ý`}
            </button>
          )}
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy.has('refresh')} onClick={() => void run('refresh', () => postsApi.refreshComments(postId), 'Đã làm mới.')}>
            {busy.has('refresh') ? <div className="spinner" /> : <RefreshCw size={14} aria-hidden="true" />} Làm mới
          </button>
        </div>
      </div>
      <div className="segmented" role="radiogroup" aria-label="Lọc bình luận">
        <button type="button" role="radio" aria-checked={onlyPending} className={onlyPending ? 'active' : ''} onClick={() => setOnlyPending(true)}>
          Cần trả lời
        </button>
        <button type="button" role="radio" aria-checked={!onlyPending} className={!onlyPending ? 'active' : ''} onClick={() => setOnlyPending(false)}>
          Tất cả
        </button>
      </div>
      {anyAuto && (
        <label className="switch comments-auto" title="Tắt: AI không soạn câu trả lời cho bình luận của riêng bài này">
          <input
            type="checkbox"
            checked={!autoReplyOff}
            disabled={busy.has('auto')}
            onChange={(e) => void run('auto', () => postsApi.setAutoReplyOff(postId, !e.target.checked))}
            aria-label="AI soạn trả lời cho bài này"
          />
          <span className="switch-track" aria-hidden="true" />
          <span className="switch-label">AI soạn trả lời cho bài này</span>
        </label>
      )}
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
  );
}
