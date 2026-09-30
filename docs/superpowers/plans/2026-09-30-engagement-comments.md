# Tương tác & bình luận Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each published post's engagement (👍 reactions · 💬 comments · ↗ shares) and a "N cần trả lời" badge in the Posts list, and let the user read a post's comments and reply as the Page from inside the app.

**Architecture:**
- **Sync job.** A keyed `sync_engagement` job runs every hour (not in tests). For posts published in the last 30 days, it:
  - reads counts for up to 50 Facebook posts per Graph call (`?ids=`);
  - fetches the latest top-level comments with their replies for posts that have comments;
  - stores the counts on `post_targets` and the comments in a new `post_comments` table.
- **Refresh.** A "Làm mới" button re-syncs one post on demand.
- **Replies** go out through Graph `POST /{comment-id}/comments` with the Page token.
- **Optional permissions.** The two new Facebook permissions are optional, so Pages without them keep posting normally:
  - `pages_read_user_content` to read comment content;
  - `pages_manage_engagement` to reply.

**Tech Stack:** Express + Prisma (MariaDB) + the MariaDB job queue; Graph API v23 through `src/lib/clients/facebook.ts`; React 19 client; Vitest (fetch stubbed, never real Facebook).

**Spec:** No separate spec file. The source is the user's choices on 2026-09-30, recorded under **Quyết định** below, plus CR/change_ui.md §10–11 (engagement display and "comment management ready"). Read both.

## Quyết định

Chosen by the user:
1. **Bình luận:** view, and reply as the Page, inside the app. No AI-suggested replies in this plan.
2. **Cập nhật:** automatically every hour, plus a "Làm mới" button per post.
3. **"Cần trả lời"** = a top-level comment from a viewer (not from the Page) that has no reply from the Page and was not marked "Đã xử lý".

