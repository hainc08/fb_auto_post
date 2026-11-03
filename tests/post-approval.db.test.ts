import { describe, it, expect, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { saveSettings } from '../src/lib/settings';
import { approveSchedulePost } from '../src/services/post-approval';
import { cleanupTestUsers, createTestUser } from './helpers/users';

async function setup() {
  const { user } = await createTestUser();
  await saveSettings(user.id, { fbAppId: '444' });
  const page = await prisma.facebookPage.create({
    data: { userId: user.id, pageId: `PA_${Date.now()}_${Math.random()}`, pageName: 'P', pageAccessToken: 'EAAfaketokenapprovalxxxxxxxxxxxxxx', tokenStatus: 'VALID', tokenAppId: '444' },
  });
  const waiting = (data: Record<string, unknown> = {}) =>
    prisma.post.create({
      data: { userId: user.id, pageId: page.id, status: 'READY', scheduleQueued: true, scheduledAt: new Date(Date.now() + 3600_000), caption: 'Bài', targets: { create: { pageId: page.id } }, ...data },
    });
  return { user, waiting };
}

describe.skipIf(!process.env.RUN_DB_TESTS)('approve a schedule post (service)', { timeout: 60_000 }, () => {
  afterAll(async () => {
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('approves a written queued post: SCHEDULED, approvedAt set, one "approved" log', async () => {
    const s = await setup();
    const post = await s.waiting();
    const saved = await approveSchedulePost(s.user.id, post.id);
    expect(saved).toMatchObject({ id: post.id, status: 'SCHEDULED', approvedAt: expect.any(Date) });
    expect(await prisma.postLog.count({ where: { postId: post.id, action: 'approved' } })).toBe(1);
  });

  it("another member's post is 404 and untouched", async () => {
    const mine = await setup();
    const other = await setup();
    const theirs = await other.waiting();
    await expect(approveSchedulePost(mine.user.id, theirs.id)).rejects.toMatchObject({ statusCode: 404 });
    expect((await prisma.post.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe('READY');
  });

  it('a second approval of the same post is refused (400) and logs nothing more', async () => {
    const s = await setup();
    const post = await s.waiting();
    await approveSchedulePost(s.user.id, post.id);
    await expect(approveSchedulePost(s.user.id, post.id)).rejects.toMatchObject({ statusCode: 400 });
    expect(await prisma.postLog.count({ where: { postId: post.id, action: 'approved' } })).toBe(1);
  });

  it('a post with no slot left is refused (409)', async () => {
    const s = await setup();
    const post = await s.waiting({ scheduledAt: null });
    await expect(approveSchedulePost(s.user.id, post.id)).rejects.toMatchObject({ statusCode: 409 });
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe('READY');
  });
});
