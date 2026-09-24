# PROMPT CHO CLAUDE CODE — Web service tạo & đăng bài Facebook tự động bằng AI

> Dán toàn bộ nội dung từ dòng `---` bên dưới vào Claude Code, chạy trong một thư mục trống.

---

Bạn là senior full-stack engineer (TypeScript/Next.js), ưu tiên code đúng, dễ đọc và an toàn khi xử lý secret hơn là code "khéo". Nhiệm vụ: xây một web service tạo bài đăng Facebook tự động, chuyển pipeline n8n hiện có thành ứng dụng web độc lập.

## 1. Ràng buộc quan trọng nhất (đọc trước)

- CHỈ làm 2 module: **(A) Tạo bài đăng** và **(B) Cấu hình** (token, App ID, thông số). KHÔNG thêm đăng nhập/phân quyền, lên lịch, Google Sheets, email thông báo, dashboard thống kê, dark mode hay bất kỳ tính năng nào không có trong spec này.
- KHÔNG BAO GIỜ hard-code secret, log secret ra console, trả secret đầy đủ về client, hay commit file `.env`.
- Mọi lời gọi API bên ngoài (Gemini, Cloudflare, Facebook) CHỈ chạy ở server (Route Handlers / Server Actions). Client không bao giờ thấy token.
- Test tự động KHÔNG được gọi API thật — dùng mock.
- DỪNG LẠI VÀ HỎI TÔI trước khi: thêm dependency ngoài danh sách ở mục 3, thay đổi schema DB sau khi tôi đã duyệt, xóa bất kỳ file nào, hoặc chạy lệnh ngoài thư mục dự án.

## 2. Pipeline gốc (n8n) cần tái hiện

```
Trigger thủ công → Lấy dữ liệu đầu vào → Basic LLM Chain (Gemini + Structured Output Parser)
→ Edit Fields → HTTP POST Cloudflare Workers AI (tạo ảnh) → Chuyển base64 thành ảnh
→ HTTP POST graph.facebook.com (đăng ảnh + caption) → If (thành công?) → nhánh lỗi: báo lỗi
```

Trong app mới:
- "Trigger + lấy dữ liệu" = form nhập chủ đề trên web (thay Google Sheets).
- "If → Gmail" = hiển thị trạng thái thất bại + thông báo lỗi trên UI (không gửi email).

## 3. Stack (cố định)

- Next.js 15 (App Router) + TypeScript strict
- Tailwind CSS (UI đơn giản, không cần thư viện component)
- SQLite + Prisma
- `zod` cho validate input/output
- `@google/genai` cho Gemini
- `fetch` native cho Cloudflare và Facebook Graph API (không dùng SDK Facebook)
- Vitest cho unit test
- Mã hóa secret: `node:crypto` AES-256-GCM, khóa lấy từ biến môi trường `ENCRYPTION_KEY` (32 byte, base64)

## 4. Module B — Cấu hình (trang `/settings`)

Lưu trong DB (1 bản ghi `Settings`), các trường secret được mã hóa AES-256-GCM trước khi lưu.

| Nhóm | Trường | Secret? |
|---|---|---|
| Gemini | `geminiApiKey`, `geminiModel` (mặc định `gemini-2.5-flash`), `systemPrompt` (textarea, có giá trị mặc định ở mục 6) | key: có |
| Cloudflare | `cfAccountId`, `cfApiToken`, `cfImageModel` (mặc định `@cf/black-forest-labs/flux-1-schnell`), `cfSteps` (mặc định 4, tối đa 8) | token: có |
| Facebook | `fbAppId`, `fbAppSecret`, `fbPageId`, `fbPageAccessToken`, `fbGraphVersion` (mặc định `v23.0`, cho phép sửa) | secret & token: có |

Yêu cầu:
- Trường secret hiển thị dạng mask (`••••••abcd`, chỉ 4 ký tự cuối). Để trống khi lưu = giữ giá trị cũ.
- Mỗi nhóm có nút **"Kiểm tra kết nối"** (gọi server):
  - Gemini: gửi prompt ngắn "ping", báo OK/lỗi.
  - Cloudflare: gọi endpoint verify token `GET https://api.cloudflare.com/client/v4/user/tokens/verify`.
  - Facebook: gọi `GET /debug_token?input_token={pageToken}&access_token={appId}|{appSecret}`, hiển thị: token hợp lệ không, loại token, ngày hết hạn, danh sách scopes. Cảnh báo nếu thiếu `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`.
