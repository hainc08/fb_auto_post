import { Router, Response } from 'express';
import { z } from 'zod';
import { PostStatus, Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { config } from '../config';
import { enqueuePost } from '../services/scheduler.service';
import { generateFromIdea, generatePostContent, improveCaption } from '../services/ai.service';
import multer from 'multer';
import { cloudflareConfigFrom, generateImage } from '../services/image.service';
import { MAX_IMAGE_BYTES, removeImage, saveImage } from '../lib/image-store';
import { logger } from '../utils/logger';
import { getSettings } from '../lib/settings';
import { DEFAULT_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES, isLiveOnAnyPage, syncTargets } from '../lib/post-targets';
import { blockMessage, blockReason } from '../lib/page-health';

const router = Router();
router.use(authenticate);

// ─── Validation Schemas ─────────────────────────

const pageIdsSchema = z.array(z.string().uuid()).min(1, 'Chọn ít nhất 1 Page').max(50);

const createPostSchema = z.object({
  /** Legacy single Page; `pageIds` wins when both are sent */
  pageId: z.string().uuid().optional(),
  pageIds: pageIdsSchema.optional(),
  templateId: z.string().uuid().optional(),
  caption: z.string().optional(),
  imageUrl: z.string().optional(),
  imagePrompt: z.string().optional(),
  hashtags: z.array(z.string()).optional(),
  callToAction: z.string().optional(),
  inputData: z.record(z.string()).optional(),
  scheduledAt: z.string().datetime().optional(),
});

const EDITABLE_STATUSES: PostStatus[] = ['DRAFT', 'READY', 'FAILED', 'SCHEDULED'];

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
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, 'Không có trường nào để cập nhật');

// ─── List Posts ─────────────────────────────────

router.get(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { status, pageId, page = '1', limit = '20' } = req.query;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = Math.min(parseInt(limit as string), 50);

    const where: Prisma.PostWhereInput = {
      userId: req.user!.id,
      ...(status && { status: status as PostStatus }),
      ...(pageId && { pageId: pageId as string }),
    };

    const [posts, total] = await Promise.all([
      prisma.post.findMany({
        where,
        select: {
          id: true,
          caption: true,
          imageUrl: true,
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
          targets: { select: { status: true } },
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
        logs: { orderBy: { createdAt: 'asc' } },
        ...targetInclude,
      },
    });

    if (!post) throw createError(404, 'Post not found');

    res.json({ success: true, data: post });
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
      },
    });

    // Log creation
    await prisma.postLog.create({
      data: { postId: post.id, action: 'created' },
    });

    // Scheduled: queue a delayed publish. The worker skips it if the post was
    // deleted or already published by then.
    if (post.scheduledAt) {
      const delay = Math.max(0, post.scheduledAt.getTime() - Date.now());
      await enqueuePost(post.id, userId, { delay, intervalMs: DEFAULT_INTERVAL_MINUTES * 60_000 });
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
        ...(status !== post.status && { errorMessage: null, errorStep: null, errorCode: null }),
      },
      include: {
        page: { select: { id: true, pageName: true, pageAvatar: true } },
        template: { select: { id: true, name: true } },
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

    const variables = (post.inputData as Record<string, string>) || {};
    const settings = await getSettings(req.user!.id);

    const gemini = { apiKey: settings.geminiApiKey, model: settings.geminiModel };
    let generated;
    if (post.template) {
      // Legacy posts created from a template
      generated = await generatePostContent({
        gemini,
        templatePrompt: post.template.promptTemplate,
        variables,
        language: (req.body.language as string) || 'vi',
        tone: (req.body.tone as string) || 'professional',
      });
    } else {
      if (!variables.basicInfo?.trim()) throw createError(400, 'Hãy nhập ý tưởng / thông tin cơ bản cho bài viết.');
      generated = await generateFromIdea({ gemini, systemPrompt: settings.systemPrompt, idea: variables.basicInfo });
    }

    // Update post with generated content
    const updated = await prisma.post.update({
      where: { id: post.id },
      data: {
        caption: generated.caption,
        hashtags: generated.hashtags,
        imagePrompt: generated.imagePrompt,
        callToAction: generated.callToAction,
        aiResponse: JSON.stringify(generated),
        status: 'READY',
      },
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

async function findImageEditablePost(req: AuthRequest) {
  const post = await prisma.post.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
  if (!post) throw createError(404, 'Post not found');
  if (!IMAGE_EDITABLE.includes(post.status)) {
    throw createError(409, post.status === 'PUBLISHED' ? 'Bài đã đăng, không đổi ảnh được.' : 'Bài đang được xử lý, hãy thử lại sau.');
  }
  if (await isLiveOnAnyPage(post.id)) throw createError(409, LOCKED_MESSAGE);
  return post;
}

/** Store a new image for the post and delete the previous file. */
async function replacePostImage(postId: string, oldPath: string | null, buffer: Buffer, extra: Record<string, unknown>, action: string) {
  let stored;
  try {
    stored = await saveImage(postId, buffer);
  } catch (error) {
    throw createError(400, (error as Error).message);
  }
  const updated = await prisma.post.update({
    where: { id: postId },
    data: { imagePath: stored.imagePath, imageUrl: stored.imageUrl, ...extra },
  });
  await removeImage(oldPath);
  await prisma.postLog.create({ data: { postId, action, details: { bytes: buffer.length, mime: stored.mime } } });
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
    const buffer = await generateImage({ cloudflare: cloudflareConfigFrom(settings), prompt });
    const updated = await replacePostImage(post.id, post.imagePath, buffer, { imagePrompt: prompt }, 'image_generated');

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

    const updated = await replacePostImage(post.id, post.imagePath, file.buffer, {}, 'image_uploaded');
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
    if (!post || !source) throw createError(400, 'Post has no caption to improve');

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
    data: { status: 'GENERATING' },
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

    res.json({ success: true, message: 'Post deleted' });
  })
);

export default router;
