import prisma from '../utils/prisma';
import { toStringArray } from '../utils/json';
import { COMMENT_REPLY_SCOPE } from '../lib/clients/facebook';
import { holdReason, parseHoldKeywords } from '../lib/reply-hold';
import { isRefused, sendReply } from './comment-reply';

/**
 * "Tự gửi trả lời": on Pages that turned it on, the sync sends the AI drafts on its own, oldest comment first,
 * at most `autoSendPerHour` per Page per rolling hour, and only drafts written since it was turned on. A comment
 * with a link, a phone number or one of the domain's keywords keeps its draft for the member (`heldReason`), and
 * so does a draft Facebook refused or gave no clear answer for: nothing is ever sent twice on its own.
 */
export async function autoSendReplies(targetId: string, now = new Date()): Promise<number> {
  const target = await prisma.postTarget.findUnique({
    where: { id: targetId },
    include: { page: true, post: { select: { userId: true, autoReplyOff: true, domain: { select: { replyHoldKeywords: true } } } } },
  });
  if (!target || !target.page.autoReply || !target.page.autoSend || !target.page.autoSendSince || target.post.autoReplyOff) return 0;
  if (!toStringArray(target.page.grantedScopes).includes(COMMENT_REPLY_SCOPE)) return 0;

  const drafts = await prisma.postComment.findMany({
    where: {
      targetId,
      parentFbId: null,
      fromPage: false,
      pageReplied: false,
      handledAt: null,
      draftReply: { not: null },
      heldReason: null,
      // drafts the member had before turning it on (perhaps left unsent on purpose) stay theirs
      draftCheckedAt: { gte: target.page.autoSendSince },
    },
    include: { target: { include: { page: true } } },
    orderBy: { commentedAt: 'asc' },
  });
  if (!drafts.length) return 0;
  const keywords = parseHoldKeywords(target.post.domain?.replyHoldKeywords);
  const hourAgo = new Date(now.getTime() - 3_600_000);

  let sent = 0;
  for (const comment of drafts) {
    const reason = holdReason(comment.message, keywords);
    if (reason) {
      await prisma.postComment.updateMany({ where: { id: comment.id, heldReason: null }, data: { heldReason: reason } });
      continue;
    }
    // Counted again before each reply: the other posts of this Page send from the same hourly allowance
    const used = await prisma.postComment.count({ where: { autoSentAt: { gte: hourAgo }, target: { pageId: target.pageId } } });
    if (used >= target.page.autoSendPerHour) break; // the rest go out at a later sync
    const message = comment.draftReply!;
    // Take the draft first: a sync running at the same time (the member's "Làm mới") finds nothing left
    const { count } = await prisma.postComment.updateMany({
      where: { id: comment.id, draftReply: message, pageReplied: false, handledAt: null, heldReason: null },
      data: { draftReply: null, autoSentAt: now },
    });
    if (!count) continue;
    try {
      await sendReply(target.post.userId, comment, message);
      sent++;
    } catch (error) {
      const refused = isRefused(error);
      await prisma.postComment.updateMany({
        where: { id: comment.id, pageReplied: false },
        data: {
          draftReply: message,
          // surely not sent: not counted against the hour
          ...(refused && { autoSentAt: null }),
          heldReason: refused
            ? `Tự gửi không được: ${(error as Error).message}`.slice(0, 300)
            : 'Không chắc Facebook đã nhận câu trả lời tự gửi. Kiểm tra trên Facebook trước khi gửi lại.',
        },
      });
      break; // the Page's next replies would likely fail the same way
    }
  }
  return sent;
}
