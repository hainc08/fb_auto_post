# Deploy Auto Post lên Hostinger (gói Business / Cloud — Node.js Web App)

> Nguồn code: GitHub `hainc08/fb_auto_post`, branch **`deploy`** (chỉ chứa code cần để build/chạy, sinh tự động từ `main` bằng `npm run deploy:branch`). `main` dùng để phát triển, Hostinger không đọc `main`.
> Tên nút/menu trong hPanel có thể khác đôi chút theo phiên bản; các bước vẫn như dưới đây.

## 0. Kiến trúc khi chạy trên Hostinger

```
Trình duyệt ──HTTPS──▶ Hostinger (proxy) ──▶ 1 Node app (dist/server.js)
                                              ├─ /api/*      API Express
                                              ├─ /*          giao diện React (client/dist)
                                              ├─ worker      đăng bài + lịch (chạy chung tiến trình)
                                              ├─▶ MariaDB    của Hostinger: dữ liệu + hàng đợi job (bảng jobs)
                                              └─▶ STORAGE_DIR ảnh bài viết (ngoài thư mục app)
```

Không cần Redis: hàng đợi đăng bài/lịch nằm trong bảng `jobs` của MariaDB, worker chạy ngay trong app.

---

## 1. Chuẩn bị (làm 1 lần)

### 1.1 Database MariaDB trên Hostinger
1. hPanel → **Websites** → chọn website → **Databases → MySQL Databases** (Hostinger chạy MariaDB).
2. Tạo database + user, ghi lại: tên DB (dạng `u123456789_autopost`), user, mật khẩu.
3. `DATABASE_URL`:
   ```
   mysql://USER:PASSWORD@localhost:3306/DB_NAME
   ```
   - Nếu mật khẩu có ký tự đặc biệt (`@ : / # ? &`…) phải **URL-encode** (vd `@` → `%40`), hoặc đặt mật khẩu chỉ gồm chữ + số.
   - Nếu `localhost` không kết nối được, lấy "MySQL host" hiển thị trong trang Databases thay vào.
   - ⚠️ **Không ghi user/mật khẩu thật vào file này** (repo công khai). Chỉ để trong `.env.production` (đã gitignore) và hPanel.

