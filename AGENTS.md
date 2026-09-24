# Auto Post Facebook - Project Context & Rules

## Project Overview
This is a SaaS web service that automates creating and scheduling Facebook Page posts. It replaces a previous n8n workflow by integrating AI content generation (Google Gemini / OpenAI / Claude) and AI image generation (Cloudflare Workers AI / DALL-E) directly into a Node.js backend.

## Tech Stack
- **Frontend**: Vite + React, TypeScript, Vanilla CSS (No Tailwind).
- **Backend**: Node.js, Express, TypeScript.
- **Database**: MariaDB via Prisma ORM.
- **Job Queue**: BullMQ + Redis.

## Current State & Constraints
- **Authentication**: Currently bypassed for MVP. `auth.middleware.ts` auto-assigns an Admin user. DO NOT re-enable auth unless explicitly requested by the user.
- **API Keys**: Managed via `.env` files. `VITE_FB_APP_ID` for frontend FB SDK.

## Core Pipeline
1. User provides keyword/topic via UI.
2. Job is queued to BullMQ (`post-pipeline`).
3. Worker calls `ai.service.ts` to generate caption + image prompt.
4. Worker calls `image.service.ts` to generate an image based on the prompt.
5. Worker calls `facebook.service.ts` to upload the image and publish the post to the connected Page.

## Coding Guidelines
- **UI/UX**: Prioritize premium, dynamic, and aesthetic UI with CSS micro-animations. Avoid generic UI.
- **Database**: Use MariaDB exclusively.
- **Error Handling**: Use the existing `asyncHandler` and `createError` utilities.
- **Imports**: Ensure ES Module imports use `.js` extension if strictly required, but standard TS imports in src/ are fine if Vite/TSNode handles them.
