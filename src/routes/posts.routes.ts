import { Router, Response } from 'express';
import { z } from 'zod';
import { PostStatus, Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { config } from '../config';
import { enqueuePost } from '../services/scheduler.service';
import { improveCaption } from '../services/ai.service';
import { imageStyleOf, writePost } from '../services/post-writer';
import multer from 'multer';
import { cloudflareConfigFrom, generateImage } from '../services/image.service';
import { MAX_IMAGE_BYTES, removeImage, saveImage } from '../lib/image-store';
import { logger } from '../utils/logger';
import { getSettings } from '../lib/settings';
import { DEFAULT_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES, isLiveOnAnyPage, syncTargets } from '../lib/post-targets';
import { blockMessage, blockReason } from '../lib/page-health';
import { timedProblem } from '../lib/post-timing';
import { removeReelBackground } from '../lib/reel/background-store';

import { assertOwnTemplate } from '../lib/ownership';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import { MAX_VIDEO_BYTES, VIDEO_TMP_DIR, removeVideo, saveUploadedVideo } from '../lib/video-store';
import { reelsProblem, type VideoInfo } from '../lib/mp4-info';
import { resolveDomainFormat } from '../lib/domains';
import { styledImagePrompt } from '../lib/compose-prompt';

const router = Router();
router.use(authenticate);

// ─── Validation Schemas ─────────────────────────

const pageIdsSchema = z.array(z.string().uuid()).min(1, 'Chọn ít nhất 1 Page').max(50);

const createPostSchema = z.object({
  /** Legacy single Page; `pageIds` wins when both are sent */
  pageId: z.string().uuid().optional(),
  pageIds: pageIdsSchema.optional(),
  templateId: z.string().uuid().optional(),
  domainId: z.string().uuid().optional(),
  formatId: z.string().uuid().optional(),
  caption: z.string().optional(),
  imageUrl: z.string().optional(),
  imagePrompt: z.string().optional(),
  hashtags: z.array(z.string()).optional(),
  callToAction: z.string().optional(),
  inputData: z.record(z.string()).optional(),
  scheduledAt: z.string().datetime().optional(),
});

const EDITABLE_STATUSES: PostStatus[] = ['DRAFT', 'READY', 'FAILED', 'SCHEDULED'];

/** Domain + format labels shown with a post */
const domainFormatSelect = { domain: { select: { id: true, name: true } }, format: { select: { id: true, name: true } } } as const;

const videoProblem = (meta: unknown) => (meta ? reelsProblem(meta as VideoInfo) : null);
export const videoState = (p: { videoUrl: string | null; videoKind: string | null; videoMeta: unknown }) => ({
  videoUrl: p.videoUrl,
  videoKind: p.videoKind,
  videoMeta: p.videoMeta,
  reelsProblem: videoProblem(p.videoMeta),
});
/** Clears a post's video columns (an image replaces it) */
const noVideo = { videoPath: null, videoUrl: null, videoMime: null, videoMeta: Prisma.DbNull, videoKind: null };

const LOCKED_MESSAGE = 'Bài đã lên ít nhất 1 Page nên không sửa nội dung được nữa (để mọi Page giống nhau). Bạn vẫn có thể đăng lại các Page lỗi.';

/**
 * All given Pages must belong to the user and be postable with the current
 * Facebook App (connected, token valid, issued by the App ID in Settings).
 */
async function assertOwnPages(userId: string, pageIds: string[]) {
  const unique = [...new Set(pageIds)];
  const [pages, settings] = await Promise.all([
    prisma.facebookPage.findMany({ where: { id: { in: unique }, userId } }),
    getSettings(userId),
  ]);
  if (pages.length !== unique.length) throw createError(404, 'Có Page không tồn tại.');

  const blocked = pages.flatMap((page) => {
    const reason = blockReason(page, settings.fbAppId);
    return reason ? [{ page, reason }] : [];
  });
  if (blocked.length) {
    const first = blocked[0];
    throw createError(
      409,
      `Không đăng được lên ${blocked.map((b) => `"${b.page.pageName}"`).join(', ')}: ${blockMessage(first.reason, first.page)} ` +
        'Vào Kênh Facebook → Đồng bộ Page, hoặc bỏ chọn các Page này.'
    );
  }
  return unique;
}

const targetInclude = {
  targets: {
    include: { page: { select: { id: true, pageName: true, pageAvatar: true } } },
    orderBy: [{ scheduledAt: 'asc' as const }, { createdAt: 'asc' as const }],
  },
};

const updatePostSchema = z
  .object({
    caption: z.string().max(5000, 'Caption tối đa 5000 ký tự'),
    hashtags: z
      .array(z.string())
      .max(30, 'Tối đa 30 hashtag')
      .transform((tags) => [
        ...new Set(tags.map((t) => t.trim().replace(/^#+/, '').replace(/\s+/g, '')).filter(Boolean)),
      ]),
    callToAction: z.string().max(300),
    imagePrompt: z.string().max(2000),
    /** The idea AI writes from (stored as inputData.basicInfo) */
    idea: z.string().trim().max(500),
    domainId: z.string().uuid(),
    formatId: z.string().uuid(),
    videoKind: z.enum(['FEED', 'REEL']),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, 'Không có trường nào để cập nhật');

// ─── List Posts ─────────────────────────────────

router.get(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { status, pageId, domainId, page = '1', limit = '20' } = req.query;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = Math.min(parseInt(limit as string), 50);

    const where: Prisma.PostWhereInput = {
      userId: req.user!.id,
      ...(status && { status: status as PostStatus }),
      ...(pageId && { pageId: pageId as string }),
      ...(domainId && { domainId: domainId as string }),
    };

    const [posts, total] = await Promise.all([
      prisma.post.findMany({
        where,
        select: {
          id: true,
          caption: true,
          imageUrl: true,
          videoUrl: true,
          videoKind: true,
          hashtags: true,
          status: true,
          fbPostId: true,
          fbPermalink: true,
          publishedAt: true,
          scheduledAt: true,
          errorMessage: true,
          createdAt: true,
          page: { select: { id: true, pageName: true, pageAvatar: true } },
          template: { select: { id: true, name: true } },
          ...domainFormatSelect,
          // Per-Page progress in the list (name + short error in a popover)
          targets: {
            select: {
              status: true,
              errorMessage: true,
              page: { select: { id: true, pageName: true } },
              // Engagement (hourly sync)
              reactionCount: true,
              commentCount: true,
              shareCount: true,
              unansweredCount: true,
              statsSyncedAt: true,
            },
            orderBy: { createdAt: 'asc' },
          },
          scheduleQueued: true,
          approvedAt: true,
          schedule: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.post.count({ where }),
    ]);

    res.json({
      success: true,
      data: posts,
      pagination: {
        page: parseInt(page as string),
        limit: take,
        total,
        totalPages: Math.ceil(total / take),
      },
    });
  })
);

// ─── Get Single Post ────────────────────────────

router.get(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await prisma.post.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: {
        page: { select: { id: true, pageName: true, pageAvatar: true, pageId: true } },
        template: { select: { id: true, name: true } },
        schedule: { select: { id: true, name: true } },
        ...domainFormatSelect,
        logs: { orderBy: { createdAt: 'asc' } },
        ...targetInclude,
      },
    });

    if (!post) throw createError(404, 'Post not found');

    res.json({ success: true, data: { ...post, reelsProblem: videoProblem(post.videoMeta) } });
  })
);

// ─── Create Post ────────────────────────────────

router.post(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = createPostSchema.parse(req.body);
    const userId = req.user!.id;

    const requested = data.pageIds ?? (data.pageId ? [data.pageId] : []);
    if (requested.length === 0) throw createError(400, 'Chọn ít nhất 1 Page.');
    await assertOwnTemplate(userId, data.templateId);
    // Ids in the body: 404 before any "Page not postable" (409) check
    const { domain, format } = await resolveDomainFormat(userId, { domainId: data.domainId, formatId: data.formatId, pageId: requested[0] });
    const pageIds = await assertOwnPages(userId, requested);

    // Check monthly post limit
    const planLimit = config.planLimits[req.user!.plan as keyof typeof config.planLimits];
    if (planLimit.maxPostsPerMonth !== -1) {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      const monthlyCount = await prisma.post.count({
        where: { userId, createdAt: { gte: startOfMonth } },
      });

      if (monthlyCount >= planLimit.maxPostsPerMonth) {
        throw createError(
          403,
          `Monthly post limit reached (${planLimit.maxPostsPerMonth} posts). Upgrade your plan.`
        );
      }
    }

    // A scheduled post publishes unattended, so it needs something to publish
    if (data.scheduledAt && !data.caption?.trim() && !data.templateId && !data.inputData?.basicInfo?.trim()) {
      throw createError(400, 'Bài hẹn giờ cần có caption, mẫu nội dung hoặc ý tưởng để AI viết.');
    }

    const post = await prisma.post.create({
      data: {
        userId,
        // First Page = the one shown in previews; every Page is a target
        pageId: pageIds[0],
        targets: { create: pageIds.map((pageId) => ({ pageId })) },
        templateId: data.templateId,
        domainId: domain.id,
        formatId: format.id,
        caption: data.caption,
        imageUrl: data.imageUrl,
        imagePrompt: data.imagePrompt,
        hashtags: data.hashtags || [],
        callToAction: data.callToAction,
        inputData: data.inputData || undefined,
        scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : undefined,
        status: data.scheduledAt ? 'SCHEDULED' : 'DRAFT',
      },
      include: {
        page: { select: { id: true, pageName: true } },
        template: { select: { id: true, name: true } },
        ...domainFormatSelect,
      },
    });

    // Log creation
    await prisma.postLog.create({
      data: { postId: post.id, action: 'created' },
    });

    // Scheduled: queue a delayed publish. The worker skips it if the post was
    // deleted or already published by then.
    if (post.scheduledAt) {
      await enqueuePost(post.id, userId, { scheduledFor: post.scheduledAt, intervalMs: DEFAULT_INTERVAL_MINUTES * 60_000 });
      await prisma.postLog.create({
        data: { postId: post.id, action: 'scheduled', details: { scheduledAt: post.scheduledAt.toISOString() } },
      });
    }

    res.status(201).json({ success: true, data: post });
  })
);

