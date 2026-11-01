# Stuck Schedule Posts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A slot-schedule post that missed its time can always be published by hand: right now, or at a time the member picks. Approving a post that has no slot left is refused with a clear way out.

**Architecture:**
- The server already lets "Đăng ngay" publish a queued post in any waiting status (`QUEUEABLE` includes `SCHEDULED`; `claimForPublishing` takes the post out of its schedule). What blocks the member is mostly the client.
- The fix opens three paths:
  1. "Đăng ngay (bỏ khung giờ)" for approved queued posts;
  2. "Hẹn giờ đăng" for queued posts, which takes them out of the schedule the way "Đăng ngay" does;
  3. a refusal of "Duyệt" when the schedule has no slot left for the post.

**Tech Stack:** Express + zod + Prisma (MariaDB), Vitest, React client.

**Spec:** none written. The diagnosis below comes from the code; the user's report on 2026-11-02 was: "bài đã lên lịch nhưng quên không duyệt và quá ngày thì không được đăng, dù sửa lại cũng không cho đăng ngay".

**Diagnosis**, as code paths on `main` (3c75afe):
1. **An approved queued post (`SCHEDULED`, `scheduleQueued: true`) has no publish button.** In `client/src/pages/PostsPage.tsx`, `PUBLISHABLE = ['DRAFT','READY','FAILED']` and `timed` requires `!scheduleQueued`.
   - Such a post waits only for the tick.
   - The tick never publishes it in two cases. First, the schedule is paused (`tickSchedule` returns early). Second, its slot was lost because the end date passed (`reslot` sets `scheduledAt: null`, and `isDue` is then always false).
   - Editing does not help: PATCH keeps `SCHEDULED`.
2. **"Duyệt" on a post with no slot (`scheduledAt: null`, after the end date) makes it `SCHEDULED` forever,** and the post falls into case 1.
3. **"Hẹn giờ đăng" refuses every queued post** (`POST /api/posts/:id/schedule` → 400 "Bài này thuộc một lịch đăng…"), and `canTime` hides the button for them.

An unapproved late post in an active schedule is moved to the next slot (`reslot`). That is intended ("approval required"), and it stays as it is.

## Global Constraints

- Branch `fix/stuck-schedule-posts` from `main`. Stage files by name; never commit on `deploy`.
- UI copy is in Vietnamese; code and comments are in English.
- Never publish a schedule post without the member's click. This plan adds no automatic publishing of unapproved posts.
- Publishing or timing a queued post by hand takes it out of its schedule (`scheduleQueued: false`). The schedule then writes another post to refill its buffer, as "Đăng ngay" already does.
- Timed-post rules are unchanged. A queued post that gets a time becomes an ordinary timed post (`status: SCHEDULED`, `scheduleQueued: false`, a delayed `publish_post` job carrying `scheduledFor`).
- Tests never start a worker and never reach Facebook.

## Review Focus

1. **An approved queued post, then "Đăng ngay":** it goes out once, and the tick never publishes it again. → Task 1 test, `scheduleQueued` false after publish, plus a tick run.
2. **A queued post given a time while its own slot is also due:** only the timed job may publish it. The tick must no longer see it (`scheduleQueued: false` before the job is booked). → Task 1 test.
3. **A paused schedule with an approved post whose slot passed:** "Đăng ngay" works. The UI says why the post did not go out. → Task 1 test (server) and Task 2 (copy).
4. **Approving a post whose schedule has no slot left:** 409 with the way out in the message, and the status stays `READY`. → Task 1 test.
5. **Cancelling the time of a post that came from a schedule** puts it back to "Chờ duyệt" as an ordinary post. It does not rejoin the schedule. → Task 1 test.

---

### Task 1: Server — time a queued post, refuse approval without a slot

**Files:**
- Modify: `src/routes/posts.routes.ts`:
  - `POST /:id/approve` (around line 690);
  - `POST /:id/schedule` (around line 725);
  - single `GET /:id` `schedule` select: add `isActive`, `endDate`.
- Test:
  - `tests/schedule-approve.db.test.ts`: new `it` blocks.
  - `tests/post-timed-routes.db.test.ts`: change the "refuses a post of a slot schedule…" test.

**Interfaces:**
- Produces, as behaviour:
  - `POST /api/posts/:id/schedule` on a post with `scheduleQueued: true`:
    - It now works like any other post.
    - In the same `updateMany` that sets the time, it sets `scheduleQueued: false`. The `where` changes from `scheduleQueued: false` to no condition on `scheduleQueued`.
    - It logs `left_schedule` before `scheduled`.
  - `POST /api/posts/:id/approve` on a queued `READY` post with `scheduledAt === null` → 409. The status stays `READY`. Message, verbatim: `Lịch đã hết khung giờ cho bài này (qua ngày kết thúc). Hãy đăng ngay hoặc hẹn giờ đăng riêng cho bài.`
  - `GET /api/posts/:id` → `schedule: { id, name, isActive, endDate }`.

