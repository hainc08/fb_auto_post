# Spec — Nhiều người dùng, Lĩnh vực & Định dạng bài

- Ngày: 2026-09-28 · Branch: `feature/multi-user-domains`
- Trạng thái: **đã duyệt** (cập nhật 2026-09-28: admin đặt mật khẩu cho member, không bắt đổi mật khẩu; admin thêm/sửa/xoá/vô hiệu hoá member)
- Hướng kiến trúc đã chọn: **A — một database chung, tách dữ liệu theo `userId`**

## 1. Mục tiêu & bối cảnh

**Người dùng nói:** hệ thống phục vụ nhiều user; mỗi user đăng nhập, quản lý Page riêng, prompt riêng, và tạo được nhiều định dạng nội dung khác nhau theo từng lĩnh vực (domain).

**Quyết định đã chốt:**

| # | Chủ đề | Quyết định |
|---|---|---|
| 1 | Đối tượng | Nhóm nội bộ / khách quen, 2–20 người. **Admin tạo tài khoản (email + mật khẩu do admin đặt)**, member dùng ngay để đăng nhập, **không bắt đổi mật khẩu**; không tự đăng ký, không thu phí |
| 2 | Key & Facebook App | **Mỗi user tự mang** Gemini, Cloudflare, Facebook App (bảng `settings` theo `userId` đã có) |
| 3 | "Domain" | **Lĩnh vực nội dung** (giọng văn, đối tượng, quy tắc, hashtag, phong cách ảnh) có **nhiều định dạng bài** |
| 4 | Page ↔ Lĩnh vực | Page có **lĩnh vực mặc định**; tạo bài vẫn chọn được Page khác (kèm cảnh báo) |
| 5 | Quyền admin | Quản lý danh sách member: **thêm, sửa (tên, email, mật khẩu, vai trò), xoá, vô hiệu hoá đăng nhập**; **không xem nội dung** của user khác |

**Thành công khi:**
1. User A đăng nhập chỉ thấy Page, bài, lịch, lĩnh vực, cấu hình của A; mọi truy cập vào id của B trả 404.
2. A chọn lĩnh vực "Tiếng Nhật" + định dạng "Hỏi đáp" ⇒ AI viết theo đúng giọng văn/cấu trúc/độ dài đó; prompt đã dùng được lưu vào bài.
3. Dữ liệu và hành vi hiện tại của tài khoản Admin không đổi sau khi deploy (bài tạo ra giống trước khi chưa sửa lĩnh vực).

**Ngoài phạm vi:** tự đăng ký, thanh toán/gói cước, mời/quên mật khẩu qua email, đăng nhập Google/Facebook, admin chia sẻ mẫu, hạn mức theo user, nhật ký thao tác, trang Templates cũ (`content_templates` giữ nguyên, không phát triển).

## 2. Hiện trạng liên quan

- Schema đã có `userId` ở `facebook_pages`, `posts`, `post_schedules`, `content_templates`, `settings`, `api_keys`; các route đều lọc `req.user.id`.
- `auth.middleware.ts` **đang bỏ qua đăng nhập** (tự lấy/ tạo user đầu tiên). `auth.routes.ts` có sẵn register/login JWT (bcrypt cost 12). Client lưu token ở `localStorage`.
- `GET /api/images/:postId` **công khai**, không kiểm tra chủ bài.
- `lib/settings.ts` fallback `.env` cho Gemini/Cloudflare/Facebook với **mọi** user.
- AI viết bài bằng `settings.systemPrompt` (một prompt chung / user) qua `generateFromIdea`; output `{ post, image_prompt }`.
- Production che bằng Basic Auth (`BASIC_AUTH_*`).

## 3. Đăng nhập, vai trò, phiên

### 3.1 Dữ liệu
```prisma
enum UserRole { ADMIN USER }

model User {
  // …trường hiện có…
  role         UserRole @default(USER)
  tokenVersion Int      @default(0) // tăng khi vô hiệu hoá / admin đổi mật khẩu, email hoặc vai trò ⇒ huỷ mọi phiên
}
```

