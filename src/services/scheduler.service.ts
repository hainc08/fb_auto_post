import { Job, Prisma } from '@prisma/client';
import { logger } from '../utils/logger';
import prisma from '../utils/prisma';
import { toStringArray } from '../utils/json';
import { getSettings, revealSecret } from '../lib/settings';
import { readImage, saveImage } from '../lib/image-store';
import { composeMessage } from '../lib/format-post';
import { FacebookClient } from '../lib/clients/facebook';
import { classifyFailure, UNCERTAIN_PUBLISH_MESSAGE } from '../lib/job-failure';
import { enqueue, removeKeyedJob, startJobWorker, UnrecoverableJobError, upsertKeyedJob, JobResult, JobWorker } from '../lib/job-queue';
import { blockMessage, blockReason, checkPages } from '../lib/page-health';
import { Frequency, nextRunAt } from '../lib/schedule-time';
import { backfillTargets, refreshPostStatus } from '../lib/post-targets';
import { generateFromIdea, generatePostContent } from './ai.service';
import { cloudflareConfigFrom, generateImage } from './image.service';
import { sendPostNotification } from './email.service';

/**
 * Scheduler Service - background work on the MariaDB job queue (src/lib/job-queue.ts)
 *
 * - publish_post: prepare one post (content + image), then queue its Pages
 * - publish_target: publish the prepared post to one Page
 * - run_schedule: one keyed job per active schedule, rescheduled after each run
 */

// ─── Job Payloads ───────────────────────────────

export interface PostPipelineJob {
  postId: string;
  userId: string;
  skipAiGeneration?: boolean;
  skipImageGeneration?: boolean;
  /** Only these targets (default: every Page not published yet) */
  targetIds?: string[];
  /** Gap between two Pages */
  intervalMs?: number;
}

export interface TargetJob {
  targetId: string;
  userId: string;
}

export interface ScheduleCheckJob {
  scheduleId: string;
}

const scheduleKey = (scheduleId: string) => `schedule:${scheduleId}`;

// ─── Publish Pipeline ───────────────────────────

/**
 * The core auto-post pipeline that mirrors the n8n workflow, in two job types:
 *
 * publish_post (once per post)
 *   1. Load post & template data (= "Get rows in sheet")
 *   2. Generate content with AI (= "Basic LLM Chain" + "Structured Output Parser")
 *   3. Edit/format fields (= "Edit Fields")
 *   4. Generate image (= "HTTP Request to Cloudflare" + "Convert to Image")
 *   → queue one publish_target per Page, staggered by `intervalMs`
 *
 * publish_target (once per Page)
 *   5. Publish to Facebook (= "Facebook Graph API" + "HTTP Request")
 *   6. Check result & notify (= "If" + "Send a message"), once all Pages are done
 *
 * Retry rules: a target that already has fbPostId is never published again, and
 * a target/post is only marked FAILED once no retry is left.
 */
