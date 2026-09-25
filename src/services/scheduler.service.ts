import { Queue, Worker, Job, UnrecoverableError } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';
import { logger } from '../utils/logger';
import prisma from '../utils/prisma';
import { toStringArray } from '../utils/json';
import { getSettings, revealSecret } from '../lib/settings';
import { readImage, saveImage } from '../lib/image-store';
import { composeMessage } from '../lib/format-post';
import { FacebookClient } from '../lib/clients/facebook';
import { classifyFailure } from '../lib/job-failure';
import { Prisma } from '@prisma/client';
import { generateFromIdea, generatePostContent } from './ai.service';
import { cloudflareConfigFrom, generateImage } from './image.service';
import { sendPostNotification } from './email.service';

/**
 * Scheduler Service - BullMQ Job Queue
 * Manages the auto-post pipeline execution
 */

// Redis connection for BullMQ
const connection = config.redis.url
  ? new IORedis(config.redis.url, { maxRetriesPerRequest: null })
  : new IORedis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      maxRetriesPerRequest: null,
    });

// ─── Queues ─────────────────────────────────────

export const postQueue = new Queue('post-pipeline', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

export const scheduleQueue = new Queue('post-schedule', {
  connection,
  defaultJobOptions: {
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  },
});

// ─── Job Types ──────────────────────────────────

export interface PostPipelineJob {
  postId: string;
  userId: string;
  skipAiGeneration?: boolean;
  skipImageGeneration?: boolean;
}

export interface ScheduleCheckJob {
  scheduleId: string;
}

// ─── Pipeline Worker ────────────────────────────

/**
 * Initialize the post pipeline worker
 * This is the core auto-post pipeline that mirrors the n8n workflow:
 *
 * 1. Load post & template data (= "Get rows in sheet")
 * 2. Generate content with AI (= "Basic LLM Chain" + "Structured Output Parser")
 * 3. Edit/format fields (= "Edit Fields")
 * 4. Generate image (= "HTTP Request to Cloudflare" + "Convert to Image")
 * 5. Publish to Facebook (= "Facebook Graph API" + "HTTP Request")
 * 6. Check result & notify (= "If" + "Send a message")
 *
 * Retry rules: a post that already has fbPostId is never published again, and
 * the post is only marked FAILED (and the user emailed) once no retry is left.
 */
export function initPostWorker(): Worker {
  const worker = new Worker<PostPipelineJob>(
    'post-pipeline',
    async (job: Job<PostPipelineJob>) => {
      const { postId, userId, skipAiGeneration, skipImageGeneration } = job.data;
      const attempt = job.attemptsMade + 1;
      const maxAttempts = job.opts.attempts ?? 1;
      let step = 'load_post';
      logger.info(`[Pipeline] Starting post pipeline`, { postId, jobId: job.id, attempt });

      try {
        // ─── Step 1: Load post data ───────────────────
        await job.updateProgress(10);

        const post = await prisma.post.findUnique({
          where: { id: postId },
          include: {
            page: true,
            template: true,
            user: { select: { id: true, email: true, name: true } },
          },
        });

        // Deleted while queued (e.g. a scheduled post) — nothing to do
        if (!post) {
          logger.warn('[Pipeline] Post no longer exists, skipping', { postId });
          return { skipped: 'deleted' };
        }
        if (post.userId !== userId) throw new UnrecoverableError('Unauthorized');
        // Already on Facebook (published by another job or an earlier attempt)
        if (post.status === 'PUBLISHED' || post.fbPostId) {
          logger.warn('[Pipeline] Post already published, skipping', { postId, fbPostId: post.fbPostId });
          return { skipped: 'already_published', fbPostId: post.fbPostId };
        }

        await logStep(postId, 'pipeline_started', { jobId: job.id ?? null, attempt });
        await prisma.post.update({
          where: { id: postId },
          data: { status: 'GENERATING' },
        });

        // ─── Step 2: AI Content Generation ────────────
        const variables = (post.inputData as Record<string, string>) || {};
        const idea = variables.basicInfo?.trim();

        if (!skipAiGeneration && !post.caption && (post.template || idea)) {
          step = 'generate_content';
          await job.updateProgress(25);
          logger.info('[Pipeline] Generating AI content...', { postId });
          await logStep(postId, 'ai_generation_started');

          const settings = await getSettings(userId);
          const gemini = { apiKey: settings.geminiApiKey, model: settings.geminiModel };
          // Template (legacy) or the idea written with the Settings system prompt
          const generated = post.template
            ? await generatePostContent({ gemini, templatePrompt: post.template.promptTemplate, variables })
            : await generateFromIdea({ gemini, systemPrompt: settings.systemPrompt, idea: idea! });

          // Update post with generated content
          await prisma.post.update({
            where: { id: postId },
            data: {
              caption: generated.caption,
              hashtags: generated.hashtags,
              imagePrompt: generated.imagePrompt,
              callToAction: generated.callToAction,
              aiResponse: JSON.stringify(generated),
            },
          });

          await logStep(postId, 'ai_generation_completed', {
            captionLength: generated.caption.length,
            hashtagCount: generated.hashtags.length,
          });

          // Reload post with updated data
          Object.assign(post, {
            caption: generated.caption,
            hashtags: generated.hashtags,
            imagePrompt: generated.imagePrompt,
            callToAction: generated.callToAction,
          });
        }

        // ─── Step 3: Edit/Format Fields ───────────────
        // Built from the stored fields every time; `caption` itself is never modified
        step = 'compose_fields';
        await job.updateProgress(40);
        const finalMessage = composeMessage(post.caption, toStringArray(post.hashtags), post.callToAction);

        // ─── Step 4: Image (stored → publish as-is; else generate + store) ──
        let image: { buffer: Buffer; mime: string } | null = null;

        const stored = post.imagePath ? await readImage(post.imagePath) : null;
        if (stored) {
          image = stored;
          await logStep(postId, 'image_reused', { imageSize: stored.buffer.length });
        } else if (!skipImageGeneration && post.imagePrompt) {
          step = 'generate_image';
          await job.updateProgress(55);
          logger.info('[Pipeline] Generating image...', { postId });
          await logStep(postId, 'image_generation_started');

          const settings = await getSettings(userId);
          const buffer = await generateImage({
            cloudflare: cloudflareConfigFrom(settings),
            prompt: post.imagePrompt,
          });

          // Keep what we publish, so the app shows the same image
          step = 'save_image';
          const saved = await saveImage(postId, buffer);
          image = { buffer, mime: saved.mime };
          await prisma.post.update({ where: { id: postId }, data: { imagePath: saved.imagePath, imageUrl: saved.imageUrl } });

          await logStep(postId, 'image_generation_completed', {
            imageSize: buffer.length,
          });
        }

        if (!finalMessage && !image) {
          throw new UnrecoverableError('Bài chưa có nội dung hoặc ảnh để đăng.');
        }

        // ─── Step 5: Publish to Facebook ──────────────
        step = 'publish_facebook';
        await job.updateProgress(75);
        logger.info('[Pipeline] Publishing to Facebook...', { postId, pageId: post.page.pageId });
        await logStep(postId, 'facebook_publish_started');

        await prisma.post.update({
          where: { id: postId },
          data: { status: 'PUBLISHING' },
        });

        const settings = await getSettings(userId);
        const pageToken = revealSecret(post.page.pageAccessToken);
        const facebook = new FacebookClient(
          { appId: settings.fbAppId, appSecret: settings.fbAppSecret, graphVersion: settings.fbGraphVersion },
          [pageToken]
        );

        const published = image
          ? await facebook.publishPhoto(post.page.pageId, pageToken, image, finalMessage)
          : await facebook.publishText(post.page.pageId, pageToken, finalMessage);

        // Record the Facebook id right away: from here on, a retry must never publish again
        const updatedPost = await prisma.post.update({
          where: { id: postId },
          data: {
            status: 'PUBLISHED',
            fbPostId: published.postId,
            fbPhotoId: published.photoId,
            message: finalMessage,
            publishedAt: new Date(),
            errorMessage: null,
            errorStep: null,
            errorCode: null,
          },
        });

        // ─── Step 6: Update & Notify ──────────────────
        step = 'check_result';
        await job.updateProgress(90);

        const permalink = await facebook.getPermalink(published.postId, pageToken);
        if (permalink) {
          await prisma.post.update({ where: { id: postId }, data: { fbPermalink: permalink } });
        }

        await logStep(postId, 'published', {
          fbPostId: published.postId,
          permalink: permalink ?? null,
        });

        // Send success notification email
        await sendPostNotification({
          to: post.user.email,
          userName: post.user.name,
          pageName: post.page.pageName,
          postCaption: finalMessage,
          status: 'success',
          permalink,
          publishedAt: updatedPost.publishedAt!,
        });

        await job.updateProgress(100);
        logger.info('[Pipeline] Post published successfully!', {
          postId,
          fbPostId: published.postId,
        });

        return { success: true, fbPostId: published.postId };

      } catch (error) {
        const failure = classifyFailure(error, step);
        const isFinal = !failure.retryable || attempt >= maxAttempts;
        logger.error('[Pipeline] Post pipeline failed:', { postId, step, attempt, final: isFinal, error: failure.message });

        if (!isFinal) {
          // BullMQ will retry; the post keeps its in-progress status meanwhile
          await logStep(postId, 'attempt_failed', { step, attempt, error: failure.message }).catch(() => {});
          throw error;
        }

        // updateMany: no throw if the post was deleted mid-run
        await prisma.post.updateMany({
          where: { id: postId },
          data: {
            status: 'FAILED',
            errorMessage: failure.message,
            errorStep: step,
            errorCode: failure.code ?? null,
          },
        });
        await logStep(postId, 'failed', { step, attempt, error: failure.message }).catch(() => {});

        // Send failure notification (once, on the final attempt)
        const post = await prisma.post.findUnique({
          where: { id: postId },
          include: {
            page: true,
            user: { select: { email: true, name: true } },
          },
        });

        if (post) {
          await sendPostNotification({
            to: post.user.email,
            userName: post.user.name,
            pageName: post.page.pageName,
            postCaption: post.caption || '(No caption)',
            status: 'failed',
            errorMessage: failure.message,
            publishedAt: new Date(),
          });
        }

        throw failure.retryable ? error : new UnrecoverableError(failure.message);
      }
    },
    {
      connection,
      concurrency: 5,
      limiter: {
        max: 10,
        duration: 60000, // Max 10 jobs per minute
      },
    }
  );

  worker.on('completed', (job) => {
    logger.info(`[Worker] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`[Worker] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

// ─── Schedule Worker ────────────────────────────

/**
 * Initialize the schedule checker worker
 * Runs periodically to check and execute scheduled posts
 */
export function initScheduleWorker(): Worker {
  const worker = new Worker<ScheduleCheckJob>(
    'post-schedule',
    async (job: Job<ScheduleCheckJob>) => {
      const { scheduleId } = job.data;

      const schedule = await prisma.postSchedule.findUnique({
        where: { id: scheduleId },
        include: {
          page: true,
          user: { select: { id: true, email: true, plan: true } },
        },
      });

      if (!schedule || !schedule.isActive) return;

      logger.info('[Scheduler] Processing schedule', { scheduleId, name: schedule.name });

      // Create a new post from the schedule
      const post = await prisma.post.create({
        data: {
          userId: schedule.userId,
          pageId: schedule.pageId,
          templateId: schedule.templateId,
          inputData: schedule.inputData || undefined,
          status: 'DRAFT',
          scheduledAt: new Date(),
        },
      });

      // Enqueue the post pipeline
      await postQueue.add('auto-post', {
        postId: post.id,
        userId: schedule.userId,
      });

      // Update schedule tracking
      await prisma.postSchedule.update({
        where: { id: scheduleId },
        data: {
          lastRunAt: new Date(),
          totalRuns: { increment: 1 },
        },
      });
    },
    { connection, concurrency: 3 }
  );

  return worker;
}

// ─── Queue Helpers ──────────────────────────────

/**
 * Add a post to the publishing pipeline
 */
export async function enqueuePost(
  postId: string,
  userId: string,
  options?: { delay?: number; skipAi?: boolean; skipImage?: boolean }
): Promise<string> {
  const job = await postQueue.add(
    'publish-post',
    {
      postId,
      userId,
      skipAiGeneration: options?.skipAi,
      skipImageGeneration: options?.skipImage,
    },
    {
      delay: options?.delay,
      jobId: `post-${postId}-${Date.now()}`,
    }
  );

  return job.id!;
}

/**
 * Add a repeatable schedule job
 */
export async function addScheduleJob(
  scheduleId: string,
  cronExpr: string,
  timezone: string = 'Asia/Ho_Chi_Minh'
): Promise<void> {
  await scheduleQueue.add(
    'check-schedule',
    { scheduleId },
    {
      repeat: {
        pattern: cronExpr,
        tz: timezone,
      },
      jobId: `schedule-${scheduleId}`,
    }
  );

  logger.info('[Scheduler] Schedule job added', { scheduleId, cronExpr, timezone });
}

/**
 * Remove a repeatable schedule job
 */
export async function removeScheduleJob(scheduleId: string): Promise<void> {
  const repeatableJobs = await scheduleQueue.getRepeatableJobs();
  for (const job of repeatableJobs) {
    if (job.id === `schedule-${scheduleId}`) {
      await scheduleQueue.removeRepeatableByKey(job.key);
      break;
    }
  }
  logger.info('[Scheduler] Schedule job removed', { scheduleId });
}

// ─── Utilities ──────────────────────────────────

async function logStep(postId: string, action: string, details?: Prisma.InputJsonObject) {
  await prisma.postLog.create({
    data: {
      postId,
      action,
      details: details || undefined,
    },
  });
}
