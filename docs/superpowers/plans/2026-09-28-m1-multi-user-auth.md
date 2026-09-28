# M1 — Đăng nhập nhiều người dùng & tách dữ liệu · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bật đăng nhập thật (cookie phiên), vai trò ADMIN/USER, trang quản lý người dùng, và bảo đảm mỗi user chỉ thấy dữ liệu của mình — AI vẫn viết bằng system prompt cũ (lĩnh vực/định dạng thuộc kế hoạch M2–M4, viết sau khi M1 xong).

**Architecture:** Một database chung, mọi truy vấn lọc `userId`. Phiên = JWT `{ sub, tv }` trong cookie `httpOnly` `ap_session`; `tokenVersion` trong DB huỷ mọi phiên khi khoá/đặt lại mật khẩu. App Express được tách thành `createApp()` để test gọi HTTP thật; một bộ test tách dữ liệu duyệt **mọi** route và tự fail khi có route chưa khai báo.

**Tech Stack:** Node.js + Express 4 + TypeScript, Prisma 6 + MariaDB, `bcryptjs`, `jsonwebtoken`, Vitest 5, React 19 + Vite 8 + React Router 6, CSS thuần.

**Spec:** `docs/superpowers/specs/2026-09-28-multi-user-domains-design.md` (§3, §4, §6 phần đăng nhập/người dùng, §7 bước 1–2, §9, §10 hàng M1).

## Global Constraints

- Branch làm việc: `feature/multi-user-domains`. Trước mỗi commit: `git branch --show-current` phải ra đúng branch; **stage từng file theo tên** (không `git add -A`); không commit `.env*`, `prompt_creator_video.md`.
- **Không thêm dependency npm mới** (đọc cookie tự viết; test HTTP bằng `fetch` + `app.listen(0)`).
- Schema chỉ **thêm** cột/bảng; áp dụng local bằng `npx prisma db push --skip-generate` (DB local: docker `autopost_mariadb`, port 3310).
- Lỗi API: dùng `asyncHandler` + `createError(status, message, details?)`; body lỗi `{ success: false, error, code? }`; thông báo tiếng Việt.
- Cookie phiên: tên `ap_session`, `httpOnly`, `SameSite=Lax`, `Secure` khi `NODE_ENV=production`, `Path=/`, 7 ngày; JWT payload `{ sub: userId, tv: tokenVersion }`.
- Mọi request `/api/*` không phải GET/HEAD/OPTIONS phải có header `X-Requested-With: autopost`, thiếu ⇒ 403 `code: 'CSRF'`.
- Mật khẩu mới ≥ 10 ký tự; mật khẩu tạm = 12 ký tự `base64url`; bcrypt cost 12.
- Sai đăng nhập 5 lần / 15 phút cho cùng `email|IP` ⇒ 429 + `Retry-After`. Lỗi đăng nhập luôn: "Email hoặc mật khẩu không đúng."
- `mustChangePassword=true` ⇒ mọi API trừ `/api/auth/me`, `/api/auth/change-password`, `/api/auth/logout` trả 403 `code: 'MUST_CHANGE_PASSWORD'`.
- Bản ghi không thuộc user ⇒ **404** (không 403).
- Admin **không** có API đọc nội dung user khác; chỉ quản lý tài khoản + số đếm.
- Email luôn chuẩn hoá `trim().toLowerCase()` khi tạo và khi đăng nhập.
- Test: `npx vitest run` (unit) và `RUN_DB_TESTS=1 npx vitest run` (cần MariaDB local). **Tắt mọi dev server trước khi chạy test DB** (worker của server sẽ lấy job của test). `vitest.config.mts` có `unstubGlobals: true` ⇒ mock `fetch` trong `beforeEach`.
- Client build cần Node 22: `cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b && npx -y -p node@22 -- node node_modules/vite/bin/vite.js build`.
- UI: tiếng Việt, token CSS có sẵn trong `client/src/index.css`, micro-animation nhẹ, tôn trọng `prefers-reduced-motion`.

## Review Focus

- **Email khác hoa/thường hoặc có khoảng trắng** (`" Admin@Example.com "`): đăng nhập vẫn thành công, tạo trùng bị chặn 409 → test ở Task 6 và Task 8.
- **Admin tự khoá mình / gỡ quyền admin cuối cùng** → bị chặn 409, không ai bị khoá ngoài hệ thống → test ở Task 8.
- **Phiên cũ sau khi khoá / đặt lại / đổi mật khẩu** → trả 401 ngay request kế tiếp → test ở Task 5, 6, 8.
- **Dev: client Vite (5173) gọi API (3000) bằng cookie** → CORS trả `Access-Control-Allow-Credentials: true` cho origin 5173 → test ở Task 1.
- **User bị khoá còn bài hẹn giờ trong hàng đợi** → worker không đăng, target FAILED "Tài khoản đã bị khoá" → test ở Task 8.

---

## File Structure

| File | Trách nhiệm |
|---|---|
| `src/app.ts` (mới) | `createApp()` + `API_ROUTERS` — dựng Express app (middleware, route, static, lỗi) |
| `src/server.ts` (sửa) | Chỉ khởi động: `runBootstrap()` → worker → `listen` |
| `src/lib/session.ts` (mới) | Ký/đọc JWT phiên, đọc cookie, set/clear cookie |
| `src/lib/passwords.ts` (mới) | Chuẩn hoá email, hash/verify, mật khẩu tạm, schema mật khẩu mới |
| `src/lib/login-limiter.ts` (mới) | Đếm đăng nhập sai theo `email\|IP` |
| `src/lib/bootstrap.ts` (mới) | `assertJwtSecret`, `ensureAdmin`, `runBootstrap` |
| `src/lib/admin-guards.ts` (mới) | Hàm thuần kiểm tra "tự khoá / admin cuối" |
| `src/middleware/auth.middleware.ts` (sửa) | `authenticate` thật, `requireAdmin`, `csrfGuard` |
| `src/middleware/error.middleware.ts` (sửa) | Trả thêm `code` |
| `src/routes/auth.routes.ts` (viết lại) | login / logout / me / change-password / api-keys |
| `src/routes/admin.routes.ts` (mới) | Quản lý người dùng |
| `src/routes/images.routes.ts`, `posts.routes.ts`, `settings.routes.ts` (sửa) | Bịt lỗ tách dữ liệu |
| `src/lib/settings.ts` (sửa) | Chỉ ADMIN được fallback `.env` |
| `src/services/scheduler.service.ts` (sửa) | Không đăng bài của user bị khoá |
| `src/config/index.ts` (sửa) | `DEFAULT_JWT_SECRET` |
| `tests/helpers/http.ts`, `tests/helpers/users.ts` (mới) | Server test + tạo user/cookie |
| `tests/*.test.ts` | Xem từng task |
| `client/src/api.ts` (sửa) | Cookie + header CSRF, `authApi`, `adminApi`, sự kiện 401 |
| `client/src/auth.tsx` (mới) | `AuthProvider`, `useAuth` |
| `client/src/App.tsx`, `main.tsx` (sửa) | `ProtectedRoute` thật, route mới |
| `client/src/pages/LoginPage.tsx` (viết lại), `ChangePasswordPage.tsx`, `UsersPage.tsx` (mới) | Giao diện |
| `client/src/components/Sidebar.tsx` (sửa) | Khối user + Đăng xuất + mục Người dùng |
| `client/src/index.css` (sửa) | Style trang đăng nhập / người dùng |

---

### Task 1: Tách `createApp()` và hạ tầng test HTTP

**Files:**
- Create: `src/app.ts`, `tests/helpers/http.ts`, `tests/app.test.ts`
- Modify: `src/server.ts` (toàn bộ file)

**Interfaces:**
- Produces: `createApp(): express.Express`; `API_ROUTERS: ReadonlyArray<readonly [string, express.Router]>`; `startTestServer(app) → Promise<{ baseUrl: string; close(): Promise<void> }>`; `api(baseUrl, method, path, opts?) → Promise<{ status: number; json: any; headers: Headers }>` với `opts = { cookie?: string; body?: unknown; headers?: Record<string, string> }` (mặc định gửi `X-Requested-With: autopost`).

- [ ] **Step 1: Viết test (fail vì chưa có `src/app.ts`)** — `tests/app.test.ts`

```ts
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createApp } from '../src/app';
import { startTestServer, api } from './helpers/http';

let server: Awaited<ReturnType<typeof startTestServer>>;
beforeAll(async () => { server = await startTestServer(createApp()); });
afterAll(() => server.close());

describe('createApp', () => {
  it('serves the API index without touching the database', async () => {
    const res = await api(server.baseUrl, 'GET', '/api');
    expect(res.status).toBe(200);
    expect(res.json.name).toBe('Auto Post Facebook API');
  });

  it('lets the Vite dev client (5173) send cookies', async () => {
    const res = await fetch(`${server.baseUrl}/api`, { headers: { Origin: 'http://localhost:5173' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });
});
```

`tests/helpers/http.ts`:

```ts
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

export async function startTestServer(app: Express) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface ApiOptions {
  cookie?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Call the API like the browser client does (CSRF header on by default). */
export async function api(baseUrl: string, method: string, path: string, opts: ApiOptions = {}) {
  const headers: Record<string, string> = {
    'X-Requested-With': 'autopost',
    ...(opts.body !== undefined && { 'Content-Type': 'application/json' }),
    ...(opts.cookie && { Cookie: opts.cookie }),
    ...opts.headers,
  };
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, headers: res.headers, text };
}
```

- [ ] **Step 2: Chạy test để thấy fail**

Run: `npx vitest run tests/app.test.ts`
Expected: FAIL — `Cannot find module '../src/app'`.

- [ ] **Step 3: Tạo `src/app.ts`** — chuyển nguyên phần dựng app từ `src/server.ts` (dòng 1–171 hiện tại) vào hàm, thêm `API_ROUTERS`:

```ts
import express, { Router } from 'express';
import cors from 'cors';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { config } from './config';
import { logger } from './utils/logger';
import { asyncHandler, createError, errorHandler, notFoundHandler } from './middleware/error.middleware';
import { basicAuthGate, safeEqual } from './middleware/basic-auth.middleware';
import authRoutes from './routes/auth.routes';
import pagesRoutes from './routes/pages.routes';
import templatesRoutes from './routes/templates.routes';
import postsRoutes from './routes/posts.routes';
import schedulesRoutes from './routes/schedules.routes';
import analyticsRoutes from './routes/analytics.routes';
import settingsRoutes from './routes/settings.routes';
import imagesRoutes from './routes/images.routes';
import { getWorker } from './services/scheduler.service';
import { countDueJobs, workerStatus } from './lib/job-queue';

/** Every API router and its mount path (the isolation test walks this list). */
export const API_ROUTERS: ReadonlyArray<readonly [string, Router]> = [
  ['/api/auth', authRoutes],
  ['/api/pages', pagesRoutes],
  ['/api/templates', templatesRoutes],
  ['/api/posts', postsRoutes],
  ['/api/schedules', schedulesRoutes],
  ['/api/analytics', analyticsRoutes],
  ['/api/settings', settingsRoutes],
  ['/api/images', imagesRoutes],
];

export function createApp() {
  const app = express();

  // Behind the hosting proxy (HTTPS terminated upstream)
  app.set('trust proxy', 1);

  const gate = basicAuthGate(process.env.BASIC_AUTH_USER, process.env.BASIC_AUTH_PASS);
  if (gate) app.use(gate);

  app.use(cors({ origin: [config.clientUrl, 'http://localhost:5173', 'http://localhost:3000'], credentials: true }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use((req, _res, next) => {
    logger.debug(`${req.method} ${req.path}`, { ip: req.ip, userAgent: req.headers['user-agent']?.substring(0, 50) });
    next();
  });

  app.get(
    '/health',
    asyncHandler(async (_req, res) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        env: config.env,
        worker: workerStatus,
        dueJobs: await countDueJobs().catch(() => null),
      });
    })
  );

  // Hostinger may put the app to sleep; a cron job calling this every minute wakes it.
  app.all(
    '/cron/tick',
    asyncHandler(async (req, res) => {
      const secret = process.env.CRON_SECRET;
      if (!secret) throw createError(404, 'Cron tick is disabled (CRON_SECRET not set)');
      const given = String(req.get('x-cron-secret') ?? req.query.key ?? '');
      if (!given || !safeEqual(given, secret)) throw createError(401, 'Invalid cron key');
      const worker = getWorker();
      if (!worker) throw createError(503, 'Worker not running');
      const processed = await worker.drain(45_000);
      res.json({ ok: true, processed, dueJobs: await countDueJobs() });
    })
  );

  for (const [mount, router] of API_ROUTERS) app.use(mount, router);

  app.get('/api', (_req, res) => {
    res.json({
      name: 'Auto Post Facebook API',
      version: '1.0.0',
      routes: API_ROUTERS.map(([mount]) => mount),
    });
  });

  const clientDist = path.resolve(process.cwd(), 'client', 'dist');
  if (existsSync(path.join(clientDist, 'index.html'))) {
    app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/|api$|health$|cron\/).*/, (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
```

Thay toàn bộ `src/server.ts`:

```ts
import { config } from './config';
import { logger } from './utils/logger';
import { createApp } from './app';
import { startWorkers } from './services/scheduler.service';
import { checkUncheckedPages } from './lib/page-health';

async function start() {
  try {
    const app = createApp();

    if (config.env === 'production' && !process.env.BASIC_AUTH_USER) {
      logger.info('Basic Auth tắt — truy cập được bảo vệ bằng đăng nhập của ứng dụng.');
    }

    // Background jobs (MariaDB queue) run in this same process
    if (config.env !== 'test') {
      startWorkers();
      void checkUncheckedPages();
    }

    app.listen(config.port, () => {
      logger.info(`Auto Post API listening on ${config.port} (${config.env}) — ${config.apiUrl}/api`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

void start();
```

