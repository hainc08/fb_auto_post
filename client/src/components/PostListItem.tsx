import type { ReactNode } from 'react';
import { StatusBadge, PostThumb, formatWhen } from './PostBits';
import PostActionsMenu, { type MenuAction } from './PostActionsMenu';
import PostPublishProgress from './PostPublishProgress';
import { splitCaption, visibleTags, postTime, engagementTotals, type TargetSummary } from '../lib/post-display';

export interface ListItemPost {
  id: string;
  caption: string | null;
  imageUrl: string | null;
  videoUrl?: string | null;
  videoKind?: 'FEED' | 'REEL' | null;
  hashtags: string[] | null;
  status: string;
  errorMessage: string | null;
  publishedAt: string | null;
  scheduledAt: string | null;
  createdAt: string;
  scheduleQueued?: boolean;
  schedule?: { id: string; name: string } | null;
  page: { id: string; pageName: string } | null;
  targets?: TargetSummary[];
  domain?: { id: string; name: string } | null;
}

interface Props {
  post: ListItemPost;
  selected: boolean;
  onSelect: () => void;
  actions: MenuAction[];
  /** Direct buttons (e.g. "Sửa" + "Duyệt & đăng" for posts waiting for approval) */
  inline?: ReactNode;
  /** Opens the comments panel ("N cần trả lời" badge) */
  onComments?: () => void;
}

/** One post: thumbnail · title + 2-line preview + light metadata · status, progress, time, actions. */
export default function PostListItem({ post: p, selected, onSelect, actions, inline, onComments }: Props) {
  const { title, preview } = splitCaption(p.caption);
  const tags = visibleTags(p.hashtags);
  const pageNames = p.targets?.length ? p.targets.map((t) => t.page?.pageName).filter(Boolean).join(', ') : p.page?.pageName;
  const pageLabel = (p.targets?.length ?? 0) > 1 ? `${p.targets!.length} Page` : (pageNames ?? '');
  const eng = engagementTotals(p.targets);
  const stats = [eng.reactions && `👍 ${eng.reactions}`, eng.comments && `💬 ${eng.comments}`, eng.shares && `↗ ${eng.shares}`].filter(Boolean).join(' · ');
  const waitingForSlot = p.status === 'SCHEDULED' || (!!p.scheduleQueued && !!p.scheduledAt && !p.publishedAt);

  return (
    <article className={`post-item ${selected ? 'selected' : ''}`} aria-current={selected || undefined}>
      <button type="button" className="post-item-open" onClick={onSelect} aria-label={`Xem chi tiết: ${title || 'bài chưa có nội dung'}`}>
        <PostThumb src={p.imageUrl} size={72} video={!!p.videoUrl} />
        <span className="post-item-body">
          <span className={`post-item-title ${title ? '' : 'empty'}`} title={title || undefined}>
            {title || 'Chưa có nội dung'}
          </span>
          {p.status === 'FAILED' && p.errorMessage ? (
            <span className="post-item-preview error" title={p.errorMessage}>{p.errorMessage}</span>
          ) : (
            preview && <span className="post-item-preview">{preview}</span>
          )}
          <span className="post-item-meta">
            {pageLabel && <span title={pageNames ?? undefined}>{pageLabel}</span>}
            {p.domain && <span className="domain-tag">{p.domain.name}</span>}
            {p.scheduleQueued && <span>Theo lịch</span>}
            {p.videoKind === 'REEL' ? <span>Reels</span> : p.videoUrl ? <span>Video</span> : null}
            {tags.shown.length > 0 && (
              <span className="post-item-tags" title={(p.hashtags ?? []).map((h) => `#${h.replace(/^#+/, '')}`).join(' ')}>
                {tags.shown.join(' ')}
                {tags.more ? ` +${tags.more}` : ''}
              </span>
            )}
          </span>
        </span>
      </button>
      <div className="post-item-side">
        <span className="post-item-status">
          <StatusBadge status={p.status} />
          <PostPublishProgress targets={p.targets} />
        </span>
        {eng.synced && (stats || eng.unanswered > 0) && (
          <span className="post-item-stats">
            {stats && <span aria-label={`${eng.reactions} cảm xúc, ${eng.comments} bình luận, ${eng.shares} chia sẻ`}>{stats}</span>}
            {eng.unanswered > 0 && (
              <button
                type="button"
                className="badge badge-ready unanswered-badge"
                onClick={(e) => {
                  e.stopPropagation();
                  onComments?.();
                }}
                aria-label={`${eng.unanswered} bình luận cần trả lời — mở bình luận`}
              >
                {eng.unanswered} cần trả lời
              </button>
            )}
          </span>
        )}
        <span className="post-item-time">{waitingForSlot ? `Lên lịch ${formatWhen(p.scheduledAt)}` : formatWhen(postTime(p))}</span>
        <span className="post-item-actions">
          {inline}
          <PostActionsMenu label={`Thao tác cho bài: ${title || 'chưa có nội dung'}`} actions={actions} />
        </span>
      </div>
    </article>
  );
}
