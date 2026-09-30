# Màn hình Bài đăng: "Content Operations" redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Posts list (`/posts`) into a compact, modern content-operations list:
- each row has a title and a 2-line preview, light metadata, a clear status, and Page publish progress with a per-Page popover;
- a ⋯ action menu, plus inline "Sửa / Duyệt & đăng" for posts waiting for approval;
- a small overview line, status tabs (including "Đã lên lịch"), and search / Page / domain / time filters.

**Architecture:**
- The page keeps its split view: the list on the left and the existing inspector (preview, history, publish buttons) on the right. Only the list side is redesigned.
- Pure display logic lives in two `.ts` files under `client/src/lib/`: title/preview split, progress label, short error, hashtags, time range, overview counts, and status → badge mapping. They are unit-tested from the root Vitest suite, since the client has no test runner.
- The UI is split into small components: `PostListItem`, `PostActionsMenu`, `PostPublishProgress`, `PostFilters`, `PostsOverview`.
- The server gets one additive change: the list response includes each Page target's `page { id, pageName }` and `errorMessage`.

**Tech Stack:** React 19 + Vite 8 + TypeScript; plain CSS with the tokens in `client/src/index.css`; `lucide-react` icons; Express + Prisma for the one backend change; Vitest (root) for tests.

**Spec:** `CR/change_ui.md` (the change request). Read it together with the **Quyết định** section below, which records what the current backend can and cannot support.

## Quyết định

1. **Keep the split view and the inspector.** Publishing, approval and history already live in the inspector. The CR says "không thay đổi chức năng publish" and "không ảnh hưởng màn hình khác". Only the list column, header, overview and filters are redesigned. "Xem chi tiết" in the menu selects the post, which opens it in the inspector.
2. **One additive backend change (needs the user's OK, since the CR says to flag it):**
   - `GET /api/posts` returns `targets: [{ status, errorMessage, page: { id, pageName } }]` instead of `targets: [{ status }]`.
   - It is the same endpoint with no schema change or migration, and existing fields are unchanged.
   - Without it, the per-Page popover and the Page filter would need one extra request per post.
3. **Not built, because the backend has no data (reported to the user, no fake UI):**
   - engagement (👍 💬 ↗);
   - comment counts / "cần trả lời" / the comment drawer;
   - "Xem bình luận" and "Nhân bản bài" (no API).

   An empty component that can never render is dead code, so none is added. The row layout leaves a slot (`post-item-stats`) where engagement can go when the data exists.
4. **Menu actions = only what exists today:**
   - Xem chi tiết (select);
   - Sửa bài (`EditPostModal`, statuses DRAFT/READY/FAILED/SCHEDULED, not live on any Page);
   - Xem trên Facebook (`fbPermalink`);
   - Duyệt & đăng (READY, not from a schedule → `POST /publish`);
   - Duyệt (READY from a schedule → `POST /approve`);
   - Đăng lại (FAILED → `POST /publish`);
   - Xoá (not PUBLISHING).

   "Tạo lại ảnh / nội dung" are reachable through Sửa bài (the modal has "Tạo lại bằng AI" and the quick rewrites), so they are not duplicated in the menu. Publishing and deleting keep the existing two-step confirmation ("Bấm lần nữa…").
5. **Status colours** (CR §7), applied through the shared `StatusBadge`, so the Dashboard gets the same colours:
   - DRAFT: gray;
   - READY: amber (was blue);
   - SCHEDULED: blue;
   - PUBLISHED: green;
   - FAILED: red;
   - GENERATING/PUBLISHING (in progress): blue with the pulsing dot (was amber).
6. **Filters run on the loaded list**, like the status tabs and search today (the 50 most recent posts). The domain filter keeps asking the API.
   - **Page filter:** listed only when the loaded posts use more than one Page. A post matches if any of its targets, or its main Page, is that Page.
   - **Time filter:** Mọi lúc / Hôm nay / 7 ngày qua / 30 ngày qua, applied to `publishedAt ?? scheduledAt ?? createdAt`. "Hôm nay" is the device's local day. Future scheduled posts count as inside the range.
7. **Title/preview:**
   - Title = the first non-empty line. If it is longer than 110 characters, cut it at the first sentence end within the limit, or else at a word boundary with "…".
   - Preview = the rest of the caption, with whitespace collapsed.
   - Stored data is never changed.
8. **Publish progress copy** (only for posts with more than one Page; a single Page is already clear from the badge):
   - "Đã đăng n/n" when all Pages are published;
   - "k/n thành công" when some failed;
   - "Đang đăng k/n" while in progress;
   - "n Page" before publishing.

   The popover lists each Page with ✓ / ✕ / … and a short error. Errors are mapped to "Token hết hạn", "Thiếu quyền", "Token của App cũ" or "Đăng thất bại"; the full message shows as a tooltip.
9. **Tabs**, in the CR's order: Tất cả, Nháp, Chờ duyệt, Đã lên lịch, Đã đăng, Lỗi.
   - Counts follow every filter except the status tab.
   - The overview line uses the same counts: total, published, waiting for approval; scheduled and failed only when not zero.
10. **"Bỏ 'n từ'"**: the word count leaves the list. The inspector is unchanged.

## Global Constraints

- UI copy is in Vietnamese; code and comments in English.
- Do not change authentication, the publish/approve behaviour, existing endpoints' paths or the database schema.
- Only the Posts list screen and components/styles it uses directly. The shared `StatusBadge` colours are the one intended cross-screen change (Decision 5).
- Reuse `client/src/index.css` tokens and classes: `--text-*`, `--bg-*`, `--border-*`, `--primary-*`, `--success-*`, `--warning-*`, `--error-*`, `--info-*`, `--radius-*`, `.badge-*`, `.btn`, `.form-select`, `.topbar-search`, `.filter-tab`. No new colours beyond status colours, no gradients, no heavy shadows.
- TypeScript: no `any` in new code.
- Accessibility: every icon-only button and menu has an `aria-label`; menus work with the keyboard (Enter/Space open, ↑/↓ move, Esc closes); truncated text has a `title`.
- Must work at desktop, tablet and phone widths (1400, 1024, 768, 390 px) without horizontal scroll.
- The client needs Node ≥ 22.12: run client tools through `npx -y -p node@22`.
- Public repo: stage files by name; never commit `.env*`, `prompt_creator_video.md`, `bugs/`, `CR/`. Check the branch before committing.

## Review Focus

1. **A caption with no line breaks and no sentence end** (one long paragraph) → the title is cut at a word boundary with "…" and the preview is the rest, never an empty title or a duplicate of the title. Test in Task 2.
2. **Old posts without targets** (created before multi-Page) or with `targets` missing → no progress chip, no crash; the Page filter still matches through `post.page`. Tests in Task 2 and Task 4.
3. **Clicking the ⋯ menu or an inline button on a row** → performs only that action and does not also select the row or open the inspector twice. Checked in the Task 5 browser run.
4. **A narrow list column** (tablet, or the 420 px inspector on a 1280 px screen) → status, time and actions move under the text instead of squeezing it. Checked in the Task 5 browser run.
5. **Search, Page, domain, time and status all combined** → counts and the list stay consistent (tab counts ignore only the status tab). Test in Task 2.

---

### Task 1: The list API returns each Page's name and error

**Files:**
- Modify: `src/routes/posts.routes.ts` (list `select`, currently `targets: { select: { status: true } }`)
- Test: `tests/posts-list.db.test.ts` (new)

**Interfaces:**
- Produces: `GET /api/posts` → each item has `targets: Array<{ status: 'PENDING'|'PUBLISHING'|'PUBLISHED'|'FAILED'; errorMessage: string | null; page: { id: string; pageName: string } }>`, ordered by creation.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;

describe.skipIf(!process.env.RUN_DB_TESTS)('posts list', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it("returns each Page's name and error, so the list can show per-Page progress", async () => {
    const { user, cookie } = await createTestUser();
    const mk = (n: string) =>
      prisma.facebookPage.create({ data: { userId: user.id, pageId: `PL_${n}_${Date.now()}`, pageName: `Trang ${n}`, pageAccessToken: 'EAAfaketokenpostslistxxxxxxxxxxxxxx' } });
    const [a, b] = [await mk('A'), await mk('B')];
    await prisma.post.create({
      data: {
        userId: user.id,
        pageId: a.id,
        caption: 'Bài hai Page',
        status: 'FAILED',
        targets: {
          create: [
            { pageId: a.id, status: 'PUBLISHED' },
            { pageId: b.id, status: 'FAILED', errorMessage: 'Error validating access token: Session has expired' },
          ],
        },
      },
    });
    const res = await api(server.baseUrl, 'GET', '/api/posts', { cookie });
    expect(res.status).toBe(200);
    const targets = res.json.data[0].targets;
    expect(targets).toEqual([
      { status: 'PUBLISHED', errorMessage: null, page: { id: a.id, pageName: 'Trang A' } },
      { status: 'FAILED', errorMessage: 'Error validating access token: Session has expired', page: { id: b.id, pageName: 'Trang B' } },
    ]);
  });
});
```

- [ ] **Step 2: Run it, see it fail**

Run: `RUN_DB_TESTS=1 npx vitest run tests/posts-list.db.test.ts`
Expected: FAIL. The targets only have `{ status }`.

- [ ] **Step 3: Change the list `select` in `src/routes/posts.routes.ts`**

Replace `targets: { select: { status: true } },` in the list route with:

```ts
          // Per-Page progress in the list (name + short error in a popover)
          targets: {
            select: { status: true, errorMessage: true, page: { select: { id: true, pageName: true } } },
            orderBy: { createdAt: 'asc' },
          },
