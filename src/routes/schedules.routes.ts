import { Router, Response } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { formatForPost, resolveDomainFormat } from '../lib/domains';
import { getSettings } from '../lib/settings';
import { nextSlots, SLOT_PATTERN, VN_TZ } from '../lib/schedule-time';
import { PENDING_STATUSES, reslot, slotTiming } from '../services/schedule-runner';
import { suggestIdeas } from '../services/ai.service';

/** Slot schedules (Phase 2): weekdays + 1–3 times a day, several Pages, an idea queue. */

const router = Router();
router.use(authenticate);

// ─── Validation ─────────────────────────────────

const ideaText = z.string().trim().min(3, 'Ý tưởng cần ít nhất 3 ký tự').max(500, 'Ý tưởng tối đa 500 ký tự');

const scheduleFields = {
  name: z.string().trim().min(1, 'Nhập tên lịch').max(100, 'Tên lịch tối đa 100 ký tự'),
  pageIds: z.array(z.string().uuid()).min(1, 'Chọn ít nhất 1 Page').max(10, 'Tối đa 10 Page'),
  weekdays: z
    .array(z.number().int().min(0, 'Ngày trong tuần không hợp lệ').max(6, 'Ngày trong tuần không hợp lệ'))
    .min(1, 'Chọn ít nhất 1 ngày trong tuần')
    .transform((d) => [...new Set(d)].sort()),
  slots: z
    .array(z.string().regex(SLOT_PATTERN, 'Khung giờ phải có dạng HH:mm'))
    .min(1, 'Chọn 1–3 khung giờ mỗi ngày')
    .max(3, 'Chọn 1–3 khung giờ mỗi ngày')
    .refine((s) => new Set(s).size === s.length, 'Các khung giờ không được trùng nhau')
    .transform((s) => [...s].sort()),
  bufferSize: z.number().int().min(1, 'Số bài viết sẵn từ 1 đến 7').max(7, 'Số bài viết sẵn từ 1 đến 7'),
  startDate: z.string().datetime(),
  endDate: z.string().datetime().nullable(),
  domainId: z.string().uuid(),
  formatId: z.string().uuid(),
};

const createSchema = z.object({
  ...scheduleFields,
  bufferSize: scheduleFields.bufferSize.default(3),
  startDate: scheduleFields.startDate.optional(),
  endDate: scheduleFields.endDate.optional(),
  domainId: scheduleFields.domainId.optional(),
  formatId: scheduleFields.formatId.optional(),
  ideas: z.array(z.string()).max(50, 'Tối đa 50 ý tưởng mỗi lần').optional(),
});
const updateSchema = z
  .object(scheduleFields)
  .partial()
  .refine((d) => Object.keys(d).length > 0, 'Không có trường nào để cập nhật');

// ─── Helpers ────────────────────────────────────

const scheduleInclude = {
  pages: { include: { page: { select: { id: true, pageName: true, pageAvatar: true, isActive: true } } } },
  domain: { select: { id: true, name: true } },
  format: { select: { id: true, name: true } },
} satisfies Prisma.PostScheduleInclude;

type LoadedSchedule = Prisma.PostScheduleGetPayload<{ include: typeof scheduleInclude }>;

async function findOwn(req: AuthRequest) {
  const schedule = await prisma.postSchedule.findFirst({ where: { id: req.params.id, userId: req.user!.id }, include: scheduleInclude });
  if (!schedule) throw createError(404, 'Không tìm thấy lịch đăng.');
  return schedule;
}

/** Ids in the body must be the caller's own, connected Pages */
async function ownPages(userId: string, pageIds: string[]): Promise<string[]> {
  const unique = [...new Set(pageIds)];
  const found = await prisma.facebookPage.findMany({ where: { id: { in: unique }, userId, isActive: true }, select: { id: true } });
  if (found.length !== unique.length) throw createError(404, 'Không tìm thấy Page.');
  return unique;
}

/** The client sends the start of the end day (Vietnam time): the whole day counts, up to 23:59 */
const endOfDay = (iso: string) => new Date(new Date(iso).getTime() + 24 * 3600_000 - 60_000);

async function summary(s: LoadedSchedule) {
  const [ideasLeft, queuedCount, awaitingApproval] = await Promise.all([
    prisma.scheduleIdea.count({ where: { scheduleId: s.id, status: 'QUEUED' } }),
    prisma.post.count({ where: { scheduleId: s.id, scheduleQueued: true, status: { in: PENDING_STATUSES } } }),
    prisma.post.count({ where: { scheduleId: s.id, scheduleQueued: true, status: 'READY' } }),
  ]);
  const { pages, ...rest } = s;
  return {
    ...rest,
    pages: pages.map((p) => p.page),
    ideasLeft,
    queuedCount,
    awaitingApproval,
    nextSlotAt: s.isActive ? (nextSlots(slotTiming(s), new Date(), 1)[0] ?? null) : null,
  };
}

