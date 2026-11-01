import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;
const product = (extra: Record<string, unknown> = {}) => ({ platform: 'SHOPEE', name: 'Bình xịt 16L', url: 'https://s.shopee.vn/abc', ...extra });

async function member() {
  const { user, cookie } = await createTestUser();
  const domain = await prisma.contentDomain.create({ data: { userId: user.id, name: `Nông nghiệp ${Math.random()}` } });
  return { user, cookie, domain };
}

describe.skipIf(!process.env.RUN_DB_TESTS)('affiliate products API', { timeout: 90_000 }, () => {
  beforeAll(async () => {
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('creates, lists, edits and archives a product; blank price and highlights clear them', async () => {
    const { cookie, domain } = await member();
    const created = await api(server.baseUrl, 'POST', '/api/products', { cookie, body: product({ price: '450.000đ', highlights: 'pin 12 tiếng', domainId: domain.id }) });
    expect(created.status).toBe(201);
    expect(created.json.data).toMatchObject({ platform: 'SHOPEE', name: 'Bình xịt 16L', price: '450.000đ', domainId: domain.id, isArchived: false });
    const id = created.json.data.id;

    const listed = await api(server.baseUrl, 'GET', '/api/products', { cookie });
    expect(listed.json.data).toEqual([expect.objectContaining({ id, usedCount: 0 })]);

    const edited = await api(server.baseUrl, 'PATCH', `/api/products/${id}`, { cookie, body: { price: '', highlights: '', name: 'Bình xịt 20L' } });
    expect(edited.json.data).toMatchObject({ name: 'Bình xịt 20L', price: null, highlights: null });

    expect((await api(server.baseUrl, 'PATCH', `/api/products/${id}`, { cookie, body: { isArchived: true } })).json.data.isArchived).toBe(true);
    expect((await api(server.baseUrl, 'GET', '/api/products', { cookie })).json.data).toEqual([]);
    expect((await api(server.baseUrl, 'GET', '/api/products?archived=1', { cookie })).json.data).toHaveLength(1);
  });

  it('refuses a link that is not http(s), a name over 200 characters and an unknown platform (400)', async () => {
    const { cookie } = await member();
    const bad = await api(server.baseUrl, 'POST', '/api/products', { cookie, body: product({ url: 'javascript:alert(1)' }) });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.json.details)).toContain('Link phải bắt đầu bằng http:// hoặc https://.');
    expect((await api(server.baseUrl, 'POST', '/api/products', { cookie, body: product({ name: 'x'.repeat(201) }) })).status).toBe(400);
    expect((await api(server.baseUrl, 'POST', '/api/products', { cookie, body: product({ platform: 'AMAZON' }) })).status).toBe(400);
  });

  it("a domain of another user is 404; listing by domainId returns only that domain's products", async () => {
    const mine = await member();
    const other = await member();
    const foreign = await api(server.baseUrl, 'POST', '/api/products', { cookie: mine.cookie, body: product({ domainId: other.domain.id }) });
    expect(foreign.status).toBe(404);
    expect(foreign.json.error).toBe('Lĩnh vực không tồn tại.');

    await api(server.baseUrl, 'POST', '/api/products', { cookie: mine.cookie, body: product({ name: 'Trong lĩnh vực', domainId: mine.domain.id }) });
    await api(server.baseUrl, 'POST', '/api/products', { cookie: mine.cookie, body: product({ name: 'Không lĩnh vực' }) });
    const byDomain = await api(server.baseUrl, 'GET', `/api/products?domainId=${mine.domain.id}`, { cookie: mine.cookie });
    expect(byDomain.json.data.map((p: { name: string }) => p.name)).toEqual(['Trong lĩnh vực']);
  });

  it('deleting a product attached to a post is 409; an unused product is deleted', async () => {
    const { user, cookie } = await member();
    const used = (await api(server.baseUrl, 'POST', '/api/products', { cookie, body: product() })).json.data;
    const unused = (await api(server.baseUrl, 'POST', '/api/products', { cookie, body: product({ name: 'Chưa dùng' }) })).json.data;
    const page = await prisma.facebookPage.create({ data: { userId: user.id, pageId: `PR_${Date.now()}`, pageName: 'P', pageAccessToken: 'x' } });
    await prisma.post.create({ data: { userId: user.id, pageId: page.id, products: { create: { productId: used.id } } } });

    const refused = await api(server.baseUrl, 'DELETE', `/api/products/${used.id}`, { cookie });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe('Sản phẩm đã gắn vào bài — hãy lưu trữ thay vì xoá.');
    expect((await api(server.baseUrl, 'DELETE', `/api/products/${unused.id}`, { cookie })).status).toBe(200);
    expect(await prisma.affiliateProduct.findUnique({ where: { id: unused.id } })).toBeNull();
    const listed = await api(server.baseUrl, 'GET', '/api/products', { cookie });
    expect(listed.json.data).toEqual([expect.objectContaining({ id: used.id, usedCount: 1 })]);
  });

  it('the 201st product is refused (409)', async () => {
    const { user, cookie } = await member();
    await prisma.affiliateProduct.createMany({ data: Array.from({ length: 200 }, (_, i) => ({ userId: user.id, platform: 'SHOPEE' as const, name: `SP ${i}`, url: 'https://s.shopee.vn/x' })) });
    const res = await api(server.baseUrl, 'POST', '/api/products', { cookie, body: product() });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('Tối đa 200 sản phẩm (tính cả sản phẩm đã lưu trữ).');
  });

  it('lists unused products first, then the least recently used', async () => {
    const { user, cookie } = await member();
    const base = { userId: user.id, platform: 'LAZADA' as const, url: 'https://c.lazada.vn/x' };
    await prisma.affiliateProduct.create({ data: { ...base, name: 'Mới dùng', lastUsedAt: new Date() } });
    await prisma.affiliateProduct.create({ data: { ...base, name: 'Dùng lâu rồi', lastUsedAt: new Date(Date.now() - 86_400_000) } });
    await prisma.affiliateProduct.create({ data: { ...base, name: 'Chưa dùng' } });
    const listed = await api(server.baseUrl, 'GET', '/api/products', { cookie });
    expect(listed.json.data.map((p: { name: string }) => p.name)).toEqual(['Chưa dùng', 'Dùng lâu rồi', 'Mới dùng']);
  });

  it('a product of another user cannot be edited or deleted (404)', async () => {
    const mine = await member();
    const other = await member();
    const theirs = (await api(server.baseUrl, 'POST', '/api/products', { cookie: other.cookie, body: product() })).json.data;
    const res = await api(server.baseUrl, 'PATCH', `/api/products/${theirs.id}`, { cookie: mine.cookie, body: { name: 'hack' } });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('Không tìm thấy sản phẩm.');
    expect((await api(server.baseUrl, 'DELETE', `/api/products/${theirs.id}`, { cookie: mine.cookie })).status).toBe(404);
  });
});
