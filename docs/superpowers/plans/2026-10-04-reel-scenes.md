# Reel Scenes and Script Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Reel is made of scenes — each scene has its own spoken text and its own picture, and the picture changes when the voice reaches the scene — and each content domain has its own instructions for how AI writes the Reel script.

**Architecture:** The Reel draft of a post (`Post.reelDraft`: voice + scenes `{ id, text, imagePrompt, image }`) is edited in the dialog and saved through a small draft API; scene pictures are files in `STORAGE_DIR/reels`, made by Cloudflare AI from the scene's image prompt or uploaded. AI writes the scenes with a prompt built from the domain (`ContentDomain.reelInstructions`, audience, voice, rules). At render time the whole script is read once by the voice service; the word marks give each scene's start, and FFmpeg concatenates one still per scene under the karaoke subtitles.

**Tech Stack:** Prisma (two additive columns), Express + zod, Gemini (`GeminiClient.generateJson`), Cloudflare Workers AI (`generateImage`), FFmpeg `concat` filter, React, Vitest.

**Spec:** none — requested in chat on 2026-10-04. The user's answers:

1. Scene pictures: **AI generates them and the user can upload their own** for any scene.
2. **Scenes are reviewed and edited before rendering** (text, image prompt, picture per scene).
3. The script prompt lives **per content domain**; an empty field means the built-in default.

Decisions taken for this plan (the user may overrule them before execution):

4. 1–8 scenes per Reel; AI writes 3–6. The total script keeps the existing limits (5 words minimum, 1500 characters).
5. Scene pictures use the existing layout (the picture on a blurred copy of itself, subtitles underneath) and the existing square image generation; pictures change with a hard cut, no transition.
6. A scene without a picture uses the post's picture (as today); with neither, a plain dark ground.
7. Generating a picture costs one Cloudflare image call of the member's own quota; nothing is generated without a click ("Tạo ảnh AI" on a scene, or "Tạo ảnh cho các cảnh chưa có").
8. "AI viết kịch bản" replaces the scenes (and removes their pictures) after a second click.

A spike on 2026-10-04 rendered three timed stills with `concat` + subtitles with the app's FFmpeg in 4 s; the cuts landed on the given times.

## Global Constraints

- UI copy and API error messages are Vietnamese; code and comments are English. Image prompts are English.
- Schema changes are additive only: `ContentDomain.reelInstructions String? @db.Text`, `Post.reelDraft Json?`. Regenerate `prisma/hostinger-schema.sql` keeping its header.
- Every new route filters by `req.user.id`, returns 404 for another user's post id, and is added to `ROUTE_CASES` in `tests/isolation.db.test.ts`.
- Tests never reach Edge TTS, Gemini, Cloudflare or Facebook: spy on `edgeTts.synthesize`, `reelRenderer.render`, `GeminiClient.prototype.generateJson`, `CloudflareClient.prototype.generateImage` inside each test.
- A test that starts a worker passes `startWorkers({ only: ['render_reel'], pollMs: 200 })`.
- **Before any `RUN_DB_TESTS=1` run and before `npx prisma generate`: kill the `tsx watch` parent of `npm run dev` and the Vite server, and confirm nothing listens on port 3000.** MariaDB must be up; ask the user to start Docker, never start it unprompted.
- Every FFmpeg run keeps `THREADS` and `FILTER_THREADS` (2 threads): the production host refuses more.
- No new dependency.
- Client commands need Node 22: `npx -y -p node@22 -- node …` as in `CLAUDE.md`.
- Public repo: stage files by name, never `git add -A`, never commit `.env*`, `CR/`, `bugs/`, `prompt_creator_video.md`, `STORY_VIDEO_PLAN.pdf`. Work on branch `feature/reel-scenes`. Do not merge, push or deploy without the user asking.

## Review Focus

1. The voice reads a different number of words than the scenes contain (numbers, symbols) → pictures still change at sensible moments, in order, never crash (Task 2 test "shares the time by text length when the counts differ").
2. The user edits scenes while a picture is being generated (or AI rewrites the script) → the finished picture is attached to its scene if it still exists, else discarded; no orphan file (Task 3 test "a picture that finishes after its scene was removed is discarded").
3. Scene pictures and drafts of another member → 404 on every draft and picture route, including the picture file itself (Task 3 isolation entries and test "another member cannot read a scene picture").
4. A post with an old single-script Reel (made before this change) → the dialog opens with one scene holding that script, and rendering it works without touching the draft API (Task 2 test "reads a Reel made before scenes existed"; Task 4 keeps `{ script }` in `POST /reel`).
5. Deleting a post, rewriting the script, or removing a scene → the picture files of the scenes that went away are deleted (Task 3 tests).

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma`, `prisma/hostinger-schema.sql` (modify) | Two additive columns |
| `src/routes/domains.routes.ts`, `client/src/pages/DomainsPage.tsx`, `client/src/api.ts` (modify) | The domain's Reel instructions |
| `src/lib/reel/scenes.ts` (new) | Pure: draft types, validation, merging edits, scene start times |
| `src/lib/reel/script-prompt.ts` (new) | Pure: the prompt AI writes scenes from |
| `src/lib/reel/scene-store.ts` (new) | Scene picture files in `STORAGE_DIR/reels` |
| `src/services/reel-draft.service.ts` (new) | Read/save the draft; ask AI for scenes |
| `src/routes/reel.routes.ts` (rewrite) | Draft, AI script, scene picture routes; render request |
| `src/lib/reel/render.ts`, `src/services/reel.service.ts` (modify) | Several stills in one video; `makeReel` from the draft |
| `src/routes/posts.routes.ts` (modify) | Remove scene pictures with the post |
| `client/src/components/ReelMaker.tsx` (rewrite), `client/src/pages/PostsPage.tsx`, `client/src/index.css` (modify) | Scene editor |
| `tests/reel-scenes.test.ts`, `tests/reel-scenes.db.test.ts` (new); `tests/reel.db.test.ts`, `tests/reel-render.test.ts`, `tests/domains-api.db.test.ts`, `tests/isolation.db.test.ts` (modify) | Tests |
| `CLAUDE.md`, `ROADMAP.md` (modify) | Docs |

---

### Task 1: Schema and the domain's Reel instructions

**Files:**
- Modify: `prisma/schema.prisma` (models `ContentDomain`, `Post`), `prisma/hostinger-schema.sql`, `src/routes/domains.routes.ts` (`domainFields`), `client/src/api.ts` (`ContentDomain`, `DomainInput`), `client/src/pages/DomainsPage.tsx`
- Test: `tests/domains-api.db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ContentDomain.reelInstructions: string | null` (≤ 2000 characters, through `POST`/`PATCH /api/domains`); `Post.reelDraft: Prisma.JsonValue | null`.

- [ ] **Step 1: Branch and commit the plan**

Stop the dev servers first (Global Constraints), then:

```bash
git checkout main && git checkout -b feature/reel-scenes
git add docs/superpowers/plans/2026-10-04-reel-scenes.md
git commit -m "docs: plan for Reel scenes and script prompt"
```

- [ ] **Step 2: Write the failing test**

In `tests/domains-api.db.test.ts`, add inside the `describe` (before its closing `});`):

```ts
  it('keeps the instructions for writing Reel scripts; empty clears them', async () => {
    const { cookie } = await createTestUser();
    const created = (await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('Reel', { reelInstructions: '  Kể một câu chuyện ngắn về dân văn phòng.  ' }) })).json.data;
    expect(created.reelInstructions).toBe('Kể một câu chuyện ngắn về dân văn phòng.');
    const listed = (await api(server.baseUrl, 'GET', '/api/domains', { cookie })).json.data.find((d: { id: string }) => d.id === created.id);
    expect(listed.reelInstructions).toBe('Kể một câu chuyện ngắn về dân văn phòng.');
    const cleared = await api(server.baseUrl, 'PATCH', `/api/domains/${created.id}`, { cookie, body: { reelInstructions: '' } });
    expect(cleared.json.data.reelInstructions).toBeNull();
    const long = await api(server.baseUrl, 'PATCH', `/api/domains/${created.id}`, { cookie, body: { reelInstructions: 'x'.repeat(2001) } });
    expect(long.status).toBe(400);
  });
```

- [ ] **Step 3: Run it to see it fail**

Run: `RUN_DB_TESTS=1 npx vitest run tests/domains-api.db.test.ts -t "Reel scripts"`
Expected: FAIL — `created.reelInstructions` is `undefined`.

- [ ] **Step 4: Schema**

In `prisma/schema.prisma`, in `model ContentDomain`, after the `imageStyle` line add:

```prisma
  reelInstructions String?  @db.Text // how AI writes Reel scripts for this domain; empty = built-in default
```

In `model Post`, after the `inputData Json?` line add:

```prisma
  // "Tạo Reel từ bài": { voice, scenes: [{ id, text, imagePrompt, image }] } (src/lib/reel/scenes.ts)
  reelDraft Json?
```

Apply and regenerate the client and the empty-database SQL:

```bash
npx prisma db push --skip-generate && npx prisma generate
node -e "const fs=require('fs');const cp=require('child_process');const f='prisma/hostinger-schema.sql';const old=fs.readFileSync(f,'utf8');const head=old.slice(0,old.indexOf('-- CreateTable'));const sql=cp.execSync('npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script',{encoding:'utf8'});fs.writeFileSync(f,head+sql.slice(sql.indexOf('-- CreateTable')));"
git diff --stat prisma/hostinger-schema.sql
```

Expected: "Your database is now in sync"; the SQL diff shows two added column lines (`reelInstructions TEXT NULL`, `reelDraft JSON NULL`) and nothing removed.

- [ ] **Step 5: API field**

In `src/routes/domains.routes.ts`, in `domainFields`, after `imageStyle: text(500),` add:

```ts
  reelInstructions: text(2000),
```

- [ ] **Step 6: Run the test**

Run: `npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run tests/domains-api.db.test.ts`
Expected: typecheck clean; all pass.

- [ ] **Step 7: The field in the Lĩnh vực page**

In `client/src/api.ts`, add `reelInstructions: string | null;` to `ContentDomain` (after `imageStyle`) and `reelInstructions?: string | null;` to `DomainInput` (after `imageStyle`).

In `client/src/pages/DomainsPage.tsx`:

- `interface Draft`: add `reelInstructions: string;` after `imageStyle: string;`.
- `EMPTY`: add `reelInstructions: ''`.
- The function that maps a domain to a draft: add `reelInstructions: d.reelInstructions ?? '',` after the `imageStyle` line.
- The `body` object in `save`: add `reelInstructions: draft.reelInstructions,` after `imageStyle: draft.imageStyle,`.
- After the `<fieldset className="domain-block">` that holds "Phong cách ảnh" (after its closing `</fieldset>`), add:

```tsx
              <fieldset className="domain-block">
                <legend>Kịch bản Reel</legend>
                <label htmlFor="d-reel" className="form-label">Hướng dẫn viết kịch bản Reel</label>
                <textarea
                  id="d-reel"
                  className="form-textarea"
                  rows={4}
                  maxLength={2000}
                  value={draft.reelInstructions}
                  onChange={(e) => set('reelInstructions')(e.target.value)}
                  placeholder="VD: Kể một câu chuyện ngắn 60–90 từ về một nhân viên văn phòng. Cảnh đầu là tình huống cụ thể, cảnh giữa là mẹo đã dùng, cảnh cuối là kết quả và một câu hỏi cho người xem."
                />
                <p className="field-hint">Dùng khi bấm "AI viết kịch bản" trong Tạo Reel từ bài. Để trống: mở bằng câu hỏi gây tò mò, một ý chính, lời kêu gọi (40–100 từ).</p>
              </fieldset>
```

Run (from `client/`): `npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b`
Expected: no output, exit code 0.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/hostinger-schema.sql src/routes/domains.routes.ts client/src/api.ts client/src/pages/DomainsPage.tsx tests/domains-api.db.test.ts
git commit -m "feat(domains): instructions for writing Reel scripts; Post.reelDraft column"
```

---

### Task 2: Scenes and the script prompt (pure)

**Files:**
- Create: `src/lib/reel/scenes.ts`, `src/lib/reel/script-prompt.ts`
- Test: `tests/reel-scenes.test.ts`

**Interfaces:**
- Consumes: `countSpokenWords`, `ReelWord` from `src/lib/reel/subtitles.ts`.
- Produces (from `scenes.ts`):
  - `interface ReelScene { id: string; text: string; imagePrompt: string; image: string | null }`, `interface ReelDraft { voice: string; scenes: ReelScene[] }`
  - `MAX_SCENES = 8`, `MAX_SCRIPT_CHARS = 1500`, `MIN_WORDS = 5`, `DEFAULT_VOICE = 'vi-VN-HoaiMyNeural'`
  - `draftScript(scenes: Array<{ text: string }>): string`
  - `draftProblem(scenes: Array<{ text: string }>): string | null`
  - `parseDraft(raw: unknown, legacyScript?: string | null, legacyVoice?: string | null): ReelDraft`
  - `mergeScenes(current: ReelScene[], incoming: Array<{ id?: string; text: string; imagePrompt?: string }>, newId: () => string): { scenes: ReelScene[]; dropped: string[] }`
  - `sceneStarts(texts: string[], words: ReelWord[]): number[]`