// ─── Update Post Content ────────────────────────

router.patch(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = updatePostSchema.parse(req.body);

    const post = await prisma.post.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });
    if (!post) throw createError(404, 'Post not found');

    if (post.status === 'PUBLISHED') {
      throw createError(400, 'Bài đã đăng lên Facebook, không thể sửa tại đây.');
    }
    if (!EDITABLE_STATUSES.includes(post.status)) {
      throw createError(409, 'Bài đang được xử lý (tạo nội dung hoặc đăng), hãy thử lại sau ít giây.');
    }
    if (await isLiveOnAnyPage(post.id)) throw createError(409, LOCKED_MESSAGE);

    // Changing domain/format applies to the next "Viết lại"
    const picked =
      data.domainId || data.formatId
        ? await resolveDomainFormat(req.user!.id, { domainId: data.domainId, formatId: data.formatId, pageId: post.pageId })
        : null;

    if (data.videoKind) {
      if (!post.videoPath) throw createError(400, 'Bài chưa có video.');
      const problem = data.videoKind === 'REEL' ? videoProblem(post.videoMeta) : null;
      if (problem) throw createError(400, problem);
    }

    const caption = data.caption !== undefined ? data.caption.trim() : post.caption;
    // An edited failed/draft post with content is ready to publish again
    const status: PostStatus =
      caption && (post.status === 'FAILED' || post.status === 'DRAFT') ? 'READY' : post.status;

    const updated = await prisma.post.update({
      where: { id: post.id },
      data: {
        ...(data.caption !== undefined && { caption: data.caption.trim() }),
        ...(data.hashtags !== undefined && { hashtags: data.hashtags }),
        ...(data.callToAction !== undefined && { callToAction: data.callToAction.trim() || null }),
        ...(data.imagePrompt !== undefined && { imagePrompt: data.imagePrompt.trim() || null }),
        ...(data.idea !== undefined && {
          inputData: { ...((post.inputData as Record<string, string>) ?? {}), basicInfo: data.idea },
        }),
        status,
        ...(picked && { domainId: picked.domain.id, formatId: picked.format.id }),
        ...(data.videoKind && { videoKind: data.videoKind }),
        ...(status !== post.status && { errorMessage: null, errorStep: null, errorCode: null }),
      },
      include: {
        page: { select: { id: true, pageName: true, pageAvatar: true } },
        template: { select: { id: true, name: true } },
        ...domainFormatSelect,
      },
    });

    await prisma.postLog.create({
      data: { postId: post.id, action: 'edited', details: { fields: Object.keys(data) } },
    });

    res.json({ success: true, data: updated });
  })
);

