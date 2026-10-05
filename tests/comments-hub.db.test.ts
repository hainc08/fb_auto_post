import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FacebookPage, PostTarget } from '@prisma/client';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { encrypt } from '../src/lib/crypto';
import { saveSettings } from '../src/lib/settings';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;
/** The API calls go through fetch too: only Facebook URLs reach the stub */
const realFetch = globalThis.fetch;
function stubGraph(handler: (input: string) => Promise<Response>) {
  const graph = vi.fn(handler);
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => (String(input).includes('facebook.com') ? graph(String(input)) : realFetch(input, init)));
  return graph;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const ALL = ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list', 'pages_read_user_content', 'pages_manage_engagement'];
const DAY = 86_400_000;

async function setup() {
  const { user, cookie } = await createTestUser();
  await saveSettings(user.id, { fbAppId: '111', fbAppSecret: 'fake-secret-comments-hub' });
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  let n = 0;
  const mkPage = (name: string, extra: Record<string, unknown> = {}) =>
    prisma.facebookPage.create({
      data: { userId: user.id, pageId: `HUB_${tag}_${++n}`, pageName: name, pageAccessToken: encrypt('EAAtokencommentshubxxxxxxxxxxxxxxxx'), tokenStatus: 'VALID', grantedScopes: ALL, ...extra },
    });
  /** A post on one Page; `synced: null` = never synced */
  const publish = async (page: FacebookPage, opts: { caption?: string; daysAgo?: number; comments?: number; unanswered?: number; failed?: boolean; synced?: Date | null } = {}) => {
    n++;
    const post = await prisma.post.create({
      data: {
        userId: user.id,
        pageId: page.id,
        caption: opts.caption ?? `Bài ${n}`,
        status: opts.failed ? 'FAILED' : 'PUBLISHED',
        targets: {
          create: {
            pageId: page.id,
            status: opts.failed ? 'FAILED' : 'PUBLISHED',
            fbPostId: opts.failed ? null : `HUB_POST_${tag}_${n}`,
            publishedAt: opts.failed ? null : new Date(Date.now() - (opts.daysAgo ?? 1) * DAY),
            reactionCount: 5,
            commentCount: opts.comments ?? 0,
            shareCount: 1,
            unansweredCount: opts.unanswered ?? 0,
            statsSyncedAt: opts.synced === undefined ? new Date(Date.now() - 3600_000) : opts.synced,
          },
        },
      },
      include: { targets: true },
    });
    return { post, target: post.targets[0] };
  };
  const comment = (target: PostTarget, extra: Record<string, unknown> = {}) =>
    prisma.postComment.create({ data: { targetId: target.id, fbCommentId: `HUB_C_${tag}_${++n}`, authorName: 'An', message: 'Giá bao nhiêu?', commentedAt: new Date(), ...extra } });
  return { user, cookie, mkPage, publish, comment };
}