Technical decisions:
4. **Permissions are optional.**
   - `REQUIRED_SCOPES` stays `pages_manage_posts, pages_read_engagement, pages_show_list`, so no Page becomes "thiếu quyền" and posting is never blocked by this feature.
   - The Facebook login (`client/src/lib/fb-sdk.ts`) also asks for `pages_read_user_content` and `pages_manage_engagement`.
   - A new `facebook_pages.grantedScopes` column (the token's scopes from the last check or sync) decides:
     - **reading comments:** needs `pages_read_user_content`. Without it, counts still show, and the comments panel says "Đồng bộ lại Page để xem bình luận".
     - **replying:** needs `pages_manage_engagement`.
   - Counts need only `pages_read_engagement`, which every Page already has. Verified with a read-only call on 2026-09-30.
5. **Which posts sync:**
   - targets that are `PUBLISHED`, have `fbPostId` and were published in the last **30 days**;
   - on an active Page with `tokenStatus = VALID`, owned by an active account.
   - One failing Page (e.g. expired token) never stops the others.
6. **Comments kept:**
   - the latest **50** top-level comments per post (newest first), each with up to **25** replies;
   - top-level comments that Facebook no longer returns (deleted or hidden) are removed on the next sync, as long as they are inside the fetched window.
   - "Page đã trả lời" = any reply whose `from.id` equals the Page's Facebook id, so a reply made directly on Facebook also clears "cần trả lời".
7. **Counts:**
   - `reactionCount`: every reaction type;
   - `commentCount`: all comments including replies (`filter(stream)`);
   - `shareCount`: 0 when Facebook omits `shares`.
   - They live on each `post_targets` row. The list sums them across Pages.
   - `unansweredCount` is recomputed from `post_comments` after every sync, reply or "Đã xử lý".
8. **"Làm mới"** is limited to once per 30 seconds per post (429 with a Vietnamese message) to stay far from Graph rate limits.
9. **Display** (CR §10–11):
   - the list row shows `👍 38 · 💬 12 · ↗ 4`, hiding zero parts and hiding the line entirely before the first sync;
   - an amber badge `3 cần trả lời` opens the comments panel;
   - the overview line adds "N bình luận cần trả lời" when above 0;
   - the ⋯ menu gains "Xem bình luận" for published posts.
10. **Schema is additive only:**
    - `facebook_pages.grantedScopes`;
    - new nullable/defaulted columns on `post_targets`;
    - the new table `post_comments`.

## Global Constraints

- UI copy, API errors and docs in Vietnamese; code and comments in English.
- Schema changes are additive only (production applies them with `prisma db push`); MariaDB.
- Every query filters by `req.user.id`; ids of another user return 404, including comment ids. Every new route goes into `ROUTE_CASES` in `tests/isolation.db.test.ts`.
- Handlers use `asyncHandler` + `createError`; input is validated with zod.
- Tests never reach real Facebook: stub `fetch` (`vi.stubGlobal`) inside each test.
- DB tests: `createTestUser()` / `cleanupTestUsers()`; stop the dev server before running them.
- New keyed system jobs are booked only when `config.env !== 'test'`; tests call the functions directly with a `where` filter.
- Client: plain CSS with existing tokens; accessible (aria labels, keyboard); works at 1400 / 1024 / 390 px without horizontal scroll.
- Public repo: stage files by name; never commit `.env*`, `prompt_creator_video.md`, `bugs/`, `CR/`; check the branch before committing.

## Review Focus

1. **A Page without the new permissions** → posting unaffected (status stays VALID), counts still sync, the comments panel explains the re-sync, and Reply returns 409 with that message instead of a Graph error. Tests in Task 1 and Task 4.
2. **One Page's token expired during the hourly sync** → the other Pages still sync, nothing throws out of the job, and the job re-books itself. Test in Task 3.
3. **A comment deleted on Facebook** → gone from the app after the next sync, and "cần trả lời" adjusts. Test in Task 3.
4. **The Page replies directly on Facebook**, not through the app → the next sync clears "cần trả lời" for that comment. Test in Task 3.
5. **Replying to or marking a comment id of another user's post** → 404, and nothing is sent to Facebook. Test in Task 4 (`ROUTE_CASES` + a body-id case).

---

### Task 1: Schema, and optional scopes recorded per Page

**Files:**
- Modify: `prisma/schema.prisma`, `src/lib/clients/facebook.ts` (scope constants), `src/lib/page-health.ts` (`TokenCheck`, `classifyToken`, `classifyInspectError`, `toData`), `src/lib/page-sync.ts` (signed preview schema and applied fields), `client/src/lib/fb-sdk.ts` (login scopes)
- Test: `tests/page-health.test.ts` (extend)

**Interfaces:**
- Produces:
  - `COMMENT_READ_SCOPE = 'pages_read_user_content'`, `COMMENT_REPLY_SCOPE = 'pages_manage_engagement'` exported from `src/lib/clients/facebook.ts`;
  - `TokenCheck.grantedScopes: string[]`;
  - `FacebookPage.grantedScopes Json?`;
  - `PostTarget.reactionCount/commentCount/shareCount Int?`, `unansweredCount Int @default(0)`, `statsSyncedAt DateTime?`, `commentsError String?`, `comments PostComment[]`;
  - model `PostComment`, table `post_comments`.

- [ ] **Step 1: Write the failing tests** (append to `tests/page-health.test.ts`; import `classifyToken` if not already imported)

```ts
describe('optional comment scopes', () => {
  const info = (scopes: string[]) => ({
    isValid: true,
    type: 'PAGE',
    appId: '111',
    expiresAt: null,
    dataAccessExpiresAt: null,
    scopes,
    missingScopes: ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list'].filter((s) => !scopes.includes(s)),
  });

  it('records the granted scopes, and missing comment scopes never block posting', () => {
    const basic = classifyToken(info(['pages_manage_posts', 'pages_read_engagement', 'pages_show_list']), '111');
    expect(basic).toMatchObject({ tokenStatus: 'VALID', grantedScopes: ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list'] });

    const full = classifyToken(info(['pages_manage_posts', 'pages_read_engagement', 'pages_show_list', 'pages_read_user_content', 'pages_manage_engagement']), '111');
    expect(full.tokenStatus).toBe('VALID');
    expect(full.grantedScopes).toContain('pages_manage_engagement');
  });
});
```

- [ ] **Step 2: Run it, see it fail**

Run: `npx vitest run tests/page-health.test.ts`
Expected: FAIL. `grantedScopes` is undefined.

- [ ] **Step 3: Code**

`src/lib/clients/facebook.ts`, after `REQUIRED_SCOPES`:

```ts
/** Optional: without them the Page still posts; the comments panel asks for a re-sync */
export const COMMENT_READ_SCOPE = 'pages_read_user_content';
export const COMMENT_REPLY_SCOPE = 'pages_manage_engagement';
```

`src/lib/page-health.ts`:
- add `grantedScopes: string[];` to `interface TokenCheck`;
- in `classifyToken`, add `grantedScopes: info.scopes,` to `base`;
- in `classifyInspectError`, add `grantedScopes: []` to `empty`;
- in `toData`, add `...(check.tokenStatus !== 'ERROR' && { grantedScopes: check.grantedScopes }),`, keeping the last known scopes when Graph could not answer.

`src/lib/page-sync.ts`:
- in the zod schema of the signed preview (next to `missingScopes: z.array(z.string()),`), add `grantedScopes: z.array(z.string()).default([]),`;
- in the applied `fields`, add `grantedScopes: p.check.grantedScopes,`.

`client/src/lib/fb-sdk.ts`:

```ts
/** Posting needs the first three; comments (read + reply) use the last two and are optional */
const SCOPES = 'pages_show_list,pages_manage_posts,pages_read_engagement,pages_read_user_content,pages_manage_engagement';
```

`prisma/schema.prisma`:

In `model FacebookPage`, after `missingScopes`:

```prisma
  grantedScopes  Json? // string[] — token scopes at the last check (optional comment scopes live here)
```

In `model PostTarget`, after `publishedAt`:

```prisma
  // Engagement (hourly sync, src/services/engagement-sync.ts); null = never synced
  reactionCount   Int?
  commentCount    Int?
  shareCount      Int?
  unansweredCount Int       @default(0)
  statsSyncedAt   DateTime?
  commentsError   String?   @db.Text
```

In `model PostTarget` relations, add `comments PostComment[]`.

New model after `PostTarget`:

```prisma
/// Comments of one published post on one Page (latest 50 top-level + their replies)
model PostComment {
  id          String    @id @default(uuid())
  targetId    String
  fbCommentId String    @unique
  parentFbId  String? // null = top-level
  authorId    String?
  authorName  String?   @db.VarChar(200)
  message     String    @db.Text
  commentedAt DateTime
  fromPage    Boolean   @default(false)
  pageReplied Boolean   @default(false) // top-level: the Page has replied (in the app or on Facebook)
  handledAt   DateTime? // marked "Đã xử lý" without a reply
  syncedAt    DateTime  @default(now())

  target PostTarget @relation(fields: [targetId], references: [id], onDelete: Cascade)

  @@index([targetId, parentFbId])
  @@map("post_comments")
}
```

- [ ] **Step 4: Apply the schema, run tests, typecheck**

Run: `npx prisma db push --skip-generate && npx prisma generate && npx vitest run tests/page-health.test.ts && npx tsc --noEmit && (cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b)`
Expected: in sync without data-loss warnings; PASS; both typechecks clean. If `page-sync` has its own tests, run `RUN_DB_TESTS=1 npx vitest run tests/page-sync.db.test.ts` too.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma src/lib/clients/facebook.ts src/lib/page-health.ts src/lib/page-sync.ts client/src/lib/fb-sdk.ts tests/page-health.test.ts
git commit -m "feat(engagement): schema for counts and comments; record optional comment scopes per Page"
```

---

### Task 2: Facebook client: engagement counts, comments, reply

**Files:**
- Modify: `src/lib/clients/facebook.ts`
- Test: `tests/facebook-engagement.test.ts` (new)

**Interfaces:**
- Produces (methods of `FacebookClient`):
  - `getEngagement(postIds: string[], pageToken: string): Promise<Record<string, PostEngagement>>`. `interface PostEngagement { reactions: number; comments: number; shares: number }`. Ids missing from the answer are left out.
  - `getComments(postId: string, pageToken: string): Promise<GraphComment[]>`. `interface GraphComment { id: string; message?: string; created_time: string; from?: { id: string; name?: string }; comments?: { data: GraphComment[] } }`.
  - `replyToComment(commentId: string, pageToken: string, message: string): Promise<{ id: string }>`, which POSTs once and is never retried.
  - `isPermissionError(error: unknown): boolean`, exported, true for `FacebookApiError` codes 10 and 200–299.

- [ ] **Step 1: Write the failing tests `tests/facebook-engagement.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { FacebookClient, FacebookApiError, isPermissionError } from '../src/lib/clients/facebook';

const TOKEN = 'EAAfaketokenengagementxxxxxxxxxxxxx';
const client = () => new FacebookClient({ appId: '123', appSecret: 'fake-secret', graphVersion: 'v23.0' }, [TOKEN]);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('FacebookClient engagement and comments', () => {
  it('getEngagement reads counts for many posts in one call, shares default to 0', async () => {
    const fetch = vi.fn(async () =>
      json({
        P_1: { id: 'P_1', reactions: { summary: { total_count: 38 } }, comments: { summary: { total_count: 12 } }, shares: { count: 4 } },
        P_2: { id: 'P_2', reactions: { summary: { total_count: 0 } }, comments: { summary: { total_count: 0 } } },
      })
    );
    vi.stubGlobal('fetch', fetch);
    const res = await client().getEngagement(['P_1', 'P_2'], TOKEN);
    expect(res).toEqual({ P_1: { reactions: 38, comments: 12, shares: 4 }, P_2: { reactions: 0, comments: 0, shares: 0 } });
    const url = new URL(String((fetch.mock.calls[0] as unknown as [string])[0]));
    expect(url.searchParams.get('ids')).toBe('P_1,P_2');
    expect(url.searchParams.get('fields')).toContain('reactions.summary(total_count)');
  });

  it('getEngagement splits more than 50 posts into several calls', async () => {
    const fetch = vi.fn(async (input: string) => {
      const ids = new URL(input).searchParams.get('ids')!.split(',');
      return json(Object.fromEntries(ids.map((id) => [id, { id, reactions: { summary: { total_count: 1 } }, comments: { summary: { total_count: 0 } } }])));
    });
    vi.stubGlobal('fetch', fetch);
    const ids = Array.from({ length: 120 }, (_, i) => `P_${i}`);
    const res = await client().getEngagement(ids, TOKEN);
    expect(Object.keys(res)).toHaveLength(120);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('getComments asks for top-level comments, newest first, with their replies', async () => {
    const fetch = vi.fn(async () => json({ data: [{ id: 'C1', message: 'Có workflow mẫu không?', created_time: '2026-09-30T01:00:00+0000', from: { id: 'U1', name: 'An' } }] }));
    vi.stubGlobal('fetch', fetch);
    const res = await client().getComments('P_1', TOKEN);
    expect(res[0].id).toBe('C1');
    const url = new URL(String((fetch.mock.calls[0] as unknown as [string])[0]));
    expect(url.pathname).toMatch(/\/P_1\/comments$/);
    expect(url.searchParams.get('filter')).toBe('toplevel');
    expect(url.searchParams.get('order')).toBe('reverse_chronological');
    expect(url.searchParams.get('fields')).toContain('comments.limit(25)');
  });

  it('replyToComment posts once and returns the new comment id', async () => {
    const fetch = vi.fn(async () => json({ id: 'C1_R1' }));
    vi.stubGlobal('fetch', fetch);
    expect(await client().replyToComment('C1', TOKEN, 'Có nhé!')).toEqual({ id: 'C1_R1' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/C1\/comments$/);
    expect(new URLSearchParams(String(init.body)).get('message')).toBe('Có nhé!');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('recognises permission errors', () => {
    expect(isPermissionError(new FacebookApiError('x', 10))).toBe(true);
    expect(isPermissionError(new FacebookApiError('x', 200))).toBe(true);
    expect(isPermissionError(new FacebookApiError('x', 190))).toBe(false);
    expect(isPermissionError(new Error('x'))).toBe(false);
  });
});
```

Before writing, check the `FacebookApiError` constructor order in `facebook.ts` (`message, code, subcode, fbtraceId, raw`) and that it is exported; adjust the test construction if the order differs.

- [ ] **Step 2: Run it, see it fail**

Run: `npx vitest run tests/facebook-engagement.test.ts`
Expected: FAIL. `getEngagement` / `isPermissionError` are not defined.

- [ ] **Step 3: Code (add to `FacebookClient` and the module in `src/lib/clients/facebook.ts`)**

```ts
export interface PostEngagement {
  reactions: number;
  comments: number;
  shares: number;
}

export interface GraphComment {
  id: string;
  message?: string;
  created_time: string;
  from?: { id: string; name?: string };
  comments?: { data: GraphComment[] };
}

/** Graph "permission" errors: code 10 and 200–299 */
export function isPermissionError(error: unknown): boolean {
  return error instanceof FacebookApiError && (error.code === 10 || (typeof error.code === 'number' && error.code >= 200 && error.code < 300));
}

const ENGAGEMENT_FIELDS = 'reactions.summary(total_count).limit(0),comments.filter(stream).summary(total_count).limit(0),shares';
const COMMENT_FIELDS = 'id,message,created_time,from{id,name}';
```

Methods inside the class:

```ts
  /** Reactions / comments / shares of many posts, 50 per call (Graph "ids" batch). */
  async getEngagement(postIds: string[], pageToken: string): Promise<Record<string, PostEngagement>> {
    const out: Record<string, PostEngagement> = {};
    for (let i = 0; i < postIds.length; i += 50) {
      const ids = postIds.slice(i, i + 50);
      const res = await this.get<Record<string, { reactions?: { summary?: { total_count?: number } }; comments?: { summary?: { total_count?: number } }; shares?: { count?: number } }>>(
        '',
        { ids: ids.join(','), fields: ENGAGEMENT_FIELDS, access_token: pageToken },
        [pageToken]
      );
      for (const id of ids) {
        const r = res[id];
        if (!r) continue;
        out[id] = { reactions: r.reactions?.summary?.total_count ?? 0, comments: r.comments?.summary?.total_count ?? 0, shares: r.shares?.count ?? 0 };
      }
    }
    return out;
  }

  /** Latest 50 top-level comments (newest first), each with up to 25 replies. */
  async getComments(postId: string, pageToken: string): Promise<GraphComment[]> {
    const res = await this.get<{ data?: GraphComment[] }>(
      `${postId}/comments`,
      { filter: 'toplevel', order: 'reverse_chronological', limit: '50', fields: `${COMMENT_FIELDS},comments.limit(25){${COMMENT_FIELDS}}`, access_token: pageToken },
      [pageToken]
    );
    return res.data ?? [];
  }

  /** Reply as the Page. Once, never retried (a blind retry could post the reply twice). */
  async replyToComment(commentId: string, pageToken: string, message: string): Promise<{ id: string }> {
    return this.postOnce<{ id: string }>(`${commentId}/comments`, new URLSearchParams({ message, access_token: pageToken }), pageToken);
  }
```

Check that `this.url('')` builds `https://graph.facebook.com/<v>/?ids=…` (read `url()` at the top of the class). If it produces a double slash or refuses an empty path, pass `'/'` or adjust `url()` minimally, and keep the test's `searchParams` assertions.

- [ ] **Step 4: Run it, see it pass**

Run: `npx vitest run tests/facebook-engagement.test.ts tests/facebook.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/clients/facebook.ts tests/facebook-engagement.test.ts
git commit -m "feat(facebook): read engagement counts in batches, read comments, reply as the Page"
```

---

### Task 3: Hourly engagement sync (counts + comments)

**Files:**
- Create: `src/services/engagement-sync.ts`
- Modify: `src/lib/job-queue.ts` (`JobType` += `'sync_engagement'`), `src/services/scheduler.service.ts` (register the handler, book the job)
- Test: `tests/engagement-sync.db.test.ts` (new)

**Interfaces:**
- Consumes: `FacebookClient.getEngagement/getComments`, `isPermissionError`, `COMMENT_READ_SCOPE` (Tasks 1–2); `getSettings`, `revealSecret`.
- Produces:
  - `ENGAGEMENT_WINDOW_DAYS = 30`; `SYNC_ENGAGEMENT_KEY = 'system:sync_engagement'`;
  - `syncTargets(targetIds: string[], now?: Date): Promise<void>`, which syncs these `post_targets` (counts + comments) grouped by Page;
  - `runEngagementSync(now?: Date, where?: Prisma.PostTargetWhereInput): Promise<void>`, for every eligible target;
  - `recountUnanswered(targetId: string): Promise<number>`;
  - `runEngagementSyncJob(): Promise<JobResult>`, which always re-books in 1 hour;
  - `bookEngagementSync(): Promise<void>`, a no-op in tests;
  - `COMMENTS_NEED_RESYNC = 'Page chưa cấp quyền đọc bình luận. Vào Kênh Facebook → Đồng bộ Page và tick đủ quyền.'`.

- [ ] **Step 1: Write the failing tests `tests/engagement-sync.db.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { encrypt } from '../src/lib/crypto';
import { saveSettings } from '../src/lib/settings';
import { runEngagementSync, COMMENTS_NEED_RESYNC } from '../src/services/engagement-sync';
import { cleanupTestUsers, createTestUser } from './helpers/users';

const READ = ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list', 'pages_read_user_content'];
let userId: string;
const now = new Date('2026-09-30T10:00:00Z');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

async function page(fbId: string, scopes = READ, extra: Record<string, unknown> = {}) {
  return prisma.facebookPage.create({
    data: { userId, pageId: fbId, pageName: `Page ${fbId}`, pageAccessToken: encrypt(`EAAtoken${fbId}xxxxxxxxxxxxxxxxxxxx`), tokenStatus: 'VALID', grantedScopes: scopes, ...extra },
  });
}
async function published(pageDbId: string, fbPostId: string, daysAgo = 1) {
  const post = await prisma.post.create({
    data: { userId, pageId: pageDbId, caption: 'x', status: 'PUBLISHED', targets: { create: { pageId: pageDbId, status: 'PUBLISHED', fbPostId, publishedAt: new Date(now.getTime() - daysAgo * 86_400_000) } } },
    include: { targets: true },
  });
  return post.targets[0];
}

/** Graph stub: counts by post id, comments by post id; tokens can be marked broken */
function graph(counts: Record<string, [number, number, number]>, comments: Record<string, unknown[]>, opts: { deniedPosts?: string[]; brokenToken?: string } = {}) {
  return vi.fn(async (input: string) => {
    const url = new URL(input);
    if (opts.brokenToken && url.searchParams.get('access_token')?.includes(opts.brokenToken)) {
      return json({ error: { message: 'Session has expired', code: 190, error_subcode: 463 } }, 400);
    }
    const ids = url.searchParams.get('ids');
    if (ids) {
      return json(Object.fromEntries(ids.split(',').filter((id) => counts[id]).map((id) => {
        const [r, c, s] = counts[id];
        return [id, { id, reactions: { summary: { total_count: r } }, comments: { summary: { total_count: c } }, ...(s ? { shares: { count: s } } : {}) }];
      })));
    }
    const postId = url.pathname.split('/').at(-2)!;
    if (opts.deniedPosts?.includes(postId)) return json({ error: { message: '(#10) Requires pages_read_user_content', code: 10 } }, 400);
    return json({ data: comments[postId] ?? [] });
  });
}

describe.skipIf(!process.env.RUN_DB_TESTS)('engagement sync', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    userId = (await createTestUser()).user.id;
    // The sync builds a FacebookClient from the user's settings (never reaches Facebook: fetch is stubbed)
    await saveSettings(userId, { fbAppId: '111', fbAppSecret: 'fake-secret-engagement' });
  });
  afterAll(async () => {
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('stores counts and comments, and knows which comments still need a reply', async () => {
    const p = await page('ES_P1');
    const t = await published(p.id, 'ES_P1_POST');
    vi.stubGlobal(
      'fetch',
      graph({ ES_P1_POST: [38, 3, 4] }, {
        ES_P1_POST: [
          { id: 'C1', message: 'Có workflow mẫu không?', created_time: '2026-09-30T08:00:00+0000', from: { id: 'U1', name: 'An' } },
          { id: 'C2', message: 'Hay quá', created_time: '2026-09-30T07:00:00+0000', from: { id: 'U2', name: 'Bình' },
            comments: { data: [{ id: 'C2_R', message: 'Cảm ơn bạn!', created_time: '2026-09-30T07:30:00+0000', from: { id: 'ES_P1', name: 'Page ES_P1' } }] } },
        ],
      })
    );
    await runEngagementSync(now, { id: t.id });
    const saved = await prisma.postTarget.findUniqueOrThrow({ where: { id: t.id }, include: { comments: { orderBy: { commentedAt: 'asc' } } } });
    expect(saved).toMatchObject({ reactionCount: 38, commentCount: 3, shareCount: 4, unansweredCount: 1, commentsError: null });
    expect(saved.comments.map((c) => [c.fbCommentId, c.fromPage, c.pageReplied])).toEqual([
      ['C2', false, true],
      ['C2_R', true, false],
      ['C1', false, false],
    ]);
  });

  it('a reply made directly on Facebook, or a deleted comment, updates "cần trả lời" on the next sync', async () => {
    const p = await page('ES_P2');
    const t = await published(p.id, 'ES_P2_POST');
    const c1 = { id: 'D1', message: 'Giá bao nhiêu?', created_time: '2026-09-30T08:00:00+0000', from: { id: 'U1', name: 'An' } };
    const c2 = { id: 'D2', message: 'Ship không?', created_time: '2026-09-30T08:05:00+0000', from: { id: 'U2', name: 'Bình' } };
    vi.stubGlobal('fetch', graph({ ES_P2_POST: [1, 2, 0] }, { ES_P2_POST: [c2, c1] }));
    await runEngagementSync(now, { id: t.id });
    expect((await prisma.postTarget.findUniqueOrThrow({ where: { id: t.id } })).unansweredCount).toBe(2);

    // Page answered D1 on Facebook; D2 was deleted
    const answered = { ...c1, comments: { data: [{ id: 'D1_R', message: 'Inbox nhé', created_time: '2026-09-30T09:00:00+0000', from: { id: 'ES_P2' } }] } };
    vi.stubGlobal('fetch', graph({ ES_P2_POST: [1, 2, 0] }, { ES_P2_POST: [answered] }));
    await runEngagementSync(new Date(now.getTime() + 3600_000), { id: t.id });
    const saved = await prisma.postTarget.findUniqueOrThrow({ where: { id: t.id }, include: { comments: true } });
    expect(saved.unansweredCount).toBe(0);
    expect(saved.comments.map((c) => c.fbCommentId).sort()).toEqual(['D1', 'D1_R']);
  });

  it('without the comment permission, counts still sync and the reason is kept', async () => {
    const p = await page('ES_P3', ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list']);
    const t = await published(p.id, 'ES_P3_POST');
    const fetch = graph({ ES_P3_POST: [5, 2, 0] }, {});
    vi.stubGlobal('fetch', fetch);
    await runEngagementSync(now, { id: t.id });
    expect(await prisma.postTarget.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ reactionCount: 5, commentCount: 2, commentsError: COMMENTS_NEED_RESYNC });
    // Comments were not even requested (scope known missing)
    expect(fetch.mock.calls.some((c) => String(c[0]).includes('/comments?'))).toBe(false);

    // Scope recorded but Facebook still refuses: same message, counts kept
    await prisma.facebookPage.update({ where: { id: p.id }, data: { grantedScopes: READ } });
    vi.stubGlobal('fetch', graph({ ES_P3_POST: [5, 2, 0] }, {}, { deniedPosts: ['ES_P3_POST'] }));
    await runEngagementSync(now, { id: t.id });
    expect(await prisma.postTarget.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ reactionCount: 5, commentsError: COMMENTS_NEED_RESYNC });
  });

  it('one Page with an expired token does not stop the others', async () => {
    const bad = await page('ES_BAD');
    const good = await page('ES_GOOD');
    const tb = await published(bad.id, 'ES_BAD_POST');
    const tg = await published(good.id, 'ES_GOOD_POST');
    vi.stubGlobal('fetch', graph({ ES_BAD_POST: [9, 0, 0], ES_GOOD_POST: [7, 0, 0] }, {}, { brokenToken: 'ES_BAD' }));
    await expect(runEngagementSync(now, { id: { in: [tb.id, tg.id] } })).resolves.toBeUndefined();
    expect((await prisma.postTarget.findUniqueOrThrow({ where: { id: tg.id } })).reactionCount).toBe(7);
    expect((await prisma.postTarget.findUniqueOrThrow({ where: { id: tb.id } })).reactionCount).toBeNull();
  });

  it('skips posts older than 30 days and Pages that cannot post', async () => {
    const p = await page('ES_OLD');
    const old = await published(p.id, 'ES_OLD_POST', 45);
    const off = await page('ES_OFF', READ, { tokenStatus: 'EXPIRED' });
    const t2 = await published(off.id, 'ES_OFF_POST');
    const fetch = graph({ ES_OLD_POST: [1, 0, 0], ES_OFF_POST: [1, 0, 0] }, {});
    vi.stubGlobal('fetch', fetch);
    await runEngagementSync(now, { id: { in: [old.id, t2.id] } });
    expect(fetch).not.toHaveBeenCalled();
  });
});
```

Before writing, check that `encrypt` is exported from `src/lib/crypto.ts` and that `revealSecret` (settings) decrypts it. Other DB tests use plain `'EAA…'` strings, so check whether `revealSecret` accepts plain text too; either form works as long as the stub matches on the token substring.

- [ ] **Step 2: Run it, see it fail**

Run: `RUN_DB_TESTS=1 npx vitest run tests/engagement-sync.db.test.ts`
Expected: FAIL. Cannot find module `engagement-sync`.

- [ ] **Step 3: `src/services/engagement-sync.ts`**

```ts
import type { Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { logger } from '../utils/logger';
import { config } from '../config';
import { getSettings, revealSecret } from '../lib/settings';
import { upsertKeyedJob, type JobResult } from '../lib/job-queue';
import { COMMENT_READ_SCOPE, FacebookClient, isPermissionError, type GraphComment } from '../lib/clients/facebook';
import { toStringArray } from '../utils/json';

/** Reactions / comments / shares and the comments themselves, for posts published in the last 30 days. */

export const ENGAGEMENT_WINDOW_DAYS = 30;
export const SYNC_ENGAGEMENT_KEY = 'system:sync_engagement';
const SYNC_EVERY_MS = 60 * 60_000;
export const COMMENTS_NEED_RESYNC = 'Page chưa cấp quyền đọc bình luận. Vào Kênh Facebook → Đồng bộ Page và tick đủ quyền.';

/** Top-level, from a viewer, no Page reply, not marked handled */
export async function recountUnanswered(targetId: string): Promise<number> {
  const unanswered = await prisma.postComment.count({ where: { targetId, parentFbId: null, fromPage: false, pageReplied: false, handledAt: null } });
  await prisma.postTarget.update({ where: { id: targetId }, data: { unansweredCount: unanswered } });
  return unanswered;
}

async function storeComments(targetId: string, pageFbId: string, comments: GraphComment[], now: Date): Promise<void> {
  const seen: string[] = [];
  for (const c of comments) {
    const replies = c.comments?.data ?? [];
    const rows = [
      { c, parent: null as string | null, pageReplied: replies.some((r) => r.from?.id === pageFbId) },
      ...replies.map((r) => ({ c: r, parent: c.id, pageReplied: false })),
    ];
    for (const { c: row, parent, pageReplied } of rows) {
      seen.push(row.id);
      const data = {
        parentFbId: parent,
        authorId: row.from?.id ?? null,
        authorName: row.from?.name?.slice(0, 200) ?? null,
        message: row.message ?? '',
        commentedAt: new Date(row.created_time),
        fromPage: row.from?.id === pageFbId,
        pageReplied,
        syncedAt: now,
      };
      await prisma.postComment.upsert({ where: { fbCommentId: row.id }, create: { targetId, fbCommentId: row.id, ...data }, update: data });
    }
  }
  // Gone from Facebook (deleted/hidden) inside the fetched window → gone here too
  const oldest = comments.length ? new Date(comments[comments.length - 1].created_time) : null;
  await prisma.postComment.deleteMany({
    where: {
      targetId,
      fbCommentId: { notIn: seen.length ? seen : ['-'] },
      ...(oldest && comments.length >= 50 ? { OR: [{ parentFbId: { not: null } }, { commentedAt: { gte: oldest } }] } : {}),
    },
  });
}

/** Sync these targets: counts for all, comments for those that have any. Grouped by Page; one Page failing never stops the others. */
export async function syncTargets(targetIds: string[], now = new Date()): Promise<void> {
  const targets = await prisma.postTarget.findMany({
    where: { id: { in: targetIds }, fbPostId: { not: null } },
    include: { page: true },
  });
  const byPage = new Map<string, typeof targets>();
  for (const t of targets) byPage.set(t.pageId, [...(byPage.get(t.pageId) ?? []), t]);

  for (const group of byPage.values()) {
    const page = group[0].page;
    try {
      const settings = await getSettings(page.userId);
      const token = revealSecret(page.pageAccessToken);
      const fb = new FacebookClient({ appId: settings.fbAppId, appSecret: settings.fbAppSecret, graphVersion: settings.fbGraphVersion }, [token]);
      const counts = await fb.getEngagement(group.map((t) => t.fbPostId!), token);
      const canRead = toStringArray(page.grantedScopes).includes(COMMENT_READ_SCOPE);

      for (const t of group) {
        const c = counts[t.fbPostId!];
        let commentsError: string | null = null;
        if (c && c.comments > 0) {
          if (!canRead) commentsError = COMMENTS_NEED_RESYNC;
          else {
            try {
              await storeComments(t.id, page.pageId, await fb.getComments(t.fbPostId!, token), now);
            } catch (error) {
              if (!isPermissionError(error)) throw error;
              commentsError = COMMENTS_NEED_RESYNC;
            }
          }
        } else if (c) {
          await prisma.postComment.deleteMany({ where: { targetId: t.id } }); // no comments left
        }
        await prisma.postTarget.update({
          where: { id: t.id },
          data: c ? { reactionCount: c.reactions, commentCount: c.comments, shareCount: c.shares, statsSyncedAt: now, commentsError } : { statsSyncedAt: now },
        });
        await recountUnanswered(t.id);
      }
    } catch (error) {
      logger.warn('[Engagement] Page sync failed', { pageId: page.id, error: (error as Error).message });
    }
  }
}

/** Every eligible target: published ≤ 30 days ago, on an active VALID Page of an active account. */
export async function runEngagementSync(now = new Date(), where: Prisma.PostTargetWhereInput = {}): Promise<void> {
  const since = new Date(now.getTime() - ENGAGEMENT_WINDOW_DAYS * 86_400_000);
  const targets = await prisma.postTarget.findMany({
    where: {
      ...where,
      status: 'PUBLISHED',
      fbPostId: { not: null },
      publishedAt: { gte: since },
      page: { isActive: true, tokenStatus: 'VALID', user: { isActive: true } },
    },
    select: { id: true },
  });
  if (targets.length) await syncTargets(targets.map((t) => t.id), now);
}

export async function runEngagementSyncJob(): Promise<JobResult> {
  try {
    await runEngagementSync();
  } catch (error) {
    logger.error('[Engagement] Sync failed', { error: (error as Error).message });
  }
  return { rescheduleAt: new Date(Date.now() + SYNC_EVERY_MS) };
}

/** One pending hourly sync (not in tests: DB test files share the database). */
export async function bookEngagementSync(): Promise<void> {
  if (config.env === 'test') return;
  const existing = await prisma.job.findUnique({ where: { key: SYNC_ENGAGEMENT_KEY } });
  if (existing && (existing.status === 'PENDING' || existing.status === 'RUNNING')) return;
  await upsertKeyedJob(SYNC_ENGAGEMENT_KEY, 'sync_engagement', {}, new Date(Date.now() + 60_000));
}
```

Check the Prisma relation name from `FacebookPage` to `User` (`user`) and adjust the `where` if it differs.

`src/lib/job-queue.ts`: add `| 'sync_engagement'` to `JobType`.

`src/services/scheduler.service.ts`:
- import `{ bookEngagementSync, runEngagementSyncJob } from './engagement-sync'`;
- in `startWorkers`, add `void bookEngagementSync().catch((e) => logger.error('[Engagement] Could not book the sync', { error: (e as Error).message }));`;
- add `sync_engagement: runEngagementSyncJob,` to the handler map;
- add to the header comment: `* - sync_engagement: every hour, reactions/comments/shares + comments of recent posts`.

- [ ] **Step 4: Run it, see it pass; the worker suites must stay green**

Run: `RUN_DB_TESTS=1 npx vitest run tests/engagement-sync.db.test.ts tests/multi-page.db.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/engagement-sync.ts src/lib/job-queue.ts src/services/scheduler.service.ts tests/engagement-sync.db.test.ts
git commit -m "feat(engagement): hourly sync of counts and comments for recent posts"
```

---

### Task 4: API: counts in the list, comments, reply, "Đã xử lý", refresh

**Files:**
- Create: `src/routes/comments.routes.ts` (mounted at `/api/posts`, after the posts router)
- Modify: `src/app.ts` (`API_ROUTERS`), `src/routes/posts.routes.ts` (list `targets` select), `tests/isolation.db.test.ts`
- Test: `tests/comments.db.test.ts` (new)

**Interfaces:**
- Consumes: `syncTargets`, `recountUnanswered`, `COMMENTS_NEED_RESYNC` (Task 3); `FacebookClient.replyToComment`, `COMMENT_READ_SCOPE`, `COMMENT_REPLY_SCOPE` (Tasks 1–2).
- Produces:
  - `GET /api/posts`: each target also has `reactionCount, commentCount, shareCount, unansweredCount, statsSyncedAt`.
  - `GET /api/posts/:id/comments` → `{ pages: Array<{ targetId, page: { id, pageName }, canRead: boolean, canReply: boolean, commentsError: string | null, statsSyncedAt: string | null, reactionCount, commentCount, shareCount, unansweredCount, threads: Array<Comment & { needsReply: boolean; replies: Comment[] }> }> }`. `Comment = { id, fbCommentId, authorName, message, commentedAt, fromPage, handledAt }`. Threads are sorted with needs-reply first, then newest.
  - `POST /api/posts/:id/comments/refresh` → the same body. 429 if synced less than 30 s ago.
  - `POST /api/posts/:id/comments/:commentId/reply` `{ message: 1..2000 }` → the same body. 409 without `pages_manage_engagement`.
  - `PATCH /api/posts/:id/comments/:commentId` `{ handled: boolean }` → the same body.
  - `:commentId` is the app's `PostComment.id` (uuid), never a Facebook id from the client.

- [ ] **Step 1: Write the failing tests `tests/comments.db.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { encrypt } from '../src/lib/crypto';
import { saveSettings } from '../src/lib/settings';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;
const ALL = ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list', 'pages_read_user_content', 'pages_manage_engagement'];

async function setup(scopes = ALL) {
  const { user, cookie } = await createTestUser();
  await saveSettings(user.id, { fbAppId: '111', fbAppSecret: 'fake-secret-comments' });
  const page = await prisma.facebookPage.create({
    data: { userId: user.id, pageId: `CM_${Date.now()}_${Math.random()}`, pageName: 'Nhà nông', pageAccessToken: encrypt('EAAtokencommentsxxxxxxxxxxxxxxxxxxx'), tokenStatus: 'VALID', grantedScopes: scopes },
  });
  const post = await prisma.post.create({
    data: {
      userId: user.id,
      pageId: page.id,
      caption: 'x',
      status: 'PUBLISHED',
      targets: { create: { pageId: page.id, status: 'PUBLISHED', fbPostId: 'CM_POST', publishedAt: new Date(), reactionCount: 3, commentCount: 1, shareCount: 0, unansweredCount: 1, statsSyncedAt: new Date(Date.now() - 3600_000) } },
    },
    include: { targets: true },
  });
  const comment = await prisma.postComment.create({
    data: { targetId: post.targets[0].id, fbCommentId: `C_${Math.random()}`, authorName: 'An', message: 'Có workflow mẫu không?', commentedAt: new Date() },
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
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'REPLY_1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const res = await api(server.baseUrl, 'POST', `/api/posts/${post.id}/comments/${comment.id}/reply`, { cookie, body: { message: 'Có nhé, workflow cơ bản là…' } });
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String((fetch.mock.calls[0] as unknown as [string])[0])).toContain(`/${comment.fbCommentId}/comments`);
    const thread = res.json.data.pages[0].threads[0];
    expect(thread).toMatchObject({ needsReply: false });
    expect(thread.replies[0]).toMatchObject({ fromPage: true, message: 'Có nhé, workflow cơ bản là…' });
    expect(res.json.data.pages[0].unansweredCount).toBe(0);
  });

  it('without the reply permission: 409 in Vietnamese, nothing sent', async () => {
    const { cookie, post, comment } = await setup(ALL.filter((s) => s !== 'pages_manage_engagement'));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
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
    const { cookie, post } = await setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        new URL(input).searchParams.get('ids')
          ? new Response(JSON.stringify({ CM_POST: { id: 'CM_POST', reactions: { summary: { total_count: 9 } }, comments: { summary: { total_count: 0 } } } }), { status: 200 })
          : new Response(JSON.stringify({ data: [] }), { status: 200 })
      )
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
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const res = await api(server.baseUrl, 'POST', `/api/posts/${mine.post.id}/comments/${other.comment.id}/reply`, { cookie: mine.cookie, body: { message: 'x' } });
    expect(res.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it, see it fail**

Run: `RUN_DB_TESTS=1 npx vitest run tests/comments.db.test.ts`
Expected: FAIL (404 on the new routes; list targets lack counts).

- [ ] **Step 3: Code**

`src/routes/posts.routes.ts`, list `targets.select`: add `reactionCount: true, commentCount: true, shareCount: true, unansweredCount: true, statsSyncedAt: true,`.

`src/routes/comments.routes.ts`:

```ts
import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { getSettings, revealSecret } from '../lib/settings';
import { toStringArray } from '../utils/json';
import { COMMENT_READ_SCOPE, COMMENT_REPLY_SCOPE, FacebookClient } from '../lib/clients/facebook';
import { recountUnanswered, syncTargets } from '../services/engagement-sync';

/** Comments of a published post: read, reply as the Page, mark handled, refresh (mounted at /api/posts). */

const router = Router();
router.use(authenticate);

const REFRESH_WAIT_MS = 30_000;
const commentSelect = { id: true, fbCommentId: true, parentFbId: true, authorName: true, message: true, commentedAt: true, fromPage: true, pageReplied: true, handledAt: true } as const;

async function ownPost(req: AuthRequest) {
  const post = await prisma.post.findFirst({ where: { id: req.params.id, userId: req.user!.id }, select: { id: true } });
  if (!post) throw createError(404, 'Post not found');
  return post;
}

async function view(postId: string) {
  const targets = await prisma.postTarget.findMany({
    where: { postId, fbPostId: { not: null } },
    orderBy: { createdAt: 'asc' },
    include: { page: { select: { id: true, pageName: true, grantedScopes: true } }, comments: { select: commentSelect, orderBy: { commentedAt: 'desc' } } },
  });
  return {
    pages: targets.map((t) => {
      const scopes = toStringArray(t.page.grantedScopes);
      const top = t.comments.filter((c) => !c.parentFbId);
      const threads = top
        .map((c) => ({
          ...c,
          needsReply: !c.fromPage && !c.pageReplied && !c.handledAt,
          replies: t.comments.filter((r) => r.parentFbId === c.fbCommentId).sort((a, b) => a.commentedAt.getTime() - b.commentedAt.getTime()),
        }))
        .sort((a, b) => Number(b.needsReply) - Number(a.needsReply) || b.commentedAt.getTime() - a.commentedAt.getTime());
      return {
        targetId: t.id,
        page: { id: t.page.id, pageName: t.page.pageName },
        canRead: scopes.includes(COMMENT_READ_SCOPE) && !t.commentsError,
        canReply: scopes.includes(COMMENT_REPLY_SCOPE),
        commentsError: t.commentsError,
        statsSyncedAt: t.statsSyncedAt,
        reactionCount: t.reactionCount,
        commentCount: t.commentCount,
        shareCount: t.shareCount,
        unansweredCount: t.unansweredCount,
        threads,
      };
    }),
  };
}

/** The comment must belong to this post, which belongs to the caller (404 otherwise) */
async function ownComment(req: AuthRequest) {
  const post = await ownPost(req);
  const comment = await prisma.postComment.findFirst({
    where: { id: req.params.commentId, target: { postId: post.id, post: { userId: req.user!.id } } },
    include: { target: { include: { page: true } } },
  });
  if (!comment) throw createError(404, 'Không tìm thấy bình luận.');
  return { post, comment };
}

router.get(
  '/:id/comments',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await ownPost(req);
    res.json({ success: true, data: await view(post.id) });
  })
);

router.post(
  '/:id/comments/refresh',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await ownPost(req);
    const targets = await prisma.postTarget.findMany({ where: { postId: post.id, fbPostId: { not: null } }, select: { id: true, statsSyncedAt: true } });
    if (!targets.length) throw createError(400, 'Bài chưa được đăng lên Page nào.');
    const recent = targets.every((t) => t.statsSyncedAt && Date.now() - t.statsSyncedAt.getTime() < REFRESH_WAIT_MS);
    if (recent) throw createError(429, 'Vừa làm mới xong, thử lại sau ít giây.');
    await syncTargets(targets.map((t) => t.id));
    res.json({ success: true, data: await view(post.id) });
  })
);

router.post(
  '/:id/comments/:commentId/reply',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { message } = z.object({ message: z.string().trim().min(1, 'Nhập nội dung trả lời').max(2000, 'Tối đa 2000 ký tự') }).parse(req.body);
    const { post, comment } = await ownComment(req);
    const page = comment.target.page;
    if (!toStringArray(page.grantedScopes).includes(COMMENT_REPLY_SCOPE)) {
      throw createError(409, 'Page chưa cấp quyền trả lời bình luận. Vào Kênh Facebook → Đồng bộ Page và tick quyền quản lý bình luận.');
    }
    const settings = await getSettings(req.user!.id);
    const token = revealSecret(page.pageAccessToken);
    const fb = new FacebookClient({ appId: settings.fbAppId, appSecret: settings.fbAppSecret, graphVersion: settings.fbGraphVersion }, [token]);
    let reply;
    try {
      reply = await fb.replyToComment(comment.fbCommentId, token, message);
    } catch (error) {
      throw createError(502, `Facebook chưa nhận câu trả lời: ${(error as Error).message}`);
    }
    // A reply always answers the top-level comment of its thread
    const topFbId = comment.parentFbId ?? comment.fbCommentId;
    await prisma.postComment.create({
      data: { targetId: comment.targetId, fbCommentId: reply.id, parentFbId: topFbId, authorId: page.pageId, authorName: page.pageName.slice(0, 200), message, commentedAt: new Date(), fromPage: true },
    });
    await prisma.postComment.updateMany({ where: { fbCommentId: topFbId }, data: { pageReplied: true } });
    await recountUnanswered(comment.targetId);
    res.json({ success: true, data: await view(post.id) });
  })
);

