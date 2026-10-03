import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { getSettings } from '../lib/settings';
import { EDGE_VOICES } from '../lib/reel/edge-tts';
import { countSpokenWords } from '../lib/reel/subtitles';
import * as renderer from '../lib/reel/render';
import prisma from '../utils/prisma';
import { queueReel, reelState, ReelError, writeReelScript } from '../services/reel.service';
import { findImageEditablePost, videoState } from './posts.routes';

/** "Tạo Reel từ bài": AI script, then voice + subtitles rendered to the post's video (mounted at /api/posts). */

const router = Router();
router.use(authenticate);

const MIN_WORDS = 5;
/** One request to the voice service; about 90 seconds of Vietnamese speech */
const MAX_SCRIPT_CHARS = 1500;

const reelSchema = z.object({
  script: z.string().trim().min(1, 'Nhập kịch bản lời đọc').max(MAX_SCRIPT_CHARS, `Kịch bản tối đa ${MAX_SCRIPT_CHARS} ký tự`),
  voice: z.enum(EDGE_VOICES).default('vi-VN-HoaiMyNeural'),
});

const NO_FFMPEG = 'Máy chủ chưa chạy được FFmpeg nên chưa dựng được Reel. Báo quản trị viên kiểm tra /cron/reel-check.';

/** Can this host make Reels? The client hides the feature when it cannot (e.g. on the production host). */
router.get(
  '/reel/status',
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    res.json({ success: true, data: { available: await renderer.ffmpegAvailable() } });
  })
);

/** Polled by the dialog: waiting, the step with its percentage, the finished video, or why it failed. */
router.get(
  '/:id/reel/progress',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await prisma.post.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
    if (!post) throw createError(404, 'Post not found');
    const state = await reelState(post.id);
    const data =
      state.state === 'done'
        ? { ...state, video: videoState(post), reelScript: (post.inputData as Record<string, string> | null)?.reelScript ?? null }
        : state;
    res.json({ success: true, data });
  })
);

router.post(
  '/:id/reel/script',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await findImageEditablePost(req);
    // No AI call (it costs the user's quota) for a Reel this host cannot render
    if (!(await renderer.ffmpegAvailable())) throw createError(503, NO_FFMPEG);
    if (!post.caption?.trim()) throw createError(400, 'Bài chưa có nội dung để viết kịch bản.');
    const settings = await getSettings(req.user!.id);
    let script: string;
    try {
      script = await writeReelScript({ apiKey: settings.geminiApiKey, model: settings.geminiModel }, post.caption);
    } catch (error) {
      throw createError(502, `AI chưa viết được kịch bản: ${(error as Error).message}`);
    }
    res.json({ success: true, data: { script } });
  })
);

/** Books the render (a background job) and answers at once; the dialog then polls /reel/progress. */
router.post(
  '/:id/reel',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { script, voice } = reelSchema.parse(req.body ?? {});
    const post = await findImageEditablePost(req);
    if (countSpokenWords(script) < MIN_WORDS) throw createError(400, `Kịch bản cần ít nhất ${MIN_WORDS} từ.`);
    if (!(await renderer.ffmpegAvailable())) throw createError(503, NO_FFMPEG);
    try {
      await queueReel(post, { script, voice });
    } catch (error) {
      if (error instanceof ReelError) throw createError(error.status, error.message);
      throw error;
    }
    res.status(202).json({ success: true, data: { state: 'queued' } });
  })
);

export default router;
