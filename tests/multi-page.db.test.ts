import { describe, it, expect, afterAll, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import '../src/config'; // loads .env (DATABASE_URL)
import prisma from '../src/utils/prisma';
import { enqueuePost, startWorkers } from '../src/services/scheduler.service';
import type { JobType } from '../src/lib/job-queue';
import { saveSettings } from '../src/lib/settings';
import { saveUploadedVideo, removeVideo, VIDEO_TMP_DIR } from '../src/lib/video-store';
import { tinyMp4 } from './helpers/mp4';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GeminiClient } from '../src/lib/clients/gemini';
import { CloudflareClient } from '../src/lib/clients/cloudflare';

/**
 * End-to-end publish to several Pages on the real MariaDB, with Facebook mocked.
 *   RUN_DB_TESTS=1 npx vitest run tests/multi-page.db.test.ts
 * Stop any dev server on the same DB first: its worker would take these jobs
 * and call the real Facebook API (with fake tokens).
 */
/**
 * Poll fast: the production 3 s poll makes multi-step publishes brush against the 15 s waits under load.
 * Only the publish jobs: other DB test files queue their own jobs (e.g. prepare_post) in the same database.
 */
const TEST_WORKER = { pollMs: 500, only: ['publish_post', 'publish_target'] as JobType[] };
const TOKEN_CHECK_KEY = 'system:check_page_tokens';
let tokenCheck: { runAt: Date; status: string } | null = null;
const PAGE_IDS = ['TEST_MP_1', 'TEST_MP_2', 'TEST_MP_3'];
let userId: string;
let pages: { id: string; pageId: string }[] = [];
let stop: (() => void) | undefined;
let failPage: string | null = null;
const publishCalls: string[] = [];

function mockFacebook() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const [, , pageOrPost, edge] = url.pathname.split('/');
      if (init?.method === 'POST') {
        publishCalls.push(pageOrPost);
        if (pageOrPost === failPage) {
          return new Response(JSON.stringify({ error: { message: 'Session expired', code: 190, error_subcode: 463 } }), { status: 400 });
        }
        return new Response(JSON.stringify({ id: `${pageOrPost}_${publishCalls.length}` }), { status: 200 });
      }
      // GET permalink
      return new Response(JSON.stringify({ permalink_url: `https://facebook.com/${pageOrPost}${edge ? `/${edge}` : ''}` }), { status: 200 });
    })
  );
}

async function createPost(pageCount: number) {
  return prisma.post.create({
    data: {
      userId,
      pageId: pages[0].id,
      caption: 'Bài thử đăng nhiều Page',
      hashtags: ['Test'],
      status: 'GENERATING', // what the publish route sets before queueing
      targets: { create: pages.slice(0, pageCount).map((p) => ({ pageId: p.id })) },
    },
    include: { targets: true },
  });
}

const waitForStatus = async (postId: string, done: string[], ms = 15_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const post = await prisma.post.findUniqueOrThrow({ where: { id: postId } });
    if (done.includes(post.status)) return post;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('timed out');
};

async function attachVideo(postId: string, opts: { durationSec: number; width: number; height: number }, kind: 'FEED' | 'REEL') {
  await mkdir(VIDEO_TMP_DIR, { recursive: true });
  const tmp = path.join(VIDEO_TMP_DIR, `mp-${postId}.upload`);
  await writeFile(tmp, tinyMp4(opts));
  const stored = await saveUploadedVideo(postId, tmp);
  await prisma.post.update({
    where: { id: postId },
    data: {
      videoPath: stored.videoPath,
      videoUrl: stored.videoUrl,
      videoMime: stored.mime,
      videoMeta: { ...stored.meta },
      videoKind: kind,
      imagePrompt: 'never used',
    },
  });
  return stored.videoPath;
}

