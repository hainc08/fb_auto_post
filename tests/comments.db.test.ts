import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
function stubGraph(handler: (input: string, init?: RequestInit) => Promise<Response> = async () => new Response('{}')) {
  const graph = vi.fn(handler);
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) =>
    String(input).includes('facebook.com') ? graph(String(input), init) : realFetch(input, init)
  );
  return graph;
}

const ALL = ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list', 'pages_read_user_content', 'pages_manage_engagement'];

async function setup(scopes = ALL) {
  const { user, cookie } = await createTestUser();
  await saveSettings(user.id, { fbAppId: '111', fbAppSecret: 'fake-secret-comments' });
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const page = await prisma.facebookPage.create({
    data: { userId: user.id, pageId: `CM_${tag}`, pageName: 'Nhà nông', pageAccessToken: encrypt('EAAtokencommentsxxxxxxxxxxxxxxxxxxx'), tokenStatus: 'VALID', grantedScopes: scopes },
  });
  const post = await prisma.post.create({
    data: {
      userId: user.id,
      pageId: page.id,
      caption: 'x',
      status: 'PUBLISHED',
      targets: {
        create: {
          pageId: page.id,
          status: 'PUBLISHED',
          fbPostId: `CM_POST_${tag}`,
          publishedAt: new Date(),
          reactionCount: 3,
          commentCount: 1,
          shareCount: 0,
          unansweredCount: 1,
          statsSyncedAt: new Date(Date.now() - 3600_000),
        },
      },
    },
    include: { targets: true },
  });
  const comment = await prisma.postComment.create({
    data: { targetId: post.targets[0].id, fbCommentId: `C_${tag}`, authorName: 'An', message: 'Có workflow mẫu không?', commentedAt: new Date() },
  });
  return { cookie, post, comment, target: post.targets[0] };
}

describe.skipIf(!process.env.RUN_DB_TESTS)('comments API', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('lists counts in the posts list and the threads of one post', async () => {
    const { cookie, post } = await setup();
    const list = await api(server.baseUrl, 'GET', '/api/posts', { cookie });
    expect(list.json.data[0].targets[0]).toMatchObject({ reactionCount: 3, commentCount: 1, unansweredCount: 1 });
    const res = await api(server.baseUrl, 'GET', `/api/posts/${post.id}/comments`, { cookie });
    expect(res.status).toBe(200);
    expect(res.json.data.pages[0]).toMatchObject({ canRead: true, canReply: true, unansweredCount: 1 });
    expect(res.json.data.pages[0].threads[0]).toMatchObject({ message: 'Có workflow mẫu không?', needsReply: true, replies: [] });
  });

  it('replies as the Page: sent once to Facebook, stored, and no longer needs a reply', async () => {
    const { cookie, post, comment } = await setup();
    const fetch = stubGraph(async () => new Response(JSON.stringify({ id: `REPLY_${comment.id}` }), { status: 200 }));
    const res = await api(server.baseUrl, 'POST', `/api/posts/${post.id}/comments/${comment.id}/reply`, { cookie, body: { message: 'Có nhé, workflow cơ bản là…' } });
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain(`/${comment.fbCommentId}/comments`);
    const thread = res.json.data.pages[0].threads[0];
    expect(thread).toMatchObject({ needsReply: false });
    expect(thread.replies[0]).toMatchObject({ fromPage: true, message: 'Có nhé, workflow cơ bản là…' });
    expect(res.json.data.pages[0].unansweredCount).toBe(0);
  });

  it('a reply the hourly sync already stored is not an error (no resend of a public reply)', async () => {
    const { cookie, post, comment, target } = await setup();
    const replyId = `RACE_${comment.id}`;
    // The sync fetched the new reply between Facebook accepting it and the app saving it
    await prisma.postComment.create({ data: { targetId: target.id, fbCommentId: replyId, parentFbId: comment.fbCommentId, message: 'Có nhé', commentedAt: new Date(), fromPage: true } });
    stubGraph(async () => new Response(JSON.stringify({ id: replyId }), { status: 200 }));
    const res = await api(server.baseUrl, 'POST', `/api/posts/${post.id}/comments/${comment.id}/reply`, { cookie, body: { message: 'Có nhé' } });
    expect(res.status).toBe(200);
    expect(res.json.data.pages[0].threads[0]).toMatchObject({ needsReply: false });
  });

  it('when the answer from Facebook is lost, the user is told to check before resending', async () => {
    const { cookie, post, comment } = await setup();
    stubGraph(async () => {
      throw new TypeError('fetch failed');
    });
    const res = await api(server.baseUrl, 'POST', `/api/posts/${post.id}/comments/${comment.id}/reply`, { cookie, body: { message: 'x' } });
    expect(res.status).toBe(502);
    expect(res.json.error).toMatch(/kiểm tra trên Facebook/);
  });

  it('without the reply permission: 409 in Vietnamese, nothing sent', async () => {
    const { cookie, post, comment } = await setup(ALL.filter((s) => s !== 'pages_manage_engagement'));
    const fetch = stubGraph();
    const res = await api(server.baseUrl, 'POST', `/api/posts/${post.id}/comments/${comment.id}/reply`, { cookie, body: { message: 'x' } });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/Đồng bộ/);
    expect(fetch).not.toHaveBeenCalled();
    const view = await api(server.baseUrl, 'GET', `/api/posts/${post.id}/comments`, { cookie });
    expect(view.json.data.pages[0].canReply).toBe(false);
  });

  it('"Đã xử lý" clears the badge and can be undone', async () => {
    const { cookie, post, comment } = await setup();
    let res = await api(server.baseUrl, 'PATCH', `/api/posts/${post.id}/comments/${comment.id}`, { cookie, body: { handled: true } });
    expect(res.json.data.pages[0]).toMatchObject({ unansweredCount: 0 });
    res = await api(server.baseUrl, 'PATCH', `/api/posts/${post.id}/comments/${comment.id}`, { cookie, body: { handled: false } });
    expect(res.json.data.pages[0]).toMatchObject({ unansweredCount: 1 });
  });

  it('refresh syncs now, then asks to wait', async () => {
    const { cookie, post, target } = await setup();
    stubGraph(async (input: string) =>
      new URL(input).searchParams.get('ids')
        ? new Response(JSON.stringify({ [target.fbPostId!]: { id: target.fbPostId, reactions: { summary: { total_count: 9 } }, comments: { summary: { total_count: 0 } } } }), { status: 200 })
        : new Response(JSON.stringify({ data: [] }), { status: 200 })
    );
    const first = await api(server.baseUrl, 'POST', `/api/posts/${post.id}/comments/refresh`, { cookie });
    expect(first.status).toBe(200);
    expect(first.json.data.pages[0]).toMatchObject({ reactionCount: 9, commentCount: 0 });
    const again = await api(server.baseUrl, 'POST', `/api/posts/${post.id}/comments/refresh`, { cookie });
    expect(again.status).toBe(429);
  });

  it("a comment of another user's post is 404, even through my own post id", async () => {
    const mine = await setup();
    const other = await setup();
    const fetch = stubGraph();
    const res = await api(server.baseUrl, 'POST', `/api/posts/${mine.post.id}/comments/${other.comment.id}/reply`, { cookie: mine.cookie, body: { message: 'x' } });
    expect(res.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});
