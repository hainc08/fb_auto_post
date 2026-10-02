import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { saveSettings } from '../src/lib/settings';
import { claimTimedPost } from '../src/lib/post-timing';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;
let cookie: string;
let userId: string;
let pageId: string;
let expiredPageId: string;

/** Three weeks ahead: if a run is killed before afterAll, no worker picks these jobs up for weeks (they carry fake tokens) */
const FAR_MS = 21 * 86_400_000;
const inHours = (h: number) => new Date(Math.floor(Date.now() / 60_000) * 60_000 + FAR_MS + h * 3600_000);
const draft = (data: Record<string, unknown> = {}, page = pageId) =>
  prisma.post.create({ data: { userId, pageId: page, caption: 'Bài viết tay', status: 'READY', targets: { create: { pageId: page } }, ...data } });
const row = (id: string) => prisma.post.findUniqueOrThrow({ where: { id } });
const jobsOf = (postId: string) => prisma.job.findMany({ where: { type: 'publish_post', payload: { path: '$.postId', equals: postId } }, orderBy: { runAt: 'asc' } });
const setTime = (id: string, at: Date, extra: Record<string, unknown> = {}) =>
  api(server.baseUrl, 'POST', `/api/posts/${id}/schedule`, { cookie, body: { scheduledAt: at.toISOString(), ...extra } });

