# Reels on Hostinger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Tạo Reel từ bài" works on the production host (Hostinger shared Node.js hosting), not only on the developer's PC.

**Architecture:** The app brings its own FFmpeg (npm `ffmpeg-static`) and its own subtitle font (Be Vietnam Pro Bold in `assets/fonts`), so nothing needs installing on the host. Rendering leaves the HTTP request: `POST /api/posts/:id/reel` books one keyed `render_reel` job per post in the existing `jobs` table, the worker runs the existing `makeReel`, and the dialog polls `GET /api/posts/:id/reel/progress`, which now reports the job's state. A key-protected `/cron/reel-check` renders a sample on the host and reports what works.

**Tech Stack:** Node/Express/TypeScript, MariaDB job queue (`src/lib/job-queue.ts`), `ffmpeg-static` (new dependency), system-independent font file, React client, Vitest.

**Spec:** none — requested in chat on 2026-10-03 after a feasibility test on the host over SSH. What that test showed (account `u774510961`, 64-core shared server):

- The `ffmpeg-static` binary (FFmpeg 7.0.2, johnvansickle build) runs and has the `ass` filter (libass).
- `libx264` fails to open with default threads on the 64-core host and works with `-threads 2`: 30 s of 1080×1920 video in 3.1 s.
- Edge TTS answered 4 of 4 requests from the host with audio and word marks.
- Not tested there: running inside the app process managed by hPanel, and subtitles with a Vietnamese font (the host has no Arial).

Decisions taken for this plan (the user may overrule them before execution):

