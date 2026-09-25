import { PostStatus, TargetStatus } from '@prisma/client';
import prisma from '../utils/prisma';
import { logger } from '../utils/logger';

/**
 * A post is published to one or more Pages ("targets"). Each target keeps its own
 * status and Facebook link; the post's status is derived from them.
 */

/** Default gap between Pages when one post goes to several (spam signals). */
export const DEFAULT_INTERVAL_MINUTES = 2;
export const MAX_INTERVAL_MINUTES = 30;

/**
 * Posts created before targets existed get one target for their Page,
 * mirroring the post's own result. Idempotent; runs at startup.
 */
export async function backfillTargets(): Promise<number> {
  const created = await prisma.$executeRaw`
    INSERT INTO post_targets (id, postId, pageId, status, fbPostId, fbPhotoId, fbPermalink, errorMessage, errorCode, publishedAt, createdAt, updatedAt)
    SELECT UUID(), p.id, p.pageId,
           CASE p.status WHEN 'PUBLISHED' THEN 'PUBLISHED' WHEN 'FAILED' THEN 'FAILED' ELSE 'PENDING' END,
           p.fbPostId, p.fbPhotoId, p.fbPermalink,
           CASE WHEN p.status = 'FAILED' THEN p.errorMessage ELSE NULL END,
           CASE WHEN p.status = 'FAILED' THEN p.errorCode ELSE NULL END,
           p.publishedAt, p.createdAt, UTC_TIMESTAMP(3)
    FROM posts p
    WHERE NOT EXISTS (SELECT 1 FROM post_targets t WHERE t.postId = p.id)`;
  if (created) logger.info(`[Targets] Backfilled ${created} post(s) with a Page target`);
  return created;
}

/**
 * Make the post's targets match `pageIds`: add missing Pages, drop unselected
 * ones that are not published yet (published ones always stay).
 */
export async function syncTargets(postId: string, pageIds: string[]): Promise<void> {
  const existing = await prisma.postTarget.findMany({ where: { postId }, select: { pageId: true, status: true } });
  const have = new Set(existing.map((t) => t.pageId));

  const toAdd = pageIds.filter((id) => !have.has(id));
  if (toAdd.length) {
    await prisma.postTarget.createMany({ data: toAdd.map((pageId) => ({ postId, pageId })), skipDuplicates: true });
  }
  await prisma.postTarget.deleteMany({
    where: { postId, pageId: { notIn: pageIds }, status: { in: ['PENDING', 'FAILED'] } },
  });
}

export interface TargetSummary {
  total: number;
  published: number;
  failed: number;
  inFlight: number;
}

export function summarize(statuses: TargetStatus[]): TargetSummary {
  return {
    total: statuses.length,
    published: statuses.filter((s) => s === 'PUBLISHED').length,
    failed: statuses.filter((s) => s === 'FAILED').length,
    inFlight: statuses.filter((s) => s === 'PENDING' || s === 'PUBLISHING').length,
  };
}

/** Post status for a set of targets that are no longer in flight. */
export function finalStatus(s: TargetSummary): PostStatus {
  return s.published === s.total ? 'PUBLISHED' : 'FAILED';
}

/**
 * Recompute the post from its targets once none is in flight. Returns true for
 * the single caller that moved the post out of PUBLISHING (so it alone notifies).
 */
export async function refreshPostStatus(postId: string): Promise<{ finalized: boolean; summary: TargetSummary }> {
  const targets = await prisma.postTarget.findMany({
    where: { postId },
    include: { page: { select: { pageName: true } } },
    orderBy: { publishedAt: 'asc' },
  });
  const summary = summarize(targets.map((t) => t.status));
  if (summary.total === 0 || summary.inFlight > 0) return { finalized: false, summary };

  const failedNames = targets.filter((t) => t.status === 'FAILED').map((t) => t.page.pageName);
  const first = targets.find((t) => t.status === 'PUBLISHED');
  const firstError = targets.find((t) => t.status === 'FAILED')?.errorMessage;

  const { count } = await prisma.post.updateMany({
    where: { id: postId, status: 'PUBLISHING' },
    data: {
      status: finalStatus(summary),
      errorMessage: failedNames.length
        ? `Lỗi trên ${failedNames.length}/${summary.total} Page (${failedNames.join(', ')})${firstError ? `: ${firstError}` : ''}`
        : null,
      // Kept for screens that show a single link (dashboard, analytics)
      fbPostId: first?.fbPostId ?? null,
      fbPhotoId: first?.fbPhotoId ?? null,
      fbPermalink: first?.fbPermalink ?? null,
      publishedAt: first?.publishedAt ?? null,
    },
  });
  return { finalized: count === 1, summary };
}

/** Content is locked once it is live on any Page, so all Pages carry the same post. */
export async function isLiveOnAnyPage(postId: string): Promise<boolean> {
  return (await prisma.postTarget.count({ where: { postId, status: { in: ['PUBLISHED', 'PUBLISHING'] } } })) > 0;
}