- Produces (from `script-prompt.ts`):
  - `DEFAULT_REEL_INSTRUCTIONS: string`
  - `buildReelScriptPrompt(input: { caption: string; domain?: ReelPromptDomain | null }): { systemInstruction: string; prompt: string }` with `interface ReelPromptDomain { name: string; audience?: string | null; voice?: string | null; rules?: string | null; reelInstructions?: string | null }`
  - `cleanScenes(raw: Array<{ text?: string; image_prompt?: string }>): Array<{ text: string; imagePrompt: string }>`

- [ ] **Step 1: Write the failing test**

Create `tests/reel-scenes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { draftProblem, draftScript, mergeScenes, parseDraft, sceneStarts, type ReelScene } from '../src/lib/reel/scenes';
import { buildReelScriptPrompt, cleanScenes, DEFAULT_REEL_INSTRUCTIONS } from '../src/lib/reel/script-prompt';
import type { ReelWord } from '../src/lib/reel/subtitles';

const scene = (id: string, text: string, image: string | null = null): ReelScene => ({ id, text, imagePrompt: `prompt ${id}`, image });
/** Words 300 ms long, back to back from 0 */
const marks = (n: number): ReelWord[] => Array.from({ length: n }, (_, i) => ({ text: `w${i}`, startMs: i * 300, durationMs: 300 }));

describe('draft', () => {
  it('the script is the scenes read one after another', () => {
    expect(draftScript([{ text: ' Bạn có biết? ' }, { text: '' }, { text: 'Thử ngay!' }])).toBe('Bạn có biết? Thử ngay!');
  });

  it('says what stops a draft from being rendered', () => {
    expect(draftProblem([])).toBe('Kịch bản chưa có cảnh nào.');
    expect(draftProblem([{ text: 'Một hai ba bốn năm' }, { text: ' — ' }])).toBe('Cảnh 2 chưa có lời đọc.');
    expect(draftProblem([{ text: 'Xin chào bạn' }])).toBe('Kịch bản cần ít nhất 5 từ.');
    expect(draftProblem(Array.from({ length: 9 }, () => ({ text: 'một hai' })))).toBe('Tối đa 8 cảnh.');
    expect(draftProblem([{ text: 'chữ '.repeat(400) }])).toMatch(/tối đa 1500 ký tự/);
    expect(draftProblem([{ text: 'Một hai ba' }, { text: 'bốn năm sáu' }])).toBeNull();
  });

  it('reads a saved draft and ignores anything malformed in it', () => {
    const draft = parseDraft({ voice: 'vi-VN-NamMinhNeural', scenes: [{ id: 'aaaaaaaa', text: 'Một', imagePrompt: 'an office', image: 'p.aaaaaaaa-1.png' }, { id: 5 }, 'x', { id: 'bbbbbbbb', text: 'Hai' }] });
    expect(draft).toEqual({
      voice: 'vi-VN-NamMinhNeural',
      scenes: [
        { id: 'aaaaaaaa', text: 'Một', imagePrompt: 'an office', image: 'p.aaaaaaaa-1.png' },
        { id: 'bbbbbbbb', text: 'Hai', imagePrompt: '', image: null },
      ],
    });
  });

  it('reads a Reel made before scenes existed as one scene', () => {
    expect(parseDraft(null, 'Kịch bản cũ của bài.', 'vi-VN-NamMinhNeural')).toEqual({
      voice: 'vi-VN-NamMinhNeural',
      scenes: [{ id: '00000000', text: 'Kịch bản cũ của bài.', imagePrompt: '', image: null }],
    });
    expect(parseDraft(undefined)).toEqual({ voice: 'vi-VN-HoaiMyNeural', scenes: [] });
  });
});

describe('mergeScenes', () => {
  const current = [scene('aaaaaaaa', 'Một', 'p.aaaaaaaa-1.png'), scene('bbbbbbbb', 'Hai', 'p.bbbbbbbb-1.png'), scene('cccccccc', 'Ba')];
  let n = 0;
  const newId = () => `new0000${++n}`;

  it('keeps the picture of a scene that is still there, in the new order, and reports the pictures to delete', () => {
    n = 0;
    const { scenes, dropped } = mergeScenes(current, [{ id: 'cccccccc', text: 'Ba mới' }, { text: 'Bốn', imagePrompt: 'a desk' }, { id: 'aaaaaaaa', text: 'Một', imagePrompt: 'changed' }], newId);
    expect(scenes).toEqual([
      { id: 'cccccccc', text: 'Ba mới', imagePrompt: 'prompt cccccccc', image: null },
      { id: 'new00001', text: 'Bốn', imagePrompt: 'a desk', image: null },
      { id: 'aaaaaaaa', text: 'Một', imagePrompt: 'changed', image: 'p.aaaaaaaa-1.png' },
    ]);
    expect(dropped).toEqual(['p.bbbbbbbb-1.png']);
  });

  it('an unknown or repeated id is a new scene', () => {
    n = 0;
    const { scenes } = mergeScenes(current, [{ id: 'aaaaaaaa', text: 'x' }, { id: 'aaaaaaaa', text: 'y' }, { id: 'zzzzzzzz', text: 'z' }], newId);
    expect(scenes.map((s) => [s.id, s.image])).toEqual([['aaaaaaaa', 'p.aaaaaaaa-1.png'], ['new00001', null], ['new00002', null]]);
  });
});

describe('sceneStarts', () => {
  it('a scene starts at its first spoken word', () => {
    // 4 words, 2 words, 3 words
    expect(sceneStarts(['Bạn mất bao lâu?', 'Thử ngay!', '— Cảm ơn bạn'], marks(9))).toEqual([0, 1200, 1800]);
    expect(sceneStarts(['Một cảnh duy nhất'], marks(4))).toEqual([0]);
    expect(sceneStarts([], marks(3))).toEqual([]);
  });

  it('shares the time by text length when the counts differ', () => {
    // 3 tokens in the scenes, 5 marks from the voice (it split a number): the voice ends at 1500 ms
    expect(sceneStarts(['aaaa bbbb', 'cc'], marks(5))).toEqual([0, 1227]);
    // never out of order, never past the end
    const starts = sceneStarts(['a', 'b', 'c'], marks(7));
    expect(starts).toEqual([...starts].sort((x, y) => x - y));
    expect(starts[2]).toBeLessThan(2100);
  });

  it('copes with no word marks at all', () => {
    expect(sceneStarts(['a b', 'c d'], [])).toEqual([0, 0]);
  });
});

describe('Reel script prompt', () => {
  it('uses the built-in instructions without a domain', () => {
    const { systemInstruction, prompt } = buildReelScriptPrompt({ caption: '  Bài viết về email.  ' });
    expect(systemInstruction).toContain('3 đến 6 cảnh');
    expect(systemInstruction).toContain('image_prompt');
    expect(systemInstruction).toContain(DEFAULT_REEL_INSTRUCTIONS);
    expect(systemInstruction).not.toContain('Lĩnh vực:');
    expect(prompt).toBe('Bài viết:\nBài viết về email.\n\nViết kịch bản Reels theo từng cảnh.');
  });

  it("uses the domain's audience, voice, rules and its own instructions", () => {
    const { systemInstruction } = buildReelScriptPrompt({
      caption: 'x',
      domain: { name: 'AI văn phòng', audience: 'Dân văn phòng', voice: 'Thân thiện', rules: 'Không dùng từ tiếng Anh', reelInstructions: '  Kể một câu chuyện ngắn.  ' },
    });
    expect(systemInstruction).toContain('Lĩnh vực: AI văn phòng');
    expect(systemInstruction).toContain('Đối tượng: Dân văn phòng');
    expect(systemInstruction).toContain('Giọng văn: Thân thiện');
    expect(systemInstruction).toContain('Quy tắc: Không dùng từ tiếng Anh');
    expect(systemInstruction).toContain('Cách viết kịch bản:\nKể một câu chuyện ngắn.');
    expect(systemInstruction).not.toContain(DEFAULT_REEL_INSTRUCTIONS);
  });

  it('a domain with no instructions of its own gets the built-in ones', () => {
    expect(buildReelScriptPrompt({ caption: 'x', domain: { name: 'A', reelInstructions: '   ' } }).systemInstruction).toContain(DEFAULT_REEL_INSTRUCTIONS);
  });

  it('cleans what the model returns', () => {
    expect(cleanScenes([{ text: '  Bạn   có biết?\n', image_prompt: ' an office  at night ' }, { text: '   ' }, { image_prompt: 'x' }, { text: 'Thử ngay!' }])).toEqual([
      { text: 'Bạn có biết?', imagePrompt: 'an office at night' },
      { text: 'Thử ngay!', imagePrompt: '' },
    ]);
    expect(cleanScenes(Array.from({ length: 12 }, (_, i) => ({ text: `Cảnh ${i}` })))).toHaveLength(8);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/reel-scenes.test.ts`
Expected: FAIL — cannot find module `../src/lib/reel/scenes`.

- [ ] **Step 3: Write `src/lib/reel/scenes.ts`**

```ts
import { countSpokenWords, type ReelWord } from './subtitles';

/**
 * The scenes of a Reel: pure data work, no I/O (tested from tests/reel-scenes.test.ts).
 * A scene is a piece of the spoken script with its own picture; the picture changes when the voice reaches the scene.
 */

export interface ReelScene {
  /** 8 hex characters; also part of the scene's picture file name */
  id: string;
  /** What the voice reads */
  text: string;
  /** English description the picture is generated from */
  imagePrompt: string;
  /** File name in STORAGE_DIR/reels (scene-store.ts), or null: the post's picture is used */
  image: string | null;
}

/** Stored in Post.reelDraft */
export interface ReelDraft {
  voice: string;
  scenes: ReelScene[];
}

export const MAX_SCENES = 8;
/** One request to the voice service; about 90 seconds of Vietnamese speech */
export const MAX_SCRIPT_CHARS = 1500;
export const MIN_WORDS = 5;
export const DEFAULT_VOICE = 'vi-VN-HoaiMyNeural';
/** Id of the single scene a pre-scenes Reel is read as */
const LEGACY_SCENE_ID = '00000000';

/** What the voice reads: the scenes one after another */
export const draftScript = (scenes: Array<{ text: string }>) =>
  scenes
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(' ');

/** Why these scenes cannot be rendered (shown to the user); null = fine */
export function draftProblem(scenes: Array<{ text: string }>): string | null {
  if (!scenes.length) return 'Kịch bản chưa có cảnh nào.';
  if (scenes.length > MAX_SCENES) return `Tối đa ${MAX_SCENES} cảnh.`;
  const script = draftScript(scenes);
  if (script.length > MAX_SCRIPT_CHARS) return `Kịch bản tối đa ${MAX_SCRIPT_CHARS} ký tự (đang ${script.length}).`;
  const silent = scenes.findIndex((s) => countSpokenWords(s.text) === 0);
  if (silent !== -1 && scenes.length > 1) return `Cảnh ${silent + 1} chưa có lời đọc.`;
  if (countSpokenWords(script) < MIN_WORDS) return `Kịch bản cần ít nhất ${MIN_WORDS} từ.`;
  return null;
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/**
 * Post.reelDraft as stored, tolerant of anything malformed. A post whose Reel was made before
 * scenes existed has no draft: its script (inputData.reelScript) becomes one scene.
 */
export function parseDraft(raw: unknown, legacyScript?: string | null, legacyVoice?: string | null): ReelDraft {
  const stored = raw && typeof raw === 'object' ? (raw as { voice?: unknown; scenes?: unknown }) : null;
  if (stored && Array.isArray(stored.scenes)) {
    const scenes = stored.scenes
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && typeof (s as { id?: unknown }).id === 'string')
      .map((s) => ({ id: s.id as string, text: text(s.text), imagePrompt: text(s.imagePrompt), image: typeof s.image === 'string' ? s.image : null }));
    return { voice: text(stored.voice) || DEFAULT_VOICE, scenes };
  }
  const script = (legacyScript ?? '').trim();
  return {
    voice: legacyVoice || DEFAULT_VOICE,
    scenes: script ? [{ id: LEGACY_SCENE_ID, text: script, imagePrompt: '', image: null }] : [],
  };
}

/**
 * The scenes as edited in the dialog, applied to the stored ones: a scene that kept its id keeps its
 * picture (and its image prompt when none is sent); anything else is a new scene.
 * `dropped`: picture files of scenes that are gone.
 */
export function mergeScenes(
  current: ReelScene[],
  incoming: Array<{ id?: string; text: string; imagePrompt?: string }>,
  newId: () => string
): { scenes: ReelScene[]; dropped: string[] } {
  const left = new Map(current.map((s) => [s.id, s]));
  const scenes = incoming.map((s) => {
    const old = s.id ? left.get(s.id) : undefined;
    if (old) left.delete(old.id);
    return { id: old?.id ?? newId(), text: s.text, imagePrompt: s.imagePrompt ?? old?.imagePrompt ?? '', image: old?.image ?? null };
  });
  return { scenes, dropped: [...left.values()].flatMap((s) => (s.image ? [s.image] : [])) };
}

/**
 * When each scene starts, in ms from the start of the voice. The voice reads all scenes in one go and
 * reports a mark per spoken word: a scene starts at its first word. When the voice counted the words
 * differently (it splits numbers, reads symbols), the time is shared by text length instead.
 */
export function sceneStarts(texts: string[], words: ReelWord[]): number[] {
  if (!texts.length) return [];
  const last = words[words.length - 1];
  const end = last ? last.startMs + last.durationMs : 0;
  const counts = texts.map(countSpokenWords);
  const starts = [0];
  if (counts.reduce((a, b) => a + b, 0) === words.length) {
    let offset = 0;
    for (let i = 1; i < texts.length; i++) {
      offset += counts[i - 1];
      starts.push(words[offset]?.startMs ?? end);
    }
    return starts;
  }
  const lengths = texts.map((t) => t.length || 1);
  const total = lengths.reduce((a, b) => a + b, 0);
  let before = 0;
  for (let i = 1; i < texts.length; i++) {
    before += lengths[i - 1];
    starts.push(Math.round((end * before) / total));
  }
  return starts;
}
```

