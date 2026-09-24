---
name: autopost-workflow
description: Guide on how to run, test, and troubleshoot the Auto Post Facebook pipeline. Activate this when making changes to the worker pipeline, AI integrations, or when testing E2E posts.
---

# Auto Post Facebook Workflow

## Running the Application Locally
1. Start the database and redis:
   ```bash
   docker-compose up -d
   ```
2. Run backend dev server:
   ```bash
   npm run dev
   ```
   (Listens on port 3000)
3. Run frontend dev server:
   ```bash
   cd client && npm run dev
   ```
   (Listens on port 5173)

## Seeding the Database
If the database is wiped, you can seed a mock Facebook Page connection by running:
```bash
npx tsx -r dotenv/config seed_page.ts
```
Note: Ensure `.env` is loaded so `DATABASE_URL` is available to Prisma.

## Pipeline Architecture (Worker)
The core logic resides in `src/workers/post.worker.ts`.
- The worker listens to the `post-pipeline` BullMQ queue.
- It orchestrates calling `ai.service.ts` for text and `image.service.ts` for media.
- It then uses `facebook.service.ts` to post.

When modifying this pipeline, be aware that AI generation and Image generation are external API calls that may take several seconds. Error handling and retry mechanisms should be respected.