async function addIdeas(scheduleId: string, texts: string[]): Promise<number> {
  const clean = texts
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .map((t) => ideaText.parse(t));
  if (!clean.length) return 0;
  const last = await prisma.scheduleIdea.aggregate({ where: { scheduleId }, _max: { position: true } });
  const start = (last._max.position ?? -1) + 1;
  await prisma.scheduleIdea.createMany({ data: clean.map((text, i) => ({ scheduleId, text, position: start + i })) });
  return clean.length;
}

// ─── Schedules ──────────────────────────────────

router.get(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const schedules = await prisma.postSchedule.findMany({ where: { userId: req.user!.id }, include: scheduleInclude, orderBy: { createdAt: 'desc' } });
    res.json({ success: true, data: await Promise.all(schedules.map(summary)) });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const s = await findOwn(req);
    const [queuedIdeas, usedIdeas, queue] = await Promise.all([
      prisma.scheduleIdea.findMany({ where: { scheduleId: s.id, status: 'QUEUED' }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }),
      prisma.scheduleIdea.findMany({ where: { scheduleId: s.id, status: 'USED' }, orderBy: { usedAt: 'desc' }, take: 20 }),
      prisma.post.findMany({
        where: { scheduleId: s.id, scheduleQueued: true, status: { in: PENDING_STATUSES } },
        orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, status: true, scheduledAt: true, caption: true, imageUrl: true, videoUrl: true, errorMessage: true, approvedAt: true },
      }),
    ]);
    res.json({ success: true, data: { ...(await summary(s)), ideas: [...queuedIdeas, ...usedIdeas], queue } });
  })
);

router.post(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = createSchema.parse(req.body);
    const userId = req.user!.id;
    const pageIds = await ownPages(userId, data.pageIds);
    const picked = await resolveDomainFormat(userId, { domainId: data.domainId, formatId: data.formatId, pageId: pageIds[0] });
    const startDate = data.startDate ? new Date(data.startDate) : new Date();
    const endDate = data.endDate ? endOfDay(data.endDate) : null;
    if (endDate && endDate <= startDate) throw createError(400, 'Ngày kết thúc phải sau ngày bắt đầu.');

    const created = await prisma.postSchedule.create({
      data: {
        userId,
        pageId: pageIds[0],
        name: data.name,
        frequency: 'SLOTS',
        timezone: VN_TZ,
        weekdays: data.weekdays,
        slots: data.slots,
        bufferSize: data.bufferSize,
        startDate,
        endDate,
        domainId: picked.domain.id,
        formatId: picked.format.id,
        pages: { create: pageIds.map((pageId) => ({ pageId })) },
      },
    });
    await addIdeas(created.id, data.ideas ?? []);
    const s = await prisma.postSchedule.findUniqueOrThrow({ where: { id: created.id }, include: scheduleInclude });
    res.status(201).json({ success: true, data: await summary(s) });
  })
);

router.put(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = updateSchema.parse(req.body);
    const s = await findOwn(req);
    const userId = req.user!.id;
    const pageIds = data.pageIds ? await ownPages(userId, data.pageIds) : null;
    const picked =
      data.domainId || data.formatId
        ? await resolveDomainFormat(userId, { domainId: data.domainId, formatId: data.formatId, pageId: pageIds?.[0] ?? s.pageId })
        : null;
    const startDate = data.startDate ? new Date(data.startDate) : s.startDate;
    const endDate = data.endDate === undefined ? s.endDate : data.endDate ? endOfDay(data.endDate) : null;
    if (endDate && endDate <= startDate) throw createError(400, 'Ngày kết thúc phải sau ngày bắt đầu.');

    await prisma.$transaction([
      prisma.postSchedule.update({
        where: { id: s.id },
        data: {
          ...(data.name && { name: data.name }),
          ...(data.weekdays && { weekdays: data.weekdays }),
          ...(data.slots && { slots: data.slots }),
          ...(data.bufferSize && { bufferSize: data.bufferSize }),
          startDate,
          endDate,
          ...(pageIds && { pageId: pageIds[0] }),
          ...(picked && { domainId: picked.domain.id, formatId: picked.format.id }),
        },
      }),
      ...(pageIds
        ? [
            prisma.schedulePage.deleteMany({ where: { scheduleId: s.id } }),
            prisma.schedulePage.createMany({ data: pageIds.map((pageId) => ({ scheduleId: s.id, pageId })) }),
          ]
        : []),
    ]);
    // New times: the posts already waiting move to the new slots (an edit that keeps them moves nothing)
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const timingChanged =
      (data.weekdays && !same(data.weekdays, s.weekdays)) ||
      (data.slots && !same(data.slots, s.slots)) ||
      startDate.getTime() !== s.startDate.getTime() ||
      (endDate?.getTime() ?? null) !== (s.endDate?.getTime() ?? null);
    if (timingChanged) await reslot(s.id);
    const updated = await prisma.postSchedule.findUniqueOrThrow({ where: { id: s.id }, include: scheduleInclude });
    res.json({ success: true, data: await summary(updated) });
  })
);