- [ ] **Step 4: Write `src/lib/reel/script-prompt.ts`**

```ts
import { MAX_SCENES } from './scenes';

/** The prompt AI writes a Reel's scenes from (pure; tested from tests/reel-scenes.test.ts). */

export interface ReelPromptDomain {
  name: string;
  audience?: string | null;
  voice?: string | null;
  rules?: string | null;
  /** The member's own "how to write Reel scripts" for this domain; empty = DEFAULT_REEL_INSTRUCTIONS */
  reelInstructions?: string | null;
}

export const DEFAULT_REEL_INSTRUCTIONS = [
  '- Tổng cộng 40 đến 100 từ, đọc lên trong 20–40 giây.',
  '- Cảnh đầu là một câu hỏi hoặc một tình huống gây tò mò; các cảnh giữa nói một ý chính; cảnh cuối kêu gọi hành động.',
  '- Câu ngắn, văn nói tự nhiên.',
].join('\n');

export function buildReelScriptPrompt(input: { caption: string; domain?: ReelPromptDomain | null }): { systemInstruction: string; prompt: string } {
  const d = input.domain;
  const lines = [
    'Bạn viết kịch bản lời đọc cho video Reels dọc trên Facebook, bằng tiếng Việt.',
    'Chia kịch bản thành 3 đến 6 cảnh. Mỗi cảnh gồm:',
    '- text: lời đọc của cảnh, 1–2 câu. Không hashtag, không emoji, không đường link, không gạch đầu dòng.',
    '- image_prompt: mô tả bằng tiếng Anh một hình minh hoạ cho đúng cảnh đó (bối cảnh, nhân vật, hành động). Không có chữ trong hình.',
    'Chỉ dùng thông tin có trong bài viết được cung cấp.',
  ];
  if (d) {
    lines.push('', `Lĩnh vực: ${d.name}`);
    if (d.audience?.trim()) lines.push(`Đối tượng: ${d.audience.trim()}`);
    if (d.voice?.trim()) lines.push(`Giọng văn: ${d.voice.trim()}`);
    if (d.rules?.trim()) lines.push(`Quy tắc: ${d.rules.trim()}`);
  }
  lines.push('', 'Cách viết kịch bản:', d?.reelInstructions?.trim() || DEFAULT_REEL_INSTRUCTIONS);
  return { systemInstruction: lines.join('\n'), prompt: `Bài viết:\n${input.caption.trim()}\n\nViết kịch bản Reels theo từng cảnh.` };
}

const oneLine = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** The model's scenes, tidied: one line each, empty ones dropped, at most MAX_SCENES */
export function cleanScenes(raw: Array<{ text?: string; image_prompt?: string }>): Array<{ text: string; imagePrompt: string }> {
  return raw
    .map((s) => ({ text: oneLine(s.text), imagePrompt: oneLine(s.image_prompt) }))
    .filter((s) => s.text)
    .slice(0, MAX_SCENES);
}
```

- [ ] **Step 5: Run the tests**

Run: `npx tsc --noEmit && npx vitest run tests/reel-scenes.test.ts`
Expected: typecheck clean; PASS (13 tests). In "says what stops a draft", a single scene of 3 words reports the 5-word rule, not "chưa có lời đọc".

- [ ] **Step 6: Commit**

```bash
git add src/lib/reel/scenes.ts src/lib/reel/script-prompt.ts tests/reel-scenes.test.ts
git commit -m "feat(reel): scenes (draft, merge, start times) and the script prompt"
```

---

### Task 3: Draft, AI scenes and scene pictures — API

**Files:**
- Create: `src/lib/reel/scene-store.ts`, `src/services/reel-draft.service.ts`, `tests/reel-scenes.db.test.ts`
- Modify: `src/routes/reel.routes.ts` (rewritten), `src/services/reel.service.ts` (remove `writeReelScript` and its Gemini imports), `src/routes/posts.routes.ts` (delete route), `tests/reel.db.test.ts` (remove the test `'AI writes a short script from the post text'`), `tests/isolation.db.test.ts`

**Interfaces:**
- Consumes: Task 2's `scenes.ts` and `script-prompt.ts`; `generateImage`, `cloudflareConfigFrom` (`src/services/image.service.ts`); `imageStyleOf` (`src/services/post-writer.ts`); `styledImagePrompt` (`src/lib/compose-prompt.ts`); `detectImageMime`, `MAX_IMAGE_BYTES`, `ImageMime` (`src/lib/image-store.ts`); `REEL_DIR` (`src/lib/reel/background-store.ts`); `findImageEditablePost` (`src/routes/posts.routes.ts`).
- Produces:
  - `saveSceneImage(postId, sceneId, buffer): Promise<string>` (the file name), `readSceneImage(postId, fileName): Promise<{ buffer: Buffer; mime: ImageMime } | null>`, `removeSceneImage(postId, fileName): Promise<void>`, `removeSceneImages(postId): Promise<void>`
  - `readDraft(post: Pick<Post, 'reelDraft' | 'inputData'>): ReelDraft`, `saveDraft(postId: string, draft: ReelDraft): Promise<void>`, `writeReelScenes(gemini: { apiKey: string; model: string }, post: Pick<Post, 'caption' | 'domainId'>): Promise<Array<{ text: string; imagePrompt: string }>>`
  - Routes (all under `/api/posts`), each answering `{ success, data: DraftView }` with `DraftView = { voice: string; scenes: Array<{ id; text; imagePrompt; imageUrl: string | null }> }` unless noted:
    - `GET /:id/reel/draft`
    - `PUT /:id/reel/draft` body `{ voice?, scenes: [{ id?, text, imagePrompt? }] }`
    - `POST /:id/reel/script` (AI writes the scenes and replaces the draft)
    - `POST /:id/reel/scenes/:sceneId/image/generate`
    - `POST /:id/reel/scenes/:sceneId/image/upload` (multipart field `image`)
    - `DELETE /:id/reel/scenes/:sceneId/image`
    - `GET /:id/reel/scenes/:sceneId/image` → the picture bytes

- [ ] **Step 1: Write the failing test**

