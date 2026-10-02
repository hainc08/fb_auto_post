import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { GeminiClient } from '../src/lib/clients/gemini';
import { edgeTts } from '../src/lib/reel/edge-tts';
import { reelRenderer } from '../src/lib/reel/render';
import * as renderModule from '../src/lib/reel/render';
import { readReelBackground } from '../src/lib/reel/background-store';
import { saveImage } from '../src/lib/image-store';
import { saveSettings } from '../src/lib/settings';
import { resolveVideo } from '../src/lib/video-store';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';
import { tinyMp4 } from './helpers/mp4';

let server: Awaited<ReturnType<typeof startTestServer>>;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('picture')]);
const SCRIPT = 'Bạn mất bao lâu để viết một email? Thử ngay hôm nay!';
const WORDS = SCRIPT.split(' ').map((text, i) => ({ text: text.replace(/[?!]/g, ''), startMs: i * 300, durationMs: 300 }));

/** Edge TTS and FFmpeg replaced: the "render" writes a tiny valid vertical MP4 */
function fakePipeline(durationSec = 20) {
  vi.spyOn(renderModule, 'ffmpegAvailable').mockResolvedValue(true);
  const voice = vi.spyOn(edgeTts, 'synthesize').mockResolvedValue({ audio: Buffer.from('mp3'), words: WORDS });
  const render = vi.spyOn(reelRenderer, 'render').mockImplementation(async ({ outPath }) => {
    await writeFile(outPath, tinyMp4({ durationSec, width: 1080, height: 1920 }));
  });
  return { voice, render };
}

async function setup(withImage = true) {
  const { user, cookie } = await createTestUser();
  const page = await prisma.facebookPage.create({ data: { userId: user.id, pageId: `REEL_${Date.now()}_${Math.random()}`, pageName: 'P', pageAccessToken: 'EAAfaketokenreelxxxxxxxxxxxxxxxxxxx' } });
  let post = await prisma.post.create({ data: { userId: user.id, pageId: page.id, caption: 'Bài viết dài về email.', status: 'READY', inputData: { basicInfo: 'ý tưởng' } } });
  if (withImage) {
    const saved = await saveImage(post.id, PNG);
    post = await prisma.post.update({ where: { id: post.id }, data: { imagePath: saved.imagePath, imageUrl: saved.imageUrl } });
  }
  return { cookie, post, userId: user.id };
}
const make = (cookie: string, id: string, body: Record<string, unknown> = { script: SCRIPT }) => api(server.baseUrl, 'POST', `/api/posts/${id}/reel`, { cookie, body });
const row = (id: string) => prisma.post.findUniqueOrThrow({ where: { id } });

