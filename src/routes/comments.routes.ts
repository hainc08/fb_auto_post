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
const SEND_BATCH = 20;
/** "Làm mới" answers after this long even if the AI is still writing drafts (they show at the next look) */
const REFRESH_DRAFT_WAIT_MS = 15_000;
/** Facebook clearly did not take the reply (as opposed to: no clear answer, it may be live) */
const REFUSED = { code: 'REPLY_REFUSED' } as const;
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
  draftReply: true,
} as const;

async function ownPost(req: AuthRequest) {
  const post = await prisma.post.findFirst({ where: { id: req.params.id, userId: req.user!.id }, select: { id: true } });
  if (!post) throw createError(404, 'Post not found');
  return post;
}

async function view(postId: string) {
  const [post, targets] = await Promise.all([
    prisma.post.findUniqueOrThrow({ where: { id: postId }, select: { autoReplyOff: true } }),
    prisma.postTarget.findMany({
      where: { postId, fbPostId: { not: null } },
      orderBy: { createdAt: 'asc' },
      include: {
        page: { select: { id: true, pageName: true, grantedScopes: true, autoReply: true } },
        comments: { select: commentSelect, orderBy: { commentedAt: 'desc' } },
      },
    }),
  ]);
  return {
    /** This post is left out of its Pages' AI reply drafts */
    autoReplyOff: post.autoReplyOff,
    pages: targets.map((t) => {
      const scopes = toStringArray(t.page.grantedScopes);
      const threads = t.comments
        .filter((c) => !c.parentFbId)
        .map((c) => {
          const needsReply = !c.fromPage && !c.pageReplied && !c.handledAt;
          return {
            ...c,
            needsReply,
            // a draft is only offered while the comment still waits
            draftReply: needsReply ? c.draftReply : null,
            replies: t.comments.filter((r) => r.parentFbId === c.fbCommentId).sort((a, b) => a.commentedAt.getTime() - b.commentedAt.getTime()),
          };
        })
        .sort((a, b) => Number(b.needsReply) - Number(a.needsReply) || b.commentedAt.getTime() - a.commentedAt.getTime());
      return {
        targetId: t.id,
        page: { id: t.page.id, pageName: t.page.pageName },
        canRead: scopes.includes(COMMENT_READ_SCOPE) && !t.commentsError,
        canReply: scopes.includes(COMMENT_REPLY_SCOPE),
        /** "AI soạn trả lời bình luận" is on for this Page */
        autoReply: t.page.autoReply,
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

type OwnedComment = Awaited<ReturnType<typeof ownComment>>['comment'];

/**
 * Post `message` as the Page under the comment and record it. Throws (409 no permission, 502 Facebook
 * refused or gave no clear answer); the caller decides what that means for a draft.
 */
async function sendReply(userId: string, comment: OwnedComment, message: string): Promise<void> {
  const page = comment.target.page;
  if (!toStringArray(page.grantedScopes).includes(COMMENT_REPLY_SCOPE)) {
    throw createError(409, 'Page chưa cấp quyền trả lời bình luận. Vào Kênh Facebook → Đồng bộ Page và tick quyền quản lý bình luận.', REFUSED);
  }
  const settings = await getSettings(userId);
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
    throw createError(502, `Facebook chưa nhận câu trả lời: ${error.message}`, REFUSED);
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
  // answered: its draft (used, edited or ignored) is done with
  await prisma.postComment.updateMany({ where: { fbCommentId: topFbId }, data: { pageReplied: true, draftReply: null } });
  await recountUnanswered(comment.targetId);
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
    await syncTargets(targets.map((t) => t.id), new Date(), { draftWaitMs: REFRESH_DRAFT_WAIT_MS });
    res.json({ success: true, data: await view(post.id) });
  })
);

router.post(
  '/:id/comments/:commentId/reply',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { message } = z.object({ message: z.string().trim().min(1, 'Nhập nội dung trả lời').max(2000, 'Tối đa 2000 ký tự') }).parse(req.body);
    const { post, comment } = await ownComment(req);
    await sendReply(req.user!.id, comment, message);
    res.json({ success: true, data: await view(post.id) });
  })
);

/** Leave this post out of (or back in) its Pages' AI reply drafts. Drafts already written stay until sent or discarded. */
router.patch(
  '/:id/comments/auto-reply',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { off } = z.object({ off: z.boolean() }).parse(req.body);
    const post = await ownPost(req);
    await prisma.post.update({ where: { id: post.id }, data: { autoReplyOff: off } });
    res.json({ success: true, data: await view(post.id) });
  })
);

const sendDraftsSchema = z.object({
  drafts: z
    .array(z.object({ commentId: z.string().uuid(), reply: z.string().min(1).max(2000) }))
    .min(1, 'Không có gợi ý nào để gửi.')
    .max(SEND_BATCH, `Mỗi lần gửi tối đa ${SEND_BATCH} gợi ý.`),
});

/**
 * "Gửi N gợi ý": post the AI drafts the member was shown (`drafts`: comment + the text as shown), oldest comment
 * first. A draft that changed since, or that the member never saw, is not sent. Stops at the first failure
 * (the answer says how many went out and why it stopped).
 */
router.post(
  '/:id/comments/send-drafts',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await ownPost(req);
    const shown = new Map(sendDraftsSchema.parse(req.body ?? {}).drafts.map((d) => [d.commentId, d.reply]));
    const waiting = await prisma.postComment.findMany({
      where: { id: { in: [...shown.keys()] }, target: { postId: post.id }, parentFbId: null, fromPage: false, pageReplied: false, handledAt: null, draftReply: { not: null } },
      include: { target: { include: { page: true } } },
      orderBy: { commentedAt: 'asc' },
    });
    let sent = 0;
    let failed: string | null = null;
    /** A reply Facebook may or may not have taken: handed back as text, no longer a draft */
    let uncertain: { commentId: string; reply: string } | null = null;
    for (const comment of waiting) {
      const message = shown.get(comment.id)!;
      // A Page that may no longer answer: its drafts are passed over, the post's other Pages still get theirs
      if (!toStringArray(comment.target.page.grantedScopes).includes(COMMENT_REPLY_SCOPE)) continue;
      // Take the draft first, and only while it still reads as the member saw it: a second click or another tab finds nothing left
      const { count } = await prisma.postComment.updateMany({
        where: { id: comment.id, draftReply: message, pageReplied: false, handledAt: null },
        data: { draftReply: null },
      });
      if (!count) continue;
      try {
        await sendReply(req.user!.id, comment, message);
        sent++;
      } catch (error) {
        failed = (error as Error).message;
        if ((error as { details?: { code?: string } }).details?.code === REFUSED.code) {
          // surely not sent: the draft goes back
          await prisma.postComment.updateMany({ where: { id: comment.id, pageReplied: false }, data: { draftReply: message } });
        } else {
          // No clear answer: the reply may be live. It must not be a draft the next "send all" posts again;
          // the member gets the text back in the reply box, to send by hand after a look at Facebook.
          uncertain = { commentId: comment.id, reply: message };
        }
        break;
      }
    }
    res.json({ success: true, data: { ...(await view(post.id)), sent, failed, uncertain } });
  })
);

/** "Bỏ gợi ý": drop the AI draft of one comment (the AI is not asked about that comment again). */
router.delete(
  '/:id/comments/:commentId/draft',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { post, comment } = await ownComment(req);
    await prisma.postComment.update({ where: { id: comment.id }, data: { draftReply: null } });
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
