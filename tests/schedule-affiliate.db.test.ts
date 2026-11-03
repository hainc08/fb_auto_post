import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { createStarterDomains } from '../src/lib/domains';
import { runScheduleTick } from '../src/services/schedule-runner';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;
// Friday 2026-09-25 10:00 Vietnam; slots every day 08:00 and 19:30
const NOW = new Date('2026-09-25T03:00:00Z');

async function setup(opts: { rotate: boolean; products?: string[] }) {
  const { user, cookie } = await createTestUser();
  const page = await prisma.facebookPage.create({ data: { userId: user.id, pageId: `SA_${Date.now()}_${Math.random()}`, pageName: 'P', pageAccessToken: 'x' } });
  const domain = await prisma.contentDomain.create({ data: { userId: user.id, name: `SA ${Math.random()}` } });
  const made = [];
  for (const [i, name] of (opts.products ?? []).entries()) {
    made.push(await prisma.affiliateProduct.create({ data: { userId: user.id, domainId: domain.id, platform: 'SHOPEE', name, url: `https://s.shopee.vn/${name}`, createdAt: new Date(Date.now() + i * 1000) } }));
  }
  // a product of another domain is never rotated in
  await prisma.affiliateProduct.create({ data: { userId: user.id, platform: 'LAZADA', name: 'Khác', url: 'https://c.lazada.vn/x' } });
  const schedule = await prisma.postSchedule.create({
    data: {
      userId: user.id,
      pageId: page.id,
      domainId: domain.id,
      name: 'Lịch',
      frequency: 'SLOTS',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      slots: ['08:00', '19:30'],
      bufferSize: 3,
      startDate: new Date('2026-09-01T00:00:00Z'),
      affiliateRotate: opts.rotate,
      pages: { create: { pageId: page.id } },
      ideas: { create: [0, 1, 2].map((i) => ({ text: `Ý tưởng ${i + 1}`, position: i })) },
    },
  });
  return { user, cookie, schedule, products: made };
}

/** The schedule's posts in slot order, with their product names */
async function postsOf(scheduleId: string) {
  const posts = await prisma.post.findMany({ where: { scheduleId }, orderBy: { scheduledAt: 'asc' }, include: { products: { include: { product: true } } } });
  // the prepare_post jobs of these posts are not run here
  await prisma.job.deleteMany({ where: { OR: posts.map((p) => ({ payload: { path: '$.postId', equals: p.id } })) } });
  return posts.map((p) => p.products.map((pp) => pp.product.name));
}

/** A post of the schedule waiting in its queue (written, not yet published) */
async function queued(s: Awaited<ReturnType<typeof setup>>, scheduleId: string, minutes: number, data: Record<string, unknown> = {}) {
  return prisma.post.create({
    data: {
      userId: s.user.id,
      pageId: s.schedule.pageId,
      scheduleId,
      scheduleQueued: true,
      scheduledAt: new Date(NOW.getTime() + minutes * 60_000),
      status: 'READY',
      caption: 'Bài đã viết',
      targets: { create: { pageId: s.schedule.pageId } },
      ...data,
    },
  });
}

const namesOf = async (postId: string) =>
  (await prisma.postProduct.findMany({ where: { postId }, orderBy: { sortOrder: 'asc' }, include: { product: true } })).map((p) => p.product.name);

