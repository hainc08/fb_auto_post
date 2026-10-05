import type { Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { logger } from '../utils/logger';
import { config } from '../config';
import { getSettings, revealSecret } from '../lib/settings';
import { upsertKeyedJob, type JobResult } from '../lib/job-queue';
import { COMMENT_READ_SCOPE, FacebookClient, isPermissionError, type GraphComment } from '../lib/clients/facebook';
import { toStringArray } from '../utils/json';
import { draftReplies } from './reply-drafts';

/**
 * Reactions / comments / shares and the comments themselves, for posts published in
 * the last 30 days. See docs/superpowers/plans/2026-09-30-engagement-comments.md.
 */

export const ENGAGEMENT_WINDOW_DAYS = 30;
export const SYNC_ENGAGEMENT_KEY = 'system:sync_engagement';
const SYNC_EVERY_MS = 60 * 60_000;
/** Facebook returns at most this many top-level comments per sync (newest first) */
const COMMENT_WINDOW = 50;
export const COMMENTS_NEED_RESYNC = 'Page chưa cấp quyền đọc bình luận. Vào Kênh Facebook → Đồng bộ Page và tick đủ quyền.';

/** Top-level, from a viewer, no Page reply, not marked handled */
export async function recountUnanswered(targetId: string): Promise<number> {
  const unanswered = await prisma.postComment.count({ where: { targetId, parentFbId: null, fromPage: false, pageReplied: false, handledAt: null } });
  await prisma.postTarget.update({ where: { id: targetId }, data: { unansweredCount: unanswered } });
  return unanswered;
}

async function storeComments(targetId: string, pageFbId: string, comments: GraphComment[], now: Date): Promise<void> {
  // Threads with more replies than Facebook returned: an answer from the Page may be among the older ones
  const truncated = comments.filter((c) => c.comments?.paging?.next).map((c) => c.id);
  const stillAnswered = new Set(
    (await prisma.postComment.findMany({ where: { fbCommentId: { in: truncated.length ? truncated : ['-'] }, pageReplied: true }, select: { fbCommentId: true } })).map(
      (c) => c.fbCommentId
    )
  );
  const seen: string[] = [];
  for (const c of comments) {
    const replies = c.comments?.data ?? [];
    const rows = [
      { row: c, parent: null as string | null, pageReplied: replies.some((r) => r.from?.id === pageFbId) || stillAnswered.has(c.id) },
      ...replies.map((r) => ({ row: r, parent: c.id, pageReplied: false })),
    ];
    for (const { row, parent, pageReplied } of rows) {
      seen.push(row.id);
      const data = {
        parentFbId: parent,
        authorId: row.from?.id ?? null,
        authorName: row.from?.name?.slice(0, 200) ?? null,
        message: row.message ?? '',
        commentedAt: new Date(row.created_time),
        fromPage: row.from?.id === pageFbId,
        pageReplied,
        syncedAt: now,
      };
      await prisma.postComment.upsert({ where: { fbCommentId: row.id }, create: { targetId, fbCommentId: row.id, ...data }, update: data });
    }
  }

  // Gone from Facebook (deleted/hidden) → gone here too, but only where the fetch was complete:
  // - top-level: every one when fewer than 50 came back, else only those newer than the oldest fetched;
  // - replies: only under top-level comments whose replies all came back.
  const oldest = comments.length ? new Date(comments[comments.length - 1].created_time) : null;
  const fullWindow = comments.length >= COMMENT_WINDOW && oldest;
  const complete = comments.filter((c) => !c.comments?.paging?.next).map((c) => c.id);
  await prisma.postComment.deleteMany({
    where: {
      targetId,
      fbCommentId: { notIn: seen.length ? seen : ['-'] },
      OR: [
        { parentFbId: null, ...(fullWindow ? { commentedAt: { gt: oldest } } : {}) },
        { parentFbId: { in: complete.length ? complete : ['-'] } },
      ],
    },
  });
  // Replies whose top-level comment is gone
  const tops = (await prisma.postComment.findMany({ where: { targetId, parentFbId: null }, select: { fbCommentId: true } })).map((c) => c.fbCommentId);
  await prisma.postComment.deleteMany({ where: { targetId, parentFbId: { not: null, notIn: tops.length ? tops : ['-'] } } });
}

/** Sync these targets: counts for all, comments for those that have any. Grouped by Page; one Page failing never stops the others. */
export async function syncTargets(targetIds: string[], now = new Date()): Promise<void> {
  const targets = await prisma.postTarget.findMany({
    where: { id: { in: targetIds }, fbPostId: { not: null } },
    include: { page: true },
  });
  const byPage = new Map<string, typeof targets>();
  for (const t of targets) byPage.set(t.pageId, [...(byPage.get(t.pageId) ?? []), t]);

  for (const group of byPage.values()) {
    const page = group[0].page;
    try {
      const settings = await getSettings(page.userId);
      const token = revealSecret(page.pageAccessToken);
      const fb = new FacebookClient({ appId: settings.fbAppId, appSecret: settings.fbAppSecret, graphVersion: settings.fbGraphVersion }, [token]);
      const counts = await fb.getEngagement(
        group.map((t) => t.fbPostId!),
        token
      );
      const canRead = toStringArray(page.grantedScopes).includes(COMMENT_READ_SCOPE);

      for (const t of group) {
        const c = counts[t.fbPostId!];
        let commentsError: string | null = null;
        if (c && c.comments > 0) {
          if (!canRead) commentsError = COMMENTS_NEED_RESYNC;
          else {
            try {
              await storeComments(t.id, page.pageId, await fb.getComments(t.fbPostId!, token), now);
            } catch (error) {
              if (!isPermissionError(error)) throw error;
              commentsError = COMMENTS_NEED_RESYNC;
            }
          }
        } else if (c) {
          await prisma.postComment.deleteMany({ where: { targetId: t.id } }); // no comments left
        }
        await prisma.postTarget.update({
          where: { id: t.id },
          data: c ? { reactionCount: c.reactions, commentCount: c.comments, shareCount: c.shares, statsSyncedAt: now, commentsError } : { statsSyncedAt: now },
        });
        await recountUnanswered(t.id);
        // "AI soạn trả lời bình luận": drafts only, sent by the member later. A failing AI never fails the sync.
        if (page.autoReply) {
          await draftReplies(t.id, now).catch((error) => logger.warn('[Replies] Drafting failed', { targetId: t.id, error: (error as Error).message }));
        }
      }
    } catch (error) {
      logger.warn('[Engagement] Page sync failed', { pageId: page.id, error: (error as Error).message });
    }
  }
}

/** Every eligible target: published ≤ 30 days ago, on an active VALID Page of an active account. */
export async function runEngagementSync(now = new Date(), where: Prisma.PostTargetWhereInput = {}): Promise<void> {
  const since = new Date(now.getTime() - ENGAGEMENT_WINDOW_DAYS * 86_400_000);
  const targets = await prisma.postTarget.findMany({
    where: {
      ...where,
      status: 'PUBLISHED',
      fbPostId: { not: null },
      publishedAt: { gte: since },
      page: { isActive: true, tokenStatus: 'VALID', user: { isActive: true } },
    },
    select: { id: true },
  });
  if (targets.length) await syncTargets(targets.map((t) => t.id), now);
}

/** sync_engagement job: never stops re-booking itself, even when a sync fails */
export async function runEngagementSyncJob(): Promise<JobResult> {
  try {
    await runEngagementSync();
  } catch (error) {
    logger.error('[Engagement] Sync failed', { error: (error as Error).message });
  }
  return { rescheduleAt: new Date(Date.now() + SYNC_EVERY_MS) };
}

/** One pending hourly sync (not in tests: DB test files share the database). */
export async function bookEngagementSync(): Promise<void> {
  if (config.env === 'test') return;
  const existing = await prisma.job.findUnique({ where: { key: SYNC_ENGAGEMENT_KEY } });
  if (existing && (existing.status === 'PENDING' || existing.status === 'RUNNING')) return;
  await upsertKeyedJob(SYNC_ENGAGEMENT_KEY, 'sync_engagement', {}, new Date(Date.now() + 60_000));
}
