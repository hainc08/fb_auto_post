import { Router, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { getSettings } from '../lib/settings';
import { MAX_IMAGE_BYTES } from '../lib/image-store';
import { styledImagePrompt } from '../lib/compose-prompt';
import { EDGE_VOICES } from '../lib/reel/edge-tts';
import * as renderer from '../lib/reel/render';
import { draftProblem, MAX_SCENES, MAX_SCRIPT_CHARS, mergeScenes, type ReelDraft, type ReelScene } from '../lib/reel/scenes';
import { readSceneImage, removeSceneImage, saveSceneImage } from '../lib/reel/scene-store';
import { imageStyleOf } from '../services/post-writer';
import { cloudflareConfigFrom, generateImage } from '../services/image.service';
import { assertNoReelRunning, queueReel, reelState, ReelError } from '../services/reel.service';
import { readDraft, saveDraft, writeReelScenes } from '../services/reel-draft.service';
import { findImageEditablePost, videoState } from './posts.routes';

/**
 * "Tạo Reel từ bài" (mounted at /api/posts): the draft (scenes: spoken text + picture), AI that writes
 * the scenes, scene pictures (generated or uploaded), and the render request with its progress.
 */

const router = Router();
router.use(authenticate);

const NO_FFMPEG = 'Máy chủ chưa chạy được FFmpeg nên chưa dựng được Reel. Báo quản trị viên kiểm tra /cron/reel-check.';
const newSceneId = () => randomUUID().slice(0, 8);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });

/** The picture's URL carries its version, so a replaced picture is never served from the browser cache */
const sceneView = (postId: string, s: ReelScene) => ({
  id: s.id,
  text: s.text,
  imagePrompt: s.imagePrompt,
  imageUrl: s.image ? `/api/posts/${postId}/reel/scenes/${s.id}/image?v=${s.image.slice(s.image.lastIndexOf('-') + 1).split('.')[0]}` : null,
});
const draftView = (postId: string, draft: ReelDraft) => ({ voice: draft.voice, scenes: draft.scenes.map((s) => sceneView(postId, s)) });

async function ownPost(req: AuthRequest) {
  const post = await prisma.post.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
  if (!post) throw createError(404, 'Post not found');
  return post;
}

/**
 * Attach a finished picture to its scene. The draft is read again here: generating takes seconds and
 * the member may have edited or rewritten the scenes meanwhile.
 */
async function attachPicture(postId: string, sceneId: string, buffer: Buffer): Promise<ReelDraft> {
  let file: string;
  try {
    file = await saveSceneImage(postId, sceneId, buffer);
  } catch (error) {
    throw createError(400, (error as Error).message);
  }
  const fresh = await prisma.post.findUnique({ where: { id: postId } });
  const draft = fresh ? readDraft(fresh) : null;
  const scene = draft?.scenes.find((s) => s.id === sceneId);
  if (!draft || !scene) {
    await removeSceneImage(postId, file);
    throw createError(409, 'Cảnh này vừa bị xoá hoặc kịch bản vừa được viết lại. Hãy thử lại trên cảnh hiện có.');
  }
  const old = scene.image;
  scene.image = file;
  await saveDraft(postId, draft);
  if (old) await removeSceneImage(postId, old);
  return draft;
}

/** The scene of an editable post, or 404 */
async function editableScene(req: AuthRequest) {
  const post = await findImageEditablePost(req);
  const draft = readDraft(post);
  const scene = draft.scenes.find((s) => s.id === req.params.sceneId);
  if (!scene) throw createError(404, 'Không tìm thấy cảnh này. Hãy lưu kịch bản rồi thử lại.');
  return { post, draft, scene };
}

/** Can this host make Reels? The client hides the feature when it cannot. */
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
    const post = await ownPost(req);
    const state = await reelState(post.id);
    const data =
      state.state === 'done'
        ? { ...state, video: videoState(post), reelScript: (post.inputData as Record<string, string> | null)?.reelScript ?? null }
        : state;
    res.json({ success: true, data });
  })
);

// ─── Draft: the scenes being edited ─────────────

router.get(
  '/:id/reel/draft',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await ownPost(req);
    res.json({ success: true, data: draftView(post.id, readDraft(post)) });
  })
);

const draftSchema = z.object({
  voice: z.enum(EDGE_VOICES).optional(),
  scenes: z
    .array(
      z.object({
        id: z.string().regex(/^[0-9a-f]{8}$/).optional(),
        text: z.string().trim().max(MAX_SCRIPT_CHARS, `Lời đọc của một cảnh tối đa ${MAX_SCRIPT_CHARS} ký tự.`),
        imagePrompt: z.string().trim().max(1000, 'Mô tả ảnh tối đa 1000 ký tự.').optional(),
      })
    )
    .max(MAX_SCENES, `Tối đa ${MAX_SCENES} cảnh.`),
});

/** Save the scenes as edited. Scenes keep their id (and picture); empty texts are fine until rendering. */
router.put(
  '/:id/reel/draft',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = draftSchema.parse(req.body ?? {});
    const post = await findImageEditablePost(req);
    await assertNoReelRunning(post.id).catch((error) => {
      throw createError(409, (error as Error).message);
    });
    const old = readDraft(post);
    const { scenes, dropped } = mergeScenes(old.scenes, body.scenes, newSceneId);
    const draft: ReelDraft = { voice: body.voice ?? old.voice, scenes };
    await saveDraft(post.id, draft);
    for (const file of dropped) await removeSceneImage(post.id, file);
    res.json({ success: true, data: draftView(post.id, draft) });
  })
);

