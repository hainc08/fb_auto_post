# Auto Post — Roadmap thực thi

> Nguồn nghiệp vụ: `PROJECT_SPEC.md`. File này là kế hoạch triển khai theo phase, cập nhật trạng thái sau mỗi phase.
> Chú thích: ⬜ chưa làm · 🔄 đang làm · ✅ xong

## Hiện trạng (audit 2026-09-24)

| Vấn đề | Mức độ |
|---|---|
| Backend **không compile**: `settings.routes.ts` import module không tồn tại (`requireAuth`, `../config/prisma`, `../utils/error`); Prisma client cũ không có model `Setting` | 🔴 chặn |
| Schema đang là PostgreSQL, trong khi quy định dự án là **MariaDB** (và Hostinger chạy MySQL/MariaDB). `String[]` và `mode: 'insensitive'` không chạy trên MySQL | 🔴 chặn |
| DB hiện tại lỗi xác thực (`credentials for autopost are not valid`) | 🔴 chặn |
| `@types/express@5` dùng với `express@4` → lỗi type `req.params` | 🟠 |
| Ảnh **upload / preview bị bỏ qua** khi đăng: worker `skipImage=true` ⇒ `imageBuffer=null` ⇒ đăng bài chỉ có chữ | 🔴 bug nghiệp vụ |
| Ảnh preview không lưu lại ⇒ worker sinh ảnh **khác** ảnh người dùng đã duyệt | 🔴 bug nghiệp vụ |
| Retry job nối hashtag/CTA **lặp lại** vào caption (caption cuối ghi đè caption gốc) | 🟠 |
| `imagePromptPrefix` trong Settings không được dùng ở đâu cả | 🟠 |
| Lịch lặp tính cron theo giờ máy chủ (sai khi deploy server UTC) | 🟠 |
| Secret thật nằm trong `.env.example` và `seed_page.ts` (Gemini key, Cloudflare token, Page token) | 🔴 bảo mật |
| UX: dùng `alert()/confirm()`, phải bấm "Tạo nháp" trước khi được dùng AI | 🟡 |

## Phase 0 — Nền móng chạy được ✅
- Chuyển Prisma sang MariaDB (docker service riêng), `String[]` → `Json`
- Sửa toàn bộ lỗi compile backend + client
- Sửa `settings.routes.ts` theo chuẩn `asyncHandler/createError`
- Dọn secret khỏi `.env.example` / `seed_page.ts` (đọc từ env)
- Tiêu chí xong: `tsc` sạch cả 2 phía, server lên, `/health` OK, CRUD settings/templates/posts chạy

## Phase 1 — Pipeline tạo & đăng bài đúng, tin cậy 🔄
> Thực hiện theo spec `claude-code-prompt-fb-autopost.md`, chi tiết ở `PLAN.md` (GĐ1–GĐ5). Các mục dưới đây được spec bao phủ.

- Lưu ảnh (AI preview hoặc upload) vào `uploads/`, serve static, gán `imageUrl` ⇒ worker đăng **đúng ảnh đã duyệt**
- Endpoint `POST /posts/:id/upload-image` (multer) + tab "AI tạo ảnh / Tải ảnh lên"
- Tách `caption` (gốc) và caption cuối khi đăng ⇒ retry idempotent
- Áp `imagePromptPrefix` + `systemPrompt` từ Settings
- Create Post 1 luồng: tự tạo nháp khi bấm "AI viết bài"; toast thay `alert`
- Theo dõi trạng thái đăng realtime (poll) + nút "Thử lại" cho bài FAILED
- ✅ (2026-09-25) Sửa lỗi độ tin cậy khi đăng: caption gốc không bị ghi đè (bản đăng lưu vào `message`); chỉ báo FAILED + email ở lần thử cuối; không đăng trùng (chặn khi đã có `fbPostId`, không retry khi Facebook timeout); bài có `scheduledAt` được đưa vào hàng đợi trễ; worker dùng `lib/clients/facebook` (Graph v23, lỗi tiếng Việt)
- ✅ (2026-09-25) Bỏ Redis: hàng đợi job trong MariaDB (bảng `jobs`)
- ✅ (2026-09-25) Đăng 1 bài lên nhiều Page (`post_targets`), trạng thái + link từng Page, giãn cách mặc định 2 phút, đăng lại từng Page lỗi
- ✅ (2026-09-30) Tải video từ máy lên (MP4/MOV ≤ 100 MB), đăng dạng bài video hoặc Reels (kiểm tra điều kiện Reels trước khi đăng) — plan docs/superpowers/plans/2026-09-30-video-upload.md

## Phase 1b — Quản lý Page theo App ID 🔄 (plan chốt 2026-09-25)

