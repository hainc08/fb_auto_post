import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate, requirePlan } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { removeScheduleJob, syncScheduleJob } from '../services/scheduler.service';

const router = Router();
router.use(authenticate);

// ─── Validation Schemas ─────────────────────────

const createScheduleSchema = z.object({
  pageId: z.string().uuid(),
  name: z.string().min(1).max(100),
  // Custom cron is no longer supported: the job queue computes runs in Vietnam time
  frequency: z.enum(['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY']),
  timezone: z.string().optional().default('Asia/Ho_Chi_Minh'),
  startDate: z.string().datetime(),
  endDate: z.string().datetime().optional(),
  templateId: z.string().uuid().optional(),
  inputData: z.record(z.string()).optional(),
  autoGenImage: z.boolean().optional().default(true),
});

// ─── List Schedules ─────────────────────────────

router.get(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const schedules = await prisma.postSchedule.findMany({
      where: { userId: req.user!.id },
      include: {
        page: { select: { id: true, pageName: true, pageAvatar: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, data: schedules });
  })
);

// ─── Create Schedule ────────────────────────────

router.post(
  '/',
  requirePlan('PRO', 'BUSINESS', 'ENTERPRISE'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = createScheduleSchema.parse(req.body);
    const userId = req.user!.id;

    // Verify page ownership
    const page = await prisma.facebookPage.findFirst({
      where: { id: data.pageId, userId, isActive: true },
    });
    if (!page) throw createError(404, 'Page not found');

    const startDate = new Date(data.startDate);
    const endDate = data.endDate ? new Date(data.endDate) : undefined;
    if (endDate && endDate <= startDate) throw createError(400, 'Ngày kết thúc phải sau thời điểm bắt đầu.');
    if (data.frequency === 'ONCE' && startDate <= new Date()) {
      throw createError(400, 'Thời điểm đăng đã qua, hãy chọn thời điểm trong tương lai.');
    }

    const schedule = await prisma.postSchedule.create({
      data: {
        userId,
        pageId: data.pageId,
        name: data.name,
        frequency: data.frequency,
        timezone: data.timezone!,
        startDate,
        endDate,
        templateId: data.templateId,
        inputData: data.inputData || undefined,
        autoGenImage: data.autoGenImage!,
      },
      include: {
        page: { select: { id: true, pageName: true } },
      },
    });

    const nextRunAt = await syncScheduleJob(schedule);

    res.status(201).json({ success: true, data: { ...schedule, nextRunAt } });
  })
);

// ─── Update Schedule ────────────────────────────

router.put(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = createScheduleSchema.partial().parse(req.body);

    const schedule = await prisma.postSchedule.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });

    if (!schedule) throw createError(404, 'Schedule not found');

    const updated = await prisma.postSchedule.update({
      where: { id: req.params.id },
      data: {
        ...data,
        startDate: data.startDate ? new Date(data.startDate) : undefined,
        endDate: data.endDate ? new Date(data.endDate) : undefined,
      },
    });

    // Any change (time, frequency, end date) moves the next run
    const nextRunAt = await syncScheduleJob(updated);

    res.json({ success: true, data: { ...updated, nextRunAt } });
  })
);

// ─── Toggle Schedule Active ─────────────────────

router.patch(
  '/:id/toggle',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const schedule = await prisma.postSchedule.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });

    if (!schedule) throw createError(404, 'Schedule not found');

    const updated = await prisma.postSchedule.update({
      where: { id: req.params.id },
      data: { isActive: !schedule.isActive },
    });

    const nextRunAt = await syncScheduleJob(updated);

    res.json({ success: true, data: { ...updated, nextRunAt } });
  })
);

// ─── Delete Schedule ────────────────────────────

router.delete(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const schedule = await prisma.postSchedule.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });

    if (!schedule) throw createError(404, 'Schedule not found');

    await removeScheduleJob(schedule.id);
    await prisma.postSchedule.delete({ where: { id: schedule.id } });

    res.json({ success: true, message: 'Schedule deleted' });
  })
);

export default router;