### 1.2 Tạo các khoá bí mật
Chạy trên máy (mỗi lệnh 1 giá trị):
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"      # JWT_SECRET
node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))" # ADMIN_PASSWORD (hoặc BASIC_AUTH_PASS nếu dùng)
```
- **ENCRYPTION_KEY** mã hoá API key + Page token trong DB. **Lưu lại cẩn thận**; đổi khoá = mất khả năng giải mã dữ liệu cũ (phải nhập lại cấu hình).
- Nếu định chuyển dữ liệu từ máy local lên (mục 6) thì dùng **đúng ENCRYPTION_KEY đang có trong `.env` local**.

### 1.3 Thư mục lưu ảnh (STORAGE_DIR)
Ảnh bài viết là file trên đĩa. Để không bị mất khi deploy lại, đặt ngoài thư mục app:
1. hPanel → **Advanced → SSH Access** → bật SSH, đăng nhập:
   ```bash
   echo $HOME                       # vd /home/u123456789
   mkdir -p ~/autopost-storage/images
   ```
2. `STORAGE_DIR=/home/u123456789/autopost-storage`

Video bài viết nằm ở `STORAGE_DIR/videos` (tối đa 100 MB mỗi video). Theo dõi dung lượng đĩa của gói.

---

## 2. Tạo Node.js App từ GitHub

1. hPanel → **Websites → Add website → Node.js Apps** (hoặc trong website có sẵn: **Node.js**).
2. **Import Git repository** → kết nối GitHub → chọn repo `hainc08/fb_auto_post`, branch **`deploy`**.
3. Cấu hình build:

| Mục | Giá trị |
|---|---|
| Framework preset | **Express** (hoặc Other) |
| Node.js version | **22.x** (bắt buộc ≥ 22.12 — Vite 8 không chạy trên Node 20.11) |
| Root directory | `/` (gốc repo) |
| Package manager | npm |
| Entry file / Start file | `dist/server.js` |

- Hostinger sẽ tự động chạy lệnh `npm run build` của dự án. File `package.json` đã được tối ưu để tự động cài đặt công cụ (devDependencies), sinh Prisma, dịch backend và build giao diện React. Lệnh cũng tự động cấu trúc cơ sở dữ liệu (`db push`).
- Nếu thay đổi schema có nguy cơ **mất dữ liệu**, quá trình cài đặt sẽ **dừng và báo lỗi** chứ không tự xoá — khi đó xem mục 7.

4. **Environment variables** (thêm trước khi bấm Deploy):

| Biến | Giá trị |
|---|---|
| `NODE_ENV` | `production` |
| `API_URL` | `https://ten-mien-cua-ban.com` |
| `CLIENT_URL` | `https://ten-mien-cua-ban.com` |
| `DATABASE_URL` | mục 1.1 |
| `ENCRYPTION_KEY` | mục 1.2 |
| `JWT_SECRET` | mục 1.2 — **bắt buộc**, ≥ 32 ký tự ngẫu nhiên (thiếu/yếu thì app không khởi động) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | lần deploy đầu: tài khoản quản trị (mật khẩu ≥ 8 ký tự). Xoá `ADMIN_PASSWORD` sau khi đăng nhập được |
| `BASIC_AUTH_USER`, `BASIC_AUTH_PASS` | **tuỳ chọn** — lớp mật khẩu thứ hai cho cả trang; app đã có đăng nhập riêng |
| `STORAGE_DIR` | mục 1.3 |
| `CRON_SECRET` | chuỗi ngẫu nhiên — cho Cron Job ở mục 4 |
| `VITE_FB_APP_ID` | Facebook App ID (dùng lúc build giao diện, cho nút "Kết nối Page") |
| `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | tuỳ chọn — có thể nhập sau trong **Cấu hình** |
| `GEMINI_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | tuỳ chọn — có thể nhập sau trong **Cấu hình** |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | nếu muốn email báo kết quả đăng (Hostinger có mail riêng: `smtp.hostinger.com`, port `465`) |

> ⚠️ **`JWT_SECRET` phải là chuỗi ngẫu nhiên ≥ 32 ký tự** (mục 1.2). Ai biết chuỗi này có thể giả phiên đăng nhập. Không dùng giá trị mẫu cũ trong `.env.example`.

5. Bấm **Deploy**. Xem log build; lần đầu mất vài phút.
6. Gắn tên miền + bật **SSL** (hPanel → Security → SSL) nếu chưa có.

---

## 3. Kiểm tra sau deploy

1. `https://ten-mien/health` → `{"status":"ok",...}` (không hỏi mật khẩu).
2. `https://ten-mien/` → trang **Đăng nhập** → nhập `ADMIN_EMAIL` / `ADMIN_PASSWORD` → vào Dashboard.
3. **Cấu hình**: nhập/kiểm tra Gemini, Cloudflare, Facebook App → bấm các nút **Kiểm tra**.
4. **Pages**: kết nối Page (hoặc "đổi token dài hạn" trong Cấu hình).
5. Tạo 1 bài → AI viết → tạo ảnh → **Duyệt & đăng** → kiểm tra bài trên Page, và ảnh vẫn hiện sau khi F5.
6. Tải thử một video khoảng 50–100 MB. Nếu báo "Máy chủ từ chối file quá lớn" (lỗi 413 từ proxy của Hostinger) thì giới hạn tải lên của gói thấp hơn 100 MB — dùng video nhỏ hơn.
7. **Lịch đăng**: tạo một lịch có khung giờ gần nhất và 1 ý tưởng → trong 1–2 phút trang lịch có bài "AI đang viết" rồi "Chờ duyệt". Duyệt bài; đến giờ bài được đăng. Lịch cũ (trước bản này) tự chuyển sang lịch theo khung giờ; lịch "Một lần"/"Hàng tháng" bị tạm dừng, tên có "(cần xem lại)".

