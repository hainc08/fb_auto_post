import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { createStarterDomains } from '../src/lib/domains';
import { saveSettings } from '../src/lib/settings';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;

/** A user with one postable Page, a domain and products (Graph never called: token already VALID for the saved App ID) */
async function setup() {
  const u = await createTestUser();
  await saveSettings(u.user.id, { fbAppId: '111' });
  await createStarterDomains(u.user.id);
  const page = await prisma.facebookPage.create({
    data: { userId: u.user.id, pageId: `PP_${Date.now()}_${Math.random()}`, pageName: 'Nhà nông', pageAccessToken: 'EAAfaketokenpostproductsxxxxxxxxx', tokenStatus: 'VALID', tokenAppId: '111' },
  });
  const make = (name: string, extra: Record<string, unknown> = {}) =>
    prisma.affiliateProduct.create({ data: { userId: u.user.id, platform: 'SHOPEE', name, url: `https://s.shopee.vn/${encodeURIComponent(name)}`, ...extra } });
  return { ...u, page, make };
}

const createPost = (s: Awaited<ReturnType<typeof setup>>, productIds?: string[]) =>
  api(server.baseUrl, 'POST', '/api/posts', { cookie: s.cookie, body: { pageIds: [s.page.id], caption: 'Bài viết', ...(productIds && { productIds }) } });

describe.skipIf(!process.env.RUN_DB_TESTS)('products attached to posts', { timeout: 90_000 }, () => {
  beforeAll(async () => {
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('creates a post with two products in the chosen order and returns its link block', async () => {
    const s = await setup();
    const a = await s.make('A');
    const b = await s.make('B');
    const res = await createPost(s, [b.id, a.id]);
    expect(res.status).toBe(201);
    expect(res.json.data.products.map((p: { id: string }) => p.id)).toEqual([b.id, a.id]);
    expect(res.json.data.affiliateBlock).toBe('🛒 Mua ở đây:\n👉 B (Shopee): https://s.shopee.vn/B\n👉 A (Shopee): https://s.shopee.vn/A');
    const got = await api(server.baseUrl, 'GET', `/api/posts/${res.json.data.id}`, { cookie: s.cookie });
    expect(got.json.data.products.map((p: { name: string }) => p.name)).toEqual(['B', 'A']);
    expect(got.json.data.affiliateBlock).toBe(res.json.data.affiliateBlock);
    // attaching marks them used, so the picker suggests other products next
    expect((await prisma.affiliateProduct.findUniqueOrThrow({ where: { id: a.id } })).lastUsedAt).toBeInstanceOf(Date);
  });

  it('PATCH replaces the products; an empty list removes them; without productIds they stay', async () => {
    const s = await setup();
    const a = await s.make('A');
    const b = await s.make('B');
    const id = (await createPost(s, [a.id])).json.data.id;
    const patch = (body: Record<string, unknown>) => api(server.baseUrl, 'PATCH', `/api/posts/${id}`, { cookie: s.cookie, body });

    expect((await patch({ productIds: [b.id] })).json.data.products.map((p: { id: string }) => p.id)).toEqual([b.id]);
    expect((await patch({ caption: 'Sửa caption' })).json.data.products.map((p: { id: string }) => p.id)).toEqual([b.id]);
    const cleared = await patch({ productIds: [] });
    expect(cleared.json.data.products).toEqual([]);
    expect(cleared.json.data.affiliateBlock).toBe('');
  });

  it('a product of another user or an archived product is 404 and nothing changes', async () => {
    const s = await setup();
    const other = await setup();
    const mine = await s.make('Mine');
    const archived = await s.make('Cũ', { isArchived: true });
    const theirs = await other.make('Theirs');
    const before = await prisma.post.count({ where: { userId: s.user.id } });

    for (const ids of [[theirs.id], [archived.id]]) {
      const res = await createPost(s, ids);
      expect(res.status).toBe(404);
      expect(res.json.error).toBe('Không tìm thấy sản phẩm.');
    }
    expect(await prisma.post.count({ where: { userId: s.user.id } })).toBe(before);

    const id = (await createPost(s, [mine.id])).json.data.id;
    const res = await api(server.baseUrl, 'PATCH', `/api/posts/${id}`, { cookie: s.cookie, body: { productIds: [theirs.id] } });
    expect(res.status).toBe(404);
    expect((await prisma.postProduct.findMany({ where: { postId: id } })).map((p) => p.productId)).toEqual([mine.id]);
  });

  it('an archived product already on the post can stay while the others change; it cannot be newly attached', async () => {
    const s = await setup();
    const a = await s.make('A');
    const b = await s.make('B');
    const c = await s.make('C');
    const id = (await createPost(s, [a.id, b.id])).json.data.id;
    await prisma.affiliateProduct.update({ where: { id: a.id }, data: { isArchived: true } });
    const patch = (productIds: string[]) => api(server.baseUrl, 'PATCH', `/api/posts/${id}`, { cookie: s.cookie, body: { productIds } });

    const kept = await patch([a.id, c.id]);
    expect(kept.status).toBe(200);
    expect(kept.json.data.products.map((p: { id: string }) => p.id)).toEqual([a.id, c.id]);
    // once removed, an archived product cannot come back
    expect((await patch([c.id])).status).toBe(200);
    expect((await patch([a.id, c.id])).status).toBe(404);
  });

  it('four products are refused (400)', async () => {
    const s = await setup();
    const ids = [];
    for (const n of ['A', 'B', 'C', 'D']) ids.push((await s.make(n)).id);
    expect((await createPost(s, ids)).status).toBe(400);
  });

  it("a published post's products cannot be changed (400)", async () => {
    const s = await setup();
    const a = await s.make('A');
    const id = (await createPost(s)).json.data.id;
    await prisma.post.update({ where: { id }, data: { status: 'PUBLISHED' } });
    const res = await api(server.baseUrl, 'PATCH', `/api/posts/${id}`, { cookie: s.cookie, body: { productIds: [a.id] } });
    expect(res.status).toBe(400);
    expect(await prisma.postProduct.count({ where: { postId: id } })).toBe(0);
  });
});
