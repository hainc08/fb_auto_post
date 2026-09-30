import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { composePrompt } from '../lib/compose-prompt';
import { getSettings } from '../lib/settings';
import { generateWithFormat } from '../services/ai.service';
import { formatFields, isUniqueViolation } from './domains.routes';

/** A single post format, found through its domain's owner (spec §5.4). */
const router = Router();
router.use(authenticate);

async function ownedFormat(id: string, userId: string) {
  const format = await prisma.contentFormat.findFirst({ where: { id, domain: { userId } }, include: { domain: true } });
  if (!format) throw createError(404, 'Định dạng không tồn tại.');
  return format;
}

const DEFAULT_NEEDED = 'Mỗi lĩnh vực cần 1 định dạng mặc định — hãy đặt định dạng khác làm mặc định trước.';

router.patch(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const change = z.object({ ...formatFields, isDefault: z.boolean(), isArchived: z.boolean() }).partial().parse(req.body);
    const format = await ownedFormat(req.params.id, req.user!.id);
    const willBeDefault = change.isDefault ?? format.isDefault;
    const willBeArchived = change.isArchived ?? format.isArchived;
    if (format.isDefault && change.isDefault === false) throw createError(409, DEFAULT_NEEDED);
    if (willBeDefault && willBeArchived) {
      throw createError(409, format.isDefault ? DEFAULT_NEEDED : 'Định dạng đã lưu trữ không làm mặc định được.');
    }

    try {
      const updated = await prisma.$transaction(async (tx) => {
        if (change.isDefault === true && !format.isDefault) {
          await tx.contentFormat.updateMany({ where: { domainId: format.domainId }, data: { isDefault: false } });
        }
        return tx.contentFormat.update({ where: { id: format.id }, data: change });
      });
      res.json({ success: true, data: updated });
    } catch (e) {
      if (isUniqueViolation(e)) throw createError(409, 'Lĩnh vực này đã có định dạng trùng tên.');
      throw e;
    }
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const format = await ownedFormat(req.params.id, req.user!.id);
    if (format.isDefault) throw createError(409, DEFAULT_NEEDED);
    const [posts, schedules] = await Promise.all([
      prisma.post.count({ where: { formatId: format.id } }),
      prisma.postSchedule.count({ where: { formatId: format.id } }),
    ]);
    if (posts + schedules > 0) throw createError(409, `Định dạng đang được dùng (${posts} bài, ${schedules} lịch) — hãy lưu trữ thay vì xoá.`);
    await prisma.contentFormat.delete({ where: { id: format.id } });
    res.json({ success: true });
  })
);

// Show the prompt (free) or try one generation (costs one Gemini call); never creates a post
router.post(
  '/:id/preview',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const body = z
      .object({
        idea: z.string().trim().min(1, 'Nhập ý tưởng để thử.').max(500),
        pageId: z.string().uuid().optional(),
        generate: z.boolean().optional(),
      })
      .parse(req.body);
    const format = await ownedFormat(req.params.id, userId);

    let pageName: string | null = null;
    if (body.pageId) {
      const page = await prisma.facebookPage.findFirst({ where: { id: body.pageId, userId }, select: { pageName: true } });
      if (!page) throw createError(404, 'Page not found');
      pageName = page.pageName;
    }

    const input = { domain: format.domain, format, idea: body.idea, pageName };
    if (!body.generate) {
      res.json({ success: true, data: { prompt: composePrompt(input) } });
      return;
    }

    const settings = await getSettings(userId);
    if (!settings.geminiApiKey) throw createError(400, 'Chưa có Gemini API key — nhập trong Cài đặt.');
    const { prompt, caption, hashtags, imagePrompt } = await generateWithFormat({
      ...input,
      gemini: { apiKey: settings.geminiApiKey, model: settings.geminiModel },
    });
    res.json({ success: true, data: { prompt, post: caption, hashtags, imagePrompt } });
  })
);

export default router;
