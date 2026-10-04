import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Job, Post } from '@prisma/client';
import prisma from '../utils/prisma';
import { logger } from '../utils/logger';
import { UnrecoverableJobError, upsertKeyedJob } from '../lib/job-queue';
import { edgeTts, type EdgeVoice } from '../lib/reel/edge-tts';
import * as renderer from '../lib/reel/render';
import { buildAss, buildLines, displayWords } from '../lib/reel/subtitles';
import { readReelBackground, removeReelBackground, saveReelBackground } from '../lib/reel/background-store';
import { readImage, removeImage } from '../lib/image-store';
import { removeVideo, saveUploadedVideo, VIDEO_TMP_DIR } from '../lib/video-store';
import { reelsProblem } from '../lib/mp4-info';
import { draftScript, sceneStarts, type ReelDraft } from '../lib/reel/scenes';
import { readSceneImage } from '../lib/reel/scene-store';
import { readDraft } from './reel-draft.service';

/** "Tạo Reel từ bài": a voice reads a short script, subtitles follow it, the video becomes the post's video. */

export class ReelError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface ReelProgress {
  stage: 'voice' | 'render' | 'saving';
  /** 0–100 over the whole job. Only the render step is measured; the voice service gives no progress. */
  percent: number;
}

/** Posts being rendered by this process, with how far each is (a second request for the same post is refused) */
const rendering = new Map<string, ReelProgress>();

/** How far the Reel of this post is; null when none is being made. */
export const reelProgress = (postId: string): ReelProgress | null => rendering.get(postId) ?? null;

/** Voice → subtitles → video → the post's video (REEL). Throws ReelError; on failure the post is unchanged. */
export async function makeReel(post: Post, draft: ReelDraft): Promise<Post> {
  const script = draftScript(draft.scenes);
  const voice = draft.voice as EdgeVoice;
  if (rendering.has(post.id)) throw new ReelError(409, 'Reel của bài này đang được dựng, hãy chờ xong rồi thử lại.');
  rendering.set(post.id, { stage: 'voice', percent: 10 });
  try {
    if (!(await renderer.ffmpegAvailable())) {
      throw new ReelError(503, 'Máy chủ chưa có FFmpeg nên chưa dựng được Reel. Cài FFmpeg hoặc đặt biến FFMPEG_PATH.');
    }
    const picture = post.imagePath ? await readImage(post.imagePath) : await readReelBackground(post.id);

    let speech;
    try {
      speech = await edgeTts.synthesize(script, voice);
    } catch (error) {
      throw new ReelError(502, `Chưa tạo được giọng đọc: ${(error as Error).message}`);
    }
    if (!speech.words.length) throw new ReelError(502, 'Chưa tạo được giọng đọc: dịch vụ không trả về mốc thời gian của từng từ.');

    // Each scene's own picture; a scene without one shows the post's picture (or a plain ground)
    const starts = sceneStarts(draft.scenes.map((s) => s.text), speech.words);
    const scenes = await Promise.all(
      draft.scenes.map(async (s, i) => ({ image: (s.image ? await readSceneImage(post.id, s.image) : null) ?? picture, startMs: starts[i] }))
    );
    const ass = buildAss(buildLines(displayWords(script, speech.words)), { withImage: scenes.some((s) => s.image), font: process.env.REEL_FONT });
    await mkdir(VIDEO_TMP_DIR, { recursive: true });
    const tmp = path.join(VIDEO_TMP_DIR, `reel-${randomUUID()}.mp4`);
    try {
      const last = speech.words[speech.words.length - 1];
      rendering.set(post.id, { stage: 'render', percent: 40 });
      await renderer.reelRenderer.render({
        audio: speech.audio,
        ass,
        scenes,
        outPath: tmp,
        durationMs: last.startMs + last.durationMs,
        // the render step is 40–95% of the bar
        onProgress: (fraction) => rendering.set(post.id, { stage: 'render', percent: 40 + Math.round(fraction * 55) }),
      });
      rendering.set(post.id, { stage: 'saving', percent: 97 });
    } catch (error) {
      throw new ReelError(500, (error as Error).message);
    }

    let stored;
    try {
      stored = await saveUploadedVideo(post.id, tmp); // removes `tmp` whatever happens
    } catch (error) {
      throw new ReelError(500, `Dựng video thất bại: ${(error as Error).message}`);
    }
    const problem = reelsProblem(stored.meta);
    if (problem) {
      await removeVideo(stored.videoPath);
      throw new ReelError(400, `${problem} Hãy sửa kịch bản cho ngắn hoặc dài hơn.`);
    }

    // The render took 20 seconds or more: the post may have been published, edited or deleted since it was checked.
    // Commit only if it is still editable, not live on any Page, and has the same media as when the render started.
    let updated: Post | null = null;
    try {
      // Keep the picture before the post lets go of it
      if (post.imagePath && picture) await saveReelBackground(post.id, picture.buffer);
      const { count } = await prisma.post.updateMany({
        where: {
          id: post.id,
          status: { in: ['DRAFT', 'READY', 'FAILED', 'SCHEDULED'] },
          videoPath: post.videoPath,
          imagePath: post.imagePath,
          targets: { none: { status: { in: ['PUBLISHED', 'PUBLISHING'] } } },
        },
        data: {
          videoPath: stored.videoPath,
          videoUrl: stored.videoUrl,
          videoMime: stored.mime,
          videoMeta: { ...stored.meta },
          videoKind: 'REEL',
          imagePath: null,
          imageUrl: null,
          inputData: { ...((post.inputData as Record<string, string> | null) ?? {}), reelScript: script, reelVoice: voice },
        },
      });
      if (count) updated = await prisma.post.findUnique({ where: { id: post.id } });
    } catch (error) {
      await removeVideo(stored.videoPath);
      throw error;
    }
    if (!updated) {
      await removeVideo(stored.videoPath);
      // Deleted meanwhile: nothing will ever clean its kept picture
      if (!(await prisma.post.count({ where: { id: post.id } }))) await removeReelBackground(post.id);
      throw new ReelError(409, 'Bài vừa thay đổi hoặc đang được đăng trong lúc dựng Reel. Hãy tải lại rồi thử lại.');
    }
    await removeVideo(post.videoPath);
    await removeImage(post.imagePath);
    await prisma.postLog.create({ data: { postId: post.id, action: 'reel_rendered', details: { ...stored.meta, voice, words: speech.words.length, scenes: draft.scenes.length } } });
    logger.info('Reel rendered', { postId: post.id, durationSec: stored.meta.durationSec, bytes: stored.meta.bytes });
    return updated;
  } finally {
    rendering.delete(post.id);
  }
}

