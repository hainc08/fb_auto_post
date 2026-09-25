# Deploy Auto Post lên Hostinger (gói Business / Cloud — Node.js Web App)

> Nguồn code: GitHub `hainc08/fb_auto_post`, branch **`deploy`** (chỉ chứa code cần để build/chạy, sinh tự động từ `main` bằng `npm run deploy:branch`). `main` dùng để phát triển, Hostinger không đọc `main`.
> Tên nút/menu trong hPanel có thể khác đôi chút theo phiên bản; các bước vẫn như dưới đây.

## 0. Kiến trúc khi chạy trên Hostinger

```
Trình duyệt ──HTTPS──▶ Hostinger (proxy) ──▶ 1 Node app (dist/server.js)
                                              ├─ /api/*      API Express
                                              ├─ /*          giao diện React (client/dist)
                                              ├─ worker      BullMQ đăng bài (chạy chung tiến trình)
                                              ├─▶ MariaDB    của Hostinger (hPanel → Databases)
                                              ├─▶ Redis      dịch vụ ngoài (Redis Cloud free)
                                              └─▶ STORAGE_DIR ảnh bài viết (ngoài thư mục app)
```

Gói Business/Cloud **không có Redis**, mà BullMQ bắt buộc cần Redis ⇒ dùng Redis Cloud (miễn phí 30 MB, đủ dùng).

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

### 1.2 Redis (Redis Cloud – miễn phí)
1. Đăng ký tại https://redis.io/try-free → tạo database **Free (30 MB)**, chọn region gần nhất (Singapore nếu có).
2. Trong cấu hình database: **Eviction policy = `noeviction`** (BullMQ yêu cầu, nếu không job có thể bị xoá ngầm).
3. Lấy **Public endpoint** + **Default user password** ⇒
   ```
   REDIS_URL=redis://default:PASSWORD@redis-12345.c1.asia-southeast1-1.gce.redns.redis-cloud.com:12345
   ```
   (Nếu nhà cung cấp bắt TLS thì dùng `rediss://`.)

> Không khuyến nghị Upstash gói free: worker BullMQ gọi Redis liên tục kể cả khi rảnh, dễ vượt hạn mức lệnh/tháng.

### 1.3 Tạo các khoá bí mật
Chạy trên máy (mỗi lệnh 1 giá trị):
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"      # JWT_SECRET
node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))" # BASIC_AUTH_PASS
```
- **ENCRYPTION_KEY** mã hoá API key + Page token trong DB. **Lưu lại cẩn thận**; đổi khoá = mất khả năng giải mã dữ liệu cũ (phải nhập lại cấu hình).
- Nếu định chuyển dữ liệu từ máy local lên (mục 6) thì dùng **đúng ENCRYPTION_KEY đang có trong `.env` local**.

### 1.4 Thư mục lưu ảnh (STORAGE_DIR)
Ảnh bài viết là file trên đĩa. Để không bị mất khi deploy lại, đặt ngoài thư mục app:
1. hPanel → **Advanced → SSH Access** → bật SSH, đăng nhập:
   ```bash
   echo $HOME                       # vd /home/u123456789
   mkdir -p ~/autopost-storage/images
   ```
2. `STORAGE_DIR=/home/u123456789/autopost-storage`

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
| Build command | `npm run build:prod && npm run db:deploy` |
| Entry file / Start file | `dist/server.js` |

- `build:prod` = cài dependencies (kể cả dev) → `prisma generate` → biên dịch backend → build giao diện `client/`.
- `db:deploy` = `prisma db push`: tạo/cập nhật bảng theo `prisma/schema.prisma`. Nếu thay đổi schema có nguy cơ **mất dữ liệu**, lệnh sẽ **dừng và báo lỗi** chứ không tự xoá — khi đó xem mục 7.

4. **Environment variables** (thêm trước khi bấm Deploy):

| Biến | Giá trị |
|---|---|
| `NODE_ENV` | `production` |
| `API_URL` | `https://ten-mien-cua-ban.com` |
| `CLIENT_URL` | `https://ten-mien-cua-ban.com` |
| `DATABASE_URL` | mục 1.1 |
| `REDIS_URL` | mục 1.2 |
| `ENCRYPTION_KEY` | mục 1.3 |
| `JWT_SECRET` | mục 1.3 |
| `BASIC_AUTH_USER` | vd `admin` |
| `BASIC_AUTH_PASS` | mục 1.3 |
| `STORAGE_DIR` | mục 1.4 |
| `VITE_FB_APP_ID` | Facebook App ID (dùng lúc build giao diện, cho nút "Kết nối Page") |
| `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | tuỳ chọn — có thể nhập sau trong **Cấu hình** |
| `GEMINI_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | tuỳ chọn — có thể nhập sau trong **Cấu hình** |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | nếu muốn email báo kết quả đăng (Hostinger có mail riêng: `smtp.hostinger.com`, port `465`) |