Create `tests/reel-scenes.db.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { GeminiClient } from '../src/lib/clients/gemini';
import { CloudflareClient } from '../src/lib/clients/cloudflare';
import * as renderModule from '../src/lib/reel/render';
import { REEL_DIR } from '../src/lib/reel/background-store';
import { saveSettings } from '../src/lib/settings';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('scene picture')]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('uploaded')]);
const made: string[] = [];
const sceneFiles = async (postId: string) => (existsSync(REEL_DIR) ? (await readdir(REEL_DIR)).filter((n) => n.startsWith(`${postId}.`) && !n.endsWith('.bg')) : []);

async function setup() {
  const { user, cookie } = await createTestUser();
  await saveSettings(user.id, { geminiApiKey: 'AIzaFakeKeyReelScenes0000000000000000', cfAccountId: 'acc-reel-scenes', cfApiToken: 'cf-fake-token-reel-scenes' });
  const domain = await prisma.contentDomain.create({
    data: { userId: user.id, name: `AI văn phòng ${Math.random()}`, audience: 'Dân văn phòng', voice: 'Thân thiện', imageStyle: 'flat illustration', reelInstructions: 'Kể một câu chuyện ngắn.' },
  });
  const page = await prisma.facebookPage.create({ data: { userId: user.id, pageId: `RSC_${Date.now()}_${Math.random()}`, pageName: 'P', pageAccessToken: 'EAAfaketokenreelscenesxxxxxxxxxxxxx' } });
  const post = await prisma.post.create({ data: { userId: user.id, pageId: page.id, domainId: domain.id, caption: 'Bài viết dài về email.', status: 'READY' } });
  made.push(post.id);
  return { cookie, post, userId: user.id };
}

const base = (id: string) => `/api/posts/${id}/reel`;
const put = (cookie: string, id: string, scenes: Array<Record<string, unknown>>, voice?: string) => api(server.baseUrl, 'PUT', `${base(id)}/draft`, { cookie, body: { scenes, ...(voice && { voice }) } });
const fakeCloudflare = () => vi.spyOn(CloudflareClient.prototype, 'generateImage').mockResolvedValue({ buffer: PNG, mimeType: 'image/png' } as never);

async function uploadPicture(cookie: string, postId: string, sceneId: string, content: Buffer) {
  const form = new FormData();
  form.append('image', new Blob([content]), 'picture.jpg');
  const res = await fetch(`${server.baseUrl}${base(postId)}/scenes/${sceneId}/image/upload`, { method: 'POST', headers: { Cookie: cookie, 'X-Requested-With': 'autopost' }, body: form });
  return { status: res.status, json: await res.json() };
}

describe.skipIf(!process.env.RUN_DB_TESTS)('Reel scenes', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    for (const id of made) for (const name of existsSync(REEL_DIR) ? (await readdir(REEL_DIR)).filter((n) => n.startsWith(id)) : []) await unlink(path.join(REEL_DIR, name)).catch(() => {});
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('a post has no scenes at first; saved scenes get ids and keep them across edits', async () => {
    const { cookie, post } = await setup();
    expect((await api(server.baseUrl, 'GET', `${base(post.id)}/draft`, { cookie })).json.data).toEqual({ voice: 'vi-VN-HoaiMyNeural', scenes: [] });

    const saved = (await put(cookie, post.id, [{ text: ' Bạn có biết? ', imagePrompt: ' an office ' }, { text: 'Thử ngay!' }], 'vi-VN-NamMinhNeural')).json.data;
    expect(saved.voice).toBe('vi-VN-NamMinhNeural');
    expect(saved.scenes).toEqual([
      { id: expect.stringMatching(/^[0-9a-f]{8}$/), text: 'Bạn có biết?', imagePrompt: 'an office', imageUrl: null },
      { id: expect.stringMatching(/^[0-9a-f]{8}$/), text: 'Thử ngay!', imagePrompt: '', imageUrl: null },
    ]);
    const [a, b] = saved.scenes;
    const edited = (await put(cookie, post.id, [{ id: b.id, text: 'Thử ngay hôm nay!' }, { id: a.id, text: a.text, imagePrompt: 'a desk' }])).json.data;
    expect(edited.scenes.map((s: { id: string }) => s.id)).toEqual([b.id, a.id]);
    expect(edited.voice).toBe('vi-VN-NamMinhNeural');
    expect((await api(server.baseUrl, 'GET', `${base(post.id)}/draft`, { cookie })).json.data).toEqual(edited);
    expect((await put(cookie, post.id, Array.from({ length: 9 }, () => ({ text: 'x' })))).status).toBe(400);
  });

  it('AI writes the scenes from the post with the domain\'s instructions and replaces the draft', async () => {
    const { cookie, post } = await setup();
    vi.spyOn(renderModule, 'ffmpegAvailable').mockResolvedValue(true);
    fakeCloudflare();
    const old = (await put(cookie, post.id, [{ text: 'Cảnh cũ', imagePrompt: 'old' }])).json.data.scenes[0];
    await api(server.baseUrl, 'POST', `${base(post.id)}/scenes/${old.id}/image/generate`, { cookie });
    expect(await sceneFiles(post.id)).toHaveLength(1);

    const gemini = vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({
      scenes: [{ text: ' 5 giờ chiều, sếp gửi file 30 trang. ', image_prompt: 'a tired office worker at dusk' }, { text: '   ' }, { text: 'Thử ngay hôm nay!', image_prompt: 'a smiling worker' }],
    } as never);
    const res = await api(server.baseUrl, 'POST', `${base(post.id)}/script`, { cookie });
    expect(res.status).toBe(200);
    expect(res.json.data.scenes).toEqual([
      { id: expect.any(String), text: '5 giờ chiều, sếp gửi file 30 trang.', imagePrompt: 'a tired office worker at dusk', imageUrl: null },
      { id: expect.any(String), text: 'Thử ngay hôm nay!', imagePrompt: 'a smiling worker', imageUrl: null },
    ]);
    const asked = gemini.mock.calls[0][0];
    expect(asked.prompt).toContain('Bài viết dài về email.');
    expect(asked.systemInstruction).toContain('Giọng văn: Thân thiện');
    expect(asked.systemInstruction).toContain('Cách viết kịch bản:\nKể một câu chuyện ngắn.');
    // the old scene and its picture are gone
    expect(await sceneFiles(post.id)).toEqual([]);
    expect((await api(server.baseUrl, 'GET', `${base(post.id)}/draft`, { cookie })).json.data).toEqual(res.json.data);
  });

  it('AI script: no text in the post is a 400; a model that returns no usable scene is a 502 and the draft stays', async () => {
    const { cookie, post } = await setup();
    vi.spyOn(renderModule, 'ffmpegAvailable').mockResolvedValue(true);
    await put(cookie, post.id, [{ text: 'Giữ nguyên' }]);
    vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ scenes: [{ text: '  ' }] } as never);
    const res = await api(server.baseUrl, 'POST', `${base(post.id)}/script`, { cookie });
    expect(res.status).toBe(502);
    expect((await api(server.baseUrl, 'GET', `${base(post.id)}/draft`, { cookie })).json.data.scenes[0].text).toBe('Giữ nguyên');
    await prisma.post.update({ where: { id: post.id }, data: { caption: null } });
    expect((await api(server.baseUrl, 'POST', `${base(post.id)}/script`, { cookie })).status).toBe(400);
  });

  it('a scene picture is generated from its prompt in the domain\'s style, served to the owner, replaced and removed', async () => {
    const { cookie, post } = await setup();
    const cloudflare = fakeCloudflare();
    const [a, b] = (await put(cookie, post.id, [{ text: 'Một', imagePrompt: 'an office at night' }, { text: 'Hai' }])).json.data.scenes;

    const res = await api(server.baseUrl, 'POST', `${base(post.id)}/scenes/${a.id}/image/generate`, { cookie });
    expect(res.status).toBe(200);
    expect(cloudflare).toHaveBeenCalledWith('flat illustration. an office at night');
    const url: string = res.json.data.scenes[0].imageUrl;
    expect(url).toMatch(new RegExp(`^/api/posts/${post.id}/reel/scenes/${a.id}/image\\?v=\\d+$`));
    const picture = await fetch(server.baseUrl + url, { headers: { Cookie: cookie } });
    expect(picture.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await picture.arrayBuffer()).equals(PNG)).toBe(true);

    // a scene with no prompt cannot be generated
    const none = await api(server.baseUrl, 'POST', `${base(post.id)}/scenes/${b.id}/image/generate`, { cookie });
    expect(none.status).toBe(400);
    expect(none.json.error).toMatch(/mô tả ảnh/);

    // an upload replaces the generated picture: one file per scene
    const uploaded = await uploadPicture(cookie, post.id, a.id, JPG);
    expect(uploaded.status).toBe(200);
    expect(uploaded.json.data.scenes[0].imageUrl).not.toBe(url);
    expect(await sceneFiles(post.id)).toHaveLength(1);
    expect((await uploadPicture(cookie, post.id, a.id, Buffer.from('not a picture'))).status).toBe(400);

    const removed = await api(server.baseUrl, 'DELETE', `${base(post.id)}/scenes/${a.id}/image`, { cookie });
    expect(removed.json.data.scenes[0].imageUrl).toBeNull();
    expect(await sceneFiles(post.id)).toEqual([]);
    expect((await api(server.baseUrl, 'POST', `${base(post.id)}/scenes/ffffffff/image/generate`, { cookie })).status).toBe(404);
  });

  it('removing a scene, or deleting the post, deletes the pictures that went away', async () => {
    const { cookie, post } = await setup();
    fakeCloudflare();
    const [a, b] = (await put(cookie, post.id, [{ text: 'Một', imagePrompt: 'x' }, { text: 'Hai', imagePrompt: 'y' }])).json.data.scenes;
    await api(server.baseUrl, 'POST', `${base(post.id)}/scenes/${a.id}/image/generate`, { cookie });
    await api(server.baseUrl, 'POST', `${base(post.id)}/scenes/${b.id}/image/generate`, { cookie });
    expect(await sceneFiles(post.id)).toHaveLength(2);
    const kept = (await put(cookie, post.id, [{ id: b.id, text: 'Hai' }])).json.data;
    expect(kept.scenes[0].imageUrl).toMatch(/image\?v=/);
    expect(await sceneFiles(post.id)).toHaveLength(1);
    expect((await api(server.baseUrl, 'DELETE', `/api/posts/${post.id}`, { cookie })).status).toBe(200);
    expect(await sceneFiles(post.id)).toEqual([]);
  });

  it('a picture that finishes after its scene was removed is discarded', async () => {
    const { cookie, post } = await setup();
    const [a] = (await put(cookie, post.id, [{ text: 'Một', imagePrompt: 'x' }])).json.data.scenes;
    // the member rewrites the scenes while Cloudflare is still drawing
    vi.spyOn(CloudflareClient.prototype, 'generateImage').mockImplementation(async () => {
      await put(cookie, post.id, [{ text: 'Cảnh khác' }]);
      return { buffer: PNG, mimeType: 'image/png' } as never;
    });
    const res = await api(server.baseUrl, 'POST', `${base(post.id)}/scenes/${a.id}/image/generate`, { cookie });
    expect(res.status).toBe(409);
    expect(await sceneFiles(post.id)).toEqual([]);
  });

  it('another member cannot read a scene picture; a published post cannot be edited', async () => {
    const { cookie, post } = await setup();
    fakeCloudflare();
    const [a] = (await put(cookie, post.id, [{ text: 'Một', imagePrompt: 'x' }])).json.data.scenes;
    const url = (await api(server.baseUrl, 'POST', `${base(post.id)}/scenes/${a.id}/image/generate`, { cookie })).json.data.scenes[0].imageUrl;
    const other = await createTestUser();
    expect((await fetch(server.baseUrl + url, { headers: { Cookie: other.cookie } })).status).toBe(404);
    expect((await api(server.baseUrl, 'GET', `${base(post.id)}/draft`, { cookie: other.cookie })).status).toBe(404);

    await prisma.post.update({ where: { id: post.id }, data: { status: 'PUBLISHED' } });
    expect((await put(cookie, post.id, [{ text: 'x' }])).status).toBe(409);
    // …but its draft and pictures can still be looked at
    expect((await api(server.baseUrl, 'GET', `${base(post.id)}/draft`, { cookie })).status).toBe(200);
    expect((await fetch(server.baseUrl + url, { headers: { Cookie: cookie } })).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `RUN_DB_TESTS=1 npx vitest run tests/reel-scenes.db.test.ts`
Expected: FAIL — `GET …/reel/draft` returns 404.

- [ ] **Step 3: Write `src/lib/reel/scene-store.ts`**

```ts
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { detectImageMime, type ImageMime } from '../image-store';
import { REEL_DIR } from './background-store';

/**
 * Pictures of a Reel's scenes: STORAGE_DIR/reels/<postId>.<sceneId>-<version>.<ext>.
 * (The same folder holds <postId>.bg, the post's own picture kept for the Reel.)
 */

const EXT: Record<ImageMime, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const POST_ID = /^[0-9a-f-]{36}$/i;
const SCENE_ID = /^[0-9a-f]{8}$/;
const FILE_TAIL = /^[0-9a-f]{8}-\d+\.(jpg|png|webp)$/;

/** The stored name belongs to this post and has the shape this module writes (nothing else is ever read or deleted) */
const owns = (postId: string, fileName: string) => POST_ID.test(postId) && fileName.startsWith(`${postId}.`) && FILE_TAIL.test(fileName.slice(postId.length + 1));

/** Stores the picture and returns its file name (kept in the scene's `image`) */
export async function saveSceneImage(postId: string, sceneId: string, buffer: Buffer): Promise<string> {
  if (!POST_ID.test(postId) || !SCENE_ID.test(sceneId)) throw new Error('Invalid scene');
  const mime = detectImageMime(buffer);
  if (!mime) throw new Error('Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP.');
  const fileName = `${postId}.${sceneId}-${Date.now()}.${EXT[mime]}`;
  await mkdir(REEL_DIR, { recursive: true });
  await writeFile(path.join(REEL_DIR, fileName), buffer);
  return fileName;
}

export async function readSceneImage(postId: string, fileName: string): Promise<{ buffer: Buffer; mime: ImageMime } | null> {
  if (!owns(postId, fileName)) return null;
  try {
    const buffer = await readFile(path.join(REEL_DIR, fileName));
    const mime = detectImageMime(buffer);
    return mime ? { buffer, mime } : null;
  } catch {
    return null;
  }
}

export async function removeSceneImage(postId: string, fileName: string): Promise<void> {
  if (owns(postId, fileName)) await unlink(path.join(REEL_DIR, fileName)).catch(() => {});
}

/** Every scene picture of the post (the post is being deleted) */
export async function removeSceneImages(postId: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(REEL_DIR);
  } catch {
    return;
  }
  for (const name of names) await removeSceneImage(postId, name);
}
```

- [ ] **Step 4: Write `src/services/reel-draft.service.ts`**

```ts
import type { Post, Prisma } from '@prisma/client';
import { Type } from '@google/genai';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { GeminiClient } from '../lib/clients/gemini';
import { buildReelScriptPrompt, cleanScenes } from '../lib/reel/script-prompt';
import { parseDraft, type ReelDraft } from '../lib/reel/scenes';

/** The Reel draft of a post (Post.reelDraft) and the AI that writes its scenes. */

export function readDraft(post: Pick<Post, 'reelDraft' | 'inputData'>): ReelDraft {
  const legacy = (post.inputData as Record<string, string> | null) ?? {};
  return parseDraft(post.reelDraft, legacy.reelScript, legacy.reelVoice);
}

export async function saveDraft(postId: string, draft: ReelDraft): Promise<void> {
  const stored = { voice: draft.voice, scenes: draft.scenes.map((s) => ({ ...s })) } as unknown as Prisma.InputJsonObject;
  await prisma.post.update({ where: { id: postId }, data: { reelDraft: stored } });
}

const SCENES_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    scenes: {
      type: Type.ARRAY,
      items: { type: Type.OBJECT, properties: { text: { type: Type.STRING }, image_prompt: { type: Type.STRING } }, required: ['text', 'image_prompt'] },
    },
  },
  required: ['scenes'],
};
const scenesValidator = z.object({ scenes: z.array(z.object({ text: z.string().optional(), image_prompt: z.string().optional() })) });

/** Scenes (spoken text + image prompt) written from the post's text, the way its content domain asks. */
export async function writeReelScenes(
  gemini: { apiKey: string; model: string },
  post: Pick<Post, 'caption' | 'domainId'>
): Promise<Array<{ text: string; imagePrompt: string }>> {
  const domain = post.domainId
    ? await prisma.contentDomain.findUnique({ where: { id: post.domainId }, select: { name: true, audience: true, voice: true, rules: true, reelInstructions: true } })
    : null;
  const { systemInstruction, prompt } = buildReelScriptPrompt({ caption: post.caption ?? '', domain });
  const result = await new GeminiClient(gemini).generateJson({ systemInstruction, prompt, responseSchema: SCENES_SCHEMA, validator: scenesValidator, temperature: 0.8 });
  return cleanScenes(result.scenes);
}
```

- [ ] **Step 5: Remove the old script writer**

In `src/services/reel.service.ts`, delete `SCRIPT_SCHEMA`, `scriptValidator`, `SCRIPT_SYSTEM`, the function `writeReelScript`, and the imports that only they used (`Type` from `@google/genai`, `z` from `zod`, `GeminiClient`).

In `tests/reel.db.test.ts`, delete the whole test `it('AI writes a short script from the post text', …)` (its replacement is in `tests/reel-scenes.db.test.ts`).

- [ ] **Step 6: Replace `src/routes/reel.routes.ts`**

```ts
import { Router, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { getSettings } from '../lib/settings';
import { MAX_IMAGE_BYTES } from '../lib/image-store';
import { styledImagePrompt } from '../lib/compose-prompt';
import { EDGE_VOICES } from '../lib/reel/edge-tts';
import { countSpokenWords } from '../lib/reel/subtitles';
import * as renderer from '../lib/reel/render';
import { MAX_SCENES, MAX_SCRIPT_CHARS, mergeScenes, type ReelDraft, type ReelScene } from '../lib/reel/scenes';
import { readSceneImage, removeSceneImage, saveSceneImage } from '../lib/reel/scene-store';
import { imageStyleOf } from '../services/post-writer';
import { cloudflareConfigFrom, generateImage } from '../services/image.service';
import { queueReel, reelState, ReelError } from '../services/reel.service';
import { readDraft, saveDraft, writeReelScenes } from '../services/reel-draft.service';
import { findImageEditablePost, videoState } from './posts.routes';

/**
 * "Tạo Reel từ bài" (mounted at /api/posts): the draft (scenes: spoken text + picture), AI that writes
 * the scenes, scene pictures (generated or uploaded), and the render request with its progress.
 */

const router = Router();
router.use(authenticate);

const MIN_WORDS = 5;
const NO_FFMPEG = 'Máy chủ chưa chạy được FFmpeg nên chưa dựng được Reel. Báo quản trị viên kiểm tra /cron/reel-check.';
const newSceneId = () => randomUUID().slice(0, 8);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });

