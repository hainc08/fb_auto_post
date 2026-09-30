# Lịch đăng theo khung giờ (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lịch đăng tự chạy đúng như thiết kế Phase 2 đã chốt: mỗi lịch có hàng chờ ý tưởng, chọn thứ + 1–3 khung giờ (giờ Việt Nam), đăng lên một hoặc nhiều Page, luôn giữ sẵn N bài do AI viết trước; người dùng duyệt từng bài; đến giờ mà bài chưa duyệt thì bài đó dời sang khung sau và các bài sau lùi theo.

**Architecture:**
- Một job hệ thống `schedule_tick`, có key, chạy mỗi phút trong hàng đợi MariaDB. Mỗi lượt, job xử lý từng lịch:
  1. đăng bài **đã duyệt** tới giờ;
  2. dời các bài **chưa duyệt** đã quá giờ sang khung tiếp theo;
  3. viết bù cho đủ N bài bằng các ý tưởng kế tiếp, mỗi bài qua một job `prepare_post`.
- Job `prepare_post` viết chữ, rồi tạo ảnh nếu định dạng có ảnh, sau đó chuyển bài sang "Chờ duyệt".
- Việc đăng dùng lại pipeline hiện có (`enqueuePost`).
- Mọi dữ liệu nằm trong MariaDB, và job tự được đặt lại khi server khởi động.

**Tech Stack:** Node/Express/TypeScript, Prisma 6 + MariaDB, Vitest, React 19 + Vite 8, Gemini (`GeminiClient.generateJson`).

**Spec:** Không có file spec riêng. Nguồn là:
- mục Phase 2 trong `ROADMAP.md`: 5 quyết định chốt ngày 2026-09-24;
- các câu trả lời của người dùng ngày 2026-09-30, ghi ở mục **Quyết định** dưới đây.

Người thực hiện đọc cả hai.

## Quyết định

Đã chốt với người dùng:

1. Làm **đầy đủ** thiết kế Phase 2:
   - hàng chờ ý tưởng, có nút "AI gợi ý 10 ý tưởng" không trùng ý đã có hoặc bài đã viết, và cảnh báo khi sắp hết;
   - chọn thứ + 1–3 khung giờ;
   - giữ sẵn N bài (mặc định 3);
   - duyệt trước khi đăng;
   - bài chưa duyệt thì dời.
2. **Một lịch đăng lên nhiều Page**, giống trang Tạo bài: mỗi Page là một `post_targets`, giãn cách `DEFAULT_INTERVAL_MINUTES` (2 phút).
3. Đến giờ mà bài chưa duyệt → **dời sang khung trống kế tiếp, các bài sau lùi theo**.
4. **Ảnh theo định dạng bài**: định dạng `withImage` thì AI viết kèm `image_prompt` và job tạo ảnh; không thì chỉ đăng chữ. Sau khi AI viết xong, người dùng vẫn đổi ảnh hoặc tải video được bằng hộp Sửa bài.

Quyết định kỹ thuật (hướng A ghi trong ROADMAP):

5. **Lịch mới có `frequency = SLOTS`**, thêm giá trị mới vào enum; các giá trị cũ giữ nguyên.
   - `weekdays`: mảng số 0–6 (0 = Chủ nhật, theo `getUTCDay` của ngày giờ Việt Nam).
   - `slots`: mảng "HH:mm", 1–3 phần tử.
   - `bufferSize`: số nguyên 1–7, mặc định 3.
   - `startDate`: ngày bắt đầu; `endDate` tuỳ chọn, là 23:59 giờ Việt Nam của ngày kết thúc.
   - `timezone` giữ `Asia/Ho_Chi_Minh`.
6. **Page của lịch** nằm trong bảng mới `schedule_pages` (scheduleId, pageId). Cột cũ `post_schedules.pageId` vẫn bắt buộc, luôn là Page đầu tiên. Page bị ngắt kết nối (`isActive=false`) thì bị bỏ qua khi tạo bài; ngắt hết Page thì lịch không tạo bài mới.
7. **Ý tưởng** nằm trong bảng mới `schedule_ideas`: `text` tối đa 500 ký tự, `position`, `status` QUEUED/USED, `postId`, `usedAt`. Lấy theo `position` tăng dần.
8. **Bài của lịch** là một `Post` bình thường, có thêm ba cột:
   - `scheduleId`: SetNull khi xoá lịch;
   - `scheduleQueued`: true khi bài còn đang giữ một khung giờ của lịch;
   - `approvedAt`.

   `scheduledAt` là khung giờ hiện tại của bài. Trạng thái:
   - `DRAFT`: chờ AI viết;
   - `GENERATING`: AI đang viết;
   - `READY`: chờ duyệt;
   - `SCHEDULED` + `approvedAt`: đã duyệt;
   - `FAILED`: AI viết lỗi. Bài vẫn giữ khung giờ, để không đốt hết ý tưởng khi, chẳng hạn, thiếu Gemini key.
9. **Duyệt** bằng `POST /api/posts/:id/approve`: bài phải có `scheduleQueued` và đang `READY`; mọi Page của bài phải đăng được, nếu không trả 409 như nút Đăng. "Duyệt & đăng ngay" hoặc "Đăng lại" (qua `claimForPublishing`) tách bài khỏi lịch (`scheduleQueued=false`), nên tick không bao giờ đăng lại bài đó.
10. **Tick** chạy mỗi 60 giây, và chỉ được đặt khi `config.env !== 'test'`, để test DB song song không bị tick chạy trên lịch của test khác. Test gọi thẳng `runScheduleTick(now, where)`. Luật mỗi lịch:
    - Bài quá giờ **sớm nhất**: nếu đã duyệt thì đăng ngay. Mỗi lượt chỉ đăng một bài cho mỗi lịch, nên server ngủ lâu rồi tỉnh dậy cũng không đăng dồn.
    - Còn bài nào quá giờ thì xếp lại **toàn bộ** bài đang giữ khung (theo thứ tự cũ) vào các khung kế tiếp sau `now`.
    - Viết bù: `bufferSize − số bài đang giữ khung`, các khung mới lấy sau khung cuối đang có.
11. **Sửa lịch** (đổi thứ/giờ/ngày) → xếp lại ngay các bài đang giữ khung vào khung mới. **Tạm dừng** → không đăng, không dời, không viết bù. **Xoá lịch** → bài đang giữ khung trở thành bài thường ở trạng thái "Chờ duyệt" (`scheduleQueued=false`; bài đã duyệt quay về `READY`). Bài không bị xoá.
12. **Lịch cũ** (ONCE/DAILY/WEEKLY/MONTHLY/CUSTOM_CRON) được chuyển một lần khi server khởi động (`migrateLegacySchedules`):
    - DAILY → mọi thứ; WEEKLY → thứ của `startDate`; khung giờ = giờ:phút của `startDate`.
    - ONCE/MONTHLY/CUSTOM_CRON → chuyển giống WEEKLY nhưng **tạm dừng**, và thêm " (cần xem lại)" vào tên.
    - `inputData.basicInfo` trở thành ý tưởng đầu tiên; job keyed `schedule:<id>` cũ bị xoá.
    - Handler `run_schedule` còn đăng ký nhưng không làm gì, để xả các job cũ.
13. **Bỏ chặn gói** (`requirePlan('PRO', …)`) ở tạo lịch: gói Free/Pro sẽ làm ở dự án SaaS sau. Mọi lỗi của `/api/schedules` bằng tiếng Việt.
14. "Nhắc duyệt" dùng badge "Bài đăng" có sẵn ở Sidebar (đếm bài `READY`). Bài của lịch ở `READY` tự được đếm, nên không cần email.

## Global Constraints

- Code và comment tiếng Anh; chữ trên giao diện, lỗi API và tài liệu tiếng Việt.
- Schema **chỉ thêm** (cột nullable/có default, bảng mới, giá trị enum mới). MariaDB; không dùng tính năng chỉ có ở Postgres.
- Mọi query lọc theo `req.user.id`; id của user khác, kể cả id trong body, trả 404. Route mới phải thêm vào `ROUTE_CASES` trong `tests/isolation.db.test.ts`.
- Handler dùng `asyncHandler` + `createError(status, message)`; kiểm tra input bằng zod.
- Test không bao giờ gọi Gemini, Cloudflare hay Facebook thật: spy `GeminiClient.prototype.generateJson`, `CloudflareClient.prototype.generateImage`, stub `fetch`. Spy tạo trong từng test hoặc `beforeEach`.
- Test DB: user tạo bằng `createTestUser()`, dọn bằng `cleanupTestUsers()`. Tắt dev server trước khi chạy test DB.
- Client: CSS thuần trong `client/src/index.css`, dùng lại token/lớp có sẵn. Giao diện dùng được ở bề ngang 390 px, không cuộn ngang.
- Repo public: stage từng file theo tên, không commit `.env*` hay `prompt_creator_video.md`, kiểm tra nhánh trước khi commit (không commit trên `deploy`).

## Review Focus

1. **Server ngủ nhiều giờ** (Hostinger), lỡ nhiều khung → chỉ bài đã duyệt sớm nhất được đăng, các bài khác dời sang khung tương lai, không đăng dồn. Test ở Task 4.
2. **Hết ý tưởng** → không tạo bài, không lỗi; lịch hiện cảnh báo; khi thêm ý tưởng thì lượt sau viết bù. Test ở Task 4.
3. **AI lỗi** (thiếu key/quota) → bài `FAILED` vẫn giữ khung, không lấy thêm ý tưởng mỗi phút. Test ở Task 3 và Task 4.
4. **Sửa khung giờ khi đã có bài chờ** → bài chờ chuyển sang khung mới, giữ thứ tự. Test ở Task 5.
5. **Bấm "Đăng ngay" một bài của lịch** → bài rời lịch; tick không đăng lần hai. Test ở Task 7.

---

### Task 1: Tính các khung giờ tiếp theo (giờ Việt Nam)

**Files:**
- Modify: `src/lib/schedule-time.ts`
- Test: `tests/schedule-time.test.ts`

**Interfaces:**
- Produces:
  - `SLOT_PATTERN: RegExp`;
  - `interface SlotTiming { weekdays: number[]; slots: string[]; startDate?: Date | null; endDate?: Date | null; timezone?: string }`;
  - `nextSlots(t: SlotTiming, after: Date, count: number): Date[]`, trả các khung **sau hẳn** `after`, không sớm hơn `startDate`, không muộn hơn `endDate`, tăng dần;
  - `wallTime(date: Date, tz?: string): { weekday: number; hhmm: string }`;
  - `VN_TZ = 'Asia/Ho_Chi_Minh'`.

- [ ] **Step 1: Viết test (thêm vào cuối `tests/schedule-time.test.ts`)**

```ts
import { nextSlots, wallTime } from '../src/lib/schedule-time';

describe('nextSlots', () => {
  // Friday 2026-09-25 10:00 in Vietnam = 03:00Z
  const FRI_10H = new Date('2026-09-25T03:00:00Z');
  const isoAll = (ds: Date[]) => ds.map((d) => d.toISOString());

  it('returns the next slots on the chosen weekdays, in Vietnam time', () => {
    // Mon(1), Wed(3), Fri(5) at 08:00 and 19:30
    const got = nextSlots({ weekdays: [1, 3, 5], slots: ['19:30', '08:00'] }, FRI_10H, 4);
    expect(isoAll(got)).toEqual([
      '2026-09-25T12:30:00.000Z', // Fri 19:30
      '2026-09-28T01:00:00.000Z', // Mon 08:00
      '2026-09-28T12:30:00.000Z', // Mon 19:30
      '2026-09-30T01:00:00.000Z', // Wed 08:00
    ]);
  });

  it('never returns a slot at or before `after`', () => {
    const at = new Date('2026-09-25T12:30:00Z'); // exactly Fri 19:30
    expect(nextSlots({ weekdays: [5], slots: ['19:30'] }, at, 1)[0].toISOString()).toBe('2026-10-02T12:30:00.000Z');
  });

  it('respects startDate and endDate', () => {
    const t = { weekdays: [0, 1, 2, 3, 4, 5, 6], slots: ['09:00'], startDate: new Date('2026-09-27T02:00:00Z'), endDate: new Date('2026-09-28T16:59:00Z') };
    expect(isoAll(nextSlots(t, FRI_10H, 5))).toEqual(['2026-09-27T02:00:00.000Z', '2026-09-28T02:00:00.000Z']);
  });

  it('returns nothing without weekdays or valid slots', () => {
    expect(nextSlots({ weekdays: [], slots: ['09:00'] }, FRI_10H, 3)).toEqual([]);
    expect(nextSlots({ weekdays: [1], slots: ['25:00', 'x'] }, FRI_10H, 3)).toEqual([]);
  });

  it('crosses midnight UTC correctly (23:30 Vietnam is 16:30Z the same day)', () => {
    expect(nextSlots({ weekdays: [5], slots: ['23:30'] }, FRI_10H, 1)[0].toISOString()).toBe('2026-09-25T16:30:00.000Z');
  });
});

describe('wallTime', () => {
  it('gives weekday and HH:mm as seen in Vietnam', () => {
    expect(wallTime(new Date('2026-09-25T17:15:00Z'))).toEqual({ weekday: 6, hhmm: '00:15' }); // Sat 00:15 in Vietnam
  });
});
```

- [ ] **Step 2: Chạy test, thấy lỗi**

Run: `npx vitest run tests/schedule-time.test.ts`
Expected: FAIL. `nextSlots` và `wallTime` chưa được export.

- [ ] **Step 3: Viết code (thêm vào cuối `src/lib/schedule-time.ts`)**

```ts
// ─── Slot schedules (weekdays + times of day) ───

export const VN_TZ = 'Asia/Ho_Chi_Minh';
export const SLOT_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Enough to find a slot even for a schedule that posts once a week near its end date */
const MAX_DAYS_AHEAD = 400;

export interface SlotTiming {
  /** 0 = Sunday … 6 = Saturday, as seen in `timezone` */
  weekdays: number[];
  /** "HH:mm", 24 h */
  slots: string[];
  startDate?: Date | null;
  endDate?: Date | null;
  timezone?: string;
}

const dayOfWeek = (w: WallClock) => new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();

/** The next `count` slots strictly after `after`, within startDate…endDate, in order. */
export function nextSlots(t: SlotTiming, after: Date, count: number): Date[] {
  const tz = t.timezone || VN_TZ;
  const days = new Set(t.weekdays);
  const times = [...new Set(t.slots)]
    .filter((s) => SLOT_PATTERN.test(s))
    .sort()
    .map((s) => s.split(':').map(Number) as [number, number]);
  const out: Date[] = [];
  if (!days.size || !times.length || count <= 0) return out;

  const from = t.startDate && t.startDate.getTime() > after.getTime() ? t.startDate : after;
  const first = toWall(from, tz);
  for (let i = 0; i <= MAX_DAYS_AHEAD && out.length < count; i++) {
    const day = addDays(first, i);
    if (!days.has(dayOfWeek(day))) continue;
    for (const [hour, minute] of times) {
      const at = fromWall({ ...day, hour, minute }, tz);
      if (at.getTime() <= after.getTime()) continue;
      if (t.startDate && at.getTime() < t.startDate.getTime()) continue;
      if (t.endDate && at.getTime() > t.endDate.getTime()) return out;
      out.push(at);
      if (out.length === count) break;
    }
  }
  return out;
}

/** Weekday (0 = Sunday) and "HH:mm" of an instant, as seen in `tz`. */
export function wallTime(date: Date, tz: string = VN_TZ): { weekday: number; hhmm: string } {
  const w = toWall(date, tz);
  return { weekday: dayOfWeek(w), hhmm: `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}` };
}
```

- [ ] **Step 4: Chạy test, thấy qua**

Run: `npx vitest run tests/schedule-time.test.ts`
Expected: PASS (các test cũ của `nextRunAt` vẫn qua).

- [ ] **Step 5: Commit**

```bash
git add src/lib/schedule-time.ts tests/schedule-time.test.ts
git commit -m "feat(schedules): compute slot times (weekdays + times of day, Vietnam time)"
```

---

### Task 2: Schema lịch theo khung giờ + chuyển lịch cũ

**Files:**
- Modify: `prisma/schema.prisma`, `src/lib/job-queue.ts:17`, `src/lib/bootstrap.ts`
- Create: `src/lib/schedule-migrate.ts`
- Test: `tests/schedule-migrate.db.test.ts`

**Interfaces:**
- Consumes: `wallTime`, `VN_TZ` (Task 1).
- Produces:
  - Prisma models `SchedulePage`, `ScheduleIdea`, enum `IdeaStatus`, `ScheduleFrequency.SLOTS`;
  - `PostSchedule.weekdays/slots/bufferSize/pages/ideas/posts`;
  - `Post.scheduleId/scheduleQueued/approvedAt/schedule`;
  - `JobType` thêm `'prepare_post' | 'schedule_tick'`;
  - `migrateLegacySchedules(where?: Prisma.PostScheduleWhereInput): Promise<number>`;
  - `ALL_WEEKDAYS = [0,1,2,3,4,5,6]`.

- [ ] **Step 1: Sửa `prisma/schema.prisma`**

Thêm `SLOTS` vào `enum ScheduleFrequency` (sau `CUSTOM_CRON`):