- [ ] **Step 1: Write the failing tests.**
  - `schedule-approve.db.test.ts`:
    - `"Đăng ngay" publishes an approved post whose slot passed in a paused schedule, and the tick leaves it`
      - A queued post with `SCHEDULED`, `approvedAt` set, and `scheduledAt` 2 hours ago, in a schedule with `isActive: false`.
      - `POST /publish` → 200.
      - The row has `scheduleQueued: false` and status `GENERATING`.
      - Turning the schedule active and running `runScheduleTick(now, { id })` books no second `publish_post` for it. Count the jobs by `payload.postId`, and delete them at the end.
    - `approving a post with no slot left is refused with the way out`
      - A queued `READY` post with `scheduledAt: null`.
      - The answer is 409, with an error matching `/hết khung giờ/` and `/hẹn giờ/`.
      - The status is still `READY`.
  - `post-timed-routes.db.test.ts`: replace the first three lines of "refuses a post of a slot schedule…" with a new test, `a post of a slot schedule can be timed: it leaves the schedule`.
    - `setTime(owned.id, inHours(5))` → 200.
    - The row has `scheduleQueued: false`, `status: 'SCHEDULED'`, and `scheduledAt` at that time.
    - There is one job for it.
    - `DELETE /schedule` on it → 200, and the status is back to `READY` with `scheduleQueued` still `false`.
    - Rename the remaining test to "refuses a post with no content and a post in progress". Drop its final `DELETE` assertion on `owned`, because it is now covered by the new test.
- [ ] **Step 2: Run** `RUN_DB_TESTS=1 npx vitest run tests/schedule-approve.db.test.ts tests/post-timed-routes.db.test.ts`.
  - Expected: the "no slot" test fails (200, not 409).
  - The timed test fails (400 "thuộc một lịch đăng").
  - The paused-schedule publish test may already pass; it pins the server path the client starts using.
- [ ] **Step 3: Implement** the two route changes and the `schedule` select.
- [ ] **Step 4: Run** `RUN_DB_TESTS=1 npx vitest run tests/schedule-approve.db.test.ts tests/post-timed-routes.db.test.ts tests/schedule-runner.db.test.ts tests/post-timing.db.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(schedules): a queued post can be timed by hand; approving without a slot left is refused`.

### Task 2: Client — the buttons and the reason

**Files:**
- Modify: `client/src/pages/PostsPage.tsx` (the detail panel around lines 640–690, `canTime` around line 415, and `rowActions`).

**Interfaces:**
- Consumes: `detail.schedule.isActive`, `detail.schedule.endDate` (Task 1), and the existing `postsApi.publish` / `postsApi.schedule`.

- [ ] **Step 1: Show the publish button for approved queued posts.**
  - The publish button renders when `PUBLISHABLE.includes(status) || timed || (detail.scheduleQueued && detail.status === 'SCHEDULED')`.
  - Its label for queued posts stays `Đăng ngay (bỏ khung giờ)`.
- [ ] **Step 2: Show "Hẹn giờ đăng" for queued posts.**
  - `canTime` drops `!detail.scheduleQueued` and allows `SCHEDULED` when `scheduleQueued`.
  - The button label for queued posts is `Hẹn giờ riêng (bỏ khung giờ)`.
- [ ] **Step 3: Explain why a queued post is stuck.** Add a line under the schedule note, with class `cell-note warn-text`:
  - `scheduledAt === null` → `Lịch đã hết khung giờ (qua ngày kết thúc): bài sẽ không tự đăng. Hãy đăng ngay hoặc hẹn giờ riêng.`, and hide the "Duyệt" button.
  - `!schedule.isActive` → `Lịch đang tạm dừng: bài chưa được đăng. Bật lại lịch, hoặc đăng ngay / hẹn giờ riêng.`
  - `status === 'READY'` and the slot is in the past → `Đã qua giờ đăng mà chưa được duyệt: lịch sẽ dời bài sang khung giờ kế tiếp. Duyệt để đăng ở khung đó, hoặc đăng ngay.`
- [ ] **Step 4: Add the row menu item.** `rowActions` adds `Đăng ngay (bỏ khung giờ)` for queued `READY`/`SCHEDULED` posts with a caption, with confirmation copy `Bấm lần nữa để đăng công khai`.
- [ ] **Step 5: Verify.** In `client/`, run `npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b` and `npm run lint`. Expected: no errors.
- [ ] **Step 6: Commit** `fix(client): a late or approved schedule post can be published or timed by hand, with the reason shown`.

### Task 3: Docs and full run

- [ ] **Step 1: Update the docs.** In `CLAUDE.md`'s schedule bullet, after "Publishing by hand (`claimForPublishing`) takes a post out of its schedule.", add: "So does giving it a time (`POST /api/posts/:id/schedule` sets `scheduleQueued: false`). Approving a queued post with no slot left (`scheduledAt` null after the end date) is refused."
- [ ] **Step 2: Run** `npx tsc --noEmit` and `RUN_DB_TESTS=1 npx vitest run`, with no dev server running. Expected: all pass except the known drift test "duplicate name 409".
- [ ] **Step 3: Commit** `docs: stuck schedule posts`.