/** The picture's URL carries its version, so a replaced picture is never served from the browser cache */
const sceneView = (postId: string, s: ReelScene) => ({
  id: s.id,
  text: s.text,
  imagePrompt: s.imagePrompt,
  imageUrl: s.image ? `/api/posts/${postId}/reel/scenes/${s.id}/image?v=${s.image.slice(s.image.lastIndexOf('-') + 1).split('.')[0]}` : null,
});
const draftView = (postId: string, draft: ReelDraft) => ({ voice: draft.voice, scenes: draft.scenes.map((s) => sceneView(postId, s)) });

async function ownPost(req: AuthRequest) {
  const post = await prisma.post.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
  if (!post) throw createError(404, 'Post not found');
  return post;
}

/**
 * Attach a finished picture to its scene. The draft is read again here: generating takes seconds and
 * the member may have edited or rewritten the scenes meanwhile.
 */
async function attachPicture(postId: string, sceneId: string, buffer: Buffer): Promise<ReelDraft> {
  let file: string;
  try {
    file = await saveSceneImage(postId, sceneId, buffer);
  } catch (error) {
    throw createError(400, (error as Error).message);
  }
  const fresh = await prisma.post.findUnique({ where: { id: postId } });
  const draft = fresh ? readDraft(fresh) : null;
  const scene = draft?.scenes.find((s) => s.id === sceneId);
  if (!draft || !scene) {
    await removeSceneImage(postId, file);
    throw createError(409, 'Cảnh này vừa bị xoá hoặc kịch bản vừa được viết lại. Hãy thử lại trên cảnh hiện có.');
  }
  const old = scene.image;
  scene.image = file;
  await saveDraft(postId, draft);
  if (old) await removeSceneImage(postId, old);
  return draft;
}

/** The scene of an editable post, or 404 */
async function editableScene(req: AuthRequest) {
  const post = await findImageEditablePost(req);
  const draft = readDraft(post);
  const scene = draft.scenes.find((s) => s.id === req.params.sceneId);
  if (!scene) throw createError(404, 'Không tìm thấy cảnh này. Hãy lưu kịch bản rồi thử lại.');
  return { post, draft, scene };
}

/** Can this host make Reels? The client hides the feature when it cannot. */
router.get(
  '/reel/status',
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    res.json({ success: true, data: { available: await renderer.ffmpegAvailable() } });
  })
);

/** Polled by the dialog: waiting, the step with its percentage, the finished video, or why it failed. */
router.get(
  '/:id/reel/progress',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await ownPost(req);
    const state = await reelState(post.id);
    const data =
      state.state === 'done'
        ? { ...state, video: videoState(post), reelScript: (post.inputData as Record<string, string> | null)?.reelScript ?? null }
        : state;
    res.json({ success: true, data });
  })
);

// ─── Draft: the scenes being edited ─────────────

router.get(
  '/:id/reel/draft',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await ownPost(req);
    res.json({ success: true, data: draftView(post.id, readDraft(post)) });
  })
);

const draftSchema = z.object({
  voice: z.enum(EDGE_VOICES).optional(),
  scenes: z
    .array(
      z.object({
        id: z.string().regex(/^[0-9a-f]{8}$/).optional(),
        text: z.string().trim().max(MAX_SCRIPT_CHARS, `Lời đọc của một cảnh tối đa ${MAX_SCRIPT_CHARS} ký tự.`),
        imagePrompt: z.string().trim().max(1000, 'Mô tả ảnh tối đa 1000 ký tự.').optional(),
      })
    )
    .max(MAX_SCENES, `Tối đa ${MAX_SCENES} cảnh.`),
});

/** Save the scenes as edited. Scenes keep their id (and picture); empty texts are fine until rendering. */
router.put(
  '/:id/reel/draft',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = draftSchema.parse(req.body ?? {});
    const post = await findImageEditablePost(req);
    const old = readDraft(post);
    const { scenes, dropped } = mergeScenes(old.scenes, body.scenes, newSceneId);
    const draft: ReelDraft = { voice: body.voice ?? old.voice, scenes };
    await saveDraft(post.id, draft);
    for (const file of dropped) await removeSceneImage(post.id, file);
    res.json({ success: true, data: draftView(post.id, draft) });
  })
);

/** AI writes the scenes from the post's text (the domain's Reel instructions) and replaces the draft. */
router.post(
  '/:id/reel/script',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await findImageEditablePost(req);
    // No AI call (it costs the member's quota) for a Reel this host cannot render
    if (!(await renderer.ffmpegAvailable())) throw createError(503, NO_FFMPEG);
    if (!post.caption?.trim()) throw createError(400, 'Bài chưa có nội dung để viết kịch bản.');
    const settings = await getSettings(req.user!.id);
    let written: Array<{ text: string; imagePrompt: string }>;
    try {
      written = await writeReelScenes({ apiKey: settings.geminiApiKey, model: settings.geminiModel }, post);
    } catch (error) {
      throw createError(502, `AI chưa viết được kịch bản: ${(error as Error).message}`);
    }
    if (!written.length) throw createError(502, 'AI chưa viết được kịch bản: không có cảnh nào có lời đọc. Hãy thử lại.');
    const old = readDraft(post);
    const draft: ReelDraft = { voice: old.voice, scenes: written.map((s) => ({ id: newSceneId(), text: s.text, imagePrompt: s.imagePrompt, image: null })) };
    await saveDraft(post.id, draft);
    for (const s of old.scenes) if (s.image) await removeSceneImage(post.id, s.image);
    res.json({ success: true, data: draftView(post.id, draft) });
  })
);

// ─── Scene pictures ─────────────────────────────

/** One Cloudflare image call of the member's quota, from the scene's prompt in the domain's image style. */
router.post(
  '/:id/reel/scenes/:sceneId/image/generate',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { post, scene } = await editableScene(req);
    if (!scene.imagePrompt.trim()) throw createError(400, 'Cảnh này chưa có mô tả ảnh (tiếng Anh) để AI tạo ảnh.');
    const settings = await getSettings(req.user!.id);
    let buffer: Buffer;
    try {
      buffer = await generateImage({ cloudflare: cloudflareConfigFrom(settings), prompt: styledImagePrompt(await imageStyleOf(post.domainId), scene.imagePrompt) });
    } catch (error) {
      throw createError(502, `Chưa tạo được ảnh: ${(error as Error).message}`);
    }
    res.json({ success: true, data: draftView(post.id, await attachPicture(post.id, scene.id, buffer)) });
  })
);

router.post(
  '/:id/reel/scenes/:sceneId/image/upload',
  (req, res, next) =>
    upload.single('image')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) return next(createError(400, err.code === 'LIMIT_FILE_SIZE' ? 'Ảnh vượt quá 8 MB.' : 'Chỉ gửi một ảnh trong trường "image".'));
      next(err);
    }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const file = (req as AuthRequest & { file?: Express.Multer.File }).file;
    if (!file) throw createError(400, 'Chưa chọn ảnh để tải lên.');
    const { post, scene } = await editableScene(req);
    res.json({ success: true, data: draftView(post.id, await attachPicture(post.id, scene.id, file.buffer)) });
  })
);

router.delete(
  '/:id/reel/scenes/:sceneId/image',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { post, draft, scene } = await editableScene(req);
    const old = scene.image;
    scene.image = null;
    await saveDraft(post.id, draft);
    if (old) await removeSceneImage(post.id, old);
    res.json({ success: true, data: draftView(post.id, draft) });
  })
);

/** The picture itself, to the post's owner only (the session cookie travels with <img> requests). */
router.get(
  '/:id/reel/scenes/:sceneId/image',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await ownPost(req);
    const scene = readDraft(post).scenes.find((s) => s.id === req.params.sceneId);
    const picture = scene?.image ? await readSceneImage(post.id, scene.image) : null;
    if (!picture) throw createError(404, 'Image not found');
    res.setHeader('Content-Type', picture.mime);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(picture.buffer);
  })
);

// ─── Render ─────────────────────────────────────

const reelSchema = z.object({
  script: z.string().trim().min(1, 'Nhập kịch bản lời đọc').max(MAX_SCRIPT_CHARS, `Kịch bản tối đa ${MAX_SCRIPT_CHARS} ký tự`),
  voice: z.enum(EDGE_VOICES).default('vi-VN-HoaiMyNeural'),
});

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

export default router;
```

- [ ] **Step 7: Remove scene pictures with the post; declare the routes**

In `src/routes/posts.routes.ts`, add the import:

```ts
import { removeSceneImages } from '../lib/reel/scene-store';
```

and in the delete route, after `await removeReelBackground(post.id);` add:

```ts
    await removeSceneImages(post.id);
```

In `tests/isolation.db.test.ts`, after the line that starts `'POST /api/posts/:id/reel/script':`, add:

```ts
  'GET /api/posts/:id/reel/draft': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/reel/draft` },
  'PUT /api/posts/:id/reel/draft': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/reel/draft`, body: { scenes: [{ text: 'hack' }] } },
  'POST /api/posts/:id/reel/scenes/:sceneId/image/generate': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/reel/scenes/00000000/image/generate` },
  'POST /api/posts/:id/reel/scenes/:sceneId/image/upload': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/reel/scenes/00000000/image/upload`, body: {} },
  'DELETE /api/posts/:id/reel/scenes/:sceneId/image': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/reel/scenes/00000000/image` },
  'GET /api/posts/:id/reel/scenes/:sceneId/image': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/reel/scenes/00000000/image` },