- [ ] **Step 4: Chạy test**

Run: `npx vitest run tests/app.test.ts && npx tsc --noEmit`
Expected: PASS (2 tests), tsc không lỗi.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # feature/multi-user-domains
git add src/app.ts src/server.ts tests/helpers/http.ts tests/app.test.ts
git commit -m "refactor: build the Express app in createApp() for HTTP tests"
```

---

### Task 2: Schema — vai trò, bắt đổi mật khẩu, tokenVersion

**Files:**
- Modify: `prisma/schema.prisma` (model `User`, thêm enum)

**Interfaces:**
- Produces: `User.role: 'ADMIN' | 'USER'` (mặc định `USER`), `User.mustChangePassword: boolean`, `User.tokenVersion: number`; enum Prisma `UserRole`.

- [ ] **Step 1: Sửa schema** — thêm sau `enum SubscriptionPlan { … }`:

```prisma
enum UserRole {
  ADMIN
  USER
}
```

Trong `model User`, sau dòng `emailVerified Boolean @default(false)`:

```prisma
  // Access
  role               UserRole @default(USER)
  mustChangePassword Boolean  @default(false)
  /// Bumped on lock / password reset / password change ⇒ every existing session becomes invalid
  tokenVersion       Int      @default(0)
```

- [ ] **Step 2: Áp dụng và kiểm tra**

Run:
```bash
npx prisma format && npx prisma generate && npx prisma db push --skip-generate
docker exec autopost_mariadb mariadb -uautopost -pautopost_secret autopost_db -e "SHOW COLUMNS FROM users LIKE 'role'; SHOW COLUMNS FROM users LIKE 'tokenVersion';"
npx tsc --noEmit
```
Expected: `Your database is now in sync`; 2 cột hiện ra; tsc sạch.

- [ ] **Step 3: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(db): user role, mustChangePassword and tokenVersion"
```

---

### Task 3: Phiên đăng nhập (JWT trong cookie)

**Files:**
- Create: `src/lib/session.ts`, `tests/session.test.ts`

**Interfaces:**
- Produces: `SESSION_COOKIE = 'ap_session'`; `SESSION_MAX_AGE_MS`; `signSession(user: { id: string; tokenVersion: number }): string`; `verifySession(token: string): { sub: string; tv: number } | null`; `readCookie(header: string | undefined, name: string): string | null`; `readSessionToken(req: Request): string | null`; `setSessionCookie(res: Response, user: { id: string; tokenVersion: number }): void`; `clearSessionCookie(res: Response): void`; `sessionCookie(user) : string` (chuỗi `ap_session=<jwt>` dùng cho test).

- [ ] **Step 1: Viết test** — `tests/session.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { config } from '../src/config';
import { readCookie, sessionCookie, signSession, verifySession, SESSION_COOKIE } from '../src/lib/session';

describe('session token', () => {
  it('round-trips user id and token version', () => {
    expect(verifySession(signSession({ id: 'u1', tokenVersion: 3 }))).toEqual({ sub: 'u1', tv: 3 });
  });

  it('rejects tampered, foreign and expired tokens', () => {
    const token = signSession({ id: 'u1', tokenVersion: 0 });
    expect(verifySession(token.slice(0, -2) + 'xx')).toBeNull();
    expect(verifySession(jwt.sign({ tv: 0 }, 'another-secret', { subject: 'u1' }))).toBeNull();
    expect(verifySession(jwt.sign({ tv: 0 }, config.jwt.secret, { subject: 'u1', expiresIn: -10 }))).toBeNull();
  });

  it('rejects tokens without a token version (old login tokens)', () => {
    expect(verifySession(jwt.sign({ userId: 'u1' }, config.jwt.secret))).toBeNull();
  });
});

describe('readCookie', () => {
  it('finds the cookie among others and decodes it', () => {
    expect(readCookie(`a=1; ${SESSION_COOKIE}=abc%2Edef; b=2`, SESSION_COOKIE)).toBe('abc.def');
  });

  it('returns null when missing or malformed', () => {
    expect(readCookie(undefined, SESSION_COOKIE)).toBeNull();
    expect(readCookie('a=1; b', SESSION_COOKIE)).toBeNull();
    expect(readCookie(`${SESSION_COOKIE}=%E0%A4%A`, SESSION_COOKIE)).toBeNull();
  });

  it('sessionCookie() builds a Cookie header value', () => {
    expect(sessionCookie({ id: 'u1', tokenVersion: 0 })).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
  });
});
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `npx vitest run tests/session.test.ts`
Expected: FAIL — module `../src/lib/session` không tồn tại.

- [ ] **Step 3: Viết `src/lib/session.ts`**

```ts
import jwt from 'jsonwebtoken';
import type { CookieOptions, Request, Response } from 'express';
import { config } from '../config';

/**
 * Login session: a JWT `{ sub: userId, tv: tokenVersion }` in an httpOnly cookie.
 * Bumping User.tokenVersion (lock, password reset/change) invalidates every session.
 */

export const SESSION_COOKIE = 'ap_session';
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionClaims {
  sub: string;
  tv: number;
}

type SessionUser = { id: string; tokenVersion: number };

export function signSession(user: SessionUser): string {
  return jwt.sign({ tv: user.tokenVersion }, config.jwt.secret, {
    subject: user.id,
    expiresIn: Math.floor(SESSION_MAX_AGE_MS / 1000),
  });
}

export function verifySession(token: string): SessionClaims | null {
  try {
    const payload = jwt.verify(token, config.jwt.secret) as jwt.JwtPayload;
    if (typeof payload.sub !== 'string' || typeof payload.tv !== 'number') return null;
    return { sub: payload.sub, tv: payload.tv };
  } catch {
    return null;
  }
}

/** Minimal cookie parsing (no cookie-parser dependency). */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export const readSessionToken = (req: Request) => readCookie(req.headers.cookie, SESSION_COOKIE);

function cookieOptions(): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure: config.env === 'production', path: '/', maxAge: SESSION_MAX_AGE_MS };
}

export function setSessionCookie(res: Response, user: SessionUser): void {
  res.cookie(SESSION_COOKIE, signSession(user), cookieOptions());
}

export function clearSessionCookie(res: Response): void {
  const { maxAge: _maxAge, ...options } = cookieOptions();
  res.clearCookie(SESSION_COOKIE, options);
}

/** `Cookie` header value for tests and scripts. */
export const sessionCookie = (user: SessionUser) => `${SESSION_COOKIE}=${signSession(user)}`;
```

- [ ] **Step 4: Chạy test**

Run: `npx vitest run tests/session.test.ts && npx tsc --noEmit`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/session.ts tests/session.test.ts
git commit -m "feat(auth): signed session cookie helpers"
```

---

### Task 4: Mật khẩu & giới hạn đăng nhập sai

**Files:**
- Create: `src/lib/passwords.ts`, `src/lib/login-limiter.ts`, `tests/passwords.test.ts`, `tests/login-limiter.test.ts`

**Interfaces:**
- Produces: `normalizeEmail(email: string): string`; `newPasswordSchema: z.ZodString`; `generateTempPassword(): string`; `hashPassword(p: string): Promise<string>`; `verifyPassword(p: string, hash: string | null | undefined): Promise<boolean>`; `class LoginLimiter { constructor(max?, windowMs?, now?); retryAfterSeconds(key): number; fail(key): void; reset(key): void }`; `loginLimiter: LoginLimiter`; `limiterKey(email: string, ip: string | undefined): string`.

- [ ] **Step 1: Viết test**

`tests/passwords.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateTempPassword, hashPassword, newPasswordSchema, normalizeEmail, verifyPassword } from '../src/lib/passwords';

describe('passwords', () => {
  it('normalizes emails', () => {
    expect(normalizeEmail('  Admin@Example.COM ')).toBe('admin@example.com');
  });

  it('temporary passwords are 12 url-safe characters and unique', () => {
    const a = generateTempPassword();
    expect(a).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(generateTempPassword()).not.toBe(a);
  });

  it('new passwords need at least 10 characters', () => {
    expect(newPasswordSchema.safeParse('short').success).toBe(false);
    expect(newPasswordSchema.safeParse('long-enough-1').success).toBe(true);
  });

  it('verifies bcrypt hashes and refuses placeholder hashes', async () => {
    const hash = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('dummy', 'dummy')).toBe(false);
    expect(await verifyPassword('x', null)).toBe(false);
  }, 20_000);
});
```

`tests/login-limiter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { LoginLimiter, limiterKey } from '../src/lib/login-limiter';

describe('LoginLimiter', () => {
  it('blocks after 5 failures within 15 minutes, then frees up', () => {
    let now = 1_000_000;
    const limiter = new LoginLimiter(5, 15 * 60_000, () => now);
    const key = limiterKey('a@b.c', '1.2.3.4');
    for (let i = 0; i < 4; i++) limiter.fail(key);
    expect(limiter.retryAfterSeconds(key)).toBe(0);
    limiter.fail(key);
    expect(limiter.retryAfterSeconds(key)).toBe(15 * 60);
    now += 10 * 60_000;
    expect(limiter.retryAfterSeconds(key)).toBe(5 * 60);
    now += 5 * 60_000 + 1;
    expect(limiter.retryAfterSeconds(key)).toBe(0);
  });

  it('a success resets the count; keys are per email and IP', () => {
    const limiter = new LoginLimiter(2, 60_000, () => 0);
    limiter.fail(limiterKey('a@b.c', 'ip1'));
    limiter.fail(limiterKey('a@b.c', 'ip1'));
    expect(limiter.retryAfterSeconds(limiterKey('a@b.c', 'ip2'))).toBe(0);
    limiter.reset(limiterKey('a@b.c', 'ip1'));
    expect(limiter.retryAfterSeconds(limiterKey('a@b.c', 'ip1'))).toBe(0);
  });
});
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `npx vitest run tests/passwords.test.ts tests/login-limiter.test.ts`
Expected: FAIL — module không tồn tại.

- [ ] **Step 3: Viết code**

`src/lib/passwords.ts`:

```ts
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

export const BCRYPT_COST = 12;

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const newPasswordSchema = z.string().min(10, 'Mật khẩu mới cần ít nhất 10 ký tự.').max(200);

/** 12 url-safe characters, shown once to the admin. */
export const generateTempPassword = () => randomBytes(9).toString('base64url');

export const hashPassword = (password: string) => bcrypt.hash(password, BCRYPT_COST);

/** False for missing or placeholder hashes (e.g. the old bypass user's "dummy"). */
export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash || !hash.startsWith('$2')) return false;
  return bcrypt.compare(password, hash);
}
```

`src/lib/login-limiter.ts`:

```ts
/**
 * Failed-login counter per `email|IP`, in process memory (reset on restart —
 * acceptable for a small internal team). 5 failures / 15 minutes ⇒ locked.
 */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max = 5,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = () => Date.now()
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  /** 0 when allowed, otherwise seconds until the oldest failure expires. */
  retryAfterSeconds(key: string): number {
    const list = this.recent(key);
    if (list.length < this.max) return 0;
    return Math.max(1, Math.ceil((list[0] + this.windowMs - this.now()) / 1000));
  }

  fail(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.failures.set(key, list);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}

export const loginLimiter = new LoginLimiter();
export const limiterKey = (email: string, ip: string | undefined) => `${email}|${ip ?? ''}`;
```

- [ ] **Step 4: Chạy test**

Run: `npx vitest run tests/passwords.test.ts tests/login-limiter.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/passwords.ts src/lib/login-limiter.ts tests/passwords.test.ts tests/login-limiter.test.ts
git commit -m "feat(auth): password helpers and failed-login limiter"
```

---

### Task 5: Middleware đăng nhập thật, `requireAdmin`, chống CSRF, mã lỗi

**Files:**
- Modify: `src/middleware/auth.middleware.ts` (thay `authenticate`, cập nhật `AuthRequest`, `authenticateApiKey`), `src/middleware/error.middleware.ts` (thêm `code`), `src/app.ts` (gắn `csrfGuard`)
- Create: `tests/helpers/users.ts`, `tests/auth-middleware.db.test.ts`

**Interfaces:**
- Consumes: `readSessionToken`, `verifySession` (Task 3).
- Produces: `interface AuthUser { id; email; name; plan; role: 'ADMIN' | 'USER'; mustChangePassword: boolean }`; `AuthRequest.user?: AuthUser`; `authenticate`; `requireAdmin`; `csrfGuard`; body lỗi có `code` khi `createError(..., { code })`. Test helper: `createTestUser(opts?) → Promise<{ user: User; cookie: string; password: string }>`, `cleanupTestUsers()`, `TEST_EMAIL_DOMAIN = '@autopost.test'`.

- [ ] **Step 1: Viết helper + test**

`tests/helpers/users.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { User } from '@prisma/client';
import prisma from '../../src/utils/prisma';
import { hashPassword } from '../../src/lib/passwords';
import { sessionCookie } from '../../src/lib/session';

export const TEST_EMAIL_DOMAIN = '@autopost.test';

export async function createTestUser(
  opts: Partial<Pick<User, 'role' | 'isActive' | 'mustChangePassword' | 'name'>> & { password?: string } = {}
): Promise<{ user: User; cookie: string; password: string }> {
  const password = opts.password ?? 'test-password-123';
  const user = await prisma.user.create({
    data: {
      email: `u-${randomUUID().slice(0, 8)}${TEST_EMAIL_DOMAIN}`,
      name: opts.name ?? 'Test User',
      passwordHash: await hashPassword(password),
      role: opts.role ?? 'USER',
      isActive: opts.isActive ?? true,
      mustChangePassword: opts.mustChangePassword ?? false,
      plan: 'ENTERPRISE',
    },
  });
  return { user, cookie: sessionCookie(user), password };
}

/** Deletes every test user (cascades their Pages, posts, schedules, settings…). */
export const cleanupTestUsers = () => prisma.user.deleteMany({ where: { email: { endsWith: TEST_EMAIL_DOMAIN } } });
```

`tests/auth-middleware.db.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;

