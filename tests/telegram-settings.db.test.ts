import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { encrypt } from '../src/lib/crypto';
import { revealSecret } from '../src/lib/settings';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;
const realFetch = globalThis.fetch;
const TOKEN = '123456:ABC-fake-token-for-tests';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

type TgCall = { method: string; body: any };
/** Stubs Telegram only (the test server itself still uses the real fetch) */
function stubTelegram(answers: Record<string, (body: any) => Response> = {}) {
  const calls: TgCall[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes('api.telegram.org')) return realFetch(input as never, init);
    const method = url.split('/').pop()!;
    const body = init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(String(init?.body ?? '{}'));
    calls.push({ method, body });
    if (answers[method]) return answers[method](body);
    if (method === 'getMe') return json({ ok: true, result: { id: 9, username: 'nhanong_bot' } });
    if (method === 'sendMessage') return json({ ok: true, result: { message_id: 1 } });
    return json({ ok: true, result: true });
  });
  return calls;
}

const connect = (cookie: string, token = TOKEN) => api(server.baseUrl, 'PUT', '/api/telegram', { cookie, body: { botToken: token } });

describe.skipIf(!process.env.RUN_DB_TESTS)('Telegram settings API', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    process.env.PUBLIC_URL = 'https://app.example.test';
    server = await startTestServer(createApp());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.PUBLIC_URL = 'https://app.example.test';
  });
  afterAll(async () => {
    delete process.env.PUBLIC_URL;
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it("connect: getMe, setWebhook with the member's URL and a 64-hex secret, an encrypted token, a link URL", async () => {
    const { user, cookie } = await createTestUser();
    const calls = stubTelegram();
    const res = await connect(cookie);
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ configured: true, botUsername: 'nhanong_bot', linked: false, enabled: true, digestTime: '08:00', canReceive: true });
    expect(res.json.data.linkUrl).toMatch(/^https:\/\/t\.me\/nhanong_bot\?start=[0-9a-f]{16}$/);
    expect(calls.map((c) => c.method)).toEqual(['getMe', 'setWebhook']);
    expect(calls[1].body).toMatchObject({ url: `https://app.example.test/telegram/webhook/${user.id}` });
    expect(calls[1].body.secret_token).toMatch(/^[0-9a-f]{64}$/);

    const row = await prisma.telegramBot.findUniqueOrThrow({ where: { userId: user.id } });
    expect(row.botToken).not.toBe(TOKEN);
    expect(revealSecret(row.botToken)).toBe(TOKEN);
    expect(row).toMatchObject({ webhookSecret: calls[1].body.secret_token, chatId: null });

    const got = await api(server.baseUrl, 'GET', '/api/telegram', { cookie });
    const text = JSON.stringify(got.json);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(row.webhookSecret);
  });

  it('a wrong token is refused and nothing is stored', async () => {
    const { user, cookie } = await createTestUser();
    stubTelegram({ getMe: () => json({ ok: false, error_code: 401, description: 'Unauthorized' }, 401) });
    const res = await connect(cookie);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/Token bot không đúng/);
    expect(await prisma.telegramBot.count({ where: { userId: user.id } })).toBe(0);
  });

  it('a non-https public address is refused before Telegram is called', async () => {
    const { cookie } = await createTestUser();
    process.env.PUBLIC_URL = 'http://localhost:5173';
    const calls = stubTelegram();
    const res = await connect(cookie);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/https/);
    expect(calls).toHaveLength(0);
  });

  it('saving the time and the switch; a bad time is refused; without a row it is 409', async () => {
    const { cookie } = await createTestUser();
    const { cookie: loner } = await createTestUser();
    stubTelegram();
    await connect(cookie);
    const put = (body: Record<string, unknown>, c = cookie) => api(server.baseUrl, 'PUT', '/api/telegram', { cookie: c, body });
    expect((await put({ digestTime: '25:00' })).status).toBe(400);
    const saved = await put({ enabled: false, digestTime: '07:30' });
    expect(saved.json.data).toMatchObject({ enabled: false, digestTime: '07:30' });
    const none = await put({ enabled: false }, loner);
    expect(none.status).toBe(409);
    expect(none.json.error).toBe('Hãy dán token bot trước.');
  });

  it('connecting a new token resets the chat, the secret and the code', async () => {
    const { user, cookie } = await createTestUser();
    stubTelegram();
    await connect(cookie);
    const first = await prisma.telegramBot.findUniqueOrThrow({ where: { userId: user.id } });
    await prisma.telegramBot.update({ where: { userId: user.id }, data: { chatId: '111', linkCode: null } });
    await connect(cookie, '654321:XYZ-another-fake-token');
    const second = await prisma.telegramBot.findUniqueOrThrow({ where: { userId: user.id } });
    expect(second.chatId).toBeNull();
    expect(second.linkCode).toMatch(/^[0-9a-f]{16}$/);
    expect(second.webhookSecret).not.toBe(first.webhookSecret);
    expect(revealSecret(second.botToken)).toBe('654321:XYZ-another-fake-token');
  });

  it('link-code gives a new code and keeps the linked chat', async () => {
    const { user, cookie } = await createTestUser();
    stubTelegram();
    await connect(cookie);
    await prisma.telegramBot.update({ where: { userId: user.id }, data: { chatId: '111', linkCode: null } });
    const res = await api(server.baseUrl, 'POST', '/api/telegram/link-code', { cookie });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ linked: true });
    expect(res.json.data.linkUrl).toMatch(/\?start=[0-9a-f]{16}$/);
    expect((await prisma.telegramBot.findUniqueOrThrow({ where: { userId: user.id } })).chatId).toBe('111');
  });

  it('test: sends to the linked chat; not linked is 409; a Telegram refusal is 502 without the token', async () => {
    const { user, cookie } = await createTestUser();
    const calls = stubTelegram();
    await connect(cookie);
    const notLinked = await api(server.baseUrl, 'POST', '/api/telegram/test', { cookie });
    expect(notLinked.status).toBe(409);
    expect(notLinked.json.error).toMatch(/Chưa liên kết Telegram/);

    await prisma.telegramBot.update({ where: { userId: user.id }, data: { chatId: '111' } });
    expect((await api(server.baseUrl, 'POST', '/api/telegram/test', { cookie })).status).toBe(200);
    const sent = calls.filter((c) => c.method === 'sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ chat_id: '111' });
    expect(sent[0].body.text).toContain('Kết nối thành công');

    stubTelegram({ sendMessage: () => json({ ok: false, error_code: 400, description: `Bad Request: chat not found (bot${TOKEN})` }, 400) });
    const refused = await api(server.baseUrl, 'POST', '/api/telegram/test', { cookie });
    expect(refused.status).toBe(502);
    expect(JSON.stringify(refused.json)).not.toContain(TOKEN);
  });

  it("disconnect: deleteWebhook is called, the row is gone, another member's row stays", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const calls = stubTelegram();
    await connect(a.cookie);
    await prisma.telegramBot.create({ data: { userId: b.user.id, botToken: encrypt('777:other'), botUsername: 'other_bot', webhookSecret: 's'.repeat(64) } });
    expect((await api(server.baseUrl, 'DELETE', '/api/telegram', { cookie: a.cookie })).status).toBe(200);
    expect(calls.some((c) => c.method === 'deleteWebhook')).toBe(true);
    expect(await prisma.telegramBot.count({ where: { userId: a.user.id } })).toBe(0);
    expect(await prisma.telegramBot.count({ where: { userId: b.user.id } })).toBe(1);
  });
});