describe.skipIf(!process.env.RUN_DB_TESTS)('timed posts: API', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    server = await startTestServer(createApp());
    const u = await createTestUser();
    cookie = u.cookie;
    userId = u.user.id;
    await saveSettings(userId, { fbAppId: '333' });
    const page = (suffix: string, tokenStatus: 'VALID' | 'EXPIRED') =>
      prisma.facebookPage.create({ data: { userId, pageId: `TMR_${Date.now()}_${suffix}`, pageName: `Page ${suffix}`, pageAccessToken: 'EAAfaketokentimedroutesxxxxxxxxxxxx', tokenStatus, tokenAppId: '333' } });
    pageId = (await page('ok', 'VALID')).id;
    expiredPageId = (await page('old', 'EXPIRED')).id;
  });
  afterAll(async () => {
    const posts = await prisma.post.findMany({ where: { userId }, select: { id: true } });
    if (posts.length) await prisma.job.deleteMany({ where: { OR: posts.map((p) => ({ payload: { path: '$.postId', equals: p.id } })) } });
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('times a written post: approved, waiting, one job at that time', async () => {
    const post = await draft();
    const at = inHours(5);
    const res = await setTime(post.id, at, { intervalMinutes: 3 });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ id: post.id, status: 'SCHEDULED', scheduledAt: at.toISOString(), pages: 1 });
    const saved = await row(post.id);
    expect(saved).toMatchObject({ status: 'SCHEDULED', scheduleQueued: false });
    expect(saved.scheduledAt?.toISOString()).toBe(at.toISOString());
    expect(saved.approvedAt).not.toBeNull();
    const jobs = await jobsOf(post.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].runAt.toISOString()).toBe(at.toISOString());
    // skipAiGeneration: the user approved what is on screen; AI never writes at the time
    expect(jobs[0].payload).toMatchObject({ scheduledFor: at.toISOString(), intervalMs: 180_000, skipAiGeneration: true });
    expect(await prisma.postLog.count({ where: { postId: post.id, action: 'scheduled' } })).toBe(1);
  });

  it('moving the time: the job of the old time can no longer take the post', async () => {
    const post = await draft();
    const first = inHours(5);
    const second = inHours(30);
    await setTime(post.id, first);
    expect((await setTime(post.id, second)).status).toBe(200);
    expect((await row(post.id)).scheduledAt?.toISOString()).toBe(second.toISOString());
    expect(await jobsOf(post.id)).toHaveLength(2);
    expect(await claimTimedPost(post.id, first)).toBe(false);
    expect(await claimTimedPost(post.id, second)).toBe(true);
  });

  it('cancelling puts the post back to "Chờ duyệt" and disarms the job', async () => {
    const post = await draft();
    const at = inHours(5);
    await setTime(post.id, at);
    const res = await api(server.baseUrl, 'DELETE', `/api/posts/${post.id}/schedule`, { cookie });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ status: 'READY', scheduledAt: null });
    expect(await row(post.id)).toMatchObject({ status: 'READY', scheduledAt: null, approvedAt: null });
    expect(await claimTimedPost(post.id, at)).toBe(false);
    expect((await api(server.baseUrl, 'DELETE', `/api/posts/${post.id}/schedule`, { cookie })).status).toBe(400);
  });

  it('a failed post can be timed again and its error is cleared', async () => {
    const post = await draft({ status: 'FAILED', errorMessage: 'Lỗi cũ', errorStep: 'publish' });
    expect((await setTime(post.id, inHours(2))).status).toBe(200);
    expect(await row(post.id)).toMatchObject({ status: 'SCHEDULED', errorMessage: null, errorStep: null });
  });

  it('refuses a time in the past, too far ahead, or malformed', async () => {
    const post = await draft();
    const past = await setTime(post.id, new Date(Date.now() - 3600_000));
    expect(past.status).toBe(400);
    expect(past.json.error).toMatch(/ít nhất 1 phút/);
    expect((await setTime(post.id, new Date(Date.now() + 91 * 86_400_000))).json.error).toMatch(/90 ngày/);
    expect((await api(server.baseUrl, 'POST', `/api/posts/${post.id}/schedule`, { cookie, body: { scheduledAt: 'mai' } })).status).toBe(400);
    expect((await row(post.id)).status).toBe('READY');
    expect(await jobsOf(post.id)).toHaveLength(0);
  });

  it('refuses a post of a slot schedule, a post with no content, and a post in progress', async () => {
    const owned = await draft({ scheduleQueued: true, scheduledAt: inHours(3) });
    const res = await setTime(owned.id, inHours(5));
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/lịch đăng/);
    const empty = await draft({ caption: null, status: 'DRAFT' });
    expect((await setTime(empty.id, inHours(5))).json.error).toMatch(/chưa có nội dung/);
    const busy = await draft({ status: 'PUBLISHING' });
    expect((await setTime(busy.id, inHours(5))).status).toBe(409);
    // …and its Pages are left alone, even when the request names other Pages
    const before = await prisma.postTarget.findMany({ where: { postId: busy.id }, select: { id: true } });
    const swap = await setTime(busy.id, inHours(5), { pageIds: [expiredPageId] });
    expect(swap.status).toBe(409);
    expect(swap.json.error).toMatch(/đang được xử lý/);
    expect(await prisma.postTarget.findMany({ where: { postId: busy.id }, select: { id: true } })).toEqual(before);
    const live = await draft({ status: 'PUBLISHED' });
    const again = await setTime(live.id, inHours(5));
    expect(again.status).toBe(400);
    expect(again.json.error).toMatch(/đã được đăng/);
    expect((await api(server.baseUrl, 'DELETE', `/api/posts/${owned.id}/schedule`, { cookie })).status).toBe(400);
  });

  it('a blocked Page refuses the time', async () => {
    const post = await draft({}, expiredPageId);
    const res = await setTime(post.id, inHours(5));
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/Page old/);
    expect((await row(post.id)).status).toBe('READY');
    expect(await jobsOf(post.id)).toHaveLength(0);
  });

  it('can change the Pages while setting the time', async () => {
    const second = await prisma.facebookPage.create({ data: { userId, pageId: `TMR_${Date.now()}_two`, pageName: 'Page two', pageAccessToken: 'EAAfaketokentimedroutesxxxxxxxxxxxx', tokenStatus: 'VALID', tokenAppId: '333' } });
    const post = await draft();
    const res = await setTime(post.id, inHours(5), { pageIds: [pageId, second.id] });
    expect(res.json.data.pages).toBe(2);
    expect(await prisma.postTarget.count({ where: { postId: post.id } })).toBe(2);
  });
});
