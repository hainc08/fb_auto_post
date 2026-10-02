# Text-to-Reel ("Tạo Reel từ bài") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a post's text, the app makes a 9:16 Reel — a voice reads a short script and the subtitles light up word by word — and stores it as the post's video, so the existing preview, "Duyệt & đăng", "Hẹn giờ đăng" and `publishReel` flows publish it.

**Architecture:** One synchronous request does the work: Edge "read aloud" TTS returns MP3 audio plus a time mark for every word → a pure module turns the script and the marks into karaoke `.ass` subtitles → FFmpeg (a program on the machine) renders 1080×1920 H.264/AAC over the post's picture → the file goes through the existing `saveUploadedVideo` and becomes the post's video with `videoKind = REEL`. TTS and rendering sit behind two small objects (`edgeTts`, `reelRenderer`) so tests replace them and another provider or renderer can be swapped in later.

**Tech Stack:** Node/Express/TypeScript, `ws` (new direct dependency) for the Edge TTS WebSocket, system FFmpeg via `child_process.execFile`, Gemini (`GeminiClient.generateJson`) for the script, React client, Vitest.

**Spec:** none — requested in chat on 2026-10-02 ("đăng bài từ text thành reel … chữ chạy theo giọng đọc có phụ đề chạy theo lời", "dùng edge để thử trước", "dựng riêng trên local này trước, dự kiến không deploy"). Decisions taken for this plan (the user may overrule them before execution):

