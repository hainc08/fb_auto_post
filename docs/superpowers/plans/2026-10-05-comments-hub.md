# Comments Module ("Bình luận") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A page of its own, "Bình luận", laid out as a dashboard: choose a Page → see its published posts with their comment counts → read and answer the comments of the chosen post, without opening posts one by one.

**Architecture:** Three small read/refresh routes under `/api/comments` (per-Page totals, the posts of one Page with their counts, "refresh this Page") feed a new client page `/comments` with three panes. The right pane reuses the existing comments UI: the body of today's `CommentsPanel` dialog is extracted into `CommentsBoard`, which the dialog (Posts page) and the new page both render, so replying, AI drafts, "Đã xử lý" and the per-post AI switch behave identically in both places. No schema change.

**Tech Stack:** Express + zod, Prisma (read queries, `groupBy`), existing `syncTargets`, React + react-router, plain CSS tokens, Vitest.

**Spec:** none — requested in chat on 2026-10-05: "dựng riêng một module quản lý các bình luận… thứ tự trong đó là chọn page, danh sách các bài, hiển thị các bình luận trên đó, view theo dạng dashboard để dễ kiểm tra".

Decisions taken for this plan (the user may overrule them before execution):

1. Only posts the app published are listed (those are the ones whose comments the app syncs), newest 100 per Page.
2. Posts with comments waiting come first, then newest first; a filter "Cần trả lời / Tất cả".
3. Four tiles for the chosen Page: comments waiting, AI drafts waiting, posts with comments, last update + "Làm mới Page".
4. "Làm mới Page" syncs that Page's posts of the last 30 days (the sync window), at most 50, skipping those synced in the last 30 seconds. AI drafts it triggers show a few seconds later.
5. The menu gets "Bình luận" with a badge: comments waiting across all Pages.
6. The Posts page keeps its comments dialog; both places show the same thing.
7. On phones the panes become steps: Pages, then posts, then the comments with a "back to the posts" link.

## Global Constraints

- **Branch from `feature/comment-reply-drafts`** (not `main`): this module shows AI drafts and needs that branch's code. New branch: `feature/comments-hub`. If `feature/comment-reply-drafts` has been merged to `main` by then, branch from `main`.
- UI copy and API error messages are Vietnamese; code and comments are English.
- No schema change, no new dependency, no new job type.
- Nothing in this plan posts to Facebook by itself: replies go through the existing routes, on the member's click.
- Every new route filters by `req.user.id`, returns 404 for another user's Page id, and is added to `ROUTE_CASES` in `tests/isolation.db.test.ts`.
- Tests never reach Gemini or Facebook: stub Graph `fetch` inside each test.
- **Before any `RUN_DB_TESTS=1` run: kill the `tsx watch` parent of `npm run dev` and the Vite server, and confirm nothing listens on port 3000.** MariaDB must be up; ask the user to start Docker, never start it unprompted.
- Client commands need Node 22: `npx -y -p node@22 -- node …` as in `CLAUDE.md`. Styling: plain CSS in `client/src/index.css`, existing tokens and classes.
- Public repo: stage files by name, never `git add -A`, never commit `.env*`, `CR/`, `bugs/`, `prompt_creator_video.md`, `STORY_VIDEO_PLAN.pdf`. Do not merge, push or deploy without the user asking.

## Review Focus

1. The member answers the last waiting comment of a post while the list is filtered to "Cần trả lời" → the list reloads without that post, but the comments being worked on stay on screen (Task 3: the board is driven by the URL, not by the list; checked in the browser step).
2. Another member's Page id in `GET /api/comments/posts` or `POST /api/comments/refresh` → 404, and `GET /api/comments/overview` never shows it (Task 1 tests and isolation entries).
3. A Page whose token is not valid for the current Facebook App → "Làm mới Page" says so instead of doing nothing silently (Task 1 test "refuses a Page whose token is not valid").
4. Counts shown in the dashboard and in the comments pane disagree after an action → every action in the board reloads the tiles and the list (Task 3; checked in the browser step).
5. A post published to two Pages → under Page A only A's comments show, and "Gửi N gợi ý" sends only A's drafts (Task 2: `pageId` narrows the board; checked in the browser step with a two-Page post).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/routes/comments-hub.routes.ts` (new) | `GET /overview`, `GET /posts`, `POST /refresh` under `/api/comments` |
| `src/app.ts` (modify) | Mount the router in `API_ROUTERS` |
| `client/src/components/CommentsBoard.tsx` (new) | The comments of one post: toolbar, filter, threads, replies, AI drafts (moved out of the dialog) |
| `client/src/components/CommentsPanel.tsx` (rewrite, small) | The dialog shell around `CommentsBoard` |
| `client/src/pages/CommentsPage.tsx` (new) | The dashboard: Pages, posts, board |
| `client/src/api.ts`, `client/src/App.tsx`, `client/src/components/Sidebar.tsx`, `client/src/index.css` (modify) | API calls and types, route, menu entry with badge, styles |
| `tests/comments-hub.db.test.ts` (new), `tests/isolation.db.test.ts` (modify) | Tests |
| `CLAUDE.md`, `ROADMAP.md` (modify) | Docs |

---

### Task 1: The comments hub API

**Files:**
- Create: `src/routes/comments-hub.routes.ts`, `tests/comments-hub.db.test.ts`
- Modify: `src/app.ts`, `tests/isolation.db.test.ts`

**Interfaces:**
- Consumes: `syncTargets(targetIds, now, { draftWaitMs })`, `ENGAGEMENT_WINDOW_DAYS` from `src/services/engagement-sync.ts`; `COMMENT_READ_SCOPE`, `COMMENT_REPLY_SCOPE` from `src/lib/clients/facebook.ts`.
- Produces (all need the session cookie):
  - `GET /api/comments/overview` → `{ pages: HubPage[] }`, active Pages by name, with `HubPage = { id, pageName, pageAvatar: string | null, canRead: boolean, canReply: boolean, autoReply: boolean, tokenValid: boolean, posts: number, postsWithComments: number, comments: number, unanswered: number, drafts: number, syncedAt: string | null }`.
  - `GET /api/comments/posts?pageId=<uuid>&filter=all|pending` → `HubPost[]` (at most 100), with `HubPost = { targetId, postId, caption: string, imageUrl: string | null, hasVideo: boolean, publishedAt: string | null, fbPermalink: string | null, reactionCount: number | null, commentCount: number | null, shareCount: number | null, unansweredCount: number, draftCount: number, statsSyncedAt: string | null, commentsError: string | null }`.
  - `POST /api/comments/refresh` body `{ pageId }` → `{ synced: number }`; 400 no recent post, 409 token not valid, 429 all just synced.

- [ ] **Step 1: Branch and commit the plan**

Stop the dev servers first (Global Constraints), then:

```bash
git checkout feature/comment-reply-drafts && git checkout -b feature/comments-hub
git add docs/superpowers/plans/2026-10-05-comments-hub.md
git commit -m "docs: plan for the comments module"
```

- [ ] **Step 2: Write the failing test**

Create `tests/comments-hub.db.test.ts`:

```ts
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
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `RUN_DB_TESTS=1 npx vitest run tests/comments-hub.db.test.ts`
Expected: FAIL — every request gets 404 (`/api/comments/…` does not exist).

