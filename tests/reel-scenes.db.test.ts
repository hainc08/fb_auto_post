import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { GeminiClient } from '../src/lib/clients/gemini';
import { CloudflareClient } from '../src/lib/clients/cloudflare';
import * as renderModule from '../src/lib/reel/render';
import { REEL_DIR } from '../src/lib/reel/background-store';
import { saveSettings } from '../src/lib/settings';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('scene picture')]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('uploaded')]);
const made: string[] = [];
const sceneFiles = async (postId: string) => (existsSync(REEL_DIR) ? (await readdir(REEL_DIR)).filter((n) => n.startsWith(`${postId}.`) && !n.endsWith('.bg')) : []);

async function setup() {
  const { user, cookie } = await createTestUser();
  await saveSettings(user.id, { geminiApiKey: 'AIzaFakeKeyReelScenes0000000000000000', cfAccountId: 'acc-reel-scenes', cfApiToken: 'cf-fake-token-reel-scenes' });
  const domain = await prisma.contentDomain.create({
    data: { userId: user.id, name: `AI văn phòng ${Math.random()}`, audience: 'Dân văn phòng', voice: 'Thân thiện', imageStyle: 'flat illustration', reelInstructions: 'Kể một câu chuyện ngắn.' },
  });
  const page = await prisma.facebookPage.create({ data: { userId: user.id, pageId: `RSC_${Date.now()}_${Math.random()}`, pageName: 'P', pageAccessToken: 'EAAfaketokenreelscenesxxxxxxxxxxxxx' } });
  const post = await prisma.post.create({ data: { userId: user.id, pageId: page.id, domainId: domain.id, caption: 'Bài viết dài về email.', status: 'READY' } });
  made.push(post.id);
  return { cookie, post, userId: user.id };
}

const base = (id: string) => `/api/posts/${id}/reel`;
const put = (cookie: string, id: string, scenes: Array<Record<string, unknown>>, voice?: string) => api(server.baseUrl, 'PUT', `${base(id)}/draft`, { cookie, body: { scenes, ...(voice && { voice }) } });
const fakeCloudflare = () => vi.spyOn(CloudflareClient.prototype, 'generateImage').mockResolvedValue({ buffer: PNG, mimeType: 'image/png' } as never);

async function uploadPicture(cookie: string, postId: string, sceneId: string, content: Buffer) {
  const form = new FormData();
  form.append('image', new Blob([content]), 'picture.jpg');
  const res = await fetch(`${server.baseUrl}${base(postId)}/scenes/${sceneId}/image/upload`, { method: 'POST', headers: { Cookie: cookie, 'X-Requested-With': 'autopost' }, body: form });
  return { status: res.status, json: await res.json() };
}

