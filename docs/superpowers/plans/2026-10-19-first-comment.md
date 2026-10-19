# Bình luận đầu theo lĩnh vực Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mỗi lĩnh vực có một mẫu "bình luận đầu". Khi bài của lĩnh vực đó lên Page xong, app tự đăng mẫu đó làm bình luận đầu của Page đó; lỗi không làm bài bị đánh dấu thất bại và có nút đăng lại.

**Architecture:** Mẫu nằm trên `ContentDomain` (cấu hình bởi quản trị viên workspace trong trang Lĩnh vực). `runTargetJob` sau khi có `fbPostId` gọi `postFirstComment` (service mới), dùng một lần gọi Graph `POST {postId}/comments` qua `FacebookClient.createComment`. Kết quả lưu trên `PostTarget` (id, nội dung đã đăng, lỗi) để job thử lại không đăng trùng. Bình luận được hiện trong bảng bình luận hiện có nhờ đồng bộ hằng giờ.

**Tech Stack:** Prisma/MariaDB (cột thêm), Express + zod, Facebook Graph API, React, Vitest.

**Spec:** không có file thiết kế riêng; quyết định lấy từ chat ngày 2026-10-19: (1) nội dung cấu hình theo lĩnh vực, (2) tự động sau khi đăng, theo định dạng đã cấu hình, (3) không bắt buộc báo tiếp thị liên kết.

Quyết định lập kế hoạch (người dùng có thể đổi trước khi thực hiện):

1. "Cấu hình trong admin" hiểu là người có vai trò ADMIN của workspace sửa mẫu trong trang Lĩnh vực. Thành viên EDITOR/VIEWER không sửa được mẫu.
2. Mẫu là văn bản thuần, không có biến thay thế. Không tự chèn tiêu đề bài hay hashtag.
3. Mẫu rỗng hoặc chỉ có khoảng trắng nghĩa là không đăng bình luận đầu.
4. Mẫu được lấy tại thời điểm bài lên Page và lưu lại nguyên văn trên target; sửa mẫu sau đó không đổi bình luận đã đăng.
5. Không có mẫu riêng theo từng bài (YAGNI); thêm sau nếu cần.
6. Không tự thử lại bình luận lỗi. Lỗi hiện trên bài, người dùng bấm "Đăng lại bình luận đầu".

## Global Constraints

- Copy tiếng Việt cho mọi thông báo lỗi và nhãn giao diện; code và comment bằng tiếng Anh.
- Chỉ thêm cột; không đổi hay xoá cột cũ (quy tắc schema của dự án).
- Mẫu tối đa 2000 ký tự, khớp giới hạn bình luận trả lời hiện có.
- Quyền Facebook cần cho bình luận đầu là `pages_manage_engagement` (`COMMENT_REPLY_SCOPE`). Không thêm quyền này vào `REQUIRED_SCOPES`.
- Mọi route mới theo workspace: dùng `tenantOf(req)`, trả 404 cho id của workspace khác, thêm vào `ROUTE_CASES` trong `tests/isolation.db.test.ts`.
- Test không gọi Facebook thật: stub `fetch` trong từng test.
- Trước mọi lần chạy `RUN_DB_TESTS=1`: tắt `npm run dev` (kể cả tiến trình `tsx watch`) và Vite, đảm bảo không có gì lắng nghe cổng 3000.
- Nhánh làm việc: `feat/sp1-workspace-tenancy` (đang dùng). Không merge, không push, không deploy nếu người dùng chưa yêu cầu.

## Review Focus

1. Bài đã lên Page nhưng đăng bình luận lỗi → target vẫn `PUBLISHED`, lỗi được lưu, không bị đánh dấu thất bại (Task 4).
2. Job thử lại sau khi bình luận đã đăng → không đăng bình luận thứ hai (Task 4).
3. Mẫu rỗng hoặc chỉ khoảng trắng → không gọi Facebook, không ghi lỗi (Task 4).
4. Thành viên EDITOR hoặc VIEWER cố sửa mẫu → 403, mẫu không đổi (Task 1).
5. Page thiếu `pages_manage_engagement` → lỗi rõ ràng, bài vẫn là đã đăng (Task 4).

---

## File Structure