router.patch(
  '/:id/comments/:commentId',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { handled } = z.object({ handled: z.boolean() }).parse(req.body);
    const { post, comment } = await ownComment(req);
    await prisma.postComment.update({ where: { id: comment.id }, data: { handledAt: handled ? new Date() : null } });
    await recountUnanswered(comment.targetId);
    res.json({ success: true, data: await view(post.id) });
  })
);

export default router;
```

`src/app.ts`: import `commentsRoutes from './routes/comments.routes'` and add `['/api/posts', commentsRoutes],` right after the posts entry in `API_ROUTERS`. Check that `listApiRoutes()` in the isolation test reports these paths as `/api/posts/:id/comments…`.

`tests/isolation.db.test.ts`:
- `ROUTE_CASES`:

```ts
  'GET /api/posts/:id/comments': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/comments` },
  'POST /api/posts/:id/comments/refresh': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/comments/refresh` },
  'POST /api/posts/:id/comments/:commentId/reply': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/comments/${b.commentId}/reply`, body: { message: 'hack' } },
  'PATCH /api/posts/:id/comments/:commentId': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/comments/${b.commentId}`, body: { handled: true } },
```

- Add `commentId: string` to `Ids`. In `beforeAll`, give B's post target a `postComment` (`fbCommentId: 'ISO_B_COMMENT', message: \`${B_MARK} bình luận\`, commentedAt: new Date()`) and set `commentId`. B's target needs a `fbPostId` for the comment to be reachable; set `fbPostId: 'ISO_B_FB'` on it.