// ─── Generate AI Content for Post ───────────────

router.post(
  '/:id/generate',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await prisma.post.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { template: true },
    });
    if (!post) throw createError(404, 'Post not found');

    const settings = await getSettings(req.user!.id);
    const { generated, aiPrompt, domainId, formatId } = await writePost(post, settings);

    const updated = await prisma.post.update({
      where: { id: post.id },
      data: {
        caption: generated.caption,
        hashtags: generated.hashtags,
        imagePrompt: generated.imagePrompt,
        callToAction: generated.callToAction,
        aiResponse: JSON.stringify(generated),
        aiPrompt,
        ...(formatId && { domainId, formatId }),
        status: 'READY',
      },
      include: domainFormatSelect,
    });

    res.json({ success: true, data: { ...updated, generated } });
  })
);

// ─── Post Image: generate / upload / remove ─────
// The stored image is exactly what gets published (no regeneration at publish).

const IMAGE_EDITABLE: PostStatus[] = ['DRAFT', 'READY', 'FAILED', 'SCHEDULED'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
});

export async function findImageEditablePost(req: AuthRequest) {
  const post = await prisma.post.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
  if (!post) throw createError(404, 'Post not found');
  if (!IMAGE_EDITABLE.includes(post.status)) {
    throw createError(409, post.status === 'PUBLISHED' ? 'Bài đã đăng, không đổi ảnh được.' : 'Bài đang được xử lý, hãy thử lại sau.');
  }
  if (await isLiveOnAnyPage(post.id)) throw createError(409, LOCKED_MESSAGE);
  return post;
}

