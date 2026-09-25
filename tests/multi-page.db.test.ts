import { describe, it, expect, afterAll, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import '../src/config'; // loads .env (DATABASE_URL)
import prisma from '../src/utils/prisma';
import { enqueuePost, startWorkers } from '../src/services/scheduler.service';

/**
 * End-to-end publish to several Pages on the real MariaDB, with Facebook mocked.
 *   RUN_DB_TESTS=1 npx vitest run tests/multi-page.db.test.ts
 * Stop any dev server on the same DB first: its worker would take these jobs
 * and call the real Facebook API (with fake tokens).
 */
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

describe.skipIf(!process.env.RUN_DB_TESTS)('publish one post to several Pages', { timeout: 40_000 }, () => {
  beforeAll(async () => {
    const user = (await prisma.user.findFirst()) ?? (await prisma.user.create({ data: { email: 'mp@test.local', name: 'MP' } }));
    userId = user.id;
    await prisma.facebookPage.deleteMany({ where: { pageId: { in: PAGE_IDS } } });
    pages = await Promise.all(
      PAGE_IDS.map((pageId, i) =>
        prisma.facebookPage.create({ data: { userId, pageId, pageName: `Trang thử ${i + 1}`, pageAccessToken: `EAAfaketoken${i}xxxxxxxxxxxxxxxxxxxx` } })
      )
    );
    stop = startWorkers();
  });

  // vitest.config unstubs globals after every test, so mock Facebook before each one
  beforeEach(mockFacebook);

  afterEach(() => {
    publishCalls.length = 0;
    failPage = null;
  });

  afterAll(async () => {
    stop?.();
    const posts = await prisma.post.findMany({ where: { targets: { some: { pageId: { in: pages.map((p) => p.id) } } } }, select: { id: true } });
    await prisma.job.deleteMany({ where: { OR: posts.map((p) => ({ payload: { path: '$.postId', equals: p.id } })) } });
    await prisma.facebookPage.deleteMany({ where: { pageId: { in: PAGE_IDS } } }); // cascades posts' targets
    await prisma.post.deleteMany({ where: { id: { in: posts.map((p) => p.id) } } });
    vi.unstubAllGlobals();
    await prisma.$disconnect();
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
    stop = startWorkers();
    await new Promise((r) => setTimeout(r, 3500));

    const jobs = await prisma.job.findMany({ where: { type: 'publish_target', payload: { path: '$.targetId', string_contains: '' } }, orderBy: { runAt: 'asc' } });
    const mine = jobs.filter((j) => post.targets.some((t) => t.id === (j.payload as { targetId: string }).targetId));
    expect(mine).toHaveLength(3);
    const gaps = mine.slice(1).map((j, i) => j.runAt.getTime() - mine[i].runAt.getTime());
    expect(gaps).toEqual([120_000, 120_000]);
    await prisma.job.deleteMany({ where: { id: { in: mine.slice(1).map((j) => j.id) } } });
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
