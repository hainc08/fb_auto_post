import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { GeminiClient } from '../src/lib/clients/gemini';
import { DOMAIN_REWRITE } from '../src/lib/rewrite-prompt';
import { saveSettings } from '../src/lib/settings';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;

/** A user with a Gemini key and a post in a domain with a saved writing prompt */
async function setup() {
  const u = await createTestUser();
  await saveSettings(u.user.id, { geminiApiKey: 'AIzaFakeKeyPostRewrite00000000000000000' });
  const page = await prisma.facebookPage.create({
    data: { userId: u.user.id, pageId: `RW_${Date.now()}_${Math.random()}`, pageName: 'Vựa', pageAccessToken: 'EAAfaketokenrewritexxxxxxxxxxxxxxx', tokenStatus: 'VALID' },
  });
  const domain = await prisma.contentDomain.create({
    data: {
      userId: u.user.id,
      name: 'Bao bì',
      audience: 'Cũ',
      writingPrompt: 'Viết cho chủ vựa, xưng em.',
      formats: { create: [{ name: 'Mẹo', instructions: 'Ba đoạn ngắn.', length: 'SHORT', isDefault: true }] },
    },
    include: { formats: true },
  });
  const post = await prisma.post.create({
    data: { userId: u.user.id, pageId: page.id, domainId: domain.id, formatId: domain.formats[0].id, caption: 'Bài đã lưu.' },
  });
  return { ...u, post };
}

describe.skipIf(!process.env.RUN_DB_TESTS)('rewrite a post with AI', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await cleanupTestUsers();
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('rewrites the draft by the instruction with the domain prompt, without saving', async () => {
    const { cookie, post } = await setup();
    const spy = vi.spyOn(GeminiClient.prototype, 'generateText').mockResolvedValue('Bài mới   viết lại.');
    const res = await api(server.baseUrl, 'POST', `/api/posts/${post.id}/improve`, { cookie, body: { instruction: 'Thêm ưu đãi', caption: 'Bản nháp đang sửa.' } });
    expect(res.status).toBe(200);
    expect(res.json.data.caption).toContain('Bài mới');
    const prompt = spy.mock.calls[0][0].prompt;
    expect(prompt).toContain('Viết cho chủ vựa, xưng em.');
    expect(prompt).toContain('Yêu cầu: Thêm ưu đãi');
    expect(prompt).toContain('Bài gốc:\nBản nháp đang sửa.');
    expect(prompt).not.toContain('Ba đoạn ngắn.');
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).caption).toBe('Bài đã lưu.');
  });

  it('"Viết lại theo lĩnh vực" follows the format and needs no instruction', async () => {
    const { cookie, post } = await setup();
    const spy = vi.spyOn(GeminiClient.prototype, 'generateText').mockResolvedValue('Theo lĩnh vực.');
    const res = await api(server.baseUrl, 'POST', `/api/posts/${post.id}/improve`, { cookie, body: { mode: 'domain', caption: 'Nháp.' } });
    expect(res.status).toBe(200);
    const prompt = spy.mock.calls[0][0].prompt;
    expect(prompt).toContain(DOMAIN_REWRITE);
    expect(prompt).toContain('Định dạng bài "Mẹo":\nBa đoạn ngắn.\nĐộ dài: khoảng 80–120 từ.');
  });

  it('refuses an empty or too long instruction before calling the AI', async () => {
    const { cookie, post } = await setup();
    const spy = vi.spyOn(GeminiClient.prototype, 'generateText');
    const empty = await api(server.baseUrl, 'POST', `/api/posts/${post.id}/improve`, { cookie, body: { instruction: '   ', caption: 'x' } });
    expect(empty.status).toBe(400);
    expect(empty.json.details[0].message).toBe('Hãy nhập yêu cầu cho AI.');
    const long = await api(server.baseUrl, 'POST', `/api/posts/${post.id}/improve`, { cookie, body: { instruction: 'a'.repeat(501), caption: 'x' } });
    expect(long.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
});