/** Store a new image for the post and delete the previous file (an image replaces a video). */
async function replacePostImage(
  post: { id: string; imagePath: string | null; videoPath: string | null },
  buffer: Buffer,
  extra: Record<string, unknown>,
  action: string
) {
  let stored;
  try {
    stored = await saveImage(post.id, buffer);
  } catch (error) {
    throw createError(400, (error as Error).message);
  }
  const updated = await prisma.post.update({
    where: { id: post.id },
    data: { imagePath: stored.imagePath, imageUrl: stored.imageUrl, ...noVideo, ...extra },
  });
  await removeImage(post.imagePath);
  await removeVideo(post.videoPath);
  await prisma.postLog.create({ data: { postId: post.id, action, details: { bytes: buffer.length, mime: stored.mime } } });
  return updated;
}

// Generate with Cloudflare (kept for the old path name used by the client)
router.post(
  ['/:id/preview-image', '/:id/image/generate'],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await findImageEditablePost(req);
    const prompt = z.string().trim().max(2000).optional().parse(req.body?.prompt) || post.imagePrompt;
    if (!prompt) throw createError(400, 'Chưa có image prompt để tạo ảnh.');

    const settings = await getSettings(req.user!.id);
    const buffer = await generateImage({
      cloudflare: cloudflareConfigFrom(settings),
      prompt: styledImagePrompt(await imageStyleOf(post.domainId), prompt),
    });
    const updated = await replacePostImage(post, buffer, { imagePrompt: prompt }, 'image_generated');

    res.json({ success: true, data: { imageUrl: updated.imageUrl, imagePrompt: updated.imagePrompt } });
  })
);

// Upload from the user's computer
router.post(
  '/:id/image/upload',
  (req, res, next) =>
    upload.single('image')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return next(createError(400, 'Ảnh vượt quá 8 MB.'));
      next(err);
    }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await findImageEditablePost(req);
    const file = (req as AuthRequest & { file?: Express.Multer.File }).file;
    if (!file) throw createError(400, 'Chưa chọn ảnh để tải lên.');

    const updated = await replacePostImage(post, file.buffer, {}, 'image_uploaded');
    logger.info('Post image uploaded', { postId: post.id, bytes: file.size });

    res.json({ success: true, data: { imageUrl: updated.imageUrl } });
  })
);