```prisma
  CUSTOM_CRON // legacy, no longer accepted by the API
  SLOTS // weekdays + times of day (Phase 2); every schedule is converted to this
```

Thêm enum mới (cạnh các enum khác):

```prisma
enum IdeaStatus {
  QUEUED
  USED
}
```

Trong `model Post`, sau `scheduledAt DateTime?`:

```prisma
  // Posts written ahead by a slot schedule (scheduledAt = the slot it holds)
  scheduleId     String?
  scheduleQueued Boolean   @default(false) // still holds a slot of its schedule
  approvedAt     DateTime? // approved for its slot (status SCHEDULED)
```

Trong phần Relations của `Post`, thêm:

```prisma
  schedule PostSchedule? @relation(fields: [scheduleId], references: [id], onDelete: SetNull)
```

Và thêm index `@@index([scheduleId, scheduleQueued])` cạnh các index hiện có.

Trong `model PostSchedule`, sau `autoGenImage`:

```prisma
  // Slot schedules: 0 = Sunday … 6 = Saturday and "HH:mm" (Vietnam time), 1–3 slots
  weekdays   Json?
  slots      Json?
  /// Posts kept written ahead for the next slots
  bufferSize Int     @default(3)
```

Phần Relations của `PostSchedule`, thêm:

```prisma
  pages SchedulePage[]
  ideas ScheduleIdea[]
  posts Post[]
```

Thêm hai model mới sau `PostSchedule`:

```prisma
/// Pages a schedule publishes to (post_schedules.pageId = the first one)
model SchedulePage {
  scheduleId String
  pageId     String

  schedule PostSchedule @relation(fields: [scheduleId], references: [id], onDelete: Cascade)
  page     FacebookPage @relation(fields: [pageId], references: [id], onDelete: Cascade)

  @@id([scheduleId, pageId])
  @@map("schedule_pages")
}

/// Ideas a schedule writes posts from, in order
model ScheduleIdea {
  id         String     @id @default(uuid())
  scheduleId String
  text       String     @db.VarChar(500)
  position   Int
  status     IdeaStatus @default(QUEUED)
  postId     String? // post written from this idea
  usedAt     DateTime?
  createdAt  DateTime   @default(now())

  schedule PostSchedule @relation(fields: [scheduleId], references: [id], onDelete: Cascade)

  @@index([scheduleId, status, position])
  @@map("schedule_ideas")
}
```

Trong `model FacebookPage`, phần relations, thêm `schedulePages SchedulePage[]`.

- [ ] **Step 2: Áp schema vào DB local**

Run: `npx prisma db push --skip-generate && npx prisma generate`
Expected: "Your database is now in sync", không có cảnh báo mất dữ liệu.

- [ ] **Step 3: `src/lib/job-queue.ts`**, dòng 17:

```ts
export type JobType = 'publish_post' | 'publish_target' | 'run_schedule' | 'check_page_tokens' | 'prepare_post' | 'schedule_tick';
```

- [ ] **Step 4: Viết test `tests/schedule-migrate.db.test.ts`**

```ts
import { describe, it, expect, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { migrateLegacySchedules } from '../src/lib/schedule-migrate';
import { cleanupTestUsers, createTestUser } from './helpers/users';

// Friday 2026-09-25 09:30 in Vietnam
const START = new Date('2026-09-25T02:30:00Z');

describe.skipIf(!process.env.RUN_DB_TESTS)('migrateLegacySchedules', () => {
  afterAll(async () => {
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('converts old schedules to slots once, keeping their idea and Page', async () => {
    const { user } = await createTestUser();
    const page = await prisma.facebookPage.create({
      data: { userId: user.id, pageId: `MIG_${Date.now()}`, pageName: 'P', pageAccessToken: 'EAAfaketokenmigratexxxxxxxxxxxxxxxx' },
    });
    const make = (frequency: 'DAILY' | 'WEEKLY' | 'ONCE', name: string) =>
      prisma.postSchedule.create({
        data: { userId: user.id, pageId: page.id, name, frequency, startDate: START, inputData: { basicInfo: `Ý tưởng ${name}` } },
      });
    const daily = await make('DAILY', 'Ngày');
    const weekly = await make('WEEKLY', 'Tuần');
    const once = await make('ONCE', 'Một lần');
    await prisma.job.create({ data: { key: `schedule:${daily.id}`, type: 'run_schedule', payload: { scheduleId: daily.id }, runAt: START } });

    expect(await migrateLegacySchedules({ userId: user.id })).toBe(3);
    expect(await migrateLegacySchedules({ userId: user.id })).toBe(0); // idempotent

    const d = await prisma.postSchedule.findUniqueOrThrow({ where: { id: daily.id }, include: { pages: true, ideas: true } });
    expect(d).toMatchObject({ frequency: 'SLOTS', weekdays: [0, 1, 2, 3, 4, 5, 6], slots: ['09:30'], isActive: true, bufferSize: 3 });
    expect(d.pages.map((p) => p.pageId)).toEqual([page.id]);
    expect(d.ideas.map((i) => i.text)).toEqual(['Ý tưởng Ngày']);
    expect(await prisma.job.findUnique({ where: { key: `schedule:${daily.id}` } })).toBeNull();

    expect(await prisma.postSchedule.findUniqueOrThrow({ where: { id: weekly.id } })).toMatchObject({ weekdays: [5], slots: ['09:30'], isActive: true });
    expect(await prisma.postSchedule.findUniqueOrThrow({ where: { id: once.id } })).toMatchObject({
      weekdays: [5],
      isActive: false,
      name: 'Một lần (cần xem lại)',
    });
  });
});
```

- [ ] **Step 5: Chạy test, thấy lỗi**

Run: `RUN_DB_TESTS=1 npx vitest run tests/schedule-migrate.db.test.ts`
Expected: FAIL. Không tìm thấy module `schedule-migrate`.

- [ ] **Step 6: Tạo `src/lib/schedule-migrate.ts`**

```ts
import type { Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { VN_TZ, wallTime } from './schedule-time';

export const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * Old schedules (ONCE/DAILY/WEEKLY/MONTHLY/CUSTOM_CRON, one idea, one Page) become
 * slot schedules: DAILY → every day, WEEKLY → startDate's weekday, at startDate's
 * time of day. The others are converted the WEEKLY way but paused for the user to
 * review. The old idea becomes the first queued idea. Idempotent.
 */
export async function migrateLegacySchedules(where: Prisma.PostScheduleWhereInput = {}): Promise<number> {
  const legacy = await prisma.postSchedule.findMany({ where: { ...where, frequency: { not: 'SLOTS' } } });
  for (const s of legacy) {
    const { weekday, hhmm } = wallTime(s.startDate, s.timezone || VN_TZ);
    const keepRunning = s.frequency === 'DAILY' || s.frequency === 'WEEKLY';
    const idea = ((s.inputData as Record<string, unknown> | null)?.basicInfo as string | undefined)?.trim();
    await prisma.$transaction([
      prisma.postSchedule.update({
        where: { id: s.id },
        data: {
          frequency: 'SLOTS',
          weekdays: s.frequency === 'DAILY' ? ALL_WEEKDAYS : [weekday],
          slots: [hhmm],
          nextRunAt: null,
          isActive: keepRunning && s.isActive,
          ...(!keepRunning && { name: `${s.name} (cần xem lại)`.slice(0, 100) }),
        },
      }),
      prisma.schedulePage.upsert({
        where: { scheduleId_pageId: { scheduleId: s.id, pageId: s.pageId } },
        create: { scheduleId: s.id, pageId: s.pageId },
        update: {},
      }),
      ...(idea ? [prisma.scheduleIdea.create({ data: { scheduleId: s.id, text: idea.slice(0, 500), position: 0 } })] : []),
      prisma.job.deleteMany({ where: { key: `schedule:${s.id}` } }),
    ]);
  }
  return legacy.length;
}
```

- [ ] **Step 7: Gọi trong `src/lib/bootstrap.ts`**

Thêm import `import { migrateLegacySchedules } from './schedule-migrate';`. Ở cuối `runBootstrap()`:

```ts
  const schedules = await migrateLegacySchedules();
  if (schedules) logger.info('[Bootstrap] Old schedules converted to slot schedules', { schedules });
```

- [ ] **Step 8: Chạy test, typecheck**

Run: `RUN_DB_TESTS=1 npx vitest run tests/schedule-migrate.db.test.ts tests/bootstrap.db.test.ts && npx tsc --noEmit`
Expected: PASS; tsc sạch. Nếu tsc báo lỗi ở `src/routes/schedules.routes.ts` hoặc `scheduler.service.ts` vì enum mới thì sửa ép kiểu tối thiểu. Các file này được viết lại ở Task 4–5.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma src/lib/job-queue.ts src/lib/schedule-migrate.ts src/lib/bootstrap.ts tests/schedule-migrate.db.test.ts
git commit -m "feat(schedules): slot schedule schema (pages, ideas, queued posts) and conversion of old schedules"
```

---

### Task 3: Job `prepare_post`: AI viết bài của lịch (chữ + ảnh theo định dạng)

**Files:**
- Create: `src/services/schedule-runner.ts`
- Test: `tests/schedule-runner.db.test.ts`

**Interfaces:**
- Consumes: `writePost`, `imageStyleOf` (`src/services/post-writer.ts`); `generateImage`, `cloudflareConfigFrom` (`src/services/image.service.ts`); `saveImage`; `styledImagePrompt`; `getSettings`; `classifyFailure` (`src/lib/job-failure.ts`); `UnrecoverableJobError`.
- Produces: `runPrepareJob(job: Job): Promise<void>`, payload `{ postId: string }`.
  - Bài phải đang `DRAFT` hoặc `FAILED` và chưa có caption.
  - Kết quả: `READY`, có caption; có ảnh nếu AI trả `imagePrompt`.
  - Lần thử cuối vẫn lỗi viết chữ → `FAILED` + `errorMessage`. Lỗi ảnh không chặn: bài vẫn `READY`, chỉ ghi log `image_failed`.

- [ ] **Step 1: Viết test `tests/schedule-runner.db.test.ts`** (file này được mở rộng thêm ở Task 4)

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Job } from '@prisma/client';
import '../src/config';
import prisma from '../src/utils/prisma';
import { saveSettings } from '../src/lib/settings';
import { createStarterDomains } from '../src/lib/domains';
import { GeminiClient } from '../src/lib/clients/gemini';
import { CloudflareClient } from '../src/lib/clients/cloudflare';
import { removeImage } from '../src/lib/image-store';
import { runPrepareJob } from '../src/services/schedule-runner';
import { cleanupTestUsers, createTestUser } from './helpers/users';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('img')]);
const fakeJob = (postId: string, attempts = 1): Job => ({ payload: { postId }, attempts, maxAttempts: 3 }) as unknown as Job;

let userId: string;
let pageId: string;

async function draftPost() {
  return prisma.post.create({
    data: {
      userId,
      pageId,
      status: 'DRAFT',
      scheduleQueued: true,
      scheduledAt: new Date(Date.now() + 3600_000),
      inputData: { basicInfo: 'Mẹo tưới lúa mùa khô' },
      targets: { create: { pageId } },
    },
  });
}

describe.skipIf(!process.env.RUN_DB_TESTS)('schedule runner', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    const { user } = await createTestUser();
    userId = user.id;
    await saveSettings(userId, { geminiApiKey: 'AIzaFakeKeyScheduleRunner0000000000000', cfAccountId: 'fakeaccount', cfApiToken: 'fake-cf-token-schedule' });
    await createStarterDomains(userId);
    pageId = (
      await prisma.facebookPage.create({
        data: { userId, pageId: `SR_${Date.now()}`, pageName: 'Nhà nông', pageAccessToken: 'EAAfaketokenschedulerunnerxxxxxxxxx', tokenStatus: 'VALID' },
      })
    ).id;
  });
  afterAll(async () => {
    const posts = await prisma.post.findMany({ where: { userId }, select: { imagePath: true } });
    await Promise.all(posts.map((p) => removeImage(p.imagePath)));
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  describe('prepare_post', () => {
    it('writes the text, makes the image, and leaves the post waiting for approval', async () => {
      const post = await draftPost();
      vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ post: 'Bài về tưới lúa', image_prompt: 'rice field' } as never);
      vi.spyOn(CloudflareClient.prototype, 'generateImage').mockResolvedValue({ buffer: PNG, mimeType: 'image/png' } as never);
      await runPrepareJob(fakeJob(post.id));
      const saved = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      expect(saved).toMatchObject({ status: 'READY', caption: 'Bài về tưới lúa', imagePrompt: 'rice field' });
      expect(saved.imagePath).not.toBeNull();
    });

    it('never overwrites a post the user already wrote', async () => {
      const post = await draftPost();
      await prisma.post.update({ where: { id: post.id }, data: { caption: 'Tự viết', status: 'READY' } });
      const gemini = vi.spyOn(GeminiClient.prototype, 'generateJson');
      await runPrepareJob(fakeJob(post.id));
      expect(gemini).not.toHaveBeenCalled();
      expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).caption).toBe('Tự viết');
    });

    it('an image failure keeps the text and still asks for approval', async () => {
      const post = await draftPost();
      vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ post: 'Có chữ', image_prompt: 'x' } as never);
      vi.spyOn(CloudflareClient.prototype, 'generateImage').mockRejectedValue(new Error('quota'));
      await runPrepareJob(fakeJob(post.id));
      expect(await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: 'READY', caption: 'Có chữ', imagePath: null });
    });

    it('on the last attempt a text failure marks the post FAILED with the reason, and it keeps its slot', async () => {
      const post = await draftPost();
      vi.spyOn(GeminiClient.prototype, 'generateJson').mockRejectedValue(new Error('API key not valid'));
      await expect(runPrepareJob(fakeJob(post.id, 3))).rejects.toThrow();
      const saved = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
      expect(saved.status).toBe('FAILED');
      expect(saved.errorMessage).toMatch(/AI chưa viết được bài/);
      expect(saved.scheduleQueued).toBe(true);
    });

    it('before the last attempt a failure puts the post back to DRAFT for the retry', async () => {
      const post = await draftPost();
      vi.spyOn(GeminiClient.prototype, 'generateJson').mockRejectedValue(new Error('503 overloaded'));
      await expect(runPrepareJob(fakeJob(post.id, 1))).rejects.toThrow();
      expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe('DRAFT');
    });
  });
});
```

- [ ] **Step 2: Chạy test, thấy lỗi**

Run: `RUN_DB_TESTS=1 npx vitest run tests/schedule-runner.db.test.ts`
Expected: FAIL. Không tìm thấy module `schedule-runner`.

- [ ] **Step 3: Tạo `src/services/schedule-runner.ts`**

```ts
import type { Job, Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { logger } from '../utils/logger';
import { getSettings } from '../lib/settings';
import { saveImage } from '../lib/image-store';
import { styledImagePrompt } from '../lib/compose-prompt';
import { classifyFailure } from '../lib/job-failure';
import { UnrecoverableJobError } from '../lib/job-queue';
import { imageStyleOf, writePost } from './post-writer';
import { cloudflareConfigFrom, generateImage } from './image.service';

/**
 * Slot schedules (Phase 2): posts written ahead by AI, approved by the user,
 * published in their slot. See docs/superpowers/plans/2026-09-30-schedule-slots.md.
 */

async function log(postId: string, action: string, details?: Prisma.InputJsonObject) {
  await prisma.postLog.create({ data: { postId, action, details } }).catch(() => {});
}

/** prepare_post: AI writes a schedule post (text, then the image if the format has one) → READY. */
export async function runPrepareJob(job: Job): Promise<void> {
  const { postId } = job.payload as { postId: string };
  const isLastAttempt = job.attempts >= job.maxAttempts;

  // Only a post nobody wrote yet (the user may have written or deleted it meanwhile)
  const { count } = await prisma.post.updateMany({
    where: { id: postId, caption: null, status: { in: ['DRAFT', 'FAILED'] } },
    data: { status: 'GENERATING', errorMessage: null },
  });
  if (count === 0) return;
  const post = await prisma.post.findUniqueOrThrow({ where: { id: postId }, include: { template: true } });

  let imagePrompt: string;
  try {
    const settings = await getSettings(post.userId);
    const { generated, aiPrompt, domainId, formatId } = await writePost(post, settings);
    imagePrompt = generated.imagePrompt;
    await prisma.post.update({
      where: { id: postId },
      data: {
        caption: generated.caption,
        hashtags: generated.hashtags,
        imagePrompt: generated.imagePrompt || null,
        callToAction: generated.callToAction,
        aiResponse: JSON.stringify(generated),
        aiPrompt,
        ...(formatId && { domainId, formatId }),
      },
    });
    await log(postId, 'ai_generation_completed', { captionLength: generated.caption.length });
  } catch (error) {
    const failure = classifyFailure(error, 'generate_content');
    const final = !failure.retryable || isLastAttempt;
    await prisma.post.updateMany({
      where: { id: postId },
      data: final
        ? { status: 'FAILED', errorMessage: `AI chưa viết được bài: ${failure.message}`, errorStep: 'generate_content' }
        : { status: 'DRAFT' },
    });
    logger.error('[Schedules] Writing a schedule post failed', { postId, final, error: failure.message });
    if (final) throw new UnrecoverableJobError(failure.message);
    throw error;
  }

  // The image never blocks the post: without it the user can still add one before approving
  if (imagePrompt) {
    try {
      const settings = await getSettings(post.userId);
      const buffer = await generateImage({
        cloudflare: cloudflareConfigFrom(settings),
        prompt: styledImagePrompt(await imageStyleOf(post.domainId), imagePrompt),
      });
      const saved = await saveImage(postId, buffer);
      await prisma.post.update({ where: { id: postId }, data: { imagePath: saved.imagePath, imageUrl: saved.imageUrl } });
    } catch (error) {
      await log(postId, 'image_failed', { error: (error as Error).message });
    }
  }

  await prisma.post.updateMany({ where: { id: postId, status: 'GENERATING' }, data: { status: 'READY' } });
}
```