> ⚠️ **Không bao giờ bỏ trống `BASIC_AUTH_USER` / `BASIC_AUTH_PASS`.** App đang tắt đăng nhập nội bộ; không có 2 biến này thì ai có link cũng xem được API key và đăng bài lên Page của bạn. Log server sẽ cảnh báo nếu thiếu.

5. Bấm **Deploy**. Xem log build; lần đầu mất vài phút.
6. Gắn tên miền + bật **SSL** (hPanel → Security → SSL) nếu chưa có.

---

## 3. Kiểm tra sau deploy

1. `https://ten-mien/health` → `{"status":"ok",...}` (không hỏi mật khẩu).
2. `https://ten-mien/` → trình duyệt hỏi user/mật khẩu → nhập `BASIC_AUTH_*` → vào Dashboard.
3. **Cấu hình**: nhập/kiểm tra Gemini, Cloudflare, Facebook App → bấm các nút **Kiểm tra**.
4. **Pages**: kết nối Page (hoặc "đổi token dài hạn" trong Cấu hình).
5. Tạo 1 bài → AI viết → tạo ảnh → **Duyệt & đăng** → kiểm tra bài trên Page, và ảnh vẫn hiện sau khi F5.

### Facebook App
developers.facebook.com → App → **Settings → Basic**:
- **App Domains**: `ten-mien-cua-ban.com`
- **Website → Site URL**: `https://ten-mien-cua-ban.com/`
- Facebook Login → **Valid OAuth Redirect URIs** / **Allowed Domains for the JavaScript SDK**: thêm `https://ten-mien-cua-ban.com`

---

## 4. Giữ worker luôn chạy (quan trọng cho bài hẹn giờ)

Worker đăng bài chạy **chung tiến trình** với web. Nếu Hostinger tạm dừng app khi không có truy cập, bài hẹn giờ sẽ bị trễ tới lần truy cập kế tiếp.
- Tạo monitor miễn phí tại https://uptimerobot.com → HTTP(s) → URL `https://ten-mien/health` → mỗi **5 phút**. Vừa giữ app thức, vừa báo khi app sập.
- Bài hẹn giờ nằm trong Redis; **không xoá/flush database Redis**.

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
- Ảnh (STORAGE_DIR), MariaDB và Redis không bị ảnh hưởng.

---

## 6. (Tuỳ chọn) Chuyển dữ liệu từ máy local lên

1. Local: `docker exec autopost_mariadb mariadb-dump -uautopost -pautopost_secret autopost_db > autopost.sql`
2. hPanel → Databases → **phpMyAdmin** → chọn DB → **Import** `autopost.sql` (làm **trước** lần deploy đầu, hoặc để `db push` chạy sau).
3. Dùng **cùng `ENCRYPTION_KEY`** với local, nếu không token/API key đã mã hoá sẽ không đọc được.
4. Copy ảnh: `scp storage/images/* u123456789@HOST:~/autopost-storage/images/` (port SSH của Hostinger thường là `65002`: `scp -P 65002 ...`).

---

## 7. Xử lý sự cố

| Triệu chứng | Nguyên nhân / cách xử lý |
|---|---|
| Build lỗi `styleText` / `Vite requires Node.js` | Chọn Node **22.x** trong cấu hình app |
| Build lỗi `P1001 Can't reach database` | Sai host/port trong `DATABASE_URL`; thử host hiển thị trong trang Databases thay cho `localhost` |
| Build lỗi `db push ... data loss` | Schema đổi làm mất dữ liệu. Backup DB (phpMyAdmin → Export), rồi chạy qua SSH trong thư mục app: `npx prisma db push --accept-data-loss` — **chỉ khi chắc chắn** |
| Web chạy nhưng bài đứng ở "Đang đăng…" mãi | Worker không kết nối được Redis: kiểm tra `REDIS_URL`, eviction policy; xem log app |
| Ảnh mất sau khi deploy | Chưa đặt `STORAGE_DIR` hoặc thư mục không ghi được — kiểm tra quyền qua SSH |
| Bị hỏi mật khẩu liên tục | Sai `BASIC_AUTH_USER/PASS`; đổi biến xong phải **Redeploy/Restart** |
| Log: `BASIC_AUTH_USER/BASIC_AUTH_PASS not set` | Thêm 2 biến này ngay (xem mục 2) |