/** Graph stub for video publishing: records which endpoint each call hit */
function videoFetch(calls: string[]) {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${url.host}${url.pathname}`);
    if (url.pathname.endsWith('/video_reels')) {
      const phase = new URLSearchParams(String(init?.body)).get('upload_phase');
      return new Response(JSON.stringify(phase === 'start' ? { video_id: 'REEL_X' } : { success: true }), { status: 200 });
    }
    if (url.host === 'rupload.facebook.com') return new Response(JSON.stringify({ success: true }), { status: 200 });
    if (url.pathname.endsWith('/videos')) return new Response(JSON.stringify({ id: 'VID_X' }), { status: 200 });
    return new Response(JSON.stringify({ permalink_url: '/page/videos/VID_X/' }), { status: 200 });
  });
}

describe.skipIf(!process.env.RUN_DB_TESTS)('publish one post to several Pages', { timeout: 40_000 }, () => {
  beforeAll(async () => {
    const user = (await prisma.user.findFirst({
      // Never another test file's temporary user: those are deleted while this file runs
      where: { email: { not: { endsWith: '@autopost.test' } } },
      orderBy: { createdAt: 'asc' },
    })) ?? (await prisma.user.create({ data: { email: 'mp@test.local', name: 'MP' } }));
    userId = user.id;
    await prisma.facebookPage.deleteMany({ where: { pageId: { in: PAGE_IDS } } });
    pages = await Promise.all(
      PAGE_IDS.map((pageId, i) =>
        prisma.facebookPage.create({ data: { userId, pageId, pageName: `Trang thử ${i + 1}`, pageAccessToken: `EAAfaketoken${i}xxxxxxxxxxxxxxxxxxxx` } })
      )
    );
    // The daily token check (03:00 VN) is often already due on the first run of the day: it would
    // "check" these Pages against the mocked Graph API, mark them expired and break the publish tests
    tokenCheck = await prisma.job.findUnique({ where: { key: TOKEN_CHECK_KEY }, select: { runAt: true, status: true } });
    if (tokenCheck?.status === 'PENDING') {
      await prisma.job.update({ where: { key: TOKEN_CHECK_KEY }, data: { runAt: new Date(Date.now() + 24 * 60 * 60_000) } });
    }
    stop = startWorkers(TEST_WORKER);
  });

  // vitest.config unstubs globals after every test, so mock Facebook before each one
  beforeEach(mockFacebook);

  afterEach(() => {
    publishCalls.length = 0;
    failPage = null;
  });

  afterAll(async () => {
    stop?.();
    if (tokenCheck?.status === 'PENDING') {
      await prisma.job.updateMany({ where: { key: TOKEN_CHECK_KEY, status: 'PENDING' }, data: { runAt: tokenCheck.runAt } });
    }
    const posts =await prisma.post.findMany({ where: { targets: { some: { pageId: { in: pages.map((p) => p.id) } } } }, select: { id: true } });
    await prisma.job.deleteMany({ where: { OR: posts.map((p) => ({ payload: { path: '$.postId', equals: p.id } })) } });
    await prisma.facebookPage.deleteMany({ where: { pageId: { in: PAGE_IDS } } }); // cascades posts' targets
    await prisma.post.deleteMany({ where: { id: { in: posts.map((p) => p.id) } } });
    vi.unstubAllGlobals();
    await prisma.$disconnect();
  });

  it('leaves the job types it was not started for to other workers', async () => {
    const job = await prisma.job.create({ data: { type: 'prepare_post', payload: { postId: 'not-for-this-worker' }, runAt: new Date() } });
    try {
      await new Promise((r) => setTimeout(r, 1500)); // three polls
      expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('PENDING');
    } finally {
      await prisma.job.delete({ where: { id: job.id } });
    }
  });

  it('records success and failure per Page, then retries only the failed Page', async () => {
    failPage = 'TEST_MP_2';
    const post = await createPost(3);
    await enqueuePost(post.id, userId, { skipAi: true, targetIds: post.targets.map((t) => t.id), intervalMs: 0 });

    const failed = await waitForStatus(post.id, ['PUBLISHED', 'FAILED']);
    expect(failed.status).toBe('FAILED');
    expect(failed.errorMessage).toMatch(/Lỗi trên 1\/3 Page \(Trang thử 2\)/);
    expect(failed.message).toBe('Bài thử đăng nhiều Page\n\n#Test');

    const targets = await prisma.postTarget.findMany({ where: { postId: post.id }, include: { page: true } });
    const byPage = Object.fromEntries(targets.map((t) => [t.page.pageId, t]));
    expect(byPage.TEST_MP_1).toMatchObject({ status: 'PUBLISHED' });
    expect(byPage.TEST_MP_1.fbPermalink).toMatch(/^https:\/\/facebook\.com\/TEST_MP_1_/);
    expect(byPage.TEST_MP_3.status).toBe('PUBLISHED');
    expect(byPage.TEST_MP_2).toMatchObject({ status: 'FAILED', fbPostId: null });
    expect(byPage.TEST_MP_2.errorMessage).toMatch(/hết hạn/);
    expect(publishCalls.sort()).toEqual(['TEST_MP_1', 'TEST_MP_2', 'TEST_MP_3']); // token error: no retry

    // Retry the failed Page only
    failPage = null;
    publishCalls.length = 0;
    await prisma.post.update({ where: { id: post.id }, data: { status: 'GENERATING' } });
    await enqueuePost(post.id, userId, { skipAi: true, targetIds: [byPage.TEST_MP_2.id], intervalMs: 0 });

    const done = await waitForStatus(post.id, ['PUBLISHED', 'FAILED']);
    expect(done.status).toBe('PUBLISHED');
    expect(done.errorMessage).toBeNull();
    expect(publishCalls).toEqual(['TEST_MP_2']);
  });

  it('staggers Pages by the chosen interval', async () => {
    const post = await createPost(3);
    // Never let these run: we only inspect the booked times
    stop?.();
    await enqueuePost(post.id, userId, { skipAi: true, targetIds: post.targets.map((t) => t.id), intervalMs: 120_000 });
    stop = startWorkers(TEST_WORKER);
    await new Promise((r) => setTimeout(r, 3500));

    const jobs = await prisma.job.findMany({ where: { type: 'publish_target', payload: { path: '$.targetId', string_contains: '' } }, orderBy: { runAt: 'asc' } });
    const mine = jobs.filter((j) => post.targets.some((t) => t.id === (j.payload as { targetId: string }).targetId));
    expect(mine).toHaveLength(3);
    const gaps = mine.slice(1).map((j, i) => j.runAt.getTime() - mine[i].runAt.getTime());
    expect(gaps).toEqual([120_000, 120_000]);
    await prisma.job.deleteMany({ where: { id: { in: mine.slice(1).map((j) => j.id) } } });
  });

  it('the worker refuses a Page whose token belongs to another app (e.g. App ID changed after scheduling)', async () => {
    const post = await createPost(2);
    // Page 2 is now on an old app's token
    await prisma.facebookPage.update({ where: { id: pages[1].id }, data: { tokenStatus: 'OTHER_APP', tokenAppId: 'OLD_APP_ID' } });
    try {
      await enqueuePost(post.id, userId, { skipAi: true, targetIds: post.targets.map((t) => t.id), intervalMs: 0 });
      const done = await waitForStatus(post.id, ['PUBLISHED', 'FAILED']);
      expect(done.status).toBe('FAILED');
      const blocked = await prisma.postTarget.findFirstOrThrow({ where: { postId: post.id, pageId: pages[1].id } });
      expect(blocked).toMatchObject({ status: 'FAILED', fbPostId: null });
      expect(blocked.errorMessage).toMatch(/Không đăng được lên Page này: Token do Facebook App khác cấp \(OLD_APP_ID\)/);
      expect(publishCalls).toEqual(['TEST_MP_1']); // nothing sent through the old app
    } finally {
      await prisma.facebookPage.update({ where: { id: pages[1].id }, data: { tokenStatus: 'UNCHECKED', tokenAppId: null } });
    }
  });

  it('does not publish for a disabled account', async () => {
    const disabled = await prisma.user.create({ data: { email: `disabled-${Date.now()}@autopost.test`, name: 'Disabled', isActive: false } });
    const page = await prisma.facebookPage.create({
      data: { userId: disabled.id, pageId: 'TEST_MP_DISABLED', pageName: 'Trang khoá', pageAccessToken: 'EAAfaketokendisabledxxxxxxxxxxxxxx' },
    });
    const post = await prisma.post.create({
      data: { userId: disabled.id, pageId: page.id, caption: 'Không được đăng', status: 'GENERATING', targets: { create: [{ pageId: page.id }] } },
      include: { targets: true },
    });
    try {
      await enqueuePost(post.id, disabled.id, { skipAi: true, targetIds: post.targets.map((t) => t.id), intervalMs: 0 });
      const done = await waitForStatus(post.id, ['PUBLISHED', 'FAILED']);
      expect(done.status).toBe('FAILED');
      expect(done.errorMessage).toMatch(/Tài khoản đã bị khoá/);
      expect(publishCalls).not.toContain('TEST_MP_DISABLED');
      // Each Page shows why it was not published (not left waiting)
      const targets = await prisma.postTarget.findMany({ where: { postId: post.id } });
      expect(targets.map((t) => t.status)).toEqual(['FAILED']);
    } finally {
      await prisma.user.delete({ where: { id: disabled.id } });
    }
  });

  it("never publishes to a Page owned by another account, even if a target points at it", async () => {
    const other = await prisma.user.create({ data: { email: `other-${Date.now()}@autopost.test`, name: 'Other' } });
    const foreignPage = await prisma.facebookPage.create({
      data: { userId: other.id, pageId: 'TEST_MP_FOREIGN', pageName: 'Page người khác', pageAccessToken: 'EAAfaketokenforeignxxxxxxxxxxxxxxx' },
    });
    const post = await prisma.post.create({
      data: { userId, pageId: pages[0].id, caption: 'Không được đăng', status: 'GENERATING', targets: { create: [{ pageId: foreignPage.id }] } },
      include: { targets: true },
    });
    try {
      await enqueuePost(post.id, userId, { skipAi: true, targetIds: post.targets.map((t) => t.id), intervalMs: 0 });
      const done = await waitForStatus(post.id, ['PUBLISHED', 'FAILED']);
      expect(done.status).toBe('FAILED');
      expect(publishCalls).not.toContain('TEST_MP_FOREIGN');
    } finally {
      await prisma.post.delete({ where: { id: post.id } });
      await prisma.user.delete({ where: { id: other.id } });
    }
  });

  it('a text-only format publishes without generating an image', async () => {
    // Own account with a (fake) Gemini key: members never borrow the server .env key
    const owner = await prisma.user.create({ data: { email: `textonly-${Date.now()}@autopost.test`, name: 'Text only' } });
    await saveSettings(owner.id, { geminiApiKey: 'AIzaFakeKeyTextOnlyTest0000000000000' });
    const page = await prisma.facebookPage.create({
      data: { userId: owner.id, pageId: 'TEST_MP_TEXT', pageName: 'Trang chữ', pageAccessToken: 'EAAfaketokentextonlyxxxxxxxxxxxxxx' },
    });
    const domain = await prisma.contentDomain.create({
      data: { userId: owner.id, name: 'Chỉ chữ', formats: { create: { name: 'Status', instructions: 'Một câu.', withImage: false, isDefault: true } } },
      include: { formats: true },
    });
    vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ post: 'Chỉ có chữ' } as never);
    const cf = vi.spyOn(CloudflareClient.prototype, 'generateImage');
    const post = await prisma.post.create({
      data: {
        userId: owner.id,
        pageId: page.id,
        domainId: domain.id,
        formatId: domain.formats[0].id,
        inputData: { basicInfo: 'Một ý' },
        status: 'GENERATING',
        targets: { create: [{ pageId: page.id }] },
      },
      include: { targets: true },
    });
    try {
      await enqueuePost(post.id, owner.id, { targetIds: post.targets.map((t) => t.id), intervalMs: 0 });
      const done = await waitForStatus(post.id, ['PUBLISHED', 'FAILED']);
      expect(done).toMatchObject({ status: 'PUBLISHED', caption: 'Chỉ có chữ', imagePath: null, formatId: domain.formats[0].id });
      expect(done.aiPrompt).toMatch('Định dạng bài "Status"');
      expect(publishCalls).toContain('TEST_MP_TEXT');
      expect(cf).not.toHaveBeenCalled();
    } finally {
      await prisma.user.delete({ where: { id: owner.id } });
    }
  });

  it('publishes an uploaded video as a normal Page video, without generating an image', async () => {
    const post = await createPost(1);
    const videoPath = await attachVideo(post.id, { durationSec: 12, width: 1280, height: 720 }, 'FEED');
    const calls: string[] = [];
    vi.stubGlobal('fetch', videoFetch(calls));
    try {
      await enqueuePost(post.id, userId, { skipAi: true, targetIds: post.targets.map((t) => t.id), intervalMs: 0 });
      const done = await waitForStatus(post.id, ['PUBLISHED', 'FAILED']);
      expect(done.status).toBe('PUBLISHED');
      expect(done.imagePath).toBeNull();
      // The Graph version comes from the account's Settings
      expect(calls.some((c) => /^graph-video\.facebook\.com\/v[\d.]+\/TEST_MP_1\/videos$/.test(c))).toBe(true);
      const target = await prisma.postTarget.findFirstOrThrow({ where: { postId: post.id } });
      expect(target).toMatchObject({ fbPostId: 'VID_X', fbPermalink: 'https://www.facebook.com/page/videos/VID_X/' });
    } finally {
      await removeVideo(videoPath);
    }
  });

  it('publishes a vertical video as a Reel (start → upload → finish)', async () => {
    const post = await createPost(1);
    const videoPath = await attachVideo(post.id, { durationSec: 20, width: 1080, height: 1920 }, 'REEL');
    const calls: string[] = [];
    vi.stubGlobal('fetch', videoFetch(calls));
    try {
      await enqueuePost(post.id, userId, { skipAi: true, targetIds: post.targets.map((t) => t.id), intervalMs: 0 });
      expect((await waitForStatus(post.id, ['PUBLISHED', 'FAILED'])).status).toBe('PUBLISHED');
      expect(calls.filter((c) => c.endsWith('/video_reels'))).toHaveLength(2);
      expect(calls.some((c) => /^rupload\.facebook\.com\/video-upload\/v[\d.]+\/REEL_X$/.test(c))).toBe(true);
      const target = await prisma.postTarget.findFirstOrThrow({ where: { postId: post.id } });
      expect(target.fbPostId).toBe('REEL_X');
      expect(target.fbPermalink).toMatch(/facebook\.com/);
    } finally {
      await removeVideo(videoPath);
    }
  });

  it('refuses to publish a Reel that does not meet the Reels requirements', async () => {
    const post = await createPost(1);
    const videoPath = await attachVideo(post.id, { durationSec: 20, width: 1920, height: 1080 }, 'REEL');
    const calls: string[] = [];
    vi.stubGlobal('fetch', videoFetch(calls));
    try {
      await enqueuePost(post.id, userId, { skipAi: true, targetIds: post.targets.map((t) => t.id), intervalMs: 0 });
      const done = await waitForStatus(post.id, ['PUBLISHED', 'FAILED']);
      expect(done.status).toBe('FAILED');
      expect(done.errorMessage).toMatch(/video dọc/);
      expect(calls.filter((c) => c.includes('video'))).toEqual([]);
    } finally {
      await removeVideo(videoPath);
    }
  });

  it('a double click never publishes the same Page twice', async () => {
    const post = await createPost(2);
    const targetIds = post.targets.map((t) => t.id);
    await Promise.all([
      enqueuePost(post.id, userId, { skipAi: true, targetIds, intervalMs: 0 }),
      enqueuePost(post.id, userId, { skipAi: true, targetIds, intervalMs: 0 }),
    ]);
    await waitForStatus(post.id, ['PUBLISHED', 'FAILED']);
    await new Promise((r) => setTimeout(r, 4000)); // let the duplicate jobs run too
    expect(publishCalls.sort()).toEqual(['TEST_MP_1', 'TEST_MP_2']);
  });
});