Trước khi viết, kiểm tra `classifyFailure` trả `{ message, retryable, code? }` bằng cách đọc `src/lib/job-failure.ts`. Nếu tên trường khác thì dùng đúng tên trong file. Test "503 overloaded" cần được xếp loại "thử lại được". Nếu `classifyFailure` xếp lỗi `Error` thường là không thử lại được, đổi test đó thành `new GeminiError('overloaded', 503)` (import từ `src/lib/clients/gemini`).

- [ ] **Step 4: Chạy test, thấy qua**

Run: `RUN_DB_TESTS=1 npx vitest run tests/schedule-runner.db.test.ts && npx tsc --noEmit`
Expected: PASS; tsc sạch.

- [ ] **Step 5: Commit**

```bash
git add src/services/schedule-runner.ts tests/schedule-runner.db.test.ts
git commit -m "feat(schedules): prepare_post job writes a schedule post (text + image by format) for approval"
```

---

### Task 4: Tick của lịch: đăng bài đã duyệt, dời bài chưa duyệt, viết bù

**Files:**
- Modify: `src/services/schedule-runner.ts`, `src/services/scheduler.service.ts`
- Test: `tests/schedule-runner.db.test.ts`

**Interfaces:**
- Consumes: `nextSlots`, `SlotTiming` (Task 1); `enqueuePost` (`scheduler.service.ts`); `enqueue`, `upsertKeyedJob`; `DEFAULT_INTERVAL_MINUTES` (`src/lib/post-targets.ts`).
- Produces:
  - `PENDING_STATUSES: PostStatus[]` = `['DRAFT','GENERATING','READY','SCHEDULED','FAILED']`;
  - `slotTiming(schedule): SlotTiming`;
  - `reslot(scheduleId: string, now?: Date): Promise<void>`, xếp các bài đang giữ khung vào các khung kế tiếp sau `now`, giữ thứ tự;
  - `tickSchedule(scheduleId: string, now?: Date): Promise<void>`;
  - `runScheduleTick(now?: Date, where?: Prisma.PostScheduleWhereInput): Promise<void>`;
  - `SCHEDULE_TICK_KEY = 'system:schedule_tick'`;
  - `bookScheduleTick(): Promise<void>`;
  - `runScheduleTickJob(): Promise<JobResult>`, luôn trả `{ rescheduleAt: now + 60 s }`.

Vòng phụ thuộc: `schedule-runner.ts` import `enqueuePost` từ `scheduler.service.ts`, còn `scheduler.service.ts` import handler từ `schedule-runner.ts`. ES module chấp nhận vòng này vì chỉ gọi hàm lúc chạy, không lúc nạp module. Nếu tsx/vitest báo `enqueuePost is not a function`, chuyển `enqueuePost` sang file mới `src/services/enqueue-post.ts`, rồi `scheduler.service.ts` re-export nó (`export { enqueuePost } from './enqueue-post'`).

- [ ] **Step 1: Thêm test vào `tests/schedule-runner.db.test.ts`**

Thêm import:

```ts
import { reslot, runScheduleTick } from '../src/services/schedule-runner';
```

Thêm helpers (trên `describe`):

```ts
// Friday 2026-09-25 10:00 Vietnam. Slots: every day 08:00 and 19:30
const NOW = new Date('2026-09-25T03:00:00Z');
const FRI_1930 = new Date('2026-09-25T12:30:00Z');
const SAT_0800 = new Date('2026-09-26T01:00:00Z');
const SAT_1930 = new Date('2026-09-26T12:30:00Z');
const SUN_0800 = new Date('2026-09-27T01:00:00Z');

async function makeSchedule(opts: { ideas?: number; bufferSize?: number; isActive?: boolean } = {}) {
  return prisma.postSchedule.create({
    data: {
      userId,
      pageId,
      name: 'Lịch thử',
      frequency: 'SLOTS',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      slots: ['08:00', '19:30'],
      bufferSize: opts.bufferSize ?? 3,
      isActive: opts.isActive ?? true,
      startDate: new Date('2026-09-01T00:00:00Z'),
      pages: { create: { pageId } },
      ideas: { create: Array.from({ length: opts.ideas ?? 5 }, (_, i) => ({ text: `Ý tưởng ${i + 1}`, position: i })) },
    },
  });
}

async function queuedPost(scheduleId: string, at: Date, status: 'READY' | 'SCHEDULED' | 'FAILED' | 'DRAFT', caption: string | null = 'Bài') {
  return prisma.post.create({
    data: {
      userId,
      pageId,
      scheduleId,
      scheduleQueued: true,
      scheduledAt: at,
      status,
      caption,
      approvedAt: status === 'SCHEDULED' ? new Date() : null,
      targets: { create: { pageId } },
    },
  });
}

const queued = (scheduleId: string) =>
  prisma.post.findMany({ where: { scheduleId, scheduleQueued: true }, orderBy: { scheduledAt: 'asc' }, select: { id: true, scheduledAt: true, status: true } });
const jobsFor = (type: string, postId: string) => prisma.job.count({ where: { type, payload: { path: '$.postId', equals: postId } } });
```

Thêm `describe('tick', …)` bên trong `describe` ngoài, sau `describe('prepare_post')`:

```ts
  describe('tick', () => {
    afterAll(async () => {
      const posts = await prisma.post.findMany({ where: { userId }, select: { id: true } });
      await prisma.job.deleteMany({ where: { OR: posts.map((p) => ({ payload: { path: '$.postId', equals: p.id } })) } });
    });

    it('fills the buffer with the next ideas, one post per upcoming slot', async () => {
      const s = await makeSchedule();
      await runScheduleTick(NOW, { id: s.id });
      const posts = await queued(s.id);
      expect(posts.map((p) => p.scheduledAt?.toISOString())).toEqual([FRI_1930, SAT_0800, SAT_1930].map((d) => d.toISOString()));
      expect(posts.every((p) => p.status === 'DRAFT')).toBe(true);
      const ideas = await prisma.scheduleIdea.findMany({ where: { scheduleId: s.id }, orderBy: { position: 'asc' } });
      expect(ideas.map((i) => i.status)).toEqual(['USED', 'USED', 'USED', 'QUEUED', 'QUEUED']);
      for (const p of posts) expect(await jobsFor('prepare_post', p.id)).toBe(1);

      await runScheduleTick(NOW, { id: s.id }); // nothing more to do
      expect(await queued(s.id)).toHaveLength(3);
    });

    it('publishes the approved post whose slot has come', async () => {
      const s = await makeSchedule({ ideas: 0 });
      const due = await queuedPost(s.id, new Date(NOW.getTime() - 60_000), 'SCHEDULED');
      await runScheduleTick(NOW, { id: s.id });
      expect(await prisma.post.findUniqueOrThrow({ where: { id: due.id } })).toMatchObject({ status: 'GENERATING', scheduleQueued: false });
      expect(await jobsFor('publish_post', due.id)).toBe(1);
    });

    it('moves an unapproved post to the next slot and pushes the later ones back', async () => {
      const s = await makeSchedule({ ideas: 0 });
      const late = await queuedPost(s.id, new Date(NOW.getTime() - 60_000), 'READY');
      const next = await queuedPost(s.id, FRI_1930, 'SCHEDULED');
      await runScheduleTick(NOW, { id: s.id });
      const posts = await queued(s.id);
      expect(posts.map((p) => [p.id, p.scheduledAt?.toISOString()])).toEqual([
        [late.id, FRI_1930.toISOString()],
        [next.id, SAT_0800.toISOString()],
      ]);
      expect(await jobsFor('publish_post', next.id)).toBe(0);
    });

    it('after a long sleep, publishes only the earliest approved post and reslots the rest (no burst)', async () => {
      const s = await makeSchedule({ ideas: 0 });
      const a = await queuedPost(s.id, new Date(NOW.getTime() - 3 * 3600_000), 'SCHEDULED');
      const b = await queuedPost(s.id, new Date(NOW.getTime() - 2 * 3600_000), 'SCHEDULED');
      await runScheduleTick(NOW, { id: s.id });
      expect(await jobsFor('publish_post', a.id)).toBe(1);
      expect(await jobsFor('publish_post', b.id)).toBe(0);
      expect((await prisma.post.findUniqueOrThrow({ where: { id: b.id } })).scheduledAt?.toISOString()).toBe(FRI_1930.toISOString());
    });

    it('a post the AI could not write keeps its slot and does not burn more ideas', async () => {
      const s = await makeSchedule({ ideas: 2, bufferSize: 1 });
      await queuedPost(s.id, FRI_1930, 'FAILED', null);
      await runScheduleTick(NOW, { id: s.id });
      await runScheduleTick(new Date(NOW.getTime() + 60_000), { id: s.id });
      expect(await queued(s.id)).toHaveLength(1);
      expect(await prisma.scheduleIdea.count({ where: { scheduleId: s.id, status: 'QUEUED' } })).toBe(2);
    });

    it('with no idea left it creates nothing, and writes again once ideas are added', async () => {
      const s = await makeSchedule({ ideas: 0 });
      await runScheduleTick(NOW, { id: s.id });
      expect(await queued(s.id)).toHaveLength(0);
      await prisma.scheduleIdea.create({ data: { scheduleId: s.id, text: 'Mới', position: 0 } });
      await runScheduleTick(NOW, { id: s.id });
      expect(await queued(s.id)).toHaveLength(1);
    });

    it('a paused schedule, or one whose Pages are all disconnected, does nothing', async () => {
      const paused = await makeSchedule({ isActive: false });
      await runScheduleTick(NOW, { id: paused.id });
      expect(await queued(paused.id)).toHaveLength(0);

      const other = await prisma.facebookPage.create({
        data: { userId, pageId: `SR_OFF_${Date.now()}`, pageName: 'Off', pageAccessToken: 'EAAfaketokenscheduleoffxxxxxxxxxxxx', isActive: false },
      });
      const noPage = await prisma.postSchedule.create({
        data: {
          userId, pageId: other.id, name: 'Không Page', frequency: 'SLOTS', weekdays: [5], slots: ['19:30'], startDate: NOW,
          pages: { create: { pageId: other.id } }, ideas: { create: { text: 'x', position: 0 } },
        },
      });
      await runScheduleTick(NOW, { id: noPage.id });
      expect(await queued(noPage.id)).toHaveLength(0);
    });

    it('reslot puts the queued posts on the next slots in order', async () => {
      const s = await makeSchedule({ ideas: 0 });
      const p1 = await queuedPost(s.id, SAT_1930, 'READY');
      const p2 = await queuedPost(s.id, SUN_0800, 'SCHEDULED');
      await reslot(s.id, NOW);
      expect((await queued(s.id)).map((p) => [p.id, p.scheduledAt?.toISOString()])).toEqual([
        [p1.id, FRI_1930.toISOString()],
        [p2.id, SAT_0800.toISOString()],
      ]);
    });
  });
```

- [ ] **Step 2: Chạy test, thấy lỗi**

Run: `RUN_DB_TESTS=1 npx vitest run tests/schedule-runner.db.test.ts -t tick`
Expected: FAIL. `runScheduleTick` / `reslot` chưa có.

- [ ] **Step 3: Thêm vào `src/services/schedule-runner.ts`**

Import thêm:

```ts
import type { PostSchedule, PostStatus } from '@prisma/client';
import { enqueue, upsertKeyedJob, type JobResult } from '../lib/job-queue';
import { nextSlots, VN_TZ, type SlotTiming } from '../lib/schedule-time';
import { DEFAULT_INTERVAL_MINUTES } from '../lib/post-targets';
import { toStringArray } from '../utils/json';
import { enqueuePost } from './scheduler.service';
import { config } from '../config';
```

(Gộp vào dòng `import type { Job, Prisma }` đã có.)

Code:

```ts
/** A post in one of these states still holds its slot (FAILED = the AI could not write it) */
export const PENDING_STATUSES: PostStatus[] = ['DRAFT', 'GENERATING', 'READY', 'SCHEDULED', 'FAILED'];
const TICK_MS = 60_000;
export const SCHEDULE_TICK_KEY = 'system:schedule_tick';

export const slotTiming = (s: Pick<PostSchedule, 'weekdays' | 'slots' | 'startDate' | 'endDate' | 'timezone'>): SlotTiming => ({
  weekdays: (Array.isArray(s.weekdays) ? s.weekdays : []).filter((d): d is number => typeof d === 'number'),
  slots: toStringArray(s.slots),
  startDate: s.startDate,
  endDate: s.endDate,
  timezone: s.timezone || VN_TZ,
});

const queuedPosts = (scheduleId: string) =>
  prisma.post.findMany({
    where: { scheduleId, scheduleQueued: true, status: { in: PENDING_STATUSES } },
    orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, status: true, scheduledAt: true, caption: true, imagePath: true, userId: true },
  });

/** Put the queued posts on the next slots after `now`, keeping their order. */
export async function reslot(scheduleId: string, now = new Date()): Promise<void> {
  const schedule = await prisma.postSchedule.findUnique({ where: { id: scheduleId } });
  if (!schedule) return;
  const posts = await queuedPosts(scheduleId);
  const slots = nextSlots(slotTiming(schedule), now, posts.length);
  for (const [i, post] of posts.entries()) {
    const at = slots[i] ?? null; // no slot left (end date): the post stays, without a time
    if (at?.getTime() === post.scheduledAt?.getTime()) continue;
    await prisma.post.update({ where: { id: post.id }, data: { scheduledAt: at } });
    await log(post.id, 'slot_moved', { to: at?.toISOString() ?? null });
  }
}

/** One schedule, one minute: publish the approved post that is due, move the late ones, write ahead. */
export async function tickSchedule(scheduleId: string, now = new Date()): Promise<void> {
  const schedule = await prisma.postSchedule.findUnique({
    where: { id: scheduleId },
    include: { user: { select: { isActive: true } }, pages: { include: { page: { select: { id: true, isActive: true } } } } },
  });
  if (!schedule || !schedule.isActive || schedule.frequency !== 'SLOTS' || !schedule.user.isActive) return;

  let posts = await queuedPosts(scheduleId);
  const isDue = (p: { scheduledAt: Date | null }) => !!p.scheduledAt && p.scheduledAt.getTime() <= now.getTime();

  // 1. The earliest due post goes out if it was approved (one per tick: no burst after downtime)
  const first = posts.find(isDue);
  if (first?.status === 'SCHEDULED') {
    const { count } = await prisma.post.updateMany({
      where: { id: first.id, status: 'SCHEDULED', scheduleQueued: true },
      data: { status: 'GENERATING', scheduleQueued: false },
    });
    if (count) {
      await enqueuePost(first.id, first.userId, {
        skipAi: !!first.caption,
        skipImage: !!first.imagePath,
        intervalMs: DEFAULT_INTERVAL_MINUTES * 60_000,
      });
      await log(first.id, 'schedule_published', { slot: first.scheduledAt?.toISOString() ?? null });
    }
    posts = posts.filter((p) => p.id !== first.id);
  }

  // 2. Anything still late was not approved in time: everyone moves to the next slots, in order
  if (posts.some(isDue)) {
    await reslot(scheduleId, now);
    posts = await queuedPosts(scheduleId);
  }

  // 3. Keep bufferSize posts written ahead, from the next ideas
  const pageIds = schedule.pages.filter((p) => p.page.isActive).map((p) => p.pageId);
  const missing = schedule.bufferSize - posts.length;
  if (missing <= 0 || pageIds.length === 0) return;
  const last = posts.reduce<Date>((max, p) => (p.scheduledAt && p.scheduledAt > max ? p.scheduledAt : max), now);
  const slots = nextSlots(slotTiming(schedule), last, missing);
  const ideas = await prisma.scheduleIdea.findMany({
    where: { scheduleId, status: 'QUEUED' },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    take: slots.length,
  });
  for (const [i, idea] of ideas.entries()) {
    const post = await prisma.$transaction(async (tx) => {
      const taken = await tx.scheduleIdea.updateMany({ where: { id: idea.id, status: 'QUEUED' }, data: { status: 'USED', usedAt: now } });
      if (!taken.count) return null;
      const created = await tx.post.create({
        data: {
          userId: schedule.userId,
          pageId: pageIds[0],
          scheduleId,
          scheduleQueued: true,
          scheduledAt: slots[i],
          status: 'DRAFT',
          domainId: schedule.domainId,
          formatId: schedule.formatId,
          inputData: { basicInfo: idea.text },
          targets: { create: pageIds.map((pageId) => ({ pageId })) },
        },
      });
      await tx.scheduleIdea.update({ where: { id: idea.id }, data: { postId: created.id } });
      return created;
    });
    if (!post) continue;
    await enqueue('prepare_post', { postId: post.id });
    await log(post.id, 'created', { schedule: schedule.name, slot: slots[i].toISOString() });
  }
}

/** Every active slot schedule (tests pass `where` to stay on their own schedules). */
export async function runScheduleTick(now = new Date(), where: Prisma.PostScheduleWhereInput = {}): Promise<void> {
  const schedules = await prisma.postSchedule.findMany({ where: { ...where, isActive: true, frequency: 'SLOTS' }, select: { id: true } });
  for (const { id } of schedules) {
    try {
      await tickSchedule(id, now);
    } catch (error) {
      logger.error('[Schedules] Tick failed for a schedule', { scheduleId: id, error: (error as Error).message });
    }
  }
}

/** schedule_tick job: never stops re-booking itself, even when a tick fails */
export async function runScheduleTickJob(): Promise<JobResult> {
  try {
    await runScheduleTick();
  } catch (error) {
    logger.error('[Schedules] Tick failed', { error: (error as Error).message });
  }
  return { rescheduleAt: new Date(Date.now() + TICK_MS) };
}

/** One pending tick job (not in tests: DB test files share the database and run in parallel). */
export async function bookScheduleTick(): Promise<void> {
  if (config.env === 'test') return;
  const existing = await prisma.job.findUnique({ where: { key: SCHEDULE_TICK_KEY } });
  if (existing && (existing.status === 'PENDING' || existing.status === 'RUNNING')) return;
  await upsertKeyedJob(SCHEDULE_TICK_KEY, 'schedule_tick', {}, new Date());
}
```

