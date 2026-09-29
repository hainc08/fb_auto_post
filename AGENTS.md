# Auto Post Facebook - Project Context & Rules

## Project Overview
This is a SaaS web service that automates creating and scheduling Facebook Page posts. It replaces a previous n8n workflow by integrating AI content generation (Google Gemini / OpenAI / Claude) and AI image generation (Cloudflare Workers AI / DALL-E) directly into a Node.js backend.

## Tech Stack
- **Frontend**: Vite + React, TypeScript, Vanilla CSS (No Tailwind).
- **Backend**: Node.js, Express, TypeScript.
- **Database**: MariaDB via Prisma ORM.
- **Job Queue**: MariaDB table `jobs` (`src/lib/job-queue.ts`), worker runs inside the API process. No Redis.

## Current State & Constraints
- **Authentication (multi-user, 2026-09):** login with email + password; session = JWT `{ sub, tv }` in the httpOnly cookie `ap_session`; `authenticate` in `auth.middleware.ts` checks `isActive` and `tokenVersion`. Roles `ADMIN` / `USER`; admins manage members at `/admin/users` (`admin.routes.ts`) and never see members' content. Non-GET `/api` requests need the header `X-Requested-With: autopost`.
- **Data isolation:** every query filters by `req.user.id`; ids that belong to another user return 404, also ids sent in a request body. New API routes MUST be added to `ROUTE_CASES` in `tests/isolation.db.test.ts` (the test fails otherwise).
- **Content domains:** AI writes with the post's content domain + format (`content_domains`, `content_formats`, `src/lib/compose-prompt.ts`, `src/services/post-writer.ts`). The old Settings system prompt became the "Mặc định / Bài chuẩn" legacy format.
- **API Keys:** each user brings their own Gemini / Cloudflare / Facebook App keys (Settings, stored per user, encrypted). Only the ADMIN account falls back to `.env` keys. `VITE_FB_APP_ID` for the frontend FB SDK.
- **Startup:** `runBootstrap()` (`src/lib/bootstrap.ts`) refuses a weak `JWT_SECRET` in production, ensures an admin (`ADMIN_EMAIL` / `ADMIN_PASSWORD` on first deploy) and migrates content domains.

## Core Pipeline
1. User provides keyword/topic via UI.
2. A `publish_post` job is queued in the MariaDB `jobs` table.
3. Worker calls `writePost` (`post-writer.ts` → `ai.service.ts`) to generate caption + image prompt with the post's content domain + format.
4. Worker calls `image.service.ts` to generate an image based on the prompt.
5. Worker calls `facebook.service.ts` to upload the image and publish the post to the connected Page.

## Coding Guidelines
- **UI/UX**: Prioritize premium, dynamic, and aesthetic UI with CSS micro-animations. Avoid generic UI.
- **Database**: Use MariaDB exclusively.
- **Error Handling**: Use the existing `asyncHandler` and `createError` utilities.
- **Imports**: Ensure ES Module imports use `.js` extension if strictly required, but standard TS imports in src/ are fine if Vite/TSNode handles them.