1. **FFmpeg comes from `ffmpeg-static` everywhere** (also on the developer's PC), unless `FFMPEG_PATH` is set. One FFmpeg version in tests and production.
2. **Subtitle font: Be Vietnam Pro Bold** (SIL Open Font License), committed in `assets/fonts` and loaded through libass `fontsdir`. `REEL_FONT` still overrides the font name.
3. **Rendering is a background job**, one per post (`reel:<postId>`), `maxAttempts = 1`. The request returns at once; the dialog shows the same progress bar and gets the result by polling.
4. **Edge TTS stays** the voice provider (unofficial; it may be blocked later — the job then fails with a clear message).
5. **`/cron/reel-check?key=CRON_SECRET`** is the after-deploy check; `&video=1` returns the sample video to look at.
6. **No deploy in this plan.** The last task ends on `main`-ready code; merging and deploying are the user's call. After a deploy the "Tạo Reel từ bài" button appears for every member on the host.

## Global Constraints

- UI copy and API error messages are Vietnamese; code and comments are English.
- No change to `prisma/schema.prisma` (`Job.type` is a string column).
- New and changed routes filter by `req.user.id` and return 404 for another user's post id; `tests/isolation.db.test.ts` keeps passing (route paths do not change).
- Tests never reach Edge TTS, Gemini or Facebook: spy on `edgeTts.synthesize`, `reelRenderer.render`, `GeminiClient.prototype.generateJson` inside each test.
- A test that starts a worker passes `startWorkers({ only: ['render_reel'], pollMs: 200 })`.
- **Before any `RUN_DB_TESTS=1` run: kill the `tsx watch` parent of `npm run dev` (not only the process on port 3000 — it respawns on file edits) and confirm nothing listens on port 3000.** MariaDB must be up; ask the user to start Docker, never start it unprompted.
- New dependency: `ffmpeg-static` only. New committed binary files: `assets/fonts/BeVietnamPro-Bold.ttf` and its `OFL.txt`.
- Client commands need Node 22: `npx -y -p node@22 -- node …` as in `CLAUDE.md`.
- Public repo: stage files by name, never `git add -A`, never commit `.env*`, `CR/`, `bugs/`, `prompt_creator_video.md`, `STORY_VIDEO_PLAN.pdf`. Work on branch `feature/reel-on-hostinger`. Do not merge, push or deploy without the user asking.

## Review Focus

1. The app process is restarted or put to sleep while a Reel renders → the job is picked up again and finishes, or fails with a message; the post is never left half-changed, and the dialog does not spin for ever (Task 2 tests "a job interrupted by a restart runs again", "the dialog's state when the job failed").
2. Two members (or two posts) render at once on the shared host → at most the worker's concurrency (2) run; a second request for the same post is refused (Task 2 test "a second request while one is queued or running is refused").
3. The host's FFmpeg or font is missing after a deploy (install script blocked, `assets` not shipped) → the feature hides itself or the check says exactly what is missing, instead of rendering boxes for Vietnamese letters (Task 1 test "finds the bundled font"; Task 4 tests).
4. The user closes the browser tab during a render and comes back → the dialog resumes the progress instead of offering a second render (Task 3 Step 4 browser check; Task 2 test of the `queued`/`running` states).
5. The post is deleted while its job waits or runs → no file and no job row is left (Task 2 tests "a post deleted while its Reel is rendered", "deleting the post removes its job").

---

## File Structure

| File | Responsibility |
|---|---|
| `assets/fonts/BeVietnamPro-Bold.ttf`, `assets/fonts/OFL.txt` (new) | Subtitle font and its licence |
| `src/lib/reel/render.ts` (modify) | FFmpeg from `ffmpeg-static`, `-threads 2`, bundled font, `probeSubtitleFont`, `ffmpegVersion` |
| `src/lib/reel/subtitles.ts` (modify) | Default font name |
| `src/lib/reel/self-check.ts` (new) | Render a sample and report each step |
| `src/lib/job-queue.ts`, `src/services/scheduler.service.ts` (modify) | `render_reel` job type and its handler registration |
| `src/services/reel.service.ts` (modify) | `queueReel`, `runReelJob`, `reelState` |
| `src/routes/reel.routes.ts`, `src/routes/posts.routes.ts`, `src/app.ts` (modify) | 202 + job state; job removed with the post; `/cron/reel-check` |
| `client/src/api.ts`, `client/src/components/ReelMaker.tsx` (modify) | Queue, poll, resume |
| `scripts/sync-deploy-branch.mjs` (modify) | Ship `assets` |
| `tests/reel-subtitles.test.ts`, `tests/reel-render.test.ts`, `tests/reel.db.test.ts`, `tests/app.test.ts` (modify) | Tests |
| `.env.example`, `CLAUDE.md`, `ROADMAP.md`, `docs/DEPLOY_HOSTINGER.md` (modify) | Docs |

---

### Task 1: The app brings its own FFmpeg and font

**Files:**
- Create: `assets/fonts/BeVietnamPro-Bold.ttf`, `assets/fonts/OFL.txt`
- Modify: `package.json` (via npm), `src/lib/reel/render.ts`, `src/lib/reel/subtitles.ts`, `src/services/reel.service.ts:79`, `scripts/sync-deploy-branch.mjs:22-43`, `.env.example`
- Test: `tests/reel-subtitles.test.ts`, `tests/reel-render.test.ts`

**Interfaces:**
- Consumes: `buildAss` from `src/lib/reel/subtitles.ts`.
- Produces:
  - `DEFAULT_REEL_FONT = 'Be Vietnam Pro'` (exported from `subtitles.ts`; `buildAss` uses it when `opts.font` is not given).
  - `REEL_FONT_FILE: string`, `ffmpegVersion(): Promise<string | null>`, `probeSubtitleFont(font?: string): Promise<string | null>` (from `render.ts`); `ffmpegAvailable()` and `reelRenderer.render(...)` keep their signatures.

- [ ] **Step 1: Branch, plan commit, dependency, font**

```bash
git checkout main && git checkout -b feature/reel-on-hostinger
git add docs/superpowers/plans/2026-10-03-reel-on-hostinger.md
git commit -m "docs: plan for Reels on Hostinger"
npm install ffmpeg-static
mkdir -p assets/fonts
curl -sL -o assets/fonts/BeVietnamPro-Bold.ttf https://github.com/google/fonts/raw/main/ofl/bevietnampro/BeVietnamPro-Bold.ttf
curl -sL -o assets/fonts/OFL.txt https://raw.githubusercontent.com/google/fonts/main/ofl/bevietnampro/OFL.txt
ls -la assets/fonts && head -1 assets/fonts/OFL.txt
node -e "console.log(require('ffmpeg-static'))"
```

Expected: `BeVietnamPro-Bold.ttf` is 140300 bytes; `OFL.txt` starts with `Copyright 2021 The Be Vietnam Pro Project Authors`; the last command prints a path to an `ffmpeg` file inside `node_modules/ffmpeg-static`.

- [ ] **Step 2: Write the failing tests**

In `tests/reel-subtitles.test.ts`, replace the test `'puts the text under the picture, or in the middle without one'` with:

```ts
  it('puts the text under the picture, or in the middle without one, in the bundled font', () => {
    expect(buildAss(two, { withImage: true })).toMatch(/^Style: K,Be Vietnam Pro,.*,2,80,80,430,1$/m);
    expect(buildAss(two, { withImage: false })).toMatch(/^Style: K,Be Vietnam Pro,.*,5,80,80,0,1$/m);
    expect(buildAss(two, { withImage: false, font: 'Arial' })).toMatch(/^Style: K,Arial,/m);
  });
```

In `tests/reel-render.test.ts`:

Replace the two lines

```ts
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;
```

with

```ts
import ffmpegStatic from 'ffmpeg-static';
import { existsSync } from 'node:fs';
import { ffmpegVersion, probeSubtitleFont, REEL_FONT_FILE } from '../src/lib/reel/render';

const FFMPEG = process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg';
const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;
```

and add these tests after `'finds FFmpeg'`:

```ts
  it('uses the FFmpeg the app ships with', async () => {
    expect(ffmpegStatic).toBeTruthy();
    expect(await ffmpegVersion()).toMatch(/^ffmpeg version \S+/);
  });

  it('finds the bundled font and uses it for Vietnamese subtitles', async () => {
    expect(existsSync(REEL_FONT_FILE)).toBe(true);
    expect(await probeSubtitleFont()).toBe('BeVietnamPro-Bold');
  });
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/reel-subtitles.test.ts tests/reel-render.test.ts`
Expected: FAIL — the style still says `Arial`; `ffmpegVersion`, `probeSubtitleFont` and `REEL_FONT_FILE` are not exported.

- [ ] **Step 4: Default font**

In `src/lib/reel/subtitles.ts`, above `export interface ReelWord`, add:

```ts
/** Bundled in assets/fonts (SIL OFL); covers Vietnamese on every host */
export const DEFAULT_REEL_FONT = 'Be Vietnam Pro';
```

and in `buildAss` replace `${opts.font ?? 'Arial'}` with `${opts.font || DEFAULT_REEL_FONT}`.

In `src/services/reel.service.ts`, the line that builds `ass` already passes `font: process.env.REEL_FONT`; leave it (an unset variable now means the bundled font).

- [ ] **Step 5: Replace `src/lib/reel/render.ts`**

```ts
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import type { ImageMime } from '../image-store';
import { buildAss, DEFAULT_REEL_FONT } from './subtitles';

/**
 * Renders a Reel with FFmpeg: the voice + karaoke subtitles over the post's picture (blurred to fill 9:16,
 * the picture itself on top), or over a plain dark ground when there is no picture.
 *
 * FFmpeg is the binary shipped by the npm package `ffmpeg-static` (FFMPEG_PATH overrides it), so the
 * production host needs nothing installed. The subtitle font is assets/fonts/BeVietnamPro-Bold.ttf.
 */

const FFMPEG = process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg';
const RENDER_TIMEOUT_MS = 180_000;
/** libx264 opens ~1.5 threads per core by default and cannot start on a 64-core shared host */
const THREADS = ['-threads', '2'];
const EXT: Record<ImageMime, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const REEL_FONT_FILE = path.resolve(process.cwd(), 'assets', 'fonts', 'BeVietnamPro-Bold.ttf');

function run(args: string[], cwd?: string, onStdout?: (text: string) => void, loglevel = 'error'): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(FFMPEG, ['-y', '-hide_banner', '-loglevel', loglevel, ...args], { cwd, timeout: RENDER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, _out, stderr) =>
      error ? reject(new Error(error.killed ? 'quá thời gian cho phép.' : String(stderr || error.message).trim().split('\n').pop())) : resolve(String(stderr))
    );
    if (onStdout) child.stdout?.on('data', (chunk) => onStdout(String(chunk)));
  });
}

/** `-progress pipe:1` prints "out_time_us=<microseconds encoded so far>" about twice a second */
function encodedMs(text: string): number | null {
  const marks = [...text.matchAll(/out_time_(?:us|ms)=(\d+)/g)];
  return marks.length ? Number(marks[marks.length - 1][1]) / 1000 : null;
}

export function ffmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => execFile(FFMPEG, ['-version'], { timeout: 10_000 }, (error) => resolve(!error)));
}

/** "ffmpeg version 7.0.2-static …", or null when FFmpeg cannot run */
export function ffmpegVersion(): Promise<string | null> {
  return new Promise((resolve) => execFile(FFMPEG, ['-version'], { timeout: 10_000 }, (error, out) => resolve(error ? null : String(out).split('\n')[0].trim())));
}

/**
 * A private work folder. File names inside it are relative (cwd): a Windows drive colon would need
 * escaping inside an FFmpeg filter. The bundled font is copied in so libass finds it through `fontsdir`.
 */
async function workDir(): Promise<{ dir: string; assFilter: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'autopost-reel-'));
  if (!existsSync(REEL_FONT_FILE)) return { dir, assFilter: 'ass=subs.ass' };
  await mkdir(path.join(dir, 'fonts'));
  await copyFile(REEL_FONT_FILE, path.join(dir, 'fonts', path.basename(REEL_FONT_FILE)));
  return { dir, assFilter: 'ass=subs.ass:fontsdir=fonts' };
}

/**
 * Which font file libass picks for the subtitles ("BeVietnamPro-Bold" when the bundled font is used);
 * null when FFmpeg or its subtitle filter does not work. One frame, a fraction of a second.
 */
export async function probeSubtitleFont(font = DEFAULT_REEL_FONT): Promise<string | null> {
  const { dir, assFilter } = await workDir();
  try {
    await writeFile(path.join(dir, 'subs.ass'), buildAss([[{ text: 'Tiếng Việt', startMs: 0, durationMs: 1000 }]], { withImage: false, font }), 'utf8');
    const log = await run(['-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:r=30', '-vf', assFilter, '-frames:v', '1', '-f', 'null', '-'], dir, undefined, 'verbose');
    return /fontselect: \([^)]*\) -> ([^,\r\n]+)/.exec(log)?.[1].trim() ?? null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function render(input: {
  audio: Buffer;
  ass: string;
  image?: { buffer: Buffer; mime: ImageMime } | null;
  outPath: string;
  /** Length of the voice; with `onProgress`, the encoded share (0–1) is reported as the video is written */
  durationMs?: number;
  onProgress?: (fraction: number) => void;
}): Promise<void> {
  const { dir, assFilter } = await workDir();
  try {
    await writeFile(path.join(dir, 'voice.mp3'), input.audio);
    await writeFile(path.join(dir, 'subs.ass'), input.ass, 'utf8');

    let video: string[];
    if (input.image) {
      const picture = `picture.${EXT[input.image.mime]}`;
      await writeFile(path.join(dir, picture), input.image.buffer);
      // The still ground is made once; blurring every frame of the video would be far slower
      await run(
        ['-i', picture, '-filter_complex',
          '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:4,eq=brightness=-0.28[bg];[0:v]scale=960:-2[fg];[bg][fg]overlay=(W-w)/2:200',
          '-frames:v', '1', 'ground.png'],
        dir
      );
      video = ['-loop', '1', '-framerate', '30', '-i', 'ground.png'];
    } else {
      video = ['-f', 'lavfi', '-i', 'color=c=0x17191F:s=1080x1920:r=30'];
    }
    const { durationMs, onProgress } = input;
    let reported = 0;
    const report =
      durationMs && onProgress
        ? (text: string) => {
            const ms = encodedMs(text);
            if (ms === null) return;
            // never backwards, never past the end
            reported = Math.max(reported, Math.min(1, ms / durationMs));
            onProgress(reported);
          }
        : undefined;
    await run(
      [...(report ? ['-progress', 'pipe:1', '-nostats'] : []), ...video, '-i', 'voice.mp3', '-vf', assFilter,
        ...THREADS, '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '160k',
        '-shortest', '-movflags', '+faststart', 'reel.mp4'],
      dir,
      report
    );
    await copyFile(path.join(dir, 'reel.mp4'), input.outPath);
  } catch (error) {
    throw new Error(`Dựng video thất bại: ${(error as Error).message}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** An object, so tests (and another renderer, e.g. Remotion) replace `render` */
export const reelRenderer = { render };
```

- [ ] **Step 6: Run the tests**

Run: `npx tsc --noEmit && npx vitest run tests/reel-subtitles.test.ts tests/reel-render.test.ts`
Expected: typecheck clean; all pass. If TypeScript cannot find types for `ffmpeg-static`, add `src/types/ffmpeg-static.d.ts` with `declare module 'ffmpeg-static' { const path: string | null; export default path; }` and commit it with this task. If `'finds the bundled font…'` returns another name, the `ffmpeg-static` build for this OS has no working `fontsdir`: stop and tell the user (the plan's Decision 1 then needs the system FFmpeg locally).

- [ ] **Step 7: Ship the font; document**

In `scripts/sync-deploy-branch.mjs`, add `'assets',` to `DEPLOY_PATHS` after `'src',`.

In `.env.example`, replace the two Reel lines with:

```
# FFMPEG_PATH=                     # "Tạo Reel từ bài": FFmpeg comes with the app (npm ffmpeg-static); set this only to use another binary
# REEL_FONT=                       # font name of the Reel subtitles (default: the bundled Be Vietnam Pro)
```

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json assets/fonts/BeVietnamPro-Bold.ttf assets/fonts/OFL.txt src/lib/reel/render.ts src/lib/reel/subtitles.ts scripts/sync-deploy-branch.mjs .env.example tests/reel-subtitles.test.ts tests/reel-render.test.ts
git commit -m "feat(reel): ship FFmpeg (ffmpeg-static) and the subtitle font with the app"
```

---

### Task 2: Render in a background job

**Files:**
- Modify: `src/lib/job-queue.ts:17` (`JobType`), `src/services/reel.service.ts`, `src/services/scheduler.service.ts` (handlers map), `src/routes/reel.routes.ts`, `src/routes/posts.routes.ts` (delete route)
- Test: `tests/reel.db.test.ts` (rewritten)

**Interfaces:**
- Consumes: `upsertKeyedJob(key, type, payload, runAt)`, `removeKeyedJob(key)`, `UnrecoverableJobError`, `JobType` (`src/lib/job-queue.ts`); `makeReel`, `reelProgress`, `ReelError` (existing in `reel.service.ts`); `startWorkers({ only, pollMs })`.
- Produces:
  - `JobType` includes `'render_reel'`.
  - `reelJobKey(postId: string): string` → `` `reel:${postId}` ``
  - `queueReel(post: Post, input: { script: string; voice: EdgeVoice }): Promise<void>` — throws `ReelError(409)` while a job for the post is PENDING or RUNNING.
  - `runReelJob(job: Job): Promise<void>` (the `render_reel` handler).
  - `reelState(postId: string): Promise<ReelState>` where `type ReelState = { state: 'idle' } | { state: 'queued' | 'running'; stage: 'voice' | 'render' | 'saving'; percent: number } | { state: 'done' } | { state: 'failed'; error: string }`.
  - `POST /api/posts/:id/reel` → `202 { success, data: { state: 'queued' } }` (same 400/404/409/503 as before; 502/500 now arrive through the job).
  - `GET /api/posts/:id/reel/progress` → `200 { success, data: ReelState }`, and when `state === 'done'` the data also has `video: { videoUrl, videoKind, videoMeta, reelsProblem }` and `reelScript: string | null`.

- [ ] **Step 1: Rewrite the test file**

Replace `tests/reel.db.test.ts` with:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { GeminiClient } from '../src/lib/clients/gemini';
import { edgeTts } from '../src/lib/reel/edge-tts';
import { reelRenderer } from '../src/lib/reel/render';
import * as renderModule from '../src/lib/reel/render';
import { readReelBackground, REEL_DIR } from '../src/lib/reel/background-store';
import { IMAGE_DIR, saveImage } from '../src/lib/image-store';
import { saveSettings } from '../src/lib/settings';
import { resolveVideo, VIDEO_DIR } from '../src/lib/video-store';
import { STALE_AFTER_MS } from '../src/lib/job-queue';
import { startWorkers } from '../src/services/scheduler.service';
import { reelJobKey } from '../src/services/reel.service';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';
import { tinyMp4 } from './helpers/mp4';

let server: Awaited<ReturnType<typeof startTestServer>>;
let stopWorker: (() => void) | undefined;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('picture')]);
const SCRIPT = 'Bạn mất bao lâu để viết một email? Thử ngay hôm nay!';
const WORDS = SCRIPT.split(' ').map((text, i) => ({ text: text.replace(/[?!]/g, ''), startMs: i * 300, durationMs: 300 }));

