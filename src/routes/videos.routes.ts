import { Router, Response, NextFunction } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { resolveVideo } from '../lib/video-store';

/** Post videos for the owner's browser preview (sendFile handles Range, for seeking); `?download=1` saves the file instead. */
const router = Router();
router.use(authenticate);

router.get(
  '/:postId',
  asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
    const post = await prisma.post.findFirst({
      where: { id: req.params.postId, userId: req.user!.id },
      select: { id: true, videoPath: true, videoMime: true, videoKind: true },
    });
    const full = post?.videoPath ? resolveVideo(post.videoPath) : null;
    if (!full) throw createError(404, 'Video not found');
    const mime = post!.videoMime ?? 'video/mp4';
    const fileName = `${post!.videoKind === 'REEL' ? 'reel' : 'video'}-${post!.id.slice(0, 8)}.${mime === 'video/quicktime' ? 'mov' : 'mp4'}`;
    res.sendFile(
      full,
      {
        headers: {
          'Content-Type': mime,
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          ...(req.query.download === '1' && { 'Content-Disposition': `attachment; filename="${fileName}"` }),
        },
      },
      (err) => {
        if (err && !res.headersSent) next(createError(404, 'Video not found'));
      }
    );
  })
);

export default router;
