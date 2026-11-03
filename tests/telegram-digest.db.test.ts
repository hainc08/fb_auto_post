import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { encrypt } from '../src/lib/crypto';
import { saveSettings } from '../src/lib/settings';
import { removeImage, saveImage } from '../src/lib/image-store';
import { runTelegramDigests, sendDigest } from '../src/services/telegram-digest';
import { api, startTestServer } from './helpers/http';
import { stubTelegram, tgJson, type TelegramCall } from './helpers/telegram-stub';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;
const SECRET = 'c'.repeat(64);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('img')]);
const savedImages: string[] = [];
const hoursAhead = (h: number) => new Date(Date.now() + h * 3600_000);

/** A member with a Page and a bot linked to chat 111 */
async function setup(bot: Record<string, unknown> = {}) {
  const { user, cookie } = await createTestUser();
  await saveSettings(user.id, { fbAppId: '666' });
  const page = await prisma.facebookPage.create({
    data: { userId: user.id, pageId: `TD_${Date.now()}_${Math.random()}`, pageName: 'Nhà nông', pageAccessToken: 'EAAfaketokentelegramdigestxxxxxxxxxxx', tokenStatus: 'VALID', tokenAppId: '666' },
  });
  const row = await prisma.telegramBot.create({
    data: { userId: user.id, botToken: encrypt('123456:ABC-fake-token-for-tests'), botUsername: 'nhanong_bot', webhookSecret: SECRET, chatId: '111', ...bot },
  });
  const waiting = (data: Record<string, unknown> = {}) =>
    prisma.post.create({
      data: { userId: user.id, pageId: page.id, status: 'READY', scheduleQueued: true, scheduledAt: hoursAhead(2), caption: 'Lúa vàng lá', targets: { create: { pageId: page.id } }, ...data },
    });
  return { user, cookie, page, row, waiting };
}

const markupOf = (call: TelegramCall) => (typeof call.body.reply_markup === 'string' ? JSON.parse(call.body.reply_markup) : call.body.reply_markup);
const textOf = (call: TelegramCall) => (call.method === 'sendPhoto' ? call.body.caption : call.body.text);
const sends = (calls: TelegramCall[]) => calls.filter((c) => c.method === 'sendMessage' || c.method === 'sendPhoto');