/** Edge TTS and FFmpeg replaced: the "render" writes a tiny valid vertical MP4 */
function fakePipeline(durationSec = 20) {
  vi.spyOn(renderModule, 'ffmpegAvailable').mockResolvedValue(true);
  const voice = vi.spyOn(edgeTts, 'synthesize').mockResolvedValue({ audio: Buffer.from('mp3'), words: WORDS });
  const render = vi.spyOn(reelRenderer, 'render').mockImplementation(async ({ outPath }) => {
    await writeFile(outPath, tinyMp4({ durationSec, width: 1080, height: 1920 }));
  });
  return { voice, render };
}

/** Posts made by this file: their files and jobs are removed at the end (deleting the test users removes rows only) */
const made: string[] = [];
const filesOf = async (dir: string, postId: string) => (existsSync(dir) ? (await readdir(dir)).filter((n) => n.startsWith(postId)) : []);
const videoFilesOf = (postId: string) => filesOf(VIDEO_DIR, postId);

async function setup(withImage = true) {
  const { user, cookie } = await createTestUser();
  const page = await prisma.facebookPage.create({ data: { userId: user.id, pageId: `REEL_${Date.now()}_${Math.random()}`, pageName: 'P', pageAccessToken: 'EAAfaketokenreelxxxxxxxxxxxxxxxxxxx' } });
  let post = await prisma.post.create({ data: { userId: user.id, pageId: page.id, caption: 'Bài viết dài về email.', status: 'READY', inputData: { basicInfo: 'ý tưởng' } } });
  made.push(post.id);
  if (withImage) {
    const saved = await saveImage(post.id, PNG);
    post = await prisma.post.update({ where: { id: post.id }, data: { imagePath: saved.imagePath, imageUrl: saved.imageUrl } });
  }
  return { cookie, post, userId: user.id };
}

const row = (id: string) => prisma.post.findUniqueOrThrow({ where: { id } });
const jobOf = (id: string) => prisma.job.findUnique({ where: { key: reelJobKey(id) } });
const queue = (cookie: string, id: string, body: Record<string, unknown> = { script: SCRIPT }) => api(server.baseUrl, 'POST', `/api/posts/${id}/reel`, { cookie, body });
const progress = (cookie: string, id: string) => api(server.baseUrl, 'GET', `/api/posts/${id}/reel/progress`, { cookie });

/** Wait for the worker to finish the post's job (DONE or FAILED) */
async function settled(id: string, ms = 15_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const job = await jobOf(id);
    if (job && (job.status === 'DONE' || job.status === 'FAILED')) return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the reel job did not finish');
}

/** Queue a Reel and wait for it: the state the dialog would end on */
async function make(cookie: string, id: string, body: Record<string, unknown> = { script: SCRIPT }) {
  const res = await queue(cookie, id, body);
  if (res.status !== 202) throw new Error(`not queued: ${res.status} ${res.text}`);
  await settled(id);
  return (await progress(cookie, id)).json.data;
}

