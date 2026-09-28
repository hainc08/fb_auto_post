import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;
const cookieFrom = (headers: Headers) => (headers.get('set-cookie') ?? '').split(';')[0];

describe.skipIf(!process.env.RUN_DB_TESTS)('auth routes', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await cleanupTestUsers();
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('logs in with a case-insensitive, trimmed email and sets an httpOnly cookie', async () => {
    const { user, password } = await createTestUser();
    const res = await api(server.baseUrl, 'POST', '/api/auth/login', { body: { email: `  ${user.email.toUpperCase()} `, password } });
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ id: user.id, email: user.email, name: user.name, role: 'USER' });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^ap_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);

    const me = await api(server.baseUrl, 'GET', '/api/auth/me', { cookie: cookieFrom(res.headers) });
    expect(me.json.data.email).toBe(user.email);
  });

  it('answers the same generic error for a wrong password and a disabled account', async () => {
    const a = await createTestUser();
    const wrong = await api(server.baseUrl, 'POST', '/api/auth/login', { body: { email: a.user.email, password: 'nope-nope-nope' } });
    const b = await createTestUser({ isActive: false });
    const disabled = await api(server.baseUrl, 'POST', '/api/auth/login', { body: { email: b.user.email, password: b.password } });
    expect(wrong.status).toBe(401);
    expect(disabled.status).toBe(401);
    expect(wrong.json.error).toBe('Email hoặc mật khẩu không đúng.');
    expect(disabled.json.error).toBe(wrong.json.error);
  });

  it('locks the email after 5 failures (429 with Retry-After)', async () => {
    const { user, password } = await createTestUser();
    for (let i = 0; i < 5; i++) {
      await api(server.baseUrl, 'POST', '/api/auth/login', { body: { email: user.email, password: 'wrong-password' } });
    }
    const res = await api(server.baseUrl, 'POST', '/api/auth/login', { body: { email: user.email, password } });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('logout clears the cookie; self sign-up and self password change do not exist', async () => {
    const out = await api(server.baseUrl, 'POST', '/api/auth/logout');
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toMatch(/ap_session=;/);
    const reg = await api(server.baseUrl, 'POST', '/api/auth/register', { body: { email: 'x@y.z', password: 'whatever-123', name: 'X' } });
    expect(reg.status).toBe(404);
    const { cookie } = await createTestUser();
    const change = await api(server.baseUrl, 'POST', '/api/auth/change-password', { cookie, body: { currentPassword: 'a', newPassword: 'b' } });
    expect(change.status).toBe(404);
  });
});
