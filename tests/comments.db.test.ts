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

  it('the Page switch "AI soạn trả lời" needs both comment permissions and a Gemini key', async () => {
    const { cookie, post } = await setup();
    const pageId = post.pageId;
    const patch = (body: Record<string, unknown>, c = cookie, id = pageId) => api(server.baseUrl, 'PATCH', `/api/pages/${id}`, { cookie: c, body });
    // no Gemini key yet
    const noKey = await patch({ autoReply: true });
    expect(noKey.status).toBe(409);
    expect(noKey.json.error).toMatch(/Gemini/);
    await saveSettings(post.userId, { geminiApiKey: 'AIzaFakeKeyCommentsSwitch00000000000000' });
    const on = await patch({ autoReply: true });
    expect(on.status).toBe(200);
    expect(on.json.data).toMatchObject({ id: pageId, autoReply: true });
    const listed = (await api(server.baseUrl, 'GET', '/api/pages', { cookie })).json.data.find((p: { id: string }) => p.id === pageId);
    expect(listed.autoReply).toBe(true);
    // the default-domain form of the same route still works and leaves the switch alone
    expect((await patch({ defaultDomainId: null })).json.data).toMatchObject({ defaultDomainId: null, autoReply: true });
    expect((await patch({ autoReply: false })).json.data.autoReply).toBe(false);

    // a Page that may read comments but not answer them
    const readOnly = await setup(ALL.filter((s) => s !== 'pages_manage_engagement'));
    await saveSettings(readOnly.post.userId, { geminiApiKey: 'AIzaFakeKeyCommentsSwitch00000000000000' });
    const refused = await patch({ autoReply: true }, readOnly.cookie, readOnly.post.pageId);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/quyền/);
    // turning it off is always allowed
    expect((await patch({ autoReply: false }, readOnly.cookie, readOnly.post.pageId)).status).toBe(200);
  });

  /** Give the post's comment a draft, and add more drafted comments */
  async function drafted(target: { id: string }, commentId: string, more = 0) {
    await prisma.postComment.update({ where: { id: commentId }, data: { draftReply: 'Dạ mời anh nhắn tin cho Page ạ.', draftCheckedAt: new Date() } });
    const extra = [];
    for (let i = 0; i < more; i++) {
      extra.push(
        await prisma.postComment.create({
          data: { targetId: target.id, fbCommentId: `D_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, authorName: `Khách ${i}`, message: `Hỏi ${i}`, commentedAt: new Date(Date.now() + (i + 1) * 1000), draftReply: `Trả lời ${i}`, draftCheckedAt: new Date() },
        })
      );
    }
    return extra;
  }
  const comments = (cookie: string, postId: string) => api(server.baseUrl, 'GET', `/api/posts/${postId}/comments`, { cookie });
  const replyOk = (id: string) => new Response(JSON.stringify({ id }));

  it('shows the AI draft of a comment that waits; sending a reply or discarding removes it', async () => {
    const { cookie, post, comment, target } = await setup();
    await prisma.facebookPage.update({ where: { id: post.pageId }, data: { autoReply: true } });
    await drafted(target, comment.id);
    const view = (await comments(cookie, post.id)).json.data;
    expect(view.autoReplyOff).toBe(false);
    expect(view.pages[0].autoReply).toBe(true);
    expect(view.pages[0].threads[0]).toMatchObject({ needsReply: true, draftReply: 'Dạ mời anh nhắn tin cho Page ạ.' });

    const discarded = await api(server.baseUrl, 'DELETE', `/api/posts/${post.id}/comments/${comment.id}/draft`, { cookie });
    expect(discarded.status).toBe(200);
    expect(discarded.json.data.pages[0].threads[0]).toMatchObject({ needsReply: true, draftReply: null });
    // discarded, not forgotten: the AI is not asked about this comment again
    expect((await prisma.postComment.findUniqueOrThrow({ where: { id: comment.id } })).draftCheckedAt).not.toBeNull();

    await drafted(target, comment.id);
    stubGraph(async () => replyOk('REPLY_MANUAL'));
    const sent = await api(server.baseUrl, 'POST', `/api/posts/${post.id}/comments/${comment.id}/reply`, { cookie, body: { message: 'Câu tôi tự sửa.' } });
    expect(sent.status).toBe(200);
    expect((await prisma.postComment.findUniqueOrThrow({ where: { id: comment.id } })).draftReply).toBeNull();
  });

  /** "Gửi N gợi ý": the panel sends the drafts it shows (default: every draft stored for the post, shown or not) */
  async function sendAll(cookie: string, postId: string, drafts?: Array<{ commentId: string; reply: string }>) {
    const stored = await prisma.postComment.findMany({ where: { target: { postId }, draftReply: { not: null } }, orderBy: { commentedAt: 'asc' } });
    return api(server.baseUrl, 'POST', `/api/posts/${postId}/comments/send-drafts`, { cookie, body: { drafts: drafts ?? stored.map((c) => ({ commentId: c.id, reply: c.draftReply! })) } });
  }

  it('send-drafts posts every waiting draft as the Page; a second call sends nothing', async () => {
    const { cookie, post, comment, target } = await setup();
    await drafted(target, comment.id, 2);
    let n = 0;
    const graph = stubGraph(async () => replyOk(`REPLY_ALL_${Date.now()}_${n++}`));
    // what the panel shows, sent twice (a double click)
    const shown = (await prisma.postComment.findMany({ where: { targetId: target.id, draftReply: { not: null } } })).map((c) => ({ commentId: c.id, reply: c.draftReply! }));
    const res = await sendAll(cookie, post.id, shown);
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ sent: 3, failed: null });
    expect(graph).toHaveBeenCalledTimes(3);
    // oldest comment first, each with its own draft
    const bodies = graph.mock.calls.map(([, init]) => new URLSearchParams(String(init?.body)).get('message'));
    expect(bodies).toEqual(['Dạ mời anh nhắn tin cho Page ạ.', 'Trả lời 0', 'Trả lời 1']);
    expect(res.json.data.pages[0].unansweredCount).toBe(0);
    expect(res.json.data.pages[0].threads.every((t: { needsReply: boolean; draftReply: string | null; replies: unknown[] }) => !t.needsReply && t.draftReply === null && t.replies.length === 1)).toBe(true);

    const again = await sendAll(cookie, post.id, shown);
    expect(again.json.data).toMatchObject({ sent: 0, failed: null });
    expect(graph).toHaveBeenCalledTimes(3);
  });

  it('send-drafts skips comments answered or handled meanwhile', async () => {
    const { cookie, post, comment, target } = await setup();
    const [answered, handled] = await drafted(target, comment.id, 2);
    await prisma.postComment.update({ where: { id: answered.id }, data: { pageReplied: true } });
    await prisma.postComment.update({ where: { id: handled.id }, data: { handledAt: new Date() } });
    const graph = stubGraph(async () => replyOk('REPLY_ONLY_ONE'));
    const res = await sendAll(cookie, post.id);
    expect(res.json.data.sent).toBe(1);
    expect(graph).toHaveBeenCalledTimes(1);
    // and the view never offers a draft for a comment that no longer waits
    expect(res.json.data.pages[0].threads.every((t: { draftReply: string | null }) => t.draftReply === null)).toBe(true);
  });

  it('send-drafts stops at the first failure, says how many were sent, and keeps the unsent drafts', async () => {
    const { cookie, post, comment, target } = await setup();
    await drafted(target, comment.id, 2);
    let call = 0;
    const graph = stubGraph(async () =>
      ++call === 2 ? new Response(JSON.stringify({ error: { message: '(#200) Permissions error', code: 200 } }), { status: 400 }) : replyOk(`REPLY_PARTIAL_${Date.now()}`)
    );
    const res = await sendAll(cookie, post.id);
    expect(res.status).toBe(200);
    expect(res.json.data.sent).toBe(1);
    expect(res.json.data.failed).toMatch(/Facebook chưa nhận câu trả lời/);
    expect(graph).toHaveBeenCalledTimes(2);
    const left = await prisma.postComment.findMany({ where: { targetId: target.id, parentFbId: null, draftReply: { not: null } }, orderBy: { commentedAt: 'asc' } });
    expect(left.map((c) => c.draftReply)).toEqual(['Trả lời 0', 'Trả lời 1']);
  });

  it('send-drafts needs the reply permission; a post can opt out of AI drafts', async () => {
    const readOnly = await setup(ALL.filter((s) => s !== 'pages_manage_engagement'));
    await drafted(readOnly.target, readOnly.comment.id);
    const graph = stubGraph();
    const refused = await sendAll(readOnly.cookie, readOnly.post.id);
    expect(refused.json.data).toMatchObject({ sent: 0, failed: null });
    expect(graph).not.toHaveBeenCalled();
    expect((await prisma.postComment.findUniqueOrThrow({ where: { id: readOnly.comment.id } })).draftReply).not.toBeNull();

    const { cookie, post } = await setup();
    const off = await api(server.baseUrl, 'PATCH', `/api/posts/${post.id}/comments/auto-reply`, { cookie, body: { off: true } });
    expect(off.status).toBe(200);
    expect(off.json.data.autoReplyOff).toBe(true);
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).autoReplyOff).toBe(true);
    expect((await api(server.baseUrl, 'PATCH', `/api/posts/${post.id}/comments/auto-reply`, { cookie, body: { off: false } })).json.data.autoReplyOff).toBe(false);
  });


  it('send-drafts sends only the drafts the member was shown, word for word', async () => {
    const { cookie, post, comment, target } = await setup();
    const [second, third] = await drafted(target, comment.id, 2);
    const graph = stubGraph(async () => replyOk(`REPLY_SHOWN_${Date.now()}`));
    // the panel showed two drafts; the sync has rewritten one since, and written a third the member never saw
    await prisma.postComment.update({ where: { id: second.id }, data: { draftReply: 'Bản AI viết lại sau đó' } });
    const res = await sendAll(cookie, post.id, [
      { commentId: comment.id, reply: 'Dạ mời anh nhắn tin cho Page ạ.' },
      { commentId: second.id, reply: 'Trả lời 0' },
    ]);
    expect(res.json.data).toMatchObject({ sent: 1, failed: null });
    expect(graph).toHaveBeenCalledTimes(1);
    expect((await prisma.postComment.findUniqueOrThrow({ where: { id: second.id } })).draftReply).toBe('Bản AI viết lại sau đó');
    expect((await prisma.postComment.findUniqueOrThrow({ where: { id: third.id } })).draftReply).toBe('Trả lời 1');
    // nothing named: nothing sent
    expect((await api(server.baseUrl, 'POST', `/api/posts/${post.id}/comments/send-drafts`, { cookie, body: {} })).status).toBe(400);
    expect((await sendAll(cookie, post.id, Array.from({ length: 21 }, () => ({ commentId: comment.id, reply: 'x' })))).status).toBe(400);
    expect(graph).toHaveBeenCalledTimes(1);
  });

  it('two send-drafts at the same moment answer each comment once', async () => {
    const { cookie, post, comment, target } = await setup();
    await drafted(target, comment.id, 2);
    let n = 0;
    const graph = stubGraph(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return replyOk(`REPLY_RACE_${Date.now()}_${n++}`);
    });
    const [a, b] = await Promise.all([sendAll(cookie, post.id), sendAll(cookie, post.id)]);
    expect(a.json.data.sent + b.json.data.sent).toBe(3);
    expect(graph).toHaveBeenCalledTimes(3);
  });

  it('when Facebook gives no clear answer, send-drafts stops and that draft cannot be sent again by a second click', async () => {
    const { cookie, post, comment, target } = await setup();
    const [second, third] = await drafted(target, comment.id, 2);
    let call = 0;
    const graph = stubGraph(async () => {
      if (++call === 2) throw new TypeError('fetch failed');
      return replyOk(`REPLY_UNSURE_${Date.now()}_${call}`);
    });
    const all = [
      { commentId: comment.id, reply: 'Dạ mời anh nhắn tin cho Page ạ.' },
      { commentId: second.id, reply: 'Trả lời 0' },
      { commentId: third.id, reply: 'Trả lời 1' },
    ];
    const res = await sendAll(cookie, post.id, all);
    expect(res.json.data.sent).toBe(1);
    expect(res.json.data.failed).toMatch(/Không chắc Facebook đã nhận/);
    // the text comes back for the member to look at, but it is no longer a draft "send all" would post
    expect(res.json.data.uncertain).toEqual({ commentId: second.id, reply: 'Trả lời 0' });
    expect(await prisma.postComment.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ draftReply: null, pageReplied: false });
    // the same click again: only the third one goes out
    const again = await sendAll(cookie, post.id, all);
    expect(again.json.data).toMatchObject({ sent: 1, failed: null, uncertain: null });
    expect(graph).toHaveBeenCalledTimes(3);
  });

  it('a Page that may no longer answer does not hold back the drafts of the post\'s other Pages', async () => {
    const { cookie, post, comment, target } = await setup();
    await drafted(target, comment.id);
    // the same post also went to a second Page, which lost the reply permission; its comment is the older one
    const lost = await prisma.facebookPage.create({
      data: { userId: post.userId, pageId: `CM_LOST_${Date.now()}`, pageName: 'Mất quyền', pageAccessToken: encrypt('EAAtokencommentslostxxxxxxxxxxxxxxx'), tokenStatus: 'VALID', grantedScopes: ALL.filter((x) => x !== 'pages_manage_engagement') },
    });
    const lostTarget = await prisma.postTarget.create({ data: { postId: post.id, pageId: lost.id, status: 'PUBLISHED', fbPostId: `CM_LOST_POST_${Date.now()}`, publishedAt: new Date() } });
    const stuck = await prisma.postComment.create({
      data: { targetId: lostTarget.id, fbCommentId: `C_LOST_${Date.now()}`, authorName: 'Cũ', message: 'Hỏi từ hôm qua', commentedAt: new Date(Date.now() - 86_400_000), draftReply: 'Gợi ý không gửi được', draftCheckedAt: new Date() },
    });
    const graph = stubGraph(async () => replyOk(`REPLY_OTHER_PAGE_${Date.now()}`));
    const res = await sendAll(cookie, post.id);
    expect(res.json.data).toMatchObject({ sent: 1, failed: null });
    expect(graph).toHaveBeenCalledTimes(1);
    expect((await prisma.postComment.findUniqueOrThrow({ where: { id: stuck.id } })).draftReply).toBe('Gợi ý không gửi được');
  });
});
