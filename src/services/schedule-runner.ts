import type { Job, PostSchedule, PostStatus, Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { logger } from '../utils/logger';
import { getSettings } from '../lib/settings';
import { saveImage } from '../lib/image-store';
import { styledImagePrompt } from '../lib/compose-prompt';
import { classifyFailure } from '../lib/job-failure';
import { enqueue, upsertKeyedJob, UnrecoverableJobError, type JobResult } from '../lib/job-queue';
import { nextSlots, VN_TZ, type SlotTiming } from '../lib/schedule-time';
import { DEFAULT_INTERVAL_MINUTES } from '../lib/post-targets';
import { toStringArray } from '../utils/json';
import { config } from '../config';
import { imageStyleOf, writePost } from './post-writer';
import { cloudflareConfigFrom, generateImage } from './image.service';
import { enqueuePost } from './scheduler.service';

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

// ─── Tick: publish, move, write ahead ───────────

/** A post in one of these states still holds its slot (FAILED = the AI could not write it) */
export const PENDING_STATUSES: PostStatus[] = ['DRAFT', 'GENERATING', 'READY', 'SCHEDULED', 'FAILED'];
const TICK_MS = 60_000;
export const SCHEDULE_TICK_KEY = 'system:schedule_tick';

export const slotTiming = (s: Pick<PostSchedule, 'weekdays' | 'slots' | 'startDate' | 'endDate' | 'timezone'>): SlotTiming => ({
  weekdays: (Array.isArray(s.weekdays) ? s.weekdays : []).filter((d): d is number => typeof d === 'number'),
  slots: toStringArray(s.slots),
  startDate: s.startDate,
  endDate: s.endDate,
  timezone: s.timezone || VN_TZ,
});

const queuedPosts = (scheduleId: string) =>
  prisma.post.findMany({
    where: { scheduleId, scheduleQueued: true, status: { in: PENDING_STATUSES } },
    orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, status: true, scheduledAt: true, caption: true, imagePath: true, userId: true },
  });

/** Put the queued posts on the next slots after `now`, keeping their order. */
export async function reslot(scheduleId: string, now = new Date()): Promise<void> {
  const schedule = await prisma.postSchedule.findUnique({ where: { id: scheduleId } });
  if (!schedule) return;
  const posts = await queuedPosts(scheduleId);
  const slots = nextSlots(slotTiming(schedule), now, posts.length);
  for (const [i, post] of posts.entries()) {
    const at = slots[i] ?? null; // no slot left (end date): the post stays, without a time
    if (at?.getTime() === post.scheduledAt?.getTime()) continue;
    await prisma.post.update({ where: { id: post.id }, data: { scheduledAt: at } });
    await log(post.id, 'slot_moved', { to: at?.toISOString() ?? null });
  }
}

/** One schedule, one minute: publish the approved post that is due, move the late ones, write ahead. */
export async function tickSchedule(scheduleId: string, now = new Date()): Promise<void> {
  const schedule = await prisma.postSchedule.findUnique({
    where: { id: scheduleId },
    include: { user: { select: { isActive: true } }, pages: { include: { page: { select: { id: true, isActive: true } } } } },
  });
  if (!schedule || !schedule.isActive || schedule.frequency !== 'SLOTS' || !schedule.user.isActive) return;

  let posts = await queuedPosts(scheduleId);
  const isDue = (p: { scheduledAt: Date | null }) => !!p.scheduledAt && p.scheduledAt.getTime() <= now.getTime();

  // 1. The earliest due post goes out if it was approved (one per tick: no burst after downtime)
  const first = posts.find(isDue);
  if (first?.status === 'SCHEDULED') {
    const { count } = await prisma.post.updateMany({
      where: { id: first.id, status: 'SCHEDULED', scheduleQueued: true },
      data: { status: 'GENERATING', scheduleQueued: false },
    });
    if (count) {
      await enqueuePost(first.id, first.userId, {
        skipAi: !!first.caption,
        skipImage: !!first.imagePath,
        intervalMs: DEFAULT_INTERVAL_MINUTES * 60_000,
      });
      await log(first.id, 'schedule_published', { slot: first.scheduledAt?.toISOString() ?? null });
    }
    posts = posts.filter((p) => p.id !== first.id);
  }

  // 2. Anything still late was not approved in time: everyone moves to the next slots, in order
  if (posts.some(isDue)) {
    await reslot(scheduleId, now);
    posts = await queuedPosts(scheduleId);
  }

  // 3. Keep bufferSize posts written ahead, from the next ideas
  const pageIds = schedule.pages.filter((p) => p.page.isActive).map((p) => p.pageId);
  const missing = schedule.bufferSize - posts.length;
  if (missing <= 0 || pageIds.length === 0) return;
  const last = posts.reduce<Date>((max, p) => (p.scheduledAt && p.scheduledAt > max ? p.scheduledAt : max), now);
  const slots = nextSlots(slotTiming(schedule), last, missing);
  const ideas = await prisma.scheduleIdea.findMany({
    where: { scheduleId, status: 'QUEUED' },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    take: slots.length,
  });
  for (const [i, idea] of ideas.entries()) {
    const post = await prisma.$transaction(async (tx) => {
      const taken = await tx.scheduleIdea.updateMany({ where: { id: idea.id, status: 'QUEUED' }, data: { status: 'USED', usedAt: now } });
      if (!taken.count) return null;
      const created = await tx.post.create({
        data: {
          userId: schedule.userId,
          pageId: pageIds[0],
          scheduleId,
          scheduleQueued: true,
          scheduledAt: slots[i],
          status: 'DRAFT',
          domainId: schedule.domainId,
          formatId: schedule.formatId,
          inputData: { basicInfo: idea.text },
          targets: { create: pageIds.map((pageId) => ({ pageId })) },
        },
      });
      await tx.scheduleIdea.update({ where: { id: idea.id }, data: { postId: created.id } });
      return created;
    });
    if (!post) continue;
    await enqueue('prepare_post', { postId: post.id });
    await log(post.id, 'created', { schedule: schedule.name, slot: slots[i].toISOString() });
  }
}

/** Every active slot schedule (tests pass `where` to stay on their own schedules). */
export async function runScheduleTick(now = new Date(), where: Prisma.PostScheduleWhereInput = {}): Promise<void> {
  const schedules = await prisma.postSchedule.findMany({ where: { ...where, isActive: true, frequency: 'SLOTS' }, select: { id: true } });
  for (const { id } of schedules) {
    try {
      await tickSchedule(id, now);
    } catch (error) {
      logger.error('[Schedules] Tick failed for a schedule', { scheduleId: id, error: (error as Error).message });
    }
  }
}

/** schedule_tick job: never stops re-booking itself, even when a tick fails */
export async function runScheduleTickJob(): Promise<JobResult> {
  try {
    await runScheduleTick();
  } catch (error) {
    logger.error('[Schedules] Tick failed', { error: (error as Error).message });
  }
  return { rescheduleAt: new Date(Date.now() + TICK_MS) };
}

/** One pending tick job (not in tests: DB test files share the database and run in parallel). */
export async function bookScheduleTick(): Promise<void> {
  if (config.env === 'test') return;
  const existing = await prisma.job.findUnique({ where: { key: SCHEDULE_TICK_KEY } });
  if (existing && (existing.status === 'PENDING' || existing.status === 'RUNNING')) return;
  await upsertKeyedJob(SCHEDULE_TICK_KEY, 'schedule_tick', {}, new Date());
}