// Remove the image (the post will be published without one unless a prompt regenerates it)
router.delete(
  '/:id/image',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await findImageEditablePost(req);
    await prisma.post.update({ where: { id: post.id }, data: { imagePath: null, imageUrl: null } });
    await removeImage(post.imagePath);
    await prisma.postLog.create({ data: { postId: post.id, action: 'image_removed' } });
    res.json({ success: true, data: { imageUrl: null } });
  })
);

// ─── Post Video: upload (to disk) / remove ──────

const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      mkdir(VIDEO_TMP_DIR, { recursive: true }).then(
        () => cb(null, VIDEO_TMP_DIR),
        (e) => cb(e as Error, VIDEO_TMP_DIR)
      );
    },
    filename: (_req, _file, cb) => cb(null, `${randomUUID()}.upload`),
  }),
  limits: { fileSize: MAX_VIDEO_BYTES, files: 1 },
});

router.post(
  '/:id/video/upload',
  // Check the post before accepting up to 100 MB
  asyncHandler(async (req: AuthRequest, _res: Response, next) => {
    await findImageEditablePost(req);
    next();
  }),
  (req, res, next) =>
    videoUpload.single('video')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        return next(createError(400, err.code === 'LIMIT_FILE_SIZE' ? 'Video vượt quá 100 MB.' : 'Chỉ gửi một file video trong trường "video".'));
      }
      next(err);
    }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const file = (req as AuthRequest & { file?: Express.Multer.File }).file;
    if (!file) throw createError(400, 'Chưa chọn video để tải lên.');
    let post;
    try {
      post = await findImageEditablePost(req);
    } catch (error) {
      await unlink(file.path).catch(() => {});
      throw error;
    }
    let stored;
    try {
      stored = await saveUploadedVideo(post.id, file.path);
    } catch (error) {
      throw createError(400, (error as Error).message);
    }
    let updated;
    try {
      updated = await prisma.post.update({
        where: { id: post.id },
        data: {
          videoPath: stored.videoPath,
          videoUrl: stored.videoUrl,
          videoMime: stored.mime,
          videoMeta: { ...stored.meta },
          videoKind: 'FEED',
          imagePath: null,
          imageUrl: null,
        },
      });
    } catch (error) {
      await removeVideo(stored.videoPath); // e.g. the post was deleted meanwhile
      throw error;
    }
    await removeVideo(post.videoPath);
    await removeImage(post.imagePath);
    await prisma.postLog.create({ data: { postId: post.id, action: 'video_uploaded', details: { ...stored.meta } } });
    logger.info('Post video uploaded', { postId: post.id, bytes: stored.meta.bytes });
    res.json({ success: true, data: videoState(updated) });
  })
);

router.delete(
  '/:id/video',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await findImageEditablePost(req);
    await prisma.post.update({ where: { id: post.id }, data: noVideo });
    await removeVideo(post.videoPath);
    await prisma.postLog.create({ data: { postId: post.id, action: 'video_removed' } });
    res.json({ success: true, data: { videoUrl: null } });
  })
);

// ─── Improve Caption ────────────────────────────

router.post(
  '/:id/improve',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { instruction, caption: draftCaption } = z
      .object({ instruction: z.string().min(1).max(500), caption: z.string().max(5000).optional() })
      .parse(req.body);

    const post = await prisma.post.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });

    // With `caption` (editor draft): rewrite the draft and return it without saving.
    // Without it: rewrite the stored caption and save (original behaviour).
    const source = draftCaption ?? post?.caption;
    if (!post) throw createError(404, 'Post not found');
    if (!source) throw createError(400, 'Post has no caption to improve');

    const settings = await getSettings(req.user!.id);
    const improved = await improveCaption(
      { apiKey: settings.geminiApiKey, model: settings.geminiModel },
      source,
      instruction
    );

    if (draftCaption === undefined) {
      await prisma.post.update({
        where: { id: post.id },
        data: { caption: improved },
      });
    }

    res.json({ success: true, data: { caption: improved } });
  })
);

// ─── Publish Post (Enqueue Pipeline) ────────────

const publishSchema = z.object({
  /** Pages to publish to (replaces the unpublished selection); default: current targets */
  pageIds: pageIdsSchema.optional(),
  /** Gap between two Pages, in minutes */
  intervalMinutes: z.number().int().min(0).max(MAX_INTERVAL_MINUTES).default(DEFAULT_INTERVAL_MINUTES),
});