```

- [ ] **Step 4: Run it, see it pass; run the isolation suite (the list must still show only the caller's data)**

Run: `RUN_DB_TESTS=1 npx vitest run tests/posts-list.db.test.ts tests/isolation.db.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/routes/posts.routes.ts tests/posts-list.db.test.ts
git commit -m "feat(posts): list returns each Page's name and error for per-Page progress"
```

---

### Task 2: Pure display helpers and status colours

**Files:**
- Create: `client/src/lib/post-display.ts`, `client/src/lib/post-status.ts`
- Modify: `client/src/components/PostBits.tsx` (`STATUS_META` moves to `post-status.ts`; `postTitle` delegates to `splitCaption`), `client/src/index.css` (badge colours)
- Test: `tests/post-display.test.ts` (root Vitest imports the client's pure files)

**Interfaces:**
- Produces (`client/src/lib/post-display.ts`):
  - `type TargetStatus = 'PENDING' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED'`
  - `interface TargetSummary { status: TargetStatus; errorMessage?: string | null; page?: { id: string; pageName: string } | null }`
  - `splitCaption(caption: string | null | undefined, maxTitle?: number): { title: string; preview: string }`
  - `publishProgress(targets: TargetSummary[] | undefined): { label: string; tone: 'success' | 'error' | 'progress' | 'neutral' } | null`
  - `shortError(message: string | null | undefined): string`
  - `visibleTags(tags: string[] | null | undefined, max?: number): { shown: string[]; more: number }`
  - `type TimeRange = '' | 'today' | '7d' | '30d'`, `inTimeRange(iso: string, range: TimeRange, now?: Date): boolean`
  - `interface ListPost { status: string; caption: string | null; publishedAt: string | null; scheduledAt: string | null; createdAt: string; page?: { id: string } | null; targets?: TargetSummary[]; domain?: { id: string } | null }`
  - `postTime(p: ListPost): string`
  - `matchesFilters(p: ListPost, f: { q: string; pageId: string; time: TimeRange }, now?: Date): boolean`
  - `statusCounts(posts: ListPost[]): Record<string, number>`, where key `''` = total.
- Produces (`client/src/lib/post-status.ts`): `STATUS_META: Record<string, { label: string; cls: string }>`, `statusMeta(status: string)`.