describe.skipIf(!process.env.RUN_DB_TESTS)('authenticate middleware', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    await cleanupTestUsers();
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('401 without a session, with code UNAUTHENTICATED', async () => {
    const res = await api(server.baseUrl, 'GET', '/api/pages');
    expect(res.status).toBe(401);
    expect(res.json.code).toBe('UNAUTHENTICATED');
  });

  it('accepts a valid session and rejects a tampered one', async () => {
    const { cookie } = await createTestUser();
    expect((await api(server.baseUrl, 'GET', '/api/pages', { cookie })).status).toBe(200);
    expect((await api(server.baseUrl, 'GET', '/api/pages', { cookie: cookie.slice(0, -3) + 'abc' })).status).toBe(401);
  });

  it('a bumped tokenVersion or a locked account kills existing sessions', async () => {
    const a = await createTestUser();
    await prisma.user.update({ where: { id: a.user.id }, data: { tokenVersion: { increment: 1 } } });
    expect((await api(server.baseUrl, 'GET', '/api/pages', { cookie: a.cookie })).status).toBe(401);

    const b = await createTestUser();
    await prisma.user.update({ where: { id: b.user.id }, data: { isActive: false } });
    expect((await api(server.baseUrl, 'GET', '/api/pages', { cookie: b.cookie })).status).toBe(401);
  });

  it('mustChangePassword only allows me / change-password / logout', async () => {
    const { cookie } = await createTestUser({ mustChangePassword: true });
    const blocked = await api(server.baseUrl, 'GET', '/api/pages', { cookie });
    expect(blocked.status).toBe(403);
    expect(blocked.json.code).toBe('MUST_CHANGE_PASSWORD');
    expect((await api(server.baseUrl, 'GET', '/api/auth/me', { cookie })).status).toBe(200);
  });

  it('state-changing API calls need the X-Requested-With header', async () => {
    const { cookie } = await createTestUser();
    const res = await api(server.baseUrl, 'POST', '/api/pages/check', { cookie, headers: { 'X-Requested-With': '' } });
    expect(res.status).toBe(403);
    expect(res.json.code).toBe('CSRF');
  });
});
```

- [ ] **Step 2: Chạy để thấy fail** (tắt dev server trước)

Run: `RUN_DB_TESTS=1 npx vitest run tests/auth-middleware.db.test.ts`
Expected: FAIL — request không cookie vẫn 200 (middleware đang bỏ qua đăng nhập).

- [ ] **Step 3: Sửa middleware**

`src/middleware/error.middleware.ts` — thay khối `res.status(statusCode).json({...})` cuối `errorHandler` bằng:

```ts
  const code =
    err.details && typeof err.details === 'object' && typeof (err.details as { code?: unknown }).code === 'string'
      ? (err.details as { code: string }).code
      : undefined;

  res.status(statusCode).json({
    success: false,
    error: message,
    ...(code && { code }),
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
```

`src/middleware/auth.middleware.ts` — thay phần đầu file tới hết `authenticate` bằng:

```ts
import { Request, Response, NextFunction } from 'express';
import prisma from '../utils/prisma';
import { createError } from './error.middleware';
import { readSessionToken, verifySession } from '../lib/session';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  plan: string;
  role: 'ADMIN' | 'USER';
  mustChangePassword: boolean;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

/** Reachable while the user still has to replace a temporary password. */
const PASSWORD_CHANGE_ALLOWED = new Set(['/api/auth/me', '/api/auth/change-password', '/api/auth/logout']);

/** Session cookie ⇒ req.user. Every /api route except login uses this. */
export const authenticate = async (req: AuthRequest, _res: Response, next: NextFunction): Promise<void> => {
  try {
    const token = readSessionToken(req);
    const claims = token ? verifySession(token) : null;
    if (!claims) return next(createError(401, 'Vui lòng đăng nhập.', { code: 'UNAUTHENTICATED' }));

    const user = await prisma.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, email: true, name: true, plan: true, role: true, isActive: true, mustChangePassword: true, tokenVersion: true },
    });
    if (!user || !user.isActive || user.tokenVersion !== claims.tv) {
      return next(createError(401, 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.', { code: 'UNAUTHENTICATED' }));
    }

    req.user = { id: user.id, email: user.email, name: user.name, plan: user.plan, role: user.role, mustChangePassword: user.mustChangePassword };

    const path = req.originalUrl.split('?')[0];
    if (user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(path)) {
      return next(createError(403, 'Bạn cần đổi mật khẩu trước khi tiếp tục.', { code: 'MUST_CHANGE_PASSWORD' }));
    }
    next();
  } catch (error) {
    next(error);
  }
};

export const requireAdmin = (req: AuthRequest, _res: Response, next: NextFunction): void => {
  if (req.user?.role !== 'ADMIN') return next(createError(403, 'Chỉ quản trị viên mới dùng được chức năng này.', { code: 'FORBIDDEN' }));
  next();
};

/** CSRF: browsers cannot add custom headers cross-site without a CORS preflight we do not allow. */
export const csrfGuard = (req: Request, _res: Response, next: NextFunction): void => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.get('x-requested-with') !== 'autopost') {
    return next(createError(403, 'Yêu cầu không hợp lệ (thiếu X-Requested-With).', { code: 'CSRF' }));
  }
  next();
};
```

Trong `authenticateApiKey` (giữ nguyên phần còn lại): đổi `include: { user: { select: { id, email, name, plan, isActive } } }` thành thêm `role: true`, và khối gán `req.user` thành:

```ts
    req.user = {
      id: key.user.id,
      email: key.user.email,
      name: key.user.name,
      plan: key.user.plan,
      role: key.user.role,
      mustChangePassword: false,
    };
```

`src/app.ts` — ngay trước vòng `for (const [mount, router] of API_ROUTERS)`:

```ts
  app.use('/api', csrfGuard);
```
và import `import { csrfGuard } from './middleware/auth.middleware';`.

- [ ] **Step 4: Chạy test**

Run: `npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run tests/auth-middleware.db.test.ts tests/app.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/middleware/auth.middleware.ts src/middleware/error.middleware.ts src/app.ts tests/helpers/users.ts tests/auth-middleware.db.test.ts
git commit -m "feat(auth): real session middleware, admin guard, CSRF header check"
```

---

### Task 6: Route đăng nhập / đăng xuất / đổi mật khẩu

**Files:**
- Modify: `src/routes/auth.routes.ts` (viết lại toàn bộ)
- Create: `tests/auth-routes.db.test.ts`

**Interfaces:**
- Consumes: `normalizeEmail`, `verifyPassword`, `hashPassword`, `newPasswordSchema`, `loginLimiter`, `limiterKey` (Task 4); `setSessionCookie`, `clearSessionCookie` (Task 3); `authenticate` (Task 5).
- Produces: `POST /api/auth/login` ⇒ `{ data: PublicUser }` + cookie; `POST /api/auth/logout`; `GET /api/auth/me` ⇒ `PublicUser`; `POST /api/auth/change-password`; `POST /api/auth/api-keys` (giữ). `PublicUser = { id, email, name, role, mustChangePassword }`. Gỡ `register`, `facebook`, `facebook/callback`.

- [ ] **Step 1: Viết test** — `tests/auth-routes.db.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;
const cookieFrom = (headers: Headers) => (headers.get('set-cookie') ?? '').split(';')[0];

describe.skipIf(!process.env.RUN_DB_TESTS)('auth routes', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await cleanupTestUsers();
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('logs in with a case-insensitive, trimmed email and sets an httpOnly cookie', async () => {
    const { user, password } = await createTestUser();
    const res = await api(server.baseUrl, 'POST', '/api/auth/login', { body: { email: `  ${user.email.toUpperCase()} `, password } });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ id: user.id, role: 'USER', mustChangePassword: false });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^ap_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);

    const me = await api(server.baseUrl, 'GET', '/api/auth/me', { cookie: cookieFrom(res.headers) });
    expect(me.json.data.email).toBe(user.email);
  });

  it('answers the same generic error for a wrong password and a locked account', async () => {
    const a = await createTestUser();
    const wrong = await api(server.baseUrl, 'POST', '/api/auth/login', { body: { email: a.user.email, password: 'nope-nope-nope' } });
    const b = await createTestUser({ isActive: false });
    const locked = await api(server.baseUrl, 'POST', '/api/auth/login', { body: { email: b.user.email, password: b.password } });
    expect(wrong.status).toBe(401);
    expect(locked.status).toBe(401);
    expect(wrong.json.error).toBe('Email hoặc mật khẩu không đúng.');
    expect(locked.json.error).toBe(wrong.json.error);
  });

  it('locks the email after 5 failures (429 with Retry-After)', async () => {
    const { user, password } = await createTestUser();
    for (let i = 0; i < 5; i++) {
      await api(server.baseUrl, 'POST', '/api/auth/login', { body: { email: user.email, password: 'wrong-password' } });
    }
    const res = await api(server.baseUrl, 'POST', '/api/auth/login', { body: { email: user.email, password } });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('change-password replaces a temporary password and invalidates the old session', async () => {
    const { user, cookie, password } = await createTestUser({ mustChangePassword: true });
    const bad = await api(server.baseUrl, 'POST', '/api/auth/change-password', { cookie, body: { currentPassword: 'wrong', newPassword: 'brand-new-pass-1' } });
    expect(bad.status).toBe(400);
    const short = await api(server.baseUrl, 'POST', '/api/auth/change-password', { cookie, body: { currentPassword: password, newPassword: 'short' } });
    expect(short.status).toBe(400);

    const ok = await api(server.baseUrl, 'POST', '/api/auth/change-password', { cookie, body: { currentPassword: password, newPassword: 'brand-new-pass-1' } });
    expect(ok.status).toBe(200);
    expect(ok.json.data.mustChangePassword).toBe(false);
    expect((await api(server.baseUrl, 'GET', '/api/pages', { cookie })).status).toBe(401);
    expect((await api(server.baseUrl, 'GET', '/api/pages', { cookie: cookieFrom(ok.headers) })).status).toBe(200);

    const relogin = await api(server.baseUrl, 'POST', '/api/auth/login', { body: { email: user.email, password: 'brand-new-pass-1' } });
    expect(relogin.status).toBe(200);
  });

  it('logout clears the cookie; self sign-up is gone', async () => {
    const out = await api(server.baseUrl, 'POST', '/api/auth/logout');
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toMatch(/ap_session=;/);
    const reg = await api(server.baseUrl, 'POST', '/api/auth/register', { body: { email: 'x@y.z', password: 'whatever-123', name: 'X' } });
    expect(reg.status).toBe(404);
  });
});
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `RUN_DB_TESTS=1 npx vitest run tests/auth-routes.db.test.ts`
Expected: FAIL — login trả token trong body, không set cookie; register vẫn 201.

- [ ] **Step 3: Viết lại `src/routes/auth.routes.ts`**

```ts
import { Router, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { clearSessionCookie, setSessionCookie } from '../lib/session';
import { hashPassword, newPasswordSchema, normalizeEmail, verifyPassword } from '../lib/passwords';
import { limiterKey, loginLimiter } from '../lib/login-limiter';
import { logger } from '../utils/logger';

const router = Router();

const publicUserSelect = { id: true, email: true, name: true, role: true, mustChangePassword: true } as const;

// ─── Login ──────────────────────────────────────

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const body = z.object({ email: z.string().min(1), password: z.string().min(1) }).parse(req.body);
    const email = normalizeEmail(body.email);
    const key = limiterKey(email, req.ip);

    const wait = loginLimiter.retryAfterSeconds(key);
    if (wait) {
      res.setHeader('Retry-After', String(wait));
      throw createError(429, `Đăng nhập sai quá nhiều lần. Thử lại sau ${Math.ceil(wait / 60)} phút.`, { code: 'LOGIN_LOCKED' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive || !(await verifyPassword(body.password, user.passwordHash))) {
      loginLimiter.fail(key);
      throw createError(401, 'Email hoặc mật khẩu không đúng.', { code: 'BAD_CREDENTIALS' });
    }

    loginLimiter.reset(key);
    const updated = await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    setSessionCookie(res, updated);
    logger.info('User logged in', { userId: user.id });
    res.json({ success: true, data: { id: updated.id, email: updated.email, name: updated.name, role: updated.role, mustChangePassword: updated.mustChangePassword } });
  })
);

// ─── Logout (works with an expired session too) ─

router.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

// ─── Current user ───────────────────────────────

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: publicUserSelect });
    res.json({ success: true, data: user });
  })
);

// ─── Change password ────────────────────────────

router.post(
  '/change-password',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { currentPassword, newPassword } = z
      .object({ currentPassword: z.string().min(1), newPassword: newPasswordSchema })
      .parse(req.body);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw createError(400, 'Mật khẩu hiện tại không đúng.', { code: 'BAD_CURRENT_PASSWORD' });
    }
    if (currentPassword === newPassword) throw createError(400, 'Mật khẩu mới phải khác mật khẩu hiện tại.');

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false, tokenVersion: { increment: 1 } },
    });
    setSessionCookie(res, updated); // old sessions die, this one continues
    res.json({ success: true, data: { id: updated.id, email: updated.email, name: updated.name, role: updated.role, mustChangePassword: false } });
  })
);

// ─── API keys (external integrations) ───────────

router.post(
  '/api-keys',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { name } = z.object({ name: z.string().min(1) }).parse(req.body);
    const apiKey = await prisma.apiKey.create({
      data: {
        userId: req.user!.id,
        key: `ap_${randomUUID().replace(/-/g, '')}`,
        name,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      },
      select: { id: true, key: true, name: true, createdAt: true, expiresAt: true },
    });
    res.status(201).json({ success: true, data: apiKey });
  })
);

export default router;
```

- [ ] **Step 4: Chạy test**

