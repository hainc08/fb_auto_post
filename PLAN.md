# PLAN — Áp spec `claude-code-prompt-fb-autopost.md` vào codebase hiện tại

> Trạng thái: GĐ0 ✅ · GĐ1 ✅ · **GĐ2 ✅, chờ bạn test bằng token thật** · GĐ3–5 ⬜
> Quyết định đã chốt (2026-09-24): giữ stack theo `AGENTS.md` (Vite + React + CSS thuần / Express / MariaDB + Prisma / BullMQ). Lấy **toàn bộ yêu cầu chức năng** của spec. Các module Lịch / Templates / Dashboard / Pages vẫn giữ nguyên, lúc này không phát triển thêm.

## 1. Ánh xạ spec → dự án

| Spec | Áp vào dự án như sau |
|---|---|
| Next.js Route Handlers | Express routes trong `src/routes/` |
| Tailwind | CSS thuần trong `client/src/index.css` |
| SQLite | MariaDB (đã chạy ở port 3310) |
| Pipeline chạy tuần tự trong server | Chạy tuần tự **bên trong 1 BullMQ job** (có sẵn). Job `generate` chạy bước 1–4, job `publish` chạy bước 6–7 |
| 1 bản ghi `Settings` id=1 | Bảng key-value `settings` **đã có** (`userId + key`). Secret được mã hoá trước khi ghi ⇒ **không cần đổi schema cho Settings** |
| `fbPageId` + `fbPageAccessToken` trong Settings | Giữ bảng `facebook_pages` (hỗ trợ nhiều Page). "Đổi token dài hạn" ⇒ chọn Page ⇒ upsert vào `facebook_pages`, token được **mã hoá**. Form tạo bài có ô chọn Page |
| `@google/genai` | Thay `@google/generative-ai` (SDK cũ, đã ngừng phát triển) |
| Vitest + mock fetch | Thêm cho backend, các test không gọi API thật |

## 2. Schema Prisma — thay đổi đề xuất (CẦN DUYỆT)

```prisma
enum PostMode { PREVIEW  PUBLISH_NOW }
enum StepStatus { RUNNING  SUCCESS  FAILED  SKIPPED }

model Post {
  // ... giữ các trường hiện có ...
  topic       String?   @db.VarChar(500)   // MỚI
  tone        String?                      // MỚI: friendly | professional | humorous
  language    String    @default("vi")     // MỚI
  extraNotes  String?   @db.Text           // MỚI
  mode        PostMode  @default(PREVIEW)  // MỚI
  message     String?   @db.Text           // MỚI: caption + hashtags đã ghép, người dùng sửa được
  imagePath   String?                      // MỚI: storage/images/{postId}.jpg
  errorStep   String?                      // MỚI: bước bị lỗi
  errorCode   String?                      // MỚI: error.code / fbtrace_id của Graph API
  steps       PostStep[]
}

model PostStep {                            // MỚI
  id              String     @id @default(uuid())
  postId          String
  name            String     // generate_content | compose_fields | generate_image | save_image | publish_facebook | check_result
  status          StepStatus
  startedAt       DateTime   @default(now())
  finishedAt      DateTime?
  durationMs      Int?
  requestSummary  Json?      // không chứa token hay base64 ảnh
  responseSummary Json?
  error           String?    @db.Text
  post Post @relation(fields: [postId], references: [id], onDelete: Cascade)
  @@index([postId, startedAt])
  @@map("post_steps")
}
```
- `caption` giữ nguyên là **caption gốc của AI**, `message` là bản sẽ đăng. Nhờ vậy khi đăng lại, hashtag không bị nối lặp.
- `fbPermalink` có sẵn đóng vai trò `fbPostUrl`.
- `PostLog` cũ giữ nguyên để không phá luồng Lịch. Luồng tạo bài mới chỉ ghi vào `PostStep`.
- `FacebookPage.pageAccessToken` giữ kiểu cột, nhưng từ giờ lưu dạng `iv:authTag:ciphertext`.

## 3. Danh sách file