const QUEUEABLE: PostStatus[] = ['DRAFT', 'READY', 'FAILED', 'SCHEDULED', 'PUBLISHED'];

/** Mark the post as queued; fails for a second click while the first run is going. */
async function claimForPublishing(postId: string) {
  const { count } = await prisma.post.updateMany({
    where: { id: postId, status: { in: QUEUEABLE } },
    // publishing by hand takes the post out of its schedule (the tick never publishes it again)
    data: { status: 'GENERATING', scheduleQueued: false },
  });
  if (count === 0) throw createError(409, 'Bài đang được xử lý hoặc đang đăng, hãy chờ xong rồi thử lại.');
}

router.post(
  '/:id/publish',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { pageIds, intervalMinutes } = publishSchema.parse(req.body ?? {});
    const post = await prisma.post.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });

    if (!post) throw createError(404, 'Post not found');
    if (!post.caption && !post.templateId) {
      throw createError(400, 'Post must have caption or template before publishing');
    }

    if (pageIds) await syncTargets(post.id, await assertOwnPages(req.user!.id, pageIds));
    const targets = await prisma.postTarget.findMany({ where: { postId: post.id, status: { not: 'PUBLISHED' } } });
    if (targets.length === 0) throw createError(400, 'Bài đã được đăng trên tất cả Page đã chọn.');
    if (!pageIds) await assertOwnPages(req.user!.id, targets.map((t) => t.pageId));

    await claimForPublishing(post.id);

    // A post that already has content is published as-is (keeps user edits);
    // AI generation only runs for template posts that were never generated.
    const jobId = await enqueuePost(post.id, req.user!.id, {
      skipAi: !!post.caption,
      skipImage: !!post.imagePath,
      targetIds: targets.map((t) => t.id),
      intervalMs: intervalMinutes * 60_000,
    });

    res.json({
      success: true,
      data: { jobId, pages: targets.length, intervalMinutes, message: 'Post queued for publishing' },
    });
  })
);

// ─── Approve a schedule post for its slot ───────

router.post(
  '/:id/approve',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await prisma.post.findFirst({ where: { id: req.params.id, userId: req.user!.id }, include: { targets: true } });
    if (!post) throw createError(404, 'Post not found');
    if (!post.scheduleQueued || post.status !== 'READY') {
      throw createError(400, 'Chỉ duyệt được bài của lịch đăng đã viết xong và đang chờ duyệt.');
    }
    // Same Page checks as "Đăng": approving a post that cannot go out would fail silently later
    await assertOwnPages(req.user!.id, post.targets.map((t) => t.pageId));
    const { count } = await prisma.post.updateMany({
      where: { id: post.id, status: 'READY', scheduleQueued: true },
      data: { status: 'SCHEDULED', approvedAt: new Date() },
    });
    if (!count) throw createError(409, 'Bài vừa thay đổi, hãy tải lại.');
    await prisma.postLog.create({ data: { postId: post.id, action: 'approved', details: { slot: post.scheduledAt?.toISOString() ?? null } } });
    const saved = await prisma.post.findUniqueOrThrow({ where: { id: post.id }, select: { id: true, status: true, approvedAt: true, scheduledAt: true } });
    res.json({ success: true, data: saved });
  })
);

// ─── Timed post: publish at a chosen time ("Hẹn giờ đăng") ───

const timedSchema = z.object({
  scheduledAt: z.string().datetime(),
  /** Pages to publish to (replaces the unpublished selection); default: current targets */
  pageIds: pageIdsSchema.optional(),
  /** Gap between two Pages, in minutes */
  intervalMinutes: z.number().int().min(0).max(MAX_INTERVAL_MINUTES).default(DEFAULT_INTERVAL_MINUTES),
});

const TIMEABLE: PostStatus[] = ['DRAFT', 'READY', 'FAILED', 'SCHEDULED'];

