import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { toStringArray } from '../utils/json';
import { COMMENT_READ_SCOPE, COMMENT_REPLY_SCOPE } from '../lib/clients/facebook';
import { ENGAGEMENT_WINDOW_DAYS, syncTargets } from '../services/engagement-sync';

/**
 * The "Bình luận" page (mounted at /api/comments): totals per Page, the posts of one Page with their
 * comment counts, and "refresh this Page". The comments of a post come from /api/posts/:id/comments.
 */

const router = Router();
router.use(authenticate);

const POSTS_LIMIT = 100;
const REFRESH_LIMIT = 50;
const REFRESH_WAIT_MS = 30_000;
/** A post on a Page that is live on Facebook */
const published = { status: 'PUBLISHED', fbPostId: { not: null } } as const;

/** AI drafts still waiting to be sent, per target */
async function draftCounts(targetIds: string[]): Promise<Map<string, number>> {
  if (!targetIds.length) return new Map();
  const rows = await prisma.postComment.groupBy({
    by: ['targetId'],
    where: { targetId: { in: targetIds }, parentFbId: null, fromPage: false, pageReplied: false, handledAt: null, draftReply: { not: null } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.targetId, r._count._all]));
}

/** The caller's Page, or 404 */
async function ownPage(userId: string, pageId: string) {
  const page = await prisma.facebookPage.findFirst({ where: { id: pageId, userId }, select: { id: true, tokenStatus: true } });
  if (!page) throw createError(404, 'Page not found');
  return page;
}

/** Totals of each active Page: what waits for an answer, what the AI drafted, when it was last synced. */
router.get(
  '/overview',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const pages = await prisma.facebookPage.findMany({
      where: { userId, isActive: true },
      select: { id: true, pageName: true, pageAvatar: true, grantedScopes: true, autoReply: true, tokenStatus: true },
      orderBy: { pageName: 'asc' },
    });
    const targets = await prisma.postTarget.findMany({
      where: { ...published, pageId: { in: pages.map((p) => p.id) }, post: { userId } },
      select: { id: true, pageId: true, commentCount: true, unansweredCount: true, statsSyncedAt: true },
    });
    const drafts = await draftCounts(targets.map((t) => t.id));
    res.json({
      success: true,
      data: {
        pages: pages.map((p) => {
          const mine = targets.filter((t) => t.pageId === p.id);
          const scopes = toStringArray(p.grantedScopes);
          const synced = mine.map((t) => t.statsSyncedAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
          return {
            id: p.id,
            pageName: p.pageName,
            pageAvatar: p.pageAvatar,
            canRead: scopes.includes(COMMENT_READ_SCOPE),
            canReply: scopes.includes(COMMENT_REPLY_SCOPE),
            autoReply: p.autoReply,
            tokenValid: p.tokenStatus === 'VALID',
            posts: mine.length,
            postsWithComments: mine.filter((t) => (t.commentCount ?? 0) > 0).length,
            comments: mine.reduce((sum, t) => sum + (t.commentCount ?? 0), 0),
            unanswered: mine.reduce((sum, t) => sum + t.unansweredCount, 0),
            drafts: mine.reduce((sum, t) => sum + (drafts.get(t.id) ?? 0), 0),
            syncedAt: synced ? new Date(synced).toISOString() : null,
          };
        }),
      },
    });
  })
);

const postsQuery = z.object({ pageId: z.string().uuid(), filter: z.enum(['all', 'pending']).default('all') });

/** The published posts of one Page: those with comments waiting first, then the newest (at most 100). */
router.get(
  '/posts',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { pageId, filter } = postsQuery.parse(req.query);
    const userId = req.user!.id;
    const page = await ownPage(userId, pageId);
    const targets = await prisma.postTarget.findMany({
      where: { ...published, pageId: page.id, post: { userId }, ...(filter === 'pending' && { unansweredCount: { gt: 0 } }) },
      orderBy: [{ unansweredCount: 'desc' }, { publishedAt: 'desc' }],
      take: POSTS_LIMIT,
      select: {
        id: true,
        postId: true,
        publishedAt: true,
        fbPermalink: true,
        reactionCount: true,
        commentCount: true,
        shareCount: true,
        unansweredCount: true,
        statsSyncedAt: true,
        commentsError: true,
        post: { select: { caption: true, imageUrl: true, videoUrl: true } },
      },
    });
    const drafts = await draftCounts(targets.map((t) => t.id));
    res.json({
      success: true,
      data: targets.map(({ id, post, ...t }) => ({
        targetId: id,
        ...t,
        caption: (post.caption ?? '').slice(0, 300),
        imageUrl: post.imageUrl,
        hasVideo: !!post.videoUrl,
        draftCount: drafts.get(id) ?? 0,
      })),
    });
  })
);

/**
 * "Làm mới Page": sync the Page's posts of the last 30 days now (counts, comments, and AI drafts where the
 * Page has them on — those finish in the background). Posts synced in the last 30 seconds are left alone.
 */
router.post(
  '/refresh',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { pageId } = z.object({ pageId: z.string().uuid() }).parse(req.body ?? {});
    const userId = req.user!.id;
    const page = await ownPage(userId, pageId);
    if (page.tokenStatus !== 'VALID') {
      throw createError(409, 'Token của Page này chưa dùng được với Facebook App hiện tại nên chưa đọc được bình luận. Vào Kênh Facebook → Đồng bộ Page rồi thử lại.');
    }
    const now = Date.now();
    const targets = await prisma.postTarget.findMany({
      where: { ...published, pageId: page.id, post: { userId }, publishedAt: { gte: new Date(now - ENGAGEMENT_WINDOW_DAYS * 86_400_000) } },
      orderBy: { publishedAt: 'desc' },
      take: REFRESH_LIMIT,
      select: { id: true, statsSyncedAt: true },
    });
    if (!targets.length) throw createError(400, `Page chưa có bài nào được đăng trong ${ENGAGEMENT_WINDOW_DAYS} ngày gần đây.`);
    const due = targets.filter((t) => !t.statsSyncedAt || now - t.statsSyncedAt.getTime() >= REFRESH_WAIT_MS);
    if (!due.length) throw createError(429, 'Vừa làm mới xong, thử lại sau ít giây.');
    // AI drafts are not waited for here (one Gemini call per post with new comments): they show a few seconds later
    await syncTargets(due.map((t) => t.id), new Date(), { draftWaitMs: 0 });
    res.json({ success: true, data: { synced: due.length } });
  })
);

export default router;
