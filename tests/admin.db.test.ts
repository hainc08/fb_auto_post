import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { readImage, removeImage, saveImage } from '../src/lib/image-store';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser, TEST_EMAIL_DOMAIN } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;
let adminCookie: string;
let adminId: string;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('img')]);

const login = (email: string, password: string) => api(server.baseUrl, 'POST', '/api/auth/login', { body: { email, password } });

describe.skipIf(!process.env.RUN_DB_TESTS)('admin: member management', { timeout: 90_000 }, () => {
  beforeAll(async () => {
    await cleanupTestUsers();
    server = await startTestServer(createApp());
    const admin = await createTestUser({ role: 'ADMIN', name: 'Test Admin' });
    adminCookie = admin.cookie;
    adminId = admin.user.id;
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('is forbidden to regular users', async () => {
    const { cookie } = await createTestUser();
    expect((await api(server.baseUrl, 'GET', '/api/admin/users', { cookie })).status).toBe(403);
  });

  it('creates a member with the password the admin chose; the member logs in right away', async () => {
    const email = `Lan.Nguyen${TEST_EMAIL_DOMAIN}`.toUpperCase();
    const created = await api(server.baseUrl, 'POST', '/api/admin/users', {
      cookie: adminCookie,
      body: { email: ` ${email} `, name: 'Lan', password: 'lan-pass-2026', role: 'USER' },
    });
    expect(created.status).toBe(201);
    expect(created.json.data).toMatchObject({ email: email.toLowerCase(), name: 'Lan', role: 'USER', isActive: true });
    expect(created.json.data).not.toHaveProperty('passwordHash');

    expect((await login(email.toLowerCase(), 'lan-pass-2026')).status).toBe(200);

    const dup = await api(server.baseUrl, 'POST', '/api/admin/users', {
      cookie: adminCookie,
      body: { email: email.toLowerCase(), name: 'X', password: 'whatever-1', role: 'USER' },
    });
    expect(dup.status).toBe(409);
    const short = await api(server.baseUrl, 'POST', '/api/admin/users', {
      cookie: adminCookie,
      body: { email: `s${TEST_EMAIL_DOMAIN}`, name: 'S', password: '123', role: 'USER' },
    });
    expect(short.status).toBe(400);
  });

  it('lists members with counts but no content', async () => {
    const res = await api(server.baseUrl, 'GET', '/api/admin/users', { cookie: adminCookie });
    expect(res.status).toBe(200);
    const row = res.json.data.find((u: { id: string }) => u.id === adminId);
    expect(row).toMatchObject({ role: 'ADMIN', isActive: true, pages: 0, posts30d: 0 });
    expect(row).not.toHaveProperty('passwordHash');
  });

  it('editing password or email ends the member session; new credentials work, old ones do not', async () => {
    const m = await createTestUser();
    const newEmail = `renamed-${Date.now()}${TEST_EMAIL_DOMAIN}`;
    const edit = await api(server.baseUrl, 'PATCH', `/api/admin/users/${m.user.id}`, {
      cookie: adminCookie,
      body: { name: 'Đổi tên', email: newEmail, password: 'new-pass-2026' },
    });
    expect(edit.status).toBe(200);
    expect(edit.json.data).toMatchObject({ name: 'Đổi tên', email: newEmail });
    expect((await api(server.baseUrl, 'GET', '/api/pages', { cookie: m.cookie })).status).toBe(401);
    expect((await login(m.user.email, m.password)).status).toBe(401);
    expect((await login(newEmail, 'new-pass-2026')).status).toBe(200);

    const nameOnly = await createTestUser();
    await api(server.baseUrl, 'PATCH', `/api/admin/users/${nameOnly.user.id}`, { cookie: adminCookie, body: { name: 'Chỉ đổi tên' } });
    expect((await api(server.baseUrl, 'GET', '/api/pages', { cookie: nameOnly.cookie })).status).toBe(200);

    const taken = await api(server.baseUrl, 'PATCH', `/api/admin/users/${nameOnly.user.id}`, { cookie: adminCookie, body: { email: newEmail } });
    expect(taken.status).toBe(409);
  });

  it('disabling blocks login and ends sessions; enabling restores login', async () => {
    const m = await createTestUser();
    const off = await api(server.baseUrl, 'PATCH', `/api/admin/users/${m.user.id}`, { cookie: adminCookie, body: { isActive: false } });
    expect(off.status).toBe(200);
    expect((await api(server.baseUrl, 'GET', '/api/pages', { cookie: m.cookie })).status).toBe(401);
    expect((await login(m.user.email, m.password)).status).toBe(401);
    await api(server.baseUrl, 'PATCH', `/api/admin/users/${m.user.id}`, { cookie: adminCookie, body: { isActive: true } });
    expect((await login(m.user.email, m.password)).status).toBe(200);
  });

  it("deleting needs the exact email and removes only that member's data and image files", async () => {
    const victim = await createTestUser();
    const bystander = await createTestUser();
    const makeData = async (userId: string, tag: string) => {
      const page = await prisma.facebookPage.create({
        data: { userId, pageId: `DEL_${tag}`, pageName: tag, pageAccessToken: 'EAAfaketokendeletexxxxxxxxxxxxxxxx' },
      });
      const post = await prisma.post.create({ data: { userId, pageId: page.id, caption: tag } });
      const stored = await saveImage(post.id, PNG);
      await prisma.post.update({ where: { id: post.id }, data: { imagePath: stored.imagePath } });
      return { page, post, imagePath: stored.imagePath };
    };
    const v = await makeData(victim.user.id, 'victim');
    const b = await makeData(bystander.user.id, 'bystander');

    const wrong = await api(server.baseUrl, 'DELETE', `/api/admin/users/${victim.user.id}`, {
      cookie: adminCookie,
      body: { confirmEmail: 'nope@x.y' },
    });
    expect(wrong.status).toBe(400);
    expect(await prisma.user.findUnique({ where: { id: victim.user.id } })).not.toBeNull();

    const del = await api(server.baseUrl, 'DELETE', `/api/admin/users/${victim.user.id}`, {
      cookie: adminCookie,
      body: { confirmEmail: victim.user.email.toUpperCase() },
    });
    expect(del.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { id: victim.user.id } })).toBeNull();
    expect(await prisma.post.findUnique({ where: { id: v.post.id } })).toBeNull();
    expect(await prisma.facebookPage.findUnique({ where: { id: v.page.id } })).toBeNull();
    expect(await readImage(v.imagePath)).toBeNull();

    expect(await prisma.post.findUnique({ where: { id: b.post.id } })).not.toBeNull();
    expect(await readImage(b.imagePath)).not.toBeNull();
    await removeImage(b.imagePath); // cleanup deletes the user, not files
  });

  it('refuses to delete or disable yourself (409) and 404s unknown members', async () => {
    const me = await prisma.user.findUniqueOrThrow({ where: { id: adminId } });
    const selfDelete = await api(server.baseUrl, 'DELETE', `/api/admin/users/${adminId}`, { cookie: adminCookie, body: { confirmEmail: me.email } });
    expect(selfDelete.status).toBe(409);
    const selfDisable = await api(server.baseUrl, 'PATCH', `/api/admin/users/${adminId}`, { cookie: adminCookie, body: { isActive: false } });
    expect(selfDisable.status).toBe(409);
    const missing = await api(server.baseUrl, 'PATCH', '/api/admin/users/00000000-0000-0000-0000-000000000000', {
      cookie: adminCookie,
      body: { isActive: false },
    });
    expect(missing.status).toBe(404);
  });
});
