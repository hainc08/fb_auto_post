# Timed Posts ("Hẹn giờ đăng") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A post written by hand (Tạo bài, or any post in Bài đăng that is not part of a slot schedule) can be given one exact date and time, and the app publishes it then without the user creating a schedule.

**Architecture:** A timed post is a `Post` with `status = SCHEDULED`, `scheduleQueued = false` and `scheduledAt` = the chosen time. Scheduling books one delayed `publish_post` job whose payload carries `scheduledFor`; when the job runs it atomically claims the post only if the post still waits for exactly that time, so changing the time, cancelling, publishing by hand or deleting the post turns older jobs into no-ops. No schema change, no new job type; the slot-schedule tick already ignores posts with `scheduleQueued = false`.

**Tech Stack:** Express + zod + Prisma (MariaDB) + the existing job queue; React 19 client with plain CSS; Vitest (root suite, DB tests behind `RUN_DB_TESTS=1`).

**Spec:** none — the request was made in chat (2026-10-02): "với các bài được tạo ngẫu nhiên có thể cấu hình lịch đăng cụ thể mà không phải tạo từ chức năng lịch đăng". Decisions taken for this plan (the user may overrule them before execution):

1. The time is picked in two places: the **Tạo bài** page (next to "Duyệt & đăng ngay") and the post inspector on the **Bài đăng** page.
2. Setting a time **is** the approval: the post publishes at that time without another click.
3. Times are entered and shown in **Vietnam time** (UTC+7), like slot schedules. Allowed range: at least 1 minute ahead, at most 90 days ahead.
4. A timed post can be **moved** ("Đổi giờ đăng"), **cancelled** ("Huỷ hẹn giờ" → back to "Chờ duyệt") or **published now**.
5. Posts that belong to a slot schedule (`scheduleQueued = true`) cannot be timed individually; they keep "Duyệt" / "Đăng ngay (bỏ khung giờ)".

## Global Constraints

