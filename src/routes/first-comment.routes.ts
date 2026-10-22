import { Router, Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { getSettings, revealSecret } from '../lib/settings';
import { FacebookClient } from '../lib/clients/facebook';
import { postFirstComment } from '../services/first-comment';

/**
 * "Đăng lại bình luận đầu" (mounted at /api/posts): post the domain's first comment again on one Page
 * after an earlier failure. Only the post's owner; the Page must have published the post.
 */

const router = Router();
router.use(authenticate);

router.post(
  '/:id/targets/:targetId/first-comment',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const target = await prisma.postTarget.findFirst({
      where: { id: req.params.targetId, postId: req.params.id, post: { userId: req.user!.id } },
      include: { page: true, post: { select: { domainId: true } } },
    });
    if (!target) throw createError(404, 'Không tìm thấy Page của bài này.');
    if (target.status !== 'PUBLISHED' || !target.fbPostId) {
      throw createError(409, 'Bài chưa lên Page này nên chưa đăng được bình luận đầu.');
    }
    const domain = target.post.domainId
      ? await prisma.contentDomain.findFirst({ where: { id: target.post.domainId, userId: req.user!.id }, select: { firstCommentTemplate: true } })
      : null;
    if (!domain?.firstCommentTemplate?.trim()) throw createError(400, 'Lĩnh vực của bài chưa có mẫu bình luận đầu.');

    const settings = await getSettings(req.user!.id);
    const pageToken = revealSecret(target.page.pageAccessToken);
    const facebook = new FacebookClient({ appId: settings.fbAppId, appSecret: settings.fbAppSecret, graphVersion: settings.fbGraphVersion }, [pageToken]);
    const status = await postFirstComment(target.id, facebook, pageToken, domain.firstCommentTemplate);
    const after = await prisma.postTarget.findUniqueOrThrow({ where: { id: target.id }, select: { firstCommentError: true } });
    res.json({ success: true, data: { status, error: after.firstCommentError } });
  })
);

export default router;
