import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { encrypt } from '../src/lib/crypto';
import { saveSettings } from '../src/lib/settings';
import { postMessageOf } from '../src/services/scheduler.service';
import { startTestServer } from './helpers/http';
import { stubTelegram, tgJson } from './helpers/telegram-stub';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;
const SECRET = 'a'.repeat(64);
const CODE = 'abcdef0123456789';

/** A member with a Page and a bot row; `linked` = a chat (111) is already linked */
async function setup(linked = false) {
  const { user } = await createTestUser();
  await saveSettings(user.id, { fbAppId: '555' });
  const page = await prisma.facebookPage.create({
    data: { userId: user.id, pageId: `TW_${Date.now()}_${Math.random()}`, pageName: 'Nhà nông', pageAccessToken: 'EAAfaketokentelegramwebhookxxxxxxxxxx', tokenStatus: 'VALID', tokenAppId: '555' },
  });
  const bot = await prisma.telegramBot.create({
    data: { userId: user.id, botToken: encrypt('123456:ABC-fake-token-for-tests'), botUsername: 'nhanong_bot', webhookSecret: SECRET, ...(linked ? { chatId: '111' } : { linkCode: CODE }) },
  });
  const waiting = (data: Record<string, unknown> = {}) =>
    prisma.post.create({
      data: { userId: user.id, pageId: page.id, status: 'READY', scheduleQueued: true, scheduledAt: new Date(Date.now() + 3600_000), caption: 'Lúa vàng lá', targets: { create: { pageId: page.id } }, ...data },
    });
  return { user, page, bot, waiting };
}

