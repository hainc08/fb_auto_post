import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;
let cookie: string;
let userId: string;
let pageA: string;
let pageB: string;

const body = (extra: Record<string, unknown> = {}) => ({
  name: 'Lịch nhà nông',
  pageIds: [pageA, pageB],
  weekdays: [1, 3, 5],
  slots: ['08:00', '19:30'],
  ideas: ['Tưới lúa mùa khô', 'Phòng rầy nâu'],
  ...extra,
});

describe.skipIf(!process.env.RUN_DB_TESTS)('schedules API', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    server = await startTestServer(createApp());
    const u = await createTestUser();
    cookie = u.cookie;
    userId = u.user.id;
    const mk = (n: string) =>
      prisma.facebookPage.create({ data: { userId, pageId: `SCH_${n}_${Date.now()}`, pageName: n, pageAccessToken: 'EAAfaketokenschedulesapixxxxxxxxxxxx' } });
    pageA = (await mk('A')).id;
    pageB = (await mk('B')).id;
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('creates a slot schedule on several Pages with its ideas, for any plan', async () => {
    await prisma.user.update({ where: { id: userId }, data: { plan: 'FREE' } });
    const res = await api(server.baseUrl, 'POST', '/api/schedules', { cookie, body: body() });
    expect(res.status).toBe(201);
    expect(res.json.data).toMatchObject({ frequency: 'SLOTS', weekdays: [1, 3, 5], slots: ['08:00', '19:30'], bufferSize: 3, ideasLeft: 2 });
    expect(res.json.data.pages.map((p: { id: string }) => p.id).sort()).toEqual([pageA, pageB].sort());
    expect(res.json.data.nextSlotAt).not.toBeNull();
  });

  it('rejects bad weekdays, slots and buffer sizes in Vietnamese', async () => {
    for (const bad of [{ weekdays: [] }, { weekdays: [7] }, { slots: [] }, { slots: ['8h'] }, { slots: ['08:00', '09:00', '10:00', '11:00'] }, { bufferSize: 9 }]) {
      const res = await api(server.baseUrl, 'POST', '/api/schedules', { cookie, body: body(bad) });
      expect(res.status).toBe(400);
    }
    const res = await api(server.baseUrl, 'POST', '/api/schedules', { cookie, body: body({ slots: ['08:00', '08:00'] }) });
    expect(res.json.details[0].message).toMatch(/khung giờ/i); // the client shows details[0]
  });

  it('changing the slots moves the posts already waiting, in order', async () => {
    const created = (await api(server.baseUrl, 'POST', '/api/schedules', { cookie, body: body({ ideas: [] }) })).json.data;
    const future = (h: number) => new Date(Date.now() + h * 3600_000);
    const p1 = await prisma.post.create({ data: { userId, pageId: pageA, scheduleId: created.id, scheduleQueued: true, scheduledAt: future(30), status: 'READY', caption: '1' } });
    const p2 = await prisma.post.create({ data: { userId, pageId: pageA, scheduleId: created.id, scheduleQueued: true, scheduledAt: future(60), status: 'SCHEDULED', caption: '2' } });
    const res = await api(server.baseUrl, 'PUT', `/api/schedules/${created.id}`, { cookie, body: { weekdays: [0, 1, 2, 3, 4, 5, 6], slots: ['06:15'] } });
    expect(res.status).toBe(200);
    const [a, b] = await Promise.all([p1, p2].map((p) => prisma.post.findUniqueOrThrow({ where: { id: p.id } })));
    const vn = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(11, 16);
    expect([vn(a.scheduledAt!), vn(b.scheduledAt!)]).toEqual(['06:15', '06:15']);
    expect(a.scheduledAt!.getTime()).toBeLessThan(b.scheduledAt!.getTime());
  });

  it('manages the idea queue: add, reorder, delete (used ideas stay)', async () => {
    const created = (await api(server.baseUrl, 'POST', '/api/schedules', { cookie, body: body({ ideas: ['Aaa'] }) })).json.data;
    expect((await api(server.baseUrl, 'POST', `/api/schedules/${created.id}/ideas`, { cookie, body: { texts: ['Bbb', '  ', 'Ccc'] } })).json.data.added).toBe(2);
    let detail = (await api(server.baseUrl, 'GET', `/api/schedules/${created.id}`, { cookie })).json.data;
    const ids = detail.ideas.map((i: { id: string }) => i.id);
    expect(detail.ideas.map((i: { text: string }) => i.text)).toEqual(['Aaa', 'Bbb', 'Ccc']);

    await api(server.baseUrl, 'PUT', `/api/schedules/${created.id}/ideas/order`, { cookie, body: { ids: [ids[2], ids[0], ids[1]] } });
    detail = (await api(server.baseUrl, 'GET', `/api/schedules/${created.id}`, { cookie })).json.data;
    expect(detail.ideas.map((i: { text: string }) => i.text)).toEqual(['Ccc', 'Aaa', 'Bbb']);

    expect((await api(server.baseUrl, 'DELETE', `/api/schedules/${created.id}/ideas/${ids[0]}`, { cookie })).status).toBe(200);
    await prisma.scheduleIdea.update({ where: { id: ids[1] }, data: { status: 'USED' } });
    expect((await api(server.baseUrl, 'DELETE', `/api/schedules/${created.id}/ideas/${ids[1]}`, { cookie })).status).toBe(400);
  });

  it('deleting a schedule keeps its written posts as normal posts waiting for approval', async () => {
    const created = (await api(server.baseUrl, 'POST', '/api/schedules', { cookie, body: body({ ideas: [] }) })).json.data;
    const post = await prisma.post.create({
      data: { userId, pageId: pageA, scheduleId: created.id, scheduleQueued: true, scheduledAt: new Date(Date.now() + 3600_000), status: 'SCHEDULED', approvedAt: new Date(), caption: 'x' },
    });
    expect((await api(server.baseUrl, 'DELETE', `/api/schedules/${created.id}`, { cookie })).status).toBe(200);
    expect(await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: 'READY', scheduleQueued: false, scheduleId: null, approvedAt: null });
  });
});