- [ ] **Step 1: Write the failing tests `tests/post-display.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import {
  splitCaption,
  publishProgress,
  shortError,
  visibleTags,
  inTimeRange,
  matchesFilters,
  statusCounts,
  type ListPost,
} from '../client/src/lib/post-display';
import { statusMeta } from '../client/src/lib/post-status';

describe('splitCaption', () => {
  it('first line is the title, the rest is the preview', () => {
    expect(splitCaption('AI Agent 24/7: từ chatbot thành "nhân viên AI"\n\nThay vì chỉ hỏi chatbot từng câu,\nAI Agent tự xử lý.')).toEqual({
      title: 'AI Agent 24/7: từ chatbot thành "nhân viên AI"',
      preview: 'Thay vì chỉ hỏi chatbot từng câu, AI Agent tự xử lý.',
    });
  });

  it('a long first line is cut at the first sentence end, the rest goes to the preview', () => {
    const text = 'Sau một cuộc họp dài, việc đọc lại biên bản rất tốn thời gian. Thủ thuật AI này giúp bạn biến biên bản thành việc cần làm chỉ trong vài giây nhờ một câu lệnh ngắn.';
    const { title, preview } = splitCaption(text);
    expect(title).toBe('Sau một cuộc họp dài, việc đọc lại biên bản rất tốn thời gian.');
    expect(preview.startsWith('Thủ thuật AI này')).toBe(true);
  });

  it('one long paragraph without a sentence end is cut at a word with "…", never empty or duplicated', () => {
    const text = 'từ '.repeat(80).trim();
    const { title, preview } = splitCaption(text);
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(111);
    expect(preview.length).toBeGreaterThan(0);
    expect(preview).not.toBe(title);
  });

  it('empty caption → empty title and preview', () => {
    expect(splitCaption(null)).toEqual({ title: '', preview: '' });
  });
});

describe('publishProgress', () => {
  const t = (status: 'PENDING' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED') => ({ status });
  it('says nothing for one Page or no targets', () => {
    expect(publishProgress([t('PUBLISHED')])).toBeNull();
    expect(publishProgress(undefined)).toBeNull();
  });
  it('reads like a person would say it', () => {
    expect(publishProgress([t('PUBLISHED'), t('PUBLISHED'), t('PUBLISHED'), t('PUBLISHED')])).toEqual({ label: 'Đã đăng 4/4', tone: 'success' });
    expect(publishProgress([t('PUBLISHED'), t('PUBLISHED'), t('PUBLISHED'), t('FAILED')])).toEqual({ label: '3/4 thành công', tone: 'error' });
    expect(publishProgress([t('PUBLISHED'), t('PUBLISHING'), t('PENDING')])).toEqual({ label: 'Đang đăng 1/3', tone: 'progress' });
    expect(publishProgress([t('PENDING'), t('PENDING')])).toEqual({ label: '2 Page', tone: 'neutral' });
  });
});

describe('shortError', () => {
  it('maps Facebook errors to short Vietnamese labels', () => {
    expect(shortError('Error validating access token: Session has expired')).toBe('Token hết hạn');
    expect(shortError('(#200) Requires pages_manage_posts permission')).toBe('Thiếu quyền');
    expect(shortError('Token do Facebook App khác cấp (123).')).toBe('Token của App cũ');
    expect(shortError('Something odd')).toBe('Đăng thất bại');
    expect(shortError(null)).toBe('Đăng thất bại');
  });
});

describe('visibleTags', () => {
  it('shows two hashtags and counts the rest', () => {
    expect(visibleTags(['AIAgent', '#TuDongHoa', 'AI', 'X'])).toEqual({ shown: ['#AIAgent', '#TuDongHoa'], more: 2 });
    expect(visibleTags(null)).toEqual({ shown: [], more: 0 });
  });
});

describe('inTimeRange', () => {
  const now = new Date(2026, 8, 30, 15, 0); // local time
  it('today, 7 and 30 days, and future scheduled posts', () => {
    expect(inTimeRange(new Date(2026, 8, 30, 1, 0).toISOString(), 'today', now)).toBe(true);
    expect(inTimeRange(new Date(2026, 8, 29, 23, 0).toISOString(), 'today', now)).toBe(false);
    expect(inTimeRange(new Date(2026, 8, 24, 16, 0).toISOString(), '7d', now)).toBe(true);
    expect(inTimeRange(new Date(2026, 8, 20, 0, 0).toISOString(), '7d', now)).toBe(false);
    expect(inTimeRange(new Date(2026, 9, 3, 8, 0).toISOString(), '7d', now)).toBe(true); // scheduled ahead
    expect(inTimeRange('2020-01-01T00:00:00Z', '', now)).toBe(true);
  });
});

describe('matchesFilters and statusCounts', () => {
  const base = { publishedAt: null, scheduledAt: null, createdAt: '2026-09-30T05:00:00Z', domain: null };
  const posts: ListPost[] = [
    { ...base, status: 'PUBLISHED', caption: 'Rầy nâu trên lúa', page: { id: 'p1' }, targets: [{ status: 'PUBLISHED', page: { id: 'p1', pageName: 'A' } }, { status: 'PUBLISHED', page: { id: 'p2', pageName: 'B' } }] },
    { ...base, status: 'READY', caption: 'Sâu tơ trên rau', page: { id: 'p1' } }, // old post: no targets
    { ...base, status: 'READY', caption: 'Rầy nâu mùa mưa', page: { id: 'p3' }, targets: [{ status: 'PENDING', page: { id: 'p3', pageName: 'C' } }] },
  ];
  const now = new Date('2026-09-30T08:00:00Z');

  it('a secondary Page matches, and old posts match through their main Page', () => {
    expect(posts.filter((p) => matchesFilters(p, { q: '', pageId: 'p2', time: '' }, now))).toHaveLength(1);
    expect(posts.filter((p) => matchesFilters(p, { q: '', pageId: 'p1', time: '' }, now))).toHaveLength(2);
  });

  it('search + Page combine; counts ignore only the status tab', () => {
    const shown = posts.filter((p) => matchesFilters(p, { q: 'rầy', pageId: 'p3', time: '' }, now));
    expect(shown).toHaveLength(1);
    expect(statusCounts(posts.filter((p) => matchesFilters(p, { q: 'rầy', pageId: '', time: '' }, now)))).toEqual({ '': 2, PUBLISHED: 1, READY: 1 });
  });
});

describe('statusMeta', () => {
  it('uses the agreed status colours', () => {
    expect(statusMeta('DRAFT').cls).toBe('badge-draft');
    expect(statusMeta('READY')).toEqual({ label: 'Chờ duyệt', cls: 'badge-ready' });
    expect(statusMeta('SCHEDULED').cls).toBe('badge-scheduled');
    expect(statusMeta('PUBLISHED').cls).toBe('badge-published');
    expect(statusMeta('FAILED').cls).toBe('badge-failed');
    expect(statusMeta('WHATEVER')).toEqual({ label: 'WHATEVER', cls: 'badge-draft' });
  });
});
```

- [ ] **Step 2: Run it, see it fail**

Run: `npx vitest run tests/post-display.test.ts`
Expected: FAIL. Cannot find module `../client/src/lib/post-display`.

- [ ] **Step 3: Create `client/src/lib/post-status.ts`**

```ts
/** One place for status wording and badge class, so every screen says the same thing (pure: tested from the root suite). */
export const STATUS_META: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Nháp', cls: 'badge-draft' },
  GENERATING: { label: 'Đang tạo…', cls: 'badge-generating' },
  READY: { label: 'Chờ duyệt', cls: 'badge-ready' },
  SCHEDULED: { label: 'Đã lên lịch', cls: 'badge-scheduled' },
  PUBLISHING: { label: 'Đang đăng…', cls: 'badge-publishing' },
  PUBLISHED: { label: 'Đã đăng', cls: 'badge-published' },
  FAILED: { label: 'Lỗi', cls: 'badge-failed' },
};

export const statusMeta = (status: string) => STATUS_META[status] ?? { label: status, cls: 'badge-draft' };
```

- [ ] **Step 4: Create `client/src/lib/post-display.ts`**