Run: `npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run tests/auth-routes.db.test.ts tests/auth-middleware.db.test.ts`
Expected: PASS (10 tests). Nếu tsc báo `sendWelcomeEmail`/`facebookService.getLoginUrl` không còn dùng: không sao (chỉ còn định nghĩa trong service).

- [ ] **Step 5: Commit**

```bash
git add src/routes/auth.routes.ts tests/auth-routes.db.test.ts
git commit -m "feat(auth): cookie login, logout, change-password; remove self sign-up"
```

---

### Task 7: Khởi tạo admin & kiểm tra JWT_SECRET khi khởi động

**Files:**
- Create: `src/lib/bootstrap.ts`, `tests/bootstrap.db.test.ts`
- Modify: `src/config/index.ts:14-17`, `src/server.ts`

**Interfaces:**
- Consumes: `hashPassword`, `normalizeEmail`, `newPasswordSchema` (Task 4).
- Produces: `DEFAULT_JWT_SECRET` (config); `assertJwtSecret(env?: string, secret?: string): void`; `ensureAdmin(env?: NodeJS.ProcessEnv, db?: Prisma.TransactionClient): Promise<void>`; `runBootstrap(): Promise<void>`.

- [ ] **Step 1: Viết test** — `tests/bootstrap.db.test.ts` (chạy trong transaction rồi rollback để không đụng dữ liệu local)

```ts
import { describe, it, expect, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { assertJwtSecret, ensureAdmin } from '../src/lib/bootstrap';
import { verifyPassword } from '../src/lib/passwords';
import { DEFAULT_JWT_SECRET } from '../src/config';
import type { Prisma } from '@prisma/client';

const ROLLBACK = new Error('rollback');
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  // bcrypt (cost 12) runs inside: allow more than Prisma's 5 s default
  await prisma.$transaction(async (tx) => {
    await fn(tx);
    throw ROLLBACK;
  }, { timeout: 30_000, maxWait: 10_000 }).catch((e) => {
    if (e !== ROLLBACK) throw e;
  });
}

describe('assertJwtSecret', () => {
  it('refuses the default or a short secret in production only', () => {
    expect(() => assertJwtSecret('production', DEFAULT_JWT_SECRET)).toThrow(/JWT_SECRET/);
    expect(() => assertJwtSecret('production', 'short')).toThrow(/JWT_SECRET/);
    expect(() => assertJwtSecret('production', 'x'.repeat(40))).not.toThrow();
    expect(() => assertJwtSecret('development', DEFAULT_JWT_SECRET)).not.toThrow();
  });
});

describe.skipIf(!process.env.RUN_DB_TESTS)('ensureAdmin', () => {
  afterAll(() => prisma.$disconnect());

  it('promotes the oldest user when nobody is ADMIN, and stays idempotent', async () => {
    await inRollback(async (tx) => {
      if ((await tx.user.count()) === 0) await tx.user.create({ data: { email: 'first@autopost.test', name: 'First' } });
      await tx.user.updateMany({ data: { role: 'USER' } });
      const oldest = await tx.user.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
      await ensureAdmin({}, tx);
      await ensureAdmin({}, tx);
      const admins = await tx.user.findMany({ where: { role: 'ADMIN' } });
      expect(admins.map((a) => a.id)).toEqual([oldest.id]);
    });
  });

  it('sets ADMIN_EMAIL/ADMIN_PASSWORD only while the admin has no real password', async () => {
    await inRollback(async (tx) => {
      if ((await tx.user.count()) === 0) await tx.user.create({ data: { email: 'first@autopost.test', name: 'First' } });
      await tx.user.updateMany({ data: { role: 'USER' } });
      const oldest = await tx.user.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
      await tx.user.update({ where: { id: oldest.id }, data: { role: 'ADMIN', passwordHash: 'dummy' } });

      await ensureAdmin({ ADMIN_EMAIL: ' Boss@AutoPost.test ', ADMIN_PASSWORD: 'first-password-1' }, tx);
      const set = await tx.user.findUniqueOrThrow({ where: { id: oldest.id } });
      expect(set.email).toBe('boss@autopost.test');
      expect(await verifyPassword('first-password-1', set.passwordHash)).toBe(true);

      await ensureAdmin({ ADMIN_EMAIL: 'boss@autopost.test', ADMIN_PASSWORD: 'second-password-2' }, tx);
      const again = await tx.user.findUniqueOrThrow({ where: { id: oldest.id } });
      expect(await verifyPassword('first-password-1', again.passwordHash)).toBe(true);
    });
  }, 30_000);
});
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `RUN_DB_TESTS=1 npx vitest run tests/bootstrap.db.test.ts`
Expected: FAIL — module `../src/lib/bootstrap` không tồn tại.

- [ ] **Step 3: Viết code**

`src/config/index.ts` — trên `export const config = {` thêm:

```ts
/** Placeholder used when JWT_SECRET is missing — refused in production (lib/bootstrap). */
export const DEFAULT_JWT_SECRET = 'dev-secret-change-me';
```
và trong `jwt:` đổi `secret: process.env.JWT_SECRET || 'dev-secret-change-me',` thành `secret: process.env.JWT_SECRET || DEFAULT_JWT_SECRET,`.

`src/lib/bootstrap.ts`:

```ts
import type { Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { config, DEFAULT_JWT_SECRET } from '../config';
import { logger } from '../utils/logger';
import { hashPassword, newPasswordSchema, normalizeEmail } from './passwords';

/** Sessions are only as safe as the signing key. */
export function assertJwtSecret(env: string = config.env, secret: string = config.jwt.secret): void {
  if (env !== 'production') return;
  if (!secret || secret === DEFAULT_JWT_SECRET || secret.length < 32) {
    throw new Error('JWT_SECRET phải là chuỗi ngẫu nhiên từ 32 ký tự trở lên trong production.');
  }
}

/**
 * Exactly one guaranteed way in: an ADMIN always exists, and on the first deploy
 * the old bypass user ("dummy" password) gets ADMIN_EMAIL / ADMIN_PASSWORD.
 * Idempotent; never overwrites a real password.
 */
export async function ensureAdmin(env: NodeJS.ProcessEnv = process.env, db: Prisma.TransactionClient = prisma): Promise<void> {
  let admin = await db.user.findFirst({ where: { role: 'ADMIN' }, orderBy: { createdAt: 'asc' } });

  if (!admin) {
    const oldest = await db.user.findFirst({ orderBy: { createdAt: 'asc' } });
    if (oldest) {
      admin = await db.user.update({ where: { id: oldest.id }, data: { role: 'ADMIN', isActive: true } });
      logger.info('[Bootstrap] Oldest user promoted to ADMIN', { userId: admin.id });
    } else if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
      admin = await db.user.create({
        data: { email: normalizeEmail(env.ADMIN_EMAIL), name: 'Admin', role: 'ADMIN', plan: 'ENTERPRISE', passwordHash: await hashPassword(env.ADMIN_PASSWORD) },
      });
      logger.info('[Bootstrap] ADMIN created from ADMIN_EMAIL', { userId: admin.id });
      return;
    } else {
      logger.warn('[Bootstrap] Chưa có user nào: đặt ADMIN_EMAIL + ADMIN_PASSWORD rồi khởi động lại.');
      return;
    }
  }

  const hasRealPassword = !!admin.passwordHash?.startsWith('$2');
  if (hasRealPassword) return;

  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    logger.warn('[Bootstrap] Admin chưa có mật khẩu: đặt ADMIN_EMAIL + ADMIN_PASSWORD rồi khởi động lại.');
    return;
  }
  const password = newPasswordSchema.safeParse(env.ADMIN_PASSWORD);
  if (!password.success) {
    logger.error('[Bootstrap] ADMIN_PASSWORD cần ít nhất 10 ký tự — bỏ qua.');
    return;
  }
  const email = normalizeEmail(env.ADMIN_EMAIL);
  const clash = await db.user.findFirst({ where: { email, NOT: { id: admin.id } } });
  if (clash) {
    logger.error('[Bootstrap] ADMIN_EMAIL đã thuộc tài khoản khác — bỏ qua.', { email });
    return;
  }
  await db.user.update({
    where: { id: admin.id },
    data: { email, passwordHash: await hashPassword(password.data), mustChangePassword: false, tokenVersion: { increment: 1 } },
  });
  logger.info('[Bootstrap] Admin credentials set from ADMIN_EMAIL / ADMIN_PASSWORD', { email });
}

export async function runBootstrap(): Promise<void> {
  assertJwtSecret();
  await ensureAdmin();
}
```

`src/server.ts` — trong `start()`, ngay sau `const app = createApp();` thêm `await runBootstrap();` và import `import { runBootstrap } from './lib/bootstrap';`.

- [ ] **Step 4: Chạy test**

Run: `npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run tests/bootstrap.db.test.ts`
Expected: PASS (3 tests). Kiểm tra dữ liệu local không bị đổi: `docker exec autopost_mariadb mariadb -uautopost -pautopost_secret autopost_db -e "SELECT email, role FROM users ORDER BY createdAt LIMIT 3"` — email admin local giữ nguyên.

- [ ] **Step 5: Commit**

```bash
git add src/lib/bootstrap.ts src/config/index.ts src/server.ts tests/bootstrap.db.test.ts
git commit -m "feat(auth): bootstrap the admin account and require a strong JWT secret"
```

---

### Task 8: API quản lý người dùng + không đăng bài của tài khoản bị khoá

**Files:**
- Create: `src/lib/admin-guards.ts`, `src/routes/admin.routes.ts`, `tests/admin-guards.test.ts`, `tests/admin.db.test.ts`
- Modify: `src/app.ts` (`API_ROUTERS` thêm `['/api/admin', adminRoutes]`), `src/services/scheduler.service.ts` (`runPublishJob`, `runTargetJob`), `tests/multi-page.db.test.ts`

**Interfaces:**
- Consumes: `authenticate`, `requireAdmin` (Task 5); `generateTempPassword`, `hashPassword`, `normalizeEmail` (Task 4).
- Produces: `accountChangeBlock(input: { actorId: string; target: { id: string; role: 'ADMIN'|'USER'; isActive: boolean }; change: { isActive?: boolean; role?: 'ADMIN'|'USER' }; otherActiveAdmins: number }): string | null`; routes `GET/POST /api/admin/users`, `PATCH /api/admin/users/:id`, `POST /api/admin/users/:id/reset-password`; `AdminUserRow = { id, email, name, role, isActive, mustChangePassword, lastLoginAt, createdAt, pages: number, posts30d: number }`.

- [ ] **Step 1: Viết test**

`tests/admin-guards.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { accountChangeBlock } from '../src/lib/admin-guards';

const admin = { id: 'a1', role: 'ADMIN' as const, isActive: true };
const user = { id: 'u1', role: 'USER' as const, isActive: true };

describe('accountChangeBlock', () => {
  it('stops admins from locking or demoting themselves', () => {
    expect(accountChangeBlock({ actorId: 'a1', target: admin, change: { isActive: false }, otherActiveAdmins: 3 })).toMatch(/chính mình/);
    expect(accountChangeBlock({ actorId: 'a1', target: admin, change: { role: 'USER' }, otherActiveAdmins: 3 })).toMatch(/chính mình/);
  });

  it('keeps at least one active admin', () => {
    expect(accountChangeBlock({ actorId: 'x', target: admin, change: { isActive: false }, otherActiveAdmins: 0 })).toMatch(/ít nhất một/);
    expect(accountChangeBlock({ actorId: 'x', target: admin, change: { role: 'USER' }, otherActiveAdmins: 0 })).toMatch(/ít nhất một/);
    expect(accountChangeBlock({ actorId: 'x', target: admin, change: { isActive: false }, otherActiveAdmins: 1 })).toBeNull();
  });

  it('allows ordinary changes', () => {
    expect(accountChangeBlock({ actorId: 'a1', target: user, change: { isActive: false }, otherActiveAdmins: 0 })).toBeNull();
    expect(accountChangeBlock({ actorId: 'a1', target: user, change: { role: 'ADMIN' }, otherActiveAdmins: 0 })).toBeNull();
  });
});
```

`tests/admin.db.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser, TEST_EMAIL_DOMAIN } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;
let adminCookie: string;
let adminId: string;

