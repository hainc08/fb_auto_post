import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { getSettings, revealSecret } from '../lib/settings';
import { toStringArray } from '../utils/json';
import { COMMENT_READ_SCOPE, COMMENT_REPLY_SCOPE, FacebookApiError, FacebookClient } from '../lib/clients/facebook';
import { recountUnanswered, syncTargets } from '../services/engagement-sync';

/** Comments of a published post: read, reply as the Page, mark handled, refresh (mounted at /api/posts). */

const router = Router();
router.use(authenticate);

const REFRESH_WAIT_MS = 30_000;
const commentSelect = {
  id: true,
  fbCommentId: true,
  parentFbId: true,
  authorName: true,
  message: true,
  commentedAt: true,
  fromPage: true,
  pageReplied: true,
  handledAt: true,
} as const;

async function ownPost(req: AuthRequest) {
  const post = await prisma.post.findFirst({ where: { id: req.params.id, userId: req.user!.id }, select: { id: true } });
  if (!post) throw createError(404, 'Post not found');
  return post;
}

async function view(postId: string) {
  const targets = await prisma.postTarget.findMany({
    where: { postId, fbPostId: { not: null } },
    orderBy: { createdAt: 'asc' },
    include: {
      page: { select: { id: true, pageName: true, grantedScopes: true } },
      comments: { select: commentSelect, orderBy: { commentedAt: 'desc' } },
    },
  });
  return {
    pages: targets.map((t) => {
      const scopes = toStringArray(t.page.grantedScopes);
      const threads = t.comments
        .filter((c) => !c.parentFbId)
        .map((c) => ({
          ...c,
          needsReply: !c.fromPage && !c.pageReplied && !c.handledAt,
          replies: t.comments.filter((r) => r.parentFbId === c.fbCommentId).sort((a, b) => a.commentedAt.getTime() - b.commentedAt.getTime()),
        }))
        .sort((a, b) => Number(b.needsReply) - Number(a.needsReply) || b.commentedAt.getTime() - a.commentedAt.getTime());
      return {
        targetId: t.id,
        page: { id: t.page.id, pageName: t.page.pageName },
        canRead: scopes.includes(COMMENT_READ_SCOPE) && !t.commentsError,
        canReply: scopes.includes(COMMENT_REPLY_SCOPE),
        commentsError: t.commentsError,
        statsSyncedAt: t.statsSyncedAt,
        reactionCount: t.reactionCount,
        commentCount: t.commentCount,
        shareCount: t.shareCount,
        unansweredCount: t.unansweredCount,
        threads,
      };
    }),
  };
}

/** The comment must belong to this post, which belongs to the caller (404 otherwise) */
async function ownComment(req: AuthRequest) {
  const post = await ownPost(req);
  const comment = await prisma.postComment.findFirst({
    where: { id: req.params.commentId, target: { postId: post.id, post: { userId: req.user!.id } } },
    include: { target: { include: { page: true } } },
  });
  if (!comment) throw createError(404, 'Không tìm thấy bình luận.');
  return { post, comment };
}

router.get(
  '/:id/comments',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await ownPost(req);
    res.json({ success: true, data: await view(post.id) });
  })
);

router.post(
  '/:id/comments/refresh',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await ownPost(req);
    const targets = await prisma.postTarget.findMany({ where: { postId: post.id, fbPostId: { not: null } }, select: { id: true, statsSyncedAt: true } });
    if (!targets.length) throw createError(400, 'Bài chưa được đăng lên Page nào.');
    const recent = targets.every((t) => t.statsSyncedAt && Date.now() - t.statsSyncedAt.getTime() < REFRESH_WAIT_MS);
    if (recent) throw createError(429, 'Vừa làm mới xong, thử lại sau ít giây.');
    await syncTargets(targets.map((t) => t.id));
    res.json({ success: true, data: await view(post.id) });
  })
);

router.post(
  '/:id/comments/:commentId/reply',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { message } = z.object({ message: z.string().trim().min(1, 'Nhập nội dung trả lời').max(2000, 'Tối đa 2000 ký tự') }).parse(req.body);
    const { post, comment } = await ownComment(req);
    const page = comment.target.page;
    if (!toStringArray(page.grantedScopes).includes(COMMENT_REPLY_SCOPE)) {
      throw createError(409, 'Page chưa cấp quyền trả lời bình luận. Vào Kênh Facebook → Đồng bộ Page và tick quyền quản lý bình luận.');
    }
    const settings = await getSettings(req.user!.id);
    const token = revealSecret(page.pageAccessToken);
    const fb = new FacebookClient({ appId: settings.fbAppId, appSecret: settings.fbAppSecret, graphVersion: settings.fbGraphVersion }, [token]);
    let reply;
    try {
      reply = await fb.replyToComment(comment.fbCommentId, token, message);
    } catch (error) {
      // No clear answer (network drop, timeout): the reply may be live already
      if (!(error instanceof FacebookApiError)) {
        throw createError(502, 'Không chắc Facebook đã nhận câu trả lời. Hãy kiểm tra trên Facebook trước khi gửi lại.');
      }
      throw createError(502, `Facebook chưa nhận câu trả lời: ${error.message}`);
    }
    // A reply always answers the top-level comment of its thread
    const topFbId = comment.parentFbId ?? comment.fbCommentId;
    // upsert: the hourly sync may have stored this reply already (Facebook accepted it; never a 500 that invites a resend)
    const replyRow = {
      targetId: comment.targetId,
      parentFbId: topFbId,
      authorId: page.pageId,
      authorName: page.pageName.slice(0, 200),
      message,
      fromPage: true,
    };
    await prisma.postComment.upsert({
      where: { fbCommentId: reply.id },
      create: { ...replyRow, fbCommentId: reply.id, commentedAt: new Date() },
      update: replyRow,
    });
    await prisma.postComment.updateMany({ where: { fbCommentId: topFbId }, data: { pageReplied: true } });
    await recountUnanswered(comment.targetId);
    res.json({ success: true, data: await view(post.id) });
  })
);

router.patch(
  '/:id/comments/:commentId',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { handled } = z.object({ handled: z.boolean() }).parse(req.body);
    const { post, comment } = await ownComment(req);
    await prisma.postComment.update({ where: { id: comment.id }, data: { handledAt: handled ? new Date() : null } });
    await recountUnanswered(comment.targetId);
    res.json({ success: true, data: await view(post.id) });
  })
);

export default router;
