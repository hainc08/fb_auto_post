import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { GeminiClient } from '../src/lib/clients/gemini';
import { CloudflareClient } from '../src/lib/clients/cloudflare';
import { buildIdeaPrompt } from '../src/lib/compose-prompt';
import { createStarterDomains } from '../src/lib/domains';
import { removeImage } from '../src/lib/image-store';
import { saveSettings } from '../src/lib/settings';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('img')]);

/** A user with keys, one postable Page (Graph never called: token already VALID for the saved App ID) */
async function setup() {
  const u = await createTestUser();
  await saveSettings(u.user.id, {
    geminiApiKey: 'AIzaFakeKeyPostsDomains000000000000000',
    cfAccountId: 'fakeaccount',
    cfApiToken: 'fake-cf-token-posts-domains',
    fbAppId: '111',
  });
  const page = await prisma.facebookPage.create({
    data: {
      userId: u.user.id,
      pageId: `PD_${Date.now()}_${Math.random()}`,
      pageName: 'Nihongo',
      pageAccessToken: 'EAAfaketokenpostsdomainsxxxxxxxxxx',
      tokenStatus: 'VALID',
      tokenAppId: '111',
    },
  });
  return { ...u, page };
}

const gem = (post = 'Bài viết\n\n#ai', image_prompt = 'a teacher') =>
  vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ post, image_prompt } as never);

describe.skipIf(!process.env.RUN_DB_TESTS)('posts with domains and formats', { timeout: 90_000 }, () => {
  beforeAll(async () => {
    await cleanupTestUsers();
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('an old account writes exactly as before (legacy "Bài chuẩn" from its system prompt)', async () => {
    const { user, cookie, page } = await setup();
    await saveSettings(user.id, { systemPrompt: 'Prompt cũ của tôi. Chủ đề: {{topic}}' });
    const spy = gem();

    const created = await api(server.baseUrl, 'POST', '/api/posts', { cookie, body: { pageIds: [page.id], inputData: { basicInfo: 'Chào sếp' } } });
    expect(created.status).toBe(201);
    expect(created.json.data.format).toMatchObject({ name: 'Bài chuẩn' });

    const gen = await api(server.baseUrl, 'POST', `/api/posts/${created.json.data.id}/generate`, { cookie });
    expect(gen.status).toBe(200);
    const call = spy.mock.calls[0][0] as { systemInstruction: string; prompt: string };
    expect(call.systemInstruction).toBe(buildIdeaPrompt('Prompt cũ của tôi. Chủ đề: {{topic}}', 'Chào sếp'));
    expect(call.prompt).toBe('Viết bài Facebook cho ý tưởng: Chào sếp');
    expect(gen.json.data).toMatchObject({ caption: 'Bài viết', hashtags: ['ai'], imagePrompt: 'a teacher', aiPrompt: call.systemInstruction });
  });

  it('writes with the chosen domain + format, adds default hashtags and stores the prompt', async () => {
    const { user, cookie, page } = await setup();
    const domain = await prisma.contentDomain.create({
      data: {
        userId: user.id,
        name: 'Tiếng Nhật',
        voice: 'Dí dỏm',
        defaultHashtags: ['NhatNgu'],
        formats: {
          create: [
            { name: 'Hỏi đáp', instructions: 'Mở bằng câu hỏi.', isDefault: true },
            { name: 'Mẹo', instructions: 'Một mẹo.', length: 'SHORT' },
          ],
        },
      },
      include: { formats: true },
    });
    const tip = domain.formats.find((f) => f.name === 'Mẹo')!;
    const spy = gem();

    const created = await api(server.baseUrl, 'POST', '/api/posts', {
      cookie,
      body: { pageIds: [page.id], domainId: domain.id, formatId: tip.id, inputData: { basicInfo: 'Chào sếp' } },
    });
    expect(created.json.data).toMatchObject({ domainId: domain.id, formatId: tip.id });
    const gen = await api(server.baseUrl, 'POST', `/api/posts/${created.json.data.id}/generate`, { cookie });

    const prompt = (spy.mock.calls[0][0] as { systemInstruction: string }).systemInstruction;
    expect(prompt).toMatch('lĩnh vực "Tiếng Nhật"');
    expect(prompt).toMatch('Định dạng bài "Mẹo":\nMột mẹo.\nĐộ dài: khoảng 80–120 từ.');
    expect(gen.json.data.hashtags).toEqual(['ai', 'NhatNgu']);
    expect(gen.json.data.aiPrompt).toBe(prompt);

    // Switching format on the draft (PATCH) is used by the next generation
    const qa = domain.formats.find((f) => f.name === 'Hỏi đáp')!;
    const patched = await api(server.baseUrl, 'PATCH', `/api/posts/${created.json.data.id}`, { cookie, body: { formatId: qa.id } });
    expect(patched.json.data.formatId).toBe(qa.id);
  });

  it('refuses a format from another domain (400) and filters the list by domain', async () => {
    const { user, cookie, page } = await setup();
    await createStarterDomains(user.id);
    const chung = await prisma.contentDomain.findFirstOrThrow({ where: { userId: user.id } });
    const other = await prisma.contentDomain.create({
      data: { userId: user.id, name: 'Khác', formats: { create: { name: 'F', instructions: 'x', isDefault: true } } },
      include: { formats: true },
    });
    const bad = await api(server.baseUrl, 'POST', '/api/posts', {
      cookie,
      body: { pageIds: [page.id], domainId: chung.id, formatId: other.formats[0].id, inputData: { basicInfo: 'x' } },
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('Định dạng không thuộc lĩnh vực đã chọn.');

    await api(server.baseUrl, 'POST', '/api/posts', { cookie, body: { pageIds: [page.id], domainId: other.id, inputData: { basicInfo: 'x' } } });
    await api(server.baseUrl, 'POST', '/api/posts', { cookie, body: { pageIds: [page.id], domainId: chung.id, inputData: { basicInfo: 'y' } } });
    const list = await api(server.baseUrl, 'GET', `/api/posts?domainId=${other.id}`, { cookie });
    expect(list.json.data).toHaveLength(1);
    expect(list.json.data[0]).toMatchObject({ domain: { id: other.id, name: 'Khác' }, format: { name: 'F' } });
  });

  it("AI images use the domain's image style", async () => {
    const { user, cookie, page } = await setup();
    const domain = await prisma.contentDomain.create({
      data: {
        userId: user.id,
        name: 'Ảnh',
        imageStyle: 'flat pastel illustration',
        formats: { create: { name: 'F', instructions: 'x', isDefault: true } },
      },
    });
    const post = await prisma.post.create({ data: { userId: user.id, pageId: page.id, domainId: domain.id, imagePrompt: 'a cat', caption: 'x' } });
    const cf = vi.spyOn(CloudflareClient.prototype, 'generateImage').mockResolvedValue({ buffer: PNG, mimeType: 'image/png' } as never);

    const res = await api(server.baseUrl, 'POST', `/api/posts/${post.id}/image/generate`, { cookie, body: {} });
    expect(res.status).toBe(200);
    expect(cf.mock.calls[0][0]).toBe('flat pastel illustration. a cat');
    expect(res.json.data.imagePrompt).toBe('a cat'); // stored without the style
    await removeImage((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).imagePath);
  });
});