describe.skipIf(!process.env.RUN_DB_TESTS)('admin users API', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await cleanupTestUsers();
    server = await startTestServer(createApp());
    const admin = await createTestUser({ role: 'ADMIN', name: 'Test Admin' });
    adminCookie = admin.cookie;
    adminId = admin.user.id;
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('is forbidden to regular users', async () => {
    const { cookie } = await createTestUser();
    const res = await api(server.baseUrl, 'GET', '/api/admin/users', { cookie });
    expect(res.status).toBe(403);
  });

  it('creates a user with a one-time temporary password that must be changed', async () => {
    const email = `New.Person${TEST_EMAIL_DOMAIN}`.toUpperCase();
    const created = await api(server.baseUrl, 'POST', '/api/admin/users', { cookie: adminCookie, body: { email, name: 'Người mới', role: 'USER' } });
    expect(created.status).toBe(201);
    expect(created.json.data.tempPassword).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(created.json.data.user.email).toBe(email.toLowerCase());

    const dup = await api(server.baseUrl, 'POST', '/api/admin/users', { cookie: adminCookie, body: { email: email.toLowerCase(), name: 'X', role: 'USER' } });
    expect(dup.status).toBe(409);

    const login = await api(server.baseUrl, 'POST', '/api/auth/login', { body: { email, password: created.json.data.tempPassword } });
    expect(login.json.data.mustChangePassword).toBe(true);
  });

  it('lists users with counts but no content', async () => {
    const res = await api(server.baseUrl, 'GET', '/api/admin/users', { cookie: adminCookie });
    expect(res.status).toBe(200);
    const row = res.json.data.find((u: { id: string }) => u.id === adminId);
    expect(row).toMatchObject({ role: 'ADMIN', isActive: true, pages: 0, posts30d: 0 });
    expect(row).not.toHaveProperty('passwordHash');
  });

  it('locking a user ends their sessions; reset gives a new temporary password', async () => {
    const target = await createTestUser();
    const lock = await api(server.baseUrl, 'PATCH', `/api/admin/users/${target.user.id}`, { cookie: adminCookie, body: { isActive: false } });
    expect(lock.status).toBe(200);
    expect((await api(server.baseUrl, 'GET', '/api/pages', { cookie: target.cookie })).status).toBe(401);

    const other = await createTestUser();
    const reset = await api(server.baseUrl, 'POST', `/api/admin/users/${other.user.id}/reset-password`, { cookie: adminCookie });
    expect(reset.status).toBe(200);
    expect((await api(server.baseUrl, 'GET', '/api/pages', { cookie: other.cookie })).status).toBe(401);
    const login = await api(server.baseUrl, 'POST', '/api/auth/login', { body: { email: other.user.email, password: reset.json.data.tempPassword } });
    expect(login.json.data.mustChangePassword).toBe(true);
  });

  it('refuses to lock yourself (409) and 404s unknown users', async () => {
    const self = await api(server.baseUrl, 'PATCH', `/api/admin/users/${adminId}`, { cookie: adminCookie, body: { isActive: false } });
    expect(self.status).toBe(409);
    const missing = await api(server.baseUrl, 'PATCH', '/api/admin/users/00000000-0000-0000-0000-000000000000', { cookie: adminCookie, body: { isActive: false } });
    expect(missing.status).toBe(404);
  });
});
```

Trong `tests/multi-page.db.test.ts`, thêm test trước `it('a double click never publishes the same Page twice'…`:

```ts
  it('does not publish for a locked account', async () => {
    const locked = await prisma.user.create({ data: { email: `locked-${Date.now()}@autopost.test`, name: 'Locked', isActive: false } });
    const page = await prisma.facebookPage.create({ data: { userId: locked.id, pageId: 'TEST_MP_LOCKED', pageName: 'Trang khoá', pageAccessToken: 'EAAfaketokenlockedxxxxxxxxxxxxxxxx' } });
    const post = await prisma.post.create({
      data: { userId: locked.id, pageId: page.id, caption: 'Không được đăng', status: 'GENERATING', targets: { create: [{ pageId: page.id }] } },
      include: { targets: true },
    });
    try {
      await enqueuePost(post.id, locked.id, { skipAi: true, targetIds: post.targets.map((t) => t.id), intervalMs: 0 });
      const done = await waitForStatus(post.id, ['PUBLISHED', 'FAILED']);
      expect(done.status).toBe('FAILED');
      expect(done.errorMessage).toMatch(/Tài khoản đã bị khoá/);
      expect(publishCalls).not.toContain('TEST_MP_LOCKED');
    } finally {
      await prisma.user.delete({ where: { id: locked.id } });
    }
  });
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `npx vitest run tests/admin-guards.test.ts; RUN_DB_TESTS=1 npx vitest run tests/admin.db.test.ts tests/multi-page.db.test.ts`
Expected: FAIL — module `admin-guards` không có; `/api/admin/users` 404; bài của tài khoản khoá vẫn được đăng.

- [ ] **Step 3: Viết code**

`src/lib/admin-guards.ts`:

```ts
type Role = 'ADMIN' | 'USER';

/**
 * Why an account change must be refused (null = allowed): nobody locks or demotes
 * themselves, and at least one active ADMIN always remains.
 */
export function accountChangeBlock(input: {
  actorId: string;
  target: { id: string; role: Role; isActive: boolean };
  change: { isActive?: boolean; role?: Role };
  otherActiveAdmins: number;
}): string | null {
  const { actorId, target, change, otherActiveAdmins } = input;
  const removesAdmin = target.role === 'ADMIN' && target.isActive && (change.isActive === false || change.role === 'USER');
  if (target.id === actorId && removesAdmin) return 'Không thể tự khoá hoặc tự bỏ quyền quản trị của chính mình.';
  if (removesAdmin && otherActiveAdmins === 0) return 'Phải còn ít nhất một quản trị viên đang hoạt động.';
  return null;
}
```

`src/routes/admin.routes.ts`:

```ts
import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate, requireAdmin } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { generateTempPassword, hashPassword, normalizeEmail } from '../lib/passwords';
import { accountChangeBlock } from '../lib/admin-guards';
import { logger } from '../utils/logger';

/** Account management only: admins never read other users' content here. */
const router = Router();
router.use(authenticate, requireAdmin);

const DAY = 24 * 60 * 60 * 1000;

router.get(
  '/users',
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const [users, posts] = await Promise.all([
      prisma.user.findMany({
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, email: true, name: true, role: true, isActive: true, mustChangePassword: true, lastLoginAt: true, createdAt: true,
          _count: { select: { pages: { where: { isActive: true } } } },
        },
      }),
      prisma.post.groupBy({ by: ['userId'], where: { createdAt: { gte: new Date(Date.now() - 30 * DAY) } }, _count: { _all: true } }),
    ]);
    const posts30d = new Map(posts.map((p) => [p.userId, p._count._all]));
    res.json({
      success: true,
      data: users.map(({ _count, ...u }) => ({ ...u, pages: _count.pages, posts30d: posts30d.get(u.id) ?? 0 })),
    });
  })
);

router.post(
  '/users',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = z
      .object({ email: z.string().email('Email không hợp lệ.'), name: z.string().trim().min(1).max(100), role: z.enum(['ADMIN', 'USER']).default('USER') })
      .parse({ ...req.body, email: typeof req.body?.email === 'string' ? normalizeEmail(req.body.email) : req.body?.email });

    if (await prisma.user.findUnique({ where: { email: body.email } })) throw createError(409, 'Email này đã có tài khoản.');

    const tempPassword = generateTempPassword();
    const user = await prisma.user.create({
      data: { email: body.email, name: body.name, role: body.role, plan: 'ENTERPRISE', mustChangePassword: true, passwordHash: await hashPassword(tempPassword) },
      select: { id: true, email: true, name: true, role: true, isActive: true, mustChangePassword: true, createdAt: true },
    });
    logger.info('User created by admin', { adminId: req.user!.id, userId: user.id });
    res.status(201).json({ success: true, data: { user, tempPassword } });
  })
);

router.patch(
  '/users/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const change = z.object({ isActive: z.boolean().optional(), role: z.enum(['ADMIN', 'USER']).optional() }).parse(req.body);
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw createError(404, 'Không tìm thấy người dùng.');

    const otherActiveAdmins = await prisma.user.count({ where: { role: 'ADMIN', isActive: true, NOT: { id: target.id } } });
    const blocked = accountChangeBlock({ actorId: req.user!.id, target, change, otherActiveAdmins });
    if (blocked) throw createError(409, blocked);

    const endsSessions = change.isActive === false || (change.role !== undefined && change.role !== target.role);
    const updated = await prisma.user.update({
      where: { id: target.id },
      data: { ...change, ...(endsSessions && { tokenVersion: { increment: 1 } }) },
      select: { id: true, email: true, name: true, role: true, isActive: true, mustChangePassword: true },
    });
    logger.info('User updated by admin', { adminId: req.user!.id, userId: target.id, change });
    res.json({ success: true, data: updated });
  })
);

router.post(
  '/users/:id/reset-password',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw createError(404, 'Không tìm thấy người dùng.');
    const tempPassword = generateTempPassword();
    await prisma.user.update({
      where: { id: target.id },
      data: { passwordHash: await hashPassword(tempPassword), mustChangePassword: true, tokenVersion: { increment: 1 } },
    });
    logger.info('Password reset by admin', { adminId: req.user!.id, userId: target.id });
    res.json({ success: true, data: { tempPassword } });
  })
);

export default router;
```

`src/app.ts` — thêm `import adminRoutes from './routes/admin.routes';` và dòng `['/api/admin', adminRoutes],` ngay sau `['/api/auth', authRoutes],` trong `API_ROUTERS`.

`src/services/scheduler.service.ts`:
- Trong `runPublishJob`, ngay sau `if (post.userId !== userId) throw new UnrecoverableJobError('Unauthorized');` thêm:

```ts
    if (!(await isAccountActive(userId))) throw new UnrecoverableJobError('Tài khoản đã bị khoá, không đăng bài.');
```
- Trong `runTargetJob`, trong `try {` ngay trước dòng `const current = await getSettings(userId);` thêm cùng dòng trên.
- Thêm hàm (cạnh `logStep` ở cuối file):

```ts
async function isAccountActive(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { isActive: true } });
  return !!user?.isActive;
}
```

- [ ] **Step 4: Chạy test**

Run: `npx tsc --noEmit && npx vitest run tests/admin-guards.test.ts && RUN_DB_TESTS=1 npx vitest run tests/admin.db.test.ts tests/multi-page.db.test.ts`
Expected: PASS (admin-guards 3, admin 5, multi-page 6).

- [ ] **Step 5: Commit**

```bash
git add src/lib/admin-guards.ts src/routes/admin.routes.ts src/app.ts src/services/scheduler.service.ts tests/admin-guards.test.ts tests/admin.db.test.ts tests/multi-page.db.test.ts
git commit -m "feat(admin): user management API; locked accounts never publish"
```

---

### Task 9: Cấu hình — chỉ ADMIN được dùng key dự phòng từ `.env`

**Files:**
- Modify: `src/lib/settings.ts` (`getSettings`, thêm `ENV_BACKED`)
- Create: `tests/settings-fallback.db.test.ts`

**Interfaces:**
- Produces: `getSettings(userId)` — với user không phải ADMIN, `geminiApiKey`, `cfAccountId`, `cfApiToken`, `fbAppId`, `fbAppSecret` chưa lưu ⇒ `''`; các giá trị mặc định không lấy từ env (`geminiModel`, `systemPrompt`, `cfImageModel`, `cfSteps`, `fbGraphVersion`) vẫn áp dụng cho mọi user. `getPublicSettings` tự hưởng thay đổi (nguồn `'env'` chỉ còn ở ADMIN).

- [ ] **Step 1: Viết test** — `tests/settings-fallback.db.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { getPublicSettings, getSettings, saveSettings } from '../src/lib/settings';
import { cleanupTestUsers, createTestUser } from './helpers/users';

const saved = { ...process.env };

describe.skipIf(!process.env.RUN_DB_TESTS)('settings env fallback', () => {
  beforeAll(async () => {
    await cleanupTestUsers();
    process.env.GEMINI_API_KEY = 'AIzaEnvFallbackKeyForTests000000000000';
    process.env.FACEBOOK_APP_ID = '123456789';
  });
  afterAll(async () => {
    process.env.GEMINI_API_KEY = saved.GEMINI_API_KEY;
    process.env.FACEBOOK_APP_ID = saved.FACEBOOK_APP_ID;
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('regular users never borrow the server .env keys', async () => {
    const { user } = await createTestUser();
    const s = await getSettings(user.id);
    expect(s.geminiApiKey).toBe('');
    expect(s.fbAppId).toBe('');
    expect(s.geminiModel).toBe('gemini-2.5-flash'); // non-secret defaults still apply
    expect((await getPublicSettings(user.id)).geminiApiKey).toMatchObject({ source: 'none' });
  });

  it('their own saved keys work', async () => {
    const { user } = await createTestUser();
    await saveSettings(user.id, { geminiApiKey: 'AIzaUserOwnKey00000000000000000000000' });
    expect((await getSettings(user.id)).geminiApiKey).toBe('AIzaUserOwnKey00000000000000000000000');
  });

  it('ADMIN keeps the .env fallback (production stays as it is)', async () => {
    const { user } = await createTestUser({ role: 'ADMIN' });
    expect((await getSettings(user.id)).geminiApiKey).toBe('AIzaEnvFallbackKeyForTests000000000000');
    expect((await getPublicSettings(user.id)).geminiApiKey).toMatchObject({ source: 'env' });
  });
});
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `RUN_DB_TESTS=1 npx vitest run tests/settings-fallback.db.test.ts`
Expected: FAIL — user thường nhận key `.env`.

- [ ] **Step 3: Sửa `src/lib/settings.ts`**

Ngay dưới `const SETTING_KEYS = …` thêm:

```ts
/** Defaults read from the server .env — only the ADMIN account may fall back to them. */
const ENV_BACKED: ReadonlySet<SettingKey> = new Set(['geminiApiKey', 'cfAccountId', 'cfApiToken', 'fbAppId', 'fbAppSecret']);
```

Thay phần đầu `getSettings`:

```ts
export async function getSettings(userId: string): Promise<AppSettings> {
  const [raw, user] = await Promise.all([
    loadRaw(userId),
    prisma.user.findUnique({ where: { id: userId }, select: { role: true } }),
  ]);
  const envFallback = user?.role === 'ADMIN';
  const value = (key: SettingKey): string => {
    const stored = raw.get(key);
    if (stored === undefined || stored === '') return envFallback || !ENV_BACKED.has(key) ? DEFAULTS[key]() : '';
    return isSecret(key) ? decrypt(stored) : stored;
  };
```
(phần `return { … }` giữ nguyên).

- [ ] **Step 4: Chạy test**

Run: `npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run tests/settings-fallback.db.test.ts tests/page-sync.db.test.ts`
Expected: PASS. (Nếu `page-sync.db.test.ts` dùng `prisma.user.findFirst()` là admin local ⇒ vẫn có fallback, không đổi.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/settings.ts tests/settings-fallback.db.test.ts
git commit -m "feat(settings): only the admin account falls back to .env keys"
```

---

### Task 10: Bịt lỗ tách dữ liệu + bộ test mọi route

**Files:**
- Modify: `src/routes/images.routes.ts`, `src/routes/posts.routes.ts` (`/:id/improve`), `src/routes/settings.routes.ts` (`/test/:group`)
- Create: `tests/isolation.db.test.ts`

**Interfaces:**
- Consumes: `API_ROUTERS` (Task 1), `createTestUser` (Task 5), `api` (Task 1).
- Produces: bảng `ROUTE_CASES` bao phủ mọi `METHOD /api/...` của `API_ROUTERS`.

- [ ] **Step 1: Viết test** — `tests/isolation.db.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp, API_ROUTERS } from '../src/app';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

/** Every route as "METHOD /api/mount/path" (array paths expanded). */
function listApiRoutes(): string[] {
  const out: string[] = [];
  for (const [mount, router] of API_ROUTERS) {
    for (const layer of (router as unknown as { stack: Array<{ route?: { path: string | string[]; methods: Record<string, boolean> } }> }).stack) {
      if (!layer.route) continue;
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const method of Object.keys(layer.route.methods)) {
        for (const p of paths) out.push(`${method.toUpperCase()} ${mount}${p === '/' ? '' : p}`);
      }
    }
  }
  return out.sort();
}

type Ids = { postId: string; pageId: string; targetId: string; scheduleId: string; templateId: string };
type Case =
  | { kind: 'foreign-id'; path: (b: Ids) => string; body?: unknown } // must 404
  | { kind: 'list'; path: string } // must not contain B's markers
  | { kind: 'own-scope'; path: string; body?: unknown; why: string } // no foreign id possible; must not touch B
  | { kind: 'admin-only' } // covered by admin.db.test.ts
  | { kind: 'public'; why: string };

const ROUTE_CASES: Record<string, Case> = {
  'POST /api/auth/login': { kind: 'public', why: 'đăng nhập' },
  'POST /api/auth/logout': { kind: 'public', why: 'chỉ xoá cookie' },
  'GET /api/auth/me': { kind: 'list', path: '/api/auth/me' },
  'POST /api/auth/change-password': { kind: 'own-scope', path: '/api/auth/change-password', body: { currentPassword: 'x', newPassword: 'y' }, why: 'chỉ tài khoản đang đăng nhập' },
  'POST /api/auth/api-keys': { kind: 'own-scope', path: '/api/auth/api-keys', body: { name: 'iso' }, why: 'gắn req.user.id' },
  'GET /api/admin/users': { kind: 'admin-only' },
  'POST /api/admin/users': { kind: 'admin-only' },
  'PATCH /api/admin/users/:id': { kind: 'admin-only' },
  'POST /api/admin/users/:id/reset-password': { kind: 'admin-only' },
  'GET /api/pages': { kind: 'list', path: '/api/pages' },
  'POST /api/pages/sync/preview': { kind: 'own-scope', path: '/api/pages/sync/preview', body: { userToken: 'EAAinvalidinvalidinvalidinvalid' }, why: 'token của chính user; không nhận id' },
  'POST /api/pages/sync/apply': { kind: 'own-scope', path: '/api/pages/sync/apply', body: { refs: [], disconnect: [] }, why: 'ref gắn userId; disconnect lọc userId (kiểm tra B còn active)' },
  'POST /api/pages/check': { kind: 'own-scope', path: '/api/pages/check', why: 'chỉ Page của user' },
  'POST /api/pages/:id/check': { kind: 'foreign-id', path: (b) => `/api/pages/${b.pageId}/check` },
  'POST /api/pages/connect': { kind: 'own-scope', path: '/api/pages/connect', body: { pages: [] }, why: 'upsert theo (userId, pageId)' },
  'DELETE /api/pages/:id': { kind: 'foreign-id', path: (b) => `/api/pages/${b.pageId}` },
  'POST /api/pages/:id/refresh-token': { kind: 'foreign-id', path: (b) => `/api/pages/${b.pageId}/refresh-token`, body: { accessToken: 'EAAx' } },
  'GET /api/templates': { kind: 'list', path: '/api/templates' },
  'GET /api/templates/:id': { kind: 'foreign-id', path: (b) => `/api/templates/${b.templateId}` },
  'POST /api/templates': { kind: 'own-scope', path: '/api/templates', body: { name: 'iso', promptTemplate: 'viết một bài ngắn' }, why: 'gắn req.user.id' },
  'PUT /api/templates/:id': { kind: 'foreign-id', path: (b) => `/api/templates/${b.templateId}`, body: { name: 'hack' } },
  'DELETE /api/templates/:id': { kind: 'foreign-id', path: (b) => `/api/templates/${b.templateId}` },
  'GET /api/posts': { kind: 'list', path: '/api/posts' },
  'GET /api/posts/:id': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}` },
  'POST /api/posts': { kind: 'foreign-id', path: () => '/api/posts', body: undefined }, // body set in test (B's pageIds)
  'PATCH /api/posts/:id': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}`, body: { caption: 'hack' } },
  'POST /api/posts/:id/generate': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/generate`, body: {} },
  'POST /api/posts/:id/preview-image': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/preview-image`, body: {} },
  'POST /api/posts/:id/image/generate': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/image/generate`, body: {} },
  'POST /api/posts/:id/image/upload': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/image/upload`, body: {} },
  'DELETE /api/posts/:id/image': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/image` },
  'POST /api/posts/:id/improve': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/improve`, body: { instruction: 'ngắn hơn' } },
  'POST /api/posts/:id/publish': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/publish`, body: {} },
  'POST /api/posts/:id/targets/:targetId/retry': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/targets/${b.targetId}/retry` },
  'DELETE /api/posts/:id': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}` },
  'GET /api/schedules': { kind: 'list', path: '/api/schedules' },
  'POST /api/schedules': { kind: 'foreign-id', path: () => '/api/schedules', body: undefined }, // body set in test (B's pageId)
  'PUT /api/schedules/:id': { kind: 'foreign-id', path: (b) => `/api/schedules/${b.scheduleId}`, body: {} },
  'PATCH /api/schedules/:id/toggle': { kind: 'foreign-id', path: (b) => `/api/schedules/${b.scheduleId}/toggle` },
  'DELETE /api/schedules/:id': { kind: 'foreign-id', path: (b) => `/api/schedules/${b.scheduleId}` },
  'GET /api/analytics/overview': { kind: 'list', path: '/api/analytics/overview' },
  'GET /api/analytics/posts-timeline': { kind: 'list', path: '/api/analytics/posts-timeline' },
  'GET /api/analytics/pages-performance': { kind: 'list', path: '/api/analytics/pages-performance' },
  'GET /api/settings': { kind: 'list', path: '/api/settings' },
  'POST /api/settings': { kind: 'own-scope', path: '/api/settings', body: { geminiModel: 'gemini-2.5-flash' }, why: 'ghi settings của req.user' },
  'POST /api/settings/test/:group': { kind: 'foreign-id', path: () => '/api/settings/test/facebook', body: undefined }, // body set in test (B's pageId)
  'POST /api/settings/facebook/exchange-token': { kind: 'own-scope', path: '/api/settings/facebook/exchange-token', body: { shortToken: 'EAAinvalidinvalidinvalidinvalid' }, why: 'token của chính user' },
  'POST /api/settings/facebook/pages': { kind: 'own-scope', path: '/api/settings/facebook/pages', body: { refs: ['bad'] }, why: 'ref do server mã hoá' },
  'POST /api/settings/facebook/pages/manual': { kind: 'own-scope', path: '/api/settings/facebook/pages/manual', body: { pageId: '1', pageAccessToken: 'EAAinvalidinvalidinvalid' }, why: 'upsert theo (userId, pageId)' },
  'GET /api/images/:postId': { kind: 'foreign-id', path: (b) => `/api/images/${b.postId}` },
};