1. **Local only.** The feature runs where FFmpeg is installed (the user's PC has FFmpeg 9 on PATH). No deploy is planned; on a host without FFmpeg the routes answer 503 with a clear message.
2. **FFmpeg only, no Remotion, no Cloudflare R2 for now.** A spike on 2026-10-02 rendered the karaoke video with FFmpeg alone in 2–4 s; Remotion needs headless Chrome and far more memory than this PC has spare, and R2 is only needed when rendering happens on another machine. The video is stored in `STORAGE_DIR/videos` like an uploaded video.
3. **Voice: Edge "read aloud" TTS** (unofficial, free, may be blocked at any time — accepted for the trial). Voices `vi-VN-HoaiMyNeural` (default) and `vi-VN-NamMinhNeural`.
4. **Script:** AI writes a short spoken script (40–100 words) from the post's caption; the user can edit it, or type their own, before rendering.
5. **The Reel replaces the post's picture as its media** (a post has an image OR a video). The picture is kept as the Reel's background, also when the Reel is rendered again.
6. **Rendering is synchronous** (the request takes about 20–40 s, most of it Edge TTS). No job queue until this is deployed.

Verified in the spike (same machine): Edge returns one `WordBoundary` per spoken word for Vietnamese; the Node library `msedge-tts@2.0.8` fails in word-boundary mode, so Task 2 carries its own small client (a port of the Python `edge-tts` protocol, run successfully); FFmpeg output (1080×1920, 16.6 s) is accepted by the app's `inspectMp4` and `reelsProblem`.

## Global Constraints

- UI copy and API error messages are Vietnamese; code and comments are English.
- No change to `prisma/schema.prisma`. The script and voice are stored in `Post.inputData` (`reelScript`, `reelVoice`).
- Every new route filters by `req.user.id`, returns 404 for another user's post id, and is added to `ROUTE_CASES` in `tests/isolation.db.test.ts`.
- Tests never reach Edge TTS, Gemini or Facebook: spy on `edgeTts.synthesize`, `reelRenderer.render` and `GeminiClient.prototype.generateJson` inside each test (`vitest.config.mts` restores mocks).
- Only one new dependency: `ws` (+ `@types/ws` as a dev dependency).
- Stop any local dev server before `RUN_DB_TESTS=1` runs; MariaDB must be up. If Docker is not running, ask the user to start it (starting it unprompted has exhausted this machine's memory before).
- Client commands need Node 22: `npx -y -p node@22 -- node …` as in `CLAUDE.md`.
- Public repo: stage files by name, never `git add -A`, never commit `.env*`, `CR/`, `bugs/`, `prompt_creator_video.md`. Work on branch `feature/text-to-reel`. Do not merge, push or deploy without the user asking.
- New CSS reuses the tokens on `:root` and goes above the `/* ─── Phones & small tablets` block in `client/src/index.css`.

## Review Focus

1. Edge TTS is down, blocked or slow → the user gets a Vietnamese message within about a minute, and the post keeps its picture and its old video (Task 4 test "when the voice service fails nothing changes").
2. The script reads longer than 90 s (or shorter than 3 s) → refused with the Reels rule, the rendered file is deleted, the post is unchanged (Task 4 test "a Reel longer than 90 seconds is refused").
3. The number of spoken words differs from the words in the script (symbols like `&`, emoji, "15%") → subtitles still follow the voice, using the words Edge reports (Task 1 test "falls back to the spoken words").
4. Two clicks on "Dựng Reel" → the second is refused while the first runs; one video is stored (Task 4 test "a second render while one is running is refused").
5. Characters that are syntax in subtitles (`{`, `}`, `\`) or in SSML (`<`, `&`) in the script → shown or read as text, never break the file (Task 1 test "removes subtitle syntax"; Task 2 test "escapes the text").

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/reel/subtitles.ts` (new) | Pure: script + word marks → display words → lines → `.ass` text |
| `src/lib/reel/edge-tts.ts` (new) | Edge "read aloud" client: text → MP3 + word marks |
| `src/lib/reel/render.ts` (new) | FFmpeg: audio + `.ass` (+ picture) → MP4 file |
| `src/lib/reel/background-store.ts` (new) | Keeps the post's picture for later renders (`STORAGE_DIR/reels`) |
| `src/services/reel.service.ts` (new) | AI script; the whole "make a Reel for this post" sequence |
| `src/routes/reel.routes.ts` (new) | `POST /api/posts/:id/reel/script`, `POST /api/posts/:id/reel` |
| `src/routes/posts.routes.ts`, `src/app.ts` (modify) | Export two helpers; mount the router; remove the background on delete |
| `client/src/components/ReelMaker.tsx` (new), `client/src/api.ts`, `client/src/pages/PostsPage.tsx`, `client/src/index.css` (modify) | The dialog and its button |
| `tests/reel-subtitles.test.ts`, `tests/reel-edge-tts.test.ts`, `tests/reel-render.test.ts`, `tests/reel.db.test.ts` (new), `tests/isolation.db.test.ts` (modify) | Tests |
| `.env.example`, `CLAUDE.md`, `ROADMAP.md` (modify) | `FFMPEG_PATH`, architecture note, status |

---

### Task 1: Subtitles from the script and the word marks

**Files:**
- Create: `src/lib/reel/subtitles.ts`
- Test: `tests/reel-subtitles.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ReelWord { text: string; startMs: number; durationMs: number }`
  - `displayWords(script: string, words: ReelWord[]): ReelWord[]`
  - `buildLines(words: ReelWord[]): ReelWord[][]`
  - `buildAss(lines: ReelWord[][], opts: { withImage: boolean; font?: string }): string`
  - `countSpokenWords(script: string): number`

- [ ] **Step 1: Branch and commit the plan**

```bash
git checkout main && git checkout -b feature/text-to-reel
git add docs/superpowers/plans/2026-10-02-text-to-reel.md
git commit -m "docs: plan for text-to-reel"
```

- [ ] **Step 2: Write the failing test**

Create `tests/reel-subtitles.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildAss, buildLines, countSpokenWords, displayWords, type ReelWord } from '../src/lib/reel/subtitles';

/** Words 200 ms long, back to back from 0 */
const marks = (texts: string[]): ReelWord[] => texts.map((text, i) => ({ text, startMs: i * 200, durationMs: 200 }));

describe('displayWords', () => {
  it('shows the script as written (case and punctuation) when the counts match', () => {
    const shown = displayWords('Bạn mất bao lâu? — Thử ngay!', marks(['Bạn', 'mất', 'bao', 'lâu', 'Thử', 'ngay']));
    expect(shown.map((w) => w.text)).toEqual(['Bạn', 'mất', 'bao', 'lâu?', 'Thử', 'ngay!']);
    expect(shown[3]).toMatchObject({ startMs: 600, durationMs: 200 });
  });

  it('falls back to the spoken words when the counts differ', () => {
    // Edge read "&" as a word and reports it XML-escaped
    const shown = displayWords('Giá chỉ 15% & rẻ', marks(['Giá', 'chỉ', '15%', '&amp;', 'rẻ', 'thêm']));
    expect(shown.map((w) => w.text)).toEqual(['Giá', 'chỉ', '15%', '&', 'rẻ', 'thêm']);
  });
});

describe('countSpokenWords', () => {
  it('ignores tokens with no letter or digit', () => {
    expect(countSpokenWords('  Bạn — mất 15% 🙂 thời gian  ')).toBe(5);
    expect(countSpokenWords('')).toBe(0);
  });
});

describe('buildLines', () => {
  const texts = (lines: ReelWord[][]) => lines.map((l) => l.map((w) => w.text).join(' '));

  it('puts at most 4 words on a line and breaks after punctuation', () => {
    const lines = buildLines(marks(['Bạn', 'mất', 'bao', 'lâu', 'để', 'viết', 'email?', 'Với', 'vài', 'câu', 'lệnh,', 'AI']));
    expect(texts(lines)).toEqual(['Bạn mất bao lâu', 'để viết email?', 'Với vài câu lệnh,', 'AI']);
  });

  it('keeps a line under 24 characters', () => {
    expect(texts(buildLines(marks(['tự-động-hoá-công-việc', 'nhanh'])))).toEqual(['tự-động-hoá-công-việc', 'nhanh']);
  });

  it('does not leave a lone word before a comma', () => {
    expect(texts(buildLines(marks(['Vâng,', 'đúng', 'vậy'])))).toEqual(['Vâng, đúng vậy']);
  });

  it('returns no line for no word', () => {
    expect(buildLines([])).toEqual([]);
  });
});

describe('buildAss', () => {
  const two: ReelWord[][] = [[{ text: 'A', startMs: 0, durationMs: 300 }, { text: 'B', startMs: 500, durationMs: 300 }]];

  it('times each word until the next one and holds the last line a moment', () => {
    const ass = buildAss(two, { withImage: false });
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:01.20,K,,0,0,0,,{\\k50}A {\\k70}B');
  });

  it('ends a line where the next one starts', () => {
    const ass = buildAss([...two, [{ text: 'C', startMs: 2000, durationMs: 500 }]], { withImage: false });
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:02.00,K,,0,0,0,,{\\k50}A {\\k150}B');
    expect(ass).toContain('Dialogue: 0,0:00:02.00,0:00:02.90,K,,0,0,0,,{\\k90}C');
  });

  it('puts the text under the picture, or in the middle without one', () => {
    expect(buildAss(two, { withImage: true })).toMatch(/^Style: K,Arial,.*,2,80,80,430,1$/m);
    expect(buildAss(two, { withImage: false })).toMatch(/^Style: K,Arial,.*,5,80,80,0,1$/m);
    expect(buildAss(two, { withImage: false, font: 'Be Vietnam Pro' })).toMatch(/^Style: K,Be Vietnam Pro,/m);
  });

  it('removes subtitle syntax from the words', () => {
    const ass = buildAss([[{ text: '{\\b1}Giá\\N', startMs: 0, durationMs: 100 }]], { withImage: false });
    expect(ass).toContain('{\\k50}b1GiáN');
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run tests/reel-subtitles.test.ts`
Expected: FAIL — cannot find module `../src/lib/reel/subtitles`.

- [ ] **Step 4: Write `src/lib/reel/subtitles.ts`**

```ts
/** Karaoke subtitles for a Reel: pure text work, no I/O (tested from tests/reel-subtitles.test.ts). */

export interface ReelWord {
  text: string;
  /** From the start of the audio */
  startMs: number;
  durationMs: number;
}

const MAX_WORDS_PER_LINE = 4;
const MAX_CHARS_PER_LINE = 24;
/** The last line stays this long after its last word */
const TAIL_MS = 400;
/** A token the voice reads has at least one letter or digit */
const SPOKEN = /[\p{L}\p{N}]/u;

const spokenTokens = (script: string) => script.split(/\s+/).filter((t) => SPOKEN.test(t));

export const countSpokenWords = (script: string) => spokenTokens(script).length;

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/**
 * What to show for each spoken word. The voice service drops punctuation and case,
 * so the script's own words are used when there is exactly one per mark; otherwise
 * (symbols read aloud, numbers split…) the words the service reports are shown.
 */
export function displayWords(script: string, words: ReelWord[]): ReelWord[] {
  const tokens = spokenTokens(script);
  const exact = tokens.length === words.length;
  return words.map((w, i) => ({ ...w, text: exact ? tokens[i] : unescapeXml(w.text) }));
}

/** Short lines: a sentence end closes the line; a comma closes it once it has two words. */
export function buildLines(words: ReelWord[]): ReelWord[][] {
  const lines: ReelWord[][] = [];
  let line: ReelWord[] = [];
  const flush = () => {
    if (line.length) lines.push(line);
    line = [];
  };
  for (const w of words) {
    const length = line.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    if (line.length >= MAX_WORDS_PER_LINE || (line.length > 0 && length > MAX_CHARS_PER_LINE)) flush();
    line.push(w);
    if (/[.!?…]["')\]]?$/.test(w.text) || (/[,;:]$/.test(w.text) && line.length >= 2)) flush();
  }
  flush();
  return lines;
}

/** Milliseconds → ASS time "H:MM:SS.cc" */
function assTime(ms: number): string {
  const cs = Math.round(ms / 10);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(cs / 360_000)}:${two(Math.floor(cs / 6000) % 60)}:${two(Math.floor(cs / 100) % 60)}.${two(cs % 100)}`;
}

/** `{`, `}` and `\` are syntax in ASS */
const plain = (text: string) => text.replace(/[{}\\]/g, '').replace(/\s+/g, ' ');

/**
 * 1080×1920 karaoke subtitles: a word turns yellow when it is spoken.
 * With a picture the text sits under it; without one it is centred.
 */
export function buildAss(lines: ReelWord[][], opts: { withImage: boolean; font?: string }): string {
  const events = lines.map((line, i) => {
    const start = line[0].startMs;
    const last = line[line.length - 1];
    const end = lines[i + 1] ? lines[i + 1][0].startMs : last.startMs + last.durationMs + TAIL_MS;
    let cursor = start;
    const text = line
      .map((w, j) => {
        const next = line[j + 1]?.startMs ?? end;
        const k = Math.max(1, Math.round((next - cursor) / 10));
        cursor = next;
        return `{\\k${k}}${plain(w.text)}`;
      })
      .join(' ');
    return `Dialogue: 0,${assTime(start)},${assTime(end)},K,,0,0,0,,${text}`;
  });
  // Colours are &HAABBGGRR: sung = yellow, not yet sung = white, dark outline
  const style = `Style: K,${opts.font ?? 'Arial'},78,&H0000E5FF,&H00FFFFFF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,${opts.withImage ? '2,80,80,430' : '5,80,80,0'},1`;
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    style,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/reel-subtitles.test.ts`
Expected: PASS (11 tests). In "removes subtitle syntax", the single word lasts until `0 + 100 + 400` ms, so its tag is `{\k50}`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reel/subtitles.ts tests/reel-subtitles.test.ts
git commit -m "feat(reel): karaoke subtitles from a script and word marks"
```

---

### Task 2: Edge TTS client with word marks

**Files:**
- Create: `src/lib/reel/edge-tts.ts`
- Modify: `package.json` (dependencies via npm)
- Test: `tests/reel-edge-tts.test.ts`

**Interfaces:**
- Consumes: `ReelWord` from Task 1.
- Produces:
  - `const EDGE_VOICES = ['vi-VN-HoaiMyNeural', 'vi-VN-NamMinhNeural'] as const; type EdgeVoice = (typeof EDGE_VOICES)[number]`
  - `edgeTts.synthesize(text: string, voice: EdgeVoice): Promise<{ audio: Buffer; words: ReelWord[] }>` — rejects with an `Error` whose message is Vietnamese and safe to show.
  - `secMsGec(nowMs?: number): string`, `buildSsml(text: string, voice: string): string`, `parseWordMarks(json: string): ReelWord[]` (exported for tests).

- [ ] **Step 1: Add the dependency**

Run: `npm install ws && npm install -D @types/ws`
Expected: `package.json` lists `ws` under `dependencies` and `@types/ws` under `devDependencies`.

- [ ] **Step 2: Write the failing test**

Create `tests/reel-edge-tts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildSsml, parseWordMarks, secMsGec } from '../src/lib/reel/edge-tts';

describe('secMsGec', () => {
  it('is the SHA-256 of the 5-minute Windows tick and the client token', () => {
    expect(secMsGec(Date.UTC(2026, 9, 3, 1, 0, 0))).toBe('8FC162997CA89621B9336E90531CDB23EE4D0A96ECAF94FC19E673B3C7EE0B50');
  });

  it('changes every 5 minutes, not in between', () => {
    const at = secMsGec(Date.UTC(2026, 9, 3, 1, 0, 0));
    expect(secMsGec(Date.UTC(2026, 9, 3, 1, 4, 59))).toBe(at);
    expect(secMsGec(Date.UTC(2026, 9, 3, 1, 5, 0))).not.toBe(at);
  });
});

describe('buildSsml', () => {
  it('escapes the text', () => {
    const ssml = buildSsml('Giá < 5 & "rẻ" > tốt', 'vi-VN-HoaiMyNeural');
    expect(ssml).toContain("<voice name='vi-VN-HoaiMyNeural'>");
    expect(ssml).toContain('Giá &lt; 5 &amp; "rẻ" &gt; tốt');
  });
});

describe('parseWordMarks', () => {
  it('reads word marks in milliseconds and skips other marks', () => {
    const json = JSON.stringify({
      Metadata: [
        { Type: 'WordBoundary', Data: { Offset: 1_375_000, Duration: 2_000_000, text: { Text: 'Bạn' } } },
        { Type: 'SentenceBoundary', Data: { Offset: 0, Duration: 9, text: { Text: 'Bạn mất' } } },
        { Type: 'WordBoundary', Data: { Offset: 3_375_000, Duration: 1_875_000, text: { Text: 'mất' } } },
      ],
    });
    expect(parseWordMarks(json)).toEqual([
      { text: 'Bạn', startMs: 137.5, durationMs: 200 },
      { text: 'mất', startMs: 337.5, durationMs: 187.5 },
    ]);
  });

  it('returns nothing for a reply without marks', () => {
    expect(parseWordMarks('{}')).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run tests/reel-edge-tts.test.ts`
Expected: FAIL — cannot find module `../src/lib/reel/edge-tts`.

- [ ] **Step 4: Write `src/lib/reel/edge-tts.ts`**

```ts
import WebSocket from 'ws';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ReelWord } from './subtitles';

/**
 * Microsoft Edge "read aloud" text-to-speech: MP3 audio plus a time mark for every word.
 * Unofficial endpoint (no contract): it can change or be blocked at any time, so callers
 * treat every failure as "voice service unavailable". Protocol ported from the Python
 * `edge-tts` project. Other providers can replace `edgeTts` with the same `synthesize`.
 */

export const EDGE_VOICES = ['vi-VN-HoaiMyNeural', 'vi-VN-NamMinhNeural'] as const;
export type EdgeVoice = (typeof EDGE_VOICES)[number];

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR = CHROMIUM_VERSION.split('.')[0];
const ENDPOINT = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const TIMEOUT_MS = 60_000;
/** Seconds between 1601-01-01 and 1970-01-01 */
const WINDOWS_EPOCH_S = 11_644_473_600;

/** Token the service expects: SHA-256 of the current 5-minute Windows tick + the client token */
export function secMsGec(nowMs = Date.now()): string {
  let seconds = Math.floor(nowMs / 1000) + WINDOWS_EPOCH_S;
  seconds -= seconds % 300;
  // 100-nanosecond ticks: seconds × 10^7
  return createHash('sha256').update(`${seconds}0000000${TRUSTED_CLIENT_TOKEN}`, 'ascii').digest('hex').toUpperCase();
}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildSsml(text: string, voice: string): string {
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`
  );
}

/** The service counts in 100-nanosecond ticks */
export function parseWordMarks(json: string): ReelWord[] {
  const marks: Array<{ Type: string; Data: { Offset: number; Duration: number; text: { Text: string } } }> = JSON.parse(json).Metadata ?? [];
  return marks
    .filter((m) => m.Type === 'WordBoundary')
    .map((m) => ({ text: m.Data.text.Text, startMs: m.Data.Offset / 10_000, durationMs: m.Data.Duration / 10_000 }));
}

/** "Fri Oct 02 2026 05:00:00 GMT+0000 (Coordinated Universal Time)" */
const jsDate = () =>
  new Date().toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (.*) GMT$/, '$1 $3 $2 $4 $5 GMT+0000 (Coordinated Universal Time)');