- [ ] **Step 4: Write `src/routes/comments-hub.routes.ts`**

```ts
import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { toStringArray } from '../utils/json';
import { COMMENT_READ_SCOPE, COMMENT_REPLY_SCOPE } from '../lib/clients/facebook';
import { ENGAGEMENT_WINDOW_DAYS, syncTargets } from '../services/engagement-sync';

/**
 * The "Bình luận" page (mounted at /api/comments): totals per Page, the posts of one Page with their
 * comment counts, and "refresh this Page". The comments of a post come from /api/posts/:id/comments.
 */

const router = Router();
router.use(authenticate);

const POSTS_LIMIT = 100;
const REFRESH_LIMIT = 50;
const REFRESH_WAIT_MS = 30_000;
/** A post on a Page that is live on Facebook */
const published = { status: 'PUBLISHED', fbPostId: { not: null } } as const;

/** AI drafts still waiting to be sent, per target */
async function draftCounts(targetIds: string[]): Promise<Map<string, number>> {
  if (!targetIds.length) return new Map();
  const rows = await prisma.postComment.groupBy({
    by: ['targetId'],
    where: { targetId: { in: targetIds }, parentFbId: null, fromPage: false, pageReplied: false, handledAt: null, draftReply: { not: null } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.targetId, r._count._all]));
}

/** The caller's Page, or 404 */
async function ownPage(userId: string, pageId: string) {
  const page = await prisma.facebookPage.findFirst({ where: { id: pageId, userId }, select: { id: true, tokenStatus: true } });
  if (!page) throw createError(404, 'Page not found');
  return page;
}

/** Totals of each active Page: what waits for an answer, what the AI drafted, when it was last synced. */
router.get(
  '/overview',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const pages = await prisma.facebookPage.findMany({
      where: { userId, isActive: true },
      select: { id: true, pageName: true, pageAvatar: true, grantedScopes: true, autoReply: true, tokenStatus: true },
      orderBy: { pageName: 'asc' },
    });
    const targets = await prisma.postTarget.findMany({
      where: { ...published, pageId: { in: pages.map((p) => p.id) }, post: { userId } },
      select: { id: true, pageId: true, commentCount: true, unansweredCount: true, statsSyncedAt: true },
    });
    const drafts = await draftCounts(targets.map((t) => t.id));
    res.json({
      success: true,
      data: {
        pages: pages.map((p) => {
          const mine = targets.filter((t) => t.pageId === p.id);
          const scopes = toStringArray(p.grantedScopes);
          const synced = mine.map((t) => t.statsSyncedAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
          return {
            id: p.id,
            pageName: p.pageName,
            pageAvatar: p.pageAvatar,
            canRead: scopes.includes(COMMENT_READ_SCOPE),
            canReply: scopes.includes(COMMENT_REPLY_SCOPE),
            autoReply: p.autoReply,
            tokenValid: p.tokenStatus === 'VALID',
            posts: mine.length,
            postsWithComments: mine.filter((t) => (t.commentCount ?? 0) > 0).length,
            comments: mine.reduce((sum, t) => sum + (t.commentCount ?? 0), 0),
            unanswered: mine.reduce((sum, t) => sum + t.unansweredCount, 0),
            drafts: mine.reduce((sum, t) => sum + (drafts.get(t.id) ?? 0), 0),
            syncedAt: synced ? new Date(synced).toISOString() : null,
          };
        }),
      },
    });
  })
);

const postsQuery = z.object({ pageId: z.string().uuid(), filter: z.enum(['all', 'pending']).default('all') });

/** The published posts of one Page: those with comments waiting first, then the newest (at most 100). */
router.get(
  '/posts',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { pageId, filter } = postsQuery.parse(req.query);
    const userId = req.user!.id;
    const page = await ownPage(userId, pageId);
    const targets = await prisma.postTarget.findMany({
      where: { ...published, pageId: page.id, post: { userId }, ...(filter === 'pending' && { unansweredCount: { gt: 0 } }) },
      orderBy: [{ unansweredCount: 'desc' }, { publishedAt: 'desc' }],
      take: POSTS_LIMIT,
      select: {
        id: true,
        postId: true,
        publishedAt: true,
        fbPermalink: true,
        reactionCount: true,
        commentCount: true,
        shareCount: true,
        unansweredCount: true,
        statsSyncedAt: true,
        commentsError: true,
        post: { select: { caption: true, imageUrl: true, videoUrl: true } },
      },
    });
    const drafts = await draftCounts(targets.map((t) => t.id));
    res.json({
      success: true,
      data: targets.map(({ id, post, ...t }) => ({
        targetId: id,
        ...t,
        caption: (post.caption ?? '').slice(0, 300),
        imageUrl: post.imageUrl,
        hasVideo: !!post.videoUrl,
        draftCount: drafts.get(id) ?? 0,
      })),
    });
  })
);

/**
 * "Làm mới Page": sync the Page's posts of the last 30 days now (counts, comments, and AI drafts where the
 * Page has them on — those finish in the background). Posts synced in the last 30 seconds are left alone.
 */
router.post(
  '/refresh',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { pageId } = z.object({ pageId: z.string().uuid() }).parse(req.body ?? {});
    const userId = req.user!.id;
    const page = await ownPage(userId, pageId);
    if (page.tokenStatus !== 'VALID') {
      throw createError(409, 'Token của Page này chưa dùng được với Facebook App hiện tại nên chưa đọc được bình luận. Vào Kênh Facebook → Đồng bộ Page rồi thử lại.');
    }
    const now = Date.now();
    const targets = await prisma.postTarget.findMany({
      where: { ...published, pageId: page.id, post: { userId }, publishedAt: { gte: new Date(now - ENGAGEMENT_WINDOW_DAYS * 86_400_000) } },
      orderBy: { publishedAt: 'desc' },
      take: REFRESH_LIMIT,
      select: { id: true, statsSyncedAt: true },
    });
    if (!targets.length) throw createError(400, `Page chưa có bài nào được đăng trong ${ENGAGEMENT_WINDOW_DAYS} ngày gần đây.`);
    const due = targets.filter((t) => !t.statsSyncedAt || now - t.statsSyncedAt.getTime() >= REFRESH_WAIT_MS);
    if (!due.length) throw createError(429, 'Vừa làm mới xong, thử lại sau ít giây.');
    // AI drafts are not waited for here (one Gemini call per post with new comments): they show a few seconds later
    await syncTargets(due.map((t) => t.id), new Date(), { draftWaitMs: 0 });
    res.json({ success: true, data: { synced: due.length } });
  })
);

export default router;
```