describe.skipIf(!process.env.RUN_DB_TESTS)('text to Reel', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    server = await startTestServer(createApp());
    stopWorker = startWorkers({ pollMs: 200, only: ['render_reel'] });
  });
  afterAll(async () => {
    stopWorker?.();
    for (const id of made) {
      for (const dir of [VIDEO_DIR, IMAGE_DIR, REEL_DIR]) {
        for (const name of await filesOf(dir, id)) await unlink(path.join(dir, name)).catch(() => {});
      }
    }
    await prisma.job.deleteMany({ where: { key: { in: made.map(reelJobKey) } } });
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('queues the Reel at once; the worker makes it and the video replaces the picture', async () => {
    const { cookie, post } = await setup();
    const { voice, render } = fakePipeline();
    const res = await queue(cookie, post.id, { script: SCRIPT, voice: 'vi-VN-NamMinhNeural' });
    expect(res.status).toBe(202);
    expect(res.json.data).toEqual({ state: 'queued' });
    expect(await jobOf(post.id)).toMatchObject({ type: 'render_reel', maxAttempts: 1 });
    await settled(post.id);

    const done = (await progress(cookie, post.id)).json.data;
    expect(done).toMatchObject({ state: 'done', reelScript: SCRIPT, video: { videoKind: 'REEL', reelsProblem: null, videoMeta: { width: 1080, height: 1920, durationSec: 20 } } });
    expect(voice).toHaveBeenCalledWith(SCRIPT, 'vi-VN-NamMinhNeural');
    const input = render.mock.calls[0][0];
    expect(input.image).toMatchObject({ mime: 'image/png' });
    // subtitles use the script's own words (punctuation kept), under the picture
    expect(input.ass).toContain('email?');
    expect(input.ass).toMatch(/,2,80,80,430,1$/m);
    const saved = await row(post.id);
    expect(saved).toMatchObject({ videoKind: 'REEL', imagePath: null, imageUrl: null, status: 'READY' });
    expect(saved.videoUrl).toBe(done.video.videoUrl);
    expect(saved.inputData).toMatchObject({ basicInfo: 'ý tưởng', reelScript: SCRIPT, reelVoice: 'vi-VN-NamMinhNeural' });
    expect(existsSync(resolveVideo(saved.videoPath!)!)).toBe(true);
    expect((await readReelBackground(post.id))?.buffer.equals(PNG)).toBe(true);
    expect(await prisma.postLog.count({ where: { postId: post.id, action: 'reel_rendered' } })).toBe(1);
  });

  it('a second render reuses the picture and removes the first video', async () => {
    const { cookie, post } = await setup();
    const { render } = fakePipeline();
    await make(cookie, post.id);
    const first = (await row(post.id)).videoPath!;
    expect((await make(cookie, post.id, { script: `${SCRIPT} Cảm ơn bạn đã xem.` })).state).toBe('done');
    expect(render.mock.calls[1][0].image).toMatchObject({ mime: 'image/png' });
    const second = (await row(post.id)).videoPath!;
    expect(second).not.toBe(first);
    expect(existsSync(resolveVideo(first)!)).toBe(false);
  });

  it('without a picture the text is centred on a plain ground', async () => {
    const { cookie, post } = await setup(false);
    const { render } = fakePipeline();
    expect((await make(cookie, post.id)).state).toBe('done');
    expect(render.mock.calls[0][0].image).toBeNull();
    expect(render.mock.calls[0][0].ass).toMatch(/,5,80,80,0,1$/m);
  });

  it('the dialog\'s state when the job failed: the reason, and nothing changed', async () => {
    const { cookie, post } = await setup();
    const { render } = fakePipeline();
    vi.spyOn(edgeTts, 'synthesize').mockRejectedValue(new Error('Dịch vụ giọng đọc từ chối kết nối (HTTP 403).'));
    const state = await make(cookie, post.id);
    expect(state.state).toBe('failed');
    expect(state.error).toMatch(/Chưa tạo được giọng đọc.*HTTP 403/);
    expect(render).not.toHaveBeenCalled();
    expect(await row(post.id)).toMatchObject({ videoPath: null, imagePath: post.imagePath });
    // failed for good: one attempt, and a new request is accepted
    expect(await jobOf(post.id)).toMatchObject({ status: 'FAILED', attempts: 1 });
    fakePipeline();
    expect((await make(cookie, post.id)).state).toBe('done');
  });

  it('a Reel longer than 90 seconds is refused and its file removed', async () => {
    const { cookie, post } = await setup();
    fakePipeline(120);
    const state = await make(cookie, post.id);
    expect(state).toMatchObject({ state: 'failed' });
    expect(state.error).toMatch(/3–90 giây/);
    expect(await row(post.id)).toMatchObject({ videoPath: null, imagePath: post.imagePath });
    expect(await videoFilesOf(post.id)).toEqual([]);
  });

  it('a post that starts publishing while its Reel is rendered is left alone', async () => {
    const { cookie, post } = await setup();
    fakePipeline();
    // e.g. its timed job fires during the 20–60 seconds of rendering
    vi.spyOn(edgeTts, 'synthesize').mockImplementation(async () => {
      await prisma.post.update({ where: { id: post.id }, data: { status: 'PUBLISHING' } });
      return { audio: Buffer.from('mp3'), words: WORDS };
    });
    const state = await make(cookie, post.id);
    expect(state.state).toBe('failed');
    expect(state.error).toMatch(/vừa thay đổi/);
    expect(await row(post.id)).toMatchObject({ status: 'PUBLISHING', videoPath: null, videoKind: null, imagePath: post.imagePath });
    expect(await videoFilesOf(post.id)).toEqual([]);
  });

  it('a post deleted while its Reel is rendered leaves no file behind', async () => {
    const { cookie, post } = await setup();
    fakePipeline();
    vi.spyOn(edgeTts, 'synthesize').mockImplementation(async () => {
      await prisma.post.delete({ where: { id: post.id } });
      return { audio: Buffer.from('mp3'), words: WORDS };
    });
    expect((await queue(cookie, post.id)).status).toBe(202);
    await settled(post.id);
    expect((await progress(cookie, post.id)).status).toBe(404);
    expect(await videoFilesOf(post.id)).toEqual([]);
    expect(await readReelBackground(post.id)).toBeNull();
  });

  it('a second request while one is queued or running is refused', async () => {
    const { cookie, post } = await setup();
    fakePipeline();
    let release!: () => void;
    vi.spyOn(edgeTts, 'synthesize').mockImplementation(() => new Promise((resolve) => (release = () => resolve({ audio: Buffer.from('mp3'), words: WORDS }))));
    expect((await queue(cookie, post.id)).status).toBe(202);
    // refused at once, whether the worker has taken the job yet or not
    const early = await queue(cookie, post.id);
    expect(early.status).toBe(409);
    expect(early.json.error).toMatch(/đang được dựng/);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 5000 });
    expect((await queue(cookie, post.id)).status).toBe(409);
    expect((await progress(cookie, post.id)).json.data).toEqual({ state: 'running', stage: 'voice', percent: 10 });
    release();
    await settled(post.id);
    expect(await videoFilesOf(post.id)).toHaveLength(1);
  });

  it('reports queued, each step with its percentage, then done', async () => {
    const { cookie, post } = await setup();
    fakePipeline();
    const state = async () => (await progress(cookie, post.id)).json.data;
    const seen: unknown[] = [await state()];
    vi.spyOn(edgeTts, 'synthesize').mockImplementation(async () => {
      seen.push(await state());
      return { audio: Buffer.from('mp3'), words: WORDS };
    });
    vi.spyOn(reelRenderer, 'render').mockImplementation(async ({ outPath, onProgress, durationMs }) => {
      expect(durationMs).toBe(WORDS.length * 300);
      seen.push(await state());
      onProgress?.(0.5);
      seen.push(await state());
      onProgress?.(1);
      seen.push(await state());
      await writeFile(outPath, tinyMp4({ durationSec: 20, width: 1080, height: 1920 }));
    });
    // the worker is paused for a moment: the job is seen waiting
    stopWorker?.();
    expect((await queue(cookie, post.id)).status).toBe(202);
    seen.push(await state());
    stopWorker = startWorkers({ pollMs: 200, only: ['render_reel'] });
    await settled(post.id);
    expect(seen).toEqual([
      { state: 'idle' },
      { state: 'queued', stage: 'voice', percent: 3 },
      { state: 'running', stage: 'voice', percent: 10 },
      { state: 'running', stage: 'render', percent: 40 },
      { state: 'running', stage: 'render', percent: 68 },
      { state: 'running', stage: 'render', percent: 95 },
    ]);
    expect((await state()).state).toBe('done');
    // another member cannot watch it
    const other = await createTestUser();
    expect((await progress(other.cookie, post.id)).status).toBe(404);
  });

  it('a job interrupted by a restart runs again and finishes', async () => {
    const { cookie, post } = await setup();
    fakePipeline();
    stopWorker?.();
    expect((await queue(cookie, post.id)).status).toBe(202);
    // as left by a process that died while rendering, 11 minutes ago
    await prisma.job.update({ where: { key: reelJobKey(post.id) }, data: { status: 'RUNNING', attempts: 1, lockToken: 'dead-process', lockedAt: new Date(Date.now() - STALE_AFTER_MS - 60_000) } });
    expect((await progress(cookie, post.id)).json.data).toEqual({ state: 'running', stage: 'voice', percent: 5 });
    // what recoverStaleJobs() does, for this job only (other test files share the jobs table)
    await prisma.job.update({ where: { key: reelJobKey(post.id) }, data: { status: 'PENDING', interrupted: true, lockToken: null, lockedAt: null, runAt: new Date() } });
    stopWorker = startWorkers({ pollMs: 200, only: ['render_reel'] });
    await settled(post.id);
    expect((await progress(cookie, post.id)).json.data.state).toBe('done');
    expect(await row(post.id)).toMatchObject({ videoKind: 'REEL' });
  });

  it('refuses a script that is too short, an unknown voice, and a host without FFmpeg, before queueing', async () => {
    const { cookie, post } = await setup();
    fakePipeline();
    const short = await queue(cookie, post.id, { script: 'Xin chào bạn' });
    expect(short.status).toBe(400);
    expect(short.json.error).toMatch(/ít nhất 5 từ/);
    expect((await queue(cookie, post.id, { script: SCRIPT, voice: 'en-US-GuyNeural' })).status).toBe(400);
    vi.spyOn(renderModule, 'ffmpegAvailable').mockResolvedValue(false);
    const none = await queue(cookie, post.id);
    expect(none.status).toBe(503);
    expect(none.json.error).toMatch(/FFmpeg/);
    expect(await jobOf(post.id)).toBeNull();
  });

  it('refuses a post that is already published or live on one of its Pages', async () => {
    const { cookie, post } = await setup();
    fakePipeline();
    await prisma.postTarget.create({ data: { postId: post.id, pageId: post.pageId, status: 'PUBLISHED', fbPostId: 'live_1' } });
    expect((await queue(cookie, post.id)).status).toBe(409);
    await prisma.postTarget.deleteMany({ where: { postId: post.id } });
    await prisma.post.update({ where: { id: post.id }, data: { status: 'PUBLISHED' } });
    expect((await queue(cookie, post.id)).status).toBe(409);
    expect(await jobOf(post.id)).toBeNull();
  });

  it('deleting the post removes its kept picture and its job', async () => {
    const { cookie, post } = await setup();
    fakePipeline();
    await make(cookie, post.id);
    expect(await jobOf(post.id)).not.toBeNull();
    expect((await api(server.baseUrl, 'DELETE', `/api/posts/${post.id}`, { cookie })).status).toBe(200);
    expect(await readReelBackground(post.id)).toBeNull();
    expect(await jobOf(post.id)).toBeNull();
  });

  it('says whether Reels can be made here, and writes no script when they cannot', async () => {
    const { cookie, post, userId } = await setup();
    await saveSettings(userId, { geminiApiKey: 'AIzaFakeKeyReelTest000000000000000000' });
    const gemini = vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ script: 'x' } as never);
    const available = vi.spyOn(renderModule, 'ffmpegAvailable').mockResolvedValue(true);
    expect((await api(server.baseUrl, 'GET', '/api/posts/reel/status', { cookie })).json.data).toEqual({ available: true });
    available.mockResolvedValue(false);
    expect((await api(server.baseUrl, 'GET', '/api/posts/reel/status', { cookie })).json.data).toEqual({ available: false });
    const res = await api(server.baseUrl, 'POST', `/api/posts/${post.id}/reel/script`, { cookie });
    expect(res.status).toBe(503);
    expect(res.json.error).toMatch(/FFmpeg/);
    expect(gemini).not.toHaveBeenCalled();
  });

  it('AI writes a short script from the post text', async () => {
    const { cookie, post, userId } = await setup();
    await saveSettings(userId, { geminiApiKey: 'AIzaFakeKeyReelTest000000000000000000' });
    vi.spyOn(renderModule, 'ffmpegAvailable').mockResolvedValue(true);
    const spy = vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ script: '  Bạn có biết? AI viết email trong mười giây.  ' } as never);
    const res = await api(server.baseUrl, 'POST', `/api/posts/${post.id}/reel/script`, { cookie });
    expect(res.status).toBe(200);
    expect(res.json.data.script).toBe('Bạn có biết? AI viết email trong mười giây.');
    expect(spy.mock.calls[0][0].prompt).toContain('Bài viết dài về email.');
    const empty = await prisma.post.update({ where: { id: post.id }, data: { caption: null } });
    expect((await api(server.baseUrl, 'POST', `/api/posts/${empty.id}/reel/script`, { cookie })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Kill any dev server first (see Global Constraints), then run: `RUN_DB_TESTS=1 npx vitest run tests/reel.db.test.ts`
Expected: FAIL — `reelJobKey` is not exported from `reel.service`; `'render_reel'` is not a `JobType`.

- [ ] **Step 3: The job type**

In `src/lib/job-queue.ts`, add `| 'render_reel'` to the `JobType` union:

```ts
export type JobType = 'publish_post' | 'publish_target' | 'run_schedule' | 'check_page_tokens' | 'prepare_post' | 'schedule_tick' | 'sync_engagement' | 'render_reel';
```

- [ ] **Step 4: Queue, handler and state in `src/services/reel.service.ts`**

Change the `@prisma/client` import to `import type { Job, Post } from '@prisma/client';` and add after the `logger` import:

```ts
import { UnrecoverableJobError, upsertKeyedJob } from '../lib/job-queue';
```

Append to the file:

```ts
// ─── Background job (one per post) ──────────────

export const reelJobKey = (postId: string) => `reel:${postId}`;

interface ReelJobPayload {
  postId: string;
  userId: string;
  script: string;
  voice: EdgeVoice;
}

/** What the dialog shows: waiting for the worker, a step with its percentage, the result, or why it failed. */
export type ReelState =
  | { state: 'idle' }
  | ({ state: 'queued' | 'running' } & ReelProgress)
  | { state: 'done' }
  | { state: 'failed'; error: string };

/** Book the render. One job per post: refused while the previous one waits or runs. */
export async function queueReel(post: Post, input: { script: string; voice: EdgeVoice }): Promise<void> {
  const job = await prisma.job.findUnique({ where: { key: reelJobKey(post.id) } });
  if (job && (job.status === 'PENDING' || job.status === 'RUNNING')) {
    throw new ReelError(409, 'Reel của bài này đang được dựng, hãy chờ xong rồi thử lại.');
  }
  const payload: ReelJobPayload = { postId: post.id, userId: post.userId, script: input.script, voice: input.voice };
  // upsertKeyedJob creates the job with maxAttempts = 1: a failed render is reported, never repeated on its own
  await upsertKeyedJob(reelJobKey(post.id), 'render_reel', { ...payload }, new Date());
}

/**
 * render_reel handler. A failure is final and its message is what the user reads (Job.lastError).
 * A job interrupted by a restart simply runs again: nothing was committed before the last step.
 */
export async function runReelJob(job: Job): Promise<void> {
  const { postId, userId, script, voice } = job.payload as unknown as ReelJobPayload;
  const post = await prisma.post.findFirst({ where: { id: postId, userId } });
  if (!post) return; // deleted while it waited
  try {
    await makeReel(post, { script, voice });
  } catch (error) {
    throw new UnrecoverableJobError(error instanceof ReelError ? error.message : `Dựng Reel thất bại: ${(error as Error).message}`);
  }
}

export async function reelState(postId: string): Promise<ReelState> {
  const job = await prisma.job.findUnique({ where: { key: reelJobKey(postId) } });
  if (!job) return { state: 'idle' };
  if (job.status === 'PENDING') return { state: 'queued', stage: 'voice', percent: 3 };
  // RUNNING with no progress in this process: taken a moment ago, or left by a process that died (recovered within 10 minutes)
  if (job.status === 'RUNNING') return { state: 'running', ...(reelProgress(postId) ?? { stage: 'voice' as const, percent: 5 }) };
  if (job.status === 'FAILED') return { state: 'failed', error: job.lastError ?? 'Dựng Reel thất bại.' };
  return { state: 'done' };
}
```

- [ ] **Step 5: Register the handler**

In `src/services/scheduler.service.ts`, add the import after the `engagement-sync` import:

```ts
import { runReelJob } from './reel.service';
```

and in the `handlers` object inside `startWorkers`, after `sync_engagement: runEngagementSyncJob,`:

```ts
    render_reel: runReelJob,
```

- [ ] **Step 6: Routes**

In `src/routes/reel.routes.ts`:

Replace the service import with:

```ts
import { queueReel, reelState, ReelError, writeReelScript } from '../services/reel.service';
```

Replace the `/:id/reel/progress` route with:

```ts
/** Polled by the dialog: waiting, the step with its percentage, the finished video, or why it failed. */
router.get(
  '/:id/reel/progress',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await prisma.post.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
    if (!post) throw createError(404, 'Post not found');
    const state = await reelState(post.id);
    const data =
      state.state === 'done'
        ? { ...state, video: videoState(post), reelScript: (post.inputData as Record<string, string> | null)?.reelScript ?? null }
        : state;
    res.json({ success: true, data });
  })
);
```

Replace the `/:id/reel` route with:

```ts
/** Books the render (a background job) and answers at once; the dialog then polls /reel/progress. */
router.post(
  '/:id/reel',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { script, voice } = reelSchema.parse(req.body ?? {});
    const post = await findImageEditablePost(req);
    if (countSpokenWords(script) < MIN_WORDS) throw createError(400, `Kịch bản cần ít nhất ${MIN_WORDS} từ.`);
    if (!(await renderer.ffmpegAvailable())) throw createError(503, NO_FFMPEG);
    try {
      await queueReel(post, { script, voice });
    } catch (error) {
      if (error instanceof ReelError) throw createError(error.status, error.message);
      throw error;
    }
    res.status(202).json({ success: true, data: { state: 'queued' } });
  })
);
```

Change `NO_FFMPEG` to:

```ts
const NO_FFMPEG = 'Máy chủ chưa chạy được FFmpeg nên chưa dựng được Reel. Báo quản trị viên kiểm tra /cron/reel-check.';
```

In `src/routes/posts.routes.ts`, add to the imports:

```ts
import { removeKeyedJob } from '../lib/job-queue';
import { reelJobKey } from '../services/reel.service';
```

and in the delete route, after `await removeReelBackground(post.id);`:

```ts
    await removeKeyedJob(reelJobKey(post.id));
```

- [ ] **Step 7: Run the tests**

Run: `npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run tests/reel.db.test.ts tests/isolation.db.test.ts tests/job-queue.db.test.ts`
Expected: typecheck clean; all pass.

- [ ] **Step 8: Commit**

```bash
git add src/lib/job-queue.ts src/services/reel.service.ts src/services/scheduler.service.ts src/routes/reel.routes.ts src/routes/posts.routes.ts tests/reel.db.test.ts
git commit -m "feat(reel): render in a background job, one per post"
```

---

### Task 3: The dialog queues, polls and resumes

**Files:**
- Modify: `client/src/api.ts` (`postsApi.reelProgress`, `postsApi.makeReel`), `client/src/components/ReelMaker.tsx`

**Interfaces:**
- Consumes: Task 2's routes.
- Produces: nothing used by other tasks.

- [ ] **Step 1: API types**

In `client/src/api.ts`, above `export const REEL_VOICES`, add:

```ts
export type ReelStage = 'voice' | 'render' | 'saving';
export type ReelState =
  | { state: 'idle' }
  | { state: 'queued' | 'running'; stage: ReelStage; percent: number }
  | { state: 'done'; video: VideoState; reelScript: string | null }
  | { state: 'failed'; error: string };
```

Replace the `reelProgress` and `makeReel` entries of `postsApi` with:

```ts
  /** Where the Reel of this post is: waiting, a step with its percentage, done (with the video) or failed. */
  reelProgress: (id: string) => apiFetch<ReelState>(`/posts/${id}/reel/progress`),

  /** Books the render (a background job, usually 20–60 seconds); follow it with `reelProgress`. */
  makeReel: (id: string, body: { script: string; voice: string }) =>
    apiFetch<{ state: 'queued' }>(`/posts/${id}/reel`, { method: 'POST', body: JSON.stringify(body) }),
```

- [ ] **Step 2: The dialog**

In `client/src/components/ReelMaker.tsx`:

Replace the progress state and its polling effect (from `/** Step and percentage reported by the server` to the end of that `useEffect`) with:

```tsx
  /** Step and percentage reported by the server while the Reel is made */
  const [progress, setProgress] = useState<{ stage: keyof typeof STAGE_LABEL; percent: number }>({ stage: 'voice', percent: 3 });

  // A render started earlier (the tab was closed or reloaded) is picked up again
  useEffect(() => {
    postsApi
      .reelProgress(postId)
      .then((r) => (r.data.state === 'queued' || r.data.state === 'running') && setBusy('render'))
      .catch(() => {});
  }, [postId]);

  // Follow the job once a second until it is done or failed
  useEffect(() => {
    if (busy !== 'render') return;
    let stopped = false;
    const timer = setInterval(() => {
      postsApi
        .reelProgress(postId)
        .then(({ data }) => {
          if (stopped) return;
          if (data.state === 'done') {
            setVideoUrl(assetUrl(data.video.videoUrl));
            if (data.reelScript) setScript(data.reelScript);
            toast.success('Đã dựng xong Reel — xem thử rồi duyệt đăng như bài thường.');
            setBusy(null);
            onDone();
          } else if (data.state === 'failed') {
            toast.error(data.error);
            setBusy(null);
          } else if (data.state === 'idle') {
            setBusy(null);
          } else {
            // never backwards: a late answer must not pull the bar back
            setProgress((p) => (data.percent >= p.percent ? { stage: data.stage, percent: data.percent } : p));
          }
        })
        .catch(() => {}); // a missed poll: the next one answers
    }, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [busy, postId]);
```

Replace the `render` function with:

```tsx
  async function render() {
    setProgress({ stage: 'voice', percent: 3 });
    setStarting(true);
    try {
      await postsApi.makeReel(postId, { script: script.trim(), voice });
      setVideoUrl(null);
      // only now: polling before the job is booked would read the previous Reel's "done"
      setBusy('render');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setStarting(false);
    }
  }
```

Next to the other state, add `const [starting, setStarting] = useState(false);` (a second click while the request is on its way), and change the "Dựng Reel" button's `disabled` to `disabled={!!busy || starting || !!problem}`.

Replace the hint under the progress bar:

```tsx
              <p className="field-hint" role="status">
                {STAGE_LABEL[progress.stage]}
                {progress.stage === 'voice' ? ' Bước này lâu nhất (thường 5–30 giây) và không đo được phần trăm.' : ''} Bạn có thể đóng cửa sổ này; Reel vẫn được dựng tiếp.
              </p>
```

and let the dialog close while rendering: in the `keydown` effect, the overlay's `onMouseDown`, the header's close button and the footer's first button, change the conditions so only `busy === 'script'` blocks closing:

```tsx
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && busy !== 'script' && onClose();
```

```tsx
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && busy !== 'script' && onClose()}>
```

```tsx
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} disabled={busy === 'script'} aria-label="Đóng">
```

```tsx
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy === 'script'}>{videoUrl ? 'Xong' : 'Đóng'}</button>
```

- [ ] **Step 3: Typecheck, lint, build**

Run (from `client/`): `npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b && npm run lint && npx -y -p node@22 -- node node_modules/vite/bin/vite.js build`
Expected: typecheck clean; no lint warning in `ReelMaker.tsx`; build ends with `✓ built in …`.

- [ ] **Step 4: Look at it in the browser (mock API, nothing real is called)**

Use the mock-API method (a read-only mock server and Vite with `VITE_API_ORIGIN` pointing at it, on a port other than 5173 if the user's dev client is running). The mock must answer `POST /api/posts/:id/reel` with `202 { state: 'queued' }` and `GET …/reel/progress` with `queued` → `running` (voice, render with rising percentages, saving) → `done` with a `video`. Check at 390px and 1366px:

1. "Dựng Reel" shows the bar moving through the three steps, then the video.
2. Closing the dialog while it runs and reopening it shows the bar again, not a "Dựng Reel" button that would start a second render.
3. A `failed` state shows the error as a toast and the button is usable again.

- [ ] **Step 5: Commit**

```bash
git add client/src/api.ts client/src/components/ReelMaker.tsx
git commit -m "feat(client): the Reel dialog follows the background job and resumes after a reload"
```

---

### Task 4: Self-check for the host

**Files:**
- Create: `src/lib/reel/self-check.ts`
- Modify: `src/app.ts` (next to `/cron/tick`)
- Test: `tests/reel-render.test.ts`, `tests/app.test.ts`

**Interfaces:**
- Consumes: `edgeTts.synthesize`; `buildAss`, `buildLines`, `displayWords`; `reelRenderer.render`, `ffmpegVersion`, `probeSubtitleFont`; `inspectMp4`, `reelsProblem`; `safeEqual` (`src/lib/crypto.ts`).
- Produces:
  - `reelSelfCheck(): Promise<ReelCheck>` with `interface ReelCheck { ok: boolean; problems: string[]; ffmpeg: string | null; font: string | null; voice: { ms: number; words: number; bytes: number } | null; render: { ms: number; durationSec: number; width: number; height: number; bytes: number } | null; file: Buffer | null }`.
  - `GET /cron/reel-check?key=CRON_SECRET` → the check as JSON without `file`; with `&video=1` → the sample MP4. 404 when `CRON_SECRET` is not set, 401 on a wrong key.

- [ ] **Step 1: Write the failing tests**

In `tests/reel-render.test.ts`, add the imports:

```ts
import { vi } from 'vitest';
import { edgeTts } from '../src/lib/reel/edge-tts';
import { reelSelfCheck } from '../src/lib/reel/self-check';
```

(merge `vi` into the existing `vitest` import) and add inside the `describe`:

```ts
  it('self-check: renders a sample and reports every step', async () => {
    fixtures();
    vi.spyOn(edgeTts, 'synthesize').mockResolvedValue({
      audio: readFileSync(voice),
      words: ['Xin', 'chào', 'đây', 'là', 'video', 'thử'].map((text, i) => ({ text, startMs: i * 600, durationMs: 500 })),
    });
    const check = await reelSelfCheck();
    expect(check.problems).toEqual([]);
    expect(check).toMatchObject({ ok: true, font: 'BeVietnamPro-Bold', voice: { words: 6 }, render: { width: 1080, height: 1920 } });
    expect(check.ffmpeg).toMatch(/^ffmpeg version/);
    expect(check.file!.subarray(4, 8).toString()).toBe('ftyp');
  });

  it('self-check: says which step failed and goes on with the others', async () => {
    vi.spyOn(edgeTts, 'synthesize').mockRejectedValue(new Error('Dịch vụ giọng đọc từ chối kết nối (HTTP 403).'));
    const check = await reelSelfCheck();
    expect(check.ok).toBe(false);
    expect(check.problems).toEqual(['Giọng đọc: Dịch vụ giọng đọc từ chối kết nối (HTTP 403).']);
    expect(check).toMatchObject({ font: 'BeVietnamPro-Bold', voice: null, render: null, file: null });
  });
```

In `tests/app.test.ts`, add the imports:

```ts
import { vi } from 'vitest';
import * as selfCheck from '../src/lib/reel/self-check';
```

(merge `vi` into the existing `vitest` import) and add inside the `describe`:

```ts
  it('/cron/reel-check needs the cron key and returns the check, or the sample video', async () => {
    const check = { ok: true, problems: [], ffmpeg: 'ffmpeg version 7', font: 'BeVietnamPro-Bold', voice: { ms: 1, words: 6, bytes: 3 }, render: { ms: 2, durationSec: 4, width: 1080, height: 1920, bytes: 9 }, file: Buffer.from('....ftypvideo') };
    const run = vi.spyOn(selfCheck, 'reelSelfCheck').mockResolvedValue(check);
    expect((await api(server.baseUrl, 'GET', '/cron/reel-check?key=x')).status).toBe(404);
    process.env.CRON_SECRET = 'cron-key-for-test';
    try {
      expect((await api(server.baseUrl, 'GET', '/cron/reel-check?key=wrong')).status).toBe(401);
      expect(run).not.toHaveBeenCalled();
      const res = await api(server.baseUrl, 'GET', '/cron/reel-check?key=cron-key-for-test');
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ ok: true, font: 'BeVietnamPro-Bold', render: { width: 1080 } });
      expect(res.json.file).toBeUndefined();
      const video = await fetch(`${server.baseUrl}/cron/reel-check?key=cron-key-for-test&video=1`);
      expect(video.headers.get('content-type')).toBe('video/mp4');
      expect(Buffer.from(await video.arrayBuffer()).toString()).toBe('....ftypvideo');
    } finally {
      delete process.env.CRON_SECRET;
    }
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/reel-render.test.ts tests/app.test.ts`
Expected: FAIL — cannot find module `../src/lib/reel/self-check`.

- [ ] **Step 3: Write `src/lib/reel/self-check.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { open, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { edgeTts } from './edge-tts';
import * as renderer from './render';
import { buildAss, buildLines, displayWords } from './subtitles';
import { inspectMp4, reelsProblem } from '../mp4-info';

/**
 * "Can this host make Reels?" — run after a deploy (GET /cron/reel-check). Makes one short sample with the
 * real voice service and the real FFmpeg, touches no post and no database row, and reports every step,
 * so a failure says what is missing (FFmpeg, the font, the voice service, the encoder).
 */

export interface ReelCheck {
  ok: boolean;
  problems: string[];
  ffmpeg: string | null;
  /** Font file libass picked for the subtitles; "BeVietnamPro-Bold" when the bundled font is used */
  font: string | null;
  voice: { ms: number; words: number; bytes: number } | null;
  render: { ms: number; durationSec: number; width: number; height: number; bytes: number } | null;
  /** The sample video */
  file: Buffer | null;
}

const SAMPLE = 'Xin chào, đây là video thử của Auto Post. Phụ đề tiếng Việt có dấu đầy đủ: ă, â, ê, ô, ơ, ư, đ.';
const EXPECTED_FONT = 'BeVietnamPro-Bold';

async function inspectFile(file: string) {
  const { size } = await stat(file);
  const handle = await open(file, 'r');
  try {
    return await inspectMp4({
      size,
      read: async (offset, length) => {
        const buf = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
        if (buf.length) await handle.read(buf, 0, buf.length, offset);
        return buf;
      },
    });
  } finally {
    await handle.close();
  }
}

export async function reelSelfCheck(): Promise<ReelCheck> {
  const check: ReelCheck = { ok: false, problems: [], ffmpeg: null, font: null, voice: null, render: null, file: null };

  check.ffmpeg = await renderer.ffmpegVersion();
  if (!check.ffmpeg) check.problems.push('FFmpeg: không chạy được (gói ffmpeg-static chưa tải được file, hoặc máy chủ không cho chạy).');

  if (check.ffmpeg) {
    check.font = await renderer.probeSubtitleFont();
    if (!check.font) check.problems.push('Phụ đề: FFmpeg không dựng được phụ đề (thiếu libass).');
    else if (check.font !== EXPECTED_FONT) check.problems.push(`Phụ đề: đang dùng font "${check.font}" thay vì Be Vietnam Pro (thiếu thư mục assets/fonts?).`);
  }

  let speech: Awaited<ReturnType<typeof edgeTts.synthesize>> | null = null;
  const voiceStart = Date.now();
  try {
    speech = await edgeTts.synthesize(SAMPLE, 'vi-VN-HoaiMyNeural');
    check.voice = { ms: Date.now() - voiceStart, words: speech.words.length, bytes: speech.audio.length };
    if (!speech.words.length) check.problems.push('Giọng đọc: dịch vụ không trả về mốc thời gian của từng từ.');
  } catch (error) {
    check.problems.push(`Giọng đọc: ${(error as Error).message}`);
  }

  if (check.ffmpeg && speech?.words.length) {
    const out = path.join(os.tmpdir(), `autopost-reel-check-${randomUUID()}.mp4`);
    const renderStart = Date.now();
    try {
      const ass = buildAss(buildLines(displayWords(SAMPLE, speech.words)), { withImage: false });
      await renderer.reelRenderer.render({ audio: speech.audio, ass, outPath: out });
      const info = await inspectFile(out);
      if (!info) throw new Error('file dựng ra không phải MP4 hợp lệ.');
      check.file = await readFile(out);
      check.render = { ms: Date.now() - renderStart, ...info, bytes: check.file.length };
      const problem = reelsProblem(info);
      if (problem) check.problems.push(`Video: ${problem}`);
    } catch (error) {
      check.problems.push(`Dựng video: ${(error as Error).message}`);
    } finally {
      await rm(out, { force: true }).catch(() => {});
    }
  }

  check.ok = check.problems.length === 0;
  return check;
}
```

- [ ] **Step 4: The route**

In `src/app.ts`, add the import:

```ts
import * as reelCheck from './lib/reel/self-check';
```

Inside `createApp`, above the `/cron/tick` route, add a helper and use it in `/cron/tick` in place of its three secret lines:

```ts
  /** /cron/* routes are opened with CRON_SECRET (header x-cron-secret or ?key=) */
  const assertCronKey = (req: express.Request) => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw createError(404, 'Cron routes are disabled (CRON_SECRET not set)');
    const given = String(req.get('x-cron-secret') ?? req.query.key ?? '');
    if (!given || !safeEqual(given, secret)) throw createError(401, 'Invalid cron key');
  };
```

(`/cron/tick` then starts with `assertCronKey(req);`.) After the `/cron/tick` route add:

```ts
  // After a deploy: can this host make Reels? Renders one sample with the real voice service and FFmpeg.
  //   curl -fsS "https://<domain>/cron/reel-check?key=<CRON_SECRET>"            → JSON report
  //   open "https://<domain>/cron/reel-check?key=<CRON_SECRET>&video=1"         → the sample video
  app.get(
    '/cron/reel-check',
    asyncHandler(async (req, res) => {
      assertCronKey(req);
      const { file, ...report } = await reelCheck.reelSelfCheck();
      if (req.query.video === '1' && file) return void res.type('video/mp4').send(file);
      res.status(report.ok ? 200 : 503).json(report);
    })
  );
```

In `tests/app.test.ts`, the existing test `'checks the cron key on /cron/tick'` expects the message `Cron tick is disabled`: if it asserts on the text, change it to match `/CRON_SECRET not set/`. (It asserts on status codes only today; leave it.)

- [ ] **Step 5: Run the tests**

Run: `npx tsc --noEmit && npx vitest run tests/reel-render.test.ts tests/app.test.ts`
Expected: typecheck clean; all pass.

- [ ] **Step 6: Run the real check on this machine (real Edge TTS, real FFmpeg; no database, nothing published)**

Create `scripts/reel-check.ts`:

```ts
import { writeFile } from 'node:fs/promises';
import { reelSelfCheck } from '../src/lib/reel/self-check';

/** Manual run of the host check: npx tsx scripts/reel-check.ts (writes storage/reel-check.mp4) */
async function main() {
  const { file, ...report } = await reelSelfCheck();
  if (file) await writeFile('storage/reel-check.mp4', file);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
main();
```

Run: `npx tsx scripts/reel-check.ts`
Expected: `"ok": true`, `"font": "BeVietnamPro-Bold"`, a `voice` and a `render` block, and `storage/reel-check.mp4` (git-ignored). Extract one frame and look at it: the subtitle must show Vietnamese letters with their marks, not boxes:

```bash
node -e "require('child_process').execFileSync(require('ffmpeg-static'), ['-y','-loglevel','error','-ss','3','-i','storage/reel-check.mp4','-frames:v','1','storage/reel-check.png'])"
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/reel/self-check.ts src/app.ts scripts/reel-check.ts tests/reel-render.test.ts tests/app.test.ts
git commit -m "feat(reel): /cron/reel-check — can this host make Reels?"
```

---

### Task 5: Docs and whole-feature verification

**Files:**
- Modify: `CLAUDE.md` (the "Reels from text" paragraph), `ROADMAP.md` (the "Tạo Reel từ bài" line), `docs/DEPLOY_HOSTINGER.md` (§3, after check 8; §7 troubleshooting table)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: `CLAUDE.md`**

Replace the paragraph that starts `**Reels from text**` with:

```markdown
**Reels from text** ("Tạo Reel từ bài", `src/routes/reel.routes.ts`, `src/services/reel.service.ts`, `src/lib/reel/`): `POST /api/posts/:id/reel` books one keyed job per post (`render_reel`, key `reel:<postId>`, one attempt) and the dialog polls `GET …/reel/progress` (`reelState`: queued → running with a step and percentage → done/failed; the failure text is `Job.lastError`). The job runs `makeReel`: Edge "read aloud" TTS (`edge-tts.ts`, unofficial endpoint) returns MP3 + one time mark per word → `subtitles.ts` (pure) builds karaoke `.ass` → `render.ts` runs FFmpeg → the file goes through `saveUploadedVideo` and becomes the post's video with `videoKind = REEL`, committed only if the post is unchanged since the job started; the post's picture is kept in `STORAGE_DIR/reels` for later renders. Nothing is installed on the host: FFmpeg is the npm package `ffmpeg-static` (`FFMPEG_PATH` overrides), always run with `-threads 2` (libx264 cannot start with default threads on the 64-core shared host), and the subtitle font is `assets/fonts/BeVietnamPro-Bold.ttf` loaded through libass `fontsdir` from the job's temp folder. `GET /cron/reel-check?key=CRON_SECRET` (`self-check.ts`) renders a sample on the host and reports FFmpeg, font, voice and render; `&video=1` returns the sample. Tests replace `edgeTts.synthesize` and `reelRenderer.render`; `tests/reel-render.test.ts` runs the real FFmpeg.
```

- [ ] **Step 2: `ROADMAP.md`**

Replace the line that starts `- 🔄 (2026-10-02) Tạo Reel từ bài (chỉ chạy local)` with (use the real completion date):

```markdown
- ✅ (2026-10-03) Tạo Reel từ bài: AI viết kịch bản ngắn → giọng đọc Edge TTS → phụ đề chạy theo lời → FFmpeg dựng video 9:16 → thành video Reels của bài. Chạy nền qua hàng đợi, có thanh tiến trình; FFmpeg (ffmpeg-static) và font Be Vietnam Pro đi kèm app nên chạy được trên Hostinger; kiểm tra sau deploy bằng `/cron/reel-check` — plans docs/superpowers/plans/2026-10-02-text-to-reel.md, 2026-10-03-reel-on-hostinger.md. Edge TTS là dịch vụ không chính thức: nếu bị chặn, đổi sang Azure Speech.
```

- [ ] **Step 3: `docs/DEPLOY_HOSTINGER.md`**

In §3, after item 8, add:

```markdown
9. **Tạo Reel từ bài**: mở `https://ten-mien/cron/reel-check?key=CRON_SECRET_CUA_BAN` → phải thấy `"ok": true`, `"font": "BeVietnamPro-Bold"`. Thêm `&video=1` để xem video mẫu: phụ đề tiếng Việt phải có dấu đầy đủ. Sau đó thử trên một bài "Chờ duyệt": **Tạo Reel từ bài** → **Dựng Reel**.
```

In the §7 table, add:

```markdown
| `/cron/reel-check` báo "FFmpeg: không chạy được" | Lúc build, gói `ffmpeg-static` chưa tải được file FFmpeg (xem log build), hoặc máy chủ không cho chạy file đó. Redeploy; nếu vẫn lỗi thì tính năng Reel tự ẩn và các phần khác không ảnh hưởng |
| `/cron/reel-check` báo đang dùng font khác | Thiếu thư mục `assets/fonts` trên máy chủ — kiểm tra `DEPLOY_PATHS` trong `scripts/sync-deploy-branch.mjs` có `assets` |
| Dựng Reel báo "Chưa tạo được giọng đọc" liên tục | Microsoft chặn hoặc đổi dịch vụ Edge TTS (không chính thức). Cần đổi nhà cung cấp giọng đọc (Azure Speech) |
```

- [ ] **Step 4: Full suite**

Kill any dev server (the `tsx watch` parent too), confirm nothing listens on port 3000, make sure MariaDB is up, then run:

`npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run`
Expected: typecheck clean; every test file passes.

- [ ] **Step 5: The deploy branch would carry the font**

Run: `git ls-files assets && node -e "const s=require('fs').readFileSync('scripts/sync-deploy-branch.mjs','utf8'); console.log(/'assets',/.test(s))"`
Expected: both font files are listed; `true`. (Do not run `npm run deploy:branch`.)

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md ROADMAP.md docs/DEPLOY_HOSTINGER.md
git commit -m "docs: Reels on Hostinger"
```

- [ ] **Step 7: Hand over**

Tell the user what is verified and what only the host can answer (FFmpeg inside the app process; the build downloading the FFmpeg binary), and that after they ask for merge + deploy the first thing to open is `/cron/reel-check`.

---

## Out of scope

- An official voice provider (Azure Speech F0) — the fallback if Edge TTS gets blocked.
- Cloudflare R2 and Remotion.
- A quota on Reels per member, or a global limit beyond the worker's concurrency of 2.
- The minors left from the first Reel review (whitespace-only AI script, overwrite confirmation, restoring the picture when a Reel is removed, control characters in the script).