- Tiện ích **"Đổi token dài hạn"**: người dùng dán short-lived User Token → server:
  1. `GET /oauth/access_token?grant_type=fb_exchange_token&client_id={appId}&client_secret={appSecret}&fb_exchange_token={shortToken}` → long-lived user token
  2. `GET /me/accounts?access_token={longUserToken}` → danh sách Page (id, name, access_token)
  3. Người dùng chọn Page → tự điền `fbPageId` + `fbPageAccessToken`.
- Ghi chú giới hạn trên UI: token Page lấy từ long-lived user token thường không hết hạn, nhưng mất hiệu lực khi đổi mật khẩu hoặc gỡ quyền app.

## 5. Module A — Tạo bài đăng (trang `/` và `/posts/[id]`)

### Input (form)
- `topic` (bắt buộc, ≤ 500 ký tự), `tone` (select: thân thiện / chuyên nghiệp / hài hước), `language` (mặc định `vi`), `extraNotes` (tùy chọn)
- Chế độ: **"Xem trước rồi đăng"** (mặc định) hoặc **"Đăng ngay"**

### Các bước pipeline (server, chạy tuần tự, mỗi bước ghi log vào `PostStep`)

1. **generate_content** — Gọi Gemini với `responseMimeType: "application/json"` + `responseSchema` để nhận đúng cấu trúc:
   ```json
   {
     "caption": "string (nội dung bài đăng, có emoji hợp lý, ≤ 2000 ký tự)",
     "hashtags": ["string", "... tối đa 8"],
     "image_prompt": "string (tiếng Anh, mô tả ảnh chi tiết cho model tạo ảnh, KHÔNG yêu cầu chữ trong ảnh)"
   }
   ```
   Validate bằng zod. Nếu parse lỗi → retry 1 lần, rồi fail.
2. **compose_fields** — Ghép `message = caption + "\n\n" + hashtags.join(" ")` (tương đương node Edit Fields).
3. **generate_image** — `POST https://api.cloudflare.com/client/v4/accounts/{cfAccountId}/ai/run/{cfImageModel}` với header `Authorization: Bearer {cfApiToken}`, body `{ "prompt": image_prompt, "steps": cfSteps }`. Model flux trả JSON `{ result: { image: "<base64 jpeg>" } }`. Viết adapter để nếu model trả binary (ví dụ SDXL trả `image/png`) thì vẫn xử lý được, dựa vào `Content-Type`.
4. **save_image** — Decode base64 → Buffer, lưu file vào `./storage/images/{postId}.jpg`, phục vụ preview qua route `/api/images/[id]` (không đặt trong `public/`).
5. **(dừng ở đây nếu chế độ "Xem trước")** — status `READY`. Người dùng có thể sửa `message`, bấm "Tạo lại ảnh" (chạy lại bước 3–4 với `image_prompt` đã sửa), rồi bấm "Đăng".
6. **publish_facebook** — `POST https://graph.facebook.com/{fbGraphVersion}/{fbPageId}/photos` dạng `multipart/form-data`: `source` (file ảnh), `message`, `published=true`, `access_token`. Lưu `post_id` / `id` trả về.
7. **check_result** (tương đương node If) — Có `post_id` → `PUBLISHED`, lưu link `https://facebook.com/{post_id}`. Ngược lại → `FAILED`, lưu `error.message`, `error.code`, `error.fbtrace_id` từ response Graph API.

### Trạng thái bài đăng
`DRAFT → GENERATING → READY → PUBLISHING → PUBLISHED` hoặc `FAILED` (ghi rõ bước lỗi).

### Xử lý lỗi
- Timeout: Gemini 60s, Cloudflare 90s, Facebook 60s.
- Retry tối đa 2 lần với backoff (1s, 3s) cho lỗi mạng và HTTP 429/5xx. KHÔNG retry lỗi 4xx khác (sai token, sai quyền).
- Nút "Chạy lại từ bước lỗi" trên trang chi tiết bài.
- Thông báo lỗi trên UI phải dễ hiểu tiếng Việt, kèm mã lỗi gốc (đã lọc bỏ token).

### UI
- `/` : form tạo bài + danh sách 20 bài gần nhất (thời gian, chủ đề, status, link FB).
- `/posts/[id]` : timeline các bước (status, thời gian chạy, lỗi nếu có), preview ảnh, textarea sửa message, xem/sửa image_prompt, nút Tạo lại ảnh / Đăng / Chạy lại.
- Trang chạy pipeline hiển thị tiến độ bằng polling 2s (không cần WebSocket).

