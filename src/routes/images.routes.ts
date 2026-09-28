import { Router, Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { readImage } from '../lib/image-store';

/**
 * Post images from storage/images (not public): the session cookie travels with
 * <img> requests, so only the post's owner can load it. URLs carry ?v=<version>.
 */
const router = Router();
router.use(authenticate);

router.get(
  '/:postId',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await prisma.post.findFirst({
      where: { id: req.params.postId, userId: req.user!.id },
      select: { imagePath: true },
    });
    if (!post?.imagePath) throw createError(404, 'Image not found');

    const image = await readImage(post.imagePath);
    if (!image) throw createError(404, 'Image not found');

    res.setHeader('Content-Type', image.mime);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(image.buffer);
  })
);

export default router;