const B_MARK = 'ISO_B_SECRET_MARK';
let server: Awaited<ReturnType<typeof startTestServer>>;
let aCookie: string;
let b: Ids;

describe.skipIf(!process.env.RUN_DB_TESTS)('data isolation between users', { timeout: 120_000 }, () => {
  // The server runs in this process: never let a route reach the real Graph API with fake tokens
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
      String(input instanceof Request ? input.url : input).includes('graph.facebook.com')
        ? Promise.resolve(new Response(JSON.stringify({ error: { message: 'blocked in test', code: 190 } }), { status: 400 }))
        : realFetch(input, init)
    );
  });

  beforeAll(async () => {
    await cleanupTestUsers();
    server = await startTestServer(createApp());
    aCookie = (await createTestUser({ name: 'User A' })).cookie;
    const { user: userB } = await createTestUser({ name: 'User B' });
    const page = await prisma.facebookPage.create({ data: { userId: userB.id, pageId: 'ISO_B_PAGE', pageName: `${B_MARK} Page`, pageAccessToken: 'EAAisolationfaketokenxxxxxxxxxxxx' } });
    const post = await prisma.post.create({
      data: { userId: userB.id, pageId: page.id, caption: `${B_MARK} caption`, status: 'FAILED', imagePath: 'storage/images/none.jpg', targets: { create: [{ pageId: page.id, status: 'FAILED' }] } },
      include: { targets: true },
    });
    const schedule = await prisma.postSchedule.create({ data: { userId: userB.id, pageId: page.id, name: `${B_MARK} lịch`, frequency: 'DAILY', startDate: new Date(Date.now() + 86_400_000) } });
    const template = await prisma.contentTemplate.create({ data: { userId: userB.id, name: `${B_MARK} mẫu`, promptTemplate: 'mẫu của B' } });
    b = { postId: post.id, pageId: page.id, targetId: post.targets[0].id, scheduleId: schedule.id, templateId: template.id };
  });

  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('every API route is declared in ROUTE_CASES (new routes must be added)', () => {
    expect(listApiRoutes()).toEqual(Object.keys(ROUTE_CASES).sort());
  });

  it("user A gets 404 on every route that takes user B's ids", async () => {
    const bodies: Record<string, unknown> = {
      'POST /api/posts': { pageIds: [b.pageId], inputData: { basicInfo: 'x' } },
      'POST /api/schedules': { pageId: b.pageId, name: 'x', frequency: 'DAILY', startDate: new Date(Date.now() + 86_400_000).toISOString() },
      'POST /api/settings/test/:group': { pageId: b.pageId },
    };
    const failures: string[] = [];
    for (const [route, c] of Object.entries(ROUTE_CASES)) {
      if (c.kind !== 'foreign-id') continue;
      const method = route.split(' ')[0];
      const res = await api(server.baseUrl, method, c.path(b), { cookie: aCookie, body: bodies[route] ?? c.body });
      if (res.status !== 404) failures.push(`${route} → ${res.status} ${res.text.slice(0, 120)}`);
    }
    expect(failures).toEqual([]);
  });

  it("lists and own-scope routes never show or change user B's data", async () => {
    const leaks: string[] = [];
    for (const [route, c] of Object.entries(ROUTE_CASES)) {
      if (c.kind !== 'list' && c.kind !== 'own-scope') continue;
      const method = route.split(' ')[0];
      const res = await api(server.baseUrl, method, c.path, { cookie: aCookie, body: c.kind === 'own-scope' ? c.body : undefined });
      if (res.text.includes(B_MARK) || res.text.includes(b.postId) || res.text.includes(b.pageId)) leaks.push(route);
    }
    expect(leaks).toEqual([]);
  });

  it("user B's data is intact after all of A's attempts", async () => {
    expect(await prisma.post.findUnique({ where: { id: b.postId } })).toMatchObject({ caption: `${B_MARK} caption` });
    expect(await prisma.facebookPage.findUnique({ where: { id: b.pageId } })).toMatchObject({ isActive: true });
    expect(await prisma.postSchedule.findUnique({ where: { id: b.scheduleId } })).not.toBeNull();
    expect(await prisma.contentTemplate.findUnique({ where: { id: b.templateId } })).toMatchObject({ name: `${B_MARK} mẫu` });
  });
});
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `RUN_DB_TESTS=1 npx vitest run tests/isolation.db.test.ts`
Expected: FAIL ở test 404 — ít nhất: `GET /api/images/:postId` (chưa đăng nhập vẫn qua, trả ảnh/404 khác lý do tuỳ file — cần **yêu cầu đăng nhập + chủ bài**), `POST /api/posts/:id/improve → 400`, `POST /api/settings/test/:group → 200`. Ghi lại danh sách thực tế trong output và sửa đúng những route đó ở Step 3.

- [ ] **Step 3: Sửa các route**

`src/routes/images.routes.ts` — thay phần router:

```ts
import { Router, Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { readImage } from '../lib/image-store';

/**
 * Post images from storage/images (not public): the session cookie travels with
 * <img> requests, so only the post's owner can load it. URLs carry ?v=<version>.
 */
const router = Router();
router.use(authenticate);

router.get(
  '/:postId',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await prisma.post.findFirst({ where: { id: req.params.postId, userId: req.user!.id }, select: { imagePath: true } });
    if (!post?.imagePath) throw createError(404, 'Image not found');

    const image = await readImage(post.imagePath);
    if (!image) throw createError(404, 'Image not found');

    res.setHeader('Content-Type', image.mime);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(image.buffer);
  })
);

export default router;
```

`src/routes/posts.routes.ts` — trong `/:id/improve`, thay dòng `if (!post || !source) throw createError(400, 'Post has no caption to improve');` bằng:

```ts
    if (!post) throw createError(404, 'Post not found');
    if (!source) throw createError(400, 'Post has no caption to improve');
```

`src/routes/settings.routes.ts` — trong handler `'/test/:group'`, dòng đầu tiên của `asyncHandler(async (req, res) => {` thêm:

```ts
    const pageId = typeof req.body?.pageId === 'string' ? req.body.pageId : undefined;
    if (pageId && !(await prisma.facebookPage.findFirst({ where: { id: pageId, userId: req.user!.id }, select: { id: true } }))) {
      throw createError(404, 'Page not found');
    }
```

Chạy lại test; nếu còn route nào ≠ 404, sửa theo cùng mẫu (thêm `userId: req.user!.id` vào `findFirst` và `throw createError(404, …)` trước mọi xử lý khác) cho đến khi danh sách `failures` rỗng.

- [ ] **Step 4: Chạy test**