**Vấn đề:** `facebook_pages` không biết token do app nào cấp. Đổi App ID xong, Page không được tick khi "Đổi token dài hạn" vẫn hiện trong ô chọn và vẫn đăng qua app cũ (Development ⇒ người khác không thấy bài). Nút Kết nối Page dùng `VITE_FB_APP_ID` gắn cứng lúc build.

**Quyết định đã chốt:**
1. Page còn token của app cũ ⇒ **chặn đăng**, báo cần đồng bộ.
2. Page không còn trong token mới ⇒ chuyển **Đã ngắt** (`isActive=false`), giữ lịch sử; không bao giờ xoá cứng (xoá Page cascade xoá bài).
3. **Một app hiện tại** (App ID trong Cài đặt); mỗi Page lưu `tokenAppId` để phát hiện lệch.
4. Lấy User token bằng **cả hai**: nút Đăng nhập Facebook (App ID lấy lúc chạy từ API) + ô dán token từ Graph API Explorer.

**Giai đoạn:**
- ✅ GĐ1 (2026-09-25) Dữ liệu & kiểm tra: cột `tokenAppId`, `tokenStatus` (VALID/OTHER_APP/EXPIRED/MISSING_PERMISSIONS/REVOKED/UNCHECKED), `tokenExpiresAt`, `missingScopes`, `tokenCheckedAt`, `tokenError`; `src/lib/page-health.ts` (debug_token từng Page); tự điền cho Page cũ; `/pages` trả `postable` + lý do.
- ✅ GĐ2 (2026-09-25) Đồng bộ Page: `POST /pages/sync/preview` (cập nhật / thêm mới / mất quyền) + `/pages/sync/apply`; gộp 3 đường kết nối cũ (FB Login, đổi token, nhập tay) vào luồng này; lưu App ID mới ⇒ đánh dấu `OTHER_APP`.
- ✅ GĐ3 (2026-09-25) Giao diện: trang Kênh Facebook thành bảng quản lý (app cấp token, trạng thái, hạn, kiểm tra lại, ngắt); banner "Đã đổi Facebook App — N Page cần đồng bộ"; ô chọn Page (Tạo bài, sidebar) chỉ cho chọn Page đăng được, Page khác mờ + lý do; FB SDK init bằng App ID runtime.
- ✅ GĐ4 (2026-09-25) Chặn & giám sát: route tạo bài / publish / đăng lại + worker (bài hẹn giờ, lịch) từ chối Page không `postable`; `/cron/tick` (CRON_SECRET) cho Cron Job hPanel mỗi phút, `/health` báo nhịp worker + `dueJobs`; job `check_page_tokens` hằng ngày; cảnh báo token hết hạn trong 7 ngày.
- ✅ Test: mock Graph (app khác / thiếu quyền / hết hạn) — `tests/page-health.test.ts`; test DB luồng đồng bộ — `tests/page-sync.db.test.ts`.

## Phase 1c — Facebook Story (ảnh + video giọng đọc, phụ đề karaoke) ⬜ plan đã lưu (2026-09-25)
Nguồn: `prompt_creator_video.md`. Review + plan chi tiết: `docs/STORY_VIDEO_PLAN.md`. Đã chốt: AI viết kịch bản ngắn · xem trước rồi mới đăng · TTS Azure F0 miễn phí (500k ký tự/tháng). Bắt buộc làm **GĐ0 PoC FFmpeg trên Hostinger** trước.

## Phase 1d — Nhiều người dùng & Lĩnh vực nội dung 🔄 (spec 2026-09-28)
Spec: `docs/superpowers/specs/2026-09-28-multi-user-domains-design.md`. Branch `feature/multi-user-domains`.
- ✅ M1 (2026-09-28) Đăng nhập bằng cookie, vai trò ADMIN/USER, admin quản lý member (thêm/sửa/xoá/vô hiệu hoá, admin đặt mật khẩu), tách dữ liệu theo user (test phủ mọi route), key `.env` chỉ dành cho admin — plan `docs/superpowers/plans/2026-09-28-m1-multi-user-auth.md`
  - Deploy cần thêm biến: `JWT_SECRET` (≥ 32 ký tự, thiếu thì server không khởi động), `ADMIN_EMAIL` + `ADMIN_PASSWORD` (lần đầu)
- ✅ M2 (2026-09-28) Lĩnh vực & Định dạng (backend): bảng `content_domains`/`content_formats`, ghép prompt, chuyển prompt cũ thành "Mặc định / Bài chuẩn" (viết y hệt trước), bộ khởi đầu cho member mới, API + xem trước prompt, lĩnh vực mặc định của Page, lịch theo lĩnh vực — plan `docs/superpowers/plans/2026-09-28-m2-m4-content-domains.md`
- ✅ M3 (2026-09-28) Giao diện: trang Lĩnh vực (định dạng, xem prompt, thử viết), Tạo bài chọn lĩnh vực + định dạng, cột lĩnh vực mặc định ở Kênh Facebook, lọc bài theo lĩnh vực, checklist khởi động
- ✅ M4 (2026-09-29) Tài liệu: AGENTS.md, README, DEPLOY_HOSTINGER (mục 6b checklist nâng cấp) — deploy do người dùng thực hiện theo mục 6b