- [ ] **Step 5: Mount it and declare the routes**

In `src/app.ts`: add `import commentsHubRoutes from './routes/comments-hub.routes';` after the `commentsRoutes` import, and in `API_ROUTERS` add after `['/api/posts', reelRoutes],`:

```ts
  ['/api/comments', commentsHubRoutes],
```

In `tests/isolation.db.test.ts`, in `ROUTE_CASES`, after the line that starts `'PATCH /api/posts/:id/comments/auto-reply':` add:

```ts
  'GET /api/comments/overview': { kind: 'list', path: '/api/comments/overview' },
  'GET /api/comments/posts': { kind: 'foreign-id', path: (b) => `/api/comments/posts?pageId=${b.pageId}` },
  'POST /api/comments/refresh': { kind: 'foreign-id', path: () => '/api/comments/refresh' }, // body = B's pageId (below)
```

and in the same file, in the `bodies` object of the test "user A gets 404 on every route that takes user B's ids" (the object that already has `'POST /api/settings/test/:group': { pageId: b.pageId },`), add:

```ts
      'POST /api/comments/refresh': { pageId: b.pageId },
```

- [ ] **Step 6: Run the tests**

Run: `npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run tests/comments-hub.db.test.ts tests/isolation.db.test.ts tests/app.test.ts`
Expected: typecheck clean; all pass.

- [ ] **Step 7: Commit**

```bash
git add src/routes/comments-hub.routes.ts src/app.ts tests/comments-hub.db.test.ts tests/isolation.db.test.ts
git commit -m "feat(comments): hub API — totals per Page, posts of a Page, refresh a Page"
```

---

### Task 2: `CommentsBoard` — the comments UI out of the dialog

**Files:**
- Create: `client/src/components/CommentsBoard.tsx`
- Modify: `client/src/components/CommentsPanel.tsx` (becomes the dialog shell), `client/src/index.css`

**Interfaces:**
- Consumes: the existing `postsApi` comment calls and types.
- Produces: `<CommentsBoard postId pageId? onChanged />` — `pageId` (a `FacebookPage.id`) narrows the board to that Page's comments, counts and "Gửi N gợi ý". `CommentsPanel` keeps its props `{ postId, onClose, onChanged }`.

There is no client test runner: this task is a move with no behaviour change, checked by typecheck, lint, build and the browser in Task 3.