- [ ] **Step 4: Nối vào worker trong `src/services/scheduler.service.ts`**

- Import: `import { bookScheduleTick, runPrepareJob, runScheduleTickJob } from './schedule-runner';`.
- Trong `startWorkers`:
  - thay dòng `void bookMissingScheduleJobs();` bằng `void bookScheduleTick().catch((e) => logger.error('[Schedules] Could not book the tick', { error: (e as Error).message }));`;
  - thêm vào map handler: `prepare_post: runPrepareJob, schedule_tick: runScheduleTickJob,`.
- Thay toàn bộ thân `runScheduleJob` bằng:

```ts
/** Old per-schedule jobs (before slot schedules): drained without doing anything. */
async function runScheduleJob(): Promise<void> {
  return;
}
```

- Xoá `bookMissingScheduleJobs`, `syncScheduleJob`, `removeScheduleJob`, `scheduleKey`, `ScheduleCheckJob`, cùng các import không còn dùng (`Frequency`, `nextRunAt` nếu `nextTokenCheck` vẫn dùng `nextRunAt` thì giữ `nextRunAt`). Cập nhật comment đầu file: thay dòng `run_schedule` bằng:
  - `prepare_post`: AI writes a slot-schedule post (schedule-runner.ts)
  - `schedule_tick`: every minute: publish approved due posts, move late ones, write ahead
- `src/routes/schedules.routes.ts` đang import `syncScheduleJob`/`removeScheduleJob`, nên sẽ lỗi biên dịch cho tới Task 5. Để mỗi commit vẫn biên dịch được, **trong task này** sửa tạm route: bỏ import đó, bỏ mọi lời gọi `syncScheduleJob(...)` (trả `nextRunAt: null`) và `removeScheduleJob(...)`. Task 5 viết lại file.

- [ ] **Step 5: Chạy test, typecheck**

Run: `RUN_DB_TESTS=1 npx vitest run tests/schedule-runner.db.test.ts && npx tsc --noEmit`
Expected: PASS; tsc sạch.

- [ ] **Step 6: Commit**

```bash
git add src/services/schedule-runner.ts src/services/scheduler.service.ts src/routes/schedules.routes.ts tests/schedule-runner.db.test.ts
git commit -m "feat(schedules): minute tick publishes approved posts, moves late ones, writes ahead from the idea queue"
```

---

### Task 5: API lịch đăng: tạo/sửa lịch nhiều Page, khung giờ, hàng chờ ý tưởng

**Files:**
- Rewrite: `src/routes/schedules.routes.ts`
- Modify: `tests/isolation.db.test.ts`
- Test: `tests/schedules.db.test.ts` (mới)

**Interfaces:**
- Consumes: `reslot`, `slotTiming`, `PENDING_STATUSES` (Task 4); `nextSlots`, `SLOT_PATTERN`, `VN_TZ` (Task 1); `resolveDomainFormat`.
- Produces (JSON luôn là `{ success, data }`):
  - `GET /api/schedules` → `ScheduleSummary[]`:
    - các trường của lịch;
    - `pages: {id,pageName,pageAvatar,isActive}[]`;
    - `ideasLeft: number`, `queuedCount: number`, `awaitingApproval: number`;
    - `nextSlotAt: string|null`;
    - `domain: {id,name}|null`, `format: {id,name}|null`.
  - `GET /api/schedules/:id` → như trên, cộng thêm:
    - `ideas: {id,text,status,position,usedAt,postId}[]`: QUEUED theo `position`, rồi 20 USED gần nhất;
    - `queue: {id,status,scheduledAt,caption,imageUrl,videoUrl,errorMessage,approvedAt}[]`.
  - `POST /api/schedules` với body `{ name, pageIds: string[1..10], weekdays: int[1..7] (0–6), slots: string[1..3] "HH:mm", bufferSize?: 1..7 (3), startDate?: ISO, endDate?: ISO|null, domainId?, formatId?, ideas?: string[] }` → 201 + ScheduleSummary.
  - `PUT /api/schedules/:id` với body = một phần các trường ở trên (trừ `ideas`) → ScheduleSummary. Đổi `weekdays/slots/startDate/endDate` thì gọi `reslot`.
  - `PATCH /api/schedules/:id/toggle`.
  - `DELETE /api/schedules/:id`: bài đang giữ khung thành bài thường chờ duyệt.
  - `POST /api/schedules/:id/ideas` `{ texts: string[1..50] }` → `{ added }`.
  - `DELETE /api/schedules/:id/ideas/:ideaId`: chỉ xoá được ý tưởng QUEUED.
  - `PUT /api/schedules/:id/ideas/order` `{ ids: string[] }`: đúng bộ id của các ý tưởng QUEUED.

- [ ] **Step 1: Viết test `tests/schedules.db.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;
let cookie: string;
let userId: string;
let pageA: string;
let pageB: string;

const body = (extra: Record<string, unknown> = {}) => ({
  name: 'Lịch nhà nông',
  pageIds: [pageA, pageB],
  weekdays: [1, 3, 5],
  slots: ['08:00', '19:30'],
  ideas: ['Tưới lúa mùa khô', 'Phòng rầy nâu'],
  ...extra,
});

describe.skipIf(!process.env.RUN_DB_TESTS)('schedules API', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    server = await startTestServer(createApp());
    const u = await createTestUser();
    cookie = u.cookie;
    userId = u.user.id;
    const mk = (n: string) =>
      prisma.facebookPage.create({ data: { userId, pageId: `SCH_${n}_${Date.now()}`, pageName: n, pageAccessToken: 'EAAfaketokenschedulesapixxxxxxxxxxxx' } });
    pageA = (await mk('A')).id;
    pageB = (await mk('B')).id;
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('creates a slot schedule on several Pages with its ideas, for any plan', async () => {
    await prisma.user.update({ where: { id: userId }, data: { plan: 'FREE' } });
    const res = await api(server.baseUrl, 'POST', '/api/schedules', { cookie, body: body() });
    expect(res.status).toBe(201);
    expect(res.json.data).toMatchObject({ frequency: 'SLOTS', weekdays: [1, 3, 5], slots: ['08:00', '19:30'], bufferSize: 3, ideasLeft: 2 });
    expect(res.json.data.pages.map((p: { id: string }) => p.id).sort()).toEqual([pageA, pageB].sort());
    expect(res.json.data.nextSlotAt).not.toBeNull();
  });

  it('rejects bad weekdays, slots and buffer sizes in Vietnamese', async () => {
    for (const bad of [{ weekdays: [] }, { weekdays: [7] }, { slots: [] }, { slots: ['8h'] }, { slots: ['08:00', '09:00', '10:00', '11:00'] }, { bufferSize: 9 }]) {
      const res = await api(server.baseUrl, 'POST', '/api/schedules', { cookie, body: body(bad) });
      expect(res.status).toBe(400);
    }
    const res = await api(server.baseUrl, 'POST', '/api/schedules', { cookie, body: body({ slots: ['08:00', '08:00'] }) });
    expect(res.json.error).toMatch(/khung giờ/i);
  });

  it('changing the slots moves the posts already waiting, in order', async () => {
    const created = (await api(server.baseUrl, 'POST', '/api/schedules', { cookie, body: body({ ideas: [] }) })).json.data;
    const future = (h: number) => new Date(Date.now() + h * 3600_000);
    const p1 = await prisma.post.create({ data: { userId, pageId: pageA, scheduleId: created.id, scheduleQueued: true, scheduledAt: future(30), status: 'READY', caption: '1' } });
    const p2 = await prisma.post.create({ data: { userId, pageId: pageA, scheduleId: created.id, scheduleQueued: true, scheduledAt: future(60), status: 'SCHEDULED', caption: '2' } });
    const res = await api(server.baseUrl, 'PUT', `/api/schedules/${created.id}`, { cookie, body: { weekdays: [0, 1, 2, 3, 4, 5, 6], slots: ['06:15'] } });
    expect(res.status).toBe(200);
    const [a, b] = await Promise.all([p1, p2].map((p) => prisma.post.findUniqueOrThrow({ where: { id: p.id } })));
    const vn = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(11, 16);
    expect([vn(a.scheduledAt!), vn(b.scheduledAt!)]).toEqual(['06:15', '06:15']);
    expect(a.scheduledAt!.getTime()).toBeLessThan(b.scheduledAt!.getTime());
  });

  it('manages the idea queue: add, reorder, delete (used ideas stay)', async () => {
    const created = (await api(server.baseUrl, 'POST', '/api/schedules', { cookie, body: body({ ideas: ['A'] }) })).json.data;
    expect((await api(server.baseUrl, 'POST', `/api/schedules/${created.id}/ideas`, { cookie, body: { texts: ['B', '  ', 'C'] } })).json.data.added).toBe(2);
    let detail = (await api(server.baseUrl, 'GET', `/api/schedules/${created.id}`, { cookie })).json.data;
    const ids = detail.ideas.map((i: { id: string }) => i.id);
    expect(detail.ideas.map((i: { text: string }) => i.text)).toEqual(['A', 'B', 'C']);

    await api(server.baseUrl, 'PUT', `/api/schedules/${created.id}/ideas/order`, { cookie, body: { ids: [ids[2], ids[0], ids[1]] } });
    detail = (await api(server.baseUrl, 'GET', `/api/schedules/${created.id}`, { cookie })).json.data;
    expect(detail.ideas.map((i: { text: string }) => i.text)).toEqual(['C', 'A', 'B']);

    expect((await api(server.baseUrl, 'DELETE', `/api/schedules/${created.id}/ideas/${ids[0]}`, { cookie })).status).toBe(200);
    await prisma.scheduleIdea.update({ where: { id: ids[1] }, data: { status: 'USED' } });
    expect((await api(server.baseUrl, 'DELETE', `/api/schedules/${created.id}/ideas/${ids[1]}`, { cookie })).status).toBe(400);
  });

  it('deleting a schedule keeps its written posts as normal posts waiting for approval', async () => {
    const created = (await api(server.baseUrl, 'POST', '/api/schedules', { cookie, body: body({ ideas: [] }) })).json.data;
    const post = await prisma.post.create({
      data: { userId, pageId: pageA, scheduleId: created.id, scheduleQueued: true, scheduledAt: new Date(Date.now() + 3600_000), status: 'SCHEDULED', approvedAt: new Date(), caption: 'x' },
    });
    expect((await api(server.baseUrl, 'DELETE', `/api/schedules/${created.id}`, { cookie })).status).toBe(200);
    expect(await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: 'READY', scheduleQueued: false, scheduleId: null, approvedAt: null });
  });
});
```

- [ ] **Step 2: Chạy test, thấy lỗi**

Run: `RUN_DB_TESTS=1 npx vitest run tests/schedules.db.test.ts`
Expected: FAIL, vì body mới chưa được nhận (400 hoặc 403 do chặn gói).

- [ ] **Step 3: Viết lại `src/routes/schedules.routes.ts`**