async function runPublishJob(job: Job): Promise<void> {
  const { postId, userId, skipAiGeneration, skipImageGeneration, targetIds, intervalMs = 0 } =
    job.payload as unknown as PostPipelineJob;
  const attempt = job.attempts;
  const maxAttempts = job.maxAttempts;
  let step = 'load_post';
  let pendingTargetIds: string[] = [];
  logger.info(`[Pipeline] Preparing post`, { postId, jobId: job.id, attempt });

  try {
    // ─── Step 1: Load post data ───────────────────
    const post = await prisma.post.findUnique({
      where: { id: postId },
      include: { template: true, targets: true },
    });

    // Deleted while queued (e.g. a scheduled post) — nothing to do
    if (!post) {
      logger.warn('[Pipeline] Post no longer exists, skipping', { postId });
      return;
    }
    if (post.userId !== userId) throw new UnrecoverableJobError('Unauthorized');

    // Pages still to publish (never re-publish a Page that has the post)
    const pending = post.targets.filter((t) => t.status !== 'PUBLISHED' && !t.fbPostId && (!targetIds || targetIds.includes(t.id)));
    pendingTargetIds = pending.map((t) => t.id);
    if (pending.length === 0) {
      logger.warn('[Pipeline] No Page left to publish, skipping', { postId });
      return;
    }

    await logStep(postId, 'pipeline_started', { jobId: job.id, attempt, pages: pending.length });
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
    // Generated once here, so every Page gets the same image
    let hasImage = !!(post.imagePath && (await readImage(post.imagePath)));
    if (hasImage) {
      await logStep(postId, 'image_reused');
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
      await prisma.post.update({ where: { id: postId }, data: { imagePath: saved.imagePath, imageUrl: saved.imageUrl } });
      hasImage = true;

      await logStep(postId, 'image_generation_completed', {
        imageSize: buffer.length,
      });
    }

    if (!finalMessage && !hasImage) {
      throw new UnrecoverableJobError('Bài chưa có nội dung hoặc ảnh để đăng.');
    }

    // ─── Queue one publish per Page, staggered ────
    step = 'queue_pages';
    await prisma.post.update({ where: { id: postId }, data: { status: 'PUBLISHING', message: finalMessage, errorMessage: null, errorStep: null, errorCode: null } });

    const start = Date.now();
    for (const [i, target] of pending.entries()) {
      const runAt = new Date(start + i * intervalMs);
      await prisma.postTarget.update({
        where: { id: target.id },
        data: { status: 'PENDING', scheduledAt: runAt, errorMessage: null, errorCode: null },
      });
      await enqueue('publish_target', { targetId: target.id, userId }, { runAt });
    }
    await logStep(postId, 'pages_queued', { pages: pending.length, intervalMinutes: intervalMs / 60_000 });
    logger.info('[Pipeline] Pages queued', { postId, pages: pending.length, intervalMs });
  } catch (error) {
    const failure = classifyFailure(error, step);
    const isFinal = !failure.retryable || attempt >= maxAttempts;
    logger.error('[Pipeline] Post preparation failed:', { postId, step, attempt, final: isFinal, error: failure.message });

    if (!isFinal) {
      // The queue will retry; the post keeps its in-progress status meanwhile
      await logStep(postId, 'attempt_failed', { step, attempt, error: failure.message }).catch(() => {});
      throw error;
    }

    // Nothing reached these Pages: show why on each of them, then settle the post
    // through the same path as per-Page results (one status rule, one email).
    // updateMany: no throw if the post was deleted mid-run
    await prisma.postTarget.updateMany({
      where: { id: { in: pendingTargetIds }, status: { not: 'PUBLISHED' } },
      data: { status: 'FAILED', errorMessage: failure.message, errorCode: failure.code ?? null },
    });
    await prisma.post.updateMany({
      where: { id: postId },
      data: { status: pendingTargetIds.length ? 'PUBLISHING' : 'FAILED', errorMessage: failure.message, errorStep: step, errorCode: failure.code ?? null },
    });
    await logStep(postId, 'failed', { step, attempt, error: failure.message }).catch(() => {});
    if (pendingTargetIds.length) await notifyResult(postId);

    throw new UnrecoverableJobError(failure.message);
  }
}

