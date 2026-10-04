import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { GeminiClient } from '../src/lib/clients/gemini';
import { CloudflareClient } from '../src/lib/clients/cloudflare';
import { edgeTts } from '../src/lib/reel/edge-tts';
import { reelRenderer } from '../src/lib/reel/render';
import * as renderModule from '../src/lib/reel/render';
import { readReelBackground, REEL_DIR } from '../src/lib/reel/background-store';
import { IMAGE_DIR, saveImage } from '../src/lib/image-store';
import { saveSettings } from '../src/lib/settings';
import { resolveVideo, VIDEO_DIR } from '../src/lib/video-store';
import { startWorkers } from '../src/services/scheduler.service';
import { reelJobKey, requeueInterruptedReels } from '../src/services/reel.service';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';
import { tinyMp4 } from './helpers/mp4';

let server: Awaited<ReturnType<typeof startTestServer>>;
let stopWorker: (() => void) | undefined;
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

/** Posts made by this file: their files and jobs are removed at the end (deleting the test users removes rows only) */
const made: string[] = [];
const filesOf = async (dir: string, postId: string) => (existsSync(dir) ? (await readdir(dir)).filter((n) => n.startsWith(postId)) : []);
const videoFilesOf = (postId: string) => filesOf(VIDEO_DIR, postId);

async function setup(withImage = true) {
  const { user, cookie } = await createTestUser();
  const page = await prisma.facebookPage.create({ data: { userId: user.id, pageId: `REEL_${Date.now()}_${Math.random()}`, pageName: 'P', pageAccessToken: 'EAAfaketokenreelxxxxxxxxxxxxxxxxxxx' } });
  let post = await prisma.post.create({ data: { userId: user.id, pageId: page.id, caption: 'Bài viết dài về email.', status: 'READY', inputData: { basicInfo: 'ý tưởng' } } });
  made.push(post.id);
  if (withImage) {
    const saved = await saveImage(post.id, PNG);
    post = await prisma.post.update({ where: { id: post.id }, data: { imagePath: saved.imagePath, imageUrl: saved.imageUrl } });
  }
  return { cookie, post, userId: user.id };
}

const row = (id: string) => prisma.post.findUniqueOrThrow({ where: { id } });
const jobOf = (id: string) => prisma.job.findUnique({ where: { key: reelJobKey(id) } });
const queue = (cookie: string, id: string, body: Record<string, unknown> = { script: SCRIPT }) => api(server.baseUrl, 'POST', `/api/posts/${id}/reel`, { cookie, body });
const progress = (cookie: string, id: string) => api(server.baseUrl, 'GET', `/api/posts/${id}/reel/progress`, { cookie });

/** Wait for the worker to finish the post's job (DONE or FAILED) */
async function settled(id: string, ms = 15_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const job = await jobOf(id);
    if (job && (job.status === 'DONE' || job.status === 'FAILED')) return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the reel job did not finish');
}

/** Queue a Reel and wait for it: the state the dialog would end on */
async function make(cookie: string, id: string, body: Record<string, unknown> = { script: SCRIPT }) {
  const res = await queue(cookie, id, body);
  if (res.status !== 202) throw new Error(`not queued: ${res.status} ${res.text}`);
  await settled(id);
  return (await progress(cookie, id)).json.data;
}