```ts
import { Router, Response } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { resolveDomainFormat } from '../lib/domains';
import { nextSlots, SLOT_PATTERN, VN_TZ } from '../lib/schedule-time';
import { PENDING_STATUSES, reslot, slotTiming } from '../services/schedule-runner';

const router = Router();
router.use(authenticate);

// ─── Validation ─────────────────────────────────

const ideaText = z.string().trim().min(3, 'Ý tưởng cần ít nhất 3 ký tự').max(500, 'Ý tưởng tối đa 500 ký tự');

const scheduleFields = {
  name: z.string().trim().min(1, 'Nhập tên lịch').max(100, 'Tên lịch tối đa 100 ký tự'),
  pageIds: z.array(z.string().uuid()).min(1, 'Chọn ít nhất 1 Page').max(10, 'Tối đa 10 Page'),
  weekdays: z
    .array(z.number().int().min(0).max(6))
    .min(1, 'Chọn ít nhất 1 ngày trong tuần')
    .transform((d) => [...new Set(d)].sort()),
  slots: z
    .array(z.string().regex(SLOT_PATTERN, 'Khung giờ phải có dạng HH:mm'))
    .min(1, 'Chọn 1–3 khung giờ mỗi ngày')
    .max(3, 'Chọn 1–3 khung giờ mỗi ngày')
    .refine((s) => new Set(s).size === s.length, 'Các khung giờ không được trùng nhau')
    .transform((s) => [...s].sort()),
  bufferSize: z.number().int().min(1, 'Số bài viết sẵn từ 1 đến 7').max(7, 'Số bài viết sẵn từ 1 đến 7'),
  startDate: z.string().datetime(),
  endDate: z.string().datetime().nullable(),
  domainId: z.string().uuid(),
  formatId: z.string().uuid(),
};

const createSchema = z.object({
  ...scheduleFields,
  bufferSize: scheduleFields.bufferSize.default(3),
  startDate: scheduleFields.startDate.optional(),
  endDate: scheduleFields.endDate.optional(),
  domainId: scheduleFields.domainId.optional(),
  formatId: scheduleFields.formatId.optional(),
  ideas: z.array(z.string()).max(50).optional(),
});
const updateSchema = z.object(scheduleFields).partial().refine((d) => Object.keys(d).length > 0, 'Không có trường nào để cập nhật');

// ─── Helpers ────────────────────────────────────

const scheduleInclude = {
  pages: { include: { page: { select: { id: true, pageName: true, pageAvatar: true, isActive: true } } } },
  domain: { select: { id: true, name: true } },
  format: { select: { id: true, name: true } },
} satisfies Prisma.PostScheduleInclude;

type LoadedSchedule = Prisma.PostScheduleGetPayload<{ include: typeof scheduleInclude }>;

async function findOwn(req: AuthRequest) {
  const schedule = await prisma.postSchedule.findFirst({ where: { id: req.params.id, userId: req.user!.id }, include: scheduleInclude });
  if (!schedule) throw createError(404, 'Không tìm thấy lịch đăng.');
  return schedule;
}

/** Ids in the body must be the caller's own, connected Pages */
async function ownPages(userId: string, pageIds: string[]): Promise<string[]> {
  const unique = [...new Set(pageIds)];
  const found = await prisma.facebookPage.findMany({ where: { id: { in: unique }, userId, isActive: true }, select: { id: true } });
  if (found.length !== unique.length) throw createError(404, 'Không tìm thấy Page.');
  return unique;
}

/** The client sends the start of the end day (Vietnam time): the whole day counts, up to 23:59 */
const endOfDay = (iso: string) => new Date(new Date(iso).getTime() + 24 * 3600_000 - 60_000);

async function summary(s: LoadedSchedule) {
  const [ideasLeft, queuedCount, awaitingApproval] = await Promise.all([
    prisma.scheduleIdea.count({ where: { scheduleId: s.id, status: 'QUEUED' } }),
    prisma.post.count({ where: { scheduleId: s.id, scheduleQueued: true, status: { in: PENDING_STATUSES } } }),
    prisma.post.count({ where: { scheduleId: s.id, scheduleQueued: true, status: 'READY' } }),
  ]);
  const { pages, ...rest } = s;
  return {
    ...rest,
    pages: pages.map((p) => p.page),
    ideasLeft,
    queuedCount,
    awaitingApproval,
    nextSlotAt: s.isActive ? (nextSlots(slotTiming(s), new Date(), 1)[0] ?? null) : null,
  };
}

async function addIdeas(scheduleId: string, texts: string[]): Promise<number> {
  const clean = texts.map((t) => t.trim()).filter((t) => t.length >= 3).map((t) => ideaText.parse(t));
  if (!clean.length) return 0;
  const last = await prisma.scheduleIdea.aggregate({ where: { scheduleId }, _max: { position: true } });
  const start = (last._max.position ?? -1) + 1;
  await prisma.scheduleIdea.createMany({ data: clean.map((text, i) => ({ scheduleId, text, position: start + i })) });
  return clean.length;
}

// ─── Schedules ──────────────────────────────────

router.get(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const schedules = await prisma.postSchedule.findMany({ where: { userId: req.user!.id }, include: scheduleInclude, orderBy: { createdAt: 'desc' } });
    res.json({ success: true, data: await Promise.all(schedules.map(summary)) });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const s = await findOwn(req);
    const [queuedIdeas, usedIdeas, queue] = await Promise.all([
      prisma.scheduleIdea.findMany({ where: { scheduleId: s.id, status: 'QUEUED' }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }),
      prisma.scheduleIdea.findMany({ where: { scheduleId: s.id, status: 'USED' }, orderBy: { usedAt: 'desc' }, take: 20 }),
      prisma.post.findMany({
        where: { scheduleId: s.id, scheduleQueued: true, status: { in: PENDING_STATUSES } },
        orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, status: true, scheduledAt: true, caption: true, imageUrl: true, videoUrl: true, errorMessage: true, approvedAt: true },
      }),
    ]);
    res.json({ success: true, data: { ...(await summary(s)), ideas: [...queuedIdeas, ...usedIdeas], queue } });
  })
);

router.post(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = createSchema.parse(req.body);
    const userId = req.user!.id;
    const pageIds = await ownPages(userId, data.pageIds);
    const picked = await resolveDomainFormat(userId, { domainId: data.domainId, formatId: data.formatId, pageId: pageIds[0] });
    const startDate = data.startDate ? new Date(data.startDate) : new Date();
    const endDate = data.endDate ? endOfDay(data.endDate) : null;
    if (endDate && endDate <= startDate) throw createError(400, 'Ngày kết thúc phải sau ngày bắt đầu.');

    const created = await prisma.postSchedule.create({
      data: {
        userId,
        pageId: pageIds[0],
        name: data.name,
        frequency: 'SLOTS',
        timezone: VN_TZ,
        weekdays: data.weekdays,
        slots: data.slots,
        bufferSize: data.bufferSize,
        startDate,
        endDate,
        domainId: picked.domain.id,
        formatId: picked.format.id,
        pages: { create: pageIds.map((pageId) => ({ pageId })) },
      },
    });
    await addIdeas(created.id, data.ideas ?? []);
    const s = await prisma.postSchedule.findUniqueOrThrow({ where: { id: created.id }, include: scheduleInclude });
    res.status(201).json({ success: true, data: await summary(s) });
  })
);

router.put(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = updateSchema.parse(req.body);
    const s = await findOwn(req);
    const userId = req.user!.id;
    const pageIds = data.pageIds ? await ownPages(userId, data.pageIds) : null;
    const picked =
      data.domainId || data.formatId
        ? await resolveDomainFormat(userId, { domainId: data.domainId, formatId: data.formatId, pageId: pageIds?.[0] ?? s.pageId })
        : null;
    const startDate = data.startDate ? new Date(data.startDate) : s.startDate;
    const endDate = data.endDate === undefined ? s.endDate : data.endDate ? endOfDay(data.endDate) : null;
    if (endDate && endDate <= startDate) throw createError(400, 'Ngày kết thúc phải sau ngày bắt đầu.');

    await prisma.$transaction([
      prisma.postSchedule.update({
        where: { id: s.id },
        data: {
          ...(data.name && { name: data.name }),
          ...(data.weekdays && { weekdays: data.weekdays }),
          ...(data.slots && { slots: data.slots }),
          ...(data.bufferSize && { bufferSize: data.bufferSize }),
          startDate,
          endDate,
          ...(pageIds && { pageId: pageIds[0] }),
          ...(picked && { domainId: picked.domain.id, formatId: picked.format.id }),
        },
      }),
      ...(pageIds
        ? [
            prisma.schedulePage.deleteMany({ where: { scheduleId: s.id } }),
            prisma.schedulePage.createMany({ data: pageIds.map((pageId) => ({ scheduleId: s.id, pageId })) }),
          ]
        : []),
    ]);
    // New times: the posts already waiting move to the new slots
    if (data.weekdays || data.slots || data.startDate || data.endDate !== undefined) await reslot(s.id);
    const updated = await prisma.postSchedule.findUniqueOrThrow({ where: { id: s.id }, include: scheduleInclude });
    res.json({ success: true, data: await summary(updated) });
  })
);

router.patch(
  '/:id/toggle',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const s = await findOwn(req);
    await prisma.postSchedule.update({ where: { id: s.id }, data: { isActive: !s.isActive } });
    // Back on: late posts move to the next slots instead of going out at once
    if (!s.isActive) await reslot(s.id);
    const updated = await prisma.postSchedule.findUniqueOrThrow({ where: { id: s.id }, include: scheduleInclude });
    res.json({ success: true, data: await summary(updated) });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const s = await findOwn(req);
    // The written posts are the user's: they stay, as normal posts waiting for approval
    await prisma.post.updateMany({
      where: { scheduleId: s.id, scheduleQueued: true, status: 'SCHEDULED' },
      data: { status: 'READY', approvedAt: null },
    });
    await prisma.post.updateMany({ where: { scheduleId: s.id, scheduleQueued: true }, data: { scheduleQueued: false } });
    await prisma.postSchedule.delete({ where: { id: s.id } });
    res.json({ success: true, message: 'Đã xoá lịch đăng.' });
  })
);

// ─── Idea queue ─────────────────────────────────

router.post(
  '/:id/ideas',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { texts } = z.object({ texts: z.array(z.string()).min(1).max(50, 'Tối đa 50 ý tưởng mỗi lần') }).parse(req.body);
    const s = await findOwn(req);
    const added = await addIdeas(s.id, texts);
    if (!added) throw createError(400, 'Chưa có ý tưởng nào hợp lệ (mỗi ý tưởng từ 3 ký tự).');
    res.json({ success: true, data: { added } });
  })
);

router.delete(
  '/:id/ideas/:ideaId',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const s = await findOwn(req);
    const idea = await prisma.scheduleIdea.findFirst({ where: { id: req.params.ideaId, scheduleId: s.id } });
    if (!idea) throw createError(404, 'Không tìm thấy ý tưởng.');
    if (idea.status !== 'QUEUED') throw createError(400, 'Ý tưởng này đã được dùng để viết bài.');
    await prisma.scheduleIdea.delete({ where: { id: idea.id } });
    res.json({ success: true });
  })
);

router.put(
  '/:id/ideas/order',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { ids } = z.object({ ids: z.array(z.string().uuid()).max(1000) }).parse(req.body);
    const s = await findOwn(req);
    const queued = await prisma.scheduleIdea.findMany({ where: { scheduleId: s.id, status: 'QUEUED' }, select: { id: true } });
    const known = new Set(queued.map((i) => i.id));
    if (ids.length !== known.size || !ids.every((id) => known.has(id))) {
      throw createError(400, 'Danh sách ý tưởng đã thay đổi, hãy tải lại trang.');
    }
    await prisma.$transaction(ids.map((id, position) => prisma.scheduleIdea.update({ where: { id }, data: { position } })));
    res.json({ success: true });
  })
);

export default router;
```

`endOfDay`: client gửi `endDate` là đầu ngày theo giờ Việt Nam (ISO của `YYYY-MM-DDT00:00+07:00`), server đổi sang 23:59 của cùng ngày.

- [ ] **Step 4: Cập nhật `tests/isolation.db.test.ts`**

Trong `ROUTE_CASES`, thay các dòng `/api/schedules` bằng:

```ts
  'GET /api/schedules': { kind: 'list', path: '/api/schedules' },
  'GET /api/schedules/:id': { kind: 'foreign-id', path: (b) => `/api/schedules/${b.scheduleId}` },
  'POST /api/schedules': { kind: 'foreign-id', path: () => '/api/schedules' }, // body = B's pageIds (below)
  'PUT /api/schedules/:id': { kind: 'foreign-id', path: (b) => `/api/schedules/${b.scheduleId}`, body: { name: 'hack' } },
  'PATCH /api/schedules/:id/toggle': { kind: 'foreign-id', path: (b) => `/api/schedules/${b.scheduleId}/toggle` },
  'DELETE /api/schedules/:id': { kind: 'foreign-id', path: (b) => `/api/schedules/${b.scheduleId}` },
  'POST /api/schedules/:id/ideas': { kind: 'foreign-id', path: (b) => `/api/schedules/${b.scheduleId}/ideas`, body: { texts: ['hack idea'] } },
  'DELETE /api/schedules/:id/ideas/:ideaId': { kind: 'foreign-id', path: (b) => `/api/schedules/${b.scheduleId}/ideas/${b.ideaId}` },
  'PUT /api/schedules/:id/ideas/order': { kind: 'foreign-id', path: (b) => `/api/schedules/${b.scheduleId}/ideas/order`, body: { ids: [] } },
```

- Thêm `ideaId: string` vào kiểu `Ids`.
- Trong `beforeAll`, tạo lịch của B với `ideas: { create: { text: \`${B_MARK} ý tưởng\`, position: 0 } }, include: { ideas: true }`, rồi đặt `ideaId: schedule.ideas[0].id`.
- Body ở test "404 on B's ids":

```ts
      'POST /api/schedules': { pageIds: [b.pageId], name: 'x', weekdays: [1], slots: ['08:00'] },
```

- Ở test "ids in the body", các dòng dùng `pageId: b.pageId` hoặc body lịch cũ đổi thành:

```ts
      ['PUT', `/api/schedules/${aOwn.scheduleId}`, { pageIds: [b.pageId] }],
      ['POST', '/api/schedules', { pageIds: [aOwn.pageId], formatId: b.formatId, name: 'x', weekdays: [1], slots: ['08:00'] }],
      ['PUT', `/api/schedules/${aOwn.scheduleId}`, { domainId: b.domainId }],
```

  Bỏ hai dòng `templateId` của lịch (API mới không nhận `templateId`).
- Lịch của A (`aSchedule`) tạo với `frequency: 'SLOTS', weekdays: [1], slots: ['08:00'], pages: { create: { pageId: aPage.id } }`.
- Kiểm tra sau cùng: `toMatchObject({ pageId: aOwn.pageId, domainId: null })`, kèm `expect(await prisma.schedulePage.count({ where: { scheduleId: aOwn.scheduleId, pageId: b.pageId } })).toBe(0)`.

- [ ] **Step 5: Chạy test, typecheck**

Run: `RUN_DB_TESTS=1 npx vitest run tests/schedules.db.test.ts tests/isolation.db.test.ts && npx tsc --noEmit`
Expected: PASS; tsc sạch.

- [ ] **Step 6: Commit**

```bash
git add src/routes/schedules.routes.ts tests/schedules.db.test.ts tests/isolation.db.test.ts
git commit -m "feat(schedules): API for slot schedules on several Pages with an idea queue"
```

---

### Task 6: AI gợi ý 10 ý tưởng (không trùng)

**Files:**
- Create: `src/lib/idea-suggest.ts`
- Modify: `src/services/ai.service.ts`, `src/routes/schedules.routes.ts`, `tests/isolation.db.test.ts`
- Test: `tests/idea-suggest.test.ts`, thêm 1 test vào `tests/schedules.db.test.ts`

**Interfaces:**
- Consumes: `PromptDomain`, `PromptFormat` (`src/lib/compose-prompt.ts`); `GeminiClient.generateJson`; `formatForPost` / `resolveDomainFormat`; `getSettings`.
- Produces:
  - `buildIdeaSuggestPrompt(input: { domain: PromptDomain; format: Pick<PromptFormat,'name'|'instructions'>; avoid: string[]; count: number }): { systemInstruction: string; prompt: string }`;
  - `cleanSuggestions(raw: string[], avoid: string[], count: number): string[]`;
  - `suggestIdeas(gemini: GeminiCredentials, input: …): Promise<string[]>`;
  - `POST /api/schedules/:id/ideas/suggest` → `{ ideas: string[] }`. Route chỉ gợi ý, không lưu.

- [ ] **Step 1: Viết test `tests/idea-suggest.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { buildIdeaSuggestPrompt, cleanSuggestions } from '../src/lib/idea-suggest';

describe('buildIdeaSuggestPrompt', () => {
  it('describes the domain and lists what to avoid', () => {
    const { systemInstruction, prompt } = buildIdeaSuggestPrompt({
      domain: { name: 'Nhà nông', audience: 'Nông dân miền Tây', voice: 'Gần gũi' },
      format: { name: 'Mẹo nhanh', instructions: 'Một mẹo cụ thể' },
      avoid: ['Tưới lúa mùa khô'],
      count: 10,
    });
    expect(systemInstruction).toMatch(/Nhà nông/);
    expect(systemInstruction).toMatch(/Nông dân miền Tây/);
    expect(prompt).toMatch(/10 ý tưởng/);
    expect(prompt).toMatch(/Tưới lúa mùa khô/);
  });
});

describe('cleanSuggestions', () => {
  it('trims, drops duplicates (also against existing ideas, ignoring case and extra spaces) and caps the count', () => {
    const got = cleanSuggestions(['  Phòng rầy nâu ', 'phòng rầy nâu', 'Tưới lúa mùa khô', 'ab', 'Bón phân đúng lúc', 'x'.repeat(600)], ['TƯỚI LÚA MÙA KHÔ'], 2);
    expect(got).toEqual(['Phòng rầy nâu', 'Bón phân đúng lúc']);
  });
});
```

- [ ] **Step 2: Chạy test, thấy lỗi**

Run: `npx vitest run tests/idea-suggest.test.ts`
Expected: FAIL. Không tìm thấy module.

- [ ] **Step 3: Tạo `src/lib/idea-suggest.ts`**

```ts
import type { PromptDomain, PromptFormat } from './compose-prompt';

/** Pure: the Gemini prompt for "suggest N post ideas" and the clean-up of its answer. */

const line = (label: string, value?: string | null) => (value?.trim() ? `${label}: ${value.trim()}\n` : '');
const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function buildIdeaSuggestPrompt(input: {
  domain: PromptDomain;
  format: Pick<PromptFormat, 'name' | 'instructions'>;
  avoid: string[];
  count: number;
}): { systemInstruction: string; prompt: string } {
  const { domain, format } = input;
  const systemInstruction =
    'Bạn là chuyên gia nội dung Fanpage Facebook tại Việt Nam.\n' +
    line('Lĩnh vực', domain.name) +
    line('Mô tả', domain.description) +
    line('Đối tượng đọc', domain.audience) +
    line('Giọng văn', domain.voice) +
    line('Quy tắc', domain.rules) +
    line('Định dạng bài', `${format.name} — ${format.instructions}`);
  const avoid = input.avoid.slice(0, 80).map((a) => `- ${a}`).join('\n');
  const prompt =
    `Đề xuất ${input.count} ý tưởng bài đăng mới, mỗi ý tưởng một câu ngắn (tối đa 150 ký tự), cụ thể, khác nhau, ` +
    'viết bằng tiếng Việt, hợp với lĩnh vực và định dạng trên.' +
    (avoid ? `\nKhông lặp lại hoặc gần giống các ý đã có:\n${avoid}` : '');
  return { systemInstruction, prompt };
}

export function cleanSuggestions(raw: string[], avoid: string[], count: number): string[] {
  const seen = new Set(avoid.map(key));
  const out: string[] = [];
  for (const r of raw) {
    const text = r.trim().replace(/\s+/g, ' ');
    if (text.length < 3 || text.length > 500 || seen.has(key(text))) continue;
    seen.add(key(text));
    out.push(text);
    if (out.length === count) break;
  }
  return out;
}
```

- [ ] **Step 4: Thêm `suggestIdeas` vào `src/services/ai.service.ts`** (cuối file)

```ts
const IDEAS_SCHEMA = {
  type: Type.OBJECT,
  properties: { ideas: { type: Type.ARRAY, items: { type: Type.STRING } } },
  required: ['ideas'],
};
const ideasValidator = z.object({ ideas: z.array(z.string()).min(1) });

/** "AI gợi ý ý tưởng" for a schedule: new ideas, none repeating `avoid`. */
export async function suggestIdeas(
  gemini: GeminiCredentials,
  input: { domain: PromptDomain; format: PromptFormat; avoid: string[]; count?: number }
): Promise<string[]> {
  const count = input.count ?? 10;
  const { systemInstruction, prompt } = buildIdeaSuggestPrompt({ ...input, count });
  const client = new GeminiClient(gemini);
  const result = await client.generateJson({ systemInstruction, prompt, responseSchema: IDEAS_SCHEMA, validator: ideasValidator, temperature: 0.9 });
  return cleanSuggestions(result.ideas, input.avoid, count);
}
```

Thêm import `import { buildIdeaSuggestPrompt, cleanSuggestions } from '../lib/idea-suggest';` ở đầu file.

- [ ] **Step 5: Thêm route vào `src/routes/schedules.routes.ts`** (trước `export default`)

Import thêm: `import { getSettings } from '../lib/settings';`, `import { formatForPost } from '../lib/domains';` và `import { suggestIdeas } from '../services/ai.service';`.