### Facebook App
developers.facebook.com → App → **Settings → Basic**:
- **App Domains**: `ten-mien-cua-ban.com`
- **Website → Site URL**: `https://ten-mien-cua-ban.com/`
- Facebook Login → **Valid OAuth Redirect URIs** / **Allowed Domains for the JavaScript SDK**: thêm `https://ten-mien-cua-ban.com`

---

## 4. Đăng bài hẹn giờ đúng giờ (Cron Job + UptimeRobot)

Worker đăng bài chạy **chung tiến trình** với web. Nếu Hostinger cho app "ngủ" khi không có ai truy cập, bài hẹn giờ và lịch sẽ **trễ** (không mất — job nằm trong bảng `jobs` — nhưng chỉ chạy khi app thức lại).

**4.1 Cron Job gọi `/cron/tick` mỗi phút (chính)**
1. Thêm biến môi trường `CRON_SECRET` (chuỗi ngẫu nhiên dài, đã có sẵn trong `.env.production`) → Redeploy.
2. hPanel → **Advanced → Cron Jobs** → tạo job **mỗi phút** (`* * * * *`), lệnh:
   ```bash
   curl -fsS -m 55 "https://ten-mien-cua-ban.com/cron/tick?key=CRON_SECRET_CUA_BAN" > /dev/null
   ```
   Mỗi lần gọi: đánh thức app, chạy hết job tới hạn (tối đa ~45 giây) rồi trả `{"ok":true,"processed":N}`. Không cần mật khẩu Basic Auth; sai/thiếu key → 401.
   Lịch đăng được xử lý mỗi phút (đăng bài đã duyệt, dời bài chưa duyệt, AI viết sẵn bài), nên cron nên chạy **mỗi phút**. Nếu gói chỉ cho mỗi 5 phút thì giờ đăng có thể trễ tới 5 phút.

**4.2 Theo dõi**
- `https://ten-mien/health` có mục `worker.lastPollAt` (lần quét gần nhất) và `dueJobs` (job tới hạn chưa chạy). `dueJobs` tăng dần ⇒ worker không chạy.
- UptimeRobot (miễn phí) → HTTP(s) → `https://ten-mien/health` mỗi **5 phút**: báo khi app sập.

**4.3 Tự kiểm tra token hằng ngày**
Lúc 03:00 (giờ VN) app kiểm tra lại token mọi Page. Page hết hạn / bị thu hồi / thiếu quyền sẽ bị chặn đăng và hiện cảnh báo; token sắp hết hạn trong 7 ngày cũng được nhắc. Bài hẹn giờ gặp Page không hợp lệ sẽ báo lỗi rõ ràng thay vì đăng qua app cũ.

- **Không xoá bảng `jobs`** khi dọn DB.

---

## 5. Cập nhật phiên bản

Phát triển trên `main` như bình thường. Khi muốn đưa lên Hostinger:

```bash
npm test && npx tsc --noEmit        # kiểm tra trước
git commit ...                      # script chỉ lấy code ĐÃ commit
npm run deploy:branch -- --push     # dựng lại branch deploy từ commit hiện tại và push
```

- Push lên `deploy` ⇒ Hostinger tự build + deploy lại (nếu đã bật auto-deploy; nếu không, bấm **Redeploy** trong hPanel).
- Push lên `main` **không** làm thay đổi gì trên Hostinger.
- **Không sửa trực tiếp trên branch `deploy`**: lần chạy script sau sẽ ghi đè.
- Thêm file/thư mục mới cần cho build (vd thư mục mới ngoài `src/`)? Thêm vào `DEPLOY_PATHS` trong `scripts/sync-deploy-branch.mjs`.
- Ảnh (STORAGE_DIR) và MariaDB không bị ảnh hưởng.

---

## 6. (Tuỳ chọn) Chuyển dữ liệu từ máy local lên

