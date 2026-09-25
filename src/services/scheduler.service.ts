import { Job, Prisma } from '@prisma/client';
import { logger } from '../utils/logger';
import prisma from '../utils/prisma';
import { toStringArray } from '../utils/json';
import { getSettings, revealSecret } from '../lib/settings';
import { readImage, saveImage } from '../lib/image-store';
import { composeMessage } from '../lib/format-post';
import { FacebookClient } from '../lib/clients/facebook';
import { classifyFailure, UNCERTAIN_PUBLISH_MESSAGE } from '../lib/job-failure';
import { enqueue, removeKeyedJob, startJobWorker, UnrecoverableJobError, upsertKeyedJob, JobResult } from '../lib/job-queue';
import { Frequency, nextRunAt } from '../lib/schedule-time';
import { generateFromIdea, generatePostContent } from './ai.service';
import { cloudflareConfigFrom, generateImage } from './image.service';
import { sendPostNotification } from './email.service';

/**
 * Scheduler Service - background work on the MariaDB job queue (src/lib/job-queue.ts)
 *
 * - publish_post: the auto-post pipeline for one post
 * - run_schedule: one keyed job per active schedule, rescheduled after each run
 */

// ─── Job Payloads ───────────────────────────────

export interface PostPipelineJob {
  postId: string;
  userId: string;
  skipAiGeneration?: boolean;
  skipImageGeneration?: boolean;
}

export interface ScheduleCheckJob {
  scheduleId: string;
}

const scheduleKey = (scheduleId: string) => `schedule:${scheduleId}`;

// ─── Publish Pipeline ───────────────────────────

/**
 * The core auto-post pipeline that mirrors the n8n workflow:
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
async function runPublishJob(job: Job): Promise<void> {
  const { postId, userId, skipAiGeneration, skipImageGeneration } = job.payload as unknown as PostPipelineJob;
  const attempt = job.attempts;
  const maxAttempts = job.maxAttempts;
  let step = 'load_post';
  logger.info(`[Pipeline] Starting post pipeline`, { postId, jobId: job.id, attempt });

  try {
    // ─── Step 1: Load post data ───────────────────
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
      return;
    }
    if (post.userId !== userId) throw new UnrecoverableJobError('Unauthorized');
    // Already on Facebook (published by another job or an earlier attempt)
    if (post.status === 'PUBLISHED' || post.fbPostId) {
      logger.warn('[Pipeline] Post already published, skipping', { postId, fbPostId: post.fbPostId });
      return;
    }
    // The process died while this post was being sent: Facebook may have it already
    if (job.interrupted && post.status === 'PUBLISHING') {
      step = 'publish_facebook';
      throw new UnrecoverableJobError(UNCERTAIN_PUBLISH_MESSAGE);
    }

    await logStep(postId, 'pipeline_started', { jobId: job.id, attempt });
    await prisma.post.update({
      where: { id: postId },
      data: { status: 'GENERATING' },
    });

    // ─── Step 2: AI Content Generation ────────────
    const variables = (post.inputData as Record<string, string>) || {};
    const idea = variables.basicInfo?.trim();

    if (!skipAiGeneration && !post.caption && (post.template || idea)) {
      step = 'generate_content';
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
    const finalMessage = composeMessage(post.caption, toStringArray(post.hashtags), post.callToAction);

    // ─── Step 4: Image (stored → publish as-is; else generate + store) ──
    let image: { buffer: Buffer; mime: string } | null = null;

    const stored = post.imagePath ? await readImage(post.imagePath) : null;
    if (stored) {
      image = stored;
      await logStep(postId, 'image_reused', { imageSize: stored.buffer.length });
    } else if (!skipImageGeneration && post.imagePrompt) {
      step = 'generate_image';
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
      throw new UnrecoverableJobError('Bài chưa có nội dung hoặc ảnh để đăng.');
    }

    // ─── Step 5: Publish to Facebook ──────────────
    step = 'publish_facebook';
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

    logger.info('[Pipeline] Post published successfully!', {
      postId,
      fbPostId: published.postId,
    });
  } catch (error) {
    const failure = classifyFailure(error, step);
    const isFinal = !failure.retryable || attempt >= maxAttempts;
    logger.error('[Pipeline] Post pipeline failed:', { postId, step, attempt, final: isFinal, error: failure.message });

    if (!isFinal) {
      // The queue will retry; the post keeps its in-progress status meanwhile
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

    throw new UnrecoverableJobError(failure.message);
  }
}

// ─── Schedules ──────────────────────────────────

/**
 * One run of a schedule: create a post and queue it, then book the next run.
 * Errors never stop the schedule: they are logged and the next run is still booked.
 */
