import { describe, it, expect, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { migrateLegacySchedules } from '../src/lib/schedule-migrate';
import { cleanupTestUsers, createTestUser } from './helpers/users';

// Friday 2026-09-25 09:30 in Vietnam
const START = new Date('2026-09-25T02:30:00Z');

describe.skipIf(!process.env.RUN_DB_TESTS)('migrateLegacySchedules', () => {
  afterAll(async () => {
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('converts old schedules to slots once, keeping their idea and Page', async () => {
    const { user } = await createTestUser();
    const page = await prisma.facebookPage.create({
      data: { userId: user.id, pageId: `MIG_${Date.now()}`, pageName: 'P', pageAccessToken: 'EAAfaketokenmigratexxxxxxxxxxxxxxxx' },
    });
    const make = (frequency: 'DAILY' | 'WEEKLY' | 'ONCE', name: string) =>
      prisma.postSchedule.create({
        data: { userId: user.id, pageId: page.id, name, frequency, startDate: START, inputData: { basicInfo: `Ý tưởng ${name}` } },
      });
    const daily = await make('DAILY', 'Ngày');
    const weekly = await make('WEEKLY', 'Tuần');
    const once = await make('ONCE', 'Một lần');
    await prisma.job.create({ data: { key: `schedule:${daily.id}`, type: 'run_schedule', payload: { scheduleId: daily.id }, runAt: START } });

    expect(await migrateLegacySchedules({ userId: user.id })).toBe(3);
    expect(await migrateLegacySchedules({ userId: user.id })).toBe(0); // idempotent

    const d = await prisma.postSchedule.findUniqueOrThrow({ where: { id: daily.id }, include: { pages: true, ideas: true } });
    expect(d).toMatchObject({ frequency: 'SLOTS', weekdays: [0, 1, 2, 3, 4, 5, 6], slots: ['09:30'], isActive: true, bufferSize: 3 });
    expect(d.pages.map((p) => p.pageId)).toEqual([page.id]);
    expect(d.ideas.map((i) => i.text)).toEqual(['Ý tưởng Ngày']);
    expect(await prisma.job.findUnique({ where: { key: `schedule:${daily.id}` } })).toBeNull();

    expect(await prisma.postSchedule.findUniqueOrThrow({ where: { id: weekly.id } })).toMatchObject({ weekdays: [5], slots: ['09:30'], isActive: true });
    expect(await prisma.postSchedule.findUniqueOrThrow({ where: { id: once.id } })).toMatchObject({
      weekdays: [5],
      isActive: false,
      name: 'Một lần (cần xem lại)',
    });
  });
});