| File | Trách nhiệm |
|---|---|
| `prisma/schema.prisma`, `prisma/hostinger-schema.sql` (sửa) | Thêm 4 cột |
| `src/routes/domains.routes.ts` (sửa) | Nhận và kiểm tra `firstCommentTemplate` |
| `src/lib/clients/facebook.ts` (sửa) | Hàm `createComment` |
| `src/services/first-comment.ts` (mới) | `postFirstComment`: đăng một lần, ghi kết quả |
| `src/services/scheduler.service.ts` (sửa) | Gọi `postFirstComment` sau khi bài lên Page |
| `src/routes/first-comment.routes.ts` (mới) | `POST /api/posts/:id/targets/:targetId/first-comment` (đăng lại) |
| `src/app.ts` (sửa) | Gắn router vào `API_ROUTERS` |
| `client/src/pages/DomainsPage.tsx`, `client/src/api.ts` (sửa) | Ô mẫu và kiểu dữ liệu |
| `client/src/pages/PostsPage.tsx` (sửa) | Hiện trạng thái bình luận đầu và nút đăng lại |
| `tests/first-comment.db.test.ts`, `tests/facebook-first-comment.test.ts` (mới) | Test |
| `tests/domains-api.db.test.ts`, `tests/isolation.db.test.ts` (sửa) | Test |
| `CLAUDE.md`, `ROADMAP.md` (sửa) | Tài liệu |

---

### Task 1: Cột dữ liệu và mẫu theo lĩnh vực

**Files:**
- Modify: `prisma/schema.prisma`, `prisma/hostinger-schema.sql`, `src/routes/domains.routes.ts`, `client/src/api.ts`, `client/src/pages/DomainsPage.tsx`
- Test: `tests/domains-api.db.test.ts`

**Interfaces:**
- Produces: `ContentDomain.firstCommentTemplate String? @db.Text`; `PostTarget.firstCommentId String?`, `PostTarget.firstCommentText String? @db.Text`, `PostTarget.firstCommentError String? @db.Text`. Trong `domainFields`: `firstCommentTemplate: text(2000)`.

- [ ] **Step 1: Viết test thất bại** trong `tests/domains-api.db.test.ts`: lưu mẫu, mẫu chỉ khoảng trắng được lưu thành `null`, mẫu 2001 ký tự trả 400, và thành viên EDITOR gọi `PATCH` trả 403 (dùng cách tạo thành viên đã có trong test SP1).

- [ ] **Step 2: Chạy test, xác nhận thất bại** (`RUN_DB_TESTS=1 npx vitest run tests/domains-api.db.test.ts -t "bình luận đầu"`). Kỳ vọng: FAIL, trường chưa tồn tại.

- [ ] **Step 3: Thêm cột** vào `ContentDomain` và `PostTarget` trong `prisma/schema.prisma`, chạy `npx prisma db push --skip-generate && npx prisma generate`, sau đó tái tạo `prisma/hostinger-schema.sql` theo lệnh trong CLAUDE.md, giữ nguyên phần đầu file.

- [ ] **Step 4: Thêm `firstCommentTemplate` vào `domainFields`** và đặt quyền sửa cho hàm `PATCH` theo `requireRole('ADMIN')` (xem `src/lib/tenant.ts`). Chuỗi rỗng sau khi `trim` được lưu thành `null`.

- [ ] **Step 5: Chạy test, xác nhận đạt** (cùng lệnh ở Step 2). Kỳ vọng: PASS.

