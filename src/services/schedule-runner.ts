import type { Job, Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { logger } from '../utils/logger';
import { getSettings } from '../lib/settings';
import { saveImage } from '../lib/image-store';
import { styledImagePrompt } from '../lib/compose-prompt';
import { classifyFailure } from '../lib/job-failure';
import { UnrecoverableJobError } from '../lib/job-queue';
import { imageStyleOf, writePost } from './post-writer';
import { cloudflareConfigFrom, generateImage } from './image.service';

/**
 * Slot schedules (Phase 2): posts written ahead by AI, approved by the user,
 * published in their slot. See docs/superpowers/plans/2026-09-30-schedule-slots.md.
 */

async function log(postId: string, action: string, details?: Prisma.InputJsonObject) {
  await prisma.postLog.create({ data: { postId, action, details } }).catch(() => {});
}

/** prepare_post: AI writes a schedule post (text, then the image if the format has one) → READY. */
export async function runPrepareJob(job: Job): Promise<void> {
  const { postId } = job.payload as { postId: string };
  const isLastAttempt = job.attempts >= job.maxAttempts;

  // Only a post nobody wrote yet (the user may have written or deleted it meanwhile)
  const { count } = await prisma.post.updateMany({
    where: { id: postId, caption: null, status: { in: ['DRAFT', 'FAILED'] } },
    data: { status: 'GENERATING', errorMessage: null },
  });
  if (count === 0) return;
  const post = await prisma.post.findUniqueOrThrow({ where: { id: postId }, include: { template: true } });

  let imagePrompt: string;
  try {
    const settings = await getSettings(post.userId);
    const { generated, aiPrompt, domainId, formatId } = await writePost(post, settings);
    imagePrompt = generated.imagePrompt;
    await prisma.post.update({
      where: { id: postId },
      data: {
        caption: generated.caption,
        hashtags: generated.hashtags,
        imagePrompt: generated.imagePrompt || null,
        callToAction: generated.callToAction,
        aiResponse: JSON.stringify(generated),
        aiPrompt,
        ...(formatId && { domainId, formatId }),
      },
    });
    await log(postId, 'ai_generation_completed', { captionLength: generated.caption.length });
  } catch (error) {
    const failure = classifyFailure(error, 'generate_content');
    const final = !failure.retryable || isLastAttempt;
    await prisma.post.updateMany({
      where: { id: postId },
      data: final
        ? { status: 'FAILED', errorMessage: `AI chưa viết được bài: ${failure.message}`, errorStep: 'generate_content' }
        : { status: 'DRAFT' },
    });
    logger.error('[Schedules] Writing a schedule post failed', { postId, final, error: failure.message });
    if (final) throw new UnrecoverableJobError(failure.message);
    throw error;
  }

  // The image never blocks the post: without it the user can still add one before approving
  if (imagePrompt) {
    try {
      const settings = await getSettings(post.userId);
      const buffer = await generateImage({
        cloudflare: cloudflareConfigFrom(settings),
        prompt: styledImagePrompt(await imageStyleOf(post.domainId), imagePrompt),
      });
      const saved = await saveImage(postId, buffer);
      await prisma.post.update({ where: { id: postId }, data: { imagePath: saved.imagePath, imageUrl: saved.imageUrl } });
    } catch (error) {
      await log(postId, 'image_failed', { error: (error as Error).message });
    }
  }

  await prisma.post.updateMany({ where: { id: postId, status: 'GENERATING' }, data: { status: 'READY' } });
}
