import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { GeminiClient } from '../src/lib/clients/gemini';
import { saveSettings } from '../src/lib/settings';
import { ensureDefaultDomain } from '../src/lib/domains';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;
const newDomain = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  audience: 'Người đi làm',
  format: { name: 'Bài chuẩn', instructions: 'Viết ngắn gọn.' },
  ...extra,
});

describe.skipIf(!process.env.RUN_DB_TESTS)('domains & formats API', { timeout: 90_000 }, () => {
  beforeAll(async () => {
    await cleanupTestUsers();
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('creates a domain with its default format; hashtags are stored without "#"; duplicate name 409', async () => {
    const { cookie } = await createTestUser();
    const res = await api(server.baseUrl, 'POST', '/api/domains', {
      cookie,
      body: newDomain('Tiếng Nhật', { defaultHashtags: ['#NhatNgu', 'nhatngu', ' Hoc Tieng '] }),
    });
    expect(res.status).toBe(201);
    expect(res.json.data.defaultHashtags).toEqual(['NhatNgu', 'nhatngu', 'HocTieng']);
    expect(res.json.data.formats).toEqual([expect.objectContaining({ name: 'Bài chuẩn', isDefault: true, length: 'MEDIUM', withImage: true })]);
    expect((await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('Tiếng Nhật') })).status).toBe(409);
    const tooMany = await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('X', { defaultHashtags: Array(11).fill('a') }) });
    expect(tooMany.status).toBe(400);
  });

  it('allows at most 20 domains per user, archived included', async () => {
    const { user, cookie } = await createTestUser();
    await prisma.contentDomain.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({ userId: user.id, name: `D${i}`, isArchived: i % 2 === 0 })),
    });
    const res = await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('Thứ 21') });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch('20');
  });

  it('lists active domains with formats and usage counts; ?archived=1 adds archived ones', async () => {
    const { user, cookie } = await createTestUser();
    const a = (await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('A') })).json.data;
    await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('B') });
    await prisma.facebookPage.create({
      data: { userId: user.id, pageId: `LIST_${Date.now()}`, pageName: 'P', pageAccessToken: 'EAAfaketokenlistxxxxxxxxxxxxxxxxxx', defaultDomainId: a.id },
    });
    await api(server.baseUrl, 'PATCH', `/api/domains/${a.id}`, { cookie, body: { isArchived: true } });

    const active = (await api(server.baseUrl, 'GET', '/api/domains', { cookie })).json.data;
    expect(active.map((d: { name: string }) => d.name)).toEqual(['B']);
    const all = (await api(server.baseUrl, 'GET', '/api/domains?archived=1', { cookie })).json.data;
    expect(all.map((d: { name: string }) => d.name)).toEqual(['B', 'A']);
    expect(all[0]._count).toEqual({ pages: 0, posts: 0, schedules: 0 });
  });

  it('archiving a domain clears it as Page default; the last active domain cannot be archived or deleted', async () => {
    const { user, cookie } = await createTestUser();
    const a = (await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('A') })).json.data;
    const b = (await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('B') })).json.data;
    const page = await prisma.facebookPage.create({
      data: { userId: user.id, pageId: `ARCH_${Date.now()}`, pageName: 'P', pageAccessToken: 'EAAfaketokenarchivexxxxxxxxxxxxxxx', defaultDomainId: a.id },
    });

    expect((await api(server.baseUrl, 'PATCH', `/api/domains/${a.id}`, { cookie, body: { isArchived: true } })).status).toBe(200);
    expect((await prisma.facebookPage.findUniqueOrThrow({ where: { id: page.id } })).defaultDomainId).toBeNull();

    const last = await api(server.baseUrl, 'PATCH', `/api/domains/${b.id}`, { cookie, body: { isArchived: true } });
    expect(last.status).toBe(409);
    expect(last.json.error).toBe('Cần giữ ít nhất 1 lĩnh vực đang dùng.');
    expect((await api(server.baseUrl, 'DELETE', `/api/domains/${b.id}`, { cookie })).status).toBe(409);
  });

  it('a domain used by a post cannot be deleted (409); an unused one can', async () => {
    const { user, cookie } = await createTestUser();
    const used = (await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('Dùng') })).json.data;
    const unused = (await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('Không dùng') })).json.data;
    await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('Giữ lại') });
    const page = await prisma.facebookPage.create({
      data: { userId: user.id, pageId: `DEL_${Date.now()}`, pageName: 'P', pageAccessToken: 'EAAfaketokendelxxxxxxxxxxxxxxxxxxx' },
    });
    await prisma.post.create({ data: { userId: user.id, pageId: page.id, domainId: used.id, caption: 'x' } });

    const blocked = await api(server.baseUrl, 'DELETE', `/api/domains/${used.id}`, { cookie });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toMatch('lưu trữ');
    expect((await api(server.baseUrl, 'DELETE', `/api/domains/${unused.id}`, { cookie })).status).toBe(200);
    expect(await prisma.contentFormat.count({ where: { domainId: unused.id } })).toBe(0);
  });

  it('formats: a new default replaces the old one; the default cannot be unset, archived or deleted; 10 per domain', async () => {
    const { cookie } = await createTestUser();
    const d = (await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('F') })).json.data;
    const first = d.formats[0];
    const second = (
      await api(server.baseUrl, 'POST', `/api/domains/${d.id}/formats`, {
        cookie,
        body: { name: 'Ngắn', instructions: 'x', length: 'SHORT', isDefault: true },
      })
    ).json.data;
    expect(second.isDefault).toBe(true);
    expect((await prisma.contentFormat.findUniqueOrThrow({ where: { id: first.id } })).isDefault).toBe(false);

    expect((await api(server.baseUrl, 'PATCH', `/api/formats/${second.id}`, { cookie, body: { isDefault: false } })).status).toBe(409);
    expect((await api(server.baseUrl, 'PATCH', `/api/formats/${second.id}`, { cookie, body: { isArchived: true } })).status).toBe(409);
    expect((await api(server.baseUrl, 'DELETE', `/api/formats/${second.id}`, { cookie })).status).toBe(409);

    const back = await api(server.baseUrl, 'PATCH', `/api/formats/${first.id}`, { cookie, body: { isDefault: true, withImage: false, example: 'Mẫu' } });
    expect(back.json.data).toMatchObject({ isDefault: true, withImage: false, example: 'Mẫu' });
    expect((await api(server.baseUrl, 'DELETE', `/api/formats/${second.id}`, { cookie })).status).toBe(200);

    for (let i = 0; i < 9; i++) {
      await api(server.baseUrl, 'POST', `/api/domains/${d.id}/formats`, { cookie, body: { name: `F${i}`, instructions: 'x' } });
    }
    const eleventh = await api(server.baseUrl, 'POST', `/api/domains/${d.id}/formats`, { cookie, body: { name: 'F10', instructions: 'x' } });
    expect(eleventh.status).toBe(409);
  });

  it('a long migrated old prompt (real ones exceed the old 5,000 limit) can still be edited, up to 10,000', async () => {
    const { user, cookie } = await createTestUser();
    // A real local prompt measured 5,013 characters: legacy prompts are not bound by the old Settings limit
    const longPrompt = `Prompt cũ rất dài {{topic}} ${'x'.repeat(6000)}`;
    await prisma.setting.create({ data: { userId: user.id, key: 'systemPrompt', value: longPrompt } });
    await ensureDefaultDomain(user.id);
    const legacy = await prisma.contentFormat.findFirstOrThrow({ where: { domain: { userId: user.id } } });
    expect(legacy.instructions).toBe(longPrompt);

    // The drawer always sends the whole form, instructions included
    const res = await api(server.baseUrl, 'PATCH', `/api/formats/${legacy.id}`, {
      cookie,
      body: { name: 'Bài chuẩn (cũ)', instructions: longPrompt, example: null, length: 'MEDIUM', withImage: true, isDefault: true },
    });
    expect(res.status).toBe(200);
    expect(res.json.data.name).toBe('Bài chuẩn (cũ)');
    const tooLong = await api(server.baseUrl, 'PATCH', `/api/formats/${legacy.id}`, { cookie, body: { instructions: 'y'.repeat(10_001) } });
    expect(tooLong.status).toBe(400);
  });

  it('preview returns the composed prompt free; generate=true calls Gemini once and saves nothing', async () => {
    const { user, cookie } = await createTestUser();
    await saveSettings(user.id, { geminiApiKey: 'AIzaFakeKeyPreviewTest00000000000000' });
    const d = (await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('Nhật', { defaultHashtags: ['NhatNgu'] }) })).json.data;
    const formatId = d.formats[0].id;
    const spy = vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ post: 'Bài thử\n\n#hoc', image_prompt: 'a desk' } as never);

    const free = await api(server.baseUrl, 'POST', `/api/formats/${formatId}/preview`, { cookie, body: { idea: 'Chào sếp' } });
    expect(free.status).toBe(200);
    expect(free.json.data.prompt).toMatch('lĩnh vực "Nhật"');
    expect(free.json.data.prompt).toMatch('Ý tưởng bài viết: Chào sếp');
    expect(free.json.data.post).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();

    const paid = await api(server.baseUrl, 'POST', `/api/formats/${formatId}/preview`, { cookie, body: { idea: 'Chào sếp', generate: true } });
    expect(paid.json.data).toMatchObject({ post: 'Bài thử', hashtags: ['hoc', 'NhatNgu'], imagePrompt: 'a desk' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await prisma.post.count({ where: { userId: user.id } })).toBe(0);
  });

  it('keeps the instructions for writing Reel scripts; empty clears them', async () => {
    const { cookie } = await createTestUser();
    const created = (await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('Reel', { reelInstructions: '  Kể một câu chuyện ngắn về dân văn phòng.  ' }) })).json.data;
    expect(created.reelInstructions).toBe('Kể một câu chuyện ngắn về dân văn phòng.');
    const listed = (await api(server.baseUrl, 'GET', '/api/domains', { cookie })).json.data.find((d: { id: string }) => d.id === created.id);
    expect(listed.reelInstructions).toBe('Kể một câu chuyện ngắn về dân văn phòng.');
    const cleared = await api(server.baseUrl, 'PATCH', `/api/domains/${created.id}`, { cookie, body: { reelInstructions: '' } });
    expect(cleared.json.data.reelInstructions).toBeNull();
    const long = await api(server.baseUrl, 'PATCH', `/api/domains/${created.id}`, { cookie, body: { reelInstructions: 'x'.repeat(2001) } });
    expect(long.status).toBe(400);
  });
});
