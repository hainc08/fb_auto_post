import type { Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { VN_TZ, wallTime } from './schedule-time';

export const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * Old schedules (ONCE/DAILY/WEEKLY/MONTHLY/CUSTOM_CRON, one idea, one Page) become
 * slot schedules: DAILY → every day, WEEKLY → startDate's weekday, at startDate's
 * time of day. The others are converted the WEEKLY way but paused for the user to
 * review. The old idea becomes the first queued idea. Idempotent.
 */
export async function migrateLegacySchedules(where: Prisma.PostScheduleWhereInput = {}): Promise<number> {
  const legacy = await prisma.postSchedule.findMany({ where: { ...where, frequency: { not: 'SLOTS' } } });
  for (const s of legacy) {
    const { weekday, hhmm } = wallTime(s.startDate, s.timezone || VN_TZ);
    const keepRunning = s.frequency === 'DAILY' || s.frequency === 'WEEKLY';
    const idea = ((s.inputData as Record<string, unknown> | null)?.basicInfo as string | undefined)?.trim();
    await prisma.$transaction([
      prisma.postSchedule.update({
        where: { id: s.id },
        data: {
          frequency: 'SLOTS',
          weekdays: s.frequency === 'DAILY' ? ALL_WEEKDAYS : [weekday],
          slots: [hhmm],
          nextRunAt: null,
          isActive: keepRunning && s.isActive,
          ...(!keepRunning && { name: `${s.name} (cần xem lại)`.slice(0, 100) }),
        },
      }),
      prisma.schedulePage.upsert({
        where: { scheduleId_pageId: { scheduleId: s.id, pageId: s.pageId } },
        create: { scheduleId: s.id, pageId: s.pageId },
        update: {},
      }),
      ...(idea ? [prisma.scheduleIdea.create({ data: { scheduleId: s.id, text: idea.slice(0, 500), position: 0 } })] : []),
      prisma.job.deleteMany({ where: { key: `schedule:${s.id}` } }),
    ]);
  }
  return legacy.length;
}
