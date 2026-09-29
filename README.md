# 🚀 Auto Post Facebook - SaaS Web Service

Hệ thống **đăng bài tự động lên Facebook Page** với AI Content & Image Generation.
Được thiết kế dưới dạng **SaaS multi-tenant** có thể bán cho nhiều doanh nghiệp.

## 🏗️ Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  React Dashboard │────▶│  Express API     │────▶│  MariaDB        │
│  (Vite + TS)     │     │  (Node.js + TS)  │     │  (jobs queue)   │
└─────────────────┘     └──────┬───────────┘     └─────────────────┘
                               │
                    ┌──────────┼──────────┐
                    │          │          │
              ┌─────▼──┐ ┌────▼────┐ ┌───▼──────┐
              │ Gemini  │ │Cloudflare│ │ Facebook │
              │   AI    │ │Workers AI│ │Graph API │
              └─────────┘ └─────────┘ └──────────┘
```

## 🔄 Pipeline (tương đương n8n workflow)

1. **📊 Lấy dữ liệu** → Từ template + input variables (thay Google Sheets)
2. **🤖 AI Content** → Google Gemini sinh caption, hashtags, CTA
3. **📋 Format** → Tự động format và ghép nội dung
4. **🎨 AI Image** → Cloudflare Workers AI tạo ảnh
5. **📘 Publish** → Facebook Graph API đăng bài
6. **✅ Notify** → Email thông báo kết quả

## ⚡ Quick Start

### Prerequisites
- Node.js 18+
- Docker & Docker Compose
- Facebook App (App ID & Secret)
- Google Gemini API Key
- Cloudflare Account (for image generation)

### 1. Clone & Install

```bash
# Install backend dependencies
npm install

# Install frontend dependencies
cd client && npm install && cd ..
```

### 2. Setup Environment

```bash
cp .env.example .env
# Edit .env with your API keys
```

### 3. Start Database

```bash
docker-compose up -d
```

### 4. Initialize Database

```bash
npx prisma db push
npx prisma generate
```

### 5. Run Development

```bash
# Terminal 1: Backend API
npm run dev

# Terminal 2: Frontend Dashboard
cd client && npm run dev
```

- **API**: http://localhost:3000
- **Dashboard**: http://localhost:5173
- **API Docs**: http://localhost:3000/api

## 👥 Tài khoản & lĩnh vực

- Đăng nhập bằng email + mật khẩu. Không có tự đăng ký: **admin** tạo tài khoản ở **Người dùng** và đặt mật khẩu cho member.
- Mỗi người chỉ thấy Page, bài, lịch, lĩnh vực và cấu hình của mình; mỗi người tự nhập key Gemini / Cloudflare / Facebook App trong **Cài đặt**.
- **Lĩnh vực** quyết định cách AI viết (đối tượng, giọng văn, quy tắc, hashtag, phong cách ảnh); mỗi lĩnh vực có nhiều **định dạng bài** (Mẹo ngắn, Listicle, Hỏi đáp…). Khi tạo bài, chọn lĩnh vực + định dạng.
- Chạy local lần đầu: đặt `ADMIN_EMAIL` và `ADMIN_PASSWORD` (≥ 8 ký tự) trong `.env`, khởi động server, đăng nhập bằng thông tin đó.

## 🌐 Deploy

Hostinger (Business/Cloud Node.js) build từ branch `deploy`, sinh bằng `npm run deploy:branch -- --push` (không sửa tay branch này). Xem [docs/DEPLOY_HOSTINGER.md](docs/DEPLOY_HOSTINGER.md).
Tóm tắt: build `npm run build:prod && npm run db:deploy`, entry `dist/server.js`, Node 22, hàng đợi job nằm trong MariaDB (không cần Redis), bắt buộc `JWT_SECRET` (≥ 32 ký tự); lần đầu cần `ADMIN_EMAIL` + `ADMIN_PASSWORD`.

## 📁 Project Structure

```
auto_post/
├── prisma/
│   └── schema.prisma          # Database schema
├── src/
│   ├── server.ts              # Express server entry point
│   ├── config/
│   │   └── index.ts           # Environment configuration
│   ├── middleware/
│   │   ├── auth.middleware.ts  # JWT + API Key authentication
│   │   └── error.middleware.ts # Error handling
│   ├── routes/
│   │   ├── auth.routes.ts     # Auth & OAuth
│   │   ├── pages.routes.ts    # Facebook Pages CRUD
│   │   ├── templates.routes.ts # Content Templates CRUD
│   │   ├── posts.routes.ts    # Posts CRUD + AI generate
│   │   ├── schedules.routes.ts # Schedule management
│   │   └── analytics.routes.ts # Dashboard analytics
│   ├── services/
│   │   ├── ai.service.ts      # Google Gemini integration
│   │   ├── image.service.ts   # Cloudflare Workers AI
│   │   ├── facebook.service.ts # Facebook Graph API
│   │   ├── email.service.ts   # Email notifications
│   │   └── scheduler.service.ts # MariaDB job queue + pipeline
│   └── utils/
│       ├── logger.ts          # Winston logger
│       └── prisma.ts          # Prisma client singleton
├── client/                    # React Frontend (Vite)
│   └── src/
│       ├── App.tsx            # Router + Layout
│       ├── api.ts             # API client
│       ├── components/
│       │   └── Sidebar.tsx    # Navigation sidebar
│       └── pages/
│           ├── LoginPage.tsx
│           ├── DashboardPage.tsx
│           ├── PagesPage.tsx
│           ├── TemplatesPage.tsx
│           ├── PostsPage.tsx
│           ├── CreatePostPage.tsx
│           └── SchedulesPage.tsx
├── docker-compose.yml
├── package.json
└── tsconfig.json
```

## 💰 Pricing Tiers

| Plan | Price/month | Pages | Posts/month | Schedule |
|------|------------|-------|-------------|----------|
| FREE | 0đ | 1 | 10 | ❌ |
| PRO | 299K | 3 | 100 | ✅ |
| BUSINESS | 799K | 10 | Unlimited | ✅ |
| ENTERPRISE | Custom | Unlimited | Unlimited | ✅ |

## 📡 API Endpoints

See `http://localhost:3000/api` for full API documentation.

## 🛡️ Security

- JWT-based authentication
- Đăng nhập bằng cookie httpOnly; mọi dữ liệu tách theo tài khoản (test `tests/isolation.db.test.ts` duyệt mọi route).
- API Key support for external integrations
- Plan-based access control
- Encrypted Facebook access tokens
- Rate limiting per plan

## 📄 License

Private - All rights reserved.