```ts
/** Pure display helpers for the Posts list (no React, no DOM): tested from tests/post-display.test.ts. */

export type TargetStatus = 'PENDING' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED';

export interface TargetSummary {
  status: TargetStatus;
  errorMessage?: string | null;
  page?: { id: string; pageName: string } | null;
}

export interface ListPost {
  status: string;
  caption: string | null;
  publishedAt: string | null;
  scheduledAt: string | null;
  createdAt: string;
  page?: { id: string } | null;
  targets?: TargetSummary[];
  domain?: { id: string } | null;
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Title = first line (cut at a sentence end or a word when long); preview = everything after it. */
export function splitCaption(caption: string | null | undefined, maxTitle = 110): { title: string; preview: string } {
  const text = (caption ?? '').trim();
  if (!text) return { title: '', preview: '' };
  const lines = text.split('\n');
  const firstIndex = lines.findIndex((l) => l.trim());
  const first = lines[firstIndex].trim();
  const after = lines.slice(firstIndex + 1).join(' ');
  if (first.length <= maxTitle) return { title: first, preview: collapse(after) };

  // A sentence end inside the limit (". ", "! ", "? ", "… ")
  const sentence = first.slice(0, maxTitle + 1).match(/^.*?[.!?…](?=\s|$)/);
  if (sentence && sentence[0].length >= 20) {
    return { title: sentence[0].trim(), preview: collapse(`${first.slice(sentence[0].length)} ${after}`) };
  }
  const cut = first.lastIndexOf(' ', maxTitle);
  const at = cut > 20 ? cut : maxTitle;
  return { title: `${first.slice(0, at).trim()}…`, preview: collapse(`${first.slice(at)} ${after}`) };
}

/** Multi-Page progress wording; null when a single Page (the status badge says it all). */
export function publishProgress(targets: TargetSummary[] | undefined): { label: string; tone: 'success' | 'error' | 'progress' | 'neutral' } | null {
  if (!targets || targets.length <= 1) return null;
  const n = targets.length;
  const published = targets.filter((t) => t.status === 'PUBLISHED').length;
  const failed = targets.filter((t) => t.status === 'FAILED').length;
  const moving = targets.some((t) => t.status === 'PUBLISHING') || (published > 0 && published + failed < n);
  if (failed > 0 && !moving) return { label: `${published}/${n} thành công`, tone: 'error' };
  if (published === n) return { label: `Đã đăng ${n}/${n}`, tone: 'success' };
  if (moving) return { label: `Đang đăng ${published}/${n}`, tone: 'progress' };
  return { label: `${n} Page`, tone: 'neutral' };
}

/** Facebook / app error → a few words (the full text goes in a tooltip). */
export function shortError(message: string | null | undefined): string {
  const m = message ?? '';
  if (/App khác|app cũ|OTHER_APP/i.test(m)) return 'Token của App cũ';
  if (/token|expired|hết hạn|session/i.test(m)) return 'Token hết hạn';
  if (/permission|quyền/i.test(m)) return 'Thiếu quyền';
  return 'Đăng thất bại';
}

export function visibleTags(tags: string[] | null | undefined, max = 2): { shown: string[]; more: number } {
  const clean = (tags ?? []).map((t) => t.trim().replace(/^#+/, '')).filter(Boolean);
  return { shown: clean.slice(0, max).map((t) => `#${t}`), more: Math.max(0, clean.length - max) };
}

export type TimeRange = '' | 'today' | '7d' | '30d';
export const TIME_RANGES: Array<{ value: TimeRange; label: string }> = [
  { value: '', label: 'Mọi lúc' },
  { value: 'today', label: 'Hôm nay' },
  { value: '7d', label: '7 ngày qua' },
  { value: '30d', label: '30 ngày qua' },
];

/** From the start of the range onwards (posts scheduled ahead count as inside). */
export function inTimeRange(iso: string, range: TimeRange, now = new Date()): boolean {
  if (!range) return true;
  const start = new Date(now);
  if (range === 'today') start.setHours(0, 0, 0, 0);
  else start.setTime(now.getTime() - (range === '7d' ? 7 : 30) * 24 * 3600_000);
  return new Date(iso).getTime() >= start.getTime();
}

/** The time a post is "about": published, else its slot, else creation */
export const postTime = (p: ListPost) => p.publishedAt ?? p.scheduledAt ?? p.createdAt;

export function matchesFilters(p: ListPost, f: { q: string; pageId: string; time: TimeRange }, now = new Date()): boolean {
  const needle = f.q.trim().toLowerCase();
  if (needle && !(p.caption ?? '').toLowerCase().includes(needle)) return false;
  if (f.pageId && p.page?.id !== f.pageId && !p.targets?.some((t) => t.page?.id === f.pageId)) return false;
  return inTimeRange(postTime(p), f.time, now);
}

/** '' = all; one key per status present */
export function statusCounts(posts: ListPost[]): Record<string, number> {
  const c: Record<string, number> = { '': posts.length };
  for (const p of posts) c[p.status] = (c[p.status] ?? 0) + 1;
  return c;
}
```

- [ ] **Step 5: Run the tests, see them pass**

Run: `npx vitest run tests/post-display.test.ts`
Expected: PASS. If the "long first line" case cuts differently, fix the helper, not the test: the rule is Decision 7.

- [ ] **Step 6: Wire `PostBits.tsx` to the pure helpers**
- Delete the local `STATUS_META`. Import `{ STATUS_META, statusMeta } from '../lib/post-status'`, re-export `STATUS_META` (`export { STATUS_META };`) so existing imports keep working.
- In `StatusBadge`, use `const meta = statusMeta(status);`.
- `postTitle(caption)` becomes `return splitCaption(caption).title;` (import from `../lib/post-display`). The Dashboard keeps working and gets the same titles.

- [ ] **Step 7: Status colours in `client/src/index.css`** (Decision 5): replace the lines

```css
.badge-ready, .badge-scheduled { background: var(--info-bg); color: var(--info-text); }
```
and
```css
.badge-generating, .badge-publishing { background: var(--warning-bg); color: var(--warning-400); }
```
with
```css
.badge-scheduled { background: var(--info-bg); color: var(--info-text); }
/* Waiting for a person: amber */
.badge-ready { background: var(--warning-bg); color: var(--warning-400); }
/* Work in progress: blue with a pulsing dot */
.badge-generating, .badge-publishing { background: var(--info-bg); color: var(--info-text); }
```

- [ ] **Step 8: Typecheck the client and run the tests**

Run: `npx vitest run tests/post-display.test.ts && (cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b)`
Expected: PASS; tsc clean.

- [ ] **Step 9: Commit**

```bash
git add client/src/lib/post-display.ts client/src/lib/post-status.ts client/src/components/PostBits.tsx client/src/index.css tests/post-display.test.ts
git commit -m "feat(client): post display helpers (title/preview, progress, filters) and agreed status colours"
```

---

### Task 3: Action menu and publish-progress popover components

**Files:**
- Create: `client/src/components/PostActionsMenu.tsx`, `client/src/components/PostPublishProgress.tsx`
- Modify: `client/src/index.css` (menu and popover styles)

**Interfaces:**
- Consumes: `publishProgress`, `shortError`, `TargetSummary` (Task 2).
- Produces:
  - `interface MenuAction { key: string; label: string; icon?: ReactNode; onSelect?: () => void; href?: string; danger?: boolean; confirmLabel?: string }`
  - `<PostActionsMenu label: string; actions: MenuAction[] />`. `confirmLabel` = first select changes the item's text; the second runs it.
  - `<PostPublishProgress targets?: TargetSummary[] />`, which renders nothing when `publishProgress` returns null.

There is no client test runner: these are verified by typecheck and the browser checks in Task 5 (keyboard, Esc, outside click, two-step confirm, popover content).

- [ ] **Step 1: `client/src/components/PostActionsMenu.tsx`**

```tsx
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';