Run: `npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run tests/isolation.db.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/routes/images.routes.ts src/routes/posts.routes.ts src/routes/settings.routes.ts tests/isolation.db.test.ts
git commit -m "fix(security): 404 on other users' ids everywhere; images need the owner's session"
```

---

### Task 11: Client — API bằng cookie, `AuthProvider`, `ProtectedRoute`

**Files:**
- Modify: `client/src/api.ts:15-80` (phần token + `apiFetch` + `authApi`), `client/src/api.ts` (`postsApi.uploadImage`), `client/src/App.tsx`, `client/src/main.tsx`
- Create: `client/src/auth.tsx`

**Interfaces:**
- Produces: `AUTH_EVENT = 'autopost:auth'` (window `CustomEvent<{ code: string }>`); `ApiError extends Error { status: number; code?: string }`; `authApi.login(email, password)`, `authApi.logout()`, `authApi.me()`, `authApi.changePassword(currentPassword, newPassword)` ⇒ `PublicUser = { id; email; name; role: 'ADMIN' | 'USER'; mustChangePassword: boolean }`; `adminApi.listUsers()`, `adminApi.createUser({ email, name, role })`, `adminApi.updateUser(id, { isActive?, role? })`, `adminApi.resetPassword(id)`; `AuthProvider`; `useAuth(): { user: PublicUser | null; loading: boolean; setUser(u): void; refresh(): Promise<void>; logout(): Promise<void> }`; `ProtectedRoute({ children, adminOnly? })`.

- [ ] **Step 1: Sửa `client/src/api.ts`** — thay từ `// ─── Auth Token Management` tới hết `export const authApi = { … };` bằng:

```ts
// ─── Fetch Wrapper ──────────────────────────────
// Session = httpOnly cookie set by the API (JS never sees it). Every call sends it
// (credentials) and the CSRF header the API requires on non-GET requests.

export const AUTH_EVENT = 'autopost:auth';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiFetch<T = any>(
  endpoint: string,
  options: RequestInit = {}
): Promise<{ success: boolean; data: T; error?: string; pagination?: any; meta?: any }> {
  const headers: Record<string, string> = {
    'X-Requested-With': 'autopost',
    ...(!(options.body instanceof FormData) && { 'Content-Type': 'application/json' }),
    ...(options.headers as Record<string, string>),
  };

  const response = await fetch(`${API_BASE}${endpoint}`, { ...options, headers, credentials: 'include' });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const code: string | undefined = data.code;
    if (code === 'UNAUTHENTICATED' || code === 'MUST_CHANGE_PASSWORD') {
      window.dispatchEvent(new CustomEvent(AUTH_EVENT, { detail: { code } }));
    }
    throw new ApiError(data.error || 'Request failed', response.status, code);
  }
  return data;
}

// ─── Auth API ───────────────────────────────────

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'USER';
  mustChangePassword: boolean;
}

export const authApi = {
  login: (email: string, password: string) =>
    apiFetch<PublicUser>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => apiFetch('/auth/logout', { method: 'POST' }),
  me: () => apiFetch<PublicUser>('/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    apiFetch<PublicUser>('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
};

// ─── Admin API ──────────────────────────────────

export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'USER';
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  pages: number;
  posts30d: number;
}

export const adminApi = {
  listUsers: () => apiFetch<AdminUserRow[]>('/admin/users'),
  createUser: (body: { email: string; name: string; role: 'ADMIN' | 'USER' }) =>
    apiFetch<{ user: Pick<AdminUserRow, 'id' | 'email' | 'name' | 'role' | 'isActive' | 'mustChangePassword' | 'createdAt'>; tempPassword: string }>('/admin/users', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateUser: (id: string, body: { isActive?: boolean; role?: 'ADMIN' | 'USER' }) =>
    apiFetch<Pick<AdminUserRow, 'id' | 'email' | 'name' | 'role' | 'isActive' | 'mustChangePassword'>>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  resetPassword: (id: string) => apiFetch<{ tempPassword: string }>(`/admin/users/${id}/reset-password`, { method: 'POST' }),
};
```

Trong `postsApi.uploadImage`, thay:

```ts
    const response = await fetch(`${API_BASE}/posts/${id}/image/upload`, { method: 'POST', body });
```
bằng:
```ts
    const response = await fetch(`${API_BASE}/posts/${id}/image/upload`, {
      method: 'POST',
      body,
      credentials: 'include',
      headers: { 'X-Requested-With': 'autopost' },
    });
```

- [ ] **Step 2: Tạo `client/src/auth.tsx`**

```tsx
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { AUTH_EVENT, authApi, type PublicUser } from './api';

interface AuthState {
  user: PublicUser | null;
  loading: boolean;
  setUser: (user: PublicUser | null) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setUser((await authApi.me()).data);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout().catch(() => undefined);
    setUser(null);
  }, []);

  useEffect(() => {
    void refresh();
    // Any API call that finds the session gone (or a password to change) updates the state
    const onAuth = (e: Event) => {
      const code = (e as CustomEvent<{ code: string }>).detail?.code;
      if (code === 'UNAUTHENTICATED') setUser(null);
      else void refresh();
    };
    window.addEventListener(AUTH_EVENT, onAuth);
    return () => window.removeEventListener(AUTH_EVENT, onAuth);
  }, [refresh]);

  return <AuthContext.Provider value={{ user, loading, setUser, refresh, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

export function ProtectedRoute({ children, adminOnly = false }: { children: ReactNode; adminOnly?: boolean }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <div className="loading-page"><div className="spinner spinner-lg" /></div>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (user.mustChangePassword && location.pathname !== '/change-password') return <Navigate to="/change-password" replace />;
  if (adminOnly && user.role !== 'ADMIN') return <Navigate to="/" replace />;
  return <>{children}</>;
}
```

- [ ] **Step 3: Sửa `client/src/App.tsx` và `client/src/main.tsx`**

`App.tsx`: xoá hàm `ProtectedRoute` cục bộ; thêm `import { ProtectedRoute } from './auth';`, `import ChangePasswordPage from './pages/ChangePasswordPage';`, `import UsersPage from './pages/UsersPage';`. Thêm hai route (trước `path="*"`):

```tsx
        <Route
          path="/change-password"
          element={
            <ProtectedRoute>
              <ChangePasswordPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/users"
          element={
            <ProtectedRoute adminOnly>
              <AppLayout>
                <UsersPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
```

`main.tsx`: bọc `<App />` trong `<AuthProvider>` (import từ `./auth`), bên trong `ToastProvider`. Vì `ProtectedRoute` dùng `useLocation`, `AuthProvider` không cần nằm trong Router; `BrowserRouter` vẫn ở `App.tsx`.

Tạo tạm `client/src/pages/ChangePasswordPage.tsx` và `client/src/pages/UsersPage.tsx` với `export default function X() { return null; }` để build được (nội dung thật ở Task 12–13).

- [ ] **Step 4: Kiểm tra build**

Run: `cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b`
Expected: không lỗi. Nếu báo `getStoredUser`/`setToken`/`setStoredUser` không tồn tại (LoginPage, Sidebar): tạm đổi `Sidebar` dùng `const { user } = useAuth();` (import `useAuth` từ `../auth`) và để `LoginPage.tsx` = `export default function LoginPage() { return null; }` — viết thật ở Task 12–13.

- [ ] **Step 5: Commit**

```bash
git add client/src/api.ts client/src/auth.tsx client/src/App.tsx client/src/main.tsx client/src/pages/ChangePasswordPage.tsx client/src/pages/UsersPage.tsx client/src/pages/LoginPage.tsx client/src/components/Sidebar.tsx
git commit -m "feat(client): cookie session, AuthProvider and protected routes"
```

---

### Task 12: Trang Đăng nhập & Đổi mật khẩu

**Files:**
- Modify: `client/src/pages/LoginPage.tsx` (viết lại), `client/src/pages/ChangePasswordPage.tsx` (viết thật), `client/src/index.css` (thêm cuối file)

**Interfaces:**
- Consumes: `authApi`, `ApiError` (Task 11); `useAuth` (Task 11); `useToast` (`client/src/components/Toast`).

- [ ] **Step 1: Viết `LoginPage.tsx`**

```tsx
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { LogIn } from 'lucide-react';
import { authApi, ApiError } from '../api';
import { useAuth } from '../auth';

/** Where to go after login: only same-app paths (no open redirect). */
const safeNext = (next: string | null) => (next && next.startsWith('/') && !next.startsWith('//') ? next : '/');

export default function LoginPage() {
  const { user, loading, setUser } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loading && user) return <Navigate to={user.mustChangePassword ? '/change-password' : safeNext(params.get('next'))} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await authApi.login(email, password);
      setUser(res.data);
      navigate(res.data.mustChangePassword ? '/change-password' : safeNext(params.get('next')), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Không kết nối được máy chủ. Thử lại sau.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <form className="auth-card" onSubmit={submit} aria-labelledby="login-title">
        <div className="auth-brand">
          <div className="logo-mark" aria-hidden="true" />
          <div>
            <h1 id="login-title">Đăng nhập Auto Post</h1>
            <p>Tài khoản do quản trị viên cấp.</p>
          </div>
        </div>
        <label className="form-label" htmlFor="login-email">Email</label>
        <input id="login-email" className="form-input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <label className="form-label" htmlFor="login-password">Mật khẩu</label>
        <input id="login-password" className="form-input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
          {busy ? <div className="spinner" /> : <LogIn size={16} aria-hidden="true" />} Đăng nhập
        </button>
        <p className="field-hint" style={{ textAlign: 'center' }}>Quên mật khẩu? Nhờ quản trị viên đặt lại.</p>
      </form>
    </main>
  );
}
```

- [ ] **Step 2: Viết `ChangePasswordPage.tsx`**

```tsx
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound } from 'lucide-react';
import { authApi, ApiError } from '../api';
import { useAuth } from '../auth';

export default function ChangePasswordPage() {
  const { user, setUser, logout } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = confirm.length > 0 && confirm !== next;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next.length < 10) return setError('Mật khẩu mới cần ít nhất 10 ký tự.');
    if (next !== confirm) return setError('Hai lần nhập mật khẩu mới chưa khớp.');
    setBusy(true);
    setError(null);
    try {
      const res = await authApi.changePassword(current, next);
      setUser(res.data);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Không kết nối được máy chủ. Thử lại sau.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <form className="auth-card" onSubmit={submit} aria-labelledby="cp-title">
        <div className="auth-brand">
          <div className="logo-mark" aria-hidden="true" />
          <div>
            <h1 id="cp-title">Đổi mật khẩu</h1>
            <p>{user?.mustChangePassword ? 'Bạn đang dùng mật khẩu tạm. Đặt mật khẩu riêng để tiếp tục.' : user?.email}</p>
          </div>
        </div>
        <label className="form-label" htmlFor="cp-current">{user?.mustChangePassword ? 'Mật khẩu tạm' : 'Mật khẩu hiện tại'}</label>
        <input id="cp-current" className="form-input" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        <label className="form-label" htmlFor="cp-new">Mật khẩu mới (ít nhất 10 ký tự)</label>
        <input id="cp-new" className="form-input" type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} />
        <label className="form-label" htmlFor="cp-confirm">Nhập lại mật khẩu mới</label>
        <input id="cp-confirm" className={`form-input ${mismatch ? 'input-warn' : ''}`} type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy || mismatch}>
          {busy ? <div className="spinner" /> : <KeyRound size={16} aria-hidden="true" />} Lưu mật khẩu mới
        </button>
        <button type="button" className="link-btn" style={{ alignSelf: 'center' }} onClick={() => void logout()}>Đăng xuất</button>
      </form>
    </main>
  );
}
```

- [ ] **Step 3: CSS** — thêm cuối `client/src/index.css`:

```css
/* ─── Auth screens ─────────────────────────── */
.auth-screen { min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background:
  radial-gradient(1200px 500px at 15% -10%, var(--primary-100), transparent 60%), var(--bg-primary); }
.auth-card { width: 100%; max-width: 400px; display: flex; flex-direction: column; gap: 10px; padding: 28px; background: var(--bg-card);
  border: 1px solid var(--border-default); border-radius: var(--radius-xl); box-shadow: var(--shadow-lg); animation: auth-in var(--transition-slow) both; }
.auth-brand { display: flex; gap: 12px; align-items: center; margin-bottom: 8px; }
.auth-brand h1 { font-size: 20px; margin: 0; text-wrap: balance; }
.auth-brand p { margin: 2px 0 0; color: var(--text-tertiary); font-size: 13px; }
.auth-card .form-label { margin: 6px 0 0; }
.auth-card .btn-block { margin-top: 10px; }
.auth-error { margin: 4px 0 0; padding: 8px 12px; border-radius: var(--radius-sm); background: var(--error-bg); color: var(--error-500); font-size: 13px; }
@keyframes auth-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .auth-card { animation: none; } }
```

- [ ] **Step 4: Build + xem thực tế**