**Mới**
- `src/lib/crypto.ts`: `encrypt` / `decrypt` / `mask` (AES-256-GCM, khoá base64 32 byte lấy từ `ENCRYPTION_KEY`)
- `src/lib/http.ts`: `fetch` có timeout và retry (tối đa 2 lần, chờ 1s rồi 3s, chỉ với lỗi mạng / 429 / 5xx). Hàm lọc token khỏi thông báo lỗi
- `src/lib/settings.ts`: đọc/ghi settings, mã hoá các khoá secret, fallback sang `.env` nếu DB chưa có giá trị
- `src/lib/clients/gemini.ts`: dùng `responseSchema` + zod, parse lỗi thì retry 1 lần, `ping()`
- `src/lib/clients/cloudflare.ts`: adapter nhận JSON base64 (flux) hoặc ảnh binary (SDXL), `verifyToken()`
- `src/lib/clients/facebook.ts`: `publishPhoto` (multipart), `debugToken`, `exchangeLongLived`, `listPages`. Dịch lỗi Graph API sang tiếng Việt
- `src/lib/pipeline/steps/*.ts` (6 bước) + `src/lib/pipeline/runner.ts`: ghi `PostStep`, hỗ trợ chạy lại từ bước lỗi
- `src/routes/images.routes.ts`: `GET /api/images/:postId`, đọc từ `storage/images/` (không public)
- `tests/*.test.ts`: crypto, http retry/timeout, 3 client (mock fetch), runner (thành công / lỗi / chạy lại)
- `vitest.config.ts`, `client/src/pages/PostDetailPage.tsx`, `client/src/components/Toast.tsx`

**Sửa**
- `prisma/schema.prisma` (mục 2), `package.json` (dependency + script `test`), `.gitignore` (`storage/`)
- `src/routes/settings.routes.ts`: trả về mask, để trống = giữ giá trị cũ. Thêm `POST /test/:group` và `POST /facebook/exchange-token`
- `src/routes/posts.routes.ts`: `POST /posts` (topic…) tạo bài rồi đưa job `generate` vào hàng đợi. Thêm `PATCH /:id` (sửa message / imagePrompt), `POST /:id/regenerate-image`, `/publish`, `/retry`
- `src/services/scheduler.service.ts`: worker gọi `runner` (thay pipeline cũ). Luồng Lịch cũng chạy qua runner với chế độ `PUBLISH_NOW`
- `src/routes/pages.routes.ts`, `seed_page.ts`: mã hoá token khi ghi
- `client`: `SettingsPage` (3 nhóm, mask, nút kiểm tra, đổi token), `CreatePostPage` (form spec + 20 bài gần nhất), route `/posts/:id`, `api.ts`
- **Không động tới** `ai.service.ts`, `image.service.ts`, `facebook.service.ts` cũ cho đến khi bạn đồng ý xoá chúng ở cuối (spec yêu cầu hỏi trước khi xoá file)

## 4. Dependencies (thuộc danh sách của spec)
- `@google/genai@^2` (thay `@google/generative-ai`), `vitest@^5` (dev). Không thêm gì khác.

## 5. Giai đoạn và checkpoint
1. **GĐ1**: schema + `crypto.ts` + `http.ts` + Vitest. Tiêu chí: `npm run build` và `npm test` xanh
2. **GĐ2**: module Cấu hình. **DỪNG**, bạn test bằng token thật
3. **GĐ3**: 3 client + runner + test mock
4. **GĐ4**: UI tạo bài, trang chi tiết, polling 2s. **DỪNG**, bạn test end-to-end
5. **GĐ5**: `README.md`, `.env.example`, cập nhật `PROJECT_SPEC.md`

## 6. Câu hỏi (đã trả lời 2026-09-24)
> 1 đồng ý · 2 fallback `.env` · 3 flux-1-schnell · 4 bỏ ô chọn mẫu · 5 người dùng tự điền system prompt trong Settings

1. **`ENCRYPTION_KEY`**: giá trị hiện tại không phải base64 32 byte. Mình sẽ sinh khoá mới và ghi vào `.env`. Page token đang lưu dạng thô sẽ được mã hoá bằng script migrate một lần. Đồng ý không?
2. **Nguồn cấu hình**: khi DB chưa có giá trị thì fallback sang `.env` (Gemini/Cloudflare key hiện có), hay bắt buộc nhập qua UI?
3. **Model mặc định**: spec ghi `flux-1-schnell` (4 bước, nhanh, rẻ), còn `.env` đang dùng `flux-2-dev`. Chọn cái nào? Gemini `gemini-2.5-flash` và Graph `v23.0` theo spec.
4. **Template**: form tạo bài theo spec chỉ gồm topic/tone/language/extraNotes. Có giữ thêm ô "Chọn mẫu" (tuỳ chọn) không, hay bỏ khỏi form mới?
5. **`[TÊN PAGE]` / `[ĐỐI TƯỢNG ĐỘC GIẢ]`** trong system prompt mặc định: tự điền tên Page đang chọn khi tạo bài, còn đối tượng độc giả do bạn nhập trong Settings. OK không?
