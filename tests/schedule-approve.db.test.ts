import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { runScheduleTick } from '../src/services/schedule-runner';
import { saveSettings } from '../src/lib/settings';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;
let cookie: string;
let userId: string;
let pageId: string;
let scheduleId: string;

async function waiting(status: 'READY' | 'DRAFT' = 'READY', at = new Date(Date.now() + 3600_000)) {
  return prisma.post.create({
    data: {
      userId,
      pageId,
      scheduleId,
      scheduleQueued: true,
      scheduledAt: at,
      status,
      caption: status === 'READY' ? 'Bài' : null,
      targets: { create: { pageId } },
    },
  });
}

describe.skipIf(!process.env.RUN_DB_TESTS)('approving schedule posts', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    server = await startTestServer(createApp());
    const u = await createTestUser();
    cookie = u.cookie;
    userId = u.user.id;
    await saveSettings(userId, { fbAppId: '222' });
    pageId = (
      await prisma.facebookPage.create({
        data: { userId, pageId: `APR_${Date.now()}`, pageName: 'P', pageAccessToken: 'EAAfaketokenapprovexxxxxxxxxxxxxxxx', tokenStatus: 'VALID', tokenAppId: '222' },
      })
    ).id;
    scheduleId = (
      await prisma.postSchedule.create({
        data: {
          userId,
          pageId,
          name: 'L',
          frequency: 'SLOTS',
          weekdays: [0, 1, 2, 3, 4, 5, 6],
          slots: ['08:00'],
          bufferSize: 1,
          startDate: new Date(),
          pages: { create: { pageId } },
        },
      })
    ).id;
  });
  afterAll(async () => {
    const posts = await prisma.post.findMany({ where: { userId }, select: { id: true } });
    await prisma.job.deleteMany({ where: { OR: posts.map((p) => ({ payload: { path: '$.postId', equals: p.id } })) } });
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('approves a written post for its slot', async () => {
    const post = await waiting();
    const res = await api(server.baseUrl, 'POST', `/api/posts/${post.id}/approve`, { cookie });
    expect(res.status).toBe(200);
    expect(await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: 'SCHEDULED', scheduleQueued: true });
    const detail = await api(server.baseUrl, 'GET', `/api/posts/${post.id}`, { cookie });
    expect(detail.json.data).toMatchObject({ scheduleQueued: true, schedule: { id: scheduleId, name: 'L' } });
  });

  it('refuses posts that are not written yet or not from a schedule', async () => {
    const draft = await waiting('DRAFT');
    expect((await api(server.baseUrl, 'POST', `/api/posts/${draft.id}/approve`, { cookie })).status).toBe(400);
    const normal = await prisma.post.create({ data: { userId, pageId, status: 'READY', caption: 'x' } });
    expect((await api(server.baseUrl, 'POST', `/api/posts/${normal.id}/approve`, { cookie })).status).toBe(400);
  });

  it('refuses when a Page of the post cannot publish (App changed)', async () => {
    const post = await waiting();
    await saveSettings(userId, { fbAppId: '333' });
    const res = await api(server.baseUrl, 'POST', `/api/posts/${post.id}/approve`, { cookie });
    await saveSettings(userId, { fbAppId: '222' });
    expect(res.status).toBe(409);
  });

  it('"Đăng ngay" takes the post out of the schedule: the tick never publishes it again', async () => {
    const post = await waiting('READY', new Date(Date.now() - 60_000));
    expect((await api(server.baseUrl, 'POST', `/api/posts/${post.id}/publish`, { cookie, body: {} })).status).toBe(200);
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).scheduleQueued).toBe(false);
    await prisma.post.update({ where: { id: post.id }, data: { status: 'SCHEDULED' } }); // even if it looked approved
    await runScheduleTick(new Date(), { id: scheduleId });
    expect(await prisma.job.count({ where: { type: 'publish_post', payload: { path: '$.postId', equals: post.id } } })).toBe(1);
  });
});
