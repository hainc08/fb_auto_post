import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate, requirePlan } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { addScheduleJob, removeScheduleJob } from '../services/scheduler.service';

const router = Router();
router.use(authenticate);

// ─── Validation Schemas ─────────────────────────

const createScheduleSchema = z.object({
  pageId: z.string().uuid(),
  name: z.string().min(1).max(100),
  frequency: z.enum(['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM_CRON']),
  cronExpr: z.string().optional(),
  timezone: z.string().optional().default('Asia/Ho_Chi_Minh'),
  startDate: z.string().datetime(),
  endDate: z.string().datetime().optional(),
  templateId: z.string().uuid().optional(),
  inputData: z.record(z.string()).optional(),
  autoGenImage: z.boolean().optional().default(true),
});

// ─── Frequency to Cron Expression ───────────────

function frequencyToCron(frequency: string, startDate: Date): string {
  const minutes = startDate.getMinutes();
  const hours = startDate.getHours();

  switch (frequency) {
    case 'DAILY':
      return `${minutes} ${hours} * * *`;
    case 'WEEKLY':
      return `${minutes} ${hours} * * ${startDate.getDay()}`;
    case 'MONTHLY':
      return `${minutes} ${hours} ${startDate.getDate()} * *`;
    case 'ONCE':
      return `${minutes} ${hours} ${startDate.getDate()} ${startDate.getMonth() + 1} *`;
    default:
      return `0 9 * * *`; // Default: 9 AM daily
  }
}

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

    // Resolve cron expression
    const cronExpr =
      data.frequency === 'CUSTOM_CRON' && data.cronExpr
        ? data.cronExpr
        : frequencyToCron(data.frequency, startDate);

    const schedule = await prisma.postSchedule.create({
      data: {
        userId,
        pageId: data.pageId,
        name: data.name,
        frequency: data.frequency as any,
        cronExpr,
        timezone: data.timezone!,
        startDate,
        endDate: data.endDate ? new Date(data.endDate) : undefined,
        templateId: data.templateId,
        inputData: data.inputData || undefined,
        autoGenImage: data.autoGenImage!,
        nextRunAt: startDate,
      },
      include: {
        page: { select: { id: true, pageName: true } },
      },
    });

    // Add to job queue
    await addScheduleJob(schedule.id, cronExpr, data.timezone!);

    res.status(201).json({ success: true, data: schedule });
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

    // Update job queue if cron changed
    if (data.cronExpr || data.frequency) {
      await removeScheduleJob(schedule.id);
      const newCron = data.cronExpr || updated.cronExpr || '0 9 * * *';
      await addScheduleJob(schedule.id, newCron, updated.timezone);
    }

    res.json({ success: true, data: updated });
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

    if (updated.isActive && updated.cronExpr) {
      await addScheduleJob(updated.id, updated.cronExpr, updated.timezone);
    } else {
      await removeScheduleJob(updated.id);
    }

    res.json({ success: true, data: updated });
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