describe.skipIf(!process.env.RUN_DB_TESTS)('Reel scenes', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    for (const id of made) for (const name of existsSync(REEL_DIR) ? (await readdir(REEL_DIR)).filter((n) => n.startsWith(id)) : []) await unlink(path.join(REEL_DIR, name)).catch(() => {});
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('a post has no scenes at first; saved scenes get ids and keep them across edits', async () => {
    const { cookie, post } = await setup();
    expect((await api(server.baseUrl, 'GET', `${base(post.id)}/draft`, { cookie })).json.data).toEqual({ voice: 'vi-VN-HoaiMyNeural', scenes: [] });

    const saved = (await put(cookie, post.id, [{ text: ' Bạn có biết? ', imagePrompt: ' an office ' }, { text: 'Thử ngay!' }], 'vi-VN-NamMinhNeural')).json.data;
    expect(saved.voice).toBe('vi-VN-NamMinhNeural');
    expect(saved.scenes).toEqual([
      { id: expect.stringMatching(/^[0-9a-f]{8}$/), text: 'Bạn có biết?', imagePrompt: 'an office', imageUrl: null },
      { id: expect.stringMatching(/^[0-9a-f]{8}$/), text: 'Thử ngay!', imagePrompt: '', imageUrl: null },
    ]);
    const [a, b] = saved.scenes;
    const edited = (await put(cookie, post.id, [{ id: b.id, text: 'Thử ngay hôm nay!' }, { id: a.id, text: a.text, imagePrompt: 'a desk' }])).json.data;
    expect(edited.scenes.map((s: { id: string }) => s.id)).toEqual([b.id, a.id]);
    expect(edited.voice).toBe('vi-VN-NamMinhNeural');
    expect((await api(server.baseUrl, 'GET', `${base(post.id)}/draft`, { cookie })).json.data).toEqual(edited);
    expect((await put(cookie, post.id, Array.from({ length: 9 }, () => ({ text: 'x' })))).status).toBe(400);
  });

  it('AI writes the scenes from the post with the domain\'s instructions and replaces the draft', async () => {
    const { cookie, post } = await setup();
    vi.spyOn(renderModule, 'ffmpegAvailable').mockResolvedValue(true);
    fakeCloudflare();
    const old = (await put(cookie, post.id, [{ text: 'Cảnh cũ', imagePrompt: 'old' }])).json.data.scenes[0];
    await api(server.baseUrl, 'POST', `${base(post.id)}/scenes/${old.id}/image/generate`, { cookie });
    expect(await sceneFiles(post.id)).toHaveLength(1);

    const gemini = vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({
      scenes: [{ text: ' 5 giờ chiều, sếp gửi file 30 trang. ', image_prompt: 'a tired office worker at dusk' }, { text: '   ' }, { text: 'Thử ngay hôm nay!', image_prompt: 'a smiling worker' }],
    } as never);
    const res = await api(server.baseUrl, 'POST', `${base(post.id)}/script`, { cookie });
    expect(res.status).toBe(200);
    expect(res.json.data.scenes).toEqual([
      { id: expect.any(String), text: '5 giờ chiều, sếp gửi file 30 trang.', imagePrompt: 'a tired office worker at dusk', imageUrl: null },
      { id: expect.any(String), text: 'Thử ngay hôm nay!', imagePrompt: 'a smiling worker', imageUrl: null },
    ]);
    const asked = gemini.mock.calls[0][0];
    expect(asked.prompt).toContain('Bài viết dài về email.');
    expect(asked.systemInstruction).toContain('Giọng văn: Thân thiện');
    expect(asked.systemInstruction).toContain('Cách viết kịch bản:\nKể một câu chuyện ngắn.');
    // the old scene and its picture are gone
    expect(await sceneFiles(post.id)).toEqual([]);
    expect((await api(server.baseUrl, 'GET', `${base(post.id)}/draft`, { cookie })).json.data).toEqual(res.json.data);
  });

  it('AI script: no text in the post is a 400; a model that returns no usable scene is a 502 and the draft stays', async () => {
    const { cookie, post } = await setup();
    vi.spyOn(renderModule, 'ffmpegAvailable').mockResolvedValue(true);
    await put(cookie, post.id, [{ text: 'Giữ nguyên' }]);
    vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ scenes: [{ text: '  ' }] } as never);
    const res = await api(server.baseUrl, 'POST', `${base(post.id)}/script`, { cookie });
    expect(res.status).toBe(502);
    expect((await api(server.baseUrl, 'GET', `${base(post.id)}/draft`, { cookie })).json.data.scenes[0].text).toBe('Giữ nguyên');
    await prisma.post.update({ where: { id: post.id }, data: { caption: null } });
    expect((await api(server.baseUrl, 'POST', `${base(post.id)}/script`, { cookie })).status).toBe(400);
  });

  it('a scene picture is generated from its prompt in the domain\'s style, served to the owner, replaced and removed', async () => {
    const { cookie, post } = await setup();
    const cloudflare = fakeCloudflare();
    const [a, b] = (await put(cookie, post.id, [{ text: 'Một', imagePrompt: 'an office at night' }, { text: 'Hai' }])).json.data.scenes;

    const res = await api(server.baseUrl, 'POST', `${base(post.id)}/scenes/${a.id}/image/generate`, { cookie });
    expect(res.status).toBe(200);
    expect(cloudflare).toHaveBeenCalledWith('flat illustration. an office at night');
    const url: string = res.json.data.scenes[0].imageUrl;
    expect(url).toMatch(new RegExp(`^/api/posts/${post.id}/reel/scenes/${a.id}/image\\?v=\\d+$`));
    const picture = await fetch(server.baseUrl + url, { headers: { Cookie: cookie } });
    expect(picture.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await picture.arrayBuffer()).equals(PNG)).toBe(true);

    // a scene with no prompt cannot be generated
    const none = await api(server.baseUrl, 'POST', `${base(post.id)}/scenes/${b.id}/image/generate`, { cookie });
    expect(none.status).toBe(400);
    expect(none.json.error).toMatch(/mô tả ảnh/);

    // an upload replaces the generated picture: one file per scene
    const uploaded = await uploadPicture(cookie, post.id, a.id, JPG);
    expect(uploaded.status).toBe(200);
    expect(uploaded.json.data.scenes[0].imageUrl).not.toBe(url);
    expect(await sceneFiles(post.id)).toHaveLength(1);
    expect((await uploadPicture(cookie, post.id, a.id, Buffer.from('not a picture'))).status).toBe(400);

    const removed = await api(server.baseUrl, 'DELETE', `${base(post.id)}/scenes/${a.id}/image`, { cookie });
    expect(removed.json.data.scenes[0].imageUrl).toBeNull();
    expect(await sceneFiles(post.id)).toEqual([]);
    expect((await api(server.baseUrl, 'POST', `${base(post.id)}/scenes/ffffffff/image/generate`, { cookie })).status).toBe(404);
  });

  it('removing a scene, or deleting the post, deletes the pictures that went away', async () => {
    const { cookie, post } = await setup();
    fakeCloudflare();
    const [a, b] = (await put(cookie, post.id, [{ text: 'Một', imagePrompt: 'x' }, { text: 'Hai', imagePrompt: 'y' }])).json.data.scenes;
    await api(server.baseUrl, 'POST', `${base(post.id)}/scenes/${a.id}/image/generate`, { cookie });
    await api(server.baseUrl, 'POST', `${base(post.id)}/scenes/${b.id}/image/generate`, { cookie });
    expect(await sceneFiles(post.id)).toHaveLength(2);
    const kept = (await put(cookie, post.id, [{ id: b.id, text: 'Hai' }])).json.data;
    expect(kept.scenes[0].imageUrl).toMatch(/image\?v=/);
    expect(await sceneFiles(post.id)).toHaveLength(1);
    expect((await api(server.baseUrl, 'DELETE', `/api/posts/${post.id}`, { cookie })).status).toBe(200);
    expect(await sceneFiles(post.id)).toEqual([]);
  });

  it('a picture that finishes after its scene was removed is discarded', async () => {
    const { cookie, post } = await setup();
    const [a] = (await put(cookie, post.id, [{ text: 'Một', imagePrompt: 'x' }])).json.data.scenes;
    // the member rewrites the scenes while Cloudflare is still drawing
    vi.spyOn(CloudflareClient.prototype, 'generateImage').mockImplementation(async () => {
      await put(cookie, post.id, [{ text: 'Cảnh khác' }]);
      return { buffer: PNG, mimeType: 'image/png' } as never;
    });
    const res = await api(server.baseUrl, 'POST', `${base(post.id)}/scenes/${a.id}/image/generate`, { cookie });
    expect(res.status).toBe(409);
    expect(await sceneFiles(post.id)).toEqual([]);
  });

  it('another member cannot read a scene picture; a published post cannot be edited', async () => {
    const { cookie, post } = await setup();
    fakeCloudflare();
    const [a] = (await put(cookie, post.id, [{ text: 'Một', imagePrompt: 'x' }])).json.data.scenes;
    const url = (await api(server.baseUrl, 'POST', `${base(post.id)}/scenes/${a.id}/image/generate`, { cookie })).json.data.scenes[0].imageUrl;
    const other = await createTestUser();
    expect((await fetch(server.baseUrl + url, { headers: { Cookie: other.cookie } })).status).toBe(404);
    expect((await api(server.baseUrl, 'GET', `${base(post.id)}/draft`, { cookie: other.cookie })).status).toBe(404);

    await prisma.post.update({ where: { id: post.id }, data: { status: 'PUBLISHED' } });
    expect((await put(cookie, post.id, [{ text: 'x' }])).status).toBe(409);
    // …but its draft and pictures can still be looked at
    expect((await api(server.baseUrl, 'GET', `${base(post.id)}/draft`, { cookie })).status).toBe(200);
    expect((await fetch(server.baseUrl + url, { headers: { Cookie: cookie } })).status).toBe(200);
  });
});