### 3.2 Phiên
- Cookie `ap_session`: `httpOnly`, `SameSite=Lax`, `Secure` khi `NODE_ENV=production`, `Path=/`, `Max-Age` 7 ngày.
- Giá trị: JWT ký bằng `JWT_SECRET`, payload `{ sub: userId, tv: tokenVersion }`.
- Middleware `authenticate` (thay bản bypass): đọc cookie → verify JWT → nạp user; từ chối (401) nếu không có, sai chữ ký, hết hạn, `isActive=false`, hoặc `tv ≠ user.tokenVersion`. Gắn `req.user = { id, email, name, role, plan }`.
- `requireAdmin`: 403 nếu `role ≠ ADMIN`.
- **Chống CSRF:** mọi request API không phải GET/HEAD phải có header `X-Requested-With: autopost` (client tự gắn); thiếu ⇒ 403. Kết hợp `SameSite=Lax`.
- Dev (Vite 5173 → API 3000): client dùng `credentials: 'include'`; CORS hiện đã `credentials: true`.
- Production **từ chối khởi động** nếu `JWT_SECRET` rỗng hoặc bằng giá trị mặc định trong `config`.

### 3.3 Mật khẩu & khoá tạm
- **Admin đặt mật khẩu** khi tạo member và khi sửa (ô để trống = giữ nguyên). Mật khẩu ≥ 8 ký tự. Giao diện có nút "Tạo ngẫu nhiên" (12 ký tự, sinh ở trình duyệt) và nút hiện/ẩn mật khẩu.
- Member **không** tự đổi mật khẩu và **không** bị bắt đổi khi đăng nhập lần đầu; quên mật khẩu ⇒ nhờ admin đặt lại.
- Sai 5 lần trong 15 phút cho cùng `email|IP` ⇒ 429 kèm `Retry-After` (bộ đếm trong bộ nhớ tiến trình; khởi động lại thì xoá — chấp nhận được).
- Thông báo lỗi đăng nhập luôn chung chung: "Email hoặc mật khẩu không đúng." (kể cả tài khoản bị vô hiệu hoá).

### 3.4 API
| Method | Path | Quyền | Mô tả |
|---|---|---|---|
| POST | `/api/auth/login` | công khai | `{ email, password }` ⇒ 200 `{ user }` + Set-Cookie; 401; 429 |
| POST | `/api/auth/logout` | công khai | Xoá cookie |
| GET | `/api/auth/me` | đăng nhập | `{ id, email, name, role }` |
| — | `/api/auth/register`, `/api/auth/facebook*` | — | Gỡ khỏi router (404) |
| GET | `/api/admin/users` | ADMIN | Danh sách + thống kê: số Page hoạt động, số bài 30 ngày, `lastLoginAt` |
| POST | `/api/admin/users` | ADMIN | `{ email, name, password, role }` ⇒ 201 `{ user }`; email trùng ⇒ 409 (+ tạo bộ lĩnh vực khởi đầu — M2) |
| PATCH | `/api/admin/users/:id` | ADMIN | `{ name?, email?, password?, role?, isActive? }` (chỉ gửi trường đổi). Đổi `password`, `email`, `role` hoặc `isActive=false` ⇒ `tokenVersion++` (member phải đăng nhập lại). Email trùng ⇒ 409. Chặn (409): tự vô hiệu hoá / tự bỏ quyền admin; vô hiệu hoá / hạ quyền **admin cuối cùng** |
| DELETE | `/api/admin/users/:id` | ADMIN | Xoá hẳn member **và toàn bộ dữ liệu của họ** (Page, bài, lịch, lĩnh vực, cấu hình — cascade) + xoá file ảnh bài trong `storage/images`. Body `{ confirmEmail }` phải trùng email ⇒ tránh xoá nhầm (400 nếu sai). Chặn (409): tự xoá mình, xoá admin cuối cùng. Job đang chờ của member bị xoá tự bỏ qua (bài/Page không còn) |

Admin **không** có endpoint đọc nội dung của user khác. Thống kê chỉ là số đếm.

### 3.5 Đường công khai
`/health`, `/cron/tick` (CRON_SECRET), `/api/auth/login`, file tĩnh của client (trang `/login` phải tải được khi chưa đăng nhập). Basic Auth giữ trong code, bật/tắt theo env như hiện tại.

## 4. Tách dữ liệu

