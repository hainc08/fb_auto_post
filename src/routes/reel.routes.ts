import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { getSettings } from '../lib/settings';
import { EDGE_VOICES } from '../lib/reel/edge-tts';
import { countSpokenWords } from '../lib/reel/subtitles';
import { makeReel, ReelError, writeReelScript } from '../services/reel.service';
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

router.post(
  '/:id/reel/script',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await findImageEditablePost(req);
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

router.post(
  '/:id/reel',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { script, voice } = reelSchema.parse(req.body ?? {});
    const post = await findImageEditablePost(req);
    if (countSpokenWords(script) < MIN_WORDS) throw createError(400, `Kịch bản cần ít nhất ${MIN_WORDS} từ.`);
    try {
      const updated = await makeReel(post, { script, voice });
      res.json({ success: true, data: { ...videoState(updated), reelScript: script } });
    } catch (error) {
      if (error instanceof ReelError) throw createError(error.status, error.message);
      throw error;
    }
  })
);

export default router;