- [ ] **Step 4: Run it, see it pass**

Run: `RUN_DB_TESTS=1 npx vitest run tests/comments.db.test.ts tests/isolation.db.test.ts tests/posts-list.db.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean. `posts-list.db.test.ts` compares targets with `arrayContaining` of exact objects, so update its expected objects to include the new fields as `expect.objectContaining({...})` if it fails on the extra keys.

- [ ] **Step 5: Commit**

```bash
git add src/routes/comments.routes.ts src/app.ts src/routes/posts.routes.ts tests/comments.db.test.ts tests/isolation.db.test.ts tests/posts-list.db.test.ts
git commit -m "feat(engagement): comments API — view, reply as the Page, mark handled, refresh; counts in the posts list"
```

---

### Task 5: Client: engagement on rows, overview, comments panel

**Files:**
- Modify: `client/src/api.ts`, `client/src/lib/post-display.ts`, `client/src/components/PostListItem.tsx`, `client/src/pages/PostsPage.tsx`, `client/src/index.css`
- Create: `client/src/components/CommentsPanel.tsx`
- Test: `tests/post-display.test.ts` (extend)

**Interfaces:**
- Consumes: the Task 4 routes.
- Produces:
  - `TargetSummary` gains optional `reactionCount?, commentCount?, shareCount?: number | null; unansweredCount?: number`;
  - `engagementTotals(targets?: TargetSummary[]): { reactions: number; comments: number; shares: number; unanswered: number; synced: boolean }`;
  - `postsApi.comments(id)`, `refreshComments(id)`, `replyComment(id, commentId, message)`, `markHandled(id, commentId, handled)`, all returning `{ pages: CommentsPage[] }`;
  - `<CommentsPanel postId onClose onChanged />`.

- [ ] **Step 1: Failing test (append to `tests/post-display.test.ts`)**

```ts
import { engagementTotals } from '../client/src/lib/post-display';