- [ ] **Step 6: Giao diện** trong `DomainsPage.tsx`: một `textarea` có nhãn "Bình luận đầu (tự động sau khi đăng bài)", `maxLength={2000}`, chỉ bật khi người dùng là ADMIN. Thêm trường vào `ContentDomain` và `DomainInput` trong `api.ts`. Kiểm tra bằng `npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b` (trong `client/`).

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/hostinger-schema.sql src/routes/domains.routes.ts client/src/api.ts client/src/pages/DomainsPage.tsx tests/domains-api.db.test.ts
git commit -m "feat(domains): first-comment template per domain; first-comment columns on post targets"
```

---

### Task 2: Hàm `createComment` trong Facebook client

**Files:**
- Modify: `src/lib/clients/facebook.ts`
- Test: `tests/facebook-first-comment.test.ts` (mới)

**Interfaces:**
- Produces: `FacebookClient.createComment(postId: string, pageToken: string, message: string): Promise<{ id: string }>` — gọi `this.postOnce<{ id: string }>(`${postId}/comments`, new URLSearchParams({ message, access_token: pageToken }), pageToken)`. Giống `replyToComment` nhưng nhận id bài, không phải id bình luận, và không retry.

- [ ] **Step 1: Viết test thất bại**: stub `fetch` trả `{ id: "P_1_C_9" }`; kiểm tra URL kết thúc bằng `/P_1/comments`, body có `message` đúng nội dung và `access_token`, kết quả trả về `id`. Thêm một test: phản hồi lỗi 400 (`code: 200`, "Permissions error") ném `FacebookApiError`.

- [ ] **Step 2: Chạy test, xác nhận thất bại** (`npx vitest run tests/facebook-first-comment.test.ts`). Kỳ vọng: FAIL, `createComment is not a function`.

- [ ] **Step 3: Thêm `createComment`** ngay dưới `replyToComment` trong `facebook.ts`, với đúng chữ ký ở trên.

- [ ] **Step 4: Chạy test, xác nhận đạt.** Kỳ vọng: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/clients/facebook.ts tests/facebook-first-comment.test.ts
git commit -m "feat(facebook): createComment — the Page's first comment under its post"
```

---

### Task 3: Dịch vụ `postFirstComment`

**Files:**
- Create: `src/services/first-comment.ts`
- Test: `tests/first-comment.db.test.ts` (mới, phần đơn vị của dịch vụ)

**Interfaces:**
- Consumes: `FacebookClient.createComment` (Task 2); cột ở Task 1.
- Produces: `postFirstComment(targetId: string, facebook: FacebookClient, pageToken: string, template: string | null): Promise<'posted' | 'skipped' | 'already' | 'failed'>`.

Hành vi:
- Nếu `target.firstCommentId` đã có → trả `'already'`, không gọi Facebook.
- Nếu `template` là `null` hoặc rỗng sau `trim` → trả `'skipped'`, không gọi Facebook, không ghi gì.
- Ngược lại: ghi `firstCommentText = template.trim()` trước khi gọi. Gọi `facebook.createComment(target.fbPostId!, pageToken, text)`.
- Thành công: ghi `firstCommentId = reply.id`, `firstCommentError = null`, trả `'posted'`.
- Lỗi: ghi `firstCommentError` bằng thông báo tiếng Việt của lỗi (dùng `error.message`), trả `'failed'`. Không đổi `status` của target.

- [ ] **Step 1: Viết test thất bại** với stub `createComment` (dùng `vi.spyOn(FacebookClient.prototype, 'createComment')`):
  - mẫu `"Link: https://example.com/a"` → `'posted'`, `firstCommentId` là id trả về, `firstCommentText` đúng;
  - gọi lần hai → `'already'`, spy chỉ được gọi một lần;
  - mẫu `"   "` và mẫu `null` → `'skipped'`, spy không được gọi;
  - spy ném `Error("Permissions error")` → `'failed'`, `firstCommentError` có chữ "Permissions error", `status` của target vẫn `PUBLISHED`.

- [ ] **Step 2: Chạy test, xác nhận thất bại.** Kỳ vọng: FAIL, không tìm thấy module.

- [ ] **Step 3: Viết `src/services/first-comment.ts`** theo hành vi ở trên. Dùng `prisma.postTarget.findUnique` và `updateMany` có điều kiện `firstCommentId: null` để chống đua.

