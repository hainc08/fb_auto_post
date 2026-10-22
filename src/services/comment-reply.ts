import { Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { createError } from '../middleware/error.middleware';
import { getSettings, revealSecret } from '../lib/settings';
import { toStringArray } from '../utils/json';
import { COMMENT_REPLY_SCOPE, FacebookApiError, FacebookClient } from '../lib/clients/facebook';
import { recountUnanswered } from './engagement-sync';

/** Facebook clearly did not take the reply (as opposed to: no clear answer, it may be live) */
export const REFUSED = { code: 'REPLY_REFUSED' } as const;

export const isRefused = (error: unknown) => (error as { details?: { code?: string } }).details?.code === REFUSED.code;

export type ReplyTarget = Prisma.PostCommentGetPayload<{ include: { target: { include: { page: true } } } }>;

/**
 * Post `message` as the Page under the comment and record it. Throws (409 no permission, 502 Facebook
 * refused or gave no clear answer); the caller decides what that means for a draft.
 */
export async function sendReply(userId: string, comment: ReplyTarget, message: string): Promise<void> {
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