- [ ] **Step 1: Create `client/src/components/CommentsBoard.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Check, Undo2, AlertTriangle, Sparkles, Send } from 'lucide-react';
import { postsApi, type CommentsPage, type CommentsView, type CommentThread } from '../api';
import { useToast } from './Toast';
import { formatWhen } from './PostBits';

interface Props {
  postId: string;
  /** Only this Page's comments (the "Bình luận" page works one Page at a time); default: every Page the post is on */
  pageId?: string;
  /** Counts changed (reply, handled, refresh, drafts): whoever shows them reloads */
  onChanged: () => void;
}

/** Comments of one published post, by Page: needs-reply first, reply as the Page, AI drafts, mark handled. */
export default function CommentsBoard({ postId, pageId, onChanged }: Props) {
  const toast = useToast();
  const [all, setAll] = useState<CommentsPage[] | null>(null);
  /** This post is left out of AI reply drafts */
  const [autoReplyOff, setAutoReplyOff] = useState(false);
  /** "Gửi N gợi ý" posts publicly: asked twice */
  const [armed, setArmed] = useState(false);
  const show = (view: CommentsView) => {
    setAll(view.pages);
    setAutoReplyOff(view.autoReplyOff);
  };
  const [onlyPending, setOnlyPending] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** Actions in flight (several can run at once; each key stays busy until its own request ends) */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const replying = [...busy].some((k) => k.startsWith('r:'));
  const pages = all && pageId ? all.filter((p) => p.page.id === pageId) : all;

  useEffect(() => {
    postsApi
      .comments(postId)
      .then((r) => show(r.data))
      .catch((e) => toast.error(e.message));
  }, [postId]);

  /** Run one action; true when it succeeded */
  async function run(key: string, action: () => Promise<{ data: CommentsView }>, done?: string): Promise<boolean> {
    setBusy((b) => new Set(b).add(key));
    try {
      const res = await action();
      show(res.data);
      onChanged();
      if (done) toast.success(done);
      return true;
    } catch (e: any) {
      toast.error(e.message);
      return false;
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(key);
        return next;
      });
    }
  }

  /** Post every waiting AI draft (the ones edited here are sent one by one with "Trả lời") */
  async function sendDrafts() {
    if (!armed) return setArmed(true);
    setArmed(false);
    setBusy((b) => new Set(b).add('r:all'));
    try {
      // exactly what is on screen: a draft the sync wrote meanwhile is not sent unread
      const { data } = await postsApi.sendDrafts(postId, sendable.map((t) => ({ commentId: t.id, reply: t.draftReply! })));
      show(data);
      // Facebook gave no clear answer for one: its text goes back in its box, to send by hand after a look at Facebook
      const unsure = data.uncertain;
      if (unsure) setDrafts((d) => ({ ...d, [unsure.commentId]: unsure.reply }));
      onChanged();
      if (data.failed) toast.error(`Đã gửi ${data.sent} câu rồi dừng: ${data.failed}`);
      else toast.success(data.sent ? `Đã gửi ${data.sent} câu trả lời trên Facebook.` : 'Không còn gợi ý nào để gửi.');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete('r:all');
        return next;
      });
    }
  }

  const pending = (pages ?? []).reduce((s, p) => s + p.unansweredCount, 0);
  const synced = (pages ?? []).map((p) => p.statsSyncedAt).filter((d): d is string => !!d).sort().pop() ?? null;
  /** A draft changed in its box: "Gửi N gợi ý" would post it as the AI wrote it, so it is left to its own "Trả lời" button */
  const edited = (t: CommentThread) => drafts[t.id] !== undefined && drafts[t.id] !== t.draftReply;
  /** Drafts "Gửi N gợi ý" sends: on Pages that may answer, untouched, at most 20 at a time (the server's limit) */
  const sendable = (pages ?? []).filter((p) => p.canReply).flatMap((p) => p.threads.filter((t) => t.draftReply && !edited(t))).slice(0, 20);
  const draftCount = sendable.length;
  const hasEdited = (pages ?? []).some((p) => p.canReply && p.threads.some((t) => t.draftReply && edited(t)));
  const anyAuto = (pages ?? []).some((p) => p.autoReply);

  function thread(p: CommentsPage, t: CommentThread) {
    // The AI draft fills the box until the member types something else
    const draft = drafts[t.id] ?? t.draftReply ?? '';
    const fromAi = !!t.draftReply && draft === t.draftReply;
    return (
      <li key={t.id} className={`comment-thread ${t.needsReply ? 'pending' : ''}`}>
        <div className="comment-head">
          <strong>{t.fromPage ? p.page.pageName : (t.authorName ?? 'Người xem')}</strong>
          <span className="muted">{formatWhen(t.commentedAt)}</span>
          {t.needsReply && <span className="badge badge-ready">Cần trả lời</span>}
          {t.handledAt && <span className="badge badge-draft">Đã xử lý</span>}
        </div>
        <p className="comment-body">{t.message || <em className="muted">(bình luận không có chữ)</em>}</p>
        {t.replies.map((r) => (
          <div key={r.id} className={`comment-reply ${r.fromPage ? 'from-page' : ''}`}>
            <strong>{r.fromPage ? p.page.pageName : (r.authorName ?? 'Người xem')}</strong> <span className="muted">{formatWhen(r.commentedAt)}</span>
            <p className="comment-body">{r.message}</p>
          </div>
        ))}
        <div className="comment-actions">
          {p.canReply && (
            <>
              <div className="comment-reply-box">
                {fromAi && (
                  <span className="draft-chip">
                    <Sparkles size={12} aria-hidden="true" /> AI gợi ý — sửa nếu cần rồi gửi
                  </span>
                )}
                <textarea
                  className="form-textarea"
                  rows={2}
                  maxLength={2000}
                  aria-label={`Trả lời ${t.authorName ?? 'bình luận'}`}
                  placeholder="Trả lời bằng tên Page…"
                  value={draft}
                  onChange={(e) => setDrafts({ ...drafts, [t.id]: e.target.value })}
                />
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                // One public reply at a time: no second send while any reply is in flight
                disabled={!draft.trim() || replying}
                onClick={async () => {
                  const ok = await run(`r:${t.id}`, () => postsApi.replyComment(postId, t.id, draft.trim()), 'Đã trả lời trên Facebook.');
                  if (ok) setDrafts(({ [t.id]: _sent, ...rest }) => rest);
                }}
              >
                {busy.has(`r:${t.id}`) ? <div className="spinner" /> : 'Trả lời'}
              </button>
            </>
          )}
          {t.draftReply && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy.has(`d:${t.id}`)}
              onClick={async () => {
                const ok = await run(`d:${t.id}`, () => postsApi.discardDraft(postId, t.id));
                if (ok) setDrafts(({ [t.id]: _dropped, ...rest }) => rest);
              }}
            >
              Bỏ gợi ý
            </button>
          )}
          {!t.fromPage && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy.has(`h:${t.id}`)} onClick={() => void run(`h:${t.id}`, () => postsApi.markHandled(postId, t.id, !t.handledAt))}>
              {t.handledAt ? (
                <>
                  <Undo2 size={14} aria-hidden="true" /> Bỏ đánh dấu
                </>
              ) : (
                <>
                  <Check size={14} aria-hidden="true" /> Đã xử lý
                </>
              )}
            </button>
          )}
        </div>
      </li>
    );
  }

  return (
    <div className="comments-board">
      <div className="comments-toolbar">
        <p className="field-hint" style={{ margin: 0 }}>
          {pending ? `${pending} cần trả lời` : 'Không có bình luận chờ trả lời'} · {synced ? `cập nhật ${formatWhen(synced)}` : 'chưa đồng bộ'}
        </p>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {draftCount > 0 && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={replying || hasEdited}
              title={hasEdited ? 'Bạn đang sửa một gợi ý: gửi câu đó bằng nút "Trả lời" trước' : undefined}
              onClick={() => void sendDrafts()}
              onBlur={() => setArmed(false)}
            >
              {busy.has('r:all') ? <div className="spinner" /> : <Send size={14} aria-hidden="true" />}
              {armed ? `Bấm lần nữa: gửi ${draftCount} câu lên Facebook` : `Gửi ${draftCount} gợi ý`}
            </button>
          )}
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy.has('refresh')} onClick={() => void run('refresh', () => postsApi.refreshComments(postId), 'Đã làm mới.')}>
            {busy.has('refresh') ? <div className="spinner" /> : <RefreshCw size={14} aria-hidden="true" />} Làm mới
          </button>
        </div>
      </div>
      <div className="segmented" role="radiogroup" aria-label="Lọc bình luận">
        <button type="button" role="radio" aria-checked={onlyPending} className={onlyPending ? 'active' : ''} onClick={() => setOnlyPending(true)}>
          Cần trả lời
        </button>
        <button type="button" role="radio" aria-checked={!onlyPending} className={!onlyPending ? 'active' : ''} onClick={() => setOnlyPending(false)}>
          Tất cả
        </button>
      </div>
      {anyAuto && (
        <label className="switch comments-auto" title="Tắt: AI không soạn câu trả lời cho bình luận của riêng bài này">
          <input
            type="checkbox"
            checked={!autoReplyOff}
            disabled={busy.has('auto')}
            onChange={(e) => void run('auto', () => postsApi.setAutoReplyOff(postId, !e.target.checked))}
            aria-label="AI soạn trả lời cho bài này"
          />
          <span className="switch-track" aria-hidden="true" />
          <span className="switch-label">AI soạn trả lời cho bài này</span>
        </label>
      )}
      {!pages ? (
        <div className="loading-page"><div className="spinner spinner-lg" /></div>
      ) : pages.length === 0 ? (
        <p className="field-hint">Bài chưa được đăng lên Page nào.</p>
      ) : (
        pages.map((p) => {
          const shown = onlyPending ? p.threads.filter((t) => t.needsReply) : p.threads;
          return (
            <section key={p.targetId} className="comments-page" aria-label={`Bình luận trên ${p.page.pageName}`}>
              {pages.length > 1 && <h3>{p.page.pageName}</h3>}
              {!p.canRead && (
                <p className="comments-note">
                  <AlertTriangle size={14} aria-hidden="true" /> {p.commentsError ?? 'Page chưa cấp quyền đọc bình luận.'} <Link to="/pages">Kênh Facebook</Link>
                </p>
              )}
              {p.canRead && !p.canReply && (
                <p className="comments-note">
                  <AlertTriangle size={14} aria-hidden="true" /> Muốn trả lời trong app: vào <Link to="/pages">Kênh Facebook</Link> → Đồng bộ Page và tick quyền quản lý bình luận.
                </p>
              )}
              {shown.length ? (
                <ul className="comment-list">{shown.map((t) => thread(p, t))}</ul>
              ) : (
                <p className="field-hint">{onlyPending ? 'Không có bình luận chờ trả lời.' : 'Chưa có bình luận.'}</p>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
```