## Phase 2 — Lịch đăng ✅ (2026-09-30)

**Quyết định đã chốt khi brainstorm (2026-09-24), dùng lại khi tiếp tục:**
1. AI tạo bài sẵn → người dùng duyệt (sửa được) → tự đăng đúng giờ.
2. Mỗi lịch có hàng chờ ý tưởng, lấy lần lượt + nút "AI gợi ý 10 ý tưởng" (không trùng bài đã đăng); cảnh báo khi sắp hết.
3. Tần suất: chọn các thứ trong tuần + 1–3 khung giờ/ngày, giờ Việt Nam (không cron tuỳ biến).
4. Luôn giữ sẵn N bài cho các lượt kế tiếp (mặc định 3), tự viết bù khi duyệt/xoá.
5. Đến giờ mà bài chưa duyệt → dời sang khung giờ trống kế tiếp, các bài sau lùi theo.

- ✅ (2026-09-30) Lịch theo thứ + 1–3 khung giờ (giờ VN), nhiều Page, hàng chờ ý tưởng + AI gợi ý 10 ý tưởng, giữ sẵn N bài, duyệt trước khi đăng, bài chưa duyệt dời sang khung sau; lịch cũ tự chuyển đổi — plan docs/superpowers/plans/2026-09-30-schedule-slots.md
- ✅ (2026-10-02) Hẹn giờ đăng cho bài lẻ (không cần tạo lịch): chọn ngày giờ ở trang Tạo bài hoặc trong chi tiết bài; đổi giờ, huỷ hẹn giờ, đăng ngay — plan docs/superpowers/plans/2026-10-02-timed-posts.md
- ✅ (2026-10-03) Tạo Reel từ bài: AI viết kịch bản ngắn → giọng đọc Edge TTS → phụ đề chạy theo lời → FFmpeg dựng video 9:16 → thành video Reels của bài. Chạy nền qua hàng đợi, có thanh tiến trình; FFmpeg (ffmpeg-static) và font Be Vietnam Pro đi kèm app nên chạy được trên Hostinger; kiểm tra sau deploy bằng `/cron/reel-check` — plans docs/superpowers/plans/2026-10-02-text-to-reel.md, 2026-10-03-reel-on-hostinger.md. Edge TTS là dịch vụ không chính thức: nếu bị chặn, đổi sang Azure Speech.
- ✅ (2026-10-04) Reel theo từng cảnh: mỗi cảnh có lời đọc và ảnh riêng (AI tạo từ mô tả hoặc tự tải lên), ảnh đổi đúng lúc giọng đọc sang cảnh mới; mỗi lĩnh vực có "Hướng dẫn viết kịch bản Reel" riêng — plan docs/superpowers/plans/2026-10-04-reel-scenes.md

## Phase 3 — "Bộ não marketing" ⬜
- **Brand Profile theo Page**: giọng văn, chân dung khách hàng, USP, từ cấm, CTA mặc định, emoji level
- **Content pillars** (Giáo dục / Social proof / Bán hàng / Giải trí, tỉ lệ 4-1-1) + công thức viết (AIDA, PAS, Hook-Story-Offer, Listicle)
- Sinh **3 phương án caption** để chọn; chấm điểm hook
- **Kế hoạch 30 ngày** tự động từ pillars → hàng loạt bài nháp
- Kiểm tra rủi ro chính sách FB (engagement-bait, claim y tế/tài chính, chữ trên ảnh)

## Phase 4 — Đo lường & vòng phản hồi 🔄
- ✅ (2026-09-30) Lượt cảm xúc/bình luận/chia sẻ từng bài (đồng bộ mỗi giờ + Làm mới), xem và trả lời bình luận bằng tên Page, "cần trả lời" — plan docs/superpowers/plans/2026-09-30-engagement-comments.md
- Đồng bộ insights bài viết (Graph API, metric còn hỗ trợ ở phiên bản hiện hành)
- Dashboard thật: reach/engagement theo pillar, khung giờ vàng
- Đưa bài top hiệu quả làm few-shot cho AI

## Phase 5 — Đa nhà cung cấp AI ⬜
- Text: Gemini / OpenAI / Claude; Ảnh: Cloudflare / DALL-E — chọn trong Settings

## Phase 6 — Production ⬜
- Mã hoá Page token, kết nối Page qua FB Login (OAuth), auth (khi được yêu cầu), deploy Hostinger