/** AI writes the scenes from the post's text (the domain's Reel instructions) and replaces the draft. */
router.post(
  '/:id/reel/script',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await findImageEditablePost(req);
    await assertNoReelRunning(post.id).catch((error) => {
      throw createError(409, (error as Error).message);
    });
    // No AI call (it costs the member's quota) for a Reel this host cannot render
    if (!(await renderer.ffmpegAvailable())) throw createError(503, NO_FFMPEG);
    if (!post.caption?.trim()) throw createError(400, 'Bài chưa có nội dung để viết kịch bản.');
    const settings = await getSettings(req.user!.id);
    let written: Array<{ text: string; imagePrompt: string }>;
    try {
      written = await writeReelScenes({ apiKey: settings.geminiApiKey, model: settings.geminiModel }, post);
    } catch (error) {
      throw createError(502, `AI chưa viết được kịch bản: ${(error as Error).message}`);
    }
    if (!written.length) throw createError(502, 'AI chưa viết được kịch bản: không có cảnh nào có lời đọc. Hãy thử lại.');
    const old = readDraft(post);
    const draft: ReelDraft = { voice: old.voice, scenes: written.map((s) => ({ id: newSceneId(), text: s.text, imagePrompt: s.imagePrompt, image: null })) };
    await saveDraft(post.id, draft);
    for (const s of old.scenes) if (s.image) await removeSceneImage(post.id, s.image);
    res.json({ success: true, data: draftView(post.id, draft) });
  })
);

// ─── Scene pictures ─────────────────────────────

/** One Cloudflare image call of the member's quota, from the scene's prompt in the domain's image style. */
router.post(
  '/:id/reel/scenes/:sceneId/image/generate',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { post, scene } = await editableScene(req);
    if (!scene.imagePrompt.trim()) throw createError(400, 'Cảnh này chưa có mô tả ảnh (tiếng Anh) để AI tạo ảnh.');
    const settings = await getSettings(req.user!.id);
    let buffer: Buffer;
    try {
      buffer = await generateImage({ cloudflare: cloudflareConfigFrom(settings), prompt: styledImagePrompt(await imageStyleOf(post.domainId), scene.imagePrompt) });
    } catch (error) {
      throw createError(502, `Chưa tạo được ảnh: ${(error as Error).message}`);
    }
    res.json({ success: true, data: draftView(post.id, await attachPicture(post.id, scene.id, buffer)) });
  })
);

router.post(
  '/:id/reel/scenes/:sceneId/image/upload',
  (req, res, next) =>
    upload.single('image')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) return next(createError(400, err.code === 'LIMIT_FILE_SIZE' ? 'Ảnh vượt quá 8 MB.' : 'Chỉ gửi một ảnh trong trường "image".'));
      next(err);
    }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const file = (req as AuthRequest & { file?: Express.Multer.File }).file;
    const { post, scene } = await editableScene(req);
    if (!file) throw createError(400, 'Chưa chọn ảnh để tải lên.');
    res.json({ success: true, data: draftView(post.id, await attachPicture(post.id, scene.id, file.buffer)) });
  })
);

router.delete(
  '/:id/reel/scenes/:sceneId/image',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { post, draft, scene } = await editableScene(req);
    const old = scene.image;
    scene.image = null;
    await saveDraft(post.id, draft);
    if (old) await removeSceneImage(post.id, old);
    res.json({ success: true, data: draftView(post.id, draft) });
  })
);

/** The picture itself, to the post's owner only (the session cookie travels with <img> requests). */
router.get(
  '/:id/reel/scenes/:sceneId/image',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await ownPost(req);
    const scene = readDraft(post).scenes.find((s) => s.id === req.params.sceneId);
    const picture = scene?.image ? await readSceneImage(post.id, scene.image) : null;
    if (!picture) throw createError(404, 'Image not found');
    res.setHeader('Content-Type', picture.mime);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(picture.buffer);
  })
);

// ─── Render ─────────────────────────────────────

const reelSchema = z.object({
  /** The quick form: the whole script as one scene. Without it the saved scenes are rendered. */
  script: z.string().trim().min(1, 'Nhập kịch bản lời đọc').max(MAX_SCRIPT_CHARS, `Kịch bản tối đa ${MAX_SCRIPT_CHARS} ký tự`).optional(),
  voice: z.enum(EDGE_VOICES).optional(),
});

/** Books the render (a background job) and answers at once; the dialog then polls /reel/progress. */
router.post(
  '/:id/reel',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { script, voice } = reelSchema.parse(req.body ?? {});
    const post = await findImageEditablePost(req);
    const old = readDraft(post);
    const draft: ReelDraft = {
      voice: voice ?? old.voice,
      scenes: script === undefined ? old.scenes : [{ id: newSceneId(), text: script, imagePrompt: '', image: null }],
    };
    const problem = draftProblem(draft.scenes);
    if (problem) throw createError(400, problem);
    if (!(await renderer.ffmpegAvailable())) throw createError(503, NO_FFMPEG);
    try {
      // before the draft changes: a Reel being made reads these scenes and their pictures
      await assertNoReelRunning(post.id);
      if (script !== undefined || voice !== undefined) {
        await saveDraft(post.id, draft);
        if (script !== undefined) for (const s of old.scenes) if (s.image) await removeSceneImage(post.id, s.image);
      }
      await queueReel(post);
    } catch (error) {
      if (error instanceof ReelError) throw createError(error.status, error.message);
      throw error;
    }
    res.status(202).json({ success: true, data: { state: 'queued' } });
  })
);

export default router;