const hexId = () => randomUUID().replace(/-/g, '');

function synthesize(text: string, voice: EdgeVoice): Promise<{ audio: Buffer; words: ReelWord[] }> {
  return new Promise((resolve, reject) => {
    const url = `${ENDPOINT}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&ConnectionId=${hexId()}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM_VERSION}`;
    const ws = new WebSocket(url, {
      headers: {
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`,
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: `muid=${randomBytes(16).toString('hex').toUpperCase()};`,
      },
    });
    const audio: Buffer[] = [];
    const words: ReelWord[] = [];
    let settled = false;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (error) reject(new Error(error));
      else resolve({ audio: Buffer.concat(audio), words });
    };
    const timer = setTimeout(() => finish('Dịch vụ giọng đọc không phản hồi (quá 60 giây).'), TIMEOUT_MS);

    ws.on('open', () => {
      ws.send(
        `X-Timestamp:${jsDate()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
      );
      // The trailing "Z" after the timestamp is what the Edge browser sends
      ws.send(`X-RequestId:${hexId()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${jsDate()}Z\r\nPath:ssml\r\n\r\n${buildSsml(text, voice)}`);
    });
    ws.on('message', (raw: WebSocket.RawData, isBinary: boolean) => {
      try {
        const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
        if (isBinary) {
          // 2-byte big-endian header length, the headers, then audio bytes
          const headerLength = data.readUInt16BE(0);
          if (data.subarray(2, 2 + headerLength).toString().includes('Path:audio')) audio.push(data.subarray(2 + headerLength));
          return;
        }
        const message = data.toString();
        const split = message.indexOf('\r\n\r\n');
        const headers = message.slice(0, split);
        if (headers.includes('Path:audio.metadata')) words.push(...parseWordMarks(message.slice(split + 4)));
        else if (headers.includes('Path:turn.end')) finish(audio.length ? undefined : 'Dịch vụ giọng đọc không trả về âm thanh.');
      } catch {
        finish('Dịch vụ giọng đọc trả về dữ liệu không đọc được.');
      }
    });
    ws.on('unexpected-response', (_req, res) => finish(`Dịch vụ giọng đọc từ chối kết nối (HTTP ${res.statusCode}).`));
    ws.on('error', () => finish('Không kết nối được dịch vụ giọng đọc.'));
    ws.on('close', () => finish('Dịch vụ giọng đọc ngắt kết nối giữa chừng.'));
  });
}

/** An object, so tests (and other providers) replace `synthesize` */
export const edgeTts = { synthesize };
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run tests/reel-edge-tts.test.ts && npx tsc --noEmit`
Expected: PASS (5 tests); typecheck clean.

- [ ] **Step 6: Try the real service once (by hand, not a test)**

Create `scripts/reel-voice-sample.ts`:

```ts
import { writeFile } from 'node:fs/promises';
import { edgeTts } from '../src/lib/reel/edge-tts';

/** Manual check of the unofficial Edge TTS endpoint: npx tsx scripts/reel-voice-sample.ts */
async function main() {
  const started = Date.now();
  const { audio, words } = await edgeTts.synthesize('Xin chào, đây là bài thử giọng đọc cho Reel.', 'vi-VN-HoaiMyNeural');
  await writeFile('storage/reel-voice-sample.mp3', audio);
  console.log(`${Date.now() - started} ms, ${audio.length} bytes, ${words.length} words:`, words.map((w) => w.text).join(' '));
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
```

Run: `npx tsx scripts/reel-voice-sample.ts`
Expected: one line like `…ms, …bytes, 10 words: Xin chào đây là bài thử giọng đọc cho Reel` and the file `storage/reel-voice-sample.mp3` (`storage/` is git-ignored). If it prints "từ chối kết nối", the service changed: stop and tell the user.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/lib/reel/edge-tts.ts tests/reel-edge-tts.test.ts scripts/reel-voice-sample.ts
git commit -m "feat(reel): Edge TTS client with word marks"
```

---

### Task 3: Render the video with FFmpeg

**Files:**
- Create: `src/lib/reel/render.ts`
- Modify: `.env.example`
- Test: `tests/reel-render.test.ts`

**Interfaces:**
- Consumes: `buildAss`, `buildLines` (Task 1); `inspectMp4` from `src/lib/mp4-info.ts`; `ImageMime` from `src/lib/image-store.ts`.
- Produces:
  - `ffmpegAvailable(): Promise<boolean>`
  - `reelRenderer.render(input: { audio: Buffer; ass: string; image?: { buffer: Buffer; mime: ImageMime } | null; outPath: string }): Promise<void>` — writes an MP4 (1080×1920, H.264 + AAC 48 kHz stereo) at `outPath`; rejects with a Vietnamese message.

- [ ] **Step 1: Write the failing test**

Create `tests/reel-render.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ffmpegAvailable, reelRenderer } from '../src/lib/reel/render';
import { buildAss, buildLines } from '../src/lib/reel/subtitles';
import { inspectMp4, reelsProblem } from '../src/lib/mp4-info';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;
const dir = mkdtempSync(path.join(os.tmpdir(), 'reel-render-test-'));

async function inspect(file: string) {
  const { size } = await stat(file);
  const f = await open(file, 'r');
  try {
    return await inspectMp4({
      size,
      read: async (offset, length) => {
        const buf = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
        if (buf.length) await f.read(buf, 0, buf.length, offset);
        return buf;
      },
    });
  } finally {
    await f.close();
  }
}

const ass = buildAss(buildLines([{ text: 'Xin', startMs: 0, durationMs: 400 }, { text: 'chào', startMs: 400, durationMs: 400 }, { text: 'Việt', startMs: 1200, durationMs: 400 }, { text: 'Nam!', startMs: 1600, durationMs: 400 }]), { withImage: false });

describe.skipIf(!hasFfmpeg)('reelRenderer (needs FFmpeg)', { timeout: 120_000 }, () => {
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // 4 seconds of tone as the "voice", and a square picture
  const voice = path.join(dir, 'voice.mp3');
  const picture = path.join(dir, 'picture.png');
  const fixtures = () => {
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:a', 'libmp3lame', voice]);
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=640x640:d=1', '-frames:v', '1', picture]);
  };

  it('finds FFmpeg', async () => {
    expect(await ffmpegAvailable()).toBe(true);
  });

  it('renders a vertical video as long as the voice, with and without a picture', async () => {
    fixtures();
    for (const [name, image] of [['plain', null], ['picture', { buffer: readFileSync(picture), mime: 'image/png' as const }]] as const) {
      const outPath = path.join(dir, `${name}.mp4`);
      await reelRenderer.render({ audio: readFileSync(voice), ass, image, outPath });
      const info = await inspect(outPath);
      expect(info).toMatchObject({ width: 1080, height: 1920 });
      expect(info!.durationSec).toBeGreaterThanOrEqual(3.5);
      expect(info!.durationSec).toBeLessThanOrEqual(4.6);
      expect(reelsProblem(info!)).toBeNull();
    }
  });

  it('leaves no work folder behind and says why it failed', async () => {
    const before = readdirSync(os.tmpdir()).filter((n) => n.startsWith('autopost-reel-')).length;
    await expect(reelRenderer.render({ audio: Buffer.from('not audio'), ass, outPath: path.join(dir, 'bad.mp4') })).rejects.toThrow(/Dựng video thất bại/);
    expect(readdirSync(os.tmpdir()).filter((n) => n.startsWith('autopost-reel-')).length).toBe(before);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/reel-render.test.ts`
Expected: FAIL — cannot find module `../src/lib/reel/render`. (If the file is reported as skipped, FFmpeg is not on PATH: set `FFMPEG_PATH` and run again — this task cannot be verified without FFmpeg.)

- [ ] **Step 3: Write `src/lib/reel/render.ts`**

```ts
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ImageMime } from '../image-store';

/**
 * Renders a Reel with the FFmpeg program installed on the machine (FFMPEG_PATH, default "ffmpeg" on PATH):
 * the voice + karaoke subtitles over the post's picture (blurred to fill 9:16, the picture itself on top),
 * or over a plain dark ground when there is no picture.
 */

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const RENDER_TIMEOUT_MS = 180_000;
const EXT: Record<ImageMime, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function run(args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { cwd, timeout: RENDER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, _out, stderr) =>
      error ? reject(new Error(String(stderr || error.message).trim().split('\n').pop())) : resolve()
    );
  });
}

export function ffmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => execFile(FFMPEG, ['-version'], { timeout: 10_000 }, (error) => resolve(!error)));
}

async function render(input: { audio: Buffer; ass: string; image?: { buffer: Buffer; mime: ImageMime } | null; outPath: string }): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'autopost-reel-'));
  try {
    await writeFile(path.join(dir, 'voice.mp3'), input.audio);
    await writeFile(path.join(dir, 'subs.ass'), input.ass, 'utf8');

    // File names are relative to `dir` (cwd): a Windows drive colon would need escaping inside the filter
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
    await run(
      [...video, '-i', 'voice.mp3', '-vf', 'ass=subs.ass',
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '160k',
        '-shortest', '-movflags', '+faststart', 'reel.mp4'],
      dir
    );
    await copyFile(path.join(dir, 'reel.mp4'), input.outPath);
  } catch (error) {
    throw new Error(`Dựng video thất bại: ${(error as Error).message}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** An object, so tests (and another renderer, e.g. Remotion) replace `render` */
export const reelRenderer = { render };
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/reel-render.test.ts`
Expected: PASS (3 tests), a few seconds each.

- [ ] **Step 5: Document the setting**

In `.env.example`, after the `# CRON_SECRET=` line, add:

```
# FFMPEG_PATH=ffmpeg               # "Tạo Reel từ bài" needs the FFmpeg program (default: "ffmpeg" on PATH)
# REEL_FONT=Arial                  # font of the Reel subtitles; must be installed and cover Vietnamese
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/reel/render.ts tests/reel-render.test.ts .env.example
git commit -m "feat(reel): render the voice and subtitles to a 9:16 video with FFmpeg"
```

---

### Task 4: Service and API — write the script, make the Reel

**Files:**
- Create: `src/lib/reel/background-store.ts`, `src/services/reel.service.ts`, `src/routes/reel.routes.ts`
- Modify: `src/routes/posts.routes.ts` (export `findImageEditablePost` and `videoState`; remove the background in the delete route), `src/app.ts` (`API_ROUTERS`), `tests/isolation.db.test.ts` (`ROUTE_CASES`)
- Test: `tests/reel.db.test.ts`

**Interfaces:**
- Consumes: `edgeTts.synthesize`, `EDGE_VOICES`, `EdgeVoice` (Task 2); `reelRenderer.render`, `ffmpegAvailable` (Task 3); `displayWords`, `buildLines`, `buildAss`, `countSpokenWords` (Task 1); `saveUploadedVideo`, `removeVideo`, `VIDEO_TMP_DIR` (`src/lib/video-store.ts`); `readImage`, `removeImage`, `detectImageMime` (`src/lib/image-store.ts`); `reelsProblem` (`src/lib/mp4-info.ts`); `GeminiClient.generateJson`.
- Produces:
  - `POST /api/posts/:id/reel/script` → `200 { success, data: { script: string } }`; 400 when the post has no text; 502 when Gemini fails.
  - `POST /api/posts/:id/reel` body `{ script: string, voice?: 'vi-VN-HoaiMyNeural' | 'vi-VN-NamMinhNeural' }` → `200 { success, data: { videoUrl, videoKind: 'REEL', videoMeta, reelsProblem: null, reelScript } }`. Errors: 400 script too short/long or the video breaks a Reels rule; 404 not the caller's post; 409 post locked or a render already running; 502 voice service failed; 503 no FFmpeg; 500 render failed.
  - `writeReelScript(gemini: { apiKey: string; model: string }, caption: string): Promise<string>`
  - `makeReel(post: Post, input: { script: string; voice: EdgeVoice }): Promise<Post>` — throws `ReelError(status, message)`.
  - `saveReelBackground(postId, buffer)`, `readReelBackground(postId)`, `removeReelBackground(postId)`.

- [ ] **Step 1: Write the failing test**

Create `tests/reel.db.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { GeminiClient } from '../src/lib/clients/gemini';
import { edgeTts } from '../src/lib/reel/edge-tts';
import { reelRenderer } from '../src/lib/reel/render';
import * as renderModule from '../src/lib/reel/render';
import { readReelBackground } from '../src/lib/reel/background-store';
import { saveImage } from '../src/lib/image-store';
import { saveSettings } from '../src/lib/settings';
import { resolveVideo } from '../src/lib/video-store';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';
import { tinyMp4 } from './helpers/mp4';

let server: Awaited<ReturnType<typeof startTestServer>>;
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

async function setup(withImage = true) {
  const { user, cookie } = await createTestUser();
  const page = await prisma.facebookPage.create({ data: { userId: user.id, pageId: `REEL_${Date.now()}_${Math.random()}`, pageName: 'P', pageAccessToken: 'EAAfaketokenreelxxxxxxxxxxxxxxxxxxx' } });
  let post = await prisma.post.create({ data: { userId: user.id, pageId: page.id, caption: 'Bài viết dài về email.', status: 'READY', inputData: { basicInfo: 'ý tưởng' } } });
  if (withImage) {
    const saved = await saveImage(post.id, PNG);
    post = await prisma.post.update({ where: { id: post.id }, data: { imagePath: saved.imagePath, imageUrl: saved.imageUrl } });
  }
  return { cookie, post, userId: user.id };
}
const make = (cookie: string, id: string, body: Record<string, unknown> = { script: SCRIPT }) => api(server.baseUrl, 'POST', `/api/posts/${id}/reel`, { cookie, body });
const row = (id: string) => prisma.post.findUniqueOrThrow({ where: { id } });

describe.skipIf(!process.env.RUN_DB_TESTS)('text to Reel', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('makes a Reel: the video replaces the picture, which becomes the background', async () => {
    const { cookie, post } = await setup();
    const { voice, render } = fakePipeline();
    const res = await make(cookie, post.id, { script: SCRIPT, voice: 'vi-VN-NamMinhNeural' });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ videoKind: 'REEL', reelsProblem: null, reelScript: SCRIPT, videoMeta: { width: 1080, height: 1920, durationSec: 20 } });
    expect(voice).toHaveBeenCalledWith(SCRIPT, 'vi-VN-NamMinhNeural');
    const input = render.mock.calls[0][0];
    expect(input.image).toMatchObject({ mime: 'image/png' });
    // subtitles use the script's own words (punctuation kept), under the picture
    expect(input.ass).toContain('email?');
    expect(input.ass).toMatch(/,2,80,80,430,1$/m);
    const saved = await row(post.id);
    expect(saved).toMatchObject({ videoKind: 'REEL', imagePath: null, imageUrl: null, status: 'READY' });
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
    const res = await make(cookie, post.id, { script: `${SCRIPT} Cảm ơn bạn đã xem.` });
    expect(res.status).toBe(200);
    expect(render.mock.calls[1][0].image).toMatchObject({ mime: 'image/png' });
    const second = (await row(post.id)).videoPath!;
    expect(second).not.toBe(first);
    expect(existsSync(resolveVideo(first)!)).toBe(false);
  });

  it('without a picture the text is centred on a plain ground', async () => {
    const { cookie, post } = await setup(false);
    const { render } = fakePipeline();
    expect((await make(cookie, post.id)).status).toBe(200);
    expect(render.mock.calls[0][0].image).toBeNull();
    expect(render.mock.calls[0][0].ass).toMatch(/,5,80,80,0,1$/m);
  });

  it('when the voice service fails nothing changes', async () => {
    const { cookie, post } = await setup();
    const { render } = fakePipeline();
    vi.spyOn(edgeTts, 'synthesize').mockRejectedValue(new Error('Dịch vụ giọng đọc từ chối kết nối (HTTP 403).'));
    const res = await make(cookie, post.id);
    expect(res.status).toBe(502);
    expect(res.json.error).toMatch(/Chưa tạo được giọng đọc.*HTTP 403/);
    expect(render).not.toHaveBeenCalled();
    expect(await row(post.id)).toMatchObject({ videoPath: null, imagePath: post.imagePath });
  });

  it('a Reel longer than 90 seconds is refused and its file removed', async () => {
    const { cookie, post } = await setup();
    fakePipeline(120);
    const res = await make(cookie, post.id);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/3–90 giây/);
    expect(await row(post.id)).toMatchObject({ videoPath: null, imagePath: post.imagePath });
  });

  it('a second render while one is running is refused', async () => {
    const { cookie, post } = await setup();
    fakePipeline();
    let release!: () => void;
    vi.spyOn(edgeTts, 'synthesize').mockImplementation(() => new Promise((resolve) => (release = () => resolve({ audio: Buffer.from('mp3'), words: WORDS }))));
    const first = make(cookie, post.id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const second = await make(cookie, post.id);
    expect(second.status).toBe(409);
    expect(second.json.error).toMatch(/đang được dựng/);
    release();
    expect((await first).status).toBe(200);
  });

  it('refuses a script that is too short, an unknown voice, and a host without FFmpeg', async () => {
    const { cookie, post } = await setup();
    const { voice } = fakePipeline();
    const short = await make(cookie, post.id, { script: 'Xin chào bạn' });
    expect(short.status).toBe(400);
    expect(short.json.error).toMatch(/ít nhất 5 từ/);
    expect((await make(cookie, post.id, { script: SCRIPT, voice: 'en-US-GuyNeural' })).status).toBe(400);
    vi.spyOn(renderModule, 'ffmpegAvailable').mockResolvedValue(false);
    const none = await make(cookie, post.id);
    expect(none.status).toBe(503);
    expect(none.json.error).toMatch(/FFmpeg/);
    expect(voice).not.toHaveBeenCalled();
  });

  it('refuses a post that is already on a Page', async () => {
    const { cookie, post } = await setup();
    fakePipeline();
    await prisma.post.update({ where: { id: post.id }, data: { status: 'PUBLISHED' } });
    expect((await make(cookie, post.id)).status).toBe(409);
  });

  it('AI writes a short script from the post text', async () => {
    const { cookie, post, userId } = await setup();
    await saveSettings(userId, { geminiApiKey: 'AIzaFakeKeyReelTest000000000000000000' });
    const spy = vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ script: '  Bạn có biết? AI viết email trong mười giây.  ' } as never);
    const res = await api(server.baseUrl, 'POST', `/api/posts/${post.id}/reel/script`, { cookie });
    expect(res.status).toBe(200);
    expect(res.json.data.script).toBe('Bạn có biết? AI viết email trong mười giây.');
    expect(spy.mock.calls[0][0].prompt).toContain('Bài viết dài về email.');
    const empty = await prisma.post.update({ where: { id: post.id }, data: { caption: null } });
    expect((await api(server.baseUrl, 'POST', `/api/posts/${empty.id}/reel/script`, { cookie })).status).toBe(400);
  });

  it('deleting the post removes the kept picture', async () => {
    const { cookie, post } = await setup();
    fakePipeline();
    await make(cookie, post.id);
    expect((await api(server.baseUrl, 'DELETE', `/api/posts/${post.id}`, { cookie })).status).toBe(200);
    expect(await readReelBackground(post.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `RUN_DB_TESTS=1 npx vitest run tests/reel.db.test.ts`
Expected: FAIL — cannot find module `../src/lib/reel/background-store`.

- [ ] **Step 3: Write `src/lib/reel/background-store.ts`**

```ts
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { detectImageMime, type ImageMime } from '../image-store';

/**
 * The picture a Reel was made from. Making a Reel replaces the post's picture with the video,
 * so the picture is kept here for rendering the Reel again (one file per post, STORAGE_DIR/reels).
 */

export const REEL_DIR = path.resolve(process.env.STORAGE_DIR || path.join(process.cwd(), 'storage'), 'reels');
const fileOf = (postId: string) => {
  if (!/^[0-9a-f-]{36}$/i.test(postId)) throw new Error('Invalid post id');
  return path.join(REEL_DIR, `${postId}.bg`);
};

export async function saveReelBackground(postId: string, buffer: Buffer): Promise<void> {
  await mkdir(REEL_DIR, { recursive: true });
  await writeFile(fileOf(postId), buffer);
}

export async function readReelBackground(postId: string): Promise<{ buffer: Buffer; mime: ImageMime } | null> {
  try {
    const buffer = await readFile(fileOf(postId));
    const mime = detectImageMime(buffer);
    return mime ? { buffer, mime } : null;
  } catch {
    return null;
  }
}

export async function removeReelBackground(postId: string): Promise<void> {
  await unlink(fileOf(postId)).catch(() => {});
}
```

- [ ] **Step 4: Write `src/services/reel.service.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Type } from '@google/genai';
import { z } from 'zod';
import type { Post } from '@prisma/client';
import prisma from '../utils/prisma';
import { logger } from '../utils/logger';
import { GeminiClient } from '../lib/clients/gemini';
import { edgeTts, type EdgeVoice } from '../lib/reel/edge-tts';
import * as renderer from '../lib/reel/render';
import { buildAss, buildLines, displayWords } from '../lib/reel/subtitles';
import { readReelBackground, saveReelBackground } from '../lib/reel/background-store';
import { readImage, removeImage } from '../lib/image-store';
import { removeVideo, saveUploadedVideo, VIDEO_TMP_DIR } from '../lib/video-store';
import { reelsProblem } from '../lib/mp4-info';

/** "Tạo Reel từ bài": a voice reads a short script, subtitles follow it, the video becomes the post's video. */

export class ReelError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const SCRIPT_SCHEMA = { type: Type.OBJECT, properties: { script: { type: Type.STRING } }, required: ['script'] };
const scriptValidator = z.object({ script: z.string().min(1) });

const SCRIPT_SYSTEM = `Bạn viết kịch bản lời đọc cho video Reels dọc trên Facebook, bằng tiếng Việt.
Quy tắc:
- 40 đến 100 từ, đọc lên trong 20–40 giây.
- Câu đầu là một câu hỏi hoặc một ý gây tò mò; sau đó một ý chính; câu cuối kêu gọi hành động.
- Câu ngắn, văn nói tự nhiên. Không hashtag, không emoji, không đường link, không gạch đầu dòng.
- Chỉ dùng thông tin có trong bài viết được cung cấp.`;

/** A short spoken script (40–100 words) from the post's text. */
export async function writeReelScript(gemini: { apiKey: string; model: string }, caption: string): Promise<string> {
  const client = new GeminiClient(gemini);
  const result = await client.generateJson({
    systemInstruction: SCRIPT_SYSTEM,
    prompt: `Bài viết:\n${caption}\n\nViết kịch bản lời đọc cho Reels.`,
    responseSchema: SCRIPT_SCHEMA,
    validator: scriptValidator,
    temperature: 0.8,
  });
  return result.script.trim();
}

/** Posts being rendered by this process (a second request for the same post is refused) */
const rendering = new Set<string>();

/** Voice → subtitles → video → the post's video (REEL). Throws ReelError; on failure the post is unchanged. */
export async function makeReel(post: Post, input: { script: string; voice: EdgeVoice }): Promise<Post> {
  if (rendering.has(post.id)) throw new ReelError(409, 'Reel của bài này đang được dựng, hãy chờ xong rồi thử lại.');
  rendering.add(post.id);
  try {
    if (!(await renderer.ffmpegAvailable())) {
      throw new ReelError(503, 'Máy chủ chưa có FFmpeg nên chưa dựng được Reel. Cài FFmpeg hoặc đặt biến FFMPEG_PATH.');
    }
    const picture = post.imagePath ? await readImage(post.imagePath) : await readReelBackground(post.id);

    let speech;
    try {
      speech = await edgeTts.synthesize(input.script, input.voice);
    } catch (error) {
      throw new ReelError(502, `Chưa tạo được giọng đọc: ${(error as Error).message}`);
    }
    if (!speech.words.length) throw new ReelError(502, 'Chưa tạo được giọng đọc: dịch vụ không trả về mốc thời gian của từng từ.');

    const ass = buildAss(buildLines(displayWords(input.script, speech.words)), { withImage: !!picture, font: process.env.REEL_FONT });
    await mkdir(VIDEO_TMP_DIR, { recursive: true });
    const tmp = path.join(VIDEO_TMP_DIR, `reel-${randomUUID()}.mp4`);
    try {
      await renderer.reelRenderer.render({ audio: speech.audio, ass, image: picture, outPath: tmp });
    } catch (error) {
      throw new ReelError(500, (error as Error).message);
    }

    let stored;
    try {
      stored = await saveUploadedVideo(post.id, tmp); // removes `tmp` whatever happens
    } catch (error) {
      throw new ReelError(500, `Dựng video thất bại: ${(error as Error).message}`);
    }
    const problem = reelsProblem(stored.meta);
    if (problem) {
      await removeVideo(stored.videoPath);
      throw new ReelError(400, `${problem} Hãy sửa kịch bản cho ngắn hoặc dài hơn.`);
    }

    // Keep the picture before the post lets go of it
    if (post.imagePath && picture) await saveReelBackground(post.id, picture.buffer);
    let updated: Post;
    try {
      updated = await prisma.post.update({
        where: { id: post.id },
        data: {
          videoPath: stored.videoPath,
          videoUrl: stored.videoUrl,
          videoMime: stored.mime,
          videoMeta: { ...stored.meta },
          videoKind: 'REEL',
          imagePath: null,
          imageUrl: null,
          inputData: { ...((post.inputData as Record<string, string> | null) ?? {}), reelScript: input.script, reelVoice: input.voice },
        },
      });
    } catch (error) {
      await removeVideo(stored.videoPath); // e.g. the post was deleted meanwhile
      throw error;
    }
    await removeVideo(post.videoPath);
    await removeImage(post.imagePath);
    await prisma.postLog.create({ data: { postId: post.id, action: 'reel_rendered', details: { ...stored.meta, voice: input.voice, words: speech.words.length } } });
    logger.info('Reel rendered', { postId: post.id, durationSec: stored.meta.durationSec, bytes: stored.meta.bytes });
    return updated;
  } finally {
    rendering.delete(post.id);
  }
}
```

- [ ] **Step 5: Export the two helpers and clean up on delete**

In `src/routes/posts.routes.ts`:

Change `const videoState = (p: {` to `export const videoState = (p: {`.

Change `async function findImageEditablePost(req: AuthRequest) {` to `export async function findImageEditablePost(req: AuthRequest) {`.

Add the import after the `post-timing` import:

```ts
import { removeReelBackground } from '../lib/reel/background-store';
```

In the delete route, after `await removeVideo(post.videoPath);` add:

```ts
    await removeReelBackground(post.id);
```

- [ ] **Step 6: Write `src/routes/reel.routes.ts`**

```ts
import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { getSettings } from '../lib/settings';
import { EDGE_VOICES } from '../lib/reel/edge-tts';
import { countSpokenWords } from '../lib/reel/subtitles';
import { makeReel, ReelError, writeReelScript } from '../services/reel.service';
import { findImageEditablePost, videoState } from './posts.routes';

/** "Tạo Reel từ bài": AI script, then voice + subtitles rendered to the post's video (mounted at /api/posts). */

const router = Router();
router.use(authenticate);

const MIN_WORDS = 5;
/** One request to the voice service; about 90 seconds of Vietnamese speech */
const MAX_SCRIPT_CHARS = 1500;

const reelSchema = z.object({
  script: z.string().trim().min(1, 'Nhập kịch bản lời đọc').max(MAX_SCRIPT_CHARS, `Kịch bản tối đa ${MAX_SCRIPT_CHARS} ký tự`),
  voice: z.enum(EDGE_VOICES).default('vi-VN-HoaiMyNeural'),
});

router.post(
  '/:id/reel/script',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await findImageEditablePost(req);
    if (!post.caption?.trim()) throw createError(400, 'Bài chưa có nội dung để viết kịch bản.');
    const settings = await getSettings(req.user!.id);
    let script: string;
    try {
      script = await writeReelScript({ apiKey: settings.geminiApiKey, model: settings.geminiModel }, post.caption);
    } catch (error) {
      throw createError(502, `AI chưa viết được kịch bản: ${(error as Error).message}`);
    }
    res.json({ success: true, data: { script } });
  })
);

router.post(
  '/:id/reel',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { script, voice } = reelSchema.parse(req.body ?? {});
    const post = await findImageEditablePost(req);
    if (countSpokenWords(script) < MIN_WORDS) throw createError(400, `Kịch bản cần ít nhất ${MIN_WORDS} từ.`);
    try {
      const updated = await makeReel(post, { script, voice });
      res.json({ success: true, data: { ...videoState(updated), reelScript: script } });
    } catch (error) {
      if (error instanceof ReelError) throw createError(error.status, error.message);
      throw error;
    }
  })
);

export default router;
```

- [ ] **Step 7: Mount the router and declare the routes**

In `src/app.ts`, add the import after `commentsRoutes`:

```ts
import reelRoutes from './routes/reel.routes';
```

and in `API_ROUTERS`, after `['/api/posts', commentsRoutes],`:

```ts
  ['/api/posts', reelRoutes],
```

In `tests/isolation.db.test.ts`, after the line that starts `'DELETE /api/posts/:id/video':`, add:

```ts
  'POST /api/posts/:id/reel/script': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/reel/script` },
  'POST /api/posts/:id/reel': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/reel`, body: { script: 'Một kịch bản thử có đủ năm từ.' } },
```

- [ ] **Step 8: Run the tests**

Run: `npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run tests/reel.db.test.ts tests/isolation.db.test.ts tests/videos.db.test.ts`
Expected: typecheck clean; all pass. If "a second render while one is running" fails because `vi.spyOn(renderModule, 'ffmpegAvailable')` does not replace the function used by the service, check that `reel.service.ts` calls it as `renderer.ffmpegAvailable()` through the `import * as renderer` namespace (Step 4), not through a named import.

- [ ] **Step 9: Commit**

```bash
git add src/lib/reel/background-store.ts src/services/reel.service.ts src/routes/reel.routes.ts src/routes/posts.routes.ts src/app.ts tests/reel.db.test.ts tests/isolation.db.test.ts
git commit -m "feat(reel): API to write a script and make a Reel from a post"
```

---

### Task 5: Client — the "Tạo Reel từ bài" dialog

**Files:**
- Create: `client/src/components/ReelMaker.tsx`
- Modify: `client/src/api.ts` (inside `postsApi`, after `removeVideo`), `client/src/pages/PostsPage.tsx`, `client/src/index.css`

**Interfaces:**
- Consumes: the two routes of Task 4; `VideoState`, `assetUrl` from `client/src/api.ts`; `useToast`; existing classes `modal-overlay`, `modal-panel`, `modal-head`, `modal-foot`, `member-body`, `form-textarea`, `form-select`, `field-hint`, `field-warning`, `label-row`, `char-count`, `btn …`.
- Produces: `<ReelMaker postId initialScript initialVoice hasCaption onClose onDone />`; `postsApi.reelScript(id)`, `postsApi.makeReel(id, { script, voice })`; `REEL_VOICES`.

- [ ] **Step 1: API calls**

In `client/src/api.ts`, after the `removeVideo` entry of `postsApi`, add:

```ts
  /** AI writes a short spoken script from the post's text (not saved). */
  reelScript: (id: string) => apiFetch<{ script: string }>(`/posts/${id}/reel/script`, { method: 'POST' }),

  /** Voice + subtitles rendered to a Reel; it becomes the post's video. Takes 20–60 seconds. */
  makeReel: (id: string, body: { script: string; voice: string }) =>
    apiFetch<VideoState & { reelScript: string }>(`/posts/${id}/reel`, { method: 'POST', body: JSON.stringify(body) }),
```

and above `export const postsApi`, add:

```ts
export const REEL_VOICES = [
  { value: 'vi-VN-HoaiMyNeural', label: 'Hoài My (nữ)' },
  { value: 'vi-VN-NamMinhNeural', label: 'Nam Minh (nam)' },
] as const;
```

- [ ] **Step 2: Write `client/src/components/ReelMaker.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Clapperboard, Sparkles, X } from 'lucide-react';
import { postsApi, assetUrl, REEL_VOICES } from '../api';
import { useToast } from './Toast';

interface Props {
  postId: string;
  /** Script and voice of the last Reel made for this post */
  initialScript?: string;
  initialVoice?: string;
  hasCaption: boolean;
  onClose: () => void;
  /** A Reel was made: the list and the preview reload */
  onDone: () => void;
}

const MIN_WORDS = 5;
const MAX_CHARS = 1500;
/** Vietnamese read aloud: about 3 words a second */
const WORDS_PER_SECOND = 3;
const countWords = (s: string) => s.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;

/** Script → voice + karaoke subtitles → the post's Reel. */
export default function ReelMaker({ postId, initialScript = '', initialVoice, hasCaption, onClose, onDone }: Props) {
  const toast = useToast();
  const [script, setScript] = useState(initialScript);
  const [voice, setVoice] = useState(initialVoice ?? REEL_VOICES[0].value);
  const [busy, setBusy] = useState<'script' | 'render' | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const words = countWords(script);
  const seconds = Math.round(words / WORDS_PER_SECOND);
  const problem =
    words < MIN_WORDS ? `Kịch bản cần ít nhất ${MIN_WORDS} từ.` : seconds > 90 ? 'Kịch bản quá dài: Reels tối đa 90 giây.' : null;

  async function writeScript() {
    setBusy('script');
    try {
      setScript((await postsApi.reelScript(postId)).data.script);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function render() {
    setBusy('render');
    try {
      const res = await postsApi.makeReel(postId, { script: script.trim(), voice });
      setVideoUrl(assetUrl(res.data.videoUrl));
      toast.success('Đã dựng xong Reel — xem thử rồi duyệt đăng như bài thường.');
      onDone();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal-panel reel-maker" role="dialog" aria-modal="true" aria-labelledby="reel-title">
        <header className="modal-head">
          <div>
            <h2 id="reel-title">Tạo Reel từ bài</h2>
            <p className="field-hint" style={{ margin: 0 }}>Giọng đọc kịch bản, phụ đề chạy theo lời. Reel sẽ thay ảnh của bài.</p>
          </div>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} disabled={!!busy} aria-label="Đóng">
            <X size={20} />
          </button>
        </header>

        <div className="member-body">
          <div className="label-row">
            <label htmlFor="reel-script" className="form-label">Kịch bản lời đọc</label>
            <span className={`char-count ${problem ? 'over' : ''}`}>{words} từ · ~{seconds} giây</span>
          </div>
          <textarea
            id="reel-script"
            className="form-textarea"
            rows={8}
            maxLength={MAX_CHARS}
            value={script}
            onChange={(e) => setScript(e.target.value)}
            disabled={!!busy}
            placeholder="Nên 40–100 từ: một câu mở gây tò mò, một ý chính, một lời kêu gọi."
            aria-describedby="reel-script-hint"
          />
          <p id="reel-script-hint" className={problem && script ? 'field-warning' : 'field-hint'}>
            {problem && script ? problem : 'Viết số và ký hiệu như bình thường (15%, 10:30) — giọng đọc tự đọc được.'}
          </p>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={writeScript} disabled={!!busy || !hasCaption}>
              {busy === 'script' ? <div className="spinner" /> : <Sparkles size={14} aria-hidden="true" />} AI viết kịch bản từ bài
            </button>
            <label htmlFor="reel-voice" className="sr-only">Giọng đọc</label>
            <select id="reel-voice" className="form-select select-sm reel-voice" value={voice} onChange={(e) => setVoice(e.target.value)} disabled={!!busy}>
              {REEL_VOICES.map((v) => (
                <option key={v.value} value={v.value}>{v.label}</option>
              ))}
            </select>
          </div>

          {busy === 'render' && (
            <p className="field-hint" role="status">Đang tạo giọng đọc và dựng video… thường mất 20–60 giây, đừng đóng cửa sổ này.</p>
          )}
          {videoUrl && busy !== 'render' && <video className="reel-preview" src={videoUrl} controls playsInline preload="metadata" />}
        </div>

        <footer className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={!!busy}>{videoUrl ? 'Xong' : 'Đóng'}</button>
          <button type="button" className="btn btn-primary" onClick={render} disabled={!!busy || !!problem}>
            {busy === 'render' ? <div className="spinner" /> : <Clapperboard size={16} aria-hidden="true" />}
            {videoUrl ? 'Dựng lại' : 'Dựng Reel'}
          </button>
        </footer>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Styles**

In `client/src/index.css`, directly above `/* ─── Timed post ("Hẹn giờ đăng") ─── */`, add:

```css
/* ─── Reel maker ─── */
.reel-maker { max-width: 560px; }
.reel-voice { width: auto; }
.reel-preview { align-self: center; width: min(240px, 100%); aspect-ratio: 9 / 16; border-radius: var(--radius-lg); background: #000; }

```

- [ ] **Step 4: Open it from the Posts inspector**

In `client/src/pages/PostsPage.tsx`:

Add `Clapperboard` to the `lucide-react` import, and after the `SchedulePicker` import add:

```tsx
import ReelMaker from '../components/ReelMaker';
```

Add to `LOG_LABEL`:

```tsx
  reel_rendered: 'Dựng Reel',
```

After `const [timing, setTiming] = useState(false);` add:

```tsx
  /** The "Tạo Reel từ bài" dialog is open for the selected post */
  const [reelOpen, setReelOpen] = useState(false);
```

In the inspector's button stack, directly before the block that starts `{detail.status !== 'PUBLISHING' && (` (the "Xoá bài" button), add:

```tsx
              {EDITABLE.includes(detail.status) && !liveSomewhere && (
                <button type="button" className="btn btn-secondary btn-block" onClick={() => setReelOpen(true)} disabled={acting}>
                  <Clapperboard size={15} aria-hidden="true" /> {detail.inputData?.reelScript ? 'Sửa Reel' : 'Tạo Reel từ bài'}
                </button>
              )}
```

Next to the other dialogs at the end of the component (before `{editingId && <EditPostModal`), add:

```tsx
      {reelOpen && detail && (
        <ReelMaker
          postId={detail.id}
          initialScript={detail.inputData?.reelScript}
          initialVoice={detail.inputData?.reelVoice}
          hasCaption={!!detail.caption}
          onClose={() => setReelOpen(false)}
          onDone={() => void load()}
        />
      )}
```

- [ ] **Step 5: Typecheck, lint, build**

Run (from `client/`): `npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b && npm run lint && npx -y -p node@22 -- node node_modules/vite/bin/vite.js build`
Expected: typecheck clean; lint shows no warning in `ReelMaker.tsx` and still eight in `PostsPage.tsx`; build ends with `✓ built in …`.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/ReelMaker.tsx client/src/api.ts client/src/pages/PostsPage.tsx client/src/index.css
git commit -m "feat(client): make a Reel from a post"
```

---

### Task 6: Docs and a real end-to-end check on this machine

**Files:**
- Modify: `CLAUDE.md` (after the "Images" paragraph), `ROADMAP.md` (Phase 2 list, after the "Hẹn giờ đăng" line)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: `CLAUDE.md`**

After the paragraph that starts `**Images** are stored on disk`, add:

```markdown
**Reels from text** ("Tạo Reel từ bài", `src/routes/reel.routes.ts`, `src/services/reel.service.ts`, `src/lib/reel/`): Edge "read aloud" TTS (`edge-tts.ts`, unofficial endpoint — every failure is a 502) returns MP3 + one time mark per word → `subtitles.ts` (pure) builds karaoke `.ass` → `render.ts` runs the FFmpeg program (`FFMPEG_PATH`, default `ffmpeg`; 503 when missing) → the file goes through `saveUploadedVideo` and becomes the post's video with `videoKind = REEL`; the post's picture is kept in `STORAGE_DIR/reels` as the background for later renders. Local only so far: rendering is synchronous in the request and Hostinger has no FFmpeg. Tests replace `edgeTts.synthesize` and `reelRenderer.render`; `tests/reel-render.test.ts` runs real FFmpeg and is skipped without it.
```

- [ ] **Step 2: `ROADMAP.md`**

After the line that starts `- ✅ (2026-10-02) Hẹn giờ đăng cho bài lẻ`, add (use the real completion date):

```markdown
- 🔄 (2026-10-02) Tạo Reel từ bài (chỉ chạy local): AI viết kịch bản ngắn → giọng đọc Edge TTS → phụ đề chạy theo lời → FFmpeg dựng video 9:16 → thành video Reels của bài. Chưa deploy (Hostinger chưa có FFmpeg; Edge TTS là dịch vụ không chính thức) — plan docs/superpowers/plans/2026-10-02-text-to-reel.md
```

- [ ] **Step 3: Full suite**

Stop any local dev server, make sure MariaDB is up, then run:

`npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run`
Expected: typecheck clean; every test file passes, none skipped on this machine (FFmpeg is installed).

- [ ] **Step 4: Make one real Reel (real Edge TTS and FFmpeg; nothing is published)**

Start the API (`npm run dev`) and the client (Vite command from `CLAUDE.md`), sign in, then at 1366px and 390px wide:

1. **Bài đăng** → open a post that is "Chờ duyệt" and has a picture → **Tạo Reel từ bài**.
2. **AI viết kịch bản từ bài** fills the box with 40–100 words; the counter shows the words and seconds.
3. **Dựng Reel** → within about a minute the player shows a vertical video: the picture on a blurred ground, the voice reading, the words turning yellow in time with it. Listen to it: the subtitles must not drift from the voice.
4. Close the dialog: the inspector shows the video and the Reels badge; the button now says **Sửa Reel** and reopens with the same script.
5. Change one sentence → **Dựng lại** → the new video still has the picture.
6. Empty the box → the button is disabled and the hint says "Kịch bản cần ít nhất 5 từ."

Do **not** press "Duyệt & đăng" unless the user asks: it publishes to the real Page.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md ROADMAP.md
git commit -m "docs: text-to-reel (local)"
```

---

## Out of scope

- Deploying: Hostinger has no FFmpeg (never tested), and the request would need to become a queued job (`render_reel`) with progress.
- Remotion and Cloudflare R2: only worth adding with a separate render machine; `reelRenderer` and the video store are the two places to swap.
- An official voice provider (Azure Speech F0): replace `edgeTts` with an object that has the same `synthesize`.
- Background music, a bundled font (the subtitles use the system font `Arial`, or `REEL_FONT`), choosing colours, text animations beyond the word highlight.
- A "Tạo Reel" button on the Tạo bài page and in the ⋯ row menu.
- Scripts longer than one voice request (1500 characters).