describe.skipIf(!process.env.RUN_DB_TESTS)('text to Reel', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    server = await startTestServer(createApp());
    stopWorker = startWorkers({ pollMs: 200, only: ['render_reel'] });
  });
  afterAll(async () => {
    stopWorker?.();
    for (const id of made) {
      for (const dir of [VIDEO_DIR, IMAGE_DIR, REEL_DIR]) {
        for (const name of await filesOf(dir, id)) await unlink(path.join(dir, name)).catch(() => {});
      }
    }
    await prisma.job.deleteMany({ where: { key: { in: made.map(reelJobKey) } } });
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('queues the Reel at once; the worker makes it and the video replaces the picture', async () => {
    const { cookie, post } = await setup();
    const { voice, render } = fakePipeline();
    const res = await queue(cookie, post.id, { script: SCRIPT, voice: 'vi-VN-NamMinhNeural' });
    expect(res.status).toBe(202);
    expect(res.json.data).toEqual({ state: 'queued' });
    expect(await jobOf(post.id)).toMatchObject({ type: 'render_reel', maxAttempts: 1 });
    await settled(post.id);

    const done = (await progress(cookie, post.id)).json.data;
    expect(done).toMatchObject({ state: 'done', reelScript: SCRIPT, video: { videoKind: 'REEL', reelsProblem: null, videoMeta: { width: 1080, height: 1920, durationSec: 20 } } });
    expect(voice).toHaveBeenCalledWith(SCRIPT, 'vi-VN-NamMinhNeural');
    const input = render.mock.calls[0][0];
    expect(input.scenes).toEqual([{ image: expect.objectContaining({ mime: 'image/png' }), startMs: 0 }]);
    // subtitles use the script's own words (punctuation kept), under the picture
    expect(input.ass).toContain('email?');
    expect(input.ass).toMatch(/,2,80,80,430,1$/m);
    const saved = await row(post.id);
    expect(saved).toMatchObject({ videoKind: 'REEL', imagePath: null, imageUrl: null, status: 'READY' });
    expect(saved.videoUrl).toBe(done.video.videoUrl);
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
    expect((await make(cookie, post.id, { script: `${SCRIPT} Cảm ơn bạn đã xem.` })).state).toBe('done');
    expect(render.mock.calls[1][0].scenes![0].image).toMatchObject({ mime: 'image/png' });
    const second = (await row(post.id)).videoPath!;
    expect(second).not.toBe(first);
    expect(existsSync(resolveVideo(first)!)).toBe(false);
  });

  it('without a picture the text is centred on a plain ground', async () => {
    const { cookie, post } = await setup(false);
    const { render } = fakePipeline();
    expect((await make(cookie, post.id)).state).toBe('done');
    expect(render.mock.calls[0][0].scenes).toEqual([{ image: null, startMs: 0 }]);
    expect(render.mock.calls[0][0].ass).toMatch(/,5,80,80,0,1$/m);
  });

  it('the dialog\'s state when the job failed: the reason, and nothing changed', async () => {
    const { cookie, post } = await setup();
    const { render } = fakePipeline();
    vi.spyOn(edgeTts, 'synthesize').mockRejectedValue(new Error('Dịch vụ giọng đọc từ chối kết nối (HTTP 403).'));
    const state = await make(cookie, post.id);
    expect(state.state).toBe('failed');
    expect(state.error).toMatch(/Chưa tạo được giọng đọc.*HTTP 403/);
    expect(render).not.toHaveBeenCalled();
    expect(await row(post.id)).toMatchObject({ videoPath: null, imagePath: post.imagePath });
    // failed for good: one attempt, and a new request is accepted
    expect(await jobOf(post.id)).toMatchObject({ status: 'FAILED', attempts: 1 });
    fakePipeline();
    expect((await make(cookie, post.id)).state).toBe('done');
  });

  it('a Reel longer than 90 seconds is refused and its file removed', async () => {
    const { cookie, post } = await setup();
    fakePipeline(120);
    const state = await make(cookie, post.id);
    expect(state).toMatchObject({ state: 'failed' });
    expect(state.error).toMatch(/3–90 giây/);
    expect(await row(post.id)).toMatchObject({ videoPath: null, imagePath: post.imagePath });
    expect(await videoFilesOf(post.id)).toEqual([]);
  });

  it('a post that starts publishing while its Reel is rendered is left alone', async () => {
    const { cookie, post } = await setup();
    fakePipeline();
    // e.g. its timed job fires during the 20–60 seconds of rendering
    vi.spyOn(edgeTts, 'synthesize').mockImplementation(async () => {
      await prisma.post.update({ where: { id: post.id }, data: { status: 'PUBLISHING' } });
      return { audio: Buffer.from('mp3'), words: WORDS };
    });
    const state = await make(cookie, post.id);
    expect(state.state).toBe('failed');
    expect(state.error).toMatch(/vừa thay đổi/);
    expect(await row(post.id)).toMatchObject({ status: 'PUBLISHING', videoPath: null, videoKind: null, imagePath: post.imagePath });
    expect(await videoFilesOf(post.id)).toEqual([]);
  });

  it('a post deleted while its Reel is rendered leaves no file behind', async () => {
    const { cookie, post } = await setup();
    fakePipeline();
    vi.spyOn(edgeTts, 'synthesize').mockImplementation(async () => {
      await prisma.post.delete({ where: { id: post.id } });
      return { audio: Buffer.from('mp3'), words: WORDS };
    });
    expect((await queue(cookie, post.id)).status).toBe(202);
    await settled(post.id);
    expect((await progress(cookie, post.id)).status).toBe(404);
    expect(await videoFilesOf(post.id)).toEqual([]);
    expect(await readReelBackground(post.id)).toBeNull();
  });

  it('a second request while one is queued or running is refused', async () => {
    const { cookie, post } = await setup();
    fakePipeline();
    let release!: () => void;
    vi.spyOn(edgeTts, 'synthesize').mockImplementation(() => new Promise((resolve) => (release = () => resolve({ audio: Buffer.from('mp3'), words: WORDS }))));
    expect((await queue(cookie, post.id)).status).toBe(202);
    // refused at once, whether the worker has taken the job yet or not
    const early = await queue(cookie, post.id);
    expect(early.status).toBe(409);
    expect(early.json.error).toMatch(/đang được dựng/);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 5000 });
    expect((await queue(cookie, post.id)).status).toBe(409);
    expect((await progress(cookie, post.id)).json.data).toEqual({ state: 'running', stage: 'voice', percent: 10 });
    release();
    await settled(post.id);
    expect(await videoFilesOf(post.id)).toHaveLength(1);
  });

  it('reports queued, each step with its percentage, then done', async () => {
    const { cookie, post } = await setup();
    fakePipeline();
    const state = async () => (await progress(cookie, post.id)).json.data;
    const seen: unknown[] = [await state()];
    vi.spyOn(edgeTts, 'synthesize').mockImplementation(async () => {
      seen.push(await state());
      return { audio: Buffer.from('mp3'), words: WORDS };
    });
    vi.spyOn(reelRenderer, 'render').mockImplementation(async ({ outPath, onProgress, durationMs }) => {
      expect(durationMs).toBe(WORDS.length * 300);
      seen.push(await state());
      onProgress?.(0.5);
      seen.push(await state());
      onProgress?.(1);
      seen.push(await state());
      await writeFile(outPath, tinyMp4({ durationSec: 20, width: 1080, height: 1920 }));
    });
    // the worker is paused for a moment: the job is seen waiting
    stopWorker?.();
    await new Promise((r) => setTimeout(r, 400)); // let a poll in flight end
    expect((await queue(cookie, post.id)).status).toBe(202);
    seen.push(await state());
    stopWorker = startWorkers({ pollMs: 200, only: ['render_reel'] });
    await settled(post.id);
    expect(seen).toEqual([
      { state: 'idle' },
      { state: 'queued', stage: 'voice', percent: 3 },
      { state: 'running', stage: 'voice', percent: 10 },
      { state: 'running', stage: 'render', percent: 40 },
      { state: 'running', stage: 'render', percent: 68 },
      { state: 'running', stage: 'render', percent: 95 },
    ]);
    expect((await state()).state).toBe('done');
    // another member cannot watch it
    const other = await createTestUser();
    expect((await progress(other.cookie, post.id)).status).toBe(404);
  });

  it('a job interrupted by a restart is put back at startup and finishes, without a 10-minute wait', async () => {
    const { cookie, post } = await setup();
    fakePipeline();
    stopWorker?.();
    await new Promise((r) => setTimeout(r, 400)); // let a poll in flight end
    expect((await queue(cookie, post.id)).status).toBe(202);
    // as left by a process that died a moment ago, in the middle of rendering
    await prisma.job.update({ where: { key: reelJobKey(post.id) }, data: { status: 'RUNNING', attempts: 1, lockToken: 'dead-process', lockedAt: new Date() } });
    expect((await progress(cookie, post.id)).json.data).toEqual({ state: 'running', stage: 'voice', percent: 5 });
    expect((await queue(cookie, post.id)).status).toBe(409);
    // what the server does when it starts
    expect(await requeueInterruptedReels()).toBe(1);
    expect(await jobOf(post.id)).toMatchObject({ status: 'PENDING', interrupted: true, lockToken: null });
    stopWorker = startWorkers({ pollMs: 200, only: ['render_reel'] });
    await settled(post.id);
    expect((await progress(cookie, post.id)).json.data.state).toBe('done');
    expect(await row(post.id)).toMatchObject({ videoKind: 'REEL' });
  });

  it('refuses a script that is too short, an unknown voice, and a host without FFmpeg, before queueing', async () => {
    const { cookie, post } = await setup();
    fakePipeline();
    const short = await queue(cookie, post.id, { script: 'Xin chào bạn' });
    expect(short.status).toBe(400);
    expect(short.json.error).toMatch(/ít nhất 5 từ/);
    expect((await queue(cookie, post.id, { script: SCRIPT, voice: 'en-US-GuyNeural' })).status).toBe(400);
    vi.spyOn(renderModule, 'ffmpegAvailable').mockResolvedValue(false);
    const none = await queue(cookie, post.id);
    expect(none.status).toBe(503);
    expect(none.json.error).toMatch(/FFmpeg/);
    expect(await jobOf(post.id)).toBeNull();
  });

  it('refuses a post that is already published or live on one of its Pages', async () => {
    const { cookie, post } = await setup();
    fakePipeline();
    await prisma.postTarget.create({ data: { postId: post.id, pageId: post.pageId, status: 'PUBLISHED', fbPostId: 'live_1' } });
    expect((await queue(cookie, post.id)).status).toBe(409);
    await prisma.postTarget.deleteMany({ where: { postId: post.id } });
    await prisma.post.update({ where: { id: post.id }, data: { status: 'PUBLISHED' } });
    expect((await queue(cookie, post.id)).status).toBe(409);
    expect(await jobOf(post.id)).toBeNull();
  });

  it('deleting the post removes its kept picture and its job', async () => {
    const { cookie, post } = await setup();
    fakePipeline();
    await make(cookie, post.id);
    expect(await jobOf(post.id)).not.toBeNull();
    expect((await api(server.baseUrl, 'DELETE', `/api/posts/${post.id}`, { cookie })).status).toBe(200);
    expect(await readReelBackground(post.id)).toBeNull();
    expect(await jobOf(post.id)).toBeNull();
  });

  it('says whether Reels can be made here, and writes no script when they cannot', async () => {
    const { cookie, post, userId } = await setup();
    await saveSettings(userId, { geminiApiKey: 'AIzaFakeKeyReelTest000000000000000000' });
    const gemini = vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ script: 'x' } as never);
    const available = vi.spyOn(renderModule, 'ffmpegAvailable').mockResolvedValue(true);
    expect((await api(server.baseUrl, 'GET', '/api/posts/reel/status', { cookie })).json.data).toEqual({ available: true });
    available.mockResolvedValue(false);
    expect((await api(server.baseUrl, 'GET', '/api/posts/reel/status', { cookie })).json.data).toEqual({ available: false });
    const res = await api(server.baseUrl, 'POST', `/api/posts/${post.id}/reel/script`, { cookie });
    expect(res.status).toBe(503);
    expect(res.json.error).toMatch(/FFmpeg/);
    expect(gemini).not.toHaveBeenCalled();
  });

  // ─── Scenes ─────────────────────────────────────

  const SCENE_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('scene picture')]);
  const draftOf = async (cookie: string, id: string) => (await api(server.baseUrl, 'GET', `/api/posts/${id}/reel/draft`, { cookie })).json.data;
  const sceneFiles = async (id: string) => (await filesOf(REEL_DIR, id)).filter((n) => !n.endsWith('.bg'));

  /** Save scenes and give the first one a picture "generated" by Cloudflare */
  async function scenesWithPicture(cookie: string, userId: string, id: string, scenes: Array<Record<string, unknown>>, voice?: string) {
    await saveSettings(userId, { cfAccountId: 'acc-reel', cfApiToken: 'cf-fake-token-reel' });
    vi.spyOn(CloudflareClient.prototype, 'generateImage').mockResolvedValue({ buffer: SCENE_PNG, mimeType: 'image/png' } as never);
    const saved = (await api(server.baseUrl, 'PUT', `/api/posts/${id}/reel/draft`, { cookie, body: { scenes, ...(voice && { voice }) } })).json.data;
    const res = await api(server.baseUrl, 'POST', `/api/posts/${id}/reel/scenes/${saved.scenes[0].id}/image/generate`, { cookie });
    if (res.status !== 200) throw new Error(`no scene picture: ${res.status} ${res.text}`);
  }

  it('renders the saved scenes: one voice request, each scene with its picture and start time', async () => {
    // the post has a picture of its own: scenes without one use it
    const { cookie, post, userId } = await setup();
    const { render } = fakePipeline();
    await scenesWithPicture(cookie, userId, post.id, [{ text: 'Bạn mất bao lâu?', imagePrompt: 'x' }, { text: 'Thử ngay hôm nay!' }, { text: 'Cảm ơn bạn.' }], 'vi-VN-NamMinhNeural');
    // 4 + 4 + 3 words, 300 ms each
    const words = Array.from({ length: 11 }, (_, i) => ({ text: `w${i}`, startMs: i * 300, durationMs: 300 }));
    const voice = vi.spyOn(edgeTts, 'synthesize').mockResolvedValue({ audio: Buffer.from('mp3'), words });

    const state = await make(cookie, post.id, {});
    expect(state).toMatchObject({ state: 'done', reelScript: 'Bạn mất bao lâu? Thử ngay hôm nay! Cảm ơn bạn.' });
    expect(voice).toHaveBeenCalledTimes(1);
    expect(voice).toHaveBeenCalledWith('Bạn mất bao lâu? Thử ngay hôm nay! Cảm ơn bạn.', 'vi-VN-NamMinhNeural');
    const input = render.mock.calls[0][0];
    expect(input.scenes!.map((s) => s.startMs)).toEqual([0, 1200, 2400]);
    expect(input.scenes![0].image!.buffer.equals(SCENE_PNG)).toBe(true);
    expect(input.scenes![1].image!.buffer.equals(PNG)).toBe(true);
    expect(input.scenes![2].image!.buffer.equals(PNG)).toBe(true);
    // subtitles under the picture, with the script's own words
    expect(input.ass).toMatch(/,2,80,80,430,1$/m);
    expect(input.ass).toContain('lâu?');
    // the scenes stay for the next edit
    expect((await draftOf(cookie, post.id)).scenes).toHaveLength(3);
  });

  it('refuses to render scenes that are not ready, with the reason', async () => {
    const { cookie, post } = await setup();
    vi.spyOn(renderModule, 'ffmpegAvailable').mockResolvedValue(true);
    const none = await queue(cookie, post.id, {});
    expect(none.status).toBe(400);
    expect(none.json.error).toBe('Kịch bản chưa có cảnh nào.');
    await api(server.baseUrl, 'PUT', `/api/posts/${post.id}/reel/draft`, { cookie, body: { scenes: [{ text: 'Một hai ba bốn năm' }, { text: '' }] } });
    const silent = await queue(cookie, post.id, {});
    expect(silent.status).toBe(400);
    expect(silent.json.error).toBe('Cảnh 2 chưa có lời đọc.');
    expect(await jobOf(post.id)).toBeNull();
  });

  it('the quick form (a whole script) replaces the scenes with one, and drops their pictures', async () => {
    const { cookie, post, userId } = await setup();
    fakePipeline();
    await scenesWithPicture(cookie, userId, post.id, [{ text: 'Một', imagePrompt: 'x' }, { text: 'Hai' }]);
    expect(await sceneFiles(post.id)).toHaveLength(1);
    expect((await make(cookie, post.id, { script: SCRIPT })).state).toBe('done');
    expect((await draftOf(cookie, post.id)).scenes).toEqual([{ id: expect.any(String), text: SCRIPT, imagePrompt: '', imageUrl: null }]);
    expect(await sceneFiles(post.id)).toEqual([]);
  });
});
