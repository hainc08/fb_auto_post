# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Auto Post: a small multi-user web app that writes Facebook Page posts with AI (Gemini text, Cloudflare Workers AI images) and publishes/schedules them to Pages. UI copy, API error messages and docs are in **Vietnamese**; code and comments are in English. `AGENTS.md` holds the original project rules; `ROADMAP.md` is the phase-by-phase status; designs and plans live in `docs/superpowers/specs/` and `docs/superpowers/plans/`.

## Commands

Backend (repo root, Node/Express/TypeScript, run with `tsx`):

```bash
docker compose up -d            # MariaDB on localhost:3310 (container autopost_mariadb)
npm run dev                     # API on :3000 (tsx watch src/server.ts) — also runs the job worker
npx tsc --noEmit                # typecheck
npx prisma db push --skip-generate && npx prisma generate   # apply schema.prisma to the local DB
npm test                        # unit tests (vitest run)
RUN_DB_TESTS=1 npx vitest run   # + DB integration tests (*.db.test.ts, need MariaDB)
npx vitest run tests/compose-prompt.test.ts -t "drops empty blocks"   # one file / one test
```

Client (`client/`, React 19 + Vite 8, needs **Node ≥ 22.12**; if the machine's Node is older, run through `npx -y -p node@22`):

```bash
cd client
npx -y -p node@22 -- node node_modules/vite/bin/vite.js --port 5173        # dev server, talks to API on :3000
npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b                # typecheck (there is no client test runner)
npx -y -p node@22 -- node node_modules/vite/bin/vite.js build               # production build → client/dist
npm run lint                                                                # oxlint
```

Deploy: Hostinger Node.js app builds from the generated **`deploy` branch** (`npm run build` = install + `prisma generate` + `tsc` + client build + `prisma db push`; entry `dist/server.js`). `main` is development only. Regenerate the branch with `npm run deploy:branch -- --push` (refuses to run while on `deploy`). Full guide: `docs/DEPLOY_HOSTINGER.md`. Empty-database schema for phpMyAdmin: `prisma/hostinger-schema.sql` (regenerate with `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`, keeping its header comment).

## Architecture

**One process.** `src/app.ts` `createApp()` builds the Express app (Basic Auth gate if `BASIC_AUTH_*` set, CORS with credentials, `/health`, `/cron/tick`, CSRF guard, every router in `API_ROUTERS`, then the built SPA from `client/dist`). `src/server.ts` runs `runBootstrap()` (`src/lib/bootstrap.ts`: refuse a weak `JWT_SECRET` in production, ensure an ADMIN exists via `ADMIN_EMAIL`/`ADMIN_PASSWORD`, migrate content domains), starts the job worker, then listens. Tests import `createApp()` and hit it over real HTTP (`tests/helpers/http.ts`).

**Job queue in MariaDB, no Redis.** `src/lib/job-queue.ts` stores jobs in the `jobs` table (`enqueue`, keyed `upsertKeyedJob`, `claimNextJob` with an UPDATE-lock, retries, `UnrecoverableJobError`, stale-job recovery). `src/services/scheduler.service.ts` registers the handlers:
- `publish_post` (`runPublishJob`): write text with AI if needed → generate/reuse the image → queue one `publish_target` per Page, staggered by `intervalMs`.
- `publish_target` (`runTargetJob`): publish to one Page (`post_targets` row), guarded so a Page never gets the post twice and never with a token from another Facebook App (`src/lib/page-health.ts` `blockReason`).
- `run_schedule` (keyed `schedule:<id>`): create a post from a `post_schedules` row, then reschedule itself (times in Vietnam time, `src/lib/schedule-time.ts`).
- `check_page_tokens`: daily Page token health check.

Hostinger may sleep the process, so an external cron calls `/cron/tick?key=CRON_SECRET`, which drains due jobs.

**Auth and data isolation.** Session = JWT `{ sub, tv }` in the httpOnly cookie `ap_session` (`src/lib/session.ts`); `authenticate` (`src/middleware/auth.middleware.ts`) reloads the user and rejects inactive users or a stale `tokenVersion` (bumped when an admin disables the account or changes its password/email/role). Non-GET `/api` requests must send `X-Requested-With: autopost`. Roles `ADMIN`/`USER`; admins manage members in `src/routes/admin.routes.ts` and never read members' content. **Every query filters by `req.user.id`, and ids that belong to another user return 404 — including ids sent in a request body** (`src/lib/ownership.ts`, `resolveDomainFormat`). `tests/isolation.db.test.ts` walks every route in `API_ROUTERS` and fails if a route is missing from its `ROUTE_CASES` table: add every new route there.

**Per-user settings.** Keys (Gemini, Cloudflare, Facebook App) live in the `settings` table per user, secrets AES-256-GCM encrypted (`src/lib/settings.ts`, `src/lib/crypto.ts`). Only the ADMIN account falls back to `.env` values. Never send decrypted settings to the client (`getPublicSettings` masks them).

**How AI writes a post.** Each user has content domains (`content_domains`: audience, voice, rules, default hashtags, image style), each with post formats (`content_formats`: instructions, length, example, `withImage`). `src/lib/compose-prompt.ts` (pure, unit-tested) builds the system prompt; `generateWithFormat` (`src/services/ai.service.ts`) calls Gemini with a JSON schema `{ post, image_prompt }`; `src/services/post-writer.ts` `writePost` is the single entry point used by both the generate route and the worker, and stores the prompt in `Post.aiPrompt`. A format with `legacyPrompt=true` ("Mặc định / Bài chuẩn", migrated from the old Settings system prompt) uses that prompt verbatim via `buildIdeaPrompt` so old accounts write exactly as before. `src/lib/domains.ts` holds the migration, the starter kit for new members and the domain/format resolution order (explicit → domain default → Page's default domain → first active domain).

**Facebook.** `src/lib/clients/facebook.ts` wraps the Graph API; Page tokens are encrypted in `facebook_pages`, and `src/lib/page-sync.ts` previews/applies syncing Pages from a user token. Each Page records which App issued its token (`tokenAppId`) so a changed App ID blocks posting until the Page is re-synced.

**Images** are stored on disk under `STORAGE_DIR/images` (`src/lib/image-store.ts`), served only to the post's owner by `GET /api/images/:postId`; the stored image is exactly what gets published. Videos (MP4/MOV ≤ 100 MB) live under `STORAGE_DIR/videos` (`src/lib/video-store.ts`, header parsed by `src/lib/mp4-info.ts`), served by `GET /api/videos/:postId`; a post has an image OR a video, and `Post.videoKind` picks `publishVideo` (feed) or `publishReel`.

**Client** (`client/src`): `api.ts` is the single fetch layer (`credentials: 'include'`, CSRF header, 401 → `AUTH_EVENT` → back to `/login`); `auth.tsx` provides `AuthProvider`/`ProtectedRoute`. Styling is plain CSS in `client/src/index.css` with design tokens on `:root` (no Tailwind); reuse existing tokens and classes.

## Conventions and gotchas

- Route handlers use `asyncHandler` + `createError(status, message, { code? })` from `src/middleware/error.middleware.ts`; error bodies are `{ success: false, error, code? }`. Validate input with zod.
- Schema changes are **additive only** (production applies them with `prisma db push` during the build, which stops on data loss). The DB is MariaDB — no Postgres-only Prisma features.
- `vitest.config.mts` sets `restoreMocks` and `unstubGlobals`: create `vi.spyOn`/`vi.stubGlobal` stubs **inside each test or `beforeEach`**. Tests must never reach real Gemini, Cloudflare or Facebook (spy on `GeminiClient.prototype.generateJson`, `CloudflareClient.prototype.generateImage`, stub Graph `fetch`).
- DB test files run in parallel against the same database: create users with `createTestUser()` / `testEmail()` from `tests/helpers/users.ts` (per-file email tag, `@autopost.test`) and clean up with `cleanupTestUsers()`; never pick "the first user" without excluding `@autopost.test` users.
- **Stop any local dev server before running DB tests** — its worker would claim the tests' jobs and call real APIs with fake tokens.
- The GitHub repo is public: stage files by name (no `git add -A`), never commit `.env*`, check the current branch before committing (never commit on `deploy`).