describe.skipIf(!process.env.RUN_DB_TESTS)('comments hub API', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('overview: the totals of each active Page, by name', async () => {
    const s = await setup();
    const a = await s.mkPage('A nhà nông', { autoReply: true });
    const b = await s.mkPage('B văn phòng', { grantedScopes: ALL.filter((x) => x !== 'pages_manage_engagement'), tokenStatus: 'OTHER_APP' });
    const off = await s.mkPage('C đã ngắt', { isActive: false });
    const busy = await s.publish(a, { comments: 3, unanswered: 2 });
    await s.publish(a, { comments: 0 });
    await s.publish(a, { failed: true });
    await s.publish(b, { comments: 1, unanswered: 1 });
    await s.publish(off, { comments: 4, unanswered: 4 });
    await s.comment(busy.target, { draftReply: 'Dạ mời anh nhắn tin ạ.', draftCheckedAt: new Date() });
    // a draft on a comment that no longer waits is not counted
    await s.comment(busy.target, { draftReply: 'đã trả lời rồi', draftCheckedAt: new Date(), pageReplied: true });

    const res = await api(server.baseUrl, 'GET', '/api/comments/overview', { cookie: s.cookie });
    expect(res.status).toBe(200);
    const pages = res.json.data.pages;
    expect(pages.map((p: { pageName: string }) => p.pageName)).toEqual(['A nhà nông', 'B văn phòng']);
    expect(pages[0]).toMatchObject({ id: a.id, canRead: true, canReply: true, autoReply: true, tokenValid: true, posts: 2, postsWithComments: 1, comments: 3, unanswered: 2, drafts: 1 });
    expect(new Date(pages[0].syncedAt).getTime()).toBeGreaterThan(Date.now() - 2 * 3600_000);
    expect(pages[1]).toMatchObject({ id: b.id, canRead: true, canReply: false, autoReply: false, tokenValid: false, posts: 1, postsWithComments: 1, comments: 1, unanswered: 1, drafts: 0 });
    // never the token
    expect(res.text).not.toContain('pageAccessToken');

    const other = await createTestUser();
    expect((await api(server.baseUrl, 'GET', '/api/comments/overview', { cookie: other.cookie })).json.data.pages).toEqual([]);
  });

  it('posts: the published posts of one Page, the ones with comments waiting first, then the newest', async () => {
    const s = await setup();
    const a = await s.mkPage('A');
    const b = await s.mkPage('B');
    const quiet = await s.publish(a, { caption: 'Cũ, không còn ai chờ', daysAgo: 5, comments: 2 });
    const busy = await s.publish(a, { caption: 'Nhiều câu hỏi', daysAgo: 3, comments: 4, unanswered: 3 });
    const fresh = await s.publish(a, { caption: `Mới đăng ${'x'.repeat(400)}`, daysAgo: 1, comments: 1, unanswered: 1 });
    await s.publish(a, { failed: true });
    await s.publish(b, { caption: 'Bài của Page khác', comments: 9, unanswered: 9 });
    await s.comment(busy.target, { draftReply: 'Dạ 1', draftCheckedAt: new Date() });
    await s.comment(busy.target, { draftReply: 'Dạ 2', draftCheckedAt: new Date() });
    await s.comment(busy.target, { draftReply: 'đã xử lý', draftCheckedAt: new Date(), handledAt: new Date() });

    const list = (query: string, cookie = s.cookie) => api(server.baseUrl, 'GET', `/api/comments/posts?${query}`, { cookie });
    const res = await list(`pageId=${a.id}`);
    expect(res.status).toBe(200);
    const rows = res.json.data;
    expect(rows.map((r: { postId: string }) => r.postId)).toEqual([busy.post.id, fresh.post.id, quiet.post.id]);
    expect(rows[0]).toMatchObject({ targetId: busy.target.id, caption: 'Nhiều câu hỏi', hasVideo: false, reactionCount: 5, commentCount: 4, shareCount: 1, unansweredCount: 3, draftCount: 2, commentsError: null });
    expect(rows[1].caption).toHaveLength(300);
    expect(rows[2].draftCount).toBe(0);

    expect((await list(`pageId=${a.id}&filter=pending`)).json.data.map((r: { postId: string }) => r.postId)).toEqual([busy.post.id, fresh.post.id]);

    // which Page is always named, and it must be the caller's
    expect((await list('')).status).toBe(400);
    expect((await list(`pageId=${a.id}&filter=nope`)).status).toBe(400);
    expect((await list('pageId=00000000-0000-4000-8000-000000000000')).status).toBe(404);
    const other = await createTestUser();
    expect((await list(`pageId=${a.id}`, other.cookie)).status).toBe(404);
  });

  it('refresh: syncs the recent posts of that Page only, and not the ones synced a moment ago', async () => {
    const s = await setup();
    const a = await s.mkPage('A');
    const b = await s.mkPage('B');
    const due = await s.publish(a, { synced: null });
    const recent = await s.publish(a, { synced: new Date() });
    const ancient = await s.publish(a, { daysAgo: 40, synced: null });
    const elsewhere = await s.publish(b, { synced: null });
    const asked: string[] = [];
    stubGraph(async (input) => {
      const ids = new URL(input).searchParams.get('ids');
      if (!ids) return json({ data: [] });
      asked.push(...ids.split(','));
      return json(Object.fromEntries(ids.split(',').map((id) => [id, { id, reactions: { summary: { total_count: 9 } }, comments: { summary: { total_count: 0 } } }])));
    });
    const refresh = (pageId: string, cookie = s.cookie) => api(server.baseUrl, 'POST', '/api/comments/refresh', { cookie, body: { pageId } });

    const res = await refresh(a.id);
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ synced: 1 });
    expect(asked).toEqual([due.target.fbPostId]);
    expect(await prisma.postTarget.findUniqueOrThrow({ where: { id: due.target.id } })).toMatchObject({ reactionCount: 9, statsSyncedAt: expect.any(Date) });
    for (const untouched of [ancient, elsewhere]) expect((await prisma.postTarget.findUniqueOrThrow({ where: { id: untouched.target.id } })).statsSyncedAt).toBeNull();
    expect((await prisma.postTarget.findUniqueOrThrow({ where: { id: recent.target.id } })).reactionCount).toBe(5);

    // at once again: everything was synced a moment ago
    const again = await refresh(a.id);
    expect(again.status).toBe(429);
    expect(asked).toHaveLength(1);

    const other = await createTestUser();
    expect((await refresh(a.id, other.cookie)).status).toBe(404);
    expect((await api(server.baseUrl, 'POST', '/api/comments/refresh', { cookie: s.cookie, body: {} })).status).toBe(400);
  });

  it('refresh refuses a Page whose token is not valid, and a Page with nothing recent, with the reason', async () => {
    const s = await setup();
    const graph = stubGraph(async () => json({}));
    const stale = await s.mkPage('Token app khác', { tokenStatus: 'OTHER_APP' });
    await s.publish(stale, { synced: null });
    const refused = await api(server.baseUrl, 'POST', '/api/comments/refresh', { cookie: s.cookie, body: { pageId: stale.id } });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/Đồng bộ Page/);

    const empty = await s.mkPage('Chưa đăng gì');
    await s.publish(empty, { daysAgo: 45, synced: null });
    const nothing = await api(server.baseUrl, 'POST', '/api/comments/refresh', { cookie: s.cookie, body: { pageId: empty.id } });
    expect(nothing.status).toBe(400);
    expect(nothing.json.error).toMatch(/30 ngày/);
    expect(graph).not.toHaveBeenCalled();
  });


  it('refresh says so when Facebook did not answer for the Page, instead of reporting success', async () => {
    const s = await setup();
    const a = await s.mkPage('A');
    const due = await s.publish(a, { synced: null });
    // the token expired since the last daily check: the Page still reads VALID, Graph refuses
    stubGraph(async () => json({ error: { message: 'Error validating access token: Session has expired', code: 190, error_subcode: 463 } }, 400));
    const res = await api(server.baseUrl, 'POST', '/api/comments/refresh', { cookie: s.cookie, body: { pageId: a.id } });
    expect(res.status).toBe(502);
    expect(res.json.error).toMatch(/Facebook chưa trả lời/);
    expect(res.json.error).toMatch(/Đồng bộ Page/);
    expect((await prisma.postTarget.findUniqueOrThrow({ where: { id: due.target.id } })).statsSyncedAt).toBeNull();
  });
});