router.patch(
  '/:id/toggle',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const s = await findOwn(req);
    await prisma.postSchedule.update({ where: { id: s.id }, data: { isActive: !s.isActive } });
    // Back on: late posts move to the next slots instead of going out at once
    if (!s.isActive) await reslot(s.id);
    const updated = await prisma.postSchedule.findUniqueOrThrow({ where: { id: s.id }, include: scheduleInclude });
    res.json({ success: true, data: await summary(updated) });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const s = await findOwn(req);
    // The written posts are the user's: they stay, as normal posts waiting for approval
    await prisma.post.updateMany({
      where: { scheduleId: s.id, scheduleQueued: true, status: 'SCHEDULED' },
      data: { status: 'READY', approvedAt: null },
    });
    await prisma.post.updateMany({ where: { scheduleId: s.id, scheduleQueued: true }, data: { scheduleQueued: false } });
    await prisma.postSchedule.delete({ where: { id: s.id } });
    res.json({ success: true, message: 'Đã xoá lịch đăng.' });
  })
);

// ─── Idea queue ─────────────────────────────────

router.post(
  '/:id/ideas',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { texts } = z.object({ texts: z.array(z.string()).min(1).max(50, 'Tối đa 50 ý tưởng mỗi lần') }).parse(req.body);
    const s = await findOwn(req);
    const added = await addIdeas(s.id, texts);
    if (!added) throw createError(400, 'Chưa có ý tưởng nào hợp lệ (mỗi ý tưởng từ 3 ký tự).');
    res.json({ success: true, data: { added } });
  })
);

router.delete(
  '/:id/ideas/:ideaId',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const s = await findOwn(req);
    const idea = await prisma.scheduleIdea.findFirst({ where: { id: req.params.ideaId, scheduleId: s.id } });
    if (!idea) throw createError(404, 'Không tìm thấy ý tưởng.');
    if (idea.status !== 'QUEUED') throw createError(400, 'Ý tưởng này đã được dùng để viết bài.');
    await prisma.scheduleIdea.delete({ where: { id: idea.id } });
    res.json({ success: true });
  })
);

router.put(
  '/:id/ideas/order',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { ids } = z.object({ ids: z.array(z.string().uuid()).max(1000) }).parse(req.body);
    const s = await findOwn(req);
    const queued = await prisma.scheduleIdea.findMany({ where: { scheduleId: s.id, status: 'QUEUED' }, select: { id: true } });
    const known = new Set(queued.map((i) => i.id));
    if (ids.length !== known.size || !ids.every((id) => known.has(id))) {
      throw createError(400, 'Danh sách ý tưởng đã thay đổi, hãy tải lại trang.');
    }
    await prisma.$transaction(ids.map((id, position) => prisma.scheduleIdea.update({ where: { id }, data: { position } })));
    res.json({ success: true });
  })
);

router.post(
  '/:id/ideas/suggest',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const s = await findOwn(req);
    const { domain, format } = await formatForPost({ userId: req.user!.id, pageId: s.pageId, formatId: s.formatId });
    const [ideas, posts] = await Promise.all([
      prisma.scheduleIdea.findMany({ where: { scheduleId: s.id }, orderBy: { createdAt: 'desc' }, take: 60, select: { text: true } }),
      prisma.post.findMany({ where: { scheduleId: s.id, caption: { not: null } }, orderBy: { createdAt: 'desc' }, take: 20, select: { caption: true } }),
    ]);
    // What was already queued or written: the first line of a post is its topic
    const avoid = [...ideas.map((i) => i.text), ...posts.map((p) => p.caption!.split('\n')[0].slice(0, 150))];
    const settings = await getSettings(req.user!.id);
    try {
      const suggested = await suggestIdeas({ apiKey: settings.geminiApiKey, model: settings.geminiModel }, { domain, format, avoid });
      res.json({ success: true, data: { ideas: suggested } });
    } catch (error) {
      throw createError(502, `AI chưa gợi ý được: ${(error as Error).message}`);
    }
  })
);

export default router;