- [ ] **Step 4: Chạy test, xác nhận đạt.** Kỳ vọng: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/first-comment.ts tests/first-comment.db.test.ts
git commit -m "feat(comments): postFirstComment — once per Page target, failures recorded not fatal"
```

---

### Task 4: Gọi dịch vụ sau khi bài lên Page

**Files:**
- Modify: `src/services/scheduler.service.ts` (trong `runTargetJob`, sau khối cập nhật `fbPermalink`)
- Test: `tests/first-comment.db.test.ts` (thêm test tích hợp worker)

**Interfaces:**
- Consumes: `postFirstComment` (Task 3); `pageToken`, `facebook`, `target`, `targetId` đã có trong `runTargetJob`.

Thay đổi: sau dòng `await logStep(post.id, 'published', …)`, gọi:

```ts
// Best effort: the post is already live, so a failed first comment never fails the target
await postFirstComment(targetId, facebook, pageToken, domainTemplate);
```

`domainTemplate` lấy từ `post.domainId` (nếu có): `prisma.contentDomain.findUnique({ where: { id: post.domainId }, select: { firstCommentTemplate: true } })`. Không có lĩnh vực thì truyền `null`. Lỗi `postFirstComment` ngoài dự kiến cũng được bắt và ghi `logger.warn`, không làm job thất bại.

- [ ] **Step 1: Viết test thất bại** trong `tests/first-comment.db.test.ts`:
  - bài có lĩnh vực với mẫu, job `publish_target` chạy với stub Graph (`/feed`/`/photos` trả `id`, permalink trả chuỗi, `/comments` trả `id`) → target `PUBLISHED`, `firstCommentId` có giá trị, log bước `published` tồn tại;
  - `/comments` trả lỗi 400 → target vẫn `PUBLISHED`, `firstCommentError` có nội dung, job không ném lỗi;
  - chạy lại job sau khi đã đăng → `/comments` chỉ được gọi một lần tổng cộng.
  Dùng `startWorkers({ only: ['publish_target'], pollMs: 200 })` như các test worker khác, và stub `fetch` chỉ cho URL `facebook.com`.

- [ ] **Step 2: Chạy test, xác nhận thất bại** (`RUN_DB_TESTS=1 npx vitest run tests/first-comment.db.test.ts`). Kỳ vọng: FAIL, `firstCommentId` là null.

- [ ] **Step 3: Thêm lời gọi** như mô tả ở trên, kèm `import { postFirstComment } from './first-comment';` trong `scheduler.service.ts`.

- [ ] **Step 4: Chạy test, xác nhận đạt, và chạy thêm** `RUN_DB_TESTS=1 npx vitest run tests/scheduler*.db.test.ts tests/multi-page.db.test.ts` để kiểm tra các luồng đăng cũ không bị ảnh hưởng. Kỳ vọng: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/scheduler.service.ts tests/first-comment.db.test.ts
git commit -m "feat(publish): post the domain's first comment after each Page publishes"
```

---

### Task 5: Đăng lại bình luận đầu

**Files:**
- Create: `src/routes/first-comment.routes.ts`
- Modify: `src/app.ts` (thêm vào `API_ROUTERS` dưới `['/api/posts', reelRoutes]`), `tests/isolation.db.test.ts`
- Test: `tests/first-comment.db.test.ts`

**Interfaces:**
- Consumes: `postFirstComment` (Task 3); `tenantOf`, `requireRole` (`src/lib/tenant.ts`); `revealSecret` và `getSettings`.
- Produces: `POST /api/posts/:id/targets/:targetId/first-comment` → `{ success: true, data: { status: 'posted' | 'already' | 'skipped' | 'failed', error: string | null } }`.

Quy tắc:
- Tìm target theo `id: targetId` và `post: { id, workspaceId }` của `tenantOf(req)`; không có → 404.
- Target chưa `PUBLISHED` hoặc chưa có `fbPostId` → 409 "Bài chưa lên Page này nên chưa đăng được bình luận đầu."
- Mẫu lấy từ lĩnh vực hiện tại của bài; lấy lại token Page bằng `revealSecret` và `FacebookClient` như `runTargetJob`.
- Quyền: `requireRole('EDITOR')`.

- [ ] **Step 1: Viết test thất bại** trong `tests/first-comment.db.test.ts`: đăng lại thành công sau khi lỗi (`'posted'`); target chưa đăng → 409; EDITOR đăng lại được; VIEWER nhận 403; người workspace khác gọi nhận 404 (ghi thêm dòng vào `ROUTE_CASES` trong `tests/isolation.db.test.ts` với `kind: 'foreign-id'`).

- [ ] **Step 2: Chạy test, xác nhận thất bại.** Kỳ vọng: FAIL, 404 cho mọi route.