```ts
router.post(
  '/:id/ideas/suggest',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const s = await findOwn(req);
    const { domain, format } = await formatForPost({ userId: req.user!.id, pageId: s.pageId, formatId: s.formatId });
    const [ideas, posts] = await Promise.all([
      prisma.scheduleIdea.findMany({ where: { scheduleId: s.id }, orderBy: { createdAt: 'desc' }, take: 60, select: { text: true } }),
      prisma.post.findMany({ where: { scheduleId: s.id, caption: { not: null } }, orderBy: { createdAt: 'desc' }, take: 20, select: { caption: true } }),
    ]);
    // What was already queued or written: the first line of a post is its topic
    const avoid = [...ideas.map((i) => i.text), ...posts.map((p) => p.caption!.split('\n')[0].slice(0, 150))];
    const settings = await getSettings(req.user!.id);
    try {
      const suggested = await suggestIdeas({ apiKey: settings.geminiApiKey, model: settings.geminiModel }, { domain, format, avoid });
      res.json({ success: true, data: { ideas: suggested } });
    } catch (error) {
      throw createError(502, `AI chưa gợi ý được: ${(error as Error).message}`);
    }
  })
);
```

- [ ] **Step 6: Thêm test DB và isolation**

Trong `tests/schedules.db.test.ts`, thêm import `vi` từ vitest, `GeminiClient` và `saveSettings`, rồi thêm test:

```ts
  it('suggests new ideas with AI, never repeating the queued ones', async () => {
    await saveSettings(userId, { geminiApiKey: 'AIzaFakeKeySchedulesApi00000000000000' });
    const created = (await api(server.baseUrl, 'POST', '/api/schedules', { cookie, body: body({ ideas: ['Phòng rầy nâu'] }) })).json.data;
    const gemini = vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ ideas: ['phòng rầy nâu', 'Bón phân đúng lúc', 'Chọn giống lúa'] } as never);
    const res = await api(server.baseUrl, 'POST', `/api/schedules/${created.id}/ideas/suggest`, { cookie });
    expect(res.status).toBe(200);
    expect(res.json.data.ideas).toEqual(['Bón phân đúng lúc', 'Chọn giống lúa']);
    expect(String((gemini.mock.calls[0][0] as { prompt: string }).prompt)).toMatch(/Phòng rầy nâu/);
  });
```

Test này cần user có lĩnh vực nội dung. Trong `beforeAll` của file, gọi `await createStarterDomains(userId);` (import từ `../src/lib/domains`).

Trong `tests/isolation.db.test.ts`, `ROUTE_CASES`:

```ts
  'POST /api/schedules/:id/ideas/suggest': { kind: 'foreign-id', path: (b) => `/api/schedules/${b.scheduleId}/ideas/suggest` },
```

- [ ] **Step 7: Chạy test, typecheck**

Run: `npx vitest run tests/idea-suggest.test.ts && RUN_DB_TESTS=1 npx vitest run tests/schedules.db.test.ts tests/isolation.db.test.ts && npx tsc --noEmit`
Expected: PASS; tsc sạch.

- [ ] **Step 8: Commit**

```bash
git add src/lib/idea-suggest.ts src/services/ai.service.ts src/routes/schedules.routes.ts tests/idea-suggest.test.ts tests/schedules.db.test.ts tests/isolation.db.test.ts
git commit -m "feat(schedules): AI suggests 10 new ideas that do not repeat the queue or past posts"
```

---

### Task 7: Duyệt bài của lịch; đăng tay thì bài rời lịch

**Files:**
- Modify: `src/routes/posts.routes.ts`, `tests/isolation.db.test.ts`
- Test: `tests/schedule-approve.db.test.ts` (mới)

**Interfaces:**
- Consumes: `assertOwnPages` (nội bộ `posts.routes.ts`); `runScheduleTick` (Task 4).
- Produces:
  - `POST /api/posts/:id/approve` → `{ id, status: 'SCHEDULED', approvedAt, scheduledAt }`;
  - `GET /api/posts/:id` và `GET /api/posts` trả thêm `scheduleQueued`, `approvedAt`, `schedule: { id, name } | null`;
  - `claimForPublishing` đặt `scheduleQueued: false`.

- [ ] **Step 1: Viết test `tests/schedule-approve.db.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { runScheduleTick } from '../src/services/schedule-runner';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';
import { saveSettings } from '../src/lib/settings';

let server: Awaited<ReturnType<typeof startTestServer>>;
let cookie: string;
let userId: string;
let pageId: string;
let scheduleId: string;

async function waiting(status: 'READY' | 'DRAFT' = 'READY', at = new Date(Date.now() + 3600_000)) {
  return prisma.post.create({
    data: { userId, pageId, scheduleId, scheduleQueued: true, scheduledAt: at, status, caption: status === 'READY' ? 'Bài' : null, targets: { create: { pageId } } },
  });
}

describe.skipIf(!process.env.RUN_DB_TESTS)('approving schedule posts', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    server = await startTestServer(createApp());
    const u = await createTestUser();
    cookie = u.cookie;
    userId = u.user.id;
    await saveSettings(userId, { fbAppId: '222' });
    pageId = (
      await prisma.facebookPage.create({
        data: { userId, pageId: `APR_${Date.now()}`, pageName: 'P', pageAccessToken: 'EAAfaketokenapprovexxxxxxxxxxxxxxxx', tokenStatus: 'VALID', tokenAppId: '222' },
      })
    ).id;
    scheduleId = (
      await prisma.postSchedule.create({
        data: { userId, pageId, name: 'L', frequency: 'SLOTS', weekdays: [0, 1, 2, 3, 4, 5, 6], slots: ['08:00'], bufferSize: 1, startDate: new Date(), pages: { create: { pageId } } },
      })
    ).id;
  });
  afterAll(async () => {
    const posts = await prisma.post.findMany({ where: { userId }, select: { id: true } });
    await prisma.job.deleteMany({ where: { OR: posts.map((p) => ({ payload: { path: '$.postId', equals: p.id } })) } });
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('approves a written post for its slot', async () => {
    const post = await waiting();
    const res = await api(server.baseUrl, 'POST', `/api/posts/${post.id}/approve`, { cookie });
    expect(res.status).toBe(200);
    expect(await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: 'SCHEDULED', scheduleQueued: true });
    const detail = await api(server.baseUrl, 'GET', `/api/posts/${post.id}`, { cookie });
    expect(detail.json.data).toMatchObject({ scheduleQueued: true, schedule: { id: scheduleId, name: 'L' } });
  });

  it('refuses posts that are not written yet or not from a schedule', async () => {
    const draft = await waiting('DRAFT');
    expect((await api(server.baseUrl, 'POST', `/api/posts/${draft.id}/approve`, { cookie })).status).toBe(400);
    const normal = await prisma.post.create({ data: { userId, pageId, status: 'READY', caption: 'x' } });
    expect((await api(server.baseUrl, 'POST', `/api/posts/${normal.id}/approve`, { cookie })).status).toBe(400);
  });

  it('refuses when a Page of the post cannot publish (App changed)', async () => {
    const post = await waiting();
    await saveSettings(userId, { fbAppId: '333' });
    const res = await api(server.baseUrl, 'POST', `/api/posts/${post.id}/approve`, { cookie });
    await saveSettings(userId, { fbAppId: '222' });
    expect(res.status).toBe(409);
  });

  it('"Đăng ngay" takes the post out of the schedule: the tick never publishes it again', async () => {
    const post = await waiting('READY', new Date(Date.now() - 60_000));
    expect((await api(server.baseUrl, 'POST', `/api/posts/${post.id}/publish`, { cookie, body: {} })).status).toBe(200);
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).scheduleQueued).toBe(false);
    await prisma.post.update({ where: { id: post.id }, data: { status: 'SCHEDULED' } }); // even if it looked approved
    await runScheduleTick(new Date(), { id: scheduleId });
    expect(await prisma.job.count({ where: { type: 'publish_post', payload: { path: '$.postId', equals: post.id } } })).toBe(1);
  });
});
```

- [ ] **Step 2: Chạy test, thấy lỗi**

Run: `RUN_DB_TESTS=1 npx vitest run tests/schedule-approve.db.test.ts`
Expected: FAIL. Route approve trả 404.

- [ ] **Step 3: Sửa `src/routes/posts.routes.ts`**

1. `claimForPublishing`: đổi `data: { status: 'GENERATING' }` thành `data: { status: 'GENERATING', scheduleQueued: false }`, kèm comment `// publishing by hand takes the post out of its schedule`.
2. Trong list (`router.get('/')`), `select` thêm `scheduleQueued: true, approvedAt: true, schedule: { select: { id: true, name: true } },`.
3. Trong `GET /:id`, `include` thêm `schedule: { select: { id: true, name: true } }`. Nếu route dùng `select` thì thêm vào `select`.
4. Thêm route approve, ngay trước `// ─── Retry one Page`:

```ts
// ─── Approve a schedule post for its slot ───────

router.post(
  '/:id/approve',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await prisma.post.findFirst({ where: { id: req.params.id, userId: req.user!.id }, include: { targets: true } });
    if (!post) throw createError(404, 'Post not found');
    if (!post.scheduleQueued || post.status !== 'READY') {
      throw createError(400, 'Chỉ duyệt được bài của lịch đăng đã viết xong và đang chờ duyệt.');
    }
    // Same Page checks as "Đăng": approving a post that cannot go out would fail silently later
    await assertOwnPages(req.user!.id, post.targets.map((t) => t.pageId));
    const { count } = await prisma.post.updateMany({
      where: { id: post.id, status: 'READY', scheduleQueued: true },
      data: { status: 'SCHEDULED', approvedAt: new Date() },
    });
    if (!count) throw createError(409, 'Bài vừa thay đổi, hãy tải lại.');
    await prisma.postLog.create({ data: { postId: post.id, action: 'approved', details: { slot: post.scheduledAt?.toISOString() ?? null } } });
    const saved = await prisma.post.findUniqueOrThrow({ where: { id: post.id }, select: { id: true, status: true, approvedAt: true, scheduledAt: true } });
    res.json({ success: true, data: saved });
  })
);
```

5. Trong `PATCH /:id`: sửa nội dung một bài đã duyệt thì bài vẫn duyệt (status giữ `SCHEDULED`). Không cần đổi gì, vì logic trạng thái hiện có chỉ đổi FAILED/DRAFT → READY. Kiểm tra lại bằng mắt.

- [ ] **Step 4: `tests/isolation.db.test.ts`**, `ROUTE_CASES`:

```ts
  'POST /api/posts/:id/approve': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/approve` },
```

- [ ] **Step 5: Chạy test, typecheck**

Run: `RUN_DB_TESTS=1 npx vitest run tests/schedule-approve.db.test.ts tests/isolation.db.test.ts tests/multi-page.db.test.ts && npx tsc --noEmit`
Expected: PASS; tsc sạch.

- [ ] **Step 6: Commit**

```bash
git add src/routes/posts.routes.ts tests/schedule-approve.db.test.ts tests/isolation.db.test.ts
git commit -m "feat(schedules): approve a schedule post for its slot; publishing by hand takes it out of the schedule"
```

---

### Task 8: Client: trang Lịch đăng (danh sách + form tạo/sửa)

**Files:**
- Modify: `client/src/api.ts`, `client/src/index.css`, `client/src/components/Sidebar.tsx`
- Create: `client/src/components/ScheduleBits.tsx`, `client/src/components/ScheduleForm.tsx`
- Rewrite: `client/src/pages/SchedulesPage.tsx`

**Interfaces:**
- Consumes: các route ở Task 5–7.
- Produces:
  - types `ScheduleSummary`, `ScheduleDetail`, `ScheduleIdea`, `QueuedPost`, `ScheduleInput`;
  - `schedulesApi.{list,get,create,update,toggle,delete,addIdeas,removeIdea,orderIdeas,suggestIdeas}`;
  - `postsApi.approve(id)`;
  - `WEEKDAY_SHORT`, `describeSlots(weekdays, slots)`, `slotLabel(iso)`, `queueStatus(post)` trong `ScheduleBits.tsx`;
  - `<ScheduleForm initial? onClose onSaved />`.

- [ ] **Step 1: `client/src/api.ts`**: thay khối `schedulesApi` bằng:

```ts
export interface ScheduleIdea {
  id: string;
  text: string;
  status: 'QUEUED' | 'USED';
  position: number;
  usedAt: string | null;
  postId: string | null;
}

export interface QueuedPost {
  id: string;
  status: 'DRAFT' | 'GENERATING' | 'READY' | 'SCHEDULED' | 'FAILED';
  scheduledAt: string | null;
  caption: string | null;
  imageUrl: string | null;
  videoUrl: string | null;
  errorMessage: string | null;
  approvedAt: string | null;
}

export interface ScheduleSummary {
  id: string;
  name: string;
  isActive: boolean;
  frequency: string;
  weekdays: number[] | null;
  slots: string[] | null;
  bufferSize: number;
  startDate: string;
  endDate: string | null;
  domain: { id: string; name: string } | null;
  format: { id: string; name: string } | null;
  pages: { id: string; pageName: string; pageAvatar: string | null; isActive: boolean }[];
  ideasLeft: number;
  queuedCount: number;
  awaitingApproval: number;
  nextSlotAt: string | null;
}

export interface ScheduleDetail extends ScheduleSummary {
  ideas: ScheduleIdea[];
  queue: QueuedPost[];
}

export interface ScheduleInput {
  name: string;
  pageIds: string[];
  weekdays: number[];
  slots: string[];
  bufferSize: number;
  startDate?: string;
  endDate?: string | null;
  domainId?: string;
  formatId?: string;
  ideas?: string[];
}