/** Publish the prepared post to one Page. */
async function runTargetJob(job: Job): Promise<void> {
  const { targetId, userId } = job.payload as unknown as TargetJob;
  const attempt = job.attempts;
  const maxAttempts = job.maxAttempts;

  const target = await prisma.postTarget.findUnique({
    where: { id: targetId },
    include: { page: true, post: true },
  });
  // Post or Page removed while queued
  if (!target) return;
  const { post, page } = target;
  if (post.userId !== userId) throw new UnrecoverableJobError('Unauthorized');

  // Already on this Page (another job or an earlier attempt)
  if (target.status === 'PUBLISHED' || target.fbPostId) {
    await refreshPostStatus(post.id);
    return;
  }

  try {
    // The process died while this Page was being sent: Facebook may have it already
    if (job.interrupted && target.status === 'PUBLISHING') {
      throw new UnrecoverableJobError(UNCERTAIN_PUBLISH_MESSAGE);
    }

    // Scheduled / queued posts: the Page may have become unusable since queueing
    // (App ID changed, token expired, Page disconnected). Never publish through the old app.
    const current = await getSettings(userId);
    const blocked = blockReason(page, current.fbAppId);
    if (blocked) throw new UnrecoverableJobError(`Không đăng được lên Page này: ${blockMessage(blocked, page)}`);

    const finalMessage = post.message ?? composeMessage(post.caption, toStringArray(post.hashtags), post.callToAction);
    const image = post.imagePath ? await readImage(post.imagePath) : null;
    if (post.imagePath && !image) throw new UnrecoverableJobError('Không đọc được ảnh của bài trên máy chủ. Hãy tạo lại hoặc tải lại ảnh.');

    // Take the Page atomically: a duplicate job for it (double click, retry race) stops here
    const { count } = await prisma.postTarget.updateMany({
      where: { id: targetId, status: { in: ['PENDING', 'FAILED'] }, fbPostId: null },
      data: { status: 'PUBLISHING' },
    });
    if (count === 0) {
      logger.warn('[Pipeline] Page already taken by another job, skipping', { postId: post.id, page: page.pageName });
      return;
    }
    logger.info('[Pipeline] Publishing to Facebook...', { postId: post.id, page: page.pageName, attempt });

    const settings = await getSettings(userId);
    const pageToken = revealSecret(page.pageAccessToken);
    const facebook = new FacebookClient(
      { appId: settings.fbAppId, appSecret: settings.fbAppSecret, graphVersion: settings.fbGraphVersion },
      [pageToken]
    );

    const published = image
      ? await facebook.publishPhoto(page.pageId, pageToken, image, finalMessage)
      : await facebook.publishText(page.pageId, pageToken, finalMessage);

    // Record the Facebook id right away: from here on, a retry must never publish again
    await prisma.postTarget.update({
      where: { id: targetId },
      data: {
        status: 'PUBLISHED',
        fbPostId: published.postId,
        fbPhotoId: published.photoId,
        publishedAt: new Date(),
        errorMessage: null,
        errorCode: null,
      },
    });

    const permalink = await facebook.getPermalink(published.postId, pageToken);
    if (permalink) {
      await prisma.postTarget.update({ where: { id: targetId }, data: { fbPermalink: permalink } });
    }
    await logStep(post.id, 'published', { page: page.pageName, fbPostId: published.postId, permalink: permalink ?? null });
    logger.info('[Pipeline] Published on Page', { postId: post.id, page: page.pageName, fbPostId: published.postId });
  } catch (error) {
    const failure = classifyFailure(error, 'publish_facebook');
    const isFinal = !failure.retryable || attempt >= maxAttempts;
    logger.error('[Pipeline] Publishing to Page failed:', { postId: post.id, page: page.pageName, attempt, final: isFinal, error: failure.message });

    await prisma.postTarget.updateMany({
      where: { id: targetId },
      data: isFinal
        ? { status: 'FAILED', errorMessage: failure.message, errorCode: failure.code ?? null }
        : { status: 'PENDING', errorMessage: `Đang thử lại: ${failure.message}` },
    });
    await logStep(post.id, isFinal ? 'page_failed' : 'attempt_failed', { page: page.pageName, attempt, error: failure.message }).catch(() => {});

    if (!isFinal) throw error;
    await notifyResult(post.id);
    throw new UnrecoverableJobError(failure.message);
  }

  await notifyResult(post.id);
}