const post = (userId: string, update: unknown, secret: string | null = SECRET) =>
  fetch(`${server.baseUrl}/telegram/webhook/${userId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret !== null && { 'X-Telegram-Bot-Api-Secret-Token': secret }) },
    body: JSON.stringify(update),
  });
const text = (chatId: number, body: string, type = 'private') => ({ update_id: 1, message: { message_id: 5, chat: { id: chatId, type }, text: body } });
const press = (chatId: number, data: string, messageId = 7) => ({ update_id: 2, callback_query: { id: 'cb1', data, message: { message_id: messageId, chat: { id: chatId, type: 'private' } } } });
const bots = (userId: string) => prisma.telegramBot.findUniqueOrThrow({ where: { userId } });
const statusOf = async (id: string) => (await prisma.post.findUniqueOrThrow({ where: { id } })).status;

describe.skipIf(!process.env.RUN_DB_TESTS)('Telegram webhook', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    server = await startTestServer(createApp());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('no header, a wrong header or an unknown user id gets 401 and nothing happens', async () => {
    const s = await setup();
    const calls = stubTelegram();
    for (const [id, secret] of [[s.user.id, null], [s.user.id, 'b'.repeat(64)], ['00000000-0000-4000-8000-000000000000', SECRET]] as const) {
      const res = await post(id, text(111, `/start ${CODE}`), secret);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false });
    }
    expect(calls).toHaveLength(0);
    expect(await bots(s.user.id)).toMatchObject({ chatId: null, linkCode: CODE });
  });

  it('/start with the right code in a private chat links it; a wrong code or a group does not', async () => {
    const s = await setup();
    const calls = stubTelegram();
    expect((await post(s.user.id, text(-50, `/start ${CODE}`, 'group'))).status).toBe(200);
    expect((await post(s.user.id, text(111, '/start wrongcode'))).status).toBe(200);
    expect(await bots(s.user.id)).toMatchObject({ chatId: null, linkCode: CODE });
    expect(calls.filter((c) => c.method === 'sendMessage').every((c) => c.body.text.includes('không đúng'))).toBe(true);

    calls.length = 0;
    expect((await post(s.user.id, text(111, `/start ${CODE}`))).status).toBe(200);
    expect(await bots(s.user.id)).toMatchObject({ chatId: '111', linkCode: null, lastError: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ chat_id: '111' });
    expect(calls[0].body.text).toContain('Đã liên kết');
    expect(calls[0].body.text).toContain('08:00');
  });

  it("a stranger's chat can neither link nor approve", async () => {
    const s = await setup(true);
    const waiting = await s.waiting();
    const calls = stubTelegram();
    await post(s.user.id, text(222, '/start whatever'));
    expect((await bots(s.user.id)).chatId).toBe('111');
    await post(s.user.id, press(222, `a:${waiting.id}`));
    expect(calls.find((c) => c.method === 'answerCallbackQuery')?.body.text).toMatch(/không có quyền/);
    expect(await statusOf(waiting.id)).toBe('READY');
  });

  it('approving: SCHEDULED with a "✅ Đã duyệt" keyboard; a second tap, a deleted post and a published post answer politely', async () => {
    const s = await setup(true);
    const waiting = await s.waiting();
    const calls = stubTelegram();
    await post(s.user.id, press(111, `a:${waiting.id}`));
    expect(await prisma.post.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({ status: 'SCHEDULED', approvedAt: expect.any(Date), scheduleQueued: true });
    expect(calls.find((c) => c.method === 'answerCallbackQuery')?.body).toMatchObject({ callback_query_id: 'cb1', text: 'Đã duyệt ✅' });
    const edit = calls.find((c) => c.method === 'editMessageReplyMarkup')!;
    expect(edit.body).toMatchObject({ chat_id: '111', message_id: 7 });
    expect(edit.body.reply_markup.inline_keyboard[0][0].text).toMatch(/^✅ Đã duyệt — đăng /);

    calls.length = 0;
    await post(s.user.id, press(111, `a:${waiting.id}`));
    expect(calls.find((c) => c.method === 'answerCallbackQuery')?.body.text).toMatch(/đã được duyệt trước đó/);
    expect(await prisma.postLog.count({ where: { postId: waiting.id, action: 'approved' } })).toBe(1);

    calls.length = 0;
    const gone = await s.waiting();
    await prisma.post.delete({ where: { id: gone.id } });
    await post(s.user.id, press(111, `a:${gone.id}`));
    expect(calls.find((c) => c.method === 'answerCallbackQuery')?.body.text).toMatch(/Không tìm thấy bài/);

    calls.length = 0;
    const live = await s.waiting({ status: 'PUBLISHED' });
    await post(s.user.id, press(111, `a:${live.id}`));
    expect(calls.find((c) => c.method === 'answerCallbackQuery')?.body.text).toMatch(/Chỉ duyệt được bài/);
    expect(await statusOf(live.id)).toBe('PUBLISHED');
  });

  it("another member's post id is not found and untouched", async () => {
    const mine = await setup(true);
    const other = await setup(true);
    const theirs = await other.waiting();
    const calls = stubTelegram();
    await post(mine.user.id, press(111, `a:${theirs.id}`));
    expect(calls.find((c) => c.method === 'answerCallbackQuery')?.body.text).toMatch(/Không tìm thấy bài/);
    expect(await statusOf(theirs.id)).toBe('READY');
  });

  it('"Xem đủ" sends the text as it will be published, product links included, split at 4096, in reply to the card', async () => {
    const s = await setup(true);
    const long = Array.from({ length: 300 }, (_, i) => `Dòng ${i}: nội dung khá dài của bài viết số ${i}`).join('\n');
    const waiting = await s.waiting({ caption: long });
    const product = await prisma.affiliateProduct.create({ data: { userId: s.user.id, platform: 'SHOPEE', name: 'Bình xịt 16L', url: 'https://s.shopee.vn/a' } });
    await prisma.postProduct.create({ data: { postId: waiting.id, productId: product.id } });
    const calls = stubTelegram();
    await post(s.user.id, press(111, `f:${waiting.id}`, 77));
    const full = await postMessageOf(await prisma.post.findUniqueOrThrow({ where: { id: waiting.id } }));
    const sent = calls.filter((c) => c.method === 'sendMessage');
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every((c) => c.body.text.length <= 4096)).toBe(true);
    expect(sent.map((c) => c.body.text).join('\n')).toBe(full);
    expect(sent[0].body.reply_to_message_id).toBe(77);
    expect(sent.map((c) => c.body.text).join('\n')).toContain('👉 Bình xịt 16L (Shopee): https://s.shopee.vn/a');
    expect(sent.every((c) => c.body.parse_mode === undefined)).toBe(true);
    expect(await statusOf(waiting.id)).toBe('READY'); // reading never approves
  });

  it("a disabled member's chat can no longer approve or read posts; the answer is still 200", async () => {
    const s = await setup(true);
    const waiting = await s.waiting();
    await prisma.user.update({ where: { id: s.user.id }, data: { isActive: false } });
    const calls = stubTelegram();
    for (const update of [press(111, `a:${waiting.id}`), press(111, `f:${waiting.id}`), text(111, '/danhsach')]) {
      expect((await post(s.user.id, update)).status).toBe(200);
    }
    expect(calls).toHaveLength(0);
    expect(await statusOf(waiting.id)).toBe('READY');
  });

  it('noop only answers; a malformed update and a failing Telegram answer still get HTTP 200', async () => {
    const s = await setup(true);
    const waiting = await s.waiting();
    const calls = stubTelegram({ answerCallbackQuery: () => tgJson({ ok: false, error_code: 400, description: 'query is too old' }, 400) });
    expect((await post(s.user.id, press(111, 'noop'))).status).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(['answerCallbackQuery']);
    expect((await post(s.user.id, {})).status).toBe(200);
    expect((await post(s.user.id, press(111, `a:${waiting.id}`))).status).toBe(200);
    expect(await statusOf(waiting.id)).toBe('SCHEDULED'); // the approval stands even though Telegram refused the answer
  });
});