describe.skipIf(!process.env.RUN_DB_TESTS)('schedules rotating affiliate products', { timeout: 90_000 }, () => {
  beforeAll(async () => {
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it("a rotating schedule gives its posts the domain's products in turn", async () => {
    const s = await setup({ rotate: true, products: ['A', 'B'] });
    await runScheduleTick(NOW, { id: s.schedule.id });
    expect(await postsOf(s.schedule.id)).toEqual([['A'], ['B'], ['A']]);
  });

  it('a schedule without rotation writes posts without products', async () => {
    const s = await setup({ rotate: false, products: ['A'] });
    await runScheduleTick(NOW, { id: s.schedule.id });
    expect(await postsOf(s.schedule.id)).toEqual([[], [], []]);
  });

  it('a rotating schedule whose domain has no active product still writes its posts', async () => {
    const s = await setup({ rotate: true, products: ['Cũ'] });
    await prisma.affiliateProduct.updateMany({ where: { id: s.products[0].id }, data: { isArchived: true } });
    await runScheduleTick(NOW, { id: s.schedule.id });
    expect(await postsOf(s.schedule.id)).toEqual([[], [], []]);
  });

  it('PUT /api/schedules/:id { affiliateRotate: true } is saved and returned', async () => {
    const { user, cookie } = await createTestUser();
    await createStarterDomains(user.id);
    const page = await prisma.facebookPage.create({ data: { userId: user.id, pageId: `SA_${Date.now()}`, pageName: 'P', pageAccessToken: 'x' } });
    const created = await api(server.baseUrl, 'POST', '/api/schedules', { cookie, body: { pageIds: [page.id], name: 'Lịch', weekdays: [1], slots: ['08:00'] } });
    expect(created.status).toBe(201);
    expect(created.json.data.affiliateRotate).toBe(false);
    const res = await api(server.baseUrl, 'PUT', `/api/schedules/${created.json.data.id}`, { cookie, body: { affiliateRotate: true } });
    expect(res.status).toBe(200);
    expect(res.json.data.affiliateRotate).toBe(true);
    const withIt = await api(server.baseUrl, 'POST', '/api/schedules', { cookie, body: { pageIds: [page.id], name: 'Lịch 2', weekdays: [1], slots: ['08:00'], affiliateRotate: true } });
    expect(withIt.json.data.affiliateRotate).toBe(true);
  });

  const put = (s: Awaited<ReturnType<typeof setup>>, body: Record<string, unknown>) => api(server.baseUrl, 'PUT', `/api/schedules/${s.schedule.id}`, { cookie: s.cookie, body });

  it('attaches products to the posts waiting in the queue, in slot order', async () => {
    const s = await setup({ rotate: false, products: ['A', 'B'] });
    const third = await queued(s, s.schedule.id, 180, { status: 'DRAFT' });
    const first = await queued(s, s.schedule.id, 60, { status: 'READY' });
    const second = await queued(s, s.schedule.id, 120, { status: 'SCHEDULED', approvedAt: new Date() });
    const res = await put(s, { affiliateRotate: true });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ affiliateRotate: true, attachedProducts: 3 });
    expect([await namesOf(first.id), await namesOf(second.id), await namesOf(third.id)]).toEqual([['A'], ['B'], ['A']]);
  });

  it('leaves posts that have products, are being written or published, left the queue or belong to another schedule', async () => {
    const s = await setup({ rotate: false, products: ['A', 'B'] });
    const other = await prisma.postSchedule.create({
      data: { userId: s.user.id, pageId: s.schedule.pageId, domainId: s.schedule.domainId, name: 'Lịch khác', frequency: 'SLOTS', weekdays: [1], slots: ['08:00'], startDate: new Date('2026-09-01T00:00:00Z'), pages: { create: { pageId: s.schedule.pageId } } },
    });
    const own = await queued(s, s.schedule.id, 60);
    const manual = await queued(s, s.schedule.id, 90);
    const manualProduct = await prisma.affiliateProduct.create({ data: { userId: s.user.id, platform: 'TIKTOK', name: 'X', url: 'https://vt.tiktok.com/x' } });
    await prisma.postProduct.create({ data: { postId: manual.id, productId: manualProduct.id } });
    const writing = await queued(s, s.schedule.id, 100, { status: 'GENERATING' });
    const publishing = await queued(s, s.schedule.id, 110, { status: 'PUBLISHING' });
    const left = await queued(s, s.schedule.id, 120, { scheduleQueued: false });
    const foreign = await queued(s, other.id, 130);
    const res = await put(s, { affiliateRotate: true });
    expect(res.json.data.attachedProducts).toBe(1);
    expect(await namesOf(own.id)).toEqual(['A']);
    expect(await namesOf(manual.id)).toEqual(['X']);
    for (const untouched of [writing, publishing, left, foreign]) expect(await namesOf(untouched.id)).toEqual([]);
  });

  it('saving again while it is on, other edits and turning it off attach or detach nothing', async () => {
    const s = await setup({ rotate: false, products: ['A', 'B'] });
    const first = await queued(s, s.schedule.id, 60);
    expect((await put(s, { affiliateRotate: true })).json.data.attachedProducts).toBe(1);
    const later = await queued(s, s.schedule.id, 120);
    for (const body of [{ affiliateRotate: true }, { name: 'Đổi tên' }, { affiliateRotate: false }]) {
      const res = await put(s, body);
      expect(res.status).toBe(200);
      expect(res.json.data.attachedProducts).toBe(0);
    }
    expect(await namesOf(later.id)).toEqual([]);
    expect(await namesOf(first.id)).toEqual(['A']);
  });

  it('turning it on with no active product in the domain attaches nothing and still saves', async () => {
    const s = await setup({ rotate: false, products: ['Cũ'] });
    await prisma.affiliateProduct.updateMany({ where: { id: s.products[0].id }, data: { isArchived: true } });
    const waiting = await queued(s, s.schedule.id, 60);
    const res = await put(s, { affiliateRotate: true });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ affiliateRotate: true, attachedProducts: 0 });
    expect(await namesOf(waiting.id)).toEqual([]);
  });
});