/** When the last Page finishes, settle the post status and send one summary email. */
async function notifyResult(postId: string): Promise<void> {
  const { finalized, summary } = await refreshPostStatus(postId);
  if (!finalized) return;

  const post = await prisma.post.findUnique({ where: { id: postId }, include: { user: { select: { email: true, name: true } } } });
  if (!post) return;
  await sendPostNotification({
    to: post.user.email,
    userName: post.user.name,
    pageName: `${summary.published}/${summary.total} Page`,
    postCaption: post.message || post.caption || '(No caption)',
    status: summary.failed ? 'failed' : 'success',
    permalink: post.fbPermalink ?? undefined,
    errorMessage: post.errorMessage ?? undefined,
    publishedAt: post.publishedAt ?? new Date(),
  });
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
        targets: { create: { pageId: schedule.pageId } },
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
let worker: JobWorker | null = null;

/** The worker running in this process (for the cron tick), if started. */
export const getWorker = () => worker;

export function startWorkers(): JobWorker {
  void backfillTargets().catch((e) => logger.error('[Targets] Backfill failed', { error: (e as Error).message }));
  void bookMissingScheduleJobs();
  void bookTokenCheck();
  worker = startJobWorker({
    publish_post: runPublishJob,
    publish_target: runTargetJob,
    run_schedule: runScheduleJob,
    check_page_tokens: runTokenCheckJob,
  });
  return worker;
}

// ─── Daily Page token check ─────────────────────

const TOKEN_CHECK_KEY = 'system:check_page_tokens';
/** 03:00 in Vietnam (20:00 UTC the day before) */
const TOKEN_CHECK_TIME = new Date('2026-01-01T20:00:00.000Z');
const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60_000;

const nextTokenCheck = () =>
  nextRunAt({ frequency: 'DAILY', startDate: TOKEN_CHECK_TIME, timezone: 'Asia/Ho_Chi_Minh' }, new Date())!;

/** Keep exactly one pending daily check booked (re-booked if it ever failed). */
async function bookTokenCheck(): Promise<void> {
  try {
    const existing = await prisma.job.findUnique({ where: { key: TOKEN_CHECK_KEY } });
    if (existing && (existing.status === 'PENDING' || existing.status === 'RUNNING')) return;
    await upsertKeyedJob(TOKEN_CHECK_KEY, 'check_page_tokens', {}, nextTokenCheck());
  } catch (error) {
    logger.error('[Pages] Could not book the daily token check', { error: (error as Error).message });
  }
}

/**
 * Re-check every connected Page token once a day, so expired / revoked tokens
 * show up (and block publishing) before a scheduled post hits them.
 */
async function runTokenCheckJob(): Promise<JobResult> {
  const owners = await prisma.facebookPage.findMany({ where: { isActive: true }, select: { userId: true }, distinct: ['userId'] });
  for (const { userId } of owners) {
    try {
      const pages = await checkPages(userId);
      const settings = await getSettings(userId);
      const blocked = pages.filter((p) => blockReason(p, settings.fbAppId));
      const expiring = pages.filter((p) => p.tokenExpiresAt && p.tokenExpiresAt.getTime() - Date.now() < EXPIRY_WARNING_MS);
      logger.info('[Pages] Daily token check', { userId, pages: pages.length, blocked: blocked.length, expiringSoon: expiring.length });
    } catch (error) {
      logger.error('[Pages] Daily token check failed', { userId, error: (error as Error).message });
    }
  }
  return { rescheduleAt: nextTokenCheck() };
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
  options?: { delay?: number; skipAi?: boolean; skipImage?: boolean; targetIds?: string[]; intervalMs?: number }
): Promise<string> {
  const payload: PostPipelineJob = {
    postId,
    userId,
    ...(options?.skipAi !== undefined && { skipAiGeneration: options.skipAi }),
    ...(options?.skipImage !== undefined && { skipImageGeneration: options.skipImage }),
    ...(options?.targetIds && { targetIds: options.targetIds }),
    ...(options?.intervalMs !== undefined && { intervalMs: options.intervalMs }),
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