- UI copy and API error messages are Vietnamese; code and comments are English.
- No change to `prisma/schema.prisma` (the columns `scheduledAt`, `approvedAt`, `scheduleQueued` exist).
- Every new route filters by `req.user.id`, returns 404 for another user's id, and is added to `ROUTE_CASES` in `tests/isolation.db.test.ts`.
- Route handlers use `asyncHandler` + `createError(status, message)`; input is validated with zod.
- Tests never reach real Gemini, Cloudflare or Facebook. No test in this plan lets a due `publish_post` or `publish_target` job exist in the database (another test file's worker could claim it).
- Stop any local dev server before `RUN_DB_TESTS=1` runs; MariaDB must be up (`docker compose up -d`).
- Client commands need Node 22: prefix with `npx -y -p node@22 -- node …` as in `CLAUDE.md`.
- Public repo: stage files by name, never `git add -A`, never commit `.env*`, `CR/`, `bugs/`, `prompt_creator_video.md`. Work on branch `feature/timed-posts`, never on `deploy`.
- New CSS reuses the existing tokens on `:root` and goes **above** the `/* ─── Phones & small tablets` block in `client/src/index.css`.

## Review Focus

1. The user moves or cancels the time, then the old job fires → nothing is published (Task 1 Step 6 test "an out-of-date timed job does nothing"; Task 2 tests "moving the time" and "cancelling").
2. The timed job fails once on a transient error and is retried → the retry must still publish, not skip because the post is already `GENERATING` (Task 1 test "a retry of a run that already took the post goes on").
3. A Page's token expired before the user picks a time → refused at once with the usual Page message, the post keeps its status (Task 2 test "a blocked Page refuses the time").
4. The same time is sent twice (double click, two tabs) → two jobs exist but only one may take the post (Task 1 test "only one job takes the post").
5. A post of a slot schedule, a post with no content, or a post being published → refused with a clear Vietnamese message (Task 2 tests).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/post-timing.ts` (new) | Time validation and the atomic claim of a timed post |
| `src/services/scheduler.service.ts` (modify) | `scheduledFor` in the job payload; the claim at the start of `runPublishJob` |
| `src/routes/posts.routes.ts` (modify) | `POST /:id/schedule`, `DELETE /:id/schedule`; create path uses `scheduledFor` |
| `client/src/lib/schedule-input.ts` (new) | Pure helpers for the date-time field (Vietnam time) |
| `client/src/components/SchedulePicker.tsx` (new) | The date-time field + confirm / cancel buttons |
| `client/src/api.ts` (modify) | `postsApi.schedule`, `postsApi.cancelSchedule` |
| `client/src/pages/CreatePostPage.tsx` (modify) | "Hẹn giờ đăng" on the create page |
| `client/src/pages/PostsPage.tsx` (modify) | Time, move, cancel, publish-now in the inspector |
| `client/src/index.css` (modify) | `.timed-picker`, `.timed-note` |
| `tests/post-timing.test.ts`, `tests/post-timing.db.test.ts`, `tests/post-timed-routes.db.test.ts`, `tests/schedule-input.test.ts` (new) | Tests |
| `tests/isolation.db.test.ts`, `CLAUDE.md`, `ROADMAP.md`, `docs/DEPLOY_HOSTINGER.md` (modify) | Route table and docs |

---

### Task 1: The timed job only publishes a post that still waits for its time

**Files:**
- Create: `src/lib/post-timing.ts`
- Modify: `src/services/scheduler.service.ts` (`PostPipelineJob` at lines 36–45, `runPublishJob` at line 71, `enqueuePost` at line 445)
- Test: `tests/post-timing.test.ts`, `tests/post-timing.db.test.ts`

**Interfaces:**
- Consumes: `enqueue(type, payload, { runAt })` from `src/lib/job-queue.ts`.
- Produces:
  - `timedProblem(at: Date, now?: Date): string | null`
  - `claimTimedPost(postId: string, scheduledFor: Date): Promise<boolean>`
  - `timedJobMayRun(post: { id: string; status: PostStatus }, scheduledFor: Date, attempt: number): Promise<boolean>`
  - `enqueuePost(postId, userId, options?: { …existing…; scheduledFor?: Date }): Promise<string>` — with `scheduledFor` the job runs at that time and carries it in its payload.
  - `runPublishJob(job: Job): Promise<void>` becomes an export (tests only).

- [ ] **Step 1: Branch and commit the plan**

```bash
git checkout main && git pull --ff-only && git checkout -b feature/timed-posts
git add docs/superpowers/plans/2026-10-02-timed-posts.md
git commit -m "docs: plan for timed posts"
```

- [ ] **Step 2: Write the failing unit test**

Create `tests/post-timing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { timedProblem } from '../src/lib/post-timing';

const now = new Date('2026-10-03T01:00:00.000Z');
const plus = (ms: number) => new Date(now.getTime() + ms);

describe('timedProblem', () => {
  it('accepts a time between 30 seconds and 90 days ahead', () => {
    expect(timedProblem(plus(30_000), now)).toBeNull();
    expect(timedProblem(plus(90 * 86_400_000), now)).toBeNull();
  });

  it('refuses the past and "right now"', () => {
    expect(timedProblem(plus(-60_000), now)).toMatch(/ít nhất 1 phút/);
    expect(timedProblem(plus(29_000), now)).toMatch(/ít nhất 1 phút/);
  });

  it('refuses more than 90 days ahead', () => {
    expect(timedProblem(plus(90 * 86_400_000 + 1), now)).toMatch(/90 ngày/);
  });

  it('refuses an invalid date', () => {
    expect(timedProblem(new Date('nope'), now)).toMatch(/không hợp lệ/);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run tests/post-timing.test.ts`
Expected: FAIL — cannot find module `../src/lib/post-timing`.

- [ ] **Step 4: Write `src/lib/post-timing.ts`**

```ts
import type { PostStatus } from '@prisma/client';
import prisma from '../utils/prisma';

/** Timed posts ("Hẹn giờ đăng"): one post published at a time the user picks, outside any slot schedule. */

/** The browser asks for 1 minute ahead; this leaves room for clock skew and request latency */
export const MIN_LEAD_MS = 30_000;
export const MAX_AHEAD_DAYS = 90;

/** Why this time cannot be used (shown to the user); null = fine */
export function timedProblem(at: Date, now = new Date()): string | null {
  if (Number.isNaN(at.getTime())) return 'Giờ đăng không hợp lệ.';
  if (at.getTime() < now.getTime() + MIN_LEAD_MS) return 'Giờ đăng phải sau hiện tại ít nhất 1 phút.';
  if (at.getTime() > now.getTime() + MAX_AHEAD_DAYS * 86_400_000) return `Chỉ hẹn được trong ${MAX_AHEAD_DAYS} ngày tới.`;
  return null;
}

/**
 * Take the post for publishing, only if it still waits for exactly this time.
 * False = the user moved the time, cancelled, published by hand or deleted the post.
 */
export async function claimTimedPost(postId: string, scheduledFor: Date): Promise<boolean> {
  const { count } = await prisma.post.updateMany({
    where: { id: postId, status: 'SCHEDULED', scheduleQueued: false, scheduledAt: scheduledFor },
    data: { status: 'GENERATING' },
  });
  return count === 1;
}

/** May this timed job publish the post? `attempt` is 1 on the first run. */
export async function timedJobMayRun(post: { id: string; status: PostStatus }, scheduledFor: Date, attempt: number): Promise<boolean> {
  // A retry of a run that already took the post
  if (attempt > 1 && post.status === 'GENERATING') return true;
  return claimTimedPost(post.id, scheduledFor);
}
```

- [ ] **Step 5: Run the unit test**

Run: `npx vitest run tests/post-timing.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Write the failing DB test**

Create `tests/post-timing.db.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Job } from '@prisma/client';
import '../src/config';
import prisma from '../src/utils/prisma';
import { claimTimedPost, timedJobMayRun } from '../src/lib/post-timing';
import { enqueuePost, runPublishJob } from '../src/services/scheduler.service';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let userId: string;
let pageId: string;
const AT = new Date('2031-05-06T02:00:00.000Z');
const OTHER = new Date('2031-05-07T02:00:00.000Z');

const timed = (data: { status?: 'SCHEDULED' | 'READY' | 'GENERATING'; scheduleQueued?: boolean } = {}) =>
  prisma.post.create({
    data: { userId, pageId, caption: 'Bài hẹn giờ', status: data.status ?? 'SCHEDULED', scheduleQueued: data.scheduleQueued ?? false, scheduledAt: AT, targets: { create: { pageId } } },
  });
const statusOf = async (id: string) => (await prisma.post.findUniqueOrThrow({ where: { id } })).status;
const jobsOf = (postId: string, type: string) => prisma.job.findMany({ where: { type, payload: { path: '$.postId', equals: postId } } });

describe.skipIf(!process.env.RUN_DB_TESTS)('timed posts: the claim', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    userId = (await createTestUser()).user.id;
    pageId = (await prisma.facebookPage.create({ data: { userId, pageId: `TMD_${Date.now()}`, pageName: 'P', pageAccessToken: 'EAAfaketokentimedxxxxxxxxxxxxxxxxxx', tokenStatus: 'VALID' } })).id;
  });
  afterAll(async () => {
    const posts = await prisma.post.findMany({ where: { userId }, select: { id: true } });
    if (posts.length) await prisma.job.deleteMany({ where: { OR: posts.map((p) => ({ payload: { path: '$.postId', equals: p.id } })) } });
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('only one job takes the post', async () => {
    const post = await timed();
    expect(await claimTimedPost(post.id, AT)).toBe(true);
    expect(await statusOf(post.id)).toBe('GENERATING');
    expect(await claimTimedPost(post.id, AT)).toBe(false);
  });

  it('a job booked for another time does not take it', async () => {
    const post = await timed();
    expect(await claimTimedPost(post.id, OTHER)).toBe(false);
    expect(await statusOf(post.id)).toBe('SCHEDULED');
  });

  it('never takes a cancelled post or a post of a slot schedule', async () => {
    expect(await claimTimedPost((await timed({ status: 'READY' })).id, AT)).toBe(false);
    expect(await claimTimedPost((await timed({ scheduleQueued: true })).id, AT)).toBe(false);
  });

  it('a retry of a run that already took the post goes on', async () => {
    const post = await timed({ status: 'GENERATING' });
    expect(await timedJobMayRun(post, AT, 2)).toBe(true);
    // the first attempt never skips the claim
    expect(await timedJobMayRun(post, AT, 1)).toBe(false);
  });

  it('enqueuePost books the job at the chosen time and records it', async () => {
    const post = await timed();
    await enqueuePost(post.id, userId, { scheduledFor: AT, intervalMs: 120_000 });
    const [job] = await jobsOf(post.id, 'publish_post');
    expect(job.runAt.toISOString()).toBe(AT.toISOString());
    expect(job.payload).toMatchObject({ postId: post.id, userId, scheduledFor: AT.toISOString(), intervalMs: 120_000 });
  });

  it('an out-of-date timed job does nothing', async () => {
    const post = await timed();
    const stale = { id: 'stale-job', attempts: 1, maxAttempts: 3, payload: { postId: post.id, userId, scheduledFor: OTHER.toISOString() } } as unknown as Job;
    await runPublishJob(stale);
    expect(await statusOf(post.id)).toBe('SCHEDULED');
    expect(await prisma.postLog.count({ where: { postId: post.id } })).toBe(0);
    expect(await jobsOf(post.id, 'publish_target')).toHaveLength(0);
  });
});
```

- [ ] **Step 7: Run it to see it fail**

Run: `RUN_DB_TESTS=1 npx vitest run tests/post-timing.db.test.ts`
Expected: FAIL — `runPublishJob` is not exported; `scheduledFor` is not a known option of `enqueuePost`.

- [ ] **Step 8: Wire the claim into the publish job**

In `src/services/scheduler.service.ts`:

Add the import after the `post-targets` import:

```ts
import { timedJobMayRun } from '../lib/post-timing';
```

Add one field to `PostPipelineJob` (after `intervalMs`):

```ts
  /** Timed post: ISO time this job was booked for. The job only runs while the post still waits for it. */
  scheduledFor?: string;
```

Export the handler and read the field — replace

```ts
async function runPublishJob(job: Job): Promise<void> {
  const { postId, userId, skipAiGeneration, skipImageGeneration, targetIds, intervalMs = 0 } =
    job.payload as unknown as PostPipelineJob;
```

with

```ts
/** Exported for tests */
export async function runPublishJob(job: Job): Promise<void> {
  const { postId, userId, skipAiGeneration, skipImageGeneration, targetIds, intervalMs = 0, scheduledFor } =
    job.payload as unknown as PostPipelineJob;
```

Right after the line `if (post.userId !== userId) throw new UnrecoverableJobError('Unauthorized');` add:

```ts
    // Timed post: the time was moved or cancelled, or the post was published by hand since this job was booked
    if (scheduledFor && !(await timedJobMayRun(post, new Date(scheduledFor), attempt))) {
      logger.info('[Pipeline] Timed job is out of date, skipping', { postId, scheduledFor });
      return;
    }
```

Replace the body of `enqueuePost` with:

```ts
export async function enqueuePost(
  postId: string,
  userId: string,
  options?: {
    delay?: number;
    skipAi?: boolean;
    skipImage?: boolean;
    targetIds?: string[];
    intervalMs?: number;
    /** Timed post: run at this time, and only while the post still waits for it */
    scheduledFor?: Date;
  }
): Promise<string> {
  const payload: PostPipelineJob = {
    postId,
    userId,
    ...(options?.skipAi !== undefined && { skipAiGeneration: options.skipAi }),
    ...(options?.skipImage !== undefined && { skipImageGeneration: options.skipImage }),
    ...(options?.targetIds && { targetIds: options.targetIds }),
    ...(options?.intervalMs !== undefined && { intervalMs: options.intervalMs }),
    ...(options?.scheduledFor && { scheduledFor: options.scheduledFor.toISOString() }),
  };
  const runAt = options?.scheduledFor ?? new Date(Date.now() + (options?.delay ?? 0));
  const job = await enqueue('publish_post', { ...payload }, { runAt });
  return job.id;
}
```

- [ ] **Step 9: Run the tests**

Run: `npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run tests/post-timing.db.test.ts tests/post-timing.test.ts tests/multi-page.db.test.ts`
Expected: typecheck clean; all pass (multi-page proves the normal publish path is untouched).

- [ ] **Step 10: Commit**

```bash
git add src/lib/post-timing.ts src/services/scheduler.service.ts tests/post-timing.test.ts tests/post-timing.db.test.ts
git commit -m "feat(posts): timed publish job only runs while the post still waits for its time"
```

---

### Task 2: API — set, move and cancel the time of a post

**Files:**
- Modify: `src/routes/posts.routes.ts` (imports at the top; create path at lines 289–297; new routes after the approve route, before "Retry one Page")
- Modify: `tests/isolation.db.test.ts` (`ROUTE_CASES`, next to `'POST /api/posts/:id/approve'`)
- Test: `tests/post-timed-routes.db.test.ts`

**Interfaces:**
- Consumes: `timedProblem(at, now?)`, `claimTimedPost(postId, scheduledFor)` and `enqueuePost(..., { scheduledFor, intervalMs })` from Task 1; `assertOwnPages`, `syncTargets`, `pageIdsSchema`, `DEFAULT_INTERVAL_MINUTES`, `MAX_INTERVAL_MINUTES` already in `posts.routes.ts`.
- Produces:
  - `POST /api/posts/:id/schedule` body `{ scheduledAt: string (ISO), pageIds?: string[], intervalMinutes?: number }` → `200 { success, data: { id, status: 'SCHEDULED', scheduledAt: string, pages: number } }`. Errors: 400 bad time / schedule-owned / no content / nothing left to publish; 404 not the caller's post or Page; 409 blocked Page or post in progress.
  - `DELETE /api/posts/:id/schedule` → `200 { success, data: { id, status: 'READY' | 'DRAFT', scheduledAt: null } }`; 400 when the post is not a timed post.

- [ ] **Step 1: Write the failing test**

Create `tests/post-timed-routes.db.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { saveSettings } from '../src/lib/settings';
import { claimTimedPost } from '../src/lib/post-timing';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;
let cookie: string;
let userId: string;
let pageId: string;
let expiredPageId: string;

const inHours = (h: number) => new Date(Math.floor(Date.now() / 60_000) * 60_000 + h * 3600_000);
const draft = (data: Record<string, unknown> = {}, page = pageId) =>
  prisma.post.create({ data: { userId, pageId: page, caption: 'Bài viết tay', status: 'READY', targets: { create: { pageId: page } }, ...data } });
const row = (id: string) => prisma.post.findUniqueOrThrow({ where: { id } });
const jobsOf = (postId: string) => prisma.job.findMany({ where: { type: 'publish_post', payload: { path: '$.postId', equals: postId } }, orderBy: { runAt: 'asc' } });
const setTime = (id: string, at: Date, extra: Record<string, unknown> = {}) =>
  api(server.baseUrl, 'POST', `/api/posts/${id}/schedule`, { cookie, body: { scheduledAt: at.toISOString(), ...extra } });

describe.skipIf(!process.env.RUN_DB_TESTS)('timed posts: API', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    server = await startTestServer(createApp());
    const u = await createTestUser();
    cookie = u.cookie;
    userId = u.user.id;
    await saveSettings(userId, { fbAppId: '333' });
    const page = (suffix: string, tokenStatus: 'VALID' | 'EXPIRED') =>
      prisma.facebookPage.create({ data: { userId, pageId: `TMR_${Date.now()}_${suffix}`, pageName: `Page ${suffix}`, pageAccessToken: 'EAAfaketokentimedroutesxxxxxxxxxxxx', tokenStatus, tokenAppId: '333' } });
    pageId = (await page('ok', 'VALID')).id;
    expiredPageId = (await page('old', 'EXPIRED')).id;
  });
  afterAll(async () => {
    const posts = await prisma.post.findMany({ where: { userId }, select: { id: true } });
    if (posts.length) await prisma.job.deleteMany({ where: { OR: posts.map((p) => ({ payload: { path: '$.postId', equals: p.id } })) } });
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('times a written post: approved, waiting, one job at that time', async () => {
    const post = await draft();
    const at = inHours(5);
    const res = await setTime(post.id, at, { intervalMinutes: 3 });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ id: post.id, status: 'SCHEDULED', scheduledAt: at.toISOString(), pages: 1 });
    const saved = await row(post.id);
    expect(saved).toMatchObject({ status: 'SCHEDULED', scheduleQueued: false });
    expect(saved.scheduledAt?.toISOString()).toBe(at.toISOString());
    expect(saved.approvedAt).not.toBeNull();
    const jobs = await jobsOf(post.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].runAt.toISOString()).toBe(at.toISOString());
    expect(jobs[0].payload).toMatchObject({ scheduledFor: at.toISOString(), intervalMs: 180_000 });
    expect(await prisma.postLog.count({ where: { postId: post.id, action: 'scheduled' } })).toBe(1);
  });

  it('moving the time: the job of the old time can no longer take the post', async () => {
    const post = await draft();
    const first = inHours(5);
    const second = inHours(30);
    await setTime(post.id, first);
    expect((await setTime(post.id, second)).status).toBe(200);
    expect((await row(post.id)).scheduledAt?.toISOString()).toBe(second.toISOString());
    expect(await jobsOf(post.id)).toHaveLength(2);
    expect(await claimTimedPost(post.id, first)).toBe(false);
    expect(await claimTimedPost(post.id, second)).toBe(true);
  });

  it('cancelling puts the post back to "Chờ duyệt" and disarms the job', async () => {
    const post = await draft();
    const at = inHours(5);
    await setTime(post.id, at);
    const res = await api(server.baseUrl, 'DELETE', `/api/posts/${post.id}/schedule`, { cookie });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ status: 'READY', scheduledAt: null });
    expect(await row(post.id)).toMatchObject({ status: 'READY', scheduledAt: null, approvedAt: null });
    expect(await claimTimedPost(post.id, at)).toBe(false);
    expect((await api(server.baseUrl, 'DELETE', `/api/posts/${post.id}/schedule`, { cookie })).status).toBe(400);
  });

  it('a failed post can be timed again and its error is cleared', async () => {
    const post = await draft({ status: 'FAILED', errorMessage: 'Lỗi cũ', errorStep: 'publish' });
    expect((await setTime(post.id, inHours(2))).status).toBe(200);
    expect(await row(post.id)).toMatchObject({ status: 'SCHEDULED', errorMessage: null, errorStep: null });
  });

  it('refuses a time in the past, too far ahead, or malformed', async () => {
    const post = await draft();
    const past = await setTime(post.id, inHours(-1));
    expect(past.status).toBe(400);
    expect(past.json.error).toMatch(/ít nhất 1 phút/);
    expect((await setTime(post.id, inHours(91 * 24))).json.error).toMatch(/90 ngày/);
    expect((await api(server.baseUrl, 'POST', `/api/posts/${post.id}/schedule`, { cookie, body: { scheduledAt: 'mai' } })).status).toBe(400);
    expect((await row(post.id)).status).toBe('READY');
    expect(await jobsOf(post.id)).toHaveLength(0);
  });

  it('refuses a post of a slot schedule, a post with no content, and a post in progress', async () => {
    const owned = await draft({ scheduleQueued: true, scheduledAt: inHours(3) });
    const res = await setTime(owned.id, inHours(5));
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/lịch đăng/);
    const empty = await draft({ caption: null, status: 'DRAFT' });
    expect((await setTime(empty.id, inHours(5))).json.error).toMatch(/chưa có nội dung/);
    const busy = await draft({ status: 'PUBLISHING' });
    expect((await setTime(busy.id, inHours(5))).status).toBe(409);
    expect((await api(server.baseUrl, 'DELETE', `/api/posts/${owned.id}/schedule`, { cookie })).status).toBe(400);
  });

  it('a blocked Page refuses the time', async () => {
    const post = await draft({}, expiredPageId);
    const res = await setTime(post.id, inHours(5));
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/Page old/);
    expect((await row(post.id)).status).toBe('READY');
    expect(await jobsOf(post.id)).toHaveLength(0);
  });

  it('can change the Pages while setting the time', async () => {
    const second = await prisma.facebookPage.create({ data: { userId, pageId: `TMR_${Date.now()}_two`, pageName: 'Page two', pageAccessToken: 'EAAfaketokentimedroutesxxxxxxxxxxxx', tokenStatus: 'VALID', tokenAppId: '333' } });
    const post = await draft();
    const res = await setTime(post.id, inHours(5), { pageIds: [pageId, second.id] });
    expect(res.json.data.pages).toBe(2);
    expect(await prisma.postTarget.count({ where: { postId: post.id } })).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `RUN_DB_TESTS=1 npx vitest run tests/post-timed-routes.db.test.ts`
Expected: FAIL — `POST /api/posts/:id/schedule` returns 404.

- [ ] **Step 3: Add the routes**

In `src/routes/posts.routes.ts`, add the import after the `page-health` import:

```ts
import { timedProblem } from '../lib/post-timing';
```

Insert this block after the approve route (before the `// ─── Retry one Page` comment):

```ts
// ─── Timed post: publish at a chosen time ("Hẹn giờ đăng") ───

const timedSchema = z.object({
  scheduledAt: z.string().datetime(),
  /** Pages to publish to (replaces the unpublished selection); default: current targets */
  pageIds: pageIdsSchema.optional(),
  /** Gap between two Pages, in minutes */
  intervalMinutes: z.number().int().min(0).max(MAX_INTERVAL_MINUTES).default(DEFAULT_INTERVAL_MINUTES),
});

const TIMEABLE: PostStatus[] = ['DRAFT', 'READY', 'FAILED', 'SCHEDULED'];

/** Set or move the time. Setting a time is the approval: the post goes out then without another click. */
router.post(
  '/:id/schedule',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { scheduledAt, pageIds, intervalMinutes } = timedSchema.parse(req.body ?? {});
    const at = new Date(scheduledAt);
    const problem = timedProblem(at);
    if (problem) throw createError(400, problem);

    const post = await prisma.post.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
    if (!post) throw createError(404, 'Post not found');
    if (post.scheduleQueued) {
      throw createError(400, 'Bài này thuộc một lịch đăng: hãy duyệt để đăng theo khung giờ của lịch, hoặc đăng ngay.');
    }
    if (!post.caption?.trim() && !post.imagePath && !post.videoPath) {
      throw createError(400, 'Bài chưa có nội dung để hẹn giờ đăng.');
    }

    // Same Page checks as "Đăng": a post that cannot go out would fail silently at its time
    if (pageIds) await syncTargets(post.id, await assertOwnPages(req.user!.id, pageIds));
    const targets = await prisma.postTarget.findMany({ where: { postId: post.id, status: { not: 'PUBLISHED' } } });
    if (targets.length === 0) throw createError(400, 'Bài đã được đăng trên tất cả Page đã chọn.');
    if (!pageIds) await assertOwnPages(req.user!.id, targets.map((t) => t.pageId));

    const { count } = await prisma.post.updateMany({
      where: { id: post.id, status: { in: TIMEABLE }, scheduleQueued: false },
      data: { status: 'SCHEDULED', scheduledAt: at, approvedAt: new Date(), errorMessage: null, errorStep: null, errorCode: null },
    });
    if (count === 0) throw createError(409, 'Bài đang được xử lý hoặc đang đăng, hãy chờ xong rồi thử lại.');

    // A job booked for an earlier time stays in the queue and does nothing (see claimTimedPost)
    await enqueuePost(post.id, req.user!.id, { scheduledFor: at, intervalMs: intervalMinutes * 60_000 });
    await prisma.postLog.create({
      data: { postId: post.id, action: 'scheduled', details: { scheduledAt: at.toISOString(), pages: targets.length } },
    });
    res.json({ success: true, data: { id: post.id, status: 'SCHEDULED', scheduledAt: at.toISOString(), pages: targets.length } });
  })
);

/** Cancel the time: the post waits for approval again. */
router.delete(
  '/:id/schedule',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await prisma.post.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
    if (!post) throw createError(404, 'Post not found');
    const status: PostStatus = post.caption?.trim() ? 'READY' : 'DRAFT';
    const { count } = await prisma.post.updateMany({
      where: { id: post.id, status: 'SCHEDULED', scheduleQueued: false },
      data: { status, scheduledAt: null, approvedAt: null },
    });
    if (count === 0) throw createError(400, 'Bài này không đang hẹn giờ đăng.');
    await prisma.postLog.create({ data: { postId: post.id, action: 'schedule_cancelled' } });
    res.json({ success: true, data: { id: post.id, status, scheduledAt: null } });
  })
);
```

In the create route, replace

```ts
    if (post.scheduledAt) {
      const delay = Math.max(0, post.scheduledAt.getTime() - Date.now());
      await enqueuePost(post.id, userId, { delay, intervalMs: DEFAULT_INTERVAL_MINUTES * 60_000 });
```

with

```ts
    if (post.scheduledAt) {
      await enqueuePost(post.id, userId, { scheduledFor: post.scheduledAt, intervalMs: DEFAULT_INTERVAL_MINUTES * 60_000 });
```

- [ ] **Step 4: Declare the routes in the isolation table**

In `tests/isolation.db.test.ts`, after the line that starts with `'POST /api/posts/:id/approve':` add:

```ts
  'POST /api/posts/:id/schedule': {
    kind: 'foreign-id',
    path: (b) => `/api/posts/${b.postId}/schedule`,
    body: { scheduledAt: new Date(Date.now() + 3 * 3600_000).toISOString() },
  },
  'DELETE /api/posts/:id/schedule': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/schedule` },
```

- [ ] **Step 5: Run the tests**

Run: `npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run tests/post-timed-routes.db.test.ts tests/isolation.db.test.ts tests/schedule-approve.db.test.ts`
Expected: typecheck clean; all pass.

- [ ] **Step 6: Commit**

```bash
git add src/routes/posts.routes.ts tests/post-timed-routes.db.test.ts tests/isolation.db.test.ts
git commit -m "feat(posts): API to set, move and cancel the publish time of a post"
```

---

### Task 3: Client — time helpers, API calls and the picker

**Files:**
- Create: `client/src/lib/schedule-input.ts`, `client/src/components/SchedulePicker.tsx`
- Modify: `client/src/api.ts` (inside `postsApi`, after `approve`), `client/src/index.css` (above the `/* ─── Phones & small tablets` block)
- Test: `tests/schedule-input.test.ts` (root Vitest suite, like `tests/post-display.test.ts`)

**Interfaces:**
- Consumes: the API of Task 2; `slotLabel(iso)` from `client/src/components/ScheduleBits.tsx` ("T6 03/10 08:30", Vietnam time) for labels in Tasks 4–5.
- Produces:
  - `toInputValue(d: Date): string`, `fromInputValue(value: string): Date | null`, `suggestedTime(now?: Date): Date`, `inputProblem(value: string, now?: Date): string | null`, `MAX_AHEAD_DAYS`
  - `postsApi.schedule(id, { scheduledAt, pageIds?, intervalMinutes? })` → `{ data: { id, status, scheduledAt, pages } }`
  - `postsApi.cancelSchedule(id)` → `{ data: { id, status, scheduledAt: null } }`
  - `<SchedulePicker initial?: string | null busy?: boolean confirmLabel?: string onConfirm={(iso: string) => void} onCancel={() => void} />`

- [ ] **Step 1: Write the failing test**

Create `tests/schedule-input.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fromInputValue, inputProblem, suggestedTime, toInputValue } from '../client/src/lib/schedule-input';

describe('date-time field in Vietnam time', () => {
  it('shows a moment as Vietnam wall time', () => {
    expect(toInputValue(new Date('2026-10-03T01:30:00.000Z'))).toBe('2026-10-03T08:30');
    expect(toInputValue(new Date('2026-12-31T18:05:00.000Z'))).toBe('2027-01-01T01:05');
  });

  it('reads the field back to the same moment', () => {
    expect(fromInputValue('2026-10-03T08:30')?.toISOString()).toBe('2026-10-03T01:30:00.000Z');
    expect(fromInputValue('2027-01-01T01:05')?.toISOString()).toBe('2026-12-31T18:05:00.000Z');
  });

  it('rejects an empty or impossible value', () => {
    expect(fromInputValue('')).toBeNull();
    expect(fromInputValue('2026-02-31T08:00')).toBeNull();
    expect(fromInputValue('hôm nay')).toBeNull();
  });

  it('suggests the next full hour that is at least 30 minutes away', () => {
    expect(suggestedTime(new Date('2026-10-03T01:10:00.000Z')).toISOString()).toBe('2026-10-03T02:00:00.000Z');
    expect(suggestedTime(new Date('2026-10-03T01:45:00.000Z')).toISOString()).toBe('2026-10-03T03:00:00.000Z');
  });
});

describe('inputProblem', () => {
  const now = new Date('2026-10-03T01:00:00.000Z'); // 08:00 in Vietnam

  it('asks for a value', () => {
    expect(inputProblem('', now)).toBe('Chọn ngày và giờ đăng.');
  });

  it('needs at least one minute ahead', () => {
    expect(inputProblem('2026-10-03T08:00', now)).toMatch(/ít nhất 1 phút/);
    expect(inputProblem('2026-10-03T07:00', now)).toMatch(/ít nhất 1 phút/);
    expect(inputProblem('2026-10-03T08:01', now)).toBeNull();
  });

  it('allows up to 90 days ahead', () => {
    expect(inputProblem('2027-01-01T08:00', now)).toBeNull();
    expect(inputProblem('2027-01-01T08:01', now)).toMatch(/90 ngày/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/schedule-input.test.ts`
Expected: FAIL — cannot find module `../client/src/lib/schedule-input`.

- [ ] **Step 3: Write `client/src/lib/schedule-input.ts`**

```ts
/** Pure helpers for the "Hẹn giờ đăng" field (no React, no DOM): tested from tests/schedule-input.test.ts. */

/** Times are entered and shown in Vietnam time, like slot schedules */
const VN_OFFSET_MS = 7 * 3600_000;
export const MIN_LEAD_MINUTES = 1;
export const MAX_AHEAD_DAYS = 90;

const two = (n: number) => String(n).padStart(2, '0');

/** A moment → value of <input type="datetime-local"> (Vietnam wall time) */
export function toInputValue(d: Date): string {
  const vn = new Date(d.getTime() + VN_OFFSET_MS);
  return `${vn.getUTCFullYear()}-${two(vn.getUTCMonth() + 1)}-${two(vn.getUTCDate())}T${two(vn.getUTCHours())}:${two(vn.getUTCMinutes())}`;
}

/** Value of the field (Vietnam wall time) → the moment; null when empty or not a real date */
export function fromInputValue(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - VN_OFFSET_MS);
  // 31 February rolls over to March: not what was typed
  return toInputValue(d) === m[0] ? d : null;
}

/** First suggestion: the next full hour that is at least 30 minutes away */
export function suggestedTime(now = new Date()): Date {
  return new Date(Math.ceil((now.getTime() + 30 * 60_000) / 3600_000) * 3600_000);
}

/** Why the field's value cannot be used (shown under the field); null = fine */
export function inputProblem(value: string, now = new Date()): string | null {
  const at = fromInputValue(value);
  if (!at) return 'Chọn ngày và giờ đăng.';
  if (at.getTime() < now.getTime() + MIN_LEAD_MINUTES * 60_000) return 'Giờ đăng phải sau hiện tại ít nhất 1 phút.';
  if (at.getTime() > now.getTime() + MAX_AHEAD_DAYS * 86_400_000) return `Chỉ hẹn được trong ${MAX_AHEAD_DAYS} ngày tới.`;
  return null;
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/schedule-input.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Add the API calls**

In `client/src/api.ts`, inside `postsApi`, after the `approve` entry add:

```ts
  /** Publish at a chosen time ("Hẹn giờ đăng"); calling it again moves the time. */
  schedule: (id: string, body: { scheduledAt: string; pageIds?: string[]; intervalMinutes?: number }) =>
    apiFetch<{ id: string; status: string; scheduledAt: string; pages: number }>(`/posts/${id}/schedule`, { method: 'POST', body: JSON.stringify(body) }),

  /** Cancel the time: the post waits for approval again. */
  cancelSchedule: (id: string) => apiFetch<{ id: string; status: string; scheduledAt: null }>(`/posts/${id}/schedule`, { method: 'DELETE' }),
```

- [ ] **Step 6: Write `client/src/components/SchedulePicker.tsx`**

```tsx
import { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { MAX_AHEAD_DAYS, fromInputValue, inputProblem, suggestedTime, toInputValue } from '../lib/schedule-input';

interface Props {
  /** Time of a post that is already timed (ISO); without it the next full hour is suggested */
  initial?: string | null;
  busy?: boolean;
  confirmLabel?: string;
  onConfirm: (iso: string) => void;
  onCancel: () => void;
}

/** Date and time for "Hẹn giờ đăng" (Vietnam time); says why a time cannot be used. */
export default function SchedulePicker({ initial, busy = false, confirmLabel = 'Hẹn giờ đăng', onConfirm, onCancel }: Props) {
  const [value, setValue] = useState(() => toInputValue(initial ? new Date(initial) : suggestedTime()));
  const now = new Date();
  const problem = inputProblem(value, now);

  return (
    <div className="timed-picker" role="group" aria-label="Hẹn giờ đăng">
      <label htmlFor="timed-at" className="form-label">Ngày giờ đăng</label>
      <input
        id="timed-at"
        type="datetime-local"
        className="form-input"
        value={value}
        min={toInputValue(now)}
        max={toInputValue(new Date(now.getTime() + MAX_AHEAD_DAYS * 86_400_000))}
        aria-invalid={!!problem}
        aria-describedby="timed-at-hint"
        onChange={(e) => setValue(e.target.value)}
      />
      <p id="timed-at-hint" className={problem ? 'field-warning' : 'field-hint'} role={problem ? 'alert' : undefined}>
        {problem ?? 'Giờ Việt Nam. Đến giờ bài tự đăng, không cần duyệt lại.'}
      </p>
      <div className="row timed-picker-actions">
        <button type="button" className="btn btn-primary" disabled={busy || !!problem} onClick={() => onConfirm(fromInputValue(value)!.toISOString())}>
          {busy ? <div className="spinner" /> : <CalendarClock size={16} aria-hidden="true" />} {confirmLabel}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>Thôi</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Add the styles**

In `client/src/index.css`, directly above the line `/* ─── Phones & small tablets ───────────────── */`, add:

```css
/* ─── Timed post ("Hẹn giờ đăng") ─── */
.timed-picker { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border: 1px solid var(--border-default); border-radius: var(--radius-lg); background: var(--bg-secondary); animation: rise-in 0.2s ease-out; }
.timed-picker .form-label, .timed-picker .field-hint, .timed-picker .field-warning { margin: 0; }
.timed-picker .form-input { background: var(--bg-card); }
.timed-picker-actions { gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.timed-picker-actions .btn-primary { flex: 1; }
.timed-note { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-radius: var(--radius-md); background: var(--info-bg); color: var(--info-text); font-size: 13.5px; }
@media (prefers-reduced-motion: reduce) { .timed-picker { animation: none; } }

```

- [ ] **Step 8: Typecheck the client**

Run (from `client/`): `npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b`
Expected: no output, exit code 0.

- [ ] **Step 9: Commit**

```bash
git add client/src/lib/schedule-input.ts client/src/components/SchedulePicker.tsx client/src/api.ts client/src/index.css tests/schedule-input.test.ts
git commit -m "feat(client): date-time picker and API calls for timed posts"
```

---

### Task 4: "Hẹn giờ đăng" on the Tạo bài page

**Files:**
- Modify: `client/src/pages/CreatePostPage.tsx` (imports lines 1–20; the `Busy` type; state near line 79; a new function after `publish()` at line 301; the buttons at lines 629–642)

**Interfaces:**
- Consumes: `SchedulePicker`, `postsApi.schedule`, `slotLabel` (Task 3); the page's own `save(quiet)`, `postId`, `selectedPages`, `intervalMinutes`, `hasContent`, `busy`, `videoBusy`, `navigate`, `toast`.
- Produces: nothing used by other tasks.

- [ ] **Step 1: Imports, busy state, picker state**

In `client/src/pages/CreatePostPage.tsx`:

Change the lucide import to add `CalendarClock`:

```tsx
import { Check, Sparkles, RefreshCw, ImageIcon, Send, X, Upload, AlertTriangle, CalendarClock } from 'lucide-react';
```

After the `VideoField` import add:

```tsx
import SchedulePicker from '../components/SchedulePicker';
import { slotLabel } from '../components/ScheduleBits';
```

Replace the `Busy` type (line 60) with:

```tsx
type Busy = null | 'writing' | 'rewriting' | 'image' | 'upload' | 'saving' | 'publishing' | 'scheduling';
```

Next to `const [busy, setBusy] = useState<Busy>(null);` add:

```tsx
  /** The "Hẹn giờ đăng" picker is open */
  const [timing, setTiming] = useState(false);
```

- [ ] **Step 2: The action**

After the closing brace of `async function publish()` add:

```tsx
  /** Save what is on screen, then let the server publish it at `iso`. */
  async function scheduleAt(iso: string) {
    if (!postId) return;
    if (!selectedPages.length) return toast.error('Chọn ít nhất 1 Page để đăng.');
    setBusy('scheduling');
    try {
      if (!(await save(true))) return;
      const res = await postsApi.schedule(postId, { scheduledAt: iso, pageIds: selectedPages.map((p) => p.id), intervalMinutes });
      toast.success(`Đã hẹn giờ — bài sẽ đăng lúc ${slotLabel(res.data.scheduledAt)}.`);
      navigate(`/posts?selected=${postId}`);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }
```

- [ ] **Step 3: The button and the picker**

Between the "Duyệt & đăng" button (`</button>` that closes the `btn btn-primary btn-lg btn-block` button) and the "Lưu, duyệt sau" button, insert:

```tsx
          {timing ? (
            <SchedulePicker busy={busy === 'scheduling'} onConfirm={(iso) => void scheduleAt(iso)} onCancel={() => setTiming(false)} />
          ) : (
            <button type="button" className="btn btn-secondary btn-block" onClick={() => setTiming(true)} disabled={!!busy || videoBusy || !hasContent || !selectedPages.length || !postId}>
              <CalendarClock size={16} aria-hidden="true" /> Hẹn giờ đăng
            </button>
          )}
```

- [ ] **Step 4: Typecheck and build**

Run (from `client/`): `npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b && npx -y -p node@22 -- node node_modules/vite/bin/vite.js build`
Expected: typecheck clean; build ends with `✓ built in …`.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/CreatePostPage.tsx
git commit -m "feat(client): set a publish time on the create page"
```

---

### Task 5: Time, move, cancel and publish-now in the Bài đăng inspector

**Files:**
- Modify: `client/src/pages/PostsPage.tsx` (imports lines 1–13; `LOG_LABEL` lines 84–99; state near line 121; the detail effect at lines 188–193; new functions after `approve()`; the inspector action block at lines 537–573)

**Interfaces:**
- Consumes: `SchedulePicker`, `postsApi.schedule`, `postsApi.cancelSchedule` (Task 3); the page's `load()`, `acting`, `setActing`, `confirming`, `confirmPublish`, `detail`, `tally`, `PUBLISHABLE`, `slotLabel`.
- Produces: nothing used by other tasks.

- [ ] **Step 1: Import, history labels, picker state**

Add the import after the `CommentsPanel` import:

```tsx
import SchedulePicker from '../components/SchedulePicker';
```

Add two entries to `LOG_LABEL`:

```tsx
  scheduled: 'Hẹn giờ đăng',
  schedule_cancelled: 'Huỷ hẹn giờ',
```

After `const [commentsFor, setCommentsFor] = useState<string | null>(null);` add:

```tsx
  /** The "Hẹn giờ đăng" picker is open in the inspector */
  const [timing, setTiming] = useState(false);
```

- [ ] **Step 2: Refresh the detail when the time changes, close the picker when the post changes**

In the effect that loads the selected post's detail, add `setTiming(false);` after `setExpanded(false);`, and add `selected?.scheduledAt` to its dependency array:

```tsx
  useEffect(() => {
    setConfirming(null);
    setExpanded(false);
    setTiming(false);
    if (!selectedId) return setDetail(null);
    postsApi.get(selectedId).then((r) => setDetail(r.data)).catch(() => setDetail(null));
  }, [selectedId, selected?.status, selected?.scheduledAt, selected?.caption, selected?.imageUrl, selected?.videoUrl, selected?.videoKind, selected?.targets?.map((t) => t.status).join()]);
```

- [ ] **Step 3: The actions**

After the closing brace of `async function approve(id: string)` add:

```tsx
  async function scheduleAt(id: string, iso: string) {
    setActing(true);
    try {
      const res = await postsApi.schedule(id, { scheduledAt: iso });
      toast.success(`Đã hẹn giờ — bài sẽ đăng lúc ${slotLabel(res.data.scheduledAt)}.`);
      setTiming(false);
      await load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setActing(false);
    }
  }

  async function cancelTimed(id: string) {
    setActing(true);
    try {
      await postsApi.cancelSchedule(id);
      toast.success('Đã huỷ hẹn giờ — bài quay lại "Chờ duyệt".');
      await load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setActing(false);
    }
  }
```

- [ ] **Step 4: The inspector buttons**

Above the `return (` of the component (next to `const message = …`) add:

```tsx
  /** A post waiting for a time the user picked (not a slot of a schedule) */
  const timed = !!detail && detail.status === 'SCHEDULED' && !detail.scheduleQueued;
  const canTime = !!detail && PUBLISHABLE.includes(detail.status) && !detail.scheduleQueued && !!detail.caption;
```

In the inspector, replace the block that starts with `{PUBLISHABLE.includes(detail.status) && (` and ends with its closing `)}` (the "Duyệt & đăng" button) with:

```tsx
              {timed && (
                <div className="timed-note">
                  <CalendarClock size={15} aria-hidden="true" />
                  <span>Hẹn giờ đăng: <strong>{slotLabel(detail.scheduledAt)}</strong></span>
                </div>
              )}
              {(PUBLISHABLE.includes(detail.status) || timed) && (
                <button type="button" className={detail.scheduleQueued || timed ? 'btn btn-secondary btn-block' : 'btn btn-primary btn-lg btn-block'} onClick={confirmPublish} disabled={acting || !detail.caption}>
                  {acting && confirming === 'publish' ? <div className="spinner" /> : <Send size={16} aria-hidden="true" />}
                  {confirming === 'publish'
                    ? 'Bấm lần nữa để đăng công khai'
                    : detail.status === 'FAILED'
                      ? tally.total > 1 ? `Đăng lại ${tally.total - tally.published} Page chưa lên` : 'Đăng lại'
                      : timed ? 'Đăng ngay (bỏ hẹn giờ)'
                        : detail.scheduleQueued ? 'Đăng ngay (bỏ khung giờ)' : tally.total > 1 ? `Duyệt & đăng lên ${tally.total} Page` : 'Duyệt & đăng ngay'}
                </button>
              )}
              {(canTime || timed) &&
                (timing ? (
                  <SchedulePicker
                    initial={timed ? detail.scheduledAt : null}
                    busy={acting}
                    confirmLabel={timed ? 'Đổi giờ đăng' : 'Hẹn giờ đăng'}
                    onConfirm={(iso) => void scheduleAt(detail.id, iso)}
                    onCancel={() => setTiming(false)}
                  />
                ) : (
                  <button type="button" className="btn btn-secondary btn-block" onClick={() => setTiming(true)} disabled={acting}>
                    <CalendarClock size={15} aria-hidden="true" /> {timed ? 'Đổi giờ đăng' : 'Hẹn giờ đăng'}
                  </button>
                ))}
              {timed && (
                <button type="button" className="btn btn-ghost btn-block" onClick={() => void cancelTimed(detail.id)} disabled={acting}>
                  Huỷ hẹn giờ
                </button>
              )}
```

- [ ] **Step 5: Typecheck, lint, build**

Run (from `client/`): `npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b && npm run lint && npx -y -p node@22 -- node node_modules/vite/bin/vite.js build`
Expected: typecheck clean; lint shows no new warning beyond the four existing `react-hooks(exhaustive-deps)` ones in `PostsPage.tsx`; build ends with `✓ built in …`.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/PostsPage.tsx
git commit -m "feat(client): time, move, cancel and publish now in the posts inspector"
```

---

### Task 6: Docs and whole-feature verification

**Files:**
- Modify: `CLAUDE.md` (the job-handler list under "Job queue in MariaDB, no Redis"), `ROADMAP.md` (Phase 2, after the line that starts `- ✅ (2026-09-30) Lịch theo thứ`), `docs/DEPLOY_HOSTINGER.md` (§3, after check 7)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: `CLAUDE.md`**

After the bullet that starts `- \`publish_target\` (\`runTargetJob\`)`, add:

```markdown
- Timed posts ("Hẹn giờ đăng", `POST`/`DELETE /api/posts/:id/schedule`): a post outside any slot schedule with `status = SCHEDULED`, `scheduleQueued = false`, `scheduledAt` = the chosen time. Each (re)scheduling books a delayed `publish_post` job whose payload carries `scheduledFor`; `runPublishJob` takes the post only while it still waits for exactly that time (`src/lib/post-timing.ts` `claimTimedPost`), so jobs of an earlier time, a cancelled time or a post published by hand do nothing — never delete or dedupe those jobs instead.
```

- [ ] **Step 2: `ROADMAP.md`**

After the line that starts `- ✅ (2026-09-30) Lịch theo thứ + 1–3 khung giờ`, add (use the real completion date):

```markdown
- ✅ (2026-10-02) Hẹn giờ đăng cho bài lẻ (không cần tạo lịch): chọn ngày giờ ở trang Tạo bài hoặc trong chi tiết bài; đổi giờ, huỷ hẹn giờ, đăng ngay — plan docs/superpowers/plans/2026-10-02-timed-posts.md
```

- [ ] **Step 3: `docs/DEPLOY_HOSTINGER.md`**

In §3 "Kiểm tra sau deploy", after item 7 add:

```markdown
8. **Hẹn giờ đăng**: mở một bài "Chờ duyệt" → **Hẹn giờ đăng** → chọn giờ sau hiện tại vài phút → bài chuyển sang "Đã lên lịch" và tự đăng đúng giờ (cần Cron Job ở mục 4). Thử **Đổi giờ đăng** và **Huỷ hẹn giờ** trên một bài khác.
```

- [ ] **Step 4: Full suite**

Stop any local dev server first, start MariaDB (`docker compose up -d`), then run:

`npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run`
Expected: typecheck clean; every test file passes (the count grows by the tests of Tasks 1–3; none skipped).

- [ ] **Step 5: Look at it in the browser**

Start the API and the client (`npm run dev`, and the Vite command from `CLAUDE.md`), sign in, then check at 1366px and at 390px wide:

1. **Tạo bài**: write a post → **Hẹn giờ đăng** opens the picker with the next full hour → pick a time **tomorrow** → toast "Đã hẹn giờ — bài sẽ đăng lúc …" and the Bài đăng page opens on that post.
2. **Bài đăng**: the post is under "Đã lên lịch"; the inspector shows "Hẹn giờ đăng: …", **Đăng ngay (bỏ hẹn giờ)**, **Đổi giờ đăng**, **Huỷ hẹn giờ**.
3. **Đổi giờ đăng** → another time → the note and the row show the new time without reloading the page.
4. Typing a past time shows "Giờ đăng phải sau hiện tại ít nhất 1 phút." and disables the button.
5. **Huỷ hẹn giờ** → the post is back under "Chờ duyệt" with **Duyệt & đăng ngay** and **Hẹn giờ đăng**.
6. A post that belongs to a slot schedule shows no **Hẹn giờ đăng** button.

Use a time at least a day ahead and cancel it at the end: a local server publishes for real when a time comes.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md ROADMAP.md docs/DEPLOY_HOSTINGER.md
git commit -m "docs: timed posts"
```

---

## Out of scope

- Timing a post that belongs to a slot schedule (decision 5).
- A calendar view of timed posts, repeating a timed post, or bulk timing several posts at once.
- A menu entry in the ⋯ row menu: the inspector (one tap on the row) already has the button.
- Removing jobs of earlier times from the `jobs` table: they are no-ops and the queue's own cleanup removes finished jobs.
