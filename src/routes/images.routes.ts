import { Router, Request, Response } from 'express';
import prisma from '../utils/prisma';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { readImage } from '../lib/image-store';

/**
 * Serves post images from storage/images (not a public folder).
 * <img> tags cannot send auth headers; when auth is re-enabled this should move
 * to signed URLs. URLs carry ?v=<version>, so they can be cached for long.
 */
const router = Router();

router.get(
  '/:postId',
  asyncHandler(async (req: Request, res: Response) => {
    const post = await prisma.post.findUnique({
      where: { id: req.params.postId },
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
