# Rotation for Waiting Posts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a member turns on "Tự gắn sản phẩm affiliate của lĩnh vực (xoay vòng)" for a schedule, the posts the schedule already wrote and that are still waiting get products too, so nothing has to be attached by hand.

**Architecture:**
- One service function, `attachRotationToQueue`, lives next to the rotation code in `schedule-runner.ts`. It reuses `pickNextProduct` and `setPostProducts` from `src/lib/post-products.ts`.
- `PUT /api/schedules/:id` calls it only when `affiliateRotate` goes from off to on. It returns the count, and the schedule form shows it in its toast.

**Tech Stack:** Express + zod + Prisma (MariaDB), Vitest, React client.

**Spec:** none written. This builds on `docs/superpowers/plans/2026-11-01-affiliate-products.md` (Task 6, rotation for new posts) on the same branch, `feature/affiliate-products`. The user chose "Gắn cho bài đang chờ" on 2026-11-02.

## Global Constraints

- Work on `feature/affiliate-products`. This feature depends on its unmerged code. Stage files by name.
- UI copy is in Vietnamese; code and comments are in English.
- Only posts of this schedule are touched, and only if they meet all of these:
  - `scheduleQueued: true`;
  - status in `DRAFT`, `READY`, `SCHEDULED` or `FAILED` (never `GENERATING`, `PUBLISHING` or `PUBLISHED`);
  - no `post_products` row yet.
- Posts are taken in `scheduledAt` order, one product each, chosen by `pickNextProduct(tx, userId, schedule.domainId)`.
- A post the member already gave products to is never changed.
- Posts the AI has already written keep their text: the AI does not rewrite them. The links are still added at publish time (the message and the first comment). A `DRAFT` post that is not written yet gets the product into its prompt when the prepare job writes it.
- Tests never start a worker. They call the service or the route directly.

## Review Focus

1. **Saving a schedule while rotation is already on, or saving other fields,** must attach nothing new. Otherwise each save would move products around. → Task 1, test 3.
2. **A post being written (`GENERATING`) or being published** must not be touched, so the result never mixes a half-written post with new products. → Task 1, test 2.
3. **A domain with no active product** still saves the schedule, with 0 attached. → Task 1, test 4.
4. **A queued post of another schedule, even of the same user,** is never touched. → Task 1, test 2 (add a post of a second schedule).
5. **Turning rotation off** detaches nothing. → Task 1, test 3.

---

### Task 1: Attach products to the waiting posts when rotation is turned on

**Files:**
- Modify:
  - `src/services/schedule-runner.ts`: add `attachRotationToQueue`.
  - `src/routes/schedules.routes.ts`: the `PUT /:id` handler.
- Test: `tests/schedule-affiliate.db.test.ts`, as new `it` blocks.

**Interfaces:**
- Consumes: `pickNextProduct(tx, userId, domainId)` and `setPostProducts(tx, userId, postId, ids)` from `src/lib/post-products.ts`.
- Produces:
  - `attachRotationToQueue(scheduleId: string): Promise<number>`.
    - It returns how many waiting posts got a product.
    - It runs one transaction per post, so a product picked for one post counts as used before the next pick.
    - It stops at the first post for which `pickNextProduct` returns null.
  - The `PUT /api/schedules/:id` response `data` gains `attachedProducts: number`, which is 0 unless rotation was just turned on.

- [ ] **Step 1: Write the failing tests** in `tests/schedule-affiliate.db.test.ts`. Reuse `setup`. Add a helper that creates queued posts with a status and a slot.
  - `turning rotation on attaches products to the posts waiting in the queue, in slot order`
    - Rotation off; products A and B; 3 queued posts (`READY`, `SCHEDULED`, `DRAFT`) at increasing slots.
    - `PUT { affiliateRotate: true }` returns 200 with `attachedProducts: 3`.
    - The posts' products in slot order are `[['A'], ['B'], ['A']]`.
  - `posts with products, posts being written or published, other schedules' posts and posts out of the queue are untouched`
    - Queued `READY` with manual product X; queued `GENERATING`; queued `PUBLISHING`; `scheduleQueued: false` `READY`; a queued `READY` post of a second schedule of the same user; and one plain queued `READY` post.
    - `attachedProducts: 1`, and only the plain post changed.
    - The post with X still has exactly `['X']`.
  - `saving again while it is on, other edits and turning it off attach or detach nothing`
    - Turn it on (1 post attached). Add a new queued post. Then send `PUT { affiliateRotate: true }`, then `PUT { name: 'Đổi tên' }`, then `PUT { affiliateRotate: false }`.
    - Each answers `attachedProducts: 0`.
    - The new post has no product, and the first post keeps its product.
  - `turning it on with no active product in the domain attaches nothing and still saves`
    - The domain's only product is archived.
    - The answer is 200, with `affiliateRotate: true` and `attachedProducts: 0`.
- [ ] **Step 2: Run** `RUN_DB_TESTS=1 npx vitest run tests/schedule-affiliate.db.test.ts`. Expected: the 4 new tests FAIL (`attachedProducts` is undefined, no products attached).
- [ ] **Step 3: Implement** `attachRotationToQueue` and call it in `PUT /:id` after the update transaction, when `data.affiliateRotate === true && !s.affiliateRotate`.
- [ ] **Step 4: Run** `RUN_DB_TESTS=1 npx vitest run tests/schedule`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(affiliate): turning rotation on attaches products to the schedule's waiting posts`.

### Task 2: Tell the member, and docs

**Files:**
- Modify:
  - `client/src/api.ts`: `ScheduleSummary` gets an optional `attachedProducts?: number`.
  - `client/src/components/ScheduleForm.tsx`: the save toast, and the checkbox hint.
  - `CLAUDE.md`: one sentence in the "Affiliate products" paragraph.

- [ ] **Step 1: Change the toast and the hint.**
  - After an update that answers `attachedProducts > 0`, the toast reads `Đã lưu lịch. Đã gắn sản phẩm cho ${n} bài đang chờ.`
  - The checkbox hint adds: `Khi bật, các bài lịch đã viết sẵn nhưng chưa đăng (chưa có sản phẩm) cũng được gắn luôn; nội dung đã viết giữ nguyên, link được thêm khi đăng.`
- [ ] **Step 2: Verify.** In `client/`, run `npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b` and `npm run lint`. Expected: no errors.
- [ ] **Step 3: Update the docs.** In `CLAUDE.md`'s affiliate paragraph, after the `affiliateRotate` sentence, add: "Turning it on (PUT /api/schedules/:id, off → on) also attaches products to the schedule's waiting posts that have none (`attachRotationToQueue`; not GENERATING/PUBLISHING), answered as `attachedProducts`."
- [ ] **Step 4: Run** `npx tsc --noEmit` and `RUN_DB_TESTS=1 npx vitest run`, with no dev server running. Expected: all pass except the known drift test "duplicate name 409".
- [ ] **Step 5: Commit** `feat(client): say how many waiting posts got products; docs`.