- Mọi truy vấn theo id từ URL lọc thêm `userId = req.user.id` (hoặc qua quan hệ, vd `format.domain.userId`, `target.post.userId`); không thuộc ⇒ **404**.
- Id tham chiếu trong body (`pageIds`, `domainId`, `formatId`, `templateId`) được kiểm tra thuộc user trước khi ghi; `formatId` phải thuộc `domainId` đã chọn.
- `GET /api/images/:postId`: yêu cầu phiên + bài thuộc user.
- Worker xử lý job của mọi user; mỗi job mang `userId` và chỉ dùng cấu hình của user đó (đã đúng ở code hiện tại).
- **Cấu hình:** `getSettings(userId)` chỉ fallback `.env` khi user là ADMIN. User thường thiếu key ⇒ trạng thái "Chưa có".

## 5. Lĩnh vực & Định dạng bài

### 5.1 Dữ liệu
```prisma
enum FormatLength { SHORT MEDIUM LONG } // 80–120 · 150–250 · 300–450 từ

model ContentDomain {
  id              String   @id @default(uuid())
  userId          String
  name            String   @db.VarChar(80)
  description     String?  @db.VarChar(300)
  audience        String?  @db.Text   // ≤ 1.000
  voice           String?  @db.Text   // ≤ 1.000
  rules           String?  @db.Text   // ≤ 2.000
  defaultHashtags Json?               // string[] ≤ 10, không có "#"
  imageStyle      String?  @db.VarChar(500) // tiếng Anh
  language        String   @default("vi")
  isArchived      Boolean  @default(false)
  sortOrder       Int      @default(0)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  user     User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  formats  ContentFormat[]
  pages    FacebookPage[]
  posts    Post[]
  schedules PostSchedule[]

  @@unique([userId, name])
  @@map("content_domains")
}

model ContentFormat {
  id           String       @id @default(uuid())
  domainId     String
  name         String       @db.VarChar(80)
  instructions String       @db.Text   // ≤ 4.000, bắt buộc
  example      String?      @db.Text   // ≤ 4.000
  length       FormatLength @default(MEDIUM)
  withImage    Boolean      @default(true)
  isDefault    Boolean      @default(false) // đúng 1 định dạng mặc định / lĩnh vực
  legacyPrompt Boolean      @default(false) // "Bài chuẩn" chuyển từ systemPrompt cũ: dùng nguyên văn (§7)
  isArchived   Boolean      @default(false)
  sortOrder    Int          @default(0)
  createdAt    DateTime     @default(now())
  updatedAt    DateTime     @updatedAt

  domain    ContentDomain  @relation(fields: [domainId], references: [id], onDelete: Cascade)
  posts     Post[]
  schedules PostSchedule[]

  @@unique([domainId, name])
  @@map("content_formats")
}
```
Thêm cột (đều nullable, `onDelete: SetNull`): `FacebookPage.defaultDomainId`; `Post.domainId`, `Post.formatId`; `PostSchedule.domainId`, `PostSchedule.formatId`.

Giới hạn: 20 lĩnh vực / user (tính cả đã lưu trữ), 10 định dạng / lĩnh vực. Lĩnh vực/định dạng đã được bài, Page hoặc lịch tham chiếu thì **không xoá được** (409) — chỉ lưu trữ. Lưu trữ lĩnh vực ⇒ `defaultDomainId` của các Page trỏ vào nó về NULL.

### 5.2 Ghép prompt
Hàm thuần `composePrompt({ domain, format, idea, pageName }) → string` (file `src/lib/compose-prompt.ts`), các khối theo thứ tự, **bỏ khối rỗng**:

```
Bạn là người viết nội dung Facebook cho lĩnh vực "{domain.name}"{ — {domain.description}}.
Đối tượng độc giả: {audience}
Giọng văn: {voice}
Quy tắc bắt buộc: {rules}

Định dạng bài "{format.name}":
{format.instructions}
Độ dài: khoảng {80–120 | 150–250 | 300–450} từ.

Bài mẫu để tham khảo phong cách (không chép lại):
{example}

image_prompt: tiếng Anh; mô tả chủ thể, bối cảnh, ánh sáng; phong cách: {imageStyle}; không chữ, không logo, không người nổi tiếng.
Chỉ trả về JSON đúng schema.
```
- Biến thay trong mọi ô văn bản: `{{idea}}` = `{{topic}}` = `{{ $json[...] }}` (tương thích n8n cũ), `{{page_name}}`, `{{audience}}`. Nếu không ô nào chứa biến ý tưởng thì thêm `Ý tưởng bài viết: {idea}` ở cuối (như `buildIdeaPrompt` hiện tại).
- Định dạng có `withImage=false` ⇒ bỏ dòng `image_prompt` khỏi prompt và **không** tạo ảnh; validator (zod) của kết quả cho phép `image_prompt` rỗng trong trường hợp này (hiện tại bắt buộc ≥ 1 ký tự).
- Định dạng có `legacyPrompt=true` ⇒ **không** dùng khung trên; system prompt = `buildIdeaPrompt(format.instructions, idea)` như code hiện tại, để bài giống hệt trước.
- Gọi Gemini y như `generateFromIdea` hiện nay (schema `{ post, image_prompt }`, `formatPostText`, tách hashtag cuối bài).
- Hashtag cuối = hashtag AI + `defaultHashtags`, bỏ trùng không phân biệt hoa thường, tối đa 30.
- Tạo ảnh (AI preview và worker): prompt ảnh = `"{imageStyle}. {image_prompt}"` nếu có `imageStyle`.
- Lưu prompt ghép vào `Post.aiPrompt`.

### 5.3 Chọn lĩnh vực/định dạng khi tạo bài
Thứ tự mặc định khi request không gửi: lĩnh vực mặc định của Page đầu tiên được chọn → lĩnh vực có `sortOrder` nhỏ nhất chưa lưu trữ; định dạng = định dạng `isDefault` của lĩnh vực đó. Bài cũ (`domainId = NULL`) vẫn viết lại được bằng lĩnh vực mặc định của user.