- [ ] **Step 3: Viết `src/routes/first-comment.routes.ts`**, dùng `asyncHandler`, `createError`, zod không cần body. Gắn `router.use(authenticate)` như các router khác (xem `reel.routes.ts`).

- [ ] **Step 4: Gắn router** vào `API_ROUTERS` trong `src/app.ts`, thêm `['/api/posts', firstCommentRoutes]`.

- [ ] **Step 5: Chạy test, xác nhận đạt**: `RUN_DB_TESTS=1 npx vitest run tests/first-comment.db.test.ts tests/isolation.db.test.ts`. Kỳ vọng: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/first-comment.routes.ts src/app.ts tests/first-comment.db.test.ts tests/isolation.db.test.ts
git commit -m "feat(publish): re-post a failed first comment"
```

---

### Task 6: Giao diện trạng thái và nút đăng lại

**Files:**
- Modify: `client/src/api.ts`, `client/src/pages/PostsPage.tsx`, `client/src/index.css`

**Interfaces:**
- Consumes: Task 5's route. Thêm vào kiểu của target trong `api.ts`: `firstCommentId: string | null; firstCommentError: string | null;`. Thêm `postsApi.retryFirstComment(postId, targetId)`.

Hiển thị trong chi tiết bài, dưới mỗi Page đã đăng:
- Có `firstCommentId`: "Đã đăng bình luận đầu".
- Có `firstCommentError` và không có `firstCommentId`: dòng cảnh báo màu cảnh báo với lỗi, kèm nút "Đăng lại bình luận đầu" (gọi `retryFirstComment`, sau đó tải lại bài).
- Không có cả hai: không hiện gì.

- [ ] **Step 1: Thêm kiểu và hàm gọi API** trong `api.ts`.

- [ ] **Step 2: Thêm khối hiển thị** trong `PostsPage.tsx`, dưới danh sách target. Dùng class có sẵn (`comments-note` cho cảnh báo, `btn btn-secondary btn-sm` cho nút).

- [ ] **Step 3: Kiểm tra kiểu và lint**: `npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b` và `npm run lint`; không thêm cảnh báo mới ở `PostsPage.tsx`.

- [ ] **Step 4: Kiểm tra trên trình duyệt** với API giả (cùng cách đã làm ở các mục trước): một bài có lỗi bình luận đầu, bấm đăng lại, thấy thông báo thành công. Kiểm tra màn hình 390px không tràn ngang.

- [ ] **Step 5: Commit**

```bash
git add client/src/api.ts client/src/pages/PostsPage.tsx client/src/index.css
git commit -m "feat(client): first-comment status and re-post button on each Page"
```

---

### Task 7: Tài liệu và kiểm tra toàn bộ

**Files:**
- Modify: `CLAUDE.md` (mục `publish_target`), `ROADMAP.md`

- [ ] **Step 1: Cập nhật `CLAUDE.md`**: một đoạn ngắn về bình luận đầu: mẫu theo lĩnh vực, đăng sau khi bài lên Page, không làm target thất bại, đăng lại qua route mới.

- [ ] **Step 2: Thêm dòng vào `ROADMAP.md`** dưới Phase 2 hoặc mục Phase 4 (chọn nơi hợp lý), với trạng thái ✅ và ngày hoàn thành thực tế.

- [ ] **Step 3: Chạy toàn bộ test**: tắt dev server trước, đảm bảo không có gì ở cổng 3000, rồi `npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run`. Kỳ vọng: không lỗi typecheck; mọi file đạt. Nếu một test cũ lỗi do chạy song song (đã gặp trước đây ở `multi-page`, `post-timed-routes`, `schedules`), chạy lại file đó riêng và báo cả hai kết quả.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md ROADMAP.md
git commit -m "docs: first comment per domain"
```

---

## Ngoài phạm vi

- Mẫu riêng cho từng bài, biến thay thế (tiêu đề, hashtag), nhiều bình luận đầu.
- Tự thử lại bình luận lỗi theo lịch.
- Báo công bố tiếp thị liên kết tự động (người dùng đã nói không bắt buộc).
- Bình luận đầu cho Instagram và TikTok (chờ thiết kế đa kênh).