async function runScheduleJob(job: Job): Promise<JobResult | void> {
  const { scheduleId } = job.payload as unknown as ScheduleCheckJob;

  const schedule = await prisma.postSchedule.findUnique({ where: { id: scheduleId } });
  if (!schedule || !schedule.isActive) return;

  logger.info('[Scheduler] Processing schedule', { scheduleId, name: schedule.name });

  try {
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
    await enqueuePost(post.id, schedule.userId);
  } catch (error) {
    logger.error('[Scheduler] Schedule run failed', { scheduleId, error: (error as Error).message });
  }

  const now = new Date();
  const next = nextRunAt(
    { frequency: schedule.frequency as Frequency, startDate: schedule.startDate, endDate: schedule.endDate, timezone: schedule.timezone },
    now
  );

  await prisma.postSchedule.update({
    where: { id: scheduleId },
    data: {
      lastRunAt: now,
      totalRuns: { increment: 1 },
      nextRunAt: next,
      // Nothing left to run (ONCE done, or past endDate)
      ...(next ? {} : { isActive: false }),
    },
  });

  return next ? { rescheduleAt: next } : undefined;
}

// ─── Worker ─────────────────────────────────────

/** Start processing queued jobs in this process. Returns a stop function. */
export function startWorkers(): () => void {
  void bookMissingScheduleJobs();
  return startJobWorker({ publish_post: runPublishJob, run_schedule: runScheduleJob });
}

/**
 * Active schedules without a queued run (e.g. created while jobs lived in Redis)
 * get their next run booked at startup.
 */
async function bookMissingScheduleJobs(): Promise<void> {
  try {
    const schedules = await prisma.postSchedule.findMany({ where: { isActive: true } });
    const booked = new Set(
      (await prisma.job.findMany({ where: { key: { in: schedules.map((s) => scheduleKey(s.id)) } }, select: { key: true } })).map(
        (j) => j.key
      )
    );
    for (const schedule of schedules) {
      if (!booked.has(scheduleKey(schedule.id))) await syncScheduleJob(schedule);
    }
  } catch (error) {
    logger.error('[Scheduler] Could not book schedule runs at startup', { error: (error as Error).message });
  }
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
  const payload: PostPipelineJob = {
    postId,
    userId,
    ...(options?.skipAi !== undefined && { skipAiGeneration: options.skipAi }),
    ...(options?.skipImage !== undefined && { skipImageGeneration: options.skipImage }),
  };
  const job = await enqueue('publish_post', { ...payload }, { runAt: new Date(Date.now() + (options?.delay ?? 0)) });
  return job.id;
}

/**
 * Book (or move) the next run of a schedule. Returns the run time, or null
 * when the schedule has no run left — then any pending run is removed.
 */
export async function syncScheduleJob(schedule: {
  id: string;
  isActive: boolean;
  frequency: string;
  startDate: Date;
  endDate: Date | null;
  timezone: string;
}): Promise<Date | null> {
  const next = schedule.isActive
    ? nextRunAt(
        { frequency: schedule.frequency as Frequency, startDate: schedule.startDate, endDate: schedule.endDate, timezone: schedule.timezone },
        new Date()
      )
    : null;

  if (next) {
    await upsertKeyedJob(scheduleKey(schedule.id), 'run_schedule', { scheduleId: schedule.id }, next);
  } else {
    await removeKeyedJob(scheduleKey(schedule.id));
  }
  await prisma.postSchedule.update({ where: { id: schedule.id }, data: { nextRunAt: next } });
  logger.info('[Scheduler] Schedule synced', { scheduleId: schedule.id, nextRunAt: next?.toISOString() ?? null });
  return next;
}

export async function removeScheduleJob(scheduleId: string): Promise<void> {
  await removeKeyedJob(scheduleKey(scheduleId));
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