- [ ] **Step 2: Replace `client/src/components/CommentsPanel.tsx`**

```tsx
import { useEffect } from 'react';
import { X } from 'lucide-react';
import CommentsBoard from './CommentsBoard';

interface Props {
  postId: string;
  onClose: () => void;
  /** Counts changed (reply, handled, refresh): the list reloads */
  onChanged: () => void;
}

/** The comments of one post in a dialog (Posts page). The "Bình luận" page shows the same board inline. */
export default function CommentsPanel({ postId, onClose, onChanged }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-panel comments-panel" role="dialog" aria-modal="true" aria-labelledby="comments-title">
        <header className="modal-head">
          <h2 id="comments-title">Bình luận</h2>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Đóng">
            <X size={20} />
          </button>
        </header>
        <div className="comments-body">
          <CommentsBoard postId={postId} onChanged={onChanged} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Styles**

In `client/src/index.css`, replace these three lines:

```css
.comments-body { padding: 16px 24px 24px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
```

```css
.comments-body > * { flex-shrink: 0; }
.comments-body > .segmented { align-self: flex-start; }
```

with:

```css
.comments-body { padding: 16px 24px 24px; overflow-y: auto; }
/* The comments of one post: in the dialog (Posts page) and inline (Bình luận page) */
.comments-board { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.comments-board > * { flex-shrink: 0; }
.comments-board > .segmented { align-self: flex-start; }
.comments-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
```

(Keep the comment line that sits between the first and the second of those lines, if there is one.)

- [ ] **Step 4: Typecheck, lint, build**

Run (from `client/`): `npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b && npm run lint && npx -y -p node@22 -- node node_modules/vite/bin/vite.js build`
Expected: typecheck clean; lint shows no new kind of warning in `CommentsBoard.tsx` beyond `react-hooks(exhaustive-deps)` on its effect; build ends with `✓ built in …`.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/CommentsBoard.tsx client/src/components/CommentsPanel.tsx client/src/index.css
git commit -m "refactor(client): CommentsBoard — the comments UI out of the dialog"
```

---

### Task 3: The "Bình luận" page

**Files:**
- Create: `client/src/pages/CommentsPage.tsx`
- Modify: `client/src/api.ts`, `client/src/App.tsx`, `client/src/components/Sidebar.tsx`, `client/src/index.css`

**Interfaces:**
- Consumes: Task 1's routes; Task 2's `<CommentsBoard postId pageId onChanged />`.
- Produces: route `/comments` (`?page=<FacebookPage.id>&post=<Post.id>`), menu entry "Bình luận".

- [ ] **Step 1: API**

In `client/src/api.ts`, after the `CommentsView` interface add:

```ts
/** One Page in the "Bình luận" dashboard */
export interface CommentsHubPage {
  id: string;
  pageName: string;
  pageAvatar: string | null;
  canRead: boolean;
  canReply: boolean;
  /** "AI soạn trả lời bình luận" is on */
  autoReply: boolean;
  /** The token works with the current Facebook App (else nothing can be synced) */
  tokenValid: boolean;
  posts: number;
  postsWithComments: number;
  comments: number;
  unanswered: number;
  /** AI drafts waiting to be sent */
  drafts: number;
  syncedAt: string | null;
}

/** One published post of a Page in the "Bình luận" dashboard */
export interface CommentsHubPost {
  targetId: string;
  postId: string;
  caption: string;
  imageUrl: string | null;
  hasVideo: boolean;
  publishedAt: string | null;
  fbPermalink: string | null;
  reactionCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
  unansweredCount: number;
  draftCount: number;
  statsSyncedAt: string | null;
  commentsError: string | null;
}
```

At the end of the file (or next to the other `…Api` objects) add:

```ts
/** The "Bình luận" page: Pages with their totals, the posts of one Page, refresh a Page. */
export const commentsApi = {
  overview: () => apiFetch<{ pages: CommentsHubPage[] }>('/comments/overview'),
  posts: (pageId: string, filter: 'all' | 'pending') => apiFetch<CommentsHubPost[]>(`/comments/posts?pageId=${pageId}&filter=${filter}`),
  /** Sync the Page's recent posts now (counts, comments; AI drafts follow a few seconds later). */
  refresh: (pageId: string) => apiFetch<{ synced: number }>('/comments/refresh', { method: 'POST', body: JSON.stringify({ pageId }) }),
};
```

- [ ] **Step 2: Create `client/src/pages/CommentsPage.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ExternalLink, MessageCircle, RefreshCw, Sparkles, ThumbsUp } from 'lucide-react';
import { commentsApi, assetUrl, type CommentsHubPage, type CommentsHubPost } from '../api';
import { useToast } from '../components/Toast';
import CommentsBoard from '../components/CommentsBoard';
import { PostThumb, formatWhen, pageInitials, postTitle } from '../components/PostBits';

/** "Bình luận": choose a Page → its published posts with their counts → the comments of one post. */
export default function CommentsPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const pageId = params.get('page');
  const postId = params.get('post');
  const [pages, setPages] = useState<CommentsHubPage[] | null>(null);
  const [posts, setPosts] = useState<CommentsHubPost[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'pending'>('all');
  const [refreshing, setRefreshing] = useState(false);

  /** Change the address (the page reads everything it shows from it, so a reload or a shared link lands on the same view) */
  function go(next: { page?: string | null; post?: string | null }, replace = false) {
    const p = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) p.set(key, value);
      else p.delete(key);
    }
    setParams(p, { replace });
  }

  const loadPages = () =>
    commentsApi.overview().then((r) => {
      setPages(r.data.pages);
      return r.data.pages;
    });
  const loadPosts = (id: string, f: 'all' | 'pending') => commentsApi.posts(id, f).then((r) => setPosts(r.data));

  useEffect(() => {
    loadPages()
      .then((list) => {
        // no Page in the address: start on the one with the most comments waiting
        if (!pageId && list.length) go({ page: [...list].sort((a, b) => b.unanswered - a.unanswered)[0].id }, true);
      })
      .catch((e) => {
        toast.error(e.message);
        setPages([]);
      });
  }, []);

  useEffect(() => {
    if (!pageId) return;
    setPosts(null);
    loadPosts(pageId, filter).catch((e) => {
      toast.error(e.message);
      setPosts([]);
    });
  }, [pageId, filter]);

  /** Counts changed (a reply, "Đã xử lý", a refresh): the tiles and the list follow, quietly */
  const reload = () => {
    void loadPages().catch(() => {});
    if (pageId) void loadPosts(pageId, filter).catch(() => {});
  };

  async function refreshPage() {
    if (!pageId) return;
    setRefreshing(true);
    try {
      const { data } = await commentsApi.refresh(pageId);
      toast.success(`Đã làm mới ${data.synced} bài. Gợi ý AI (nếu có) sẽ hiện sau ít giây.`);
      reload();
      // AI drafts are written after the sync answers
      setTimeout(reload, 10_000);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setRefreshing(false);
    }
  }

  const current = pages?.find((p) => p.id === pageId) ?? null;
  const selected = posts?.find((p) => p.postId === postId) ?? null;

  if (pages && pages.length === 0) {
    return (
      <div className="comments-hub">
        <div className="page-header">
          <h1>Bình luận</h1>
          <p>Chưa có Page nào đang kết nối. Vào <Link to="/pages">Kênh Facebook</Link> để kết nối Page trước.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`comments-hub ${postId ? 'has-post' : ''}`}>
      <div className="page-header">
        <h1>Bình luận</h1>
        <p>Chọn Page, chọn bài, rồi đọc và trả lời bình luận ngay tại đây. Chỉ gồm các bài do app đăng.</p>
      </div>

      {current && (
        <div className="stats-grid hub-stats">
          <div className="stat-card">
            <span className="stat-label">Cần trả lời</span>
            <span className="stat-value">{current.unanswered}</span>
            <span className={`stat-change ${current.unanswered ? 'negative' : 'positive'}`}>{current.unanswered ? 'bình luận đang chờ' : 'Đã trả lời hết'}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Gợi ý AI chờ duyệt</span>
            <span className="stat-value">{current.drafts}</span>
            {current.autoReply ? (
              <span className="stat-change">AI đang soạn trả lời cho Page này</span>
            ) : (
              <Link to="/pages" className="stat-change" style={{ color: 'var(--primary-500)', fontWeight: 500 }}>Bật AI trả lời ở Kênh Facebook →</Link>
            )}
          </div>
          <div className="stat-card">
            <span className="stat-label">Bài có bình luận</span>
            <span className="stat-value">{current.postsWithComments}<small> / {current.posts}</small></span>
            <span className="stat-change">{current.comments} bình luận tất cả</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Cập nhật</span>
            <span className="stat-value hub-synced">{current.syncedAt ? formatWhen(current.syncedAt) : 'Chưa đồng bộ'}</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refreshPage()} disabled={refreshing} style={{ alignSelf: 'flex-start' }}>
              {refreshing ? <div className="spinner" /> : <RefreshCw size={14} aria-hidden="true" />} Làm mới Page
            </button>
          </div>
        </div>
      )}

      {current && !current.tokenValid && (
        <p className="comments-note">
          <AlertTriangle size={14} aria-hidden="true" /> Token của Page này chưa dùng được với Facebook App hiện tại nên bình luận không được cập nhật. <Link to="/pages">Đồng bộ Page</Link>
        </p>
      )}
      {current && current.tokenValid && !current.canRead && (
        <p className="comments-note">
          <AlertTriangle size={14} aria-hidden="true" /> Page chưa cấp quyền đọc bình luận. <Link to="/pages">Đồng bộ Page</Link> và tick đủ quyền.
        </p>
      )}

      <div className="hub-grid">
        <nav className="hub-pages card flush" aria-label="Chọn Page">
          <h2 className="hub-title">Page</h2>
          {!pages ? (
            <div className="loading-page" style={{ minHeight: 120 }}><div className="spinner" /></div>
          ) : (
            <ul>
              {pages.map((p) => (
                <li key={p.id}>
                  <button type="button" className={`hub-page ${p.id === pageId ? 'active' : ''}`} aria-current={p.id === pageId} onClick={() => go({ page: p.id, post: null })}>
                    <span className="hub-avatar" aria-hidden="true">{p.pageAvatar ? <img src={p.pageAvatar} alt="" /> : pageInitials(p.pageName)}</span>
                    <span className="hub-page-name">{p.pageName}</span>
                    {p.unanswered > 0 && <span className="nav-count" aria-label={`${p.unanswered} bình luận cần trả lời`}>{p.unanswered}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>

        <section className="hub-posts card flush" aria-label="Bài đăng của Page">
          <div className="hub-posts-head">
            <h2 className="hub-title">Bài đăng</h2>
            <div className="segmented" role="radiogroup" aria-label="Lọc bài">
              <button type="button" role="radio" aria-checked={filter === 'all'} className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
                Tất cả
              </button>
              <button type="button" role="radio" aria-checked={filter === 'pending'} className={filter === 'pending' ? 'active' : ''} onClick={() => setFilter('pending')}>
                Cần trả lời
              </button>
            </div>
          </div>
          {!pageId || !posts ? (
            <div className="loading-page" style={{ minHeight: 160 }}><div className="spinner" /></div>
          ) : posts.length === 0 ? (
            <p className="field-hint hub-empty">{filter === 'pending' ? 'Không có bài nào đang chờ trả lời bình luận.' : 'Page này chưa có bài nào do app đăng.'}</p>
          ) : (
            <ul className="hub-post-list">
              {posts.map((p) => (
                <li key={p.targetId}>
                  <button type="button" className={`hub-post ${p.postId === postId ? 'active' : ''}`} aria-current={p.postId === postId} onClick={() => go({ post: p.postId })}>
                    <PostThumb src={assetUrl(p.imageUrl)} size={44} video={p.hasVideo} />
                    <span className="hub-post-text">
                      <span className="hub-post-title">{postTitle(p.caption) || 'Bài không có chữ'}</span>
                      <span className="hub-post-meta">
                        <span>{p.publishedAt ? formatWhen(p.publishedAt) : ''}</span>
                        <span><ThumbsUp size={12} aria-hidden="true" /> {p.reactionCount ?? '–'}</span>
                        <span><MessageCircle size={12} aria-hidden="true" /> {p.commentCount ?? '–'}</span>
                        {p.draftCount > 0 && (
                          <span className="hub-drafts"><Sparkles size={12} aria-hidden="true" /> {p.draftCount} gợi ý</span>
                        )}
                      </span>
                    </span>
                    {p.unansweredCount > 0 && <span className="badge badge-ready">{p.unansweredCount} chờ</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="hub-board card" aria-label="Bình luận của bài">
          {postId && pageId ? (
            <>
              <button type="button" className="back-link hub-back" onClick={() => go({ post: null })}>
                <ArrowLeft size={15} aria-hidden="true" /> Danh sách bài
              </button>
              <div className="hub-board-head">
                <h2 className="hub-title">{selected ? postTitle(selected.caption) || 'Bài không có chữ' : 'Bình luận của bài'}</h2>
                {selected?.fbPermalink && (
                  <a href={selected.fbPermalink} target="_blank" rel="noreferrer" className="link-btn">
                    Xem trên Facebook <ExternalLink size={12} aria-hidden="true" />
                  </a>
                )}
              </div>
              {/* driven by the address, not by the list: a post that leaves the filtered list stays open while it is worked on */}
              <CommentsBoard key={`${postId}:${pageId}`} postId={postId} pageId={pageId} onChanged={reload} />
            </>
          ) : (
            <div className="hub-empty hub-choose">
              <MessageCircle size={28} strokeWidth={1.5} aria-hidden="true" />
              <p>Chọn một bài ở cột bên để xem và trả lời bình luận.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
```

`pageInitials` is already exported from `client/src/components/PostBits.tsx`; `PostThumb` takes `src`, `size` and `video`.

- [ ] **Step 3: Route and menu**

In `client/src/App.tsx`: add `import CommentsPage from './pages/CommentsPage';` after the `ReelPage` import, and before the `<Route path="*" …>` line add:

```tsx
        <Route
          path="/comments"
          element={
            <ProtectedRoute>
              <AppLayout>
                <CommentsPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
```

In `client/src/components/Sidebar.tsx`:

- Add `MessageCircle` to the existing `lucide-react` import and `commentsApi` to the existing import from `'../api'`.
- After `const [pending, setPending] = useState(0);` add:

```tsx
  /** Comments waiting for an answer, on every Page */
  const [unanswered, setUnanswered] = useState(0);
```

- In the effect that runs on `location.pathname`, after the `postsApi.list(…)` call (its whole `.then(…).catch(…)` chain) add:

```tsx
    commentsApi
      .overview()
      .then((r) => setUnanswered(r.data.pages.reduce((sum, p) => sum + p.unanswered, 0)))
      .catch(() => {});
```

- After the closing `</NavLink>` of the "Bài đăng" entry add:

```tsx
          <NavLink to="/comments" className={navClass}>
            <MessageCircle className="nav-icon" strokeWidth={1.8} />
            <span className="nav-label">Bình luận</span>
            {unanswered > 0 && (
              <span className="nav-count" aria-label={`${unanswered} bình luận cần trả lời`}>
                {unanswered}
              </span>
            )}
          </NavLink>
```

- [ ] **Step 4: Styles**

In `client/src/index.css`, after the `.comments-toolbar { … }` line added in Task 2, add:

```css
/* ─── "Bình luận" page: Pages | posts | the comments of one post ─── */
.hub-stats .stat-value small { font-size: 16px; font-weight: 500; color: var(--text-tertiary); }
.hub-stats .hub-synced { font-size: 18px; line-height: 1.6; }
.hub-grid { display: grid; grid-template-columns: 230px 340px minmax(0, 1fr); gap: 16px; align-items: start; }
.hub-title { font-size: 14px; font-weight: 600; margin: 0; }
.hub-pages, .hub-posts { position: sticky; top: 16px; max-height: calc(100vh - 32px); display: flex; flex-direction: column; min-width: 0; }
.hub-pages > .hub-title { padding: 14px 16px 8px; }
.hub-pages ul, .hub-post-list { list-style: none; margin: 0; padding: 0 8px 8px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.hub-page, .hub-post { width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px; border: none; background: none; border-radius: var(--radius-md); font: inherit; color: inherit; text-align: left; cursor: pointer; min-width: 0; }
.hub-page:hover, .hub-post:hover { background: var(--bg-tertiary); }
.hub-page.active, .hub-post.active { background: var(--primary-50, var(--bg-tertiary)); box-shadow: inset 3px 0 0 var(--primary-500); }
.hub-page:focus-visible, .hub-post:focus-visible { outline: 2px solid var(--border-focus); outline-offset: -2px; }
.hub-avatar { width: 30px; height: 30px; border-radius: 50%; background: var(--bg-tertiary); display: grid; place-items: center; font-size: 11px; font-weight: 600; flex-shrink: 0; overflow: hidden; }
.hub-avatar img { width: 100%; height: 100%; object-fit: cover; }
.hub-page-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; font-weight: 500; }
.hub-posts-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 16px 8px; flex-wrap: wrap; }
.hub-post { align-items: flex-start; }
.hub-post-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.hub-post-title { font-size: 13.5px; font-weight: 500; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.hub-post-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 12px; color: var(--text-tertiary); }
.hub-post-meta span { display: inline-flex; align-items: center; gap: 3px; }
.hub-post-meta .hub-drafts { color: var(--primary-600); font-weight: 600; }
.hub-board { min-width: 0; display: flex; flex-direction: column; gap: 14px; }
.hub-board-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.hub-board-head .hub-title { font-size: 16px; }
.hub-back { display: none; border: none; background: none; padding: 0; font: inherit; cursor: pointer; margin: 0; }
.hub-empty { padding: 16px; }
.hub-choose { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 48px 16px; color: var(--text-tertiary); text-align: center; }
.hub-choose p { margin: 0; }
@media (max-width: 1200px) {
  .hub-grid { grid-template-columns: 200px 300px minmax(0, 1fr); }
}
@media (max-width: 960px) {
  /* Steps instead of panes: Pages, then posts; a chosen post takes the screen, with a way back */
  .hub-grid { grid-template-columns: minmax(0, 1fr); }
  .hub-pages, .hub-posts { position: static; max-height: none; }
  .hub-pages ul { flex-direction: row; overflow-x: auto; padding-bottom: 10px; }
  .hub-pages li { flex-shrink: 0; }
  .hub-page { width: auto; }
  .hub-page.active { box-shadow: inset 0 -3px 0 var(--primary-500); }
  .hub-page-name { max-width: 160px; }
  .comments-hub:not(.has-post) .hub-board { display: none; }
  .comments-hub.has-post .hub-pages, .comments-hub.has-post .hub-posts, .comments-hub.has-post .hub-stats { display: none; }
  .hub-back { display: inline-flex; }
}
```

- [ ] **Step 5: Typecheck, lint, build**

Run (from `client/`): `npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b && npm run lint && npx -y -p node@22 -- node node_modules/vite/bin/vite.js build`
Expected: typecheck clean; lint shows no new kind of warning in `CommentsPage.tsx` beyond the kinds the other pages already have (`react-hooks(exhaustive-deps)`, `react(set-state-in-effect)`); build ends with `✓ built in …`.

- [ ] **Step 6: Look at it in the browser (mock API, nothing real is called)**

With the mock-API method (the mock answers `/api/comments/overview` with two Pages, `/api/comments/posts` with several posts — one of them on both Pages — and `/api/comments/refresh`, next to the comment routes it already answers), check at 1366px and 390px:

1. The menu shows "Bình luận" with the count of comments waiting; the page opens on the Page with the most comments waiting, tiles filled.
2. Choosing a Page changes the tiles and the list; the list shows posts with comments waiting first, each with its counts and "N gợi ý".
3. Choosing a post shows its comments on the right with the AI drafts in the reply boxes; replying, "Bỏ gợi ý", "Đã xử lý" and "Gửi N gợi ý" work, and after each the tiles and the list's counts change too (Review Focus 4).
4. With the list on "Cần trả lời", answering the last waiting comment of the open post removes the post from the list but leaves its comments on screen (Review Focus 1).
5. For the post that is on two Pages: under Page A only A's comments show and "Gửi N gợi ý" counts only A's drafts (Review Focus 5).
6. Reloading the browser keeps the same Page and post (the address carries them).
7. "Làm mới Page" shows the toast and reloads.
8. The comments dialog on the Posts page still works as before (same toolbar, now inside the body).
9. At 390px: Pages scroll sideways, the list is full width, choosing a post shows only its comments with "← Danh sách bài"; nothing overflows sideways.

- [ ] **Step 7: Commit**

```bash
git add client/src/api.ts client/src/pages/CommentsPage.tsx client/src/App.tsx client/src/components/Sidebar.tsx client/src/index.css
git commit -m "feat(client): the \"Bình luận\" page — Pages, posts and comments in one dashboard"
```

---

### Task 4: Docs and whole-feature verification

**Files:**
- Modify: `CLAUDE.md`, `ROADMAP.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: `CLAUDE.md`**

At the end of the bullet that starts `` - `sync_engagement` `` append (same bullet):

```markdown
 **"Bình luận" page** (`client/src/pages/CommentsPage.tsx`, route `/comments?page=&post=`): choose a Page → its published posts with counts → the comments of one post. Data: `src/routes/comments-hub.routes.ts` at `/api/comments` (`GET /overview` totals per active Page, `GET /posts?pageId=&filter=` the Page's published posts with `unansweredCount`/`draftCount`, `POST /refresh` syncs the Page's posts of the last 30 days without waiting for AI drafts); the comments themselves come from `/api/posts/:id/comments`. `client/src/components/CommentsBoard.tsx` is the one comments UI, used inline there (narrowed to a Page with `pageId`) and inside the Posts page's `CommentsPanel` dialog.
```

In the `**Client**` paragraph nothing changes.

- [ ] **Step 2: `ROADMAP.md`**

After the line that starts `- ✅ (2026-10-05) AI soạn trả lời bình luận`, add (use the real completion date):

```markdown
- ✅ (2026-10-05) Trang Bình luận: chọn Page → danh sách bài đã đăng kèm số bình luận chờ trả lời và số gợi ý AI → đọc và trả lời ngay trong trang; ô tổng quan cho từng Page, nút "Làm mới Page", huy hiệu số bình luận chờ trên menu — plan docs/superpowers/plans/2026-10-05-comments-hub.md
```

- [ ] **Step 3: Full suite**

Kill any dev server (the `tsx watch` parent too), confirm nothing listens on port 3000, make sure MariaDB is up, then run:

`npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run`
Expected: typecheck clean; every test file passes. (`tests/multi-page.db.test.ts` and `tests/schedules.db.test.ts` have each failed under parallel load before and passed alone; if only one of those fails, run the suite again and report every result.)

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md ROADMAP.md
git commit -m "docs: the Bình luận page"
```

- [ ] **Step 5: Hand over**

Tell the user what is verified and what is not (the page has only been looked at with the mock API; real Pages with real comments are theirs to try), and that merging or deploying needs their word. This branch sits on top of `feature/comment-reply-drafts`: merging it brings that work along.

---

## Out of scope

- Comments on posts not published by the app; comments older than what the sync keeps.
- Search inside comments, filters by date or by author, export.
- Hiding, deleting or liking comments.
- A view of all Pages mixed together; choosing several posts at once.
- Faster automatic sync or Facebook webhooks (the hourly sync and the two "Làm mới" buttons stay).
- Removing the comments dialog from the Posts page.