```

If the upload entry answers 400 instead of 404 (multer rejects the JSON body before the post is looked up), follow what the table already does for `'POST /api/posts/:id/video/upload'` and `'POST /api/posts/:id/image/upload'`: the upload route must look the post up before parsing the body — add, as the first handler of the upload route, `asyncHandler(async (req: AuthRequest, _res: Response, next) => { await editableScene(req).catch(async (e) => { if (e?.statusCode !== 404 || (await prisma.post.count({ where: { id: req.params.id, userId: req.user!.id } }))) return; throw e; }); next(); })` only if the isolation test demands it; otherwise leave the route as written.

- [ ] **Step 8: Run the tests**

Run: `npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run tests/reel-scenes.db.test.ts tests/reel.db.test.ts tests/isolation.db.test.ts`
Expected: typecheck clean; all pass.

- [ ] **Step 9: Commit**

```bash
git add src/lib/reel/scene-store.ts src/services/reel-draft.service.ts src/services/reel.service.ts src/routes/reel.routes.ts src/routes/posts.routes.ts tests/reel-scenes.db.test.ts tests/reel.db.test.ts tests/isolation.db.test.ts
git commit -m "feat(reel): scene draft, AI-written scenes and scene pictures API"
```

---

### Task 4: Render the scenes

**Files:**
- Modify: `src/lib/reel/render.ts` (the `render` function), `src/services/reel.service.ts` (`makeReel`, `queueReel`, `runReelJob`), `src/routes/reel.routes.ts` (the `POST /:id/reel` route)
- Test: `tests/reel-render.test.ts`, `tests/reel.db.test.ts`, `tests/reel-scenes.db.test.ts`

**Interfaces:**
- Consumes: Task 2's `draftScript`, `draftProblem`, `sceneStarts`; Task 3's `readDraft`, `saveDraft`, `readSceneImage`, `removeSceneImage`.
- Produces:
  - `interface RenderScene { image: { buffer: Buffer; mime: ImageMime } | null; startMs: number }` (exported from `render.ts`); `reelRenderer.render` accepts `scenes?: RenderScene[]` (the old `image?` stays, meaning one scene).
  - `makeReel(post: Post, draft: ReelDraft): Promise<Post>`, `queueReel(post: Post): Promise<void>`; the job payload is `{ postId, userId }` and the handler reads the draft when it runs.
  - `POST /api/posts/:id/reel` body `{ script?: string, voice?: string }`: with `script`, the draft becomes one scene with that text (the quick form); without, the saved scenes are rendered. 400 with `draftProblem`'s message when they cannot be.

- [ ] **Step 1: Write the failing tests**

In `tests/reel-render.test.ts`, add inside the FFmpeg `describe` (after the test `'renders a vertical video as long as the voice…'`):

```ts
  /** Average colour of the frame at `seconds` */
  const colourAt = (file: string, seconds: number) => {
    const rgb = execFileSync(FFMPEG, ['-loglevel', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    return { r: rgb[0], g: rgb[1], b: rgb[2] };
  };
  const solid = (colour: string) => {
    const file = path.join(dir, `${colour}.png`);
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${colour}:s=640x640`, '-frames:v', '1', file]);
    return { buffer: readFileSync(file), mime: 'image/png' as const };
  };

  it('shows each scene\'s picture from its start time, then the next one', async () => {
    fixtures();
    const outPath = path.join(dir, 'scenes.mp4');
    const red = solid('red');
    await reelRenderer.render({
      audio: readFileSync(voice),
      ass,
      outPath,
      scenes: [
        { image: red, startMs: 0 },
        { image: solid('green'), startMs: 1500 },
        { image: null, startMs: 2600 },
        // the same picture again: its ground is made once
        { image: red, startMs: 3300 },
      ],
    });
    const info = await inspect(outPath);
    expect(info).toMatchObject({ width: 1080, height: 1920 });
    expect(info!.durationSec).toBeGreaterThanOrEqual(3.5);
    expect(info!.durationSec).toBeLessThanOrEqual(4.6);
    const first = colourAt(outPath, 0.7);
    expect(first.r).toBeGreaterThan(first.g + 40);
    const second = colourAt(outPath, 2.0);
    expect(second.g).toBeGreaterThan(second.r + 40);
    const third = colourAt(outPath, 2.95);
    expect(Math.max(third.r, third.g, third.b)).toBeLessThan(70);
    const fourth = colourAt(outPath, 3.7);
    expect(fourth.r).toBeGreaterThan(fourth.g + 40);
  });
```

In `tests/reel.db.test.ts`, change the three assertions on the render input:

- `expect(input.image).toMatchObject({ mime: 'image/png' });` → `expect(input.scenes).toEqual([{ image: expect.objectContaining({ mime: 'image/png' }), startMs: 0 }]);`
- `expect(render.mock.calls[1][0].image).toMatchObject({ mime: 'image/png' });` → `expect(render.mock.calls[1][0].scenes![0].image).toMatchObject({ mime: 'image/png' });`
- `expect(render.mock.calls[0][0].image).toBeNull();` → `expect(render.mock.calls[0][0].scenes).toEqual([{ image: null, startMs: 0 }]);`

In `tests/reel-scenes.db.test.ts`, add the imports:

```ts
import { writeFile } from 'node:fs/promises';
import { edgeTts } from '../src/lib/reel/edge-tts';
import { reelRenderer } from '../src/lib/reel/render';
import { saveImage } from '../src/lib/image-store';
import { IMAGE_DIR } from '../src/lib/image-store';
import { VIDEO_DIR } from '../src/lib/video-store';
import { startWorkers } from '../src/services/scheduler.service';
import { reelJobKey } from '../src/services/reel.service';
import { tinyMp4 } from './helpers/mp4';
```

(merge `writeFile` into the existing `node:fs/promises` import), start a worker in `beforeAll` and stop it in `afterAll`, and clean the other two folders and the jobs:

```ts
let stopWorker: (() => void) | undefined;
```

```ts
  beforeAll(async () => {
    server = await startTestServer(createApp());
    stopWorker = startWorkers({ pollMs: 200, only: ['render_reel'] });
  });
  afterAll(async () => {
    stopWorker?.();
    for (const id of made) {
      for (const dir of [REEL_DIR, IMAGE_DIR, VIDEO_DIR]) {
        for (const name of existsSync(dir) ? (await readdir(dir)).filter((n) => n.startsWith(id)) : []) await unlink(path.join(dir, name)).catch(() => {});
      }
    }
    await prisma.job.deleteMany({ where: { key: { in: made.map(reelJobKey) } } });
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });
```

and add these tests:

```ts
  /** Wait for the worker to finish the post's Reel job, then return the dialog's state */
  async function rendered(cookie: string, id: string) {
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      const job = await prisma.job.findUnique({ where: { key: reelJobKey(id) } });
      if (job && (job.status === 'DONE' || job.status === 'FAILED')) return (await api(server.baseUrl, 'GET', `${base(id)}/progress`, { cookie })).json.data;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('the reel job did not finish');
  }

  it('renders the saved scenes: one voice request, each scene with its picture and start time', async () => {
    const { cookie, post } = await setup();
    vi.spyOn(renderModule, 'ffmpegAvailable').mockResolvedValue(true);
    fakeCloudflare();
    // the post has a picture of its own: scenes without one use it
    const own = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('post picture')]);
    const stored = await saveImage(post.id, own);
    await prisma.post.update({ where: { id: post.id }, data: { imagePath: stored.imagePath, imageUrl: stored.imageUrl } });

    const [a] = (await put(cookie, post.id, [{ text: 'Bạn mất bao lâu?', imagePrompt: 'x' }, { text: 'Thử ngay hôm nay!' }, { text: 'Cảm ơn bạn.' }], 'vi-VN-NamMinhNeural')).json.data.scenes;
    await api(server.baseUrl, 'POST', `${base(post.id)}/scenes/${a.id}/image/generate`, { cookie });

    // 4 + 4 + 3 words, 300 ms each
    const words = Array.from({ length: 11 }, (_, i) => ({ text: `w${i}`, startMs: i * 300, durationMs: 300 }));
    const voice = vi.spyOn(edgeTts, 'synthesize').mockResolvedValue({ audio: Buffer.from('mp3'), words });
    const render = vi.spyOn(reelRenderer, 'render').mockImplementation(async ({ outPath }) => {
      await writeFile(outPath, tinyMp4({ durationSec: 20, width: 1080, height: 1920 }));
    });

    const res = await api(server.baseUrl, 'POST', base(post.id), { cookie, body: {} });
    expect(res.status).toBe(202);
    const state = await rendered(cookie, post.id);
    expect(state).toMatchObject({ state: 'done', reelScript: 'Bạn mất bao lâu? Thử ngay hôm nay! Cảm ơn bạn.' });
    expect(voice).toHaveBeenCalledTimes(1);
    expect(voice).toHaveBeenCalledWith('Bạn mất bao lâu? Thử ngay hôm nay! Cảm ơn bạn.', 'vi-VN-NamMinhNeural');
    const input = render.mock.calls[0][0];
    expect(input.scenes!.map((s) => s.startMs)).toEqual([0, 1200, 2400]);
    expect(input.scenes![0].image!.buffer.equals(PNG)).toBe(true);
    expect(input.scenes![1].image!.buffer.equals(own)).toBe(true);
    expect(input.scenes![2].image!.buffer.equals(own)).toBe(true);
    // subtitles under the picture, with the script's own words
    expect(input.ass).toMatch(/,2,80,80,430,1$/m);
    expect(input.ass).toContain('lâu?');
    // the scenes stay for the next edit
    expect((await api(server.baseUrl, 'GET', `${base(post.id)}/draft`, { cookie })).json.data.scenes).toHaveLength(3);
  });

  it('refuses to render scenes that are not ready, with the reason', async () => {
    const { cookie, post } = await setup();
    vi.spyOn(renderModule, 'ffmpegAvailable').mockResolvedValue(true);
    const none = await api(server.baseUrl, 'POST', base(post.id), { cookie, body: {} });
    expect(none.status).toBe(400);
    expect(none.json.error).toBe('Kịch bản chưa có cảnh nào.');
    await put(cookie, post.id, [{ text: 'Một hai ba bốn năm' }, { text: '' }]);
    const silent = await api(server.baseUrl, 'POST', base(post.id), { cookie, body: {} });
    expect(silent.status).toBe(400);
    expect(silent.json.error).toBe('Cảnh 2 chưa có lời đọc.');
    expect(await prisma.job.findUnique({ where: { key: reelJobKey(post.id) } })).toBeNull();
  });

  it('the quick form (a whole script) replaces the scenes with one, and drops their pictures', async () => {
    const { cookie, post } = await setup();
    vi.spyOn(renderModule, 'ffmpegAvailable').mockResolvedValue(true);
    fakeCloudflare();
    vi.spyOn(edgeTts, 'synthesize').mockResolvedValue({ audio: Buffer.from('mp3'), words: Array.from({ length: 6 }, (_, i) => ({ text: `w${i}`, startMs: i * 300, durationMs: 300 })) });
    vi.spyOn(reelRenderer, 'render').mockImplementation(async ({ outPath }) => {
      await writeFile(outPath, tinyMp4({ durationSec: 20, width: 1080, height: 1920 }));
    });
    const [a] = (await put(cookie, post.id, [{ text: 'Một', imagePrompt: 'x' }, { text: 'Hai' }])).json.data.scenes;
    await api(server.baseUrl, 'POST', `${base(post.id)}/scenes/${a.id}/image/generate`, { cookie });
    expect((await api(server.baseUrl, 'POST', base(post.id), { cookie, body: { script: 'Một kịch bản thử có sáu từ.' } })).status).toBe(202);
    expect((await rendered(cookie, post.id)).state).toBe('done');
    const draft = (await api(server.baseUrl, 'GET', `${base(post.id)}/draft`, { cookie })).json.data;
    expect(draft.scenes).toEqual([{ id: expect.any(String), text: 'Một kịch bản thử có sáu từ.', imagePrompt: '', imageUrl: null }]);
    expect(await sceneFiles(post.id)).toEqual([]);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/reel-render.test.ts && RUN_DB_TESTS=1 npx vitest run tests/reel.db.test.ts tests/reel-scenes.db.test.ts`
Expected: FAIL — the render test shows the first picture all the way (`scenes` is ignored); the DB tests fail on `input.scenes` being undefined and on `POST /reel` with `{}` answering 400 "Nhập kịch bản lời đọc".

- [ ] **Step 3: Several stills in one video**

In `src/lib/reel/render.ts`, replace the `render` function (from `async function render(input: {` to its closing brace) with:

```ts
export interface RenderScene {
  /** The scene's picture; null = a plain dark ground */
  image: { buffer: Buffer; mime: ImageMime } | null;
  /** When the voice reaches the scene, from the start of the audio */
  startMs: number;
}

/** The picture on a blurred, darkened copy of itself that fills 9:16 */
const GROUND_FILTER =
  '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:4,eq=brightness=-0.28[bg];[0:v]scale=960:-2[fg];[bg][fg]overlay=(W-w)/2:200';

async function render(input: {
  audio: Buffer;
  ass: string;
  /** One still per scene, shown from its start to the next scene's (default: one scene with `image`) */
  scenes?: RenderScene[];
  image?: { buffer: Buffer; mime: ImageMime } | null;
  outPath: string;
  /** Length of the voice; with `onProgress`, the encoded share (0–1) is reported as the video is written */
  durationMs?: number;
  onProgress?: (fraction: number) => void;
}): Promise<void> {
  const scenes: RenderScene[] = input.scenes?.length ? input.scenes : [{ image: input.image ?? null, startMs: 0 }];
  const { dir, assFilter } = await workDir();
  try {
    await writeFile(path.join(dir, 'voice.mp3'), input.audio);
    await writeFile(path.join(dir, 'subs.ass'), input.ass, 'utf8');

    // One still ground per distinct picture: scenes sharing a picture (or having none) share the file.
    // Made once each; blurring every frame of the video would be far slower.
    const grounds = new Map<Buffer | null, string>();
    for (const scene of scenes) {
      const key = scene.image?.buffer ?? null;
      if (grounds.has(key)) continue;
      const n = grounds.size;
      const ground = `ground${n}.png`;
      if (scene.image) {
        const picture = `picture${n}.${EXT[scene.image.mime]}`;
        await writeFile(path.join(dir, picture), scene.image.buffer);
        await run([...FILTER_THREADS, ...THREADS, '-i', picture, '-filter_complex', GROUND_FILTER, ...THREADS, '-frames:v', '1', ground], dir);
      } else {
        await run([...FILTER_THREADS, '-f', 'lavfi', '-i', 'color=c=0x17191F:s=1080x1920', ...THREADS, '-frames:v', '1', ground], dir);
      }
      grounds.set(key, ground);
    }

    // Each scene is its still for as long as it lasts; the last one runs until the voice ends (-shortest)
    const stills = scenes.flatMap((scene, i) => {
      const next = scenes[i + 1];
      const seconds = next ? Math.max(0.1, (next.startMs - scene.startMs) / 1000) : 3600;
      return ['-loop', '1', '-framerate', '30', '-t', seconds.toFixed(3), '-i', grounds.get(scene.image?.buffer ?? null)!];
    });
    const graph =
      scenes.length > 1
        ? `${scenes.map((_, i) => `[${i}:v]`).join('')}concat=n=${scenes.length}:v=1:a=0,${assFilter}[v]`
        : `[0:v]${assFilter}[v]`;

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
      [...(report ? ['-progress', 'pipe:1', '-nostats'] : []), ...FILTER_THREADS, ...stills, '-i', 'voice.mp3',
        '-filter_complex', graph, '-map', '[v]', '-map', `${scenes.length}:a`,
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
```

Run: `npx vitest run tests/reel-render.test.ts`
Expected: PASS, including the older single-picture tests and the self-check tests (they pass `image`, which still means one scene).

- [ ] **Step 4: `makeReel` from the draft**

In `src/services/reel.service.ts`:

Add the imports:

```ts
import { draftScript, sceneStarts, type ReelDraft } from '../lib/reel/scenes';
import { readSceneImage } from '../lib/reel/scene-store';
import { readDraft } from './reel-draft.service';
```

Change the signature and the body of `makeReel` in these places:

- `export async function makeReel(post: Post, input: { script: string; voice: EdgeVoice }): Promise<Post> {` → `export async function makeReel(post: Post, draft: ReelDraft): Promise<Post> {`, and as its first two lines add:

```ts
  const script = draftScript(draft.scenes);
  const voice = draft.voice as EdgeVoice;
```

- `speech = await edgeTts.synthesize(input.script, input.voice);` → `speech = await edgeTts.synthesize(script, voice);`
- Replace the line that builds `ass` with:

```ts
    // Each scene's own picture; a scene without one shows the post's picture (or a plain ground)
    const starts = sceneStarts(draft.scenes.map((s) => s.text), speech.words);
    const scenes = await Promise.all(
      draft.scenes.map(async (s, i) => ({ image: (s.image ? await readSceneImage(post.id, s.image) : null) ?? picture, startMs: starts[i] }))
    );
    const ass = buildAss(buildLines(displayWords(script, speech.words)), { withImage: scenes.some((s) => s.image), font: process.env.REEL_FONT });
```

- In the `renderer.reelRenderer.render({ … })` call, replace `image: picture,` with `scenes,`.
- `inputData: { …, reelScript: input.script, reelVoice: input.voice },` → `inputData: { ...((post.inputData as Record<string, string> | null) ?? {}), reelScript: script, reelVoice: voice },`
- In the `postLog.create` details, `voice: input.voice` → `voice`, and add `scenes: draft.scenes.length`.

Replace `ReelJobPayload`, `queueReel` and `runReelJob` with:

```ts
interface ReelJobPayload {
  postId: string;
  userId: string;
}

/** Book the render of the post's saved scenes. One job per post: refused while the previous one waits or runs. */
export async function queueReel(post: Post): Promise<void> {
  await assertNoReelRunning(post.id);
  const payload: ReelJobPayload = { postId: post.id, userId: post.userId };
  // upsertKeyedJob creates the job with maxAttempts = 1: a failed render is reported, never repeated on its own
  await upsertKeyedJob(reelJobKey(post.id), 'render_reel', { ...payload }, new Date());
}

/** Throws 409 while the post's Reel is waiting or being made (its scenes must not change under it) */
export async function assertNoReelRunning(postId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { key: reelJobKey(postId) } });
  if (job && (job.status === 'PENDING' || job.status === 'RUNNING')) {
    throw new ReelError(409, 'Reel của bài này đang được dựng, hãy chờ xong rồi thử lại.');
  }
}

/**
 * render_reel handler: renders the scenes as saved when the job runs. A failure is final and its message
 * is what the user reads (Job.lastError). A job interrupted by a restart simply runs again.
 */
export async function runReelJob(job: Job): Promise<void> {
  const { postId, userId } = job.payload as unknown as ReelJobPayload;
  const post = await prisma.post.findFirst({ where: { id: postId, userId } });
  if (!post) return; // deleted while it waited
  try {
    await makeReel(post, readDraft(post));
  } catch (error) {
    throw new UnrecoverableJobError(error instanceof ReelError ? error.message : `Dựng Reel thất bại: ${(error as Error).message}`);
  }
}
```

- [ ] **Step 5: The render request**

In `src/routes/reel.routes.ts`:

Change the imports from `scenes` and the services:

```ts
import { draftProblem, MAX_SCENES, MAX_SCRIPT_CHARS, mergeScenes, type ReelDraft, type ReelScene } from '../lib/reel/scenes';
import { assertNoReelRunning, queueReel, reelState, ReelError } from '../services/reel.service';
```

Remove `const MIN_WORDS = 5;` and the `countSpokenWords` import, and replace `reelSchema` and the `POST /:id/reel` route with:

```ts
const reelSchema = z.object({
  /** The quick form: the whole script as one scene. Without it the saved scenes are rendered. */
  script: z.string().trim().min(1, 'Nhập kịch bản lời đọc').max(MAX_SCRIPT_CHARS, `Kịch bản tối đa ${MAX_SCRIPT_CHARS} ký tự`).optional(),
  voice: z.enum(EDGE_VOICES).optional(),
});

/** Books the render (a background job) and answers at once; the dialog then polls /reel/progress. */
router.post(
  '/:id/reel',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { script, voice } = reelSchema.parse(req.body ?? {});
    const post = await findImageEditablePost(req);
    const old = readDraft(post);
    const draft: ReelDraft = {
      voice: voice ?? old.voice,
      scenes: script === undefined ? old.scenes : [{ id: newSceneId(), text: script, imagePrompt: '', image: null }],
    };
    const problem = draftProblem(draft.scenes);
    if (problem) throw createError(400, problem);
    if (!(await renderer.ffmpegAvailable())) throw createError(503, NO_FFMPEG);
    try {
      // before the draft changes: a Reel being made reads these scenes and their pictures
      await assertNoReelRunning(post.id);
      if (script !== undefined || voice !== undefined) {
        await saveDraft(post.id, draft);
        if (script !== undefined) for (const s of old.scenes) if (s.image) await removeSceneImage(post.id, s.image);
      }
      await queueReel({ ...post, reelDraft: null });
    } catch (error) {
      if (error instanceof ReelError) throw createError(error.status, error.message);
      throw error;
    }
    res.status(202).json({ success: true, data: { state: 'queued' } });
  })
);
```

(`queueReel` only uses the post's `id` and `userId`.)

Also guard the editing routes while a Reel is being made: in `PUT /:id/reel/draft` and `POST /:id/reel/script`, right after `const post = await findImageEditablePost(req);`, add:

```ts
    await assertNoReelRunning(post.id).catch((error) => {
      throw createError(409, (error as Error).message);
    });
```

- [ ] **Step 6: Run the tests**

Run: `npx tsc --noEmit && npx vitest run tests/reel-render.test.ts && RUN_DB_TESTS=1 npx vitest run tests/reel.db.test.ts tests/reel-scenes.db.test.ts tests/isolation.db.test.ts`
Expected: typecheck clean; all pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/reel/render.ts src/services/reel.service.ts src/routes/reel.routes.ts tests/reel-render.test.ts tests/reel.db.test.ts tests/reel-scenes.db.test.ts
git commit -m "feat(reel): render scenes — one still per scene, timed by the voice"
```

---

### Task 5: The scene editor

**Files:**
- Modify: `client/src/api.ts`, `client/src/components/ReelMaker.tsx` (rewritten), `client/src/pages/PostsPage.tsx` (the `<ReelMaker>` props), `client/src/index.css`

**Interfaces:**
- Consumes: the routes of Tasks 3–4.
- Produces: `<ReelMaker postId hasCaption onClose onStarted />`.

- [ ] **Step 1: API**

In `client/src/api.ts`, above `export const REEL_VOICES`, add:

```ts
export interface ReelSceneView {
  id: string;
  text: string;
  imagePrompt: string;
  imageUrl: string | null;
}
export interface ReelDraftView {
  voice: string;
  scenes: ReelSceneView[];
}
```

In `postsApi`, replace the `reelScript` and `makeReel` entries with:

```ts
  /** The scenes of the post's Reel as saved. */
  reelDraft: (id: string) => apiFetch<ReelDraftView>(`/posts/${id}/reel/draft`),

  /** Save the scenes as edited (a scene keeps its picture by its id). */
  saveReelDraft: (id: string, body: { voice: string; scenes: Array<{ id?: string; text: string; imagePrompt: string }> }) =>
    apiFetch<ReelDraftView>(`/posts/${id}/reel/draft`, { method: 'PUT', body: JSON.stringify(body) }),

  /** AI writes the scenes from the post's text and replaces the saved ones (their pictures are removed). */
  reelScript: (id: string) => apiFetch<ReelDraftView>(`/posts/${id}/reel/script`, { method: 'POST' }),

  /** One Cloudflare image call: the scene's picture from its image prompt. */
  generateSceneImage: (id: string, sceneId: string) => apiFetch<ReelDraftView>(`/posts/${id}/reel/scenes/${sceneId}/image/generate`, { method: 'POST' }),

  uploadSceneImage: (id: string, sceneId: string, file: File) => {
    const body = new FormData();
    body.append('image', file);
    return apiFetch<ReelDraftView>(`/posts/${id}/reel/scenes/${sceneId}/image/upload`, { method: 'POST', body });
  },

  removeSceneImage: (id: string, sceneId: string) => apiFetch<ReelDraftView>(`/posts/${id}/reel/scenes/${sceneId}/image`, { method: 'DELETE' }),

  /** Books the render of the saved scenes (a background job, usually 20–60 seconds); follow it with `reelProgress`. */
  makeReel: (id: string) => apiFetch<{ state: 'queued' }>(`/posts/${id}/reel`, { method: 'POST', body: JSON.stringify({}) }),
```

- [ ] **Step 2: Replace `client/src/components/ReelMaker.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import { Clapperboard, ImagePlus, Plus, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { postsApi, assetUrl, MAX_UPLOAD_BYTES, REEL_VOICES, UPLOAD_TYPES, type ReelDraftView } from '../api';
import { useToast } from './Toast';

interface Props {
  postId: string;
  hasCaption: boolean;
  onClose: () => void;
  /** A render is queued or already running: the page follows it and reports the result, also after this dialog is closed */
  onStarted: () => void;
}

/** A scene being edited; `id` comes from the server once the scenes are saved */
interface Scene {
  id?: string;
  text: string;
  imagePrompt: string;
  imageUrl: string | null;
}

const MIN_WORDS = 5;
const MAX_CHARS = 1500;
const MAX_SCENES = 8;
/** Vietnamese read aloud: about 3 words a second */
const WORDS_PER_SECOND = 3;
const STAGE_LABEL = {
  voice: 'Bước 1/3 · Đang tạo giọng đọc…',
  render: 'Bước 2/3 · Đang dựng video…',
  saving: 'Bước 3/3 · Đang lưu…',
} as const;
const countWords = (s: string) => s.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;

/** Scenes (spoken text + picture) → voice + karaoke subtitles → the post's Reel. */
export default function ReelMaker({ postId, hasCaption, onClose, onStarted }: Props) {
  const toast = useToast();
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [voice, setVoice] = useState<string>(REEL_VOICES[0].value);
  /** What is running: 'load', 'script', 'save', 'start', 'render', 'pictures', or 'scene:<index>' */
  const [busy, setBusy] = useState<string | null>('load');
  /** "AI viết kịch bản" replaces the scenes: asked twice when there are some */
  const [armed, setArmed] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  /** Step and percentage reported by the server while the Reel is made */
  const [progress, setProgress] = useState<{ stage: keyof typeof STAGE_LABEL; percent: number }>({ stage: 'voice', percent: 3 });
  const fileRef = useRef<HTMLInputElement>(null);
  /** Scene the file picker was opened for */
  const uploadFor = useRef<number | null>(null);

  const apply = (draft: ReelDraftView) => {
    setScenes(draft.scenes);
    setVoice(draft.voice);
  };

  useEffect(() => {
    postsApi
      .reelDraft(postId)
      .then((r) => apply(r.data))
      .catch((e) => toast.error(e.message))
      .finally(() => setBusy((b) => (b === 'load' ? null : b)));
    // A render started earlier (the tab was closed or reloaded) is picked up again
    postsApi
      .reelProgress(postId)
      .then((r) => {
        if (r.data.state !== 'queued' && r.data.state !== 'running') return;
        setBusy('render');
        onStarted();
      })
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
            stopped = true; // the page announces the result and reloads the list
            setVideoUrl(assetUrl(data.video.videoUrl));
            setBusy(null);
          } else if (data.state === 'failed' || data.state === 'idle') {
            stopped = true;
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (!busy || busy === 'render') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  /** Run one action; the scenes are locked while it runs */
  async function act(key: string, action: () => Promise<void>) {
    setBusy(key);
    try {
      await action();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy((b) => (b === key ? null : b));
    }
  }

  /** Save the scenes as they are on screen; the answer carries the ids pictures are attached to */
  async function persist(): Promise<ReelDraftView> {
    const res = await postsApi.saveReelDraft(postId, { voice, scenes: scenes.map((s) => ({ id: s.id, text: s.text, imagePrompt: s.imagePrompt })) });
    apply(res.data);
    return res.data;
  }

  const edit = (i: number, patch: Partial<Scene>) => setScenes((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  function writeScript() {
    if (scenes.some((s) => s.text.trim() || s.imageUrl) && !armed) return setArmed(true);
    setArmed(false);
    void act('script', async () => apply((await postsApi.reelScript(postId)).data));
  }

  const generate = (i: number) =>
    act(`scene:${i}`, async () => {
      const draft = await persist();
      apply((await postsApi.generateSceneImage(postId, draft.scenes[i].id)).data);
    });

  /** One picture after another: each is a separate AI call of the member's quota */
  const generateMissing = () =>
    act('pictures', async () => {
      let draft = await persist();
      for (let i = 0; i < draft.scenes.length; i++) {
        if (draft.scenes[i].imageUrl || !draft.scenes[i].imagePrompt.trim()) continue;
        draft = (await postsApi.generateSceneImage(postId, draft.scenes[i].id)).data;
        apply(draft);
      }
    });

  function pickFile(i: number) {
    uploadFor.current = i;
    fileRef.current?.click();
  }

  function upload(file?: File) {
    const i = uploadFor.current;
    if (fileRef.current) fileRef.current.value = '';
    if (!file || i === null) return;
    if (!UPLOAD_TYPES.includes(file.type)) return toast.error('Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP.');
    if (file.size > MAX_UPLOAD_BYTES) return toast.error('Ảnh vượt quá 8 MB.');
    void act(`scene:${i}`, async () => {
      const draft = await persist();
      apply((await postsApi.uploadSceneImage(postId, draft.scenes[i].id, file)).data);
    });
  }

  const removePicture = (i: number) =>
    act(`scene:${i}`, async () => {
      const draft = await persist();
      apply((await postsApi.removeSceneImage(postId, draft.scenes[i].id)).data);
    });

  const render = () =>
    act('start', async () => {
      await persist();
      setProgress({ stage: 'voice', percent: 3 });
      await postsApi.makeReel(postId);
      setVideoUrl(null);
      onStarted();
      // only now: polling before the job is booked would read the previous Reel's "done"
      setBusy('render');
    });

  const script = scenes.map((s) => s.text.trim()).filter(Boolean).join(' ');
  const words = countWords(script);
  const seconds = Math.round(words / WORDS_PER_SECOND);
  const silent = scenes.findIndex((s) => countWords(s.text) === 0);
  const problem = !scenes.length
    ? 'Chưa có cảnh nào: bấm "AI viết kịch bản" hoặc "Thêm cảnh".'
    : silent !== -1 && scenes.length > 1
      ? `Cảnh ${silent + 1} chưa có lời đọc.`
      : script.length > MAX_CHARS
        ? `Kịch bản tối đa ${MAX_CHARS} ký tự (đang ${script.length}).`
        : words < MIN_WORDS
          ? `Kịch bản cần ít nhất ${MIN_WORDS} từ.`
          : seconds > 90
            ? 'Kịch bản quá dài: Reels tối đa 90 giây.'
            : null;
  const locked = !!busy;
  const missing = scenes.filter((s) => !s.imageUrl && s.imagePrompt.trim()).length;
  const closable = !busy || busy === 'render';

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && closable && onClose()}>
      <div className="modal-panel reel-maker" role="dialog" aria-modal="true" aria-labelledby="reel-title">
        <header className="modal-head">
          <div>
            <h2 id="reel-title">Tạo Reel từ bài</h2>
            <p className="field-hint" style={{ margin: 0 }}>Mỗi cảnh có lời đọc và ảnh riêng; ảnh đổi khi giọng đọc sang cảnh mới. Reel sẽ thay ảnh/video hiện tại của bài.</p>
          </div>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} disabled={!closable} aria-label="Đóng">
            <X size={20} />
          </button>
        </header>

        <div className="member-body">
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={writeScript} onBlur={() => setArmed(false)} disabled={locked || !hasCaption}>
              {busy === 'script' ? <div className="spinner" /> : <Sparkles size={14} aria-hidden="true" />}
              {armed ? 'Bấm lần nữa: thay các cảnh hiện tại' : 'AI viết kịch bản từ bài'}
            </button>
            <label htmlFor="reel-voice" className="sr-only">Giọng đọc</label>
            <select id="reel-voice" className="form-select select-sm reel-voice" value={voice} onChange={(e) => setVoice(e.target.value)} disabled={locked}>
              {REEL_VOICES.map((v) => (
                <option key={v.value} value={v.value}>{v.label}</option>
              ))}
            </select>
            <span className={`char-count ${problem && scenes.length ? 'over' : ''}`} style={{ marginLeft: 'auto' }}>{scenes.length} cảnh · {words} từ · ~{seconds} giây</span>
          </div>

          {busy === 'load' ? (
            <div className="loading-page" style={{ minHeight: 120 }}><div className="spinner spinner-lg" /></div>
          ) : (
            <ol className="reel-scenes">
              {scenes.map((s, i) => (
                <li key={s.id ?? `new-${i}`} className="reel-scene">
                  <div className="reel-scene-thumb">
                    {busy === `scene:${i}` ? <div className="spinner" /> : s.imageUrl ? <img src={assetUrl(s.imageUrl)!} alt={`Ảnh của cảnh ${i + 1}`} /> : <ImagePlus size={22} strokeWidth={1.6} aria-hidden="true" />}
                  </div>
                  <div className="reel-scene-body">
                    <div className="label-row">
                      <label htmlFor={`scene-text-${i}`} className="form-label">Cảnh {i + 1}</label>
                      <button type="button" className="link-btn" onClick={() => setScenes((list) => list.filter((_, j) => j !== i))} disabled={locked} aria-label={`Xoá cảnh ${i + 1}`}>
                        Xoá cảnh
                      </button>
                    </div>
                    <textarea
                      id={`scene-text-${i}`}
                      className="form-textarea"
                      rows={2}
                      value={s.text}
                      onChange={(e) => edit(i, { text: e.target.value })}
                      disabled={locked}
                      placeholder="Lời đọc của cảnh này, 1–2 câu"
                    />
                    <input
                      className="form-input"
                      aria-label={`Mô tả ảnh của cảnh ${i + 1} (tiếng Anh)`}
                      maxLength={1000}
                      value={s.imagePrompt}
                      onChange={(e) => edit(i, { imagePrompt: e.target.value })}
                      disabled={locked}
                      placeholder="Mô tả ảnh bằng tiếng Anh, VD: an office worker reading a long document at dusk"
                    />
                    <div className="row reel-scene-actions">
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => void generate(i)} disabled={locked || !s.imagePrompt.trim()}>
                        <Sparkles size={14} aria-hidden="true" /> {s.imageUrl ? 'Tạo lại ảnh' : 'Tạo ảnh AI'}
                      </button>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => pickFile(i)} disabled={locked}>
                        <Upload size={14} aria-hidden="true" /> Tải ảnh
                      </button>
                      {s.imageUrl && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void removePicture(i)} disabled={locked} aria-label={`Bỏ ảnh của cảnh ${i + 1}`}>
                          <Trash2 size={14} aria-hidden="true" /> Bỏ ảnh
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => upload(e.target.files?.[0])} />

          {busy !== 'load' && (
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setScenes((list) => [...list, { text: '', imagePrompt: '', imageUrl: null }])} disabled={locked || scenes.length >= MAX_SCENES}>
                <Plus size={14} aria-hidden="true" /> Thêm cảnh
              </button>
              {missing > 0 && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void generateMissing()} disabled={locked}>
                  {busy === 'pictures' ? <div className="spinner" /> : <Sparkles size={14} aria-hidden="true" />} Tạo ảnh cho {missing} cảnh chưa có
                </button>
              )}
            </div>
          )}
          <p className={problem && scenes.length ? 'field-warning' : 'field-hint'}>
            {problem ?? 'Cảnh chưa có ảnh riêng sẽ dùng ảnh của bài. Mỗi lần "Tạo ảnh AI" tốn một lượt tạo ảnh Cloudflare của bạn.'}
          </p>

          {busy === 'render' && (
            <div className="reel-progress">
              <div className="upload-progress" role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Tiến độ dựng Reel">
                <span style={{ width: `${progress.percent}%` }} />
                <em>{progress.percent}%</em>
              </div>
              <p className="field-hint" role="status">
                {STAGE_LABEL[progress.stage]}
                {progress.stage === 'voice' ? ' Bước này lâu nhất (thường 5–30 giây) và không đo được phần trăm.' : ''} Bạn có thể đóng cửa sổ này; Reel vẫn được dựng tiếp.
              </p>
            </div>
          )}
          {videoUrl && busy !== 'render' && <video className="reel-preview" src={videoUrl} controls playsInline preload="metadata" />}
        </div>

        <footer className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={!closable}>{videoUrl ? 'Xong' : 'Đóng'}</button>
          <button type="button" className="btn btn-primary" onClick={() => void render()} disabled={locked || !!problem}>
            {busy === 'start' || busy === 'render' ? <div className="spinner" /> : <Clapperboard size={16} aria-hidden="true" />}
            {videoUrl ? 'Dựng lại' : 'Dựng Reel'}
          </button>
        </footer>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: The page and the styles**

In `client/src/pages/PostsPage.tsx`, the `<ReelMaker … />` element: remove the `initialScript` and `initialVoice` props (the dialog loads the saved scenes itself), keeping `postId`, `hasCaption`, `onClose`, `onStarted`.

In `client/src/index.css`, change `.reel-maker { max-width: 560px; }` to `.reel-maker { max-width: 720px; }`, and after the line `.reel-voice { width: auto; }` add:

```css
.reel-scenes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.reel-scene { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 12px; padding: 10px; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--bg-card); }
.reel-scene-thumb { width: 88px; height: 88px; border-radius: 8px; background: var(--bg-tertiary); display: grid; place-items: center; color: #8A8E98; overflow: hidden; }
.reel-scene-thumb img { width: 100%; height: 100%; object-fit: cover; }
.reel-scene-body { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.reel-scene-body .form-label { margin: 0; }
.reel-scene-body .form-textarea { min-height: 56px; }
.reel-scene-actions { flex-wrap: wrap; gap: 6px; }
@media (max-width: 640px) {
  .reel-scene { grid-template-columns: 64px minmax(0, 1fr); gap: 10px; }
  .reel-scene-thumb { width: 64px; height: 64px; }
}
```

- [ ] **Step 4: Typecheck, lint, build**

Run (from `client/`): `npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b && npm run lint && npx -y -p node@22 -- node node_modules/vite/bin/vite.js build`
Expected: typecheck clean; lint shows no new kind of warning in `ReelMaker.tsx` beyond `react-hooks(exhaustive-deps)` on its effects; build ends with `✓ built in …`.

- [ ] **Step 5: Look at it in the browser (mock API, nothing real is called)**

With the mock-API method (a mock server answering the draft, script, scene picture, render and progress routes; Vite with `VITE_API_ORIGIN` on a port other than 5173), check at 1366px and 390px:

1. The dialog opens with no scene and the hint "Chưa có cảnh nào…"; "AI viết kịch bản từ bài" fills 3–4 scenes with text and image prompts; the counter shows scenes, words and seconds.
2. "Tạo ảnh AI" on a scene shows a spinner in its thumbnail, then the picture; "Tạo ảnh cho N cảnh chưa có" fills the rest one by one; "Tải ảnh" and "Bỏ ảnh" work.
3. Emptying a scene's text shows "Cảnh N chưa có lời đọc." and disables "Dựng Reel"; "Xoá cảnh" and "Thêm cảnh" work; the 9th scene cannot be added.
4. A second click is needed to let AI replace existing scenes.
5. "Dựng Reel" saves, shows the progress bar, then the video; nothing overflows sideways at 390px.

- [ ] **Step 6: Commit**

```bash
git add client/src/api.ts client/src/components/ReelMaker.tsx client/src/pages/PostsPage.tsx client/src/index.css
git commit -m "feat(client): Reel scene editor — text, image prompt and picture per scene"
```

---

### Task 6: Docs and whole-feature verification

**Files:**
- Modify: `CLAUDE.md` (the "Reels from text" paragraph), `ROADMAP.md` (after the "Tạo Reel từ bài" line)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: `CLAUDE.md`**

At the end of the paragraph that starts `**Reels from text**`, append (same paragraph):

```markdown
 A Reel is made of **scenes** (`Post.reelDraft`: `{ voice, scenes: [{ id, text, imagePrompt, image }] }`, pure logic in `src/lib/reel/scenes.ts`): the dialog edits them through `GET`/`PUT …/reel/draft`; `POST …/reel/script` lets Gemini write them with the prompt of `script-prompt.ts` (the domain's `reelInstructions`, audience, voice, rules; empty = the built-in default); scene pictures are files `STORAGE_DIR/reels/<postId>.<sceneId>-<version>.<ext>` (`scene-store.ts`), generated by Cloudflare from the scene's image prompt or uploaded (`…/reel/scenes/:sceneId/image[/generate|/upload]`), never generated without a click. The voice reads all scenes in one request; `sceneStarts` turns the word marks into each scene's start and `render.ts` concatenates one still per scene (a scene without a picture shows the post's). `POST …/reel` with `{ script }` is the quick single-scene form. A post made before scenes existed is read as one scene (`parseDraft`).
```

- [ ] **Step 2: `ROADMAP.md`**

After the line that starts `- ✅ (2026-10-03) Tạo Reel từ bài`, add (use the real completion date):

```markdown
- ✅ (2026-10-04) Reel theo từng cảnh: mỗi cảnh có lời đọc và ảnh riêng (AI tạo từ mô tả hoặc tự tải lên), ảnh đổi đúng lúc giọng đọc sang cảnh mới; mỗi lĩnh vực có "Hướng dẫn viết kịch bản Reel" riêng — plan docs/superpowers/plans/2026-10-04-reel-scenes.md
```

- [ ] **Step 3: Full suite**

Kill any dev server (the `tsx watch` parent too), confirm nothing listens on port 3000, make sure MariaDB is up, then run:

`npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run`
Expected: typecheck clean; every test file passes.

- [ ] **Step 4: One real Reel with scenes on this machine (real Edge TTS and FFmpeg; no Gemini, no Cloudflare, nothing published)**

Without starting `npm run dev` (its worker would run the user's own jobs), make a Reel through `makeReel` on a throwaway test post with three scenes — two with generated solid-colour pictures saved through `saveSceneImage`, one without — and look at three frames (one per scene): each shows its own picture and Vietnamese subtitles. Remove the test user and its files afterwards. Report the timings (voice, render).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md ROADMAP.md
git commit -m "docs: Reel scenes and the domain's script instructions"
```

- [ ] **Step 6: Hand over**

Tell the user what is verified and what is not (real Gemini scene writing and real Cloudflare pictures are only exercised through spies), and that deploying needs their word: the build applies the two new columns with `prisma db push`.

---

## Out of scope

- Transitions between scenes (cross-fade), zoom/pan on stills, portrait (9:16) image generation, video clips as scene media.
- Reordering scenes by drag and drop (delete and add cover it).
- Regenerating one scene's text with AI.
- A per-account default Reel prompt (the domain field covers it).
- The minors left from the earlier Reel reviews.