describe('engagementTotals', () => {
  it('sums every Page, and says whether anything was synced yet', () => {
    expect(
      engagementTotals([
        { status: 'PUBLISHED', reactionCount: 30, commentCount: 10, shareCount: 4, unansweredCount: 2 },
        { status: 'PUBLISHED', reactionCount: 8, commentCount: 2, shareCount: null, unansweredCount: 1 },
      ])
    ).toEqual({ reactions: 38, comments: 12, shares: 4, unanswered: 3, synced: true });
    expect(engagementTotals([{ status: 'PUBLISHED' }])).toEqual({ reactions: 0, comments: 0, shares: 0, unanswered: 0, synced: false });
    expect(engagementTotals(undefined).synced).toBe(false);
  });
});
```

(Merge the import into the existing import block of the file.)

- [ ] **Step 2: Run it, see it fail**

Run: `npx vitest run tests/post-display.test.ts`
Expected: FAIL. `engagementTotals` is not a function.

- [ ] **Step 3: Code**

`client/src/lib/post-display.ts`: extend `TargetSummary`:

```ts
  reactionCount?: number | null;
  commentCount?: number | null;
  shareCount?: number | null;
  unansweredCount?: number;
```

and add:

```ts
/** Engagement of a post over all its Pages; synced = at least one Page has counts */
export function engagementTotals(targets: TargetSummary[] | undefined) {
  const t = targets ?? [];
  return {
    reactions: t.reduce((s, x) => s + (x.reactionCount ?? 0), 0),
    comments: t.reduce((s, x) => s + (x.commentCount ?? 0), 0),
    shares: t.reduce((s, x) => s + (x.shareCount ?? 0), 0),
    unanswered: t.reduce((s, x) => s + (x.unansweredCount ?? 0), 0),
    synced: t.some((x) => x.reactionCount != null),
  };
}
```

`client/src/api.ts`, types plus four `postsApi` methods:

```ts
export interface PostCommentRow {
  id: string;
  fbCommentId: string;
  authorName: string | null;
  message: string;
  commentedAt: string;
  fromPage: boolean;
  handledAt: string | null;
}

