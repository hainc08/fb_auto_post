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

## Phase 2 — Lịch đăng ⏸ (tạm hoãn 2026-09-24, người dùng làm các phần cơ bản khác trước)

**Quyết định đã chốt khi brainstorm (2026-09-24), dùng lại khi tiếp tục:**
1. AI tạo bài sẵn → người dùng duyệt (sửa được) → tự đăng đúng giờ.
2. Mỗi lịch có hàng chờ ý tưởng, lấy lần lượt + nút "AI gợi ý 10 ý tưởng" (không trùng bài đã đăng); cảnh báo khi sắp hết.
3. Tần suất: chọn các thứ trong tuần + 1–3 khung giờ/ngày, giờ Việt Nam (không cron tuỳ biến).
4. Luôn giữ sẵn N bài cho các lượt kế tiếp (mặc định 3), tự viết bù khi duyệt/xoá.
5. Đến giờ mà bài chưa duyệt → dời sang khung giờ trống kế tiếp, các bài sau lùi theo.

**Chờ duyệt:** hướng kỹ thuật A (đề xuất): 1 job BullMQ chạy mỗi phút, dữ liệu gốc nằm trong MariaDB (tạo bù bài + đăng bài đã duyệt / dời bài chưa duyệt), job tự tạo lại khi khởi động. Giả định chưa xác nhận: bài theo lịch luôn có ảnh AI; 1 lịch = 1 Page; nhắc duyệt bằng số bài chờ duyệt trên menu/Dashboard (chưa gửi email); bỏ lịch cũ và cron tuỳ biến.

**Lỗi của lịch hiện tại cần xử lý khi làm:** cùng 1 ý tưởng cho mọi lượt; đăng thẳng không duyệt; giờ tính theo máy chủ (sai khi server chạy UTC); "Một lần" thực ra lặp lại hằng năm; ngày kết thúc bị bỏ qua; sửa giờ không cập nhật lịch chạy; lịch chỉ nằm trong Redis nên mất khi Redis bị xoá.

## Phase 3 — "Bộ não marketing" ⬜
- **Brand Profile theo Page**: giọng văn, chân dung khách hàng, USP, từ cấm, CTA mặc định, emoji level
- **Content pillars** (Giáo dục / Social proof / Bán hàng / Giải trí, tỉ lệ 4-1-1) + công thức viết (AIDA, PAS, Hook-Story-Offer, Listicle)
- Sinh **3 phương án caption** để chọn; chấm điểm hook
- **Kế hoạch 30 ngày** tự động từ pillars → hàng loạt bài nháp
- Kiểm tra rủi ro chính sách FB (engagement-bait, claim y tế/tài chính, chữ trên ảnh)

## Phase 4 — Đo lường & vòng phản hồi ⬜
- Đồng bộ insights bài viết (Graph API, metric còn hỗ trợ ở phiên bản hiện hành)
- Dashboard thật: reach/engagement theo pillar, khung giờ vàng
- Đưa bài top hiệu quả làm few-shot cho AI

## Phase 5 — Đa nhà cung cấp AI ⬜
- Text: Gemini / OpenAI / Claude; Ảnh: Cloudflare / DALL-E — chọn trong Settings

## Phase 6 — Production ⬜
- Mã hoá Page token, kết nối Page qua FB Login (OAuth), auth (khi được yêu cầu), deploy Hostinger