describe.skipIf(!process.env.RUN_DB_TESTS)('Telegram morning digest', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    process.env.PUBLIC_URL = 'https://app.example.test';
    server = await startTestServer(createApp());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    delete process.env.PUBLIC_URL;
    for (const path of savedImages) await removeImage(path);
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('sends the header and one card per waiting post, in slot order, with the approve keyboard', async () => {
    const s = await setup();
    const other = await setup();
    const late = await s.waiting({ caption: 'Bài muộn', scheduledAt: hoursAhead(5) });
    const early = await s.waiting({ caption: 'Bài sớm có ảnh', scheduledAt: hoursAhead(1) });
    const middle = await s.waiting({ caption: 'Bài giữa', scheduledAt: hoursAhead(3) });
    const saved = await saveImage(early.id, PNG);
    savedImages.push(saved.imagePath);
    await prisma.post.update({ where: { id: early.id }, data: { imagePath: saved.imagePath } });
    const product = await prisma.affiliateProduct.create({ data: { userId: s.user.id, platform: 'SHOPEE', name: 'Bình xịt 16L', url: 'https://s.shopee.vn/a' } });
    await prisma.postProduct.create({ data: { postId: middle.id, productId: product.id } });
    // not waiting for approval, or not this member's
    await s.waiting({ status: 'SCHEDULED' });
    await s.waiting({ status: 'DRAFT', caption: null });
    await s.waiting({ scheduleQueued: false });
    await s.waiting({ status: 'PUBLISHED' });
    await other.waiting({ caption: 'Bài của người khác' });

    const calls = stubTelegram();
    expect(await sendDigest(s.user.id, { delayMs: 0 })).toEqual({ total: 3, sent: 3 });
    const out = sends(calls);
    expect(out.map((c) => c.method)).toEqual(['sendMessage', 'sendPhoto', 'sendMessage', 'sendMessage']);
    expect(out.every((c) => c.body.chat_id === '111')).toBe(true);
    expect(out[0].body.text).toBe('☀️ Chào buổi sáng! Có 3 bài đang chờ bạn duyệt.');
    expect(textOf(out[1])).toContain('Bài sớm có ảnh');
    expect(textOf(out[2])).toContain('Bài giữa');
    expect(textOf(out[2])).toContain('🛒 Bình xịt 16L');
    expect(textOf(out[3])).toContain('Bài muộn');
    expect(textOf(out[1])).toContain('Nhà nông');
    for (const [call, post] of [[out[1], early], [out[2], middle], [out[3], late]] as const) {
      const rows = markupOf(call).inline_keyboard;
      expect(rows[0][0]).toEqual({ text: '✅ Duyệt', callback_data: `a:${post.id}` });
      expect(rows[1][0].url).toBe(`https://app.example.test/posts?selected=${post.id}`);
    }
    expect(JSON.stringify(calls)).not.toContain('Bài của người khác');
  });

  it('12 waiting posts: 10 cards, and the header says 2 more', async () => {
    const s = await setup();
    for (let i = 0; i < 12; i++) await s.waiting({ caption: `Bài ${i}`, scheduledAt: hoursAhead(1 + i) });
    const calls = stubTelegram();
    expect(await sendDigest(s.user.id, { delayMs: 0 })).toEqual({ total: 12, sent: 10 });
    expect(sends(calls)).toHaveLength(11);
    expect(sends(calls)[0].body.text).toContain('Có 12 bài');
    expect(sends(calls)[0].body.text).toContain('còn 2 bài');
  });

  it('captions with < _ * reach Telegram verbatim and no request carries parse_mode', async () => {
    const s = await setup();
    const post = await s.waiting({ caption: '<b>Lúa</b> a_b*c [x](y)' });
    const saved = await saveImage(post.id, PNG);
    savedImages.push(saved.imagePath);
    await prisma.post.update({ where: { id: post.id }, data: { imagePath: saved.imagePath } });
    await s.waiting({ caption: '<i>Bài hai</i> _x_' });
    const calls = stubTelegram();
    await sendDigest(s.user.id, { delayMs: 0 });
    expect(sends(calls).map(textOf).join('\n')).toContain('<b>Lúa</b> a_b*c [x](y)');
    expect(sends(calls).map(textOf).join('\n')).toContain('<i>Bài hai</i> _x_');
    expect(calls.every((c) => c.body.parse_mode === undefined)).toBe(true);
  });

  it('no waiting posts: nothing is sent by the digest; the manual list and /danhsach say there is nothing to approve', async () => {
    const s = await setup();
    const calls = stubTelegram();
    expect(await sendDigest(s.user.id, { delayMs: 0 })).toEqual({ total: 0, sent: 0 });
    expect(calls).toHaveLength(0);

    const res = await api(server.baseUrl, 'POST', '/api/telegram/digest', { cookie: s.cookie });
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ total: 0, sent: 0 });
    expect(sends(calls).map(textOf)).toEqual(['Không có bài nào đang chờ duyệt 🎉']);

    calls.length = 0;
    await fetch(`${server.baseUrl}/telegram/webhook/${s.user.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET },
      body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: 111, type: 'private' }, text: '/danhsach' } }),
    });
    expect(sends(calls).map(textOf)).toEqual(['Không có bài nào đang chờ duyệt 🎉']);
    // /danhsach from a chat that is not linked does nothing
    calls.length = 0;
    await fetch(`${server.baseUrl}/telegram/webhook/${s.user.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET },
      body: JSON.stringify({ update_id: 2, message: { message_id: 1, chat: { id: 222, type: 'private' }, text: '/danhsach' } }),
    });
    expect(sends(calls).every((c) => c.body.chat_id !== '222' || !textOf(c).includes('Không có bài'))).toBe(true);
  });

  it('POST /api/telegram/digest returns { total, sent } and sends the list; without a linked chat it is 409', async () => {
    const s = await setup();
    await s.waiting();
    const calls = stubTelegram();
    const res = await api(server.baseUrl, 'POST', '/api/telegram/digest', { cookie: s.cookie });
    expect(res.json.data).toEqual({ total: 1, sent: 1 });
    expect(sends(calls)).toHaveLength(2);
    const unlinked = await setup({ chatId: null });
    expect((await api(server.baseUrl, 'POST', '/api/telegram/digest', { cookie: unlinked.cookie })).status).toBe(409);
  });

  it('runTelegramDigests: only from the morning time, once a day, and an empty queue still marks the day', async () => {
    const s = await setup();
    await s.waiting();
    const only = { userId: s.user.id };
    const calls = stubTelegram();
    const at = (iso: string) => new Date(iso);
    expect(await runTelegramDigests(at('2026-11-04T00:59:00Z'), only)).toBe(0); // 07:59 in Vietnam
    expect(calls).toHaveLength(0);
    expect(await runTelegramDigests(at('2026-11-04T01:00:00Z'), only)).toBe(1);
    expect(sends(calls)).toHaveLength(2);
    expect((await prisma.telegramBot.findUniqueOrThrow({ where: { userId: s.user.id } })).lastDigestOn).toBe('2026-11-04');
    expect(await runTelegramDigests(at('2026-11-04T05:00:00Z'), only)).toBe(0); // same day
    expect(await runTelegramDigests(at('2026-11-05T01:00:00Z'), only)).toBe(1); // next day, the post still waits

    await prisma.post.updateMany({ where: { userId: s.user.id }, data: { status: 'SCHEDULED' } });
    calls.length = 0;
    expect(await runTelegramDigests(at('2026-11-06T01:00:00Z'), only)).toBe(0);
    expect(calls).toHaveLength(0);
    expect((await prisma.telegramBot.findUniqueOrThrow({ where: { userId: s.user.id } })).lastDigestOn).toBe('2026-11-06');
  });

  it('a disabled or unlinked bot is skipped, and two runs at once send once', async () => {
    const off = await setup({ enabled: false });
    const unlinked = await setup({ chatId: null });
    const s = await setup();
    for (const x of [off, unlinked, s]) await x.waiting();
    const calls = stubTelegram();
    const now = new Date('2026-11-04T01:00:00Z');
    expect(await runTelegramDigests(now, { userId: { in: [off.user.id, unlinked.user.id] } })).toBe(0);
    expect(calls).toHaveLength(0);
    const results = await Promise.all([runTelegramDigests(now, { userId: s.user.id }), runTelegramDigests(now, { userId: s.user.id })]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(sends(calls)).toHaveLength(2);
  });

  it('a blocked bot (403) is unlinked with an explanation', async () => {
    const s = await setup();
    await s.waiting();
    stubTelegram({ sendMessage: () => tgJson({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, 403) });
    expect(await runTelegramDigests(new Date('2026-11-04T01:00:00Z'), { userId: s.user.id })).toBe(0);
    const row = await prisma.telegramBot.findUniqueOrThrow({ where: { userId: s.user.id } });
    expect(row.chatId).toBeNull();
    expect(row.lastError).toMatch(/bị chặn/);
    expect(row.lastDigestOn).toBe('2026-11-04');
  });

  it('a 429 with nothing delivered is retried by the next run; a 400 is not and is recorded', async () => {
    const s = await setup();
    await s.waiting();
    const now = new Date('2026-11-04T01:00:00Z');
    stubTelegram({ sendMessage: () => tgJson({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 5' }, 429) });
    expect(await runTelegramDigests(now, { userId: s.user.id })).toBe(0);
    let row = await prisma.telegramBot.findUniqueOrThrow({ where: { userId: s.user.id } });
    expect(row.lastDigestOn).toBeNull(); // the day was given back
    expect(row.lastError).toMatch(/Too Many Requests/);
    vi.unstubAllGlobals();
    const calls = stubTelegram();
    expect(await runTelegramDigests(now, { userId: s.user.id })).toBe(1);
    expect(sends(calls)).toHaveLength(2);
    row = await prisma.telegramBot.findUniqueOrThrow({ where: { userId: s.user.id } });
    expect(row).toMatchObject({ lastDigestOn: '2026-11-04', lastError: null });

    const t = await setup();
    await t.waiting();
    vi.unstubAllGlobals();
    stubTelegram({ sendMessage: () => tgJson({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 400) });
    expect(await runTelegramDigests(now, { userId: t.user.id })).toBe(0);
    row = await prisma.telegramBot.findUniqueOrThrow({ where: { userId: t.user.id } });
    expect(row).toMatchObject({ lastDigestOn: '2026-11-04' });
    expect(row.lastError).toMatch(/chat not found/);
    vi.unstubAllGlobals();
    const again = stubTelegram();
    expect(await runTelegramDigests(now, { userId: t.user.id })).toBe(0);
    expect(again).toHaveLength(0);
  });

  it('a failure after the header went out keeps the day: the cards are never sent twice', async () => {
    const s = await setup();
    await s.waiting();
    let n = 0;
    stubTelegram({
      sendMessage: () => (++n === 1 ? tgJson({ ok: true, result: { message_id: 1 } }) : tgJson({ ok: false, error_code: 500, description: 'Internal Server Error' }, 500)),
    });
    expect(await runTelegramDigests(new Date('2026-11-04T01:00:00Z'), { userId: s.user.id })).toBe(0);
    const row = await prisma.telegramBot.findUniqueOrThrow({ where: { userId: s.user.id } });
    expect(row.lastDigestOn).toBe('2026-11-04');
    expect(row.lastError).toMatch(/Internal Server Error/);
  });
});