describe.skipIf(!process.env.RUN_DB_TESTS)('text to Reel', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('makes a Reel: the video replaces the picture, which becomes the background', async () => {
    const { cookie, post } = await setup();
    const { voice, render } = fakePipeline();
    const res = await make(cookie, post.id, { script: SCRIPT, voice: 'vi-VN-NamMinhNeural' });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ videoKind: 'REEL', reelsProblem: null, reelScript: SCRIPT, videoMeta: { width: 1080, height: 1920, durationSec: 20 } });
    expect(voice).toHaveBeenCalledWith(SCRIPT, 'vi-VN-NamMinhNeural');
    const input = render.mock.calls[0][0];
    expect(input.image).toMatchObject({ mime: 'image/png' });
    // subtitles use the script's own words (punctuation kept), under the picture
    expect(input.ass).toContain('email?');
    expect(input.ass).toMatch(/,2,80,80,430,1$/m);
    const saved = await row(post.id);
    expect(saved).toMatchObject({ videoKind: 'REEL', imagePath: null, imageUrl: null, status: 'READY' });
    expect(saved.inputData).toMatchObject({ basicInfo: 'ý tưởng', reelScript: SCRIPT, reelVoice: 'vi-VN-NamMinhNeural' });
    expect(existsSync(resolveVideo(saved.videoPath!)!)).toBe(true);
    expect((await readReelBackground(post.id))?.buffer.equals(PNG)).toBe(true);
    expect(await prisma.postLog.count({ where: { postId: post.id, action: 'reel_rendered' } })).toBe(1);
  });

  it('a second render reuses the picture and removes the first video', async () => {
    const { cookie, post } = await setup();
    const { render } = fakePipeline();
    await make(cookie, post.id);
    const first = (await row(post.id)).videoPath!;
    const res = await make(cookie, post.id, { script: `${SCRIPT} Cảm ơn bạn đã xem.` });
    expect(res.status).toBe(200);
    expect(render.mock.calls[1][0].image).toMatchObject({ mime: 'image/png' });
    const second = (await row(post.id)).videoPath!;
    expect(second).not.toBe(first);
    expect(existsSync(resolveVideo(first)!)).toBe(false);
  });

  it('without a picture the text is centred on a plain ground', async () => {
    const { cookie, post } = await setup(false);
    const { render } = fakePipeline();
    expect((await make(cookie, post.id)).status).toBe(200);
    expect(render.mock.calls[0][0].image).toBeNull();
    expect(render.mock.calls[0][0].ass).toMatch(/,5,80,80,0,1$/m);
  });

  it('when the voice service fails nothing changes', async () => {
    const { cookie, post } = await setup();
    const { render } = fakePipeline();
    vi.spyOn(edgeTts, 'synthesize').mockRejectedValue(new Error('Dịch vụ giọng đọc từ chối kết nối (HTTP 403).'));
    const res = await make(cookie, post.id);
    expect(res.status).toBe(502);
    expect(res.json.error).toMatch(/Chưa tạo được giọng đọc.*HTTP 403/);
    expect(render).not.toHaveBeenCalled();
    expect(await row(post.id)).toMatchObject({ videoPath: null, imagePath: post.imagePath });
  });

  it('a Reel longer than 90 seconds is refused and its file removed', async () => {
    const { cookie, post } = await setup();
    fakePipeline(120);
    const res = await make(cookie, post.id);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/3–90 giây/);
    expect(await row(post.id)).toMatchObject({ videoPath: null, imagePath: post.imagePath });
  });

  it('a second render while one is running is refused', async () => {
    const { cookie, post } = await setup();
    fakePipeline();
    let release!: () => void;
    vi.spyOn(edgeTts, 'synthesize').mockImplementation(() => new Promise((resolve) => (release = () => resolve({ audio: Buffer.from('mp3'), words: WORDS }))));
    const first = make(cookie, post.id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const second = await make(cookie, post.id);
    expect(second.status).toBe(409);
    expect(second.json.error).toMatch(/đang được dựng/);
    release();
    expect((await first).status).toBe(200);
  });

  it('refuses a script that is too short, an unknown voice, and a host without FFmpeg', async () => {
    const { cookie, post } = await setup();
    const { voice } = fakePipeline();
    const short = await make(cookie, post.id, { script: 'Xin chào bạn' });
    expect(short.status).toBe(400);
    expect(short.json.error).toMatch(/ít nhất 5 từ/);
    expect((await make(cookie, post.id, { script: SCRIPT, voice: 'en-US-GuyNeural' })).status).toBe(400);
    vi.spyOn(renderModule, 'ffmpegAvailable').mockResolvedValue(false);
    const none = await make(cookie, post.id);
    expect(none.status).toBe(503);
    expect(none.json.error).toMatch(/FFmpeg/);
    expect(voice).not.toHaveBeenCalled();
  });

  it('refuses a post that is already on a Page', async () => {
    const { cookie, post } = await setup();
    fakePipeline();
    await prisma.post.update({ where: { id: post.id }, data: { status: 'PUBLISHED' } });
    expect((await make(cookie, post.id)).status).toBe(409);
  });

  it('AI writes a short script from the post text', async () => {
    const { cookie, post, userId } = await setup();
    await saveSettings(userId, { geminiApiKey: 'AIzaFakeKeyReelTest000000000000000000' });
    const spy = vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ script: '  Bạn có biết? AI viết email trong mười giây.  ' } as never);
    const res = await api(server.baseUrl, 'POST', `/api/posts/${post.id}/reel/script`, { cookie });
    expect(res.status).toBe(200);
    expect(res.json.data.script).toBe('Bạn có biết? AI viết email trong mười giây.');
    expect(spy.mock.calls[0][0].prompt).toContain('Bài viết dài về email.');
    const empty = await prisma.post.update({ where: { id: post.id }, data: { caption: null } });
    expect((await api(server.baseUrl, 'POST', `/api/posts/${empty.id}/reel/script`, { cookie })).status).toBe(400);
  });

  it('deleting the post removes the kept picture', async () => {
    const { cookie, post } = await setup();
    fakePipeline();
    await make(cookie, post.id);
    expect((await api(server.baseUrl, 'DELETE', `/api/posts/${post.id}`, { cookie })).status).toBe(200);
    expect(await readReelBackground(post.id)).toBeNull();
  });
});