## 6. System prompt mặc định cho Gemini (lưu trong Settings, cho sửa)

```
Bạn là chuyên gia viết content mạng xã hội cho Fanpage [TÊN PAGE], đối tượng [ĐỐI TƯỢNG ĐỘC GIẢ].
Viết bài Facebook theo chủ đề, giọng điệu và ghi chú được cung cấp.
Yêu cầu: câu mở đầu gây chú ý, đoạn ngắn dễ đọc trên điện thoại, kết thúc bằng lời kêu gọi tương tác.
image_prompt phải bằng tiếng Anh, mô tả chủ thể, bối cảnh, ánh sáng, phong cách; không chứa chữ, logo hay người nổi tiếng.
Chỉ trả về JSON đúng schema.
```

## 7. Data model (Prisma) — đề xuất, chờ tôi duyệt

- `Settings` (id=1, các trường ở mục 4, secret lưu dạng `iv:authTag:ciphertext`)
- `Post` (id, topic, tone, language, extraNotes, mode, caption, hashtags JSON, message, imagePrompt, imagePath, fbPostId, fbPostUrl, status, errorStep, errorMessage, createdAt, updatedAt)
- `PostStep` (id, postId, name, status, startedAt, finishedAt, durationMs, requestSummary, responseSummary, error) — summary KHÔNG chứa token hay base64 ảnh.

## 8. Cấu trúc thư mục

```
src/
  app/                    # pages + route handlers
  lib/
    crypto.ts             # encrypt/decrypt/mask
    settings.ts           # đọc/ghi Settings (giải mã chỉ ở server)
    clients/gemini.ts
    clients/cloudflare.ts
    clients/facebook.ts
    pipeline/             # mỗi bước 1 file + runner.ts
    http.ts               # fetch có timeout + retry
prisma/schema.prisma
storage/images/           # gitignored
tests/
```

## 9. Cách làm việc — theo từng giai đoạn, dừng ở checkpoint

- **Giai đoạn 0 — Kế hoạch:** Đọc toàn bộ spec, viết `PLAN.md` (danh sách file, schema Prisma, các câu hỏi chưa rõ). **DỪNG, chờ tôi duyệt.**
- **Giai đoạn 1:** Khởi tạo dự án, Prisma schema, `crypto.ts`, `http.ts` + unit test. Chạy `npm run build` và `npm test` phải xanh.
- **Giai đoạn 2:** Module Cấu hình (UI + lưu mã hóa + 3 nút kiểm tra kết nối + đổi token dài hạn). **DỪNG, báo tôi test bằng token thật.**
- **Giai đoạn 3:** 3 client (Gemini, Cloudflare, Facebook) + pipeline runner + test với mock fetch.
- **Giai đoạn 4:** UI tạo bài, trang chi tiết, preview/sửa/đăng/chạy lại. **DỪNG, báo tôi test end-to-end.**
- **Giai đoạn 5:** `README.md` (cài đặt, tạo `ENCRYPTION_KEY`, cách lấy App ID/Secret và token Page, quyền cần xin), `.env.example`.

Sau mỗi bước, in: `✅ [việc đã xong]` + lệnh để tôi tự kiểm tra.
Nếu cùng một lỗi build/test thất bại 3 lần liên tiếp → DỪNG và mô tả vấn đề, không tiếp tục thử mò.
Chỉ làm đúng những gì được yêu cầu. Không thêm abstraction, file hay tính năng ngoài spec.

## 10. Tiêu chí hoàn thành

- [ ] `npm run build` và `npm test` pass, không có lỗi TypeScript.
- [ ] Lưu cấu hình xong, mở DB thấy secret đã mã hóa; UI và API response chỉ hiện dạng mask.
- [ ] 3 nút "Kiểm tra kết nối" trả kết quả đúng với token hợp lệ và token sai.
- [ ] Nhập 1 chủ đề → nhận caption + hashtags + ảnh preview trong chế độ "Xem trước".
- [ ] Bấm "Đăng" → bài có ảnh + caption xuất hiện trên Fanpage, link FB lưu trong DB.
- [ ] Dùng token sai → status `FAILED`, UI hiện bước lỗi và thông báo dễ hiểu, không lộ token.
- [ ] `grep` toàn bộ log và response không tìm thấy token/secret.