export const schedulesApi = {
  list: () => apiFetch<ScheduleSummary[]>('/schedules'),
  get: (id: string) => apiFetch<ScheduleDetail>(`/schedules/${id}`),
  create: (body: ScheduleInput) => apiFetch<ScheduleSummary>('/schedules', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<ScheduleInput>) => apiFetch<ScheduleSummary>(`/schedules/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  toggle: (id: string) => apiFetch<ScheduleSummary>(`/schedules/${id}/toggle`, { method: 'PATCH' }),
  delete: (id: string) => apiFetch(`/schedules/${id}`, { method: 'DELETE' }),
  addIdeas: (id: string, texts: string[]) => apiFetch<{ added: number }>(`/schedules/${id}/ideas`, { method: 'POST', body: JSON.stringify({ texts }) }),
  removeIdea: (id: string, ideaId: string) => apiFetch(`/schedules/${id}/ideas/${ideaId}`, { method: 'DELETE' }),
  orderIdeas: (id: string, ids: string[]) => apiFetch(`/schedules/${id}/ideas/order`, { method: 'PUT', body: JSON.stringify({ ids }) }),
  suggestIdeas: (id: string) => apiFetch<{ ideas: string[] }>(`/schedules/${id}/ideas/suggest`, { method: 'POST' }),
};
```

Trong `postsApi`, thêm:

```ts
  /** Approve a schedule post for its slot. */
  approve: (id: string) => apiFetch<{ id: string; status: string; scheduledAt: string | null }>(`/posts/${id}/approve`, { method: 'POST' }),
```

- [ ] **Step 2: Tạo `client/src/components/ScheduleBits.tsx`**

```tsx
import type { QueuedPost } from '../api';

/** 0 = Chủ nhật … 6 = Thứ bảy; shown Monday first */
export const WEEKDAY_SHORT = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** "T2, T4, T6 · 08:00, 19:30" · "Mỗi ngày · 08:00" */
export function describeSlots(weekdays: number[] | null, slots: string[] | null): string {
  const days = weekdays ?? [];
  const dayText = days.length === 7 ? 'Mỗi ngày' : WEEKDAY_ORDER.filter((d) => days.includes(d)).map((d) => WEEKDAY_SHORT[d]).join(', ');
  return `${dayText || 'Chưa chọn ngày'} · ${(slots ?? []).join(', ') || 'chưa có giờ'}`;
}

/** "T6 25/09 19:30" in Vietnam time */
export function slotLabel(iso: string | null): string {
  if (!iso) return 'Chưa có khung giờ';
  const d = new Date(iso);
  const vn = new Date(d.getTime() + 7 * 3600_000);
  const dd = String(vn.getUTCDate()).padStart(2, '0');
  const mm = String(vn.getUTCMonth() + 1).padStart(2, '0');
  const hh = String(vn.getUTCHours()).padStart(2, '0');
  const mi = String(vn.getUTCMinutes()).padStart(2, '0');
  return `${WEEKDAY_SHORT[vn.getUTCDay()]} ${dd}/${mm} ${hh}:${mi}`;
}

export function queueStatus(p: Pick<QueuedPost, 'status'>): { label: string; cls: string } {
  switch (p.status) {
    case 'DRAFT':
    case 'GENERATING':
      return { label: 'AI đang viết', cls: 'badge-generating' };
    case 'READY':
      return { label: 'Chờ duyệt', cls: 'badge-ready' };
    case 'SCHEDULED':
      return { label: 'Đã duyệt', cls: 'badge-scheduled' };
    default:
      return { label: 'AI viết lỗi', cls: 'badge-failed' };
  }
}
```

- [ ] **Step 3: Tạo `client/src/components/ScheduleForm.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';
import { schedulesApi, pagesApi, domainsApi, type ContentDomain, type PageInfo, type ScheduleSummary } from '../api';
import { useToast } from './Toast';
import { WEEKDAY_ORDER, WEEKDAY_SHORT } from './ScheduleBits';

interface Props {
  /** Editing an existing schedule; creating when absent */
  initial?: ScheduleSummary;
  onClose: () => void;
  onSaved: (s: ScheduleSummary) => void;
}

const todayVN = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
/** "2026-10-31" (Vietnam day) → ISO of 00:00 that day in Vietnam */
const dayStartIso = (day: string) => new Date(`${day}T00:00:00+07:00`).toISOString();
const isoToDay = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString().slice(0, 10) : '');

export default function ScheduleForm({ initial, onClose, onSaved }: Props) {
  const toast = useToast();
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [domains, setDomains] = useState<ContentDomain[]>([]);
  const [name, setName] = useState(initial?.name ?? '');
  const [pageIds, setPageIds] = useState<string[]>(initial?.pages.map((p) => p.id) ?? []);
  const [weekdays, setWeekdays] = useState<number[]>(initial?.weekdays ?? [1, 2, 3, 4, 5]);
  const [slots, setSlots] = useState<string[]>(initial?.slots ?? ['08:00']);
  const [bufferSize, setBufferSize] = useState(initial?.bufferSize ?? 3);
  const [domainId, setDomainId] = useState(initial?.domain?.id ?? '');
  const [formatId, setFormatId] = useState(initial?.format?.id ?? '');
  const [startDay, setStartDay] = useState(initial ? isoToDay(initial.startDate) : todayVN());
  const [endDay, setEndDay] = useState(isoToDay(initial?.endDate ?? null));
  const [ideasText, setIdeasText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([pagesApi.list(), domainsApi.list()])
      .then(([p, d]) => {
        setPages(p.data.filter((x: PageInfo) => x.isActive));
        setDomains(d.data.filter((x: ContentDomain) => !x.isArchived));
      })
      .catch((e) => toast.error(e.message));
  }, []);

  const domain = domains.find((d) => d.id === domainId) ?? domains[0];
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  async function save() {
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        pageIds,
        weekdays,
        slots,
        bufferSize,
        startDate: dayStartIso(startDay || todayVN()),
        endDate: endDay ? dayStartIso(endDay) : null,
        ...(domain && { domainId: domain.id }),
        ...(formatId && { formatId }),
      };
      const res = initial
        ? await schedulesApi.update(initial.id, body)
        : await schedulesApi.create({ ...body, ideas: ideasText.split('\n').map((l) => l.trim()).filter(Boolean) });
      toast.success(initial ? 'Đã lưu lịch.' : 'Đã tạo lịch — AI sẽ viết sẵn bài cho các khung giờ tới.');
      onSaved(res.data);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  const valid = name.trim() && pageIds.length && weekdays.length && slots.length && slots.every(Boolean);

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-panel schedule-form" role="dialog" aria-modal="true" aria-labelledby="schedule-form-title">
        <header className="modal-head">
          <h2 id="schedule-form-title">{initial ? 'Sửa lịch đăng' : 'Tạo lịch đăng'}</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Đóng"><X size={20} /></button>
        </header>

        <div className="schedule-form-body">
          <div className="form-group">
            <label className="form-label" htmlFor="sf-name">Tên lịch</label>
            <input id="sf-name" className="form-input" value={name} maxLength={100} placeholder="VD: Mẹo nhà nông mỗi sáng" onChange={(e) => setName(e.target.value)} />
          </div>

          <fieldset className="form-group">
            <legend className="form-label">Đăng lên Page</legend>
            {pages.length === 0 && <p className="field-hint">Chưa có Page nào đang kết nối.</p>}
            <div className="check-list">
              {pages.map((p) => (
                <label key={p.id} className="check-item">
                  <input type="checkbox" checked={pageIds.includes(p.id)} onChange={() => setPageIds(toggle(pageIds, p.id))} />
                  {p.pageName}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="form-group">
            <legend className="form-label">Ngày đăng trong tuần</legend>
            <div className="weekday-picker">
              {WEEKDAY_ORDER.map((d) => (
                <button key={d} type="button" className={`chip-btn ${weekdays.includes(d) ? 'active' : ''}`} aria-pressed={weekdays.includes(d)} onClick={() => setWeekdays(toggle(weekdays, d))}>
                  {WEEKDAY_SHORT[d]}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="form-group">
            <legend className="form-label">Khung giờ mỗi ngày (giờ Việt Nam, 1–3 khung)</legend>
            <div className="slot-list">
              {slots.map((s, i) => (
                <span key={i} className="slot-item">
                  <input type="time" className="form-input" value={s} aria-label={`Khung giờ ${i + 1}`} onChange={(e) => setSlots(slots.map((x, j) => (j === i ? e.target.value : x)))} />
                  {slots.length > 1 && (
                    <button type="button" className="btn btn-ghost btn-icon" aria-label={`Bỏ khung giờ ${i + 1}`} onClick={() => setSlots(slots.filter((_, j) => j !== i))}>
                      <Trash2 size={15} />
                    </button>
                  )}
                </span>
              ))}
              {slots.length < 3 && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSlots([...slots, '19:30'])}>
                  <Plus size={14} /> Thêm khung giờ
                </button>
              )}
            </div>
          </fieldset>

          <div className="grid-2 schedule-form-grid">
            <div className="form-group">
              <label className="form-label" htmlFor="sf-domain">Lĩnh vực</label>
              <select id="sf-domain" className="form-select" value={domain?.id ?? ''} onChange={(e) => { setDomainId(e.target.value); setFormatId(''); }}>
                {domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="sf-format">Định dạng bài</label>
              <select id="sf-format" className="form-select" value={formatId} onChange={(e) => setFormatId(e.target.value)}>
                <option value="">Mặc định của lĩnh vực</option>
                {domain?.formats?.filter((f) => !f.isArchived).map((f) => <option key={f.id} value={f.id}>{f.name}{f.withImage ? '' : ' (chỉ chữ)'}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="sf-buffer">Số bài AI viết sẵn</label>
              <input id="sf-buffer" type="number" min={1} max={7} className="form-input" value={bufferSize} onChange={(e) => setBufferSize(Math.min(7, Math.max(1, Number(e.target.value) || 1)))} />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="sf-start">Bắt đầu từ ngày</label>
              <input id="sf-start" type="date" className="form-input" value={startDay} onChange={(e) => setStartDay(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="sf-end">Kết thúc (tuỳ chọn)</label>
              <input id="sf-end" type="date" className="form-input" value={endDay} onChange={(e) => setEndDay(e.target.value)} />
            </div>
          </div>

          {!initial && (
            <div className="form-group">
              <label className="form-label" htmlFor="sf-ideas">Ý tưởng ban đầu (mỗi dòng một ý, thêm sau cũng được)</label>
              <textarea id="sf-ideas" className="form-textarea" rows={4} value={ideasText} placeholder={'Cách tưới lúa tiết kiệm nước mùa khô\nNhận biết rầy nâu sớm'} onChange={(e) => setIdeasText(e.target.value)} />
            </div>
          )}
          <p className="field-hint">AI viết sẵn bài cho các khung giờ tới; bạn duyệt từng bài. Bài chưa duyệt kịp sẽ dời sang khung sau.</p>
        </div>

        <footer className="modal-foot">
          <span />
          <div className="row" style={{ gap: 10 }}>
            <button className="btn btn-secondary" onClick={onClose}>Huỷ</button>
            <button className="btn btn-primary" onClick={save} disabled={!valid || saving}>
              {saving ? <div className="spinner" /> : initial ? 'Lưu lịch' : 'Tạo lịch'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
```

`ContentDomain`/`ContentFormat` trong `client/src/api.ts` dùng `isArchived`; domain không có `isDefault` (format có). `domainsApi.list()` đã bỏ lĩnh vực lưu trữ.

- [ ] **Step 4: Viết lại `client/src/pages/SchedulesPage.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Calendar, Plus, AlertTriangle } from 'lucide-react';
import { schedulesApi, type ScheduleSummary } from '../api';
import { useToast } from '../components/Toast';
import ScheduleForm from '../components/ScheduleForm';
import { describeSlots, slotLabel } from '../components/ScheduleBits';

export default function SchedulesPage() {
  const toast = useToast();
  const [schedules, setSchedules] = useState<ScheduleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = () =>
    schedulesApi
      .list()
      .then((r) => setSchedules(r.data))
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  useEffect(() => void load(), []);

  return (
    <div>
      <div className="page-header schedules-header">
        <div>
          <h1>Lịch đăng</h1>
          <p>AI viết sẵn bài theo hàng chờ ý tưởng, bạn duyệt, hệ thống tự đăng đúng khung giờ.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={18} /> Tạo lịch</button>
      </div>

      {loading ? (
        <div className="loading-page"><div className="spinner spinner-lg" /></div>
      ) : schedules.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <Calendar size={56} style={{ opacity: 0.3 }} aria-hidden="true" />
            <h3>Chưa có lịch đăng</h3>
            <p>Chọn ngày, khung giờ và thêm vài ý tưởng — AI sẽ viết sẵn bài để bạn duyệt.</p>
            <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={18} /> Tạo lịch đầu tiên</button>
          </div>
        </div>
      ) : (
        <div className="grid-2">
          {schedules.map((s) => (
            <Link key={s.id} to={`/schedules/${s.id}`} className="card schedule-card">
              <div className="schedule-card-head">
                <h3>{s.name}</h3>
                <span className={`badge ${s.isActive ? 'badge-published' : 'badge-draft'}`}>{s.isActive ? 'Đang chạy' : 'Tạm dừng'}</span>
              </div>
              <p className="muted">{describeSlots(s.weekdays, s.slots)}</p>
              <p className="muted">{s.pages.map((p) => p.pageName).join(', ') || 'Chưa có Page'}{s.domain ? ` · ${s.domain.name}` : ''}</p>
              <dl className="schedule-stats">
                <div><dt>Khung tới</dt><dd>{s.isActive ? slotLabel(s.nextSlotAt) : '—'}</dd></div>
                <div><dt>Bài viết sẵn</dt><dd>{s.queuedCount}/{s.bufferSize}</dd></div>
                <div><dt>Chờ duyệt</dt><dd className={s.awaitingApproval ? 'attention' : ''}>{s.awaitingApproval}</dd></div>
                <div><dt>Ý tưởng còn</dt><dd className={s.ideasLeft <= 3 ? 'attention' : ''}>{s.ideasLeft}</dd></div>
              </dl>
              {s.ideasLeft <= 3 && s.isActive && (
                <p className="schedule-warn"><AlertTriangle size={14} aria-hidden="true" /> {s.ideasLeft ? `Chỉ còn ${s.ideasLeft} ý tưởng` : 'Hết ý tưởng'} — thêm ý tưởng để lịch không bị ngắt.</p>
              )}
            </Link>
          ))}
        </div>
      )}

      {creating && (
        <ScheduleForm
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 5: CSS**: thêm vào cuối `client/src/index.css`

```css
/* ─── Schedules ────────────────────────────── */
.schedules-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.schedule-card { display: flex; flex-direction: column; gap: 6px; color: inherit; text-decoration: none; transition: border-color var(--transition-fast); }
.schedule-card:hover { border-color: var(--primary-500); }
.schedule-card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.schedule-card-head h3 { font-size: 1rem; margin: 0; }
.schedule-card .muted { margin: 0; font-size: 0.82rem; }
.schedule-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 10px 0 0; }
.schedule-stats dt { font-size: 0.72rem; color: var(--text-tertiary); }
.schedule-stats dd { margin: 0; font-weight: 600; font-size: 0.88rem; }
.schedule-stats dd.attention, .schedule-warn { color: var(--warning-600, #b45309); }
.schedule-warn { display: flex; align-items: center; gap: 6px; font-size: 0.8rem; margin: 6px 0 0; }
.schedule-form { max-width: 640px; width: 100%; }
.schedule-form-body { overflow-y: auto; padding: 4px 2px; }
.schedule-form fieldset { border: 0; padding: 0; margin-inline: 0; }
.schedule-form-grid { gap: 0 16px; }
.check-list, .weekday-picker, .slot-list { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.check-item { display: inline-flex; align-items: center; gap: 6px; font-size: 0.88rem; }
.chip-btn.active { background: var(--primary-500); border-color: var(--primary-500); color: #fff; }
.slot-item { display: inline-flex; align-items: center; gap: 4px; }
.slot-item .form-input { width: 120px; }
@media (max-width: 640px) {
  .schedule-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .schedule-form-grid { grid-template-columns: 1fr; }
}
```

Nếu `--warning-600` hoặc `.chip-btn.active` đã tồn tại với tên khác trong `index.css`, dùng lại cái có sẵn và bỏ dòng tương ứng ở đây.

- [ ] **Step 6: `client/src/components/Sidebar.tsx`**: bỏ `<span className="nav-tag">Beta</span>` ở mục Lịch đăng.

- [ ] **Step 7: Typecheck client**

Run: `cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b`
Expected: sạch. Trang chi tiết `/schedules/:id` chưa có (Task 9); các thẻ lịch vẫn link tới đó.

- [ ] **Step 8: Commit**

```bash
git add client/src/api.ts client/src/index.css client/src/components/Sidebar.tsx client/src/components/ScheduleBits.tsx client/src/components/ScheduleForm.tsx client/src/pages/SchedulesPage.tsx
git commit -m "feat(client): schedules list and create/edit form (Pages, weekdays, time slots, ideas)"
```

---

### Task 9: Client: trang chi tiết lịch (bài sắp đăng + hàng chờ ý tưởng), nút Duyệt ở Bài đăng; kiểm tra trên trình duyệt

**Files:**
- Create: `client/src/pages/ScheduleDetailPage.tsx`, `client/src/components/IdeaQueue.tsx`
- Modify: `client/src/App.tsx`, `client/src/pages/PostsPage.tsx`, `client/src/index.css`

**Interfaces:**
- Consumes: `schedulesApi`, `postsApi.approve`, `ScheduleBits`, `ScheduleForm`, `EditPostModal` (`{ postId, onClose, onSaved }`).
- Produces: route `/schedules/:id`; `<IdeaQueue scheduleId ideas onChanged />`.

- [ ] **Step 1: Tạo `client/src/components/IdeaQueue.tsx`**

```tsx
import { useState } from 'react';
import { ArrowUp, ArrowDown, Trash2, Sparkles, Plus } from 'lucide-react';
import { schedulesApi, type ScheduleIdea } from '../api';
import { useToast } from './Toast';

interface Props {
  scheduleId: string;
  ideas: ScheduleIdea[];
  onChanged: () => void;
}

/** The ideas a schedule writes from: add (typed or AI-suggested), reorder, remove. */
export default function IdeaQueue({ scheduleId, ideas, onChanged }: Props) {
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [suggested, setSuggested] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState<null | 'add' | 'suggest' | 'order'>(null);
  const queued = ideas.filter((i) => i.status === 'QUEUED');
  const used = ideas.filter((i) => i.status === 'USED');

  async function add(texts: string[]) {
    if (!texts.length) return;
    setBusy('add');
    try {
      const res = await schedulesApi.addIdeas(scheduleId, texts);
      toast.success(`Đã thêm ${res.data.added} ý tưởng.`);
      setDraft('');
      setSuggested((s) => s.filter((x) => !texts.includes(x)));
      setPicked([]);
      onChanged();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function suggest() {
    setBusy('suggest');
    try {
      const res = await schedulesApi.suggestIdeas(scheduleId);
      setSuggested(res.data.ideas);
      setPicked(res.data.ideas);
      if (!res.data.ideas.length) toast.info('AI chưa nghĩ ra ý mới, thử lại sau nhé.');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function move(index: number, delta: -1 | 1) {
    const ids = queued.map((i) => i.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    setBusy('order');
    try {
      await schedulesApi.orderIdeas(scheduleId, ids);
      onChanged();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    try {
      await schedulesApi.removeIdea(scheduleId, id);
      onChanged();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <section className="card idea-queue" aria-labelledby="idea-queue-title">
      <div className="idea-queue-head">
        <h2 id="idea-queue-title">Hàng chờ ý tưởng <span className="muted">({queued.length})</span></h2>
        <button type="button" className="btn btn-secondary btn-sm" onClick={suggest} disabled={!!busy}>
          {busy === 'suggest' ? <div className="spinner" /> : <Sparkles size={14} aria-hidden="true" />} AI gợi ý 10 ý tưởng
        </button>
      </div>

      {suggested.length > 0 && (
        <div className="idea-suggestions">
          {suggested.map((s) => (
            <label key={s} className="check-item">
              <input type="checkbox" checked={picked.includes(s)} onChange={() => setPicked(picked.includes(s) ? picked.filter((x) => x !== s) : [...picked, s])} />
              {s}
            </label>
          ))}
          <button type="button" className="btn btn-primary btn-sm" onClick={() => add(picked)} disabled={!picked.length || !!busy}>
            <Plus size={14} aria-hidden="true" /> Thêm {picked.length} ý đã chọn
          </button>
        </div>
      )}

      <ol className="idea-list">
        {queued.map((idea, i) => (
          <li key={idea.id}>
            <span className="idea-text">{idea.text}</span>
            <span className="idea-actions">
              <button type="button" className="btn btn-ghost btn-icon" aria-label="Lên trên" disabled={i === 0 || !!busy} onClick={() => move(i, -1)}><ArrowUp size={15} /></button>
              <button type="button" className="btn btn-ghost btn-icon" aria-label="Xuống dưới" disabled={i === queued.length - 1 || !!busy} onClick={() => move(i, 1)}><ArrowDown size={15} /></button>
              <button type="button" className="btn btn-ghost btn-icon danger-hover" aria-label="Xoá ý tưởng" onClick={() => remove(idea.id)}><Trash2 size={15} /></button>
            </span>
          </li>
        ))}
      </ol>
      {queued.length === 0 && <p className="field-hint">Hàng chờ trống — lịch sẽ không viết thêm bài cho tới khi bạn thêm ý tưởng.</p>}

      <div className="idea-add">
        <textarea className="form-textarea" rows={2} value={draft} placeholder="Mỗi dòng một ý tưởng" aria-label="Thêm ý tưởng" onChange={(e) => setDraft(e.target.value)} />
        <button type="button" className="btn btn-secondary btn-sm" disabled={!draft.trim() || !!busy} onClick={() => add(draft.split('\n').map((l) => l.trim()).filter(Boolean))}>
          <Plus size={14} aria-hidden="true" /> Thêm
        </button>
      </div>

      {used.length > 0 && (
        <details className="idea-used">
          <summary>Đã dùng ({used.length})</summary>
          <ul>{used.map((i) => <li key={i.id}>{i.text}</li>)}</ul>
        </details>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Tạo `client/src/pages/ScheduleDetailPage.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, PenLine, Power, PowerOff, Trash2, Settings2 } from 'lucide-react';
import { schedulesApi, postsApi, assetUrl, type ScheduleDetail } from '../api';
import { useToast } from '../components/Toast';
import ScheduleForm from '../components/ScheduleForm';
import EditPostModal from '../components/EditPostModal';
import IdeaQueue from '../components/IdeaQueue';
import { PostThumb, postTitle } from '../components/PostBits';
import { describeSlots, queueStatus, slotLabel } from '../components/ScheduleBits';

export default function ScheduleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const navigate = useNavigate();
  const [s, setS] = useState<ScheduleDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [editingPost, setEditingPost] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () =>
    schedulesApi
      .get(id!)
      .then((r) => setS(r.data))
      .catch((e) => {
        toast.error(e.message);
        navigate('/schedules');
      });
  useEffect(() => void load(), [id]);
  // AI writes in the background: refresh while something is being written
  useEffect(() => {
    if (!s?.queue.some((p) => p.status === 'DRAFT' || p.status === 'GENERATING')) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [s]);

  async function approve(postId: string) {
    setBusy(postId);
    try {
      const res = await postsApi.approve(postId);
      toast.success(`Đã duyệt — bài sẽ đăng lúc ${slotLabel(res.data.scheduledAt)}.`);
      await load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function toggle() {
    try {
      await schedulesApi.toggle(s!.id);
      await load();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function remove() {
    if (!confirmDelete) return setConfirmDelete(true);
    try {
      await schedulesApi.delete(s!.id);
      toast.success('Đã xoá lịch. Các bài đã viết vẫn nằm trong Bài đăng.');
      navigate('/schedules');
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  if (!s) return <div className="loading-page"><div className="spinner spinner-lg" /></div>;

  return (
    <div className="schedule-detail">
      <Link to="/schedules" className="back-link"><ArrowLeft size={15} aria-hidden="true" /> Lịch đăng</Link>
      <div className="page-header schedules-header">
        <div>
          <h1>{s.name} <span className={`badge ${s.isActive ? 'badge-published' : 'badge-draft'}`}>{s.isActive ? 'Đang chạy' : 'Tạm dừng'}</span></h1>
          <p>{describeSlots(s.weekdays, s.slots)} · {s.pages.map((p) => p.pageName).join(', ')}{s.domain ? ` · ${s.domain.name}` : ''}</p>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}><Settings2 size={14} aria-hidden="true" /> Sửa lịch</button>
          <button className={`btn btn-sm ${s.isActive ? 'btn-secondary' : 'btn-primary'}`} onClick={toggle}>
            {s.isActive ? <><PowerOff size={14} aria-hidden="true" /> Tạm dừng</> : <><Power size={14} aria-hidden="true" /> Chạy lại</>}
          </button>
          <button className="btn btn-danger btn-sm" onClick={remove}><Trash2 size={14} aria-hidden="true" /> {confirmDelete ? 'Bấm lần nữa để xoá' : 'Xoá'}</button>
        </div>
      </div>

      <div className="schedule-detail-grid">
        <section className="card" aria-labelledby="queue-title">
          <h2 id="queue-title">Bài sắp đăng</h2>
          {s.queue.length === 0 ? (
            <p className="field-hint">{s.ideasLeft ? 'AI sẽ viết bài trong ít phút tới.' : 'Chưa có bài — thêm ý tưởng để AI viết.'}</p>
          ) : (
            <ul className="queue-list">
              {s.queue.map((p) => {
                const st = queueStatus(p);
                return (
                  <li key={p.id} className="queue-item">
                    <PostThumb src={p.imageUrl} size={48} video={!!p.videoUrl} />
                    <span className="queue-main">
                      <strong>{slotLabel(p.scheduledAt)}</strong>
                      <span className={p.caption ? '' : 'muted'}>{postTitle(p.caption) || (p.status === 'FAILED' ? p.errorMessage : 'AI đang viết…')}</span>
                    </span>
                    <span className={`badge ${st.cls}`}>{st.label}</span>
                    <span className="queue-actions">
                      <button className="btn btn-secondary btn-sm" onClick={() => setEditingPost(p.id)} disabled={p.status === 'GENERATING'}>
                        <PenLine size={14} aria-hidden="true" /> Sửa
                      </button>
                      {p.status === 'READY' && (
                        <button className="btn btn-primary btn-sm" onClick={() => approve(p.id)} disabled={busy === p.id}>
                          {busy === p.id ? <div className="spinner" /> : <Check size={14} aria-hidden="true" />} Duyệt
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="field-hint">Bài chưa duyệt khi tới giờ sẽ dời sang khung sau; các bài phía sau lùi theo.</p>
        </section>

        <IdeaQueue scheduleId={s.id} ideas={s.ideas} onChanged={() => void load()} />
      </div>

      {editing && (
        <ScheduleForm
          initial={s}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
        />
      )}
      {editingPost && <EditPostModal postId={editingPost} onClose={() => setEditingPost(null)} onSaved={() => void load()} />}
    </div>
  );
}
```

(`assetUrl` không dùng thì bỏ khỏi import.)

- [ ] **Step 3: Route trong `client/src/App.tsx`**: thêm ngay sau route `/schedules`, cùng kiểu bọc (`ProtectedRoute` + layout như route `/schedules`):

```tsx
        <Route
          path="/schedules/:id"
          element={
            <ProtectedRoute>
              {/* same wrapper as /schedules */}
              <ScheduleDetailPage />
            </ProtectedRoute>
          }
        />
```

Chép đúng phần bọc bên trong `ProtectedRoute` của route `/schedules`; thẻ comment trên chỉ đánh dấu chỗ chép. Import `ScheduleDetailPage` cùng kiểu với các trang khác (lazy hoặc thường, theo file).

- [ ] **Step 4: `client/src/pages/PostsPage.tsx`**: bài của lịch

- `interface PostData` thêm `scheduleQueued?: boolean; approvedAt?: string | null; schedule?: { id: string; name: string } | null;`.
- Import `postsApi` đã có; thêm `import { slotLabel } from '../components/ScheduleBits';`, và `CalendarClock` từ lucide.
- Thêm hàm, cạnh `publish()`:

```tsx
  async function approve() {
    if (!selectedId) return;
    setActing(true);
    try {
      const res = await postsApi.approve(selectedId);
      toast.success(`Đã duyệt — bài sẽ đăng lúc ${slotLabel(res.data.scheduledAt)}.`);
      await load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setActing(false);
    }
  }
```

- Trong khối nút cuối panel chi tiết (trước nút `PUBLISHABLE.includes(detail.status)`), thêm:

```tsx
              {detail.scheduleQueued && (
                <div className="schedule-note">
                  <CalendarClock size={15} aria-hidden="true" />
                  <span>
                    Theo lịch <Link to={`/schedules/${detail.schedule?.id}`}>{detail.schedule?.name}</Link> · {slotLabel(detail.scheduledAt)}
                    {detail.status === 'SCHEDULED' ? ' · đã duyệt' : ''}
                  </span>
                </div>
              )}
              {detail.scheduleQueued && detail.status === 'READY' && (
                <button type="button" className="btn btn-primary btn-lg btn-block" onClick={approve} disabled={acting || !detail.caption}>
                  <CalendarClock size={16} aria-hidden="true" /> Duyệt — đăng lúc {slotLabel(detail.scheduledAt)}
                </button>
              )}
```

- Với bài của lịch, nút "Duyệt & đăng ngay" hiện có đổi thành nút phụ: thêm `detail.scheduleQueued ? 'btn btn-secondary btn-block' : 'btn btn-primary btn-lg btn-block'` vào `className`, và nhãn khi `detail.scheduleQueued` là `'Đăng ngay (bỏ khung giờ)'`.
- Dòng meta trong danh sách: trước số từ, thêm `{p.scheduleQueued ? '🗓 ' : ''}`. Không dùng emoji nếu file không dùng emoji ở chỗ khác; khi đó dùng chữ `Theo lịch · `.

- [ ] **Step 5: CSS**: thêm vào cuối `client/src/index.css`

```css
.back-link { display: inline-flex; align-items: center; gap: 4px; font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 8px; }
.schedule-detail-grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.schedule-detail-grid h2 { font-size: 1rem; margin: 0 0 12px; }
.queue-list, .idea-list { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.queue-item { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: 'thumb main badge' 'thumb actions actions'; gap: 4px 10px; align-items: center; padding: 8px; border: 1px solid var(--border-subtle); border-radius: 10px; }
.queue-item .post-thumb { grid-area: thumb; }
.queue-main { grid-area: main; display: flex; flex-direction: column; min-width: 0; font-size: 0.85rem; }
.queue-main span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.queue-item .badge { grid-area: badge; }
.queue-actions { grid-area: actions; display: flex; gap: 6px; justify-content: flex-end; }
.idea-queue-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.idea-queue-head h2 { margin: 0; }
.idea-list li { display: flex; align-items: center; gap: 6px; font-size: 0.86rem; }
.idea-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.idea-actions { display: flex; flex-shrink: 0; }
.idea-suggestions { display: flex; flex-direction: column; gap: 6px; padding: 10px; border-radius: 10px; background: var(--bg-secondary); margin-bottom: 10px; }
.idea-add { display: flex; gap: 8px; align-items: flex-start; }
.idea-add .form-textarea { flex: 1; min-height: 56px; }
.idea-used { margin-top: 10px; font-size: 0.82rem; color: var(--text-secondary); }
.schedule-note { display: flex; align-items: center; gap: 6px; font-size: 0.84rem; color: var(--text-secondary); }
@media (max-width: 900px) { .schedule-detail-grid { grid-template-columns: 1fr; } }
```

- [ ] **Step 6: Typecheck + lint client**

Run: `cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b && npm run lint`
Expected: tsc sạch; lint không có **error** mới (warning kiểu cũ chấp nhận được).

- [ ] **Step 7: Kiểm tra trên trình duyệt**

- **Tắt test trước.** Chạy `npm run dev` (API) và Vite (xem `CLAUDE.md`). Đăng nhập tài khoản local.
- Không bấm Đăng lên Page thật:
  - Dùng Page giả tạm thời (tokenStatus VALID) như lần kiểm tra video: tạo bằng script tsx trong `.superpowers/sdd/<plan>/`, xoá khi xong.
  - Spy AI không làm được trong dev server, nên: nếu tài khoản có Gemini key thật thì AI viết thật (chấp nhận được, chỉ tốn quota); nếu không có key thì bài sẽ "AI viết lỗi" và đó cũng là một ca cần xem.
- Dùng Playwright kiểm tra:
  1. `/schedules` → Tạo lịch: chọn Page giả, T2–T6, hai khung giờ, 3 ý tưởng → thẻ lịch hiện "Khung tới" và "Ý tưởng còn 3".
  2. Chờ tick (≤ 60 s) → trang chi tiết có 3 bài "AI đang viết", rồi "Chờ duyệt" (hoặc "AI viết lỗi").
  3. Bấm **Duyệt** một bài → thành "Đã duyệt". Mở **Sửa** → hộp Sửa bài hiện ra.
  4. **AI gợi ý 10 ý tưởng** (khi có key) → chọn vài ý → Thêm. Đổi thứ tự bằng nút lên/xuống; xoá một ý.
  5. **Sửa lịch** đổi khung giờ → giờ của các bài chờ đổi theo.
  6. `/posts` → bài của lịch có dòng "Theo lịch …" và nút "Duyệt — đăng lúc …".
  7. Bề ngang 390 px: không cuộn ngang ở `/schedules`, `/schedules/:id` và trong form.
- Chụp `.playwright-mcp/schedules-list.png` và `.playwright-mcp/schedule-detail.png`.
- Xong thì xoá lịch, bài và Page giả; tắt hẳn các server (`taskkill` cả cây `npm run dev`); xoá job `system:schedule_tick` nếu muốn DB local sạch (không bắt buộc).

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/ScheduleDetailPage.tsx client/src/components/IdeaQueue.tsx client/src/App.tsx client/src/pages/PostsPage.tsx client/src/index.css
git commit -m "feat(client): schedule page with upcoming posts to approve and the idea queue (AI suggestions)"
```

---

### Task 10: Tài liệu, SQL Hostinger, kiểm tra toàn bộ

**Files:** Modify `ROADMAP.md`, `CLAUDE.md`, `docs/DEPLOY_HOSTINGER.md`, `prisma/hostinger-schema.sql`

- [ ] **Step 1: SQL Hostinger**: sinh lại như hướng dẫn trong `CLAUDE.md`, giữ header comment. Import thử vào một database tạm; phải có bảng `schedule_pages` và `schedule_ideas`, cùng các cột `posts.scheduleId`, `posts.scheduleQueued`, `posts.approvedAt`. Xoá database tạm.

- [ ] **Step 2: `ROADMAP.md`**: đổi tiêu đề Phase 2 thành `## Phase 2 — Lịch đăng ✅ (2026-09-30)` và thêm dưới các quyết định:

```markdown
- ✅ (2026-09-30) Lịch theo thứ + 1–3 khung giờ (giờ VN), nhiều Page, hàng chờ ý tưởng + AI gợi ý 10 ý tưởng, giữ sẵn N bài, duyệt trước khi đăng, bài chưa duyệt dời sang khung sau; lịch cũ tự chuyển đổi — plan docs/superpowers/plans/2026-09-30-schedule-slots.md
```

Xoá đoạn "Chờ duyệt: hướng kỹ thuật A…" và "Lỗi của lịch hiện tại cần xử lý khi làm…" (đã xử lý).

- [ ] **Step 3: `CLAUDE.md`**: trong danh sách job ở **Job queue in MariaDB**, thay dòng `run_schedule` bằng:

```markdown
- `schedule_tick` (keyed `system:schedule_tick`, every minute, not booked in tests) and `prepare_post`: slot schedules (`src/services/schedule-runner.ts`). A schedule has weekdays + 1–3 "HH:mm" slots (Vietnam time, `nextSlots` in `src/lib/schedule-time.ts`), Pages (`schedule_pages`) and an idea queue (`schedule_ideas`). The tick keeps `bufferSize` posts written ahead (`Post.scheduleQueued`, `scheduledAt` = slot), publishes the earliest due post once approved (`POST /api/posts/:id/approve` → `SCHEDULED`), and moves unapproved late posts to the next slots. Publishing by hand (`claimForPublishing`) takes a post out of its schedule. `run_schedule` is a no-op kept to drain old jobs.
```

- [ ] **Step 4: `docs/DEPLOY_HOSTINGER.md`**:
  - Trong mục 3 (Kiểm tra sau deploy), thêm bước: "Lịch đăng: tạo một lịch với khung giờ gần nhất và 1 ý tưởng → trong 1–2 phút trang lịch có bài 'AI đang viết' rồi 'Chờ duyệt'. Duyệt bài; đến giờ bài được đăng. Cần Cron Job (mục 4) chạy mỗi phút nếu app hay ngủ."
  - Trong mục 4, ghi rõ: tick lịch đăng chạy mỗi phút trong worker, nên cron `/cron/tick` nên gọi **mỗi phút** (hoặc 5 phút nếu gói giới hạn; khi đó giờ đăng có thể trễ tới 5 phút).

- [ ] **Step 5: Kiểm tra toàn bộ** (không có dev server)

```bash
netstat -ano | grep -E ":(3000|5173) .*LISTENING" || echo "no dev servers"
npx tsc --noEmit && npx vitest run && RUN_DB_TESTS=1 npx vitest run
(cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b && npx -y -p node@22 -- node node_modules/vite/bin/vite.js build)
```

Expected: tất cả PASS, build OK. Chạy bộ test DB hai lần để chắc không chập chờn.

- [ ] **Step 6: Commit và DỪNG**

```bash
git branch --show-current
git add ROADMAP.md CLAUDE.md docs/DEPLOY_HOSTINGER.md prisma/hostinger-schema.sql
git commit -m "docs: slot schedules (Phase 2) — roadmap, architecture notes, deploy checks"
```

Báo người dùng:
- tính năng đã xong trên nhánh, chưa merge, chưa deploy;
- sau khi deploy, các lịch cũ tự chuyển; lịch "Một lần/Hàng tháng" bị tạm dừng kèm "(cần xem lại)";
- nên đặt cron `/cron/tick` mỗi phút.
