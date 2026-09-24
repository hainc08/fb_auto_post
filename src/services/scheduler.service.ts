import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';
import { logger } from '../utils/logger';
import prisma from '../utils/prisma';
import { toStringArray } from '../utils/json';
import { getSettings, revealSecret } from '../lib/settings';
import { readImage, saveImage } from '../lib/image-store';
import { Prisma } from '@prisma/client';
import { generateFromIdea, generatePostContent } from './ai.service';
import { cloudflareConfigFrom, generateImage } from './image.service';
import * as facebookService from './facebook.service';
import { sendPostNotification } from './email.service';

/**
 * Scheduler Service - BullMQ Job Queue
 * Manages the auto-post pipeline execution
 */

// Redis connection for BullMQ
const connection = new IORedis({
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
 */
export function initPostWorker(): Worker {
  const worker = new Worker<PostPipelineJob>(
    'post-pipeline',
    async (job: Job<PostPipelineJob>) => {
      const { postId, userId, skipAiGeneration, skipImageGeneration } = job.data;
      logger.info(`[Pipeline] Starting post pipeline`, { postId, jobId: job.id });

      try {
        // ─── Step 1: Load post data ───────────────────
        await job.updateProgress(10);
        await logStep(postId, 'pipeline_started', { jobId: job.id });

        const post = await prisma.post.findUnique({
          where: { id: postId },
          include: {
            page: true,
            template: true,
            user: { select: { id: true, email: true, name: true } },
          },
        });

        if (!post) throw new Error(`Post ${postId} not found`);
        if (post.userId !== userId) throw new Error('Unauthorized');

        // Update status to GENERATING
        await prisma.post.update({
          where: { id: postId },
          data: { status: 'GENERATING' },
        });

        // ─── Step 2: AI Content Generation ────────────
        const variables = (post.inputData as Record<string, string>) || {};
        const idea = variables.basicInfo?.trim();

        if (!skipAiGeneration && (post.template || idea)) {
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
        await job.updateProgress(40);
        
        // Combine caption with hashtags and CTA
        let finalCaption = post.caption || '';
        
        const hashtags = toStringArray(post.hashtags);
        if (hashtags.length > 0) {
          const hashtagStr = hashtags.map((h) => 
            h.startsWith('#') ? h : `#${h}`
          ).join(' ');
          finalCaption += `\n\n${hashtagStr}`;
        }

        if (post.callToAction) {
          finalCaption += `\n\n👉 ${post.callToAction}`;
        }

        // ─── Step 4: Image (stored → publish as-is; else generate + store) ──
        let imageBuffer: Buffer | null = null;
        let imageMime = 'image/jpeg';

        const stored = post.imagePath ? await readImage(post.imagePath) : null;
        if (stored) {
          imageBuffer = stored.buffer;
          imageMime = stored.mime;
          await logStep(postId, 'image_reused', { imageSize: stored.buffer.length });
        } else if (!skipImageGeneration && post.imagePrompt) {
          await job.updateProgress(55);
          logger.info('[Pipeline] Generating image...', { postId });
          await logStep(postId, 'image_generation_started');

          const settings = await getSettings(userId);
          imageBuffer = await generateImage({
            cloudflare: cloudflareConfigFrom(settings),
            prompt: post.imagePrompt,
          });

          // Keep what we publish, so the app shows the same image
          const saved = await saveImage(postId, imageBuffer);
          imageMime = saved.mime;
          await prisma.post.update({ where: { id: postId }, data: { imagePath: saved.imagePath, imageUrl: saved.imageUrl } });

          await logStep(postId, 'image_generation_completed', {
            imageSize: imageBuffer.length,
          });
        }

        // ─── Step 5: Publish to Facebook ──────────────
        await job.updateProgress(75);
        logger.info('[Pipeline] Publishing to Facebook...', { postId, pageId: post.page.pageId });
        await logStep(postId, 'facebook_publish_started');

        // Update status to PUBLISHING
        await prisma.post.update({
          where: { id: postId },
          data: { status: 'PUBLISHING' },
        });

        let publishResult: facebookService.PublishResult;

        if (imageBuffer) {
          // Publish photo post (with image)
          publishResult = await facebookService.publishPhotoPost(
            post.page.pageId,
            revealSecret(post.page.pageAccessToken),
            imageBuffer,
            finalCaption,
            imageMime
          );
        } else {
          // Publish text-only post
          publishResult = await facebookService.publishTextPost(
            post.page.pageId,
            revealSecret(post.page.pageAccessToken),
            finalCaption
          );
        }

        // ─── Step 6: Update & Notify ──────────────────
        await job.updateProgress(90);

        // Update post as PUBLISHED
        const updatedPost = await prisma.post.update({
          where: { id: postId },
          data: {
            status: 'PUBLISHED',
            fbPostId: publishResult.postId,
            fbPermalink: publishResult.permalink,
            caption: finalCaption,
            publishedAt: new Date(),
          },
        });

        await logStep(postId, 'published', {
          fbPostId: publishResult.postId,
          permalink: publishResult.permalink,
        });

        // Send success notification email
        await sendPostNotification({
          to: post.user.email,
          userName: post.user.name,
          pageName: post.page.pageName,
          postCaption: finalCaption,
          status: 'success',
          permalink: publishResult.permalink,
          publishedAt: updatedPost.publishedAt!,
        });

        await job.updateProgress(100);
        logger.info('[Pipeline] Post published successfully!', {
          postId,
          fbPostId: publishResult.postId,
        });

        return { success: true, fbPostId: publishResult.postId };

      } catch (error) {
        const errorMessage = (error as Error).message;
        logger.error('[Pipeline] Post pipeline failed:', { postId, error: errorMessage });

        // Update post as FAILED
        await prisma.post.update({
          where: { id: postId },
          data: {
            status: 'FAILED',
            errorMessage,
          },
        });

        await logStep(postId, 'failed', { error: errorMessage });

        // Send failure notification
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
            errorMessage,
            publishedAt: new Date(),
          });
        }

        throw error;
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
