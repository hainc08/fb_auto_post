import prisma from '../utils/prisma';
import type { FacebookClient } from '../lib/clients/facebook';

/**
 * The domain's "bình luận đầu": the Page's first comment under its own post, posted once per Page target
 * right after the post is live. A failure never changes the target (the post is already published);
 * it is recorded so the member can post it again from the post page.
 */

export type FirstCommentResult = 'posted' | 'skipped' | 'already' | 'failed';

export async function postFirstComment(
  targetId: string,
  facebook: FacebookClient,
  pageToken: string,
  template: string | null
): Promise<FirstCommentResult> {
  const target = await prisma.postTarget.findUnique({ where: { id: targetId }, select: { fbPostId: true, firstCommentId: true } });
  if (!target?.fbPostId) return 'skipped';
  if (target.firstCommentId) return 'already';
  const text = (template ?? '').trim();
  if (!text) return 'skipped';

  // Claim before calling Facebook: a second run that finds the text already claimed does not post again
  const claimed = await prisma.postTarget.updateMany({
    where: { id: targetId, firstCommentId: null },
    data: { firstCommentText: text, firstCommentError: null },
  });
  if (!claimed.count) return 'already';

  try {
    const reply = await facebook.createComment(target.fbPostId, pageToken, text);
    await prisma.postTarget.update({ where: { id: targetId }, data: { firstCommentId: reply.id, firstCommentError: null } });
    return 'posted';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.postTarget.update({ where: { id: targetId }, data: { firstCommentError: message } });
    return 'failed';
  }
}