### 5.4 API
| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/domains?archived=1` | Lĩnh vực + định dạng + số Page/bài dùng |
| POST | `/api/domains` | Tạo (kèm 1 định dạng mặc định bắt buộc trong body) |
| PATCH | `/api/domains/:id` | Sửa trường; `isArchived` |
| DELETE | `/api/domains/:id` | 409 nếu đang được tham chiếu |
| POST | `/api/domains/:id/formats` | Tạo định dạng |
| PATCH | `/api/formats/:id` | Sửa; `isDefault=true` ⇒ bỏ mặc định của định dạng khác cùng lĩnh vực (transaction) |
| DELETE | `/api/formats/:id` | 409 nếu đang được tham chiếu hoặc là định dạng mặc định duy nhất |
| POST | `/api/formats/:id/preview` | `{ idea, pageId?, generate?: boolean }` ⇒ `{ prompt }`; `generate=true` gọi Gemini, trả thêm `{ post, hashtags, imagePrompt }`, **không** tạo bài |
| PATCH | `/api/pages/:id` | `{ defaultDomainId \| null }` |
| POST/PATCH | `/api/posts`, `/api/posts/:id` | Nhận `domainId`, `formatId` |
| GET | `/api/posts?domainId=` | Lọc theo lĩnh vực |
| POST/PUT | `/api/schedules` | Nhận `domainId`, `formatId` |

## 6. Giao diện

- **`/login`** (làm lại `LoginPage.tsx`): email + mật khẩu; lỗi 401/429 bằng tiếng Việt; sau đăng nhập quay về trang định mở. Không có màn hình đổi mật khẩu.
- `ProtectedRoute` gọi `/auth/me` khi mở app; chưa đăng nhập ⇒ `/login?next=…`. Client bỏ token `localStorage`, dùng cookie; `apiFetch` gắn `X-Requested-With`, `credentials: 'include'`; 401 ở bất kỳ request nào ⇒ về `/login`.
- **Sidebar:** mục **Lĩnh vực** (Nội dung); **Người dùng** (Hệ thống, chỉ ADMIN); khối user dưới cùng: tên, email, **Đăng xuất**.
- **`/domains`** hai cột: trái danh sách (tên, số định dạng, số Page, số bài; lưu trữ ở cuối); phải biểu mẫu lĩnh vực theo khối (Đối tượng & giọng văn · Quy tắc · Hashtag · Phong cách ảnh) + thẻ định dạng, sửa trong khung trượt (tên, cấu trúc, độ dài Ngắn/Vừa/Dài, bài mẫu, có ảnh, mặc định). Nút **Xem prompt** (không tốn phí) và **Thử viết** (ghi rõ "dùng 1 lượt Gemini của bạn").
- **Tạo bài:** chọn **Lĩnh vực** + nút chọn **Định dạng**; ô Page chia "Page của lĩnh vực này" / "Page khác" (⚠ + ghi chú); nhắc "Bấm Viết lại" khi đổi lĩnh vực/định dạng sau khi đã viết; khung thu gọn **Xem prompt**; nhớ lựa chọn cuối (localStorage, bọc try/catch).
- **Kênh Facebook:** cột **Lĩnh vực mặc định** (select tại dòng).
- **Bài đăng:** lọc theo lĩnh vực; nhãn lĩnh vực · định dạng trên dòng.
- **Cài đặt:** bỏ ô System prompt ⇒ link "Cách AI viết bài → Lĩnh vực"; user thường thấy "Chưa có" thay cho "Tạm từ .env".
- **`/admin/users`** (quản lý member): bảng (tên, email, vai trò, trạng thái Hoạt động/Vô hiệu hoá, số Page, số bài 30 ngày, đăng nhập cuối) + ô tìm theo tên/email.
  - **Thêm member**: hộp thoại (cùng kiểu hộp Sửa bài) gồm tên, email, mật khẩu (nút Tạo ngẫu nhiên + hiện/ẩn + Copy), vai trò ⇒ tạo xong nhắc "Gửi email + mật khẩu cho member".
  - **Sửa**: cùng hộp thoại, mật khẩu để trống = giữ nguyên; ghi chú "Đổi mật khẩu/email/vai trò sẽ đăng xuất member".
  - **Vô hiệu hoá / Kích hoạt** ngay trên dòng (công tắc) — vô hiệu hoá đăng xuất member ngay, dữ liệu giữ nguyên, lịch đăng của họ không chạy.
  - **Xoá**: hộp xác nhận ghi rõ số Page/bài sẽ mất, phải gõ lại email mới bật nút Xoá; gợi ý "Muốn giữ dữ liệu? Dùng Vô hiệu hoá".
  - Dòng của chính admin: không có nút Xoá/Vô hiệu hoá.
- **Dashboard:** checklist khởi động (key Gemini + Cloudflare · Facebook App + Page đã đồng bộ · đã xem lĩnh vực · có bài đầu tiên), tự tick, ẩn khi đủ.
- Giữ nguyên hệ token màu/font/thành phần hiện có; micro-animation nhẹ, tôn trọng `prefers-reduced-motion`.

## 7. Chuyển đổi & khởi tạo

`src/lib/bootstrap.ts` → `runBootstrap()` chạy lúc khởi động, **trước** worker, idempotent:
1. `assertJwtSecret()` (production).
2. `ensureAdmin()`: nếu chưa có ADMIN ⇒ user có `createdAt` nhỏ nhất thành ADMIN. Nếu có `ADMIN_EMAIL` + `ADMIN_PASSWORD` **và** admin chưa có mật khẩu thật (`passwordHash` rỗng hoặc bằng `'dummy'`) ⇒ đặt email + hash.
3. `migrateDomains()`: user chưa có lĩnh vực nào ⇒ tạo "Mặc định" (các trường khác rỗng) + định dạng "Bài chuẩn" (`isDefault`, `instructions` = `systemPrompt` hiện có của user hoặc `DEFAULT_SYSTEM_PROMPT`, `length=MEDIUM`, `withImage=true`).
   - Riêng lĩnh vực chuyển đổi này: `composePrompt` dùng **nguyên văn** `instructions` làm system prompt (qua `buildIdeaPrompt`) để kết quả giống hệt trước — đánh dấu bằng cờ `ContentFormat.legacyPrompt Boolean @default(false)`.
4. User tạo mới qua admin: bộ khởi đầu trong code — lĩnh vực "Chung" + 3 định dạng: "Mẹo ngắn" (SHORT), "Listicle 5 ý" (MEDIUM), "Hỏi đáp" (MEDIUM).

`settings.systemPrompt` không bị xoá khỏi DB (giữ để hoàn tác), nhưng không còn được dùng.

## 8. Deploy (Hostinger)

1. hPanel thêm `ADMIN_EMAIL`, `ADMIN_PASSWORD`; kiểm tra `JWT_SECRET` đã là chuỗi ngẫu nhiên.
2. Merge vào `main` → `npm run deploy:branch -- --push`; build chạy `db push` (chỉ thêm bảng/cột).
3. Đăng nhập admin; kiểm tra Page/bài cũ, tạo 1 bài ⇒ nội dung tương đương trước.
4. Xoá `BASIC_AUTH_USER`, `BASIC_AUTH_PASS`, `ADMIN_PASSWORD` khỏi hPanel → Redeploy.
5. Tạo tài khoản cho từng người.

Không đổi: Cron Job `/cron/tick`, `/health`, UptimeRobot, Đồng bộ Page, branch `deploy`.

## 9. Kiểm thử

- **Unit:** `composePrompt` (đủ khối, bỏ khối rỗng, biến, `withImage=false`, `legacyPrompt`); gộp hashtag; auth (cookie, JWT sai/hết hạn, `tokenVersion`, khoá 5 lần, CSRF header); guard tự thao tác / admin cuối cùng (vô hiệu hoá, hạ quyền, xoá).
- **DB integration** (`RUN_DB_TESTS=1`):
  - **Tách dữ liệu:** bảng khai báo mọi route (method + path + cách tạo id của user B); user A gọi ⇒ 404 / danh sách không chứa dữ liệu B. **Test phủ route:** duyệt `app._router` và fail nếu có route `/api/*` chưa khai báo trong bảng (trừ danh sách công khai).
  - USER gọi `/api/admin/*` ⇒ 403; vô hiệu hoá hoặc đổi mật khẩu member ⇒ phiên cũ 401, mật khẩu mới đăng nhập được; xoá member ⇒ Page/bài/lịch của họ biến mất, member khác không bị ảnh hưởng; sai `confirmEmail` ⇒ 400.
  - `runBootstrap()` chạy 2 lần không tạo trùng; bài tạo bằng lĩnh vực chuyển đổi dùng đúng prompt cũ.
  - Tạo bài với `domainId/formatId` lưu `aiPrompt`; `formatId` không thuộc `domainId` ⇒ 400.
- **UI:** chụp màn hình `/login`, `/domains`, Tạo bài, `/admin/users`.
- Toàn bộ test hiện có (110) vẫn pass.

## 10. Giai đoạn & tiêu chí xong

| GĐ | Nội dung | Xong khi |
|---|---|---|
| **M1** | §3, §4, `ensureAdmin`/`assertJwtSecret`, trang Đăng nhập + Quản lý member, sidebar | Admin tạo member, member đăng nhập ngay; 2 user dùng song song; test tách dữ liệu + phủ route xanh; AI vẫn dùng system prompt cũ |
| **M2** | §5.1–5.4 backend, `migrateDomains`, bộ khởi đầu, `imageStyle` | Tạo bài qua API theo lĩnh vực/định dạng; bài của lĩnh vực chuyển đổi giống trước |
| **M3** | §6 phần Lĩnh vực, Tạo bài, Kênh Facebook, Bài đăng, Dashboard | Dùng trọn tính năng trên web; ảnh chụp màn hình |
| **M4** | `AGENTS.md` (auth đã bật), README, `docs/DEPLOY_HOSTINGER.md` + trang checklist (bỏ Basic Auth, thêm ADMIN_*) | Tài liệu khớp; deploy theo §8 |

Mỗi GĐ dừng lại cho người dùng kiểm tra trước khi sang GĐ sau.

## 11. Rủi ro
- **Quên lọc `userId` ở route mới** ⇒ test phủ route bắt buộc.
- **Đăng nhập hỏng ⇒ khoá chính admin ngoài hệ thống:** `ADMIN_EMAIL/ADMIN_PASSWORD` + `ensureAdmin`; không cho gỡ/xoá admin cuối.
- **Xoá nhầm member mất hết dữ liệu:** phải gõ lại email để xác nhận; giao diện gợi ý dùng Vô hiệu hoá khi muốn giữ dữ liệu.
- **Khác biệt bài sau chuyển đổi:** cờ `legacyPrompt` giữ nguyên hành vi cũ cho lĩnh vực "Mặc định".
- **Hostinger & cookie:** app sau proxy HTTPS (`trust proxy` đã bật) ⇒ cookie `Secure` hoạt động; kiểm tra trên domain tạm `*.hostingersite.com`.