1. Local: `docker exec autopost_mariadb mariadb-dump -uautopost -pautopost_secret autopost_db > autopost.sql`
2. hPanel → Databases → **phpMyAdmin** → chọn DB → **Import** `autopost.sql` (làm **trước** lần deploy đầu, hoặc để `db push` chạy sau).
3. Dùng **cùng `ENCRYPTION_KEY`** với local, nếu không token/API key đã mã hoá sẽ không đọc được.
4. Copy ảnh: `scp storage/images/* u123456789@HOST:~/autopost-storage/images/` (port SSH của Hostinger thường là `65002`: `scp -P 65002 ...`).

---

## 6b. Checklist nâng cấp lên bản nhiều người dùng (Phase 1d)

Làm **một lần** khi đưa bản có đăng nhập + lĩnh vực lên host đang chạy:

1. hPanel → Environment variables:
   - kiểm tra `JWT_SECRET` là chuỗi ngẫu nhiên ≥ 32 ký tự;
   - thêm `ADMIN_EMAIL` (email bạn sẽ dùng) và `ADMIN_PASSWORD` (≥ 8 ký tự).
2. Merge `feature/multi-user-domains` vào `main` → `npm run deploy:branch -- --push`. Build tự chạy `db push`, chỉ **thêm** bảng/cột, không xoá dữ liệu.
3. Mở trang → đăng nhập bằng `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Kiểm tra:
   - Page và bài cũ vẫn còn;
   - **Lĩnh vực** có "Mặc định / Bài chuẩn" (chính là System prompt cũ);
   - tạo 1 bài → nội dung giống cách viết trước đây.
4. Xoá `ADMIN_PASSWORD` (và `BASIC_AUTH_USER`, `BASIC_AUTH_PASS` nếu không muốn giữ lớp mật khẩu thứ hai) khỏi hPanel → **Redeploy**.
5. **Người dùng** → Thêm member cho từng người (đặt mật khẩu, gửi riêng cho họ). Mỗi member tự nhập key trong **Cài đặt** và đồng bộ Page của mình.

Không đổi: Cron Job `/cron/tick`, `/health`, UptimeRobot, đồng bộ Page, branch `deploy`.

---

## 7. Xử lý sự cố

| Triệu chứng | Nguyên nhân / cách xử lý |
|---|---|
| Build lỗi `styleText` / `Vite requires Node.js` | Chọn Node **22.x** trong cấu hình app |
| Build lỗi `P1001 Can't reach database` | Sai host/port trong `DATABASE_URL`; thử host hiển thị trong trang Databases thay cho `localhost` |
| Build lỗi `db push ... data loss` | Schema đổi làm mất dữ liệu. Backup DB (phpMyAdmin → Export), rồi chạy qua SSH trong thư mục app: `npx prisma db push --accept-data-loss` — **chỉ khi chắc chắn** |
| Bài đứng mãi ở "Chờ đăng"/"Đang đăng…" | App đang ngủ hoặc sập nên worker không chạy: kiểm tra log app, UptimeRobot (mục 4). Job bị ngắt giữa chừng sẽ tự chạy lại sau 10 phút |
| Tải video báo "Máy chủ từ chối file quá lớn" | Proxy của Hostinger giới hạn dung lượng tải lên; dùng video nhỏ hơn hoặc nén lại |
| Ảnh mất sau khi deploy | Chưa đặt `STORAGE_DIR` hoặc thư mục không ghi được — kiểm tra quyền qua SSH |
| Không đăng nhập được admin | Kiểm tra `ADMIN_EMAIL`/`ADMIN_PASSWORD` rồi **Restart**; log có dòng `[Bootstrap]` cho biết đã đặt mật khẩu hay chưa |
| App không khởi động, log `JWT_SECRET phải là chuỗi ngẫu nhiên…` | Đặt `JWT_SECRET` ≥ 32 ký tự ngẫu nhiên, Restart |
| Trình duyệt hỏi user/mật khẩu (hộp thoại của trình duyệt) | Đang bật `BASIC_AUTH_USER/PASS` — nhập đúng, hoặc xoá 2 biến này rồi **Redeploy** |
