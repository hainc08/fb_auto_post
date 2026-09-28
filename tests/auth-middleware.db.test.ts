import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;

describe.skipIf(!process.env.RUN_DB_TESTS)('authenticate middleware', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    await cleanupTestUsers();
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('401 without a session, with code UNAUTHENTICATED', async () => {
    const res = await api(server.baseUrl, 'GET', '/api/pages');
    expect(res.status).toBe(401);
    expect(res.json.code).toBe('UNAUTHENTICATED');
  });

  it('accepts a valid session and rejects a tampered one', async () => {
    const { cookie } = await createTestUser();
    expect((await api(server.baseUrl, 'GET', '/api/pages', { cookie })).status).toBe(200);
    expect((await api(server.baseUrl, 'GET', '/api/pages', { cookie: cookie.slice(0, -3) + 'abc' })).status).toBe(401);
  });

  it('a bumped tokenVersion or a disabled account kills existing sessions', async () => {
    const a = await createTestUser();
    await prisma.user.update({ where: { id: a.user.id }, data: { tokenVersion: { increment: 1 } } });
    expect((await api(server.baseUrl, 'GET', '/api/pages', { cookie: a.cookie })).status).toBe(401);

    const b = await createTestUser();
    await prisma.user.update({ where: { id: b.user.id }, data: { isActive: false } });
    expect((await api(server.baseUrl, 'GET', '/api/pages', { cookie: b.cookie })).status).toBe(401);
  });

  it('state-changing API calls need the X-Requested-With header', async () => {
    const { cookie } = await createTestUser();
    const res = await api(server.baseUrl, 'POST', '/api/pages/check', { cookie, headers: { 'X-Requested-With': '' } });
    expect(res.status).toBe(403);
    expect(res.json.code).toBe('CSRF');
  });
});