// ─── Background job (one per post) ──────────────

export const reelJobKey = (postId: string) => `reel:${postId}`;


/** What the dialog shows: waiting for the worker, a step with its percentage, the result, or why it failed. */
export type ReelState =
  | { state: 'idle' }
  | ({ state: 'queued' | 'running' } & ReelProgress)
  | { state: 'done' }
  | { state: 'failed'; error: string };

interface ReelJobPayload {
  postId: string;
  userId: string;
}

/** Book the render of the post's saved scenes. One job per post: refused while the previous one waits or runs. */
export async function queueReel(post: Post): Promise<void> {
  await assertNoReelRunning(post.id);
  const payload: ReelJobPayload = { postId: post.id, userId: post.userId };
  // upsertKeyedJob creates the job with maxAttempts = 1: a failed render is reported, never repeated on its own
  await upsertKeyedJob(reelJobKey(post.id), 'render_reel', { ...payload }, new Date());
}

/** Throws 409 while the post's Reel is waiting or being made (its scenes must not change under it) */
export async function assertNoReelRunning(postId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { key: reelJobKey(postId) } });
  if (job && (job.status === 'PENDING' || job.status === 'RUNNING')) {
    throw new ReelError(409, 'Reel của bài này đang được dựng, hãy chờ xong rồi thử lại.');
  }
}

/**
 * render_reel handler: renders the scenes as saved when the job runs. A failure is final and its message
 * is what the user reads (Job.lastError). A job interrupted by a restart simply runs again.
 */
export async function runReelJob(job: Job): Promise<void> {
  const { postId, userId } = job.payload as unknown as ReelJobPayload;
  const post = await prisma.post.findFirst({ where: { id: postId, userId } });
  if (!post) return; // deleted while it waited
  try {
    await makeReel(post, readDraft(post));
  } catch (error) {
    throw new UnrecoverableJobError(error instanceof ReelError ? error.message : `Dựng Reel thất bại: ${(error as Error).message}`);
  }
}

export async function reelState(postId: string): Promise<ReelState> {
  const job = await prisma.job.findUnique({ where: { key: reelJobKey(postId) } });
  if (!job) return { state: 'idle' };
  if (job.status === 'PENDING') return { state: 'queued', stage: 'voice', percent: 3 };
  // RUNNING with no progress in this process: taken a moment ago, or left by a process that died (recovered within 10 minutes)
  if (job.status === 'RUNNING') return { state: 'running', ...(reelProgress(postId) ?? { stage: 'voice' as const, percent: 5 }) };
  if (job.status === 'FAILED') return { state: 'failed', error: job.lastError ?? 'Dựng Reel thất bại.' };
  return { state: 'done' };
}

/**
 * At startup: renders this process's predecessor was in the middle of go back in the queue now.
 * (One process serves the app; without this the generic recovery would only notice after 10 minutes,
 * and meanwhile the dialog would show a frozen bar and refuse a new render.)
 */
export async function requeueInterruptedReels(): Promise<number> {
  const { count } = await prisma.job.updateMany({
    where: { type: 'render_reel', status: 'RUNNING' },
    data: { status: 'PENDING', interrupted: true, lockToken: null, lockedAt: null, runAt: new Date() },
  });
  if (count) logger.warn(`[Reel] ${count} render(s) interrupted by a restart are queued again`);
  return count;
}