export interface MenuAction {
  key: string;
  label: string;
  icon?: ReactNode;
  /** Runs the action (buttons) */
  onSelect?: () => void;
  /** Opens a link in a new tab instead (e.g. Xem trên Facebook) */
  href?: string;
  danger?: boolean;
  /** Two-step: the first select shows this text, the second runs the action */
  confirmLabel?: string;
}

/** "⋯" menu for one post. Keyboard: Enter/Space opens, ↑/↓ move, Esc closes and returns focus. */
export default function PostActionsMenu({ label, actions }: { label: string; actions: MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const [arming, setArming] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const items = () => [...(rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  const close = (focusTrigger = true) => {
    setOpen(false);
    setArming(null);
    if (focusTrigger) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>) {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    }
  }

  function run(a: MenuAction) {
    if (a.confirmLabel && arming !== a.key) return setArming(a.key);
    a.onSelect?.();
    close();
  }

  if (!actions.length) return null;
  return (
    <div className="actions-menu" ref={rootRef} onKeyDown={onMenuKey} onClick={(e) => e.stopPropagation()}>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-ghost btn-icon btn-sm"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <MoreHorizontal size={17} aria-hidden="true" />
      </button>
      {open && (
        <div className="actions-menu-list" role="menu" id={menuId} aria-label={label}>
          {actions.map((a) =>
            a.href ? (
              <a key={a.key} role="menuitem" tabIndex={-1} className="actions-menu-item" href={a.href} target="_blank" rel="noreferrer" onClick={() => close()}>
                {a.icon}
                {a.label}
              </a>
            ) : (
              <button key={a.key} type="button" role="menuitem" tabIndex={-1} className={`actions-menu-item ${a.danger ? 'danger' : ''}`} onClick={() => run(a)}>
                {a.icon}
                {arming === a.key ? a.confirmLabel : a.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: `client/src/components/PostPublishProgress.tsx`**

```tsx
import { useState } from 'react';
import { Check, X, Loader } from 'lucide-react';
import { publishProgress, shortError, type TargetSummary } from '../lib/post-display';

/** "Đã đăng 4/4" / "3/4 thành công" with a per-Page popover on hover or focus (multi-Page posts only). */
export default function PostPublishProgress({ targets }: { targets?: TargetSummary[] }) {
  const [open, setOpen] = useState(false);
  const progress = publishProgress(targets);
  if (!progress || !targets) return null;
  const withNames = targets.some((t) => t.page);

  return (
    <span className="publish-progress" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className={`progress-chip tone-${progress.tone}`}
        aria-expanded={withNames ? open : undefined}
        aria-label={`${progress.label}${withNames ? ' — xem từng Page' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onBlur={() => setOpen(false)}
      >
        {progress.label}
      </button>
      {open && withNames && (
        <span className="progress-popover" role="tooltip">
          {targets.map((t, i) => (
            <span key={t.page?.id ?? i} className={`progress-line status-${t.status.toLowerCase()}`} title={t.errorMessage ?? undefined}>
              {t.status === 'PUBLISHED' ? <Check size={13} aria-hidden="true" /> : t.status === 'FAILED' ? <X size={13} aria-hidden="true" /> : <Loader size={13} aria-hidden="true" />}
              <span className="progress-page">{t.page?.pageName ?? 'Page'}</span>
              {t.status === 'FAILED' && <span className="progress-error">{shortError(t.errorMessage)}</span>}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
```

- [ ] **Step 3: CSS (append to `client/src/index.css`)**

```css
/* ─── Posts list: actions menu + publish progress ─── */
.actions-menu { position: relative; display: inline-flex; }
.actions-menu-list { position: absolute; right: 0; top: calc(100% + 4px); z-index: 30; min-width: 190px; padding: 4px; background: var(--bg-card); border: 1px solid var(--border-default); border-radius: var(--radius-md); box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08); display: flex; flex-direction: column; }
.actions-menu-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border: 0; background: none; border-radius: var(--radius-sm); font-size: 13.5px; color: var(--text-primary); text-align: left; cursor: pointer; text-decoration: none; white-space: nowrap; }
.actions-menu-item:hover, .actions-menu-item:focus-visible { background: var(--bg-secondary); outline: none; }
.actions-menu-item.danger { color: var(--error-500); }
.publish-progress { position: relative; display: inline-flex; }
.progress-chip { border: 0; background: none; padding: 0; font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; cursor: default; color: var(--text-secondary); }
.progress-chip.tone-success { color: var(--success-text); }
.progress-chip.tone-error { color: var(--error-500); cursor: pointer; }
.progress-chip.tone-progress { color: var(--info-text); }
.progress-chip:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; border-radius: 4px; }
.progress-popover { position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; min-width: 220px; padding: 8px 10px; background: var(--bg-card); border: 1px solid var(--border-default); border-radius: var(--radius-md); box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08); display: flex; flex-direction: column; gap: 5px; }
.progress-line { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-primary); }
.progress-line.status-published svg { color: var(--success-text); }
.progress-line.status-failed svg { color: var(--error-500); }
.progress-page { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.progress-error { color: var(--error-500); font-size: 12px; white-space: nowrap; }
```

Before writing, check the class names used exist in `index.css` (`--info-text`, `--success-text`, `--border-focus`, `.btn-icon`, `.btn-sm`); use the existing ones if named differently.

- [ ] **Step 4: Typecheck**

Run: `cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/PostActionsMenu.tsx client/src/components/PostPublishProgress.tsx client/src/index.css
git commit -m "feat(client): accessible post actions menu and per-Page publish progress popover"
```

---

### Task 4: New list row, header, overview and filters on the Posts page

**Files:**
- Create: `client/src/components/PostListItem.tsx`, `client/src/components/PostFilters.tsx`
- Modify: `client/src/pages/PostsPage.tsx`, `client/src/index.css`

**Interfaces:**
- Consumes:
  - from Task 2: `splitCaption`, `visibleTags`, `postTime`, `matchesFilters`, `statusCounts`, `TIME_RANGES`, `TimeRange`, `TargetSummary`;
  - from Task 3: `PostActionsMenu`, `MenuAction`, `PostPublishProgress`;
  - from PostBits: `StatusBadge`, `PostThumb`, `formatWhen`;
  - `slotLabel` (ScheduleBits); `postsApi.publish/approve/delete`; `EditPostModal`.
- Produces:
  - `<PostListItem post selected onSelect actions inline />`;
  - `<PostFilters q pageId domainId time pages domains onChange />`;
  - `PostsPage` handlers take a post id: `publish(id)`, `approve(id)`, `remove(id)`.

- [ ] **Step 1: `client/src/components/PostListItem.tsx`**

```tsx
import type { ReactNode } from 'react';
import { StatusBadge, PostThumb, formatWhen } from './PostBits';
import PostActionsMenu, { type MenuAction } from './PostActionsMenu';
import PostPublishProgress from './PostPublishProgress';
import { splitCaption, visibleTags, postTime, type TargetSummary } from '../lib/post-display';

export interface ListItemPost {
  id: string;
  caption: string | null;
  imageUrl: string | null;
  videoUrl?: string | null;
  videoKind?: 'FEED' | 'REEL' | null;
  hashtags: string[] | null;
  status: string;
  errorMessage: string | null;
  publishedAt: string | null;
  scheduledAt: string | null;
  createdAt: string;
  scheduleQueued?: boolean;
  schedule?: { id: string; name: string } | null;
  page: { id: string; pageName: string } | null;
  targets?: TargetSummary[];
  domain?: { id: string; name: string } | null;
}

interface Props {
  post: ListItemPost;
  selected: boolean;
  onSelect: () => void;
  actions: MenuAction[];
  /** Direct buttons (e.g. "Sửa" + "Duyệt & đăng" for posts waiting for approval) */
  inline?: ReactNode;
}

/** One post: thumbnail · title + 2-line preview + light metadata · status, progress, time, actions. */
export default function PostListItem({ post: p, selected, onSelect, actions, inline }: Props) {
  const { title, preview } = splitCaption(p.caption);
  const tags = visibleTags(p.hashtags);
  const pageNames = p.targets?.length ? p.targets.map((t) => t.page?.pageName).filter(Boolean).join(', ') : p.page?.pageName;
  const pageLabel = (p.targets?.length ?? 0) > 1 ? `${p.targets!.length} Page` : (pageNames ?? '');
  const when = postTime(p);

  return (
    <article className={`post-item ${selected ? 'selected' : ''}`} aria-current={selected || undefined}>
      <button type="button" className="post-item-open" onClick={onSelect} aria-label={`Xem chi tiết: ${title || 'bài chưa có nội dung'}`}>
        <PostThumb src={p.imageUrl} size={72} video={!!p.videoUrl} />
        <span className="post-item-body">
          <span className={`post-item-title ${title ? '' : 'empty'}`} title={title || undefined}>{title || 'Chưa có nội dung'}</span>
          {p.status === 'FAILED' && p.errorMessage ? (
            <span className="post-item-preview error" title={p.errorMessage}>{p.errorMessage}</span>
          ) : (
            preview && <span className="post-item-preview">{preview}</span>
          )}
          <span className="post-item-meta">
            <span title={pageNames ?? undefined}>{pageLabel}</span>
            {p.domain && <span className="domain-tag">{p.domain.name}</span>}
            {p.scheduleQueued && <span>Theo lịch</span>}
            {p.videoKind === 'REEL' ? <span>Reels</span> : p.videoUrl ? <span>Video</span> : null}
            {tags.shown.length > 0 && (
              <span className="post-item-tags" title={(p.hashtags ?? []).map((h) => `#${h.replace(/^#+/, '')}`).join(' ')}>
                {tags.shown.join(' ')}
                {tags.more ? ` +${tags.more}` : ''}
              </span>
            )}
          </span>
        </span>
      </button>
      <div className="post-item-side">
        <span className="post-item-status">
          <StatusBadge status={p.status} />
          <PostPublishProgress targets={p.targets} />
        </span>
        {/* post-item-stats: engagement / comments go here once the backend provides them */}
        <span className="post-item-time">
          {p.status === 'SCHEDULED' || (p.scheduleQueued && p.scheduledAt && !p.publishedAt) ? `Lên lịch ${formatWhen(p.scheduledAt)}` : formatWhen(when)}
        </span>
        <span className="post-item-actions">
          {inline}
          <PostActionsMenu label={`Thao tác cho bài: ${title || 'chưa có nội dung'}`} actions={actions} />
        </span>
      </div>
    </article>
  );
}
```

- [ ] **Step 2: `client/src/components/PostFilters.tsx`**

```tsx
import { Search } from 'lucide-react';
import type { ContentDomain } from '../api';
import { TIME_RANGES, type TimeRange } from '../lib/post-display';

interface Props {
  q: string;
  pageId: string;
  domainId: string;
  time: TimeRange;
  /** Pages seen in the loaded posts (the filter shows when there is more than one) */
  pages: Array<{ id: string; pageName: string }>;
  domains: ContentDomain[];
  onChange: (key: 'q' | 'page' | 'domain' | 'time', value: string) => void;
}

export default function PostFilters({ q, pageId, domainId, time, pages, domains, onChange }: Props) {
  return (
    <div className="post-filters">
      <label className="topbar-search post-search">
        <Search size={15} aria-hidden="true" />
        <input type="search" placeholder="Tìm bài đăng..." aria-label="Tìm bài đăng" value={q} onChange={(e) => onChange('q', e.target.value)} />
      </label>
      {pages.length > 1 && (
        <select className="form-select select-sm post-filter" aria-label="Lọc theo Page" value={pageId} onChange={(e) => onChange('page', e.target.value)}>
          <option value="">Mọi Page</option>
          {pages.map((p) => (
            <option key={p.id} value={p.id}>{p.pageName}</option>
          ))}
        </select>
      )}
      {domains.length > 1 && (
        <select className="form-select select-sm post-filter" aria-label="Lọc theo lĩnh vực" value={domainId} onChange={(e) => onChange('domain', e.target.value)}>
          <option value="">Mọi lĩnh vực</option>
          {domains.map((d) => (
            <option key={d.id} value={d.id}>{d.name}{d.isArchived ? ' (lưu trữ)' : ''}</option>
          ))}
        </select>
      )}
      <select className="form-select select-sm post-filter" aria-label="Lọc theo thời gian" value={time} onChange={(e) => onChange('time', e.target.value)}>
        {TIME_RANGES.map((t) => (
          <option key={t.value} value={t.value}>{t.label}</option>
        ))}
      </select>
    </div>
  );
}
```

- [ ] **Step 3: `client/src/pages/PostsPage.tsx`: the list side**

1. **Imports.** Add `PostListItem`, `PostFilters`, `type MenuAction`, and `{ matchesFilters, statusCounts, type TimeRange, type TargetSummary }` from `../lib/post-display`. Add icons `Eye, PenLine, ExternalLink, Send, Check, RotateCcw, Trash2, CalendarClock`. Remove the now-unused `wordCount`, and `Search` if it is only used by the old search box.
2. **`PostData.targets`** becomes `TargetSummary[]`. Delete the local `TargetStatus`/`countTargets` if `TARGET_META` and the inspector no longer use them; keep what the inspector still uses.
3. **Tabs** (Decision 9):

```ts
const TABS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Tất cả' },
  { value: 'DRAFT', label: 'Nháp' },
  { value: 'READY', label: 'Chờ duyệt' },
  { value: 'SCHEDULED', label: 'Đã lên lịch' },
  { value: 'PUBLISHED', label: 'Đã đăng' },
  { value: 'FAILED', label: 'Lỗi' },
];
```

4. **Filters from the URL:** `const pageFilter = params.get('page') ?? '';` and `const time = (params.get('time') ?? '') as TimeRange;`.
5. **Replace `counts` / `visible`:**

```ts
  // Every filter but the status tab (tab counts and the overview follow search/Page/time)
  const filtered = useMemo(() => posts.filter((p) => matchesFilters(p, { q, pageId: pageFilter, time })), [posts, q, pageFilter, time]);
  const counts = useMemo(() => statusCounts(filtered), [filtered]);
  const visible = useMemo(() => filtered.filter((p) => !status || p.status === status), [filtered, status]);
  const pageOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of posts) {
      for (const t of p.targets ?? []) if (t.page) seen.set(t.page.id, t.page.pageName);
      if (!p.targets?.length && p.page) seen.set(p.page.id, p.page.pageName);
    }
    return [...seen].map(([id, pageName]) => ({ id, pageName })).sort((a, b) => a.pageName.localeCompare(b.pageName, 'vi'));
  }, [posts]);
```

6. **Handlers take an id** (the inspector passes `selectedId!`). Keep the two-step confirm for the inspector (`confirming`). The list's inline and menu actions confirm themselves (the menu's `confirmLabel`, and an inline "Bấm lần nữa để đăng" state):

```ts
  async function publish(id: string) { /* body of today's publish() with `id` instead of selectedId, without the confirming check */ }
  async function approve(id: string) { /* body of today's approve() with `id` */ }
  async function remove(id: string) { /* body of today's remove() with `id`, without the confirming check; clears the selection if it was `id` */ }
```

In the inspector, keep the confirm step before calling them:

```ts
  const confirmPublish = () => (confirming === 'publish' ? void publish(selectedId!).finally(() => setConfirming(null)) : setConfirming('publish'));
  const confirmRemove = () => (confirming === 'delete' ? void remove(selectedId!).finally(() => setConfirming(null)) : setConfirming('delete'));
```

and use `confirmPublish` / `confirmRemove` / `() => approve(selectedId!)` for the inspector's existing buttons, with no visual change there.

7. **Per-row actions** (Decision 4):

```tsx
  function rowActions(p: PostData): MenuAction[] {
    const live = (p.targets ?? []).some((t) => t.status === 'PUBLISHED');
    const a: MenuAction[] = [{ key: 'open', label: 'Xem chi tiết', icon: <Eye size={15} aria-hidden="true" />, onSelect: () => setSelectedId(p.id) }];
    if (EDITABLE.includes(p.status) && !live) a.push({ key: 'edit', label: 'Sửa bài', icon: <PenLine size={15} aria-hidden="true" />, onSelect: () => setEditingId(p.id) });
    if (p.fbPermalink) a.push({ key: 'fb', label: 'Xem trên Facebook', icon: <ExternalLink size={15} aria-hidden="true" />, href: p.fbPermalink });
    if (p.status === 'READY' && p.scheduleQueued) a.push({ key: 'approve', label: 'Duyệt (đăng theo lịch)', icon: <CalendarClock size={15} aria-hidden="true" />, onSelect: () => void approve(p.id) });
    if (p.status === 'READY' && !p.scheduleQueued && p.caption)
      a.push({ key: 'publish', label: 'Duyệt & đăng', icon: <Send size={15} aria-hidden="true" />, confirmLabel: 'Bấm lần nữa để đăng công khai', onSelect: () => void publish(p.id) });
    if (p.status === 'FAILED' && p.caption) a.push({ key: 'retry', label: 'Đăng lại', icon: <RotateCcw size={15} aria-hidden="true" />, confirmLabel: 'Bấm lần nữa để đăng lại', onSelect: () => void publish(p.id) });
    if (p.status !== 'PUBLISHING')
      a.push({ key: 'delete', label: 'Xoá', icon: <Trash2 size={15} aria-hidden="true" />, danger: true, confirmLabel: 'Bấm lần nữa để xoá vĩnh viễn', onSelect: () => void remove(p.id) });
    return a;
  }
```

8. **Inline buttons for posts waiting for approval** (CR §9). Add `const [armed, setArmed] = useState<string | null>(null);` and:

```tsx
  function rowInline(p: PostData) {
    if (p.status !== 'READY') return null;
    const stop = (fn: () => void) => (e: React.MouseEvent) => {
      e.stopPropagation();
      fn();
    };
    return (
      <>
        <button type="button" className="btn btn-secondary btn-sm" onClick={stop(() => setEditingId(p.id))}>Sửa</button>
        {p.scheduleQueued ? (
          <button type="button" className="btn btn-primary btn-sm" disabled={acting} onClick={stop(() => void approve(p.id))}>Duyệt</button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={acting || !p.caption}
            onClick={stop(() => (armed === p.id ? (setArmed(null), void publish(p.id)) : setArmed(p.id)))}
            onBlur={() => setArmed((a) => (a === p.id ? null : a))}
          >
            {armed === p.id ? 'Bấm lần nữa để đăng' : 'Duyệt & đăng'}
          </button>
        )}
      </>
    );
  }
```

(Import the `MouseEvent` type from react instead of using `React.MouseEvent` if the file does not import `React`.)

9. **Replace the header, filter row, list and footer JSX of `split-main`** (the inspector stays as it is):

```tsx
      <div className="split-main">
        <div className="posts-header">
          <div className="page-header" style={{ marginBottom: 0 }}>
            <h1>Bài đăng</h1>
            <p>Quản lý, duyệt và theo dõi nội dung Fanpage.</p>
          </div>
          <Link to="/posts/create" className="btn btn-primary"><Plus size={16} aria-hidden="true" /> Tạo bài mới</Link>
        </div>

        {!loading && posts.length > 0 && (
          <p className="posts-overview" aria-label="Tổng quan">
            <span><strong>{counts[''] ?? 0}</strong> bài</span>
            <span><strong>{counts.PUBLISHED ?? 0}</strong> đã đăng</span>
            <span className={counts.READY ? 'attention' : ''}><strong>{counts.READY ?? 0}</strong> chờ duyệt</span>
            {!!counts.SCHEDULED && <span><strong>{counts.SCHEDULED}</strong> đã lên lịch</span>}
            {!!counts.FAILED && <span className="danger"><strong>{counts.FAILED}</strong> lỗi</span>}
          </p>
        )}

        <div className="filter-tabs" role="tablist" aria-label="Lọc theo trạng thái">
          {TABS.map((t) => (
            <button key={t.value} type="button" role="tab" className="filter-tab" aria-selected={status === t.value} onClick={() => setParam('status', t.value)}>
              {t.label}<span className="count">{counts[t.value] ?? 0}</span>
            </button>
          ))}
        </div>

        <PostFilters
          q={q}
          pageId={pageFilter}
          domainId={domainFilter}
          time={time}
          pages={pageOptions}
          domains={domains}
          onChange={(key, value) => setParam(key, value)}
        />

        {loading ? (
          <div className="loading-page"><div className="spinner spinner-lg" /></div>
        ) : visible.length === 0 ? (
          /* keep today's empty-state block unchanged */
        ) : (
          <section className="card flush post-list" aria-label="Danh sách bài đăng">
            {visible.map((p) => (
              <PostListItem
                key={p.id}
                post={p}
                selected={p.id === selectedId}
                onSelect={() => setSelectedId(p.id)}
                actions={rowActions(p)}
                inline={rowInline(p)}
              />
            ))}
          </section>
        )}
        {!loading && visible.length > 0 && (
          <span className="muted" style={{ fontSize: 12.5 }}>Hiển thị {visible.length} / {posts.length} bài{posts.length === 50 ? ' (50 bài mới nhất)' : ''}</span>
        )}
      </div>
```

Keep today's empty-state JSX exactly where the comment is. `setParam` already clears `selected`.

10. **CSS**: replace the old row styles. Leave `.post-row` in place if the Dashboard still uses it: check with `grep -rn "post-row" client/src`. Append:

```css
/* ─── Posts list (redesign) ─── */
.posts-header { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
.posts-overview { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0; font-size: 13px; color: var(--text-secondary); }
.posts-overview strong { color: var(--text-primary); font-variant-numeric: tabular-nums; }
.posts-overview .attention strong { color: var(--warning-400); }
.posts-overview .danger strong { color: var(--error-500); }
.filter-tab .count { margin-left: 6px; opacity: 0.65; }
.post-filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.post-search { flex: 1 1 220px; max-width: 360px; height: 34px; }
.post-filter { width: auto; flex: 0 1 auto; min-width: 130px; max-width: 220px; }
.post-list { container-type: inline-size; }
.post-item { display: flex; align-items: flex-start; gap: 14px; padding: 14px 16px; border-bottom: 1px solid var(--border-subtle); }
.post-item:last-child { border-bottom: 0; }
.post-item:hover { background: var(--bg-secondary); }
.post-item.selected { background: var(--primary-50); box-shadow: inset 3px 0 0 var(--primary-500); }
.post-item-open { flex: 1; min-width: 0; display: flex; gap: 14px; align-items: flex-start; padding: 0; border: 0; background: none; text-align: left; cursor: pointer; color: inherit; }
.post-item-open:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 4px; border-radius: 6px; }
.post-item .post-thumb { border-radius: 9px; object-fit: cover; flex-shrink: 0; }
.post-item-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.post-item-title { font-size: 14.5px; font-weight: 600; color: var(--text-primary); line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.post-item-title.empty { color: var(--text-tertiary); font-style: italic; font-weight: 500; }
.post-item-preview { font-size: 13px; color: var(--text-secondary); line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.post-item-preview.error { color: var(--error-500); }
.post-item-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; font-size: 12px; color: var(--text-tertiary); min-width: 0; }
.post-item-meta .domain-tag { margin: 0; }
.post-item-tags { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.post-item-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex-shrink: 0; }
.post-item-status { display: flex; align-items: center; gap: 8px; }
.post-item-time { font-size: 12px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.post-item-actions { display: flex; align-items: center; gap: 6px; }
/* Narrow list (tablet, or next to the inspector): status/time/actions go under the text */
@container (max-width: 620px) {
  .post-item { flex-wrap: wrap; }
  .post-item-side { flex-direction: row; flex-wrap: wrap; align-items: center; width: 100%; padding-left: 86px; gap: 8px 12px; }
  .post-item-actions { margin-left: auto; }
}
@media (max-width: 640px) {
  .post-item .post-thumb { width: 56px !important; height: 56px !important; }
  .post-item-side { padding-left: 70px; }
  .post-item-tags { display: none; }
}
```

Check `--primary-50` exists (it's used by `.post-row.selected` today). Remove the `.filter-row` and `.domain-filter` rules added earlier today if nothing uses them any more (`grep -rn "filter-row\|domain-filter" client/src`).

- [ ] **Step 4: Typecheck, lint, tests**

Run: `(cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b && npm run lint) && npx vitest run tests/post-display.test.ts`
Expected: tsc clean; no new lint **errors** (warnings like the existing ones are acceptable); tests pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/PostListItem.tsx client/src/components/PostFilters.tsx client/src/pages/PostsPage.tsx client/src/index.css
git commit -m "feat(client): redesigned Posts list — title/preview rows, status + per-Page progress, actions, overview, filters"
```

---

### Task 5: Browser check (desktop, tablet, phone) and full verification

**Files:** only fixes found by the check. Test data is created and removed with scripts in the plan workspace; nothing is committed from it.

- [ ] **Step 1: Test data (local DB, admin account, temporary)**
- Create with a `tsx` script in the plan workspace:
  - 2 temporary Pages named "(thử UI)";
  - 6 posts: PUBLISHED on 3 Pages; FAILED on 2 Pages (one target error "Session has expired"); READY normal; READY from a schedule (`scheduleQueued`); DRAFT; SCHEDULED; plus one long caption with no line break.
- Use existing images, or none (placeholder).
- Log in with a session cookie created by `sessionCookie()` (as in the earlier checks), never by typing a password.
- **Nothing is published**: do not confirm "Duyệt & đăng" or "Đăng lại" twice on real Pages. The temporary Pages have fake tokens.

- [ ] **Step 2: Check with Playwright at 1400×900, 1024×768, 768×1024, 390×844**
1. Rows show a thumbnail (72 px, rounded, cover, or the placeholder), a bold 1-line title, a lighter 2-line preview, light metadata (Page, domain, at most 2 hashtags plus "+N"), no word count.
2. Status colours: Nháp gray, Chờ duyệt amber, Đã lên lịch blue, Đã đăng green, Lỗi red.
3. Multi-Page posts show "Đã đăng 3/3" or "1/2 thành công". Hover or click opens the popover with ✓ / ✕ and "Token hết hạn".
4. ⋯ menu:
   - opens with Enter;
   - ↑/↓ move and Esc closes, returning focus to ⋯;
   - an outside click closes it;
   - "Xoá" needs two clicks;
   - clicking ⋯ does **not** select the row.
5. A READY post has [Sửa] [Duyệt & đăng]; the first click turns the button into "Bấm lần nữa để đăng", and blur resets it. A schedule post has [Sửa] [Duyệt]. Test the approve flow only on the temporary post.
6. Overview line and tab counts match; "Đã lên lịch" tab works.
7. Search + Page + time filters combine; the URL keeps them; reload keeps them.
8. At 1024 and 768 the status/time/actions move under the text; at 390 no horizontal scroll.
9. The inspector still works (preview, history, publish buttons) for the selected post.
- Screenshots: `.playwright-mcp/posts-redesign-1400.png`, `-1024.png`, `-390.png`.

- [ ] **Step 3: Clean up.** Delete the temporary posts and Pages with the script, remove the cookie file, stop the servers only if this session started them.

- [ ] **Step 4: Full verification** (no dev server running for DB tests)

```bash
npx tsc --noEmit && npx vitest run && RUN_DB_TESTS=1 npx vitest run
(cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b && npx -y -p node@22 -- node node_modules/vite/bin/vite.js build)
```

Expected: all pass; build OK.

- [ ] **Step 5: Commit fixes from the check (if any), then STOP and report to the user:**
- files changed;
- what was done;
- what could not be done because the backend has no data (engagement, comments, duplicate, "Xem bình luận");
- the one additive API change (Decision 2).

Do not merge or push without the user's OK.

```bash
git branch --show-current
git add <only the files the fixes touched>
git commit -m "fix(client): posts list — fixes from the browser check"
```
