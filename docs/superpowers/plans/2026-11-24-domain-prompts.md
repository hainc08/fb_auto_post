# Domain Prompts Simplification Plan

> Executed inline (native) by the user's choice of 2026-11-24 ("làm theo đề xuất đi, tạo nhánh mới").

**Goal:** The "Lĩnh vực nội dung" screen shows only **Prompt viết bài** (one field, ≤ 10,000 characters), **Prompt tạo ảnh** (≤ 2,000) and **Định dạng bài**. Everything else moves into a collapsed **Cài đặt khác**. Nothing is lost and existing domains write exactly as before until they are edited.

**Architecture:**
- Two new nullable `Text` columns on `content_domains`:
  - `writingPrompt` (null = never edited: read from the old four fields);
  - `imageGuide` (null = read from `imageStyle`).
- A pure module `src/lib/domain-prompt.ts` gives the effective values. Every reader goes through it: `composePrompt`, `reply-prompt`, `reel/script-prompt`, `idea-suggest`, `imageStyleOf`.
- The old columns stay in place: additive schema, so no migration and no data loss.

## Global Constraints
- Branch `feature/domain-prompts` from `main`. Stage by name.
- Schema additive only (`db execute` locally, `hostinger-schema.sql` too). No column is widened or dropped (production `db push` must not stop).
- Vietnamese copy, English code.
- **A domain never edited** (`writingPrompt` null): `composePrompt` output is **byte-identical** to before.
- An empty saved prompt is stored as `''`, never null, so the old fields do not come back.

## Tasks

### 1. Effective prompts (pure)
`src/lib/domain-prompt.ts`:
- `legacyWritingPrompt(d)`: the description line, then `Đối tượng độc giả: …`, `Giọng văn: …`, `Quy tắc bắt buộc: …`, empty parts skipped, joined by `\n`.
- `writingPromptOf(d)`: the `writingPrompt` when not null (trimmed), else the legacy text.
- `imageGuideOf(d)`: the `imageGuide` when not null, else `imageStyle`, else `''`.

Tests: `tests/domain-prompt.test.ts`.

### 2. Readers
- `composePrompt`: with `writingPrompt` not null, the first block is `Bạn là người viết nội dung Facebook cho lĩnh vực "<name>".` followed by the filled prompt (`{{idea}}`, `{{page_name}}`, `{{audience}}` still work). Otherwise the old block. The image style comes from `imageGuideOf`.
- `reply-prompt`, `reel/script-prompt`, `idea-suggest`: with `writingPrompt` not null, one block `Hướng dẫn viết của lĩnh vực:\n<prompt>` replaces their audience, voice and rules lines.
- `imageStyleOf`: `imageGuideOf`.
- Callers' Prisma selects add `writingPrompt` and `imageGuide`.

Tests: the existing prompt test files, plus a case each.

### 3. API and schema
- Columns `writingPrompt String? @db.Text`, `imageGuide String? @db.Text`.
- `domainFields`:
  - `writingPrompt` max 10,000, message `Prompt viết bài tối đa 10.000 ký tự.`;
  - `imageGuide` max 2,000, message `Prompt tạo ảnh tối đa 2.000 ký tự.`;
  - both trimmed, `''` kept.
- Domain answers (list, create, update) carry the **effective** `writingPrompt` and `imageGuide`, so the screen is pre-filled from the old fields.

Tests: `tests/domains-api.db.test.ts`, plus `imageStyleOf` reading the guide.

### 4. Screen
`DomainsPage.tsx`:
- Name, then `Prompt viết bài` (textarea, 12 rows, 10,000, character count), then `Prompt tạo ảnh` (4 rows, 2,000, character count).
- `<details>` "Cài đặt khác" (closed) holds hashtags, Reel, comment replies with the hold keywords, and the first comment.
- Mô tả, Đối tượng, Giọng văn, Quy tắc and Phong cách ảnh are no longer shown or sent.
- Formats are unchanged.

Verify with tsc, lint, build and a browser check.

### 5. Docs and full run
`CLAUDE.md`, `ROADMAP.md`, the full suite.