export interface CommentThread extends PostCommentRow {
  needsReply: boolean;
  replies: PostCommentRow[];
}

export interface CommentsPage {
  targetId: string;
  page: { id: string; pageName: string };
  canRead: boolean;
  canReply: boolean;
  commentsError: string | null;
  statsSyncedAt: string | null;
  reactionCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
  unansweredCount: number;
  threads: CommentThread[];
}
```

Inside `postsApi`:

```ts
  comments: (id: string) => apiFetch<{ pages: CommentsPage[] }>(`/posts/${id}/comments`),
  refreshComments: (id: string) => apiFetch<{ pages: CommentsPage[] }>(`/posts/${id}/comments/refresh`, { method: 'POST' }),
  replyComment: (id: string, commentId: string, message: string) =>
    apiFetch<{ pages: CommentsPage[] }>(`/posts/${id}/comments/${commentId}/reply`, { method: 'POST', body: JSON.stringify({ message }) }),
  markHandled: (id: string, commentId: string, handled: boolean) =>
    apiFetch<{ pages: CommentsPage[] }>(`/posts/${id}/comments/${commentId}`, { method: 'PATCH', body: JSON.stringify({ handled }) }),
```

`client/src/components/CommentsPanel.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { X, RefreshCw, Check, Undo2, AlertTriangle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { postsApi, type CommentsPage, type CommentThread } from '../api';
import { useToast } from './Toast';
import { formatWhen } from './PostBits';

interface Props {
  postId: string;
  onClose: () => void;
  /** Counts changed (reply, handled, refresh): the list reloads */
  onChanged: () => void;
}

/** Comments of one published post, by Page: needs-reply first, reply as the Page, mark handled. */
export default function CommentsPanel({ postId, onClose, onChanged }: Props) {
  const toast = useToast();
  const [pages, setPages] = useState<CommentsPage[] | null>(null);
  const [onlyPending, setOnlyPending] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    postsApi.comments(postId).then((r) => setPages(r.data.pages)).catch((e) => toast.error(e.message));
  }, [postId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function run(key: string, action: () => Promise<{ data: { pages: CommentsPage[] } }>, done?: string) {
    setBusy(key);
    try {
      const res = await action();
      setPages(res.data.pages);
      onChanged();
      if (done) toast.success(done);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  const pending = (pages ?? []).reduce((s, p) => s + p.unansweredCount, 0);
  const synced = (pages ?? []).map((p) => p.statsSyncedAt).filter(Boolean).sort().pop() ?? null;

  function thread(p: CommentsPage, t: CommentThread) {
    return (
      <li key={t.id} className={`comment-thread ${t.needsReply ? 'pending' : ''}`}>
        <div className="comment-head">
          <strong>{t.authorName ?? 'Người xem'}</strong>
          <span className="muted">{formatWhen(t.commentedAt)}</span>
          {t.needsReply && <span className="badge badge-ready">Cần trả lời</span>}
        </div>
        <p className="comment-body">{t.message || <em className="muted">(bình luận không có chữ)</em>}</p>
        {t.replies.map((r) => (
          <div key={r.id} className={`comment-reply ${r.fromPage ? 'from-page' : ''}`}>
            <strong>{r.fromPage ? p.page.pageName : (r.authorName ?? 'Người xem')}</strong> <span className="muted">{formatWhen(r.commentedAt)}</span>
            <p className="comment-body">{r.message}</p>
          </div>
        ))}
        <div className="comment-actions">
          {p.canReply ? (
            <>
              <textarea
                className="form-textarea"
                rows={2}
                maxLength={2000}
                aria-label={`Trả lời ${t.authorName ?? 'bình luận'}`}
                placeholder="Trả lời bằng tên Page…"
                value={drafts[t.id] ?? ''}
                onChange={(e) => setDrafts({ ...drafts, [t.id]: e.target.value })}
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!drafts[t.id]?.trim() || busy === t.id}
                onClick={() =>
                  run(t.id, () => postsApi.replyComment(postId, t.id, drafts[t.id]!.trim()), 'Đã trả lời trên Facebook.').then(() => setDrafts((d) => ({ ...d, [t.id]: '' })))
                }
              >
                {busy === t.id ? <div className="spinner" /> : 'Trả lời'}
              </button>
            </>
          ) : null}
          {!t.fromPage && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy === `h${t.id}`}
              onClick={() => run(`h${t.id}`, () => postsApi.markHandled(postId, t.id, !t.handledAt))}
            >
              {t.handledAt ? <><Undo2 size={14} aria-hidden="true" /> Bỏ đánh dấu</> : <><Check size={14} aria-hidden="true" /> Đã xử lý</>}
            </button>
          )}
        </div>
      </li>
    );
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-panel comments-panel" role="dialog" aria-modal="true" aria-labelledby="comments-title">
        <header className="modal-head">
          <div>
            <h2 id="comments-title">Bình luận</h2>
            <p className="field-hint" style={{ margin: 0 }}>
              {pending ? `${pending} cần trả lời` : 'Không có bình luận chờ trả lời'} · {synced ? `cập nhật ${formatWhen(synced)}` : 'chưa đồng bộ'}
            </p>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy === 'refresh'} onClick={() => run('refresh', () => postsApi.refreshComments(postId), 'Đã làm mới.')}>
              {busy === 'refresh' ? <div className="spinner" /> : <RefreshCw size={14} aria-hidden="true" />} Làm mới
            </button>
            <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Đóng">
              <X size={20} />
            </button>
          </div>
        </header>
        <div className="comments-body">
          <div className="segmented" role="radiogroup" aria-label="Lọc bình luận">
            <button type="button" role="radio" aria-checked={onlyPending} className={onlyPending ? 'active' : ''} onClick={() => setOnlyPending(true)}>Cần trả lời</button>
            <button type="button" role="radio" aria-checked={!onlyPending} className={!onlyPending ? 'active' : ''} onClick={() => setOnlyPending(false)}>Tất cả</button>
          </div>
          {!pages ? (
            <div className="loading-page"><div className="spinner spinner-lg" /></div>
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
                  {shown.length ? <ul className="comment-list">{shown.map((t) => thread(p, t))}</ul> : <p className="field-hint">{onlyPending ? 'Không có bình luận chờ trả lời.' : 'Chưa có bình luận.'}</p>}
                </section>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
```

`client/src/components/PostListItem.tsx`:
- import `engagementTotals`;
- add an optional prop `onComments?: () => void`;
- compute `const eng = engagementTotals(p.targets);`;
- replace the `post-item-stats` comment with:

```tsx
        {eng.synced && (eng.reactions || eng.comments || eng.shares || eng.unanswered) ? (
          <span className="post-item-stats">
            {[eng.reactions && `👍 ${eng.reactions}`, eng.comments && `💬 ${eng.comments}`, eng.shares && `↗ ${eng.shares}`].filter(Boolean).join(' · ')}
            {eng.unanswered > 0 && (
              <button type="button" className="badge badge-ready unanswered-badge" onClick={(e) => { e.stopPropagation(); onComments?.(); }} aria-label={`${eng.unanswered} bình luận cần trả lời — mở bình luận`}>
                {eng.unanswered} cần trả lời
              </button>
            )}
          </span>
        ) : null}
```

`client/src/pages/PostsPage.tsx`:
- import `CommentsPanel`, `MessageCircle` (lucide) and `engagementTotals`;
- add `const [commentsFor, setCommentsFor] = useState<string | null>(null);`;
- overview: compute `const pendingComments = useMemo(() => filtered.reduce((s, p) => s + engagementTotals(p.targets).unanswered, 0), [filtered]);` and add `{pendingComments > 0 && <span className="attention"><strong>{pendingComments}</strong> bình luận cần trả lời</span>}`;
- `rowActions`: when `(p.targets ?? []).some((t) => t.status === 'PUBLISHED')`, add after "Xem trên Facebook": `{ key: 'comments', label: 'Xem bình luận', icon: <MessageCircle size={15} aria-hidden="true" />, onSelect: () => setCommentsFor(p.id) }`;
- pass `onComments={() => setCommentsFor(p.id)}` to `PostListItem`;
- render `{commentsFor && <CommentsPanel postId={commentsFor} onClose={() => setCommentsFor(null)} onChanged={() => void load()} />}` next to `EditPostModal`.

CSS (append to `client/src/index.css`):

```css
/* ─── Engagement + comments ─── */
.post-item-stats { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.unanswered-badge { border: 0; cursor: pointer; }
.comments-panel { max-width: 720px; width: 100%; }
.comments-body { padding: 16px 24px 24px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
.comments-page h3 { font-size: 14px; margin: 0 0 8px; }
.comments-note { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 13px; color: var(--warning-400); background: var(--warning-bg); border-radius: var(--radius-md); padding: 8px 10px; margin: 0 0 8px; }
.comment-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.comment-thread { border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 10px 12px; }
.comment-thread.pending { border-color: color-mix(in srgb, var(--warning-500) 35%, transparent); }
.comment-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.comment-body { margin: 4px 0 0; font-size: 13.5px; white-space: pre-wrap; overflow-wrap: anywhere; }
.comment-reply { margin: 8px 0 0 16px; padding-left: 10px; border-left: 2px solid var(--border-subtle); font-size: 13px; }
.comment-reply.from-page { border-left-color: var(--primary-500); }
.comment-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; margin-top: 8px; }
.comment-actions .form-textarea { flex: 1 1 260px; min-height: 56px; }
```

Check the `.segmented` style (two definitions exist in `index.css`); use it as in `VideoField`.

- [ ] **Step 4: Tests + typecheck + lint**

Run: `npx vitest run tests/post-display.test.ts && (cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b && npm run lint)`
Expected: PASS; tsc clean; no new lint errors.

- [ ] **Step 5: Browser check** (the dev server is running; stop it before any DB test run)
- Seed with a `tsx` script in the plan workspace, on the local admin account:
  - one temporary Page "(thử UI)" with a fake token and `grantedScopes` including both comment scopes;
  - one PUBLISHED post on it with `fbPostId`, counts, and 3 `post_comments`: one needing a reply, one already answered by the Page, one marked handled;
  - a second temporary Page without `pages_manage_engagement`.
- Log in with a `sessionCookie()` cookie file, never a password.
- **Do not click "Trả lời" or "Làm mới" on the real Page** ("Viral page mon"). On the fake Page the Graph call fails harmlessly; check the error toast is Vietnamese.
- Check:
  1. the row shows `👍 · 💬 · ↗` and the amber "1 cần trả lời", which opens the panel;
  2. the overview shows "1 bình luận cần trả lời";
  3. the panel: needs-reply first, the "Cần trả lời / Tất cả" filter, "Đã xử lý" then "Bỏ đánh dấu" updates the counts, Esc closes;
  4. on the Page without the reply scope, the note with the Kênh Facebook link shows and there is no reply box;
  5. at 390 px, no horizontal scroll in the panel.
- Screenshot `.playwright-mcp/comments-panel.png`. Remove the seed data and the cookie file afterwards.

- [ ] **Step 6: Commit**

```bash
git add client/src/api.ts client/src/lib/post-display.ts client/src/components/PostListItem.tsx client/src/components/CommentsPanel.tsx client/src/pages/PostsPage.tsx client/src/index.css tests/post-display.test.ts
git commit -m "feat(client): engagement on post rows, comments panel with reply as the Page"
```

---

### Task 6: Docs, Hostinger SQL, full verification

**Files:** Modify `docs/DEPLOY_HOSTINGER.md`, `CLAUDE.md`, `ROADMAP.md`, `prisma/hostinger-schema.sql`

- [ ] **Step 1: SQL** — regenerate `prisma/hostinger-schema.sql` as `CLAUDE.md` describes, keeping the header. Import it into a temporary database, check that `post_comments` and `facebook_pages.grantedScopes` exist, then drop the temporary database.
- [ ] **Step 2: `docs/DEPLOY_HOSTINGER.md`** — add a section "Tương tác & bình luận" covering:
  - after this deploy, each Page must be **synced once** (Kênh Facebook → Đồng bộ Page) and the two new permissions ticked, to read and reply to comments. Counts work without it;
  - an App in **Live** mode used by people without a role on the App needs Meta **App Review** (Advanced Access) for `pages_read_user_content` and `pages_manage_engagement`. The admin's own Pages work without review;
  - numbers refresh every hour, and cron `/cron/tick` must be running.
- [ ] **Step 3: `CLAUDE.md`** — in the job list add: "`sync_engagement` (keyed `system:sync_engagement`, hourly, not booked in tests): counts on `post_targets` + comments in `post_comments` for posts published ≤ 30 days (`src/services/engagement-sync.ts`); reading/replying needs the optional scopes recorded in `facebook_pages.grantedScopes`." In **Facebook**, add that `REQUIRED_SCOPES` must never include the comment scopes.
- [ ] **Step 4: `ROADMAP.md`** — under Phase 4 (Đo lường & vòng phản hồi) add: `- ✅ (2026-09-30) Lượt thích/bình luận/chia sẻ từng bài (đồng bộ mỗi giờ), xem và trả lời bình luận bằng tên Page, "cần trả lời" — plan docs/superpowers/plans/2026-09-30-engagement-comments.md`.
- [ ] **Step 5: Full verification (no dev server)**

```bash
npx tsc --noEmit && npx vitest run && RUN_DB_TESTS=1 npx vitest run
(cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b && npx -y -p node@22 -- node node_modules/vite/bin/vite.js build)
```

Expected: everything passes; build OK.

- [ ] **Step 6: Commit and STOP**

```bash
git branch --show-current
git add docs/DEPLOY_HOSTINGER.md CLAUDE.md ROADMAP.md prisma/hostinger-schema.sql
git commit -m "docs: engagement and comments — re-sync Pages, App Review note, roadmap"
```

Report to the user:
- it is done on the branch, not merged, not deployed;
- after deploying, re-sync the Pages and tick the new permissions;
- which permissions need App Review if the App is Live for other people.