/** Set or move the time. Setting a time is the approval: the post goes out then without another click. */
router.post(
  '/:id/schedule',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { scheduledAt, pageIds, intervalMinutes } = timedSchema.parse(req.body ?? {});
    const at = new Date(scheduledAt);
    const problem = timedProblem(at);
    if (problem) throw createError(400, problem);

    const post = await prisma.post.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
    if (!post) throw createError(404, 'Post not found');
    if (post.scheduleQueued) {
      throw createError(400, 'Bài này thuộc một lịch đăng: hãy duyệt để đăng theo khung giờ của lịch, hoặc đăng ngay.');
    }
    if (!post.caption?.trim() && !post.imagePath && !post.videoPath) {
      throw createError(400, 'Bài chưa có nội dung để hẹn giờ đăng.');
    }
    // Before touching its Pages: a post in progress keeps the targets its jobs were queued for
    if (post.status === 'PUBLISHED') throw createError(400, 'Bài đã được đăng, không hẹn giờ được nữa.');
    if (!TIMEABLE.includes(post.status)) throw createError(409, 'Bài đang được xử lý hoặc đang đăng, hãy chờ xong rồi thử lại.');

    // Same Page checks as "Đăng": a post that cannot go out would fail silently at its time
    if (pageIds) await syncTargets(post.id, await assertOwnPages(req.user!.id, pageIds));
    const targets = await prisma.postTarget.findMany({ where: { postId: post.id, status: { not: 'PUBLISHED' } } });
    if (targets.length === 0) throw createError(400, 'Bài đã được đăng trên tất cả Page đã chọn.');
    if (!pageIds) await assertOwnPages(req.user!.id, targets.map((t) => t.pageId));

    const { count } = await prisma.post.updateMany({
      where: { id: post.id, status: { in: TIMEABLE }, scheduleQueued: false },
      data: { status: 'SCHEDULED', scheduledAt: at, approvedAt: new Date(), errorMessage: null, errorStep: null, errorCode: null },
    });
    if (count === 0) throw createError(409, 'Bài đang được xử lý hoặc đang đăng, hãy chờ xong rồi thử lại.');

    // A job booked for an earlier time stays in the queue and does nothing (see claimTimedPost)
    // skipAi: the user approved what they saw; nothing is written by AI at the time
    await enqueuePost(post.id, req.user!.id, { scheduledFor: at, skipAi: true, intervalMs: intervalMinutes * 60_000 });
    await prisma.postLog.create({
      data: { postId: post.id, action: 'scheduled', details: { scheduledAt: at.toISOString(), pages: targets.length } },
    });
    res.json({ success: true, data: { id: post.id, status: 'SCHEDULED', scheduledAt: at.toISOString(), pages: targets.length } });
  })
);

/** Cancel the time: the post waits for approval again. */
router.delete(
  '/:id/schedule',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await prisma.post.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
    if (!post) throw createError(404, 'Post not found');
    const status: PostStatus = post.caption?.trim() ? 'READY' : 'DRAFT';
    const { count } = await prisma.post.updateMany({
      where: { id: post.id, status: 'SCHEDULED', scheduleQueued: false },
      data: { status, scheduledAt: null, approvedAt: null },
    });
    if (count === 0) throw createError(400, 'Bài này không đang hẹn giờ đăng.');
    await prisma.postLog.create({ data: { postId: post.id, action: 'schedule_cancelled' } });
    res.json({ success: true, data: { id: post.id, status, scheduledAt: null } });
  })
);

// ─── Retry one Page ─────────────────────────────

router.post(
  '/:id/targets/:targetId/retry',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const target = await prisma.postTarget.findFirst({
      where: { id: req.params.targetId, postId: req.params.id, post: { userId: req.user!.id } },
    });
    if (!target) throw createError(404, 'Không tìm thấy Page của bài này.');
    if (target.status !== 'FAILED') throw createError(400, 'Chỉ đăng lại được Page đang báo lỗi.');
    await assertOwnPages(req.user!.id, [target.pageId]);

    await claimForPublishing(target.postId);
    const jobId = await enqueuePost(target.postId, req.user!.id, { skipAi: true, targetIds: [target.id], intervalMs: 0 });
    res.json({ success: true, data: { jobId } });
  })
);

// ─── Delete Post ────────────────────────────────

router.delete(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await prisma.post.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });

    if (!post) throw createError(404, 'Post not found');
    if (post.status === 'PUBLISHING') {
      throw createError(400, 'Cannot delete a post that is currently being published');
    }

    await prisma.post.delete({ where: { id: post.id } });
    await removeImage(post.imagePath);
    await removeVideo(post.videoPath);
    await removeReelBackground(post.id);

    res.json({ success: true, message: 'Post deleted' });
  })
);

export default router;