Run: `cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b`
Rồi chạy thử (ghi PID để tắt hẳn sau đó):
```bash
cd .. && (npx tsx src/server.ts > /tmp/api-m1.log 2>&1 &) ; (cd client && npx -y -p node@22 -- node node_modules/vite/bin/vite.js --port 5173 --strictPort > /tmp/vite-m1.log 2>&1 &) ; sleep 14
```
Mở `http://localhost:5173/` bằng Playwright: phải chuyển tới `/login?next=%2F`; chụp màn hình `.playwright-mcp/m1-login.png`. Đăng nhập bằng một tài khoản test tạo qua `prisma` với `mustChangePassword=true` ⇒ phải tới `/change-password`; chụp `.playwright-mcp/m1-change-password.png`. Tắt server: `for p in $(netstat -ano | grep -E ":(3000|5173) .*LISTENING" | awk '{print $NF}' | sort -u); do taskkill //PID $p //T //F; done`.
Expected: 2 màn hình hiển thị đúng, không lỗi console.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/LoginPage.tsx client/src/pages/ChangePasswordPage.tsx client/src/index.css
git commit -m "feat(client): login and change-password screens"
```

---

### Task 13: Sidebar (người dùng, đăng xuất) & trang Người dùng

**Files:**
- Modify: `client/src/components/Sidebar.tsx` (khối `user-profile`, nhóm "Hệ thống"), `client/src/index.css`
- Modify: `client/src/pages/UsersPage.tsx` (viết thật)

**Interfaces:**
- Consumes: `useAuth` (Task 11); `adminApi`, `AdminUserRow` (Task 11); `useToast`; `formatWhen` từ `client/src/components/PostBits`.

- [ ] **Step 1: Sidebar** — import `LogOut, Users` từ `lucide-react`, `useAuth` từ `../auth`, `useNavigate`; xoá `getStoredUser`. Trong component: `const { user, logout } = useAuth(); const navigate = useNavigate();`. Sau `NavLink` "Cài đặt" thêm:

```tsx
          {user?.role === 'ADMIN' && (
            <NavLink to="/admin/users" className={navClass}>
              <Users className="nav-icon" strokeWidth={1.8} />
              <span className="nav-label">Người dùng</span>
            </NavLink>
          )}
```

Thay khối `<div className="user-profile">…</div>` bằng:

```tsx
        <div className="user-profile">
          <span className="avatar ink">{user?.name?.charAt(0)?.toUpperCase() || '?'}</span>
          <div className="user-info">
            <span className="user-name">{user?.name}</span>
            <span className="user-plan" title={user?.email}>{user?.role === 'ADMIN' ? 'Quản trị viên' : user?.email}</span>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Đăng xuất"
            title="Đăng xuất"
            onClick={async () => {
              await logout();
              navigate('/login', { replace: true });
            }}
          >
            <LogOut size={16} aria-hidden="true" />
          </button>
        </div>
```

CSS thêm cuối `index.css`:

```css
.user-profile .icon-btn { margin-left: auto; width: 32px; height: 32px; display: grid; place-items: center; border: none; border-radius: var(--radius-sm);
  background: transparent; color: var(--text-tertiary); cursor: pointer; transition: background var(--transition-fast), color var(--transition-fast); }
.user-profile .icon-btn:hover { background: var(--bg-glass-hover); color: var(--error-500); }
.user-profile .icon-btn:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
.user-profile .user-plan { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px; }
```

- [ ] **Step 2: `UsersPage.tsx`**

```tsx
import { useEffect, useState, type FormEvent } from 'react';
import { UserPlus, KeyRound, Lock, Unlock, Copy } from 'lucide-react';
import { adminApi, type AdminUserRow } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { formatWhen } from '../components/PostBits';

const statusOf = (u: AdminUserRow) =>
  !u.isActive ? { label: 'Bị khoá', cls: 'badge-failed' } : u.mustChangePassword ? { label: 'Chờ đổi mật khẩu', cls: 'badge-warn' } : { label: 'Hoạt động', cls: 'badge-published' };

export default function UsersPage() {
  const toast = useToast();
  const { user: me } = useAuth();
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ email: '', name: '', role: 'USER' as 'ADMIN' | 'USER' });
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  async function load() {
    try {
      setUsers((await adminApi.listUsers()).data);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy('create');
    try {
      const res = await adminApi.createUser(form);
      setSecret({ email: res.data.user.email, password: res.data.tempPassword });
      setForm({ email: '', name: '', role: 'USER' });
      await load();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function toggleActive(u: AdminUserRow) {
    if (u.isActive && confirmId !== u.id) return setConfirmId(u.id);
    setBusy(`lock:${u.id}`);
    try {
      await adminApi.updateUser(u.id, { isActive: !u.isActive });
      toast.success(u.isActive ? `Đã khoá ${u.email}. Mọi phiên của người này đã bị đăng xuất.` : `Đã mở khoá ${u.email}.`);
      setConfirmId(null);
      await load();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function reset(u: AdminUserRow) {
    setBusy(`reset:${u.id}`);
    try {
      const res = await adminApi.resetPassword(u.id);
      setSecret({ email: u.email, password: res.data.tempPassword });
      await load();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.password);
      toast.success('Đã copy mật khẩu tạm.');
    } catch {
      toast.info('Không copy được — hãy chọn và copy thủ công.');
    }
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-header" style={{ marginBottom: 0 }}>
        <h1>Người dùng</h1>
        <p>Tạo tài khoản, khoá/mở và đặt lại mật khẩu. Quản trị viên không xem được nội dung của người dùng khác.</p>
      </div>

      <form className="card users-create" onSubmit={create} aria-label="Tạo người dùng">
        <div className="field"><label className="form-label" htmlFor="nu-email">Email</label>
          <input id="nu-email" className="form-input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
        <div className="field"><label className="form-label" htmlFor="nu-name">Tên</label>
          <input id="nu-name" className="form-input" required maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div className="field"><label className="form-label" htmlFor="nu-role">Vai trò</label>
          <select id="nu-role" className="form-select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'ADMIN' | 'USER' })}>
            <option value="USER">Người dùng</option><option value="ADMIN">Quản trị viên</option>
          </select></div>
        <button type="submit" className="btn btn-primary" disabled={busy === 'create'}>
          {busy === 'create' ? <div className="spinner" /> : <UserPlus size={16} aria-hidden="true" />} Tạo tài khoản
        </button>
      </form>

      {secret && (
        <div className="secret-once" role="status">
          <div>
            <strong>Mật khẩu tạm cho {secret.email}</strong>
            <p className="field-hint" style={{ margin: 0 }}>Chỉ hiện một lần. Gửi cho người dùng; họ phải đổi mật khẩu khi đăng nhập lần đầu.</p>
          </div>
          <code className="secret-value">{secret.password}</code>
          <button type="button" className="btn btn-secondary btn-sm" onClick={copySecret}><Copy size={14} aria-hidden="true" /> Copy</button>
          <button type="button" className="link-btn" onClick={() => setSecret(null)}>Đã gửi, ẩn đi</button>
        </div>
      )}

      <section className="card flush" aria-label="Danh sách người dùng">
        <div className="table-wrap">
          <table className="page-table">
            <thead><tr><th scope="col">Người dùng</th><th scope="col">Vai trò</th><th scope="col">Trạng thái</th><th scope="col">Page</th><th scope="col">Bài 30 ngày</th><th scope="col">Đăng nhập cuối</th><th scope="col"><span className="sr-only">Thao tác</span></th></tr></thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24 }}><div className="spinner" /></td></tr>
              ) : users.map((u) => {
                const st = statusOf(u);
                const self = u.id === me?.id;
                return (
                  <tr key={u.id} className={u.isActive ? '' : 'blocked'}>
                    <td><div className="name">{u.name}{self && <span className="muted"> (bạn)</span>}</div><div className="muted" style={{ fontSize: 12 }}>{u.email}</div></td>
                    <td>{u.role === 'ADMIN' ? 'Quản trị viên' : 'Người dùng'}</td>
                    <td><span className={`badge ${st.cls}`}>{st.label}</span></td>
                    <td className="mono">{u.pages}</td>
                    <td className="mono">{u.posts30d}</td>
                    <td className="muted">{u.lastLoginAt ? formatWhen(u.lastLoginAt) : 'Chưa'}</td>
                    <td>
                      <div className="row-actions">
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => reset(u)} disabled={!!busy} title="Đặt lại mật khẩu">
                          {busy === `reset:${u.id}` ? <div className="spinner" /> : <KeyRound size={14} aria-hidden="true" />} Đặt lại
                        </button>
                        {!self && (
                          <button type="button" className={`btn btn-sm ${confirmId === u.id ? 'btn-danger' : 'btn-secondary'}`} onClick={() => toggleActive(u)} disabled={!!busy && confirmId !== u.id}>
                            {busy === `lock:${u.id}` ? <div className="spinner" /> : u.isActive ? <Lock size={14} aria-hidden="true" /> : <Unlock size={14} aria-hidden="true" />}
                            {u.isActive ? (confirmId === u.id ? 'Bấm lần nữa để khoá' : 'Khoá') : 'Mở khoá'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
```

CSS thêm cuối `index.css`:

```css
/* ─── Users (admin) ────────────────────────── */
.users-create { display: grid; grid-template-columns: 2fr 1.5fr 1fr auto; gap: 12px; align-items: end; padding: 16px 18px; }
@media (max-width: 860px) { .users-create { grid-template-columns: 1fr; } }
.users-create .field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.users-create .form-label { margin: 0; }
.secret-once { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 14px 16px; border-radius: var(--radius-md);
  background: var(--success-bg); border: 1px solid color-mix(in srgb, var(--success-500) 30%, transparent); animation: banner-in var(--transition-slow) both; }
.secret-once > div { flex: 1; min-width: 220px; }
.secret-value { font-family: var(--font-mono); font-size: 15px; padding: 6px 10px; border-radius: var(--radius-sm); background: var(--bg-card); border: 1px solid var(--border-default); user-select: all; }
```

- [ ] **Step 3: Build + xem thực tế**

Run: `cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b`, rồi chạy server + Vite như Task 12 Step 4. Đăng nhập bằng tài khoản ADMIN test ⇒ sidebar có "Người dùng"; mở `/admin/users`, tạo 1 user ⇒ hộp mật khẩu tạm hiện; chụp `.playwright-mcp/m1-users.png`. Đăng nhập bằng user thường ⇒ không có mục "Người dùng", truy cập `/admin/users` bị chuyển về `/`. Tắt hẳn server (lệnh `taskkill` ở Task 12). Xoá tài khoản test: `docker exec autopost_mariadb mariadb -uautopost -pautopost_secret autopost_db -e "DELETE FROM users WHERE email LIKE '%@autopost.test'"`.
Expected: đúng như mô tả, không lỗi console.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/Sidebar.tsx client/src/pages/UsersPage.tsx client/src/index.css
git commit -m "feat(client): sidebar sign-out and admin users page"
```

---

### Task 14: Hoàn tất M1 — schema SQL, cấu hình mẫu, kiểm tra toàn bộ

**Files:**
- Modify: `prisma/hostinger-schema.sql` (sinh lại), `.env.example`, `ROADMAP.md`

- [ ] **Step 1: Sinh lại SQL & thử import**

```bash
head -9 prisma/hostinger-schema.sql > prisma/.head.tmp
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/.body.tmp
cat prisma/.head.tmp prisma/.body.tmp > prisma/hostinger-schema.sql && rm prisma/.head.tmp prisma/.body.tmp
R="docker exec -i autopost_mariadb mariadb -uroot -pautopost_root"
$R -e "DROP DATABASE IF EXISTS sqltest; CREATE DATABASE sqltest CHARACTER SET utf8mb4;" && $R sqltest < prisma/hostinger-schema.sql && $R sqltest -e "SHOW COLUMNS FROM users LIKE 'role'" && $R -e "DROP DATABASE sqltest"
```
Expected: cột `role` có trong DB thử.

- [ ] **Step 2: `.env.example`** — sau khối `# Production only` thêm:

```
# First deploy with login (see docs): sets the admin account while it has no real password
# ADMIN_EMAIL=you@example.com
# ADMIN_PASSWORD=                  # ≥ 10 characters; remove from the host after the first login
```
và đổi dòng `JWT_SECRET=your-super-secret-jwt-key-change-in-production` thành `JWT_SECRET=                        # ≥ 32 random characters (required in production)`.

- [ ] **Step 3: ROADMAP** — thêm trước `## Phase 2 — Lịch đăng`:

```markdown
## Phase 1d — Nhiều người dùng & Lĩnh vực nội dung 🔄 (spec 2026-09-28)
Spec: `docs/superpowers/specs/2026-09-28-multi-user-domains-design.md`. Branch `feature/multi-user-domains`.
- ✅ M1 Đăng nhập (cookie), vai trò, quản lý người dùng, tách dữ liệu (test mọi route), key `.env` chỉ cho admin — plan `docs/superpowers/plans/2026-09-28-m1-multi-user-auth.md`
- ⬜ M2 Lĩnh vực & Định dạng (backend) · ⬜ M3 Giao diện Lĩnh vực/Tạo bài · ⬜ M4 Tài liệu & deploy
```

- [ ] **Step 4: Kiểm tra toàn bộ** (không có dev server đang chạy)

```bash
netstat -ano | grep -E ":(3000|5173) .*LISTENING" || echo "no dev servers"
npx tsc --noEmit
npx vitest run
RUN_DB_TESTS=1 npx vitest run
cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b && npx -y -p node@22 -- node node_modules/vite/bin/vite.js build
docker exec autopost_mariadb mariadb -uautopost -pautopost_secret autopost_db -e "SELECT COUNT(*) leftovers FROM users WHERE email LIKE '%@autopost.test'"
```
Expected: tất cả PASS (110 test cũ + test mới), build OK, `leftovers = 0`.

- [ ] **Step 5: Commit & dừng lại cho người dùng kiểm tra**

```bash
git branch --show-current
git add prisma/hostinger-schema.sql .env.example ROADMAP.md
git diff --cached | grep -E "^\+" | grep -cE "AIza[0-9A-Za-z_-]{20}|EAA[A-Za-z0-9]{25,}|P2026|u774510961_u_" || true
git commit -m "chore(m1): schema SQL, env example and roadmap for multi-user login"
```
Báo người dùng: M1 xong trên `feature/multi-user-domains` (chưa merge/deploy); cách thử local (tạo user bằng trang Người dùng); việc tiếp theo là viết plan M2–M4.

---

## Sau M1

Plan M2–M4 (lĩnh vực, định dạng, giao diện, tài liệu, deploy) sẽ viết thành `docs/superpowers/plans/<ngày>-m2-m4-content-domains.md` **sau khi M1 được duyệt**, dựa trên code thực tế sau M1 (các file `settings`, `posts.routes`, `CreatePostPage`, `Sidebar` đều bị M1 thay đổi).
