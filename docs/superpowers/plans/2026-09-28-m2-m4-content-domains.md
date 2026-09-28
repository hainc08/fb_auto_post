# M2–M4 — Lĩnh vực & Định dạng bài, giao diện, tài liệu · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mỗi user có các **lĩnh vực nội dung** (giọng văn, đối tượng, quy tắc, hashtag, phong cách ảnh), mỗi lĩnh vực có nhiều **định dạng bài**. AI viết bài theo lĩnh vực + định dạng đã chọn. Tài khoản cũ viết **y hệt trước** nhờ định dạng chuyển đổi `legacyPrompt`. Toàn bộ dùng được trên web, tài liệu khớp để deploy.

**Architecture:**
- Hai bảng mới `content_domains` / `content_formats` thuộc `userId`; thêm cột `domainId` / `formatId` vào Page, bài và lịch.
- Hàm thuần `composePrompt` ghép system prompt. `generateWithFormat` gọi Gemini, còn `writePost` là điểm vào dùng chung cho route và worker.
- `migrateDomains` chạy lúc khởi động và chuyển `systemPrompt` cũ của từng user thành lĩnh vực "Mặc định" với định dạng "Bài chuẩn" (`legacyPrompt=true`).

**Tech Stack:** Node.js + Express 4 + TypeScript, Prisma 6 + MariaDB, Zod, `@google/genai`, Vitest 5, React 19 + Vite 8 + React Router 6, CSS thuần, lucide-react.

**Spec:** `docs/superpowers/specs/2026-09-28-multi-user-domains-design.md` — §1 (tiêu chí 2–3), §4 (id trong body), §5, §6 (trừ phần đăng nhập/member đã xong ở M1), §7 bước 3–4, §8, §9, §10 hàng M2–M4.

**Nền:** M1 đã xong trên branch `feature/multi-user-domains`. Đã có sẵn:
- `authenticate`, `req.user`, `createApp()` / `API_ROUTERS`;
- `tests/helpers/http.ts` (`startTestServer`, `api`) và `tests/helpers/users.ts` (`createTestUser`, `cleanupTestUsers`, `testEmail`), trong đó cleanup chỉ xoá user của chính file test;
- `src/lib/ownership.ts` (`assertOwnTemplate`), `runBootstrap()` trong `src/lib/bootstrap.ts`;
- `tests/isolation.db.test.ts` với `ROUTE_CASES` và test "ids in the body".

## Checkpoints (spec §10: "Mỗi GĐ dừng lại cho người dùng kiểm tra")

- **M2** = Task 1–7. Chạy toàn bộ test, commit, rồi **dừng** để người dùng kiểm tra.
- **M3** = Task 8–12. Chạy thử trên trình duyệt, chụp màn hình, rồi **dừng**.
- **M4** = Task 13. **Dừng.** Merge vào `main`, deploy và xoá biến trên hPanel là việc người dùng làm hoặc duyệt.

## Global Constraints

- **Git:**
  - Branch làm việc: `feature/multi-user-domains`.
  - Trước mỗi commit: `git branch --show-current`; **stage từng file theo tên**; không commit `.env*` hay `prompt_creator_video.md`.
  - Quét diff đã stage: không có key thật (`AIza…` thật, `EAA…` thật, mật khẩu DB). Token giả trong test phải chứa chữ `fake`.
  - **Không push, merge, deploy** nếu người dùng chưa đồng ý.
- **Dependency và schema:**
  - Không thêm dependency npm mới.
  - Schema chỉ **thêm** bảng/cột. Áp dụng local bằng `npx prisma db push --skip-generate` (MariaDB docker `autopost_mariadb`, port 3310).
- **Lỗi API:**
  - Dùng `asyncHandler` + `createError(status, message)`; body lỗi `{ success: false, error, code? }`; thông báo tiếng Việt.
  - Id không thuộc user trả **404**. `formatId` không thuộc `domainId` trả **400** `Định dạng không thuộc lĩnh vực đã chọn.`
- **Giới hạn và độ dài trường (spec §5.1):**
  - Tối đa 20 lĩnh vực mỗi user (tính cả đã lưu trữ), 10 định dạng mỗi lĩnh vực.
  - `name` ≤ 80; `description` ≤ 300; `audience` ≤ 1000; `voice` ≤ 1000; `rules` ≤ 2000; `imageStyle` ≤ 500; `instructions` 1–4000; `example` ≤ 4000.
  - `defaultHashtags` ≤ 10 tag, lưu **không có** `#`.
  - Độ dài bài: `SHORT` 80–120, `MEDIUM` 150–250, `LONG` 300–450 từ.
- **Tiêu chí thành công số 3:** định dạng `legacyPrompt=true` gọi Gemini với **đúng** `systemInstruction = buildIdeaPrompt(instructions, idea)` và `prompt = "Viết bài Facebook cho ý tưởng: {idea}"` như code cũ, hashtag không đổi khi lĩnh vực không có hashtag mặc định.
- **Test:**
  - `npx tsc --noEmit`; `npx vitest run`; `RUN_DB_TESTS=1 npx vitest run`.
  - **Tắt mọi dev server trước khi chạy test DB.**
  - Không gọi Gemini, Cloudflare hay Facebook thật: dùng `vi.spyOn(GeminiClient.prototype, 'generateJson')`, `vi.spyOn(CloudflareClient.prototype, 'generateImage')` và stub `fetch` của Graph.
  - `vitest.config.mts` có `restoreMocks` / `unstubGlobals`, nên spy và stub phải đặt **trong từng test hoặc `beforeEach`**.
- **Client:**
  - Build cần Node 22: `cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b` (tsconfig có `erasableSyntaxOnly`, nên **không** dùng parameter properties trong class).
  - UI tiếng Việt, token CSS có sẵn trong `client/src/index.css`, micro-animation nhẹ, tôn trọng `prefers-reduced-motion`, bề ngang điện thoại không cuộn ngang.
  - `localStorage` luôn bọc try/catch.

## Review Focus

1. **Lĩnh vực đang là mặc định của Page bị lưu trữ.** `defaultDomainId` của Page về `null`, tạo bài cho Page đó dùng lĩnh vực đang dùng đầu tiên, không lỗi → test ở Task 5 và Task 4.
2. **Định dạng "không kèm ảnh" (`withImage=false`) đăng bằng worker khi bài chưa có ảnh.** Không gọi Cloudflare, bài đăng dạng chữ → test ở Task 6.
3. **Hashtag mặc định nhập kèm `#`, trùng khác hoa/thường, hoặc tổng quá 30.** Lưu không `#`; khi gộp thì bỏ trùng không phân biệt hoa thường và cắt ở 30 → test ở Task 2 và Task 5.
4. **Lưu trữ hoặc xoá lĩnh vực đang dùng cuối cùng.** Chặn 409 "Cần giữ ít nhất 1 lĩnh vực đang dùng." (quyết định thêm: nếu không chặn, lần tạo bài sau sẽ âm thầm tạo lại "Mặc định") → test ở Task 5.
5. **Gửi `formatId` của lĩnh vực khác hoặc của user khác**, hoặc gắn lĩnh vực của user B vào Page hay lịch của A. Trả 400 hoặc 404, không ghi gì → test ở Task 4, Task 6, Task 7.

---

## File Structure

| File | Trách nhiệm |
|---|---|
| `prisma/schema.prisma` (sửa) | Enum `FormatLength`, model `ContentDomain`, `ContentFormat`; cột `defaultDomainId`, `domainId`, `formatId` |
| `src/lib/compose-prompt.ts` (mới) | Hàm thuần: `buildIdeaPrompt` (chuyển từ ai.service), `composePrompt`, `mergeHashtags`, `cleanTag`, `styledImagePrompt`, `LENGTH_WORDS` |
| `src/services/ai.service.ts` (sửa) | `generateWithFormat`; bỏ `generateFromIdea`; re-export `buildIdeaPrompt` |
| `src/lib/domains.ts` (mới) | Bộ khởi đầu, `ensureDefaultDomain`, `migrateDomains`, `createStarterDomains`, `resolveDomainFormat`, `formatForPost` |
| `src/services/post-writer.ts` (mới) | `writePost` (route + worker), `imageStyleOf` |
| `src/routes/domains.routes.ts`, `src/routes/formats.routes.ts` (mới) | API lĩnh vực / định dạng / xem trước prompt |
| `src/routes/posts.routes.ts`, `pages.routes.ts`, `schedules.routes.ts`, `admin.routes.ts` (sửa) | Nhận `domainId` / `formatId`, lọc, default Page, bộ khởi đầu cho member mới |
| `src/services/scheduler.service.ts` (sửa) | Worker dùng `writePost` + phong cách ảnh; lịch chép `domainId` / `formatId` |
| `src/lib/bootstrap.ts` (sửa) | `runBootstrap` gọi `migrateDomains` |
| `src/app.ts` (sửa) | Gắn `/api/domains`, `/api/formats` |
| `client/src/api.ts` (sửa) | Kiểu + `domainsApi`, `pagesApi.setDefaultDomain`, lỗi validation dễ đọc |
| `client/src/pages/DomainsPage.tsx`, `client/src/components/FormatDrawer.tsx`, `client/src/components/PromptPreview.tsx` (mới) | Trang Lĩnh vực |
| `client/src/pages/CreatePostPage.tsx`, `PagesPage.tsx`, `PostsPage.tsx`, `SettingsPage.tsx`, `DashboardPage.tsx`, `client/src/components/Sidebar.tsx`, `client/src/App.tsx`, `client/src/index.css` (sửa) | Giao diện theo spec §6 |
| `AGENTS.md`, `README.md`, `docs/DEPLOY_HOSTINGER.md`, `ROADMAP.md`, `prisma/hostinger-schema.sql` (sửa) | Tài liệu, deploy |

---

# M2 — Backend lĩnh vực & định dạng

### Task 1: Schema lĩnh vực / định dạng

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: Prisma models `ContentDomain`, `ContentFormat`, enum `FormatLength`; `FacebookPage.defaultDomainId` / `defaultDomain`; `Post.domainId` / `formatId` / `domain` / `format`; `PostSchedule.domainId` / `formatId` / `domain` / `format`; `User.domains`.

- [ ] **Step 1: Sửa schema**

Sau `enum UserRole { … }` thêm:

```prisma
/// Target length of a post format: SHORT 80–120 · MEDIUM 150–250 · LONG 300–450 words
enum FormatLength {
  SHORT
  MEDIUM
  LONG
}
```

Cuối file thêm:

```prisma
// ─── Content domains & formats (how AI writes, per user) ───

model ContentDomain {
  id              String   @id @default(uuid())
  userId          String
  name            String   @db.VarChar(80)
  description     String?  @db.VarChar(300)
  audience        String?  @db.Text
  voice           String?  @db.Text
  rules           String?  @db.Text
  defaultHashtags Json? // string[] ≤ 10, stored without "#"
  imageStyle      String?  @db.VarChar(500) // English
  language        String   @default("vi")
  isArchived      Boolean  @default(false)
  sortOrder       Int      @default(0)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  user      User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  formats   ContentFormat[]
  pages     FacebookPage[]
  posts     Post[]
  schedules PostSchedule[]

  @@unique([userId, name])
  @@map("content_domains")
}

model ContentFormat {
  id           String       @id @default(uuid())
  domainId     String
  name         String       @db.VarChar(80)
  instructions String       @db.Text
  example      String?      @db.Text
  length       FormatLength @default(MEDIUM)
  withImage    Boolean      @default(true)
  isDefault    Boolean      @default(false) // exactly one default per domain
  /// "Bài chuẩn" migrated from the old Settings system prompt: used verbatim (buildIdeaPrompt)
  legacyPrompt Boolean      @default(false)
  isArchived   Boolean      @default(false)
  sortOrder    Int          @default(0)
  createdAt    DateTime     @default(now())
  updatedAt    DateTime     @updatedAt

  domain    ContentDomain  @relation(fields: [domainId], references: [id], onDelete: Cascade)
  posts     Post[]
  schedules PostSchedule[]

  @@unique([domainId, name])
  @@map("content_formats")
}
```

Trong `model User`, sau `settings  Setting[]`: `  domains   ContentDomain[]`

Trong `model FacebookPage`, sau `tokenError     String?     @db.Text`:

```prisma

  /// Domain preselected when creating a post for this Page
  defaultDomainId String?
```

và trong phần Relations của nó: `  defaultDomain ContentDomain? @relation(fields: [defaultDomainId], references: [id], onDelete: SetNull)`

Trong `model Post`, sau `templateId String?`:

```prisma
  domainId   String?
  formatId   String?
```

và trong Relations: 

```prisma
  domain   ContentDomain?   @relation(fields: [domainId], references: [id], onDelete: SetNull)
  format   ContentFormat?   @relation(fields: [formatId], references: [id], onDelete: SetNull)
```

Trong `model PostSchedule`, sau `templateId   String?`:

```prisma
  domainId     String?
  formatId     String?
```

và trong Relations:

```prisma
  domain ContentDomain? @relation(fields: [domainId], references: [id], onDelete: SetNull)
  format ContentFormat? @relation(fields: [formatId], references: [id], onDelete: SetNull)
```

- [ ] **Step 2: Áp dụng và kiểm tra**

```bash
npx prisma format && npx prisma generate && npx prisma db push --skip-generate
docker exec autopost_mariadb mariadb -uautopost -pautopost_secret autopost_db -e "SHOW TABLES LIKE 'content_%'; SHOW COLUMNS FROM posts LIKE '%Id'; SHOW COLUMNS FROM facebook_pages LIKE 'defaultDomainId';"
npx tsc --noEmit
```
Expected: `content_domains`, `content_formats`; `posts` có `domainId`, `formatId`; `facebook_pages.defaultDomainId`; tsc sạch.

- [ ] **Step 3: Commit**

```bash
git branch --show-current
git add prisma/schema.prisma
git commit -m "feat(db): content domains and formats"
```

---

### Task 2: Ghép prompt (hàm thuần)

**Files:**
- Create: `src/lib/compose-prompt.ts`, `tests/compose-prompt.test.ts`
- Modify: `src/services/ai.service.ts` (xoá `IDEA_PLACEHOLDER` + `buildIdeaPrompt`, thay bằng re-export)

**Interfaces:**
- Produces:
  - `type FormatLength = 'SHORT' | 'MEDIUM' | 'LONG'` và `LENGTH_WORDS: Record<FormatLength, string>`.
  - `interface PromptDomain { name: string; description?: string | null; audience?: string | null; voice?: string | null; rules?: string | null; imageStyle?: string | null }`.
  - `interface PromptFormat { name: string; instructions: string; example?: string | null; length: FormatLength; withImage: boolean; legacyPrompt: boolean }`.
  - `buildIdeaPrompt(systemPrompt, idea): string` (giữ nguyên hành vi cũ) và `composePrompt(input: { domain: PromptDomain; format: PromptFormat; idea: string; pageName?: string | null }): string`.
  - `cleanTag(tag: string): string`, `toTagList(value: unknown): string[]`, `mergeHashtags(ai: string[], defaults: unknown, max?: number): string[]`, `styledImagePrompt(imageStyle: string | null | undefined, prompt: string): string`.
  - `tests/idea-prompt.test.ts` vẫn import `buildIdeaPrompt` từ `src/services/ai.service`, và chạy được nhờ re-export.

- [ ] **Step 1: Viết test** — `tests/compose-prompt.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { buildIdeaPrompt, composePrompt, mergeHashtags, styledImagePrompt, type PromptDomain, type PromptFormat } from '../src/lib/compose-prompt';

const domain: PromptDomain = {
  name: 'Tiếng Nhật',
  description: 'Học tiếng Nhật cho người đi làm',
  audience: 'Nhân viên văn phòng 25–35 tuổi',
  voice: 'Thân thiện, dí dỏm',
  rules: 'Luôn có 1 ví dụ tiếng Nhật kèm phiên âm',
  imageStyle: 'flat illustration, pastel colors',
};
const format: PromptFormat = {
  name: 'Hỏi đáp',
  instructions: 'Mở bằng câu hỏi, trả lời ngắn, giải thích 3 câu.',
  example: 'Hỏi: "Sumimasen" dùng khi nào?',
  length: 'MEDIUM',
  withImage: true,
  legacyPrompt: false,
};

describe('composePrompt', () => {
  it('builds every block in order and appends the idea when no field uses it', () => {
    const prompt = composePrompt({ domain, format, idea: '  Cách chào sếp  ' });
    expect(prompt).toBe(
      [
        'Bạn là người viết nội dung Facebook cho lĩnh vực "Tiếng Nhật" — Học tiếng Nhật cho người đi làm.',
        'Đối tượng độc giả: Nhân viên văn phòng 25–35 tuổi',
        'Giọng văn: Thân thiện, dí dỏm',
        'Quy tắc bắt buộc: Luôn có 1 ví dụ tiếng Nhật kèm phiên âm',
        '',
        'Định dạng bài "Hỏi đáp":',
        'Mở bằng câu hỏi, trả lời ngắn, giải thích 3 câu.',
        'Độ dài: khoảng 150–250 từ.',
        '',
        'Bài mẫu để tham khảo phong cách (không chép lại):',
        'Hỏi: "Sumimasen" dùng khi nào?',
        '',
        'image_prompt: tiếng Anh; mô tả chủ thể, bối cảnh, ánh sáng; phong cách: flat illustration, pastel colors; không chữ, không logo, không người nổi tiếng.',
        'Chỉ trả về JSON đúng schema.',
        '',
        'Ý tưởng bài viết: Cách chào sếp',
      ].join('\n')
    );
  });

  it('drops empty blocks', () => {
    const prompt = composePrompt({
      domain: { name: 'Chung' },
      format: { ...format, example: '  ', length: 'SHORT' },
      idea: 'x',
    });
    expect(prompt).not.toMatch(/Đối tượng|Giọng văn|Quy tắc|Bài mẫu|phong cách:/);
    expect(prompt).toMatch(/^Bạn là người viết nội dung Facebook cho lĩnh vực "Chung"\.\n\nĐịnh dạng bài/);
    expect(prompt).toMatch(/khoảng 80–120 từ/);
  });

  it('fills {{idea}}, {{topic}}, n8n and {{page_name}}/{{audience}} variables, and then does not append the idea', () => {
    const prompt = composePrompt({
      domain: { ...domain, rules: 'Nhắc tên {{ page_name }} ở cuối' },
      format: { ...format, instructions: 'Chủ đề: {{idea}}. Viết cho {{audience}}. Nhắc lại {{ $json["nội dung"] }}', example: null },
      idea: 'Chào sếp',
      pageName: 'Nihongo Mỗi Ngày',
    });
    expect(prompt).toMatch('Quy tắc bắt buộc: Nhắc tên Nihongo Mỗi Ngày ở cuối');
    expect(prompt).toMatch('Chủ đề: Chào sếp. Viết cho Nhân viên văn phòng 25–35 tuổi. Nhắc lại Chào sếp');
    expect(prompt).not.toMatch('Ý tưởng bài viết:');
  });

  it('text-only formats drop the image_prompt line', () => {
    expect(composePrompt({ domain, format: { ...format, withImage: false }, idea: 'x' })).not.toMatch('image_prompt');
  });

  it('legacy formats use the old system prompt verbatim', () => {
    const legacy = { ...format, legacyPrompt: true, instructions: 'Prompt cũ {{topic}} hết.' };
    expect(composePrompt({ domain, format: legacy, idea: ' Ý ' })).toBe(buildIdeaPrompt('Prompt cũ {{topic}} hết.', ' Ý '));
    expect(composePrompt({ domain, format: legacy, idea: ' Ý ' })).toBe('Prompt cũ Ý hết.');
  });
});

describe('mergeHashtags', () => {
  it('adds defaults without "#", drops case-insensitive duplicates, caps at 30', () => {
    expect(mergeHashtags(['Tieng Nhat', 'hoc'], ['#Hoc', ' NhatNgu ', '', 5])).toEqual(['TiengNhat', 'hoc', 'NhatNgu']);
    const many = Array.from({ length: 40 }, (_, i) => `t${i}`);
    expect(mergeHashtags(many, ['x'])).toHaveLength(30);
  });

  it('returns the AI tags untouched when the domain has no defaults (legacy output stays identical)', () => {
    const ai = ['A', 'a', 'B'];
    expect(mergeHashtags(ai, null)).toBe(ai);
    expect(mergeHashtags(ai, [])).toBe(ai);
  });
});

describe('styledImagePrompt', () => {
  it('prefixes the domain style when there is one', () => {
    expect(styledImagePrompt(' watercolor ', ' a cat ')).toBe('watercolor. a cat');
    expect(styledImagePrompt(null, 'a cat')).toBe('a cat');
  });
});
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `npx vitest run tests/compose-prompt.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/compose-prompt'`.

- [ ] **Step 3: Viết `src/lib/compose-prompt.ts`**

```ts
/**
 * System prompt for AI posts, built from the user's content domain + format (spec §5.2).
 * Pure functions: no I/O, fully unit-tested.
 */

export type FormatLength = 'SHORT' | 'MEDIUM' | 'LONG';

export const LENGTH_WORDS: Record<FormatLength, string> = { SHORT: '80–120', MEDIUM: '150–250', LONG: '300–450' };

export interface PromptDomain {
  name: string;
  description?: string | null;
  audience?: string | null;
  voice?: string | null;
  rules?: string | null;
  imageStyle?: string | null;
}

export interface PromptFormat {
  name: string;
  instructions: string;
  example?: string | null;
  length: FormatLength;
  withImage: boolean;
  legacyPrompt: boolean;
}

/** Old Settings / n8n placeholders: `{{topic}}` or `{{ $json["…"] }}` (legacy behaviour, unchanged). */
const LEGACY_IDEA = /\{\{\s*(?:topic|\$json\[[^\]]*\])\s*\}\}/g;
/** Domain and format fields also accept `{{idea}}`. */
const IDEA_VAR = /\{\{\s*(?:idea|topic|\$json\[[^\]]*\])\s*\}\}/g;
const PAGE_VAR = /\{\{\s*page_name\s*\}\}/g;
const AUDIENCE_VAR = /\{\{\s*audience\s*\}\}/g;

/**
 * The old way: the whole Settings system prompt, with the idea put into its
 * placeholder, or appended when it has none. Kept verbatim for legacy formats.
 */
export function buildIdeaPrompt(systemPrompt: string, idea: string): string {
  const withIdea = systemPrompt.replace(LEGACY_IDEA, idea.trim());
  return withIdea !== systemPrompt ? withIdea : `${systemPrompt}\n\nThông tin cơ bản:\n${idea.trim()}`;
}

export function composePrompt(input: { domain: PromptDomain; format: PromptFormat; idea: string; pageName?: string | null }): string {
  const { domain, format } = input;
  const idea = input.idea.trim();
  if (format.legacyPrompt) return buildIdeaPrompt(format.instructions, input.idea);

  let ideaUsed = false;
  const audience = (domain.audience ?? '').trim();
  const fill = (text?: string | null): string => {
    const raw = (text ?? '').trim();
    if (!raw) return '';
    return raw
      .replace(IDEA_VAR, () => {
        ideaUsed = true;
        return idea;
      })
      .replace(PAGE_VAR, (input.pageName ?? '').trim())
      .replace(AUDIENCE_VAR, audience);
  };
  const line = (label: string, value: string) => (value ? `${label}: ${value}` : '');

  const description = fill(domain.description);
  const style = (domain.imageStyle ?? '').trim();
  const example = fill(format.example);

  const blocks = [
    [
      `Bạn là người viết nội dung Facebook cho lĩnh vực "${domain.name.trim()}"${description ? ` — ${description}` : ''}.`,
      line('Đối tượng độc giả', fill(domain.audience)),
      line('Giọng văn', fill(domain.voice)),
      line('Quy tắc bắt buộc', fill(domain.rules)),
    ],
    [`Định dạng bài "${format.name.trim()}":`, fill(format.instructions), `Độ dài: khoảng ${LENGTH_WORDS[format.length]} từ.`],
    example ? ['Bài mẫu để tham khảo phong cách (không chép lại):', example] : [],
    [
      format.withImage
        ? `image_prompt: tiếng Anh; mô tả chủ thể, bối cảnh, ánh sáng${style ? `; phong cách: ${style}` : ''}; không chữ, không logo, không người nổi tiếng.`
        : '',
      'Chỉ trả về JSON đúng schema.',
    ],
  ];

  const prompt = blocks
    .map((block) => block.filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n');
  return ideaUsed ? prompt : `${prompt}\n\nÝ tưởng bài viết: ${idea}`;
}

export const cleanTag = (tag: string) => tag.trim().replace(/^#+/, '').replace(/\s+/g, '');

export const toTagList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** AI hashtags + the domain's defaults, no case-insensitive duplicates, at most `max`. */
export function mergeHashtags(ai: string[], defaults: unknown, max = 30): string[] {
  const extra = toTagList(defaults);
  if (extra.length === 0) return ai;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...ai, ...extra]) {
    const tag = cleanTag(raw);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length === max) break;
  }
  return out;
}

/** Image prompt with the domain's visual style in front. */
export function styledImagePrompt(imageStyle: string | null | undefined, prompt: string): string {
  const style = (imageStyle ?? '').trim();
  return style ? `${style}. ${prompt.trim()}` : prompt.trim();
}
```

Trong `src/services/ai.service.ts`: xoá khối từ `/**\n * Where the idea goes inside the Settings system prompt` đến hết hàm `buildIdeaPrompt` (dòng 34–47), thêm sau các import:

```ts
import { buildIdeaPrompt } from '../lib/compose-prompt';

export { buildIdeaPrompt };
```

- [ ] **Step 4: Chạy test**

Run: `npx vitest run tests/compose-prompt.test.ts tests/idea-prompt.test.ts && npx tsc --noEmit`
Expected: PASS (compose-prompt 8 test, idea-prompt giữ nguyên); tsc sạch.

- [ ] **Step 5: Commit**

```bash
git add src/lib/compose-prompt.ts src/services/ai.service.ts tests/compose-prompt.test.ts
git commit -m "feat(ai): compose the system prompt from a content domain and format"
```

---

### Task 3: `generateWithFormat` (gọi Gemini theo định dạng)

**Files:**
- Modify: `src/services/ai.service.ts`
- Create: `tests/generate-with-format.test.ts`

**Interfaces:**
- Consumes: `composePrompt`, `mergeHashtags`, `PromptDomain`, `PromptFormat` (Task 2).
- Produces: `generateWithFormat(input: { gemini: GeminiCredentials; domain: PromptDomain & { defaultHashtags?: unknown }; format: PromptFormat; idea: string; pageName?: string | null }): Promise<GeneratedContent & { prompt: string }>`. `generateFromIdea` **vẫn giữ** tới Task 6 (khi đó mới xoá).

- [ ] **Step 1: Viết test** — `tests/generate-with-format.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
import { GeminiClient } from '../src/lib/clients/gemini';
import { generateWithFormat } from '../src/services/ai.service';
import { buildIdeaPrompt, type PromptFormat } from '../src/lib/compose-prompt';

const gemini = { apiKey: 'AIzaFakeKeyForUnitTests000000000000000', model: 'gemini-2.5-flash' };
const format: PromptFormat = { name: 'Bài chuẩn', instructions: 'Prompt cũ.', example: null, length: 'MEDIUM', withImage: true, legacyPrompt: true };

describe('generateWithFormat', () => {
  it('legacy format: same Gemini request as the old generateFromIdea', async () => {
    const spy = vi
      .spyOn(GeminiClient.prototype, 'generateJson')
      .mockResolvedValue({ post: 'Nội dung bài\n\n#A #B', image_prompt: ' a cat ' } as never);
    const out = await generateWithFormat({ gemini, domain: { name: 'Mặc định' }, format, idea: ' Ý tưởng ' });

    const call = spy.mock.calls[0][0] as { systemInstruction: string; prompt: string; temperature?: number };
    expect(call.systemInstruction).toBe(buildIdeaPrompt('Prompt cũ.', ' Ý tưởng '));
    expect(call.prompt).toBe('Viết bài Facebook cho ý tưởng: Ý tưởng');
    expect(call.temperature).toBe(0.7);
    expect(out).toMatchObject({ caption: 'Nội dung bài', hashtags: ['A', 'B'], imagePrompt: 'a cat', prompt: call.systemInstruction });
  });

  it("adds the domain's default hashtags", async () => {
    vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ post: 'Bài\n\n#hoc', image_prompt: 'x' } as never);
    const out = await generateWithFormat({
      gemini,
      domain: { name: 'Tiếng Nhật', defaultHashtags: ['Hoc', 'NhatNgu'] },
      format: { ...format, legacyPrompt: false },
      idea: 'x',
    });
    expect(out.hashtags).toEqual(['hoc', 'NhatNgu']);
  });

  it('text-only format: asks for no image prompt and returns an empty one', async () => {
    const spy = vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ post: 'Chỉ chữ' } as never);
    const out = await generateWithFormat({ gemini, domain: { name: 'X' }, format: { ...format, legacyPrompt: false, withImage: false }, idea: 'x' });
    const schema = (spy.mock.calls[0][0] as { responseSchema: { required: string[] } }).responseSchema;
    expect(schema.required).toEqual(['post']);
    expect(out.imagePrompt).toBe('');
    expect(out.prompt).not.toMatch('image_prompt');
  });
});
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `npx vitest run tests/generate-with-format.test.ts`
Expected: FAIL — `generateWithFormat` không phải là export.

- [ ] **Step 3: Thêm vào `src/services/ai.service.ts`**

Import (sửa dòng import compose-prompt ở Task 2):

```ts
import { buildIdeaPrompt, composePrompt, mergeHashtags, type PromptDomain, type PromptFormat } from '../lib/compose-prompt';
```

Sau `ideaPostValidator` thêm:

```ts
const TEXT_ONLY_SCHEMA = {
  type: Type.OBJECT,
  properties: { post: { type: Type.STRING } },
  required: ['post'],
  propertyOrdering: ['post'],
};

const textOnlyValidator = z.object({ post: z.string().min(1) });

/**
 * Write a post for a content domain + format (spec §5.2). Same Gemini call as the
 * old idea flow; legacy formats send exactly the old system prompt.
 * Returns the system prompt used, to store in Post.aiPrompt.
 */
export async function generateWithFormat(input: {
  gemini: GeminiCredentials;
  domain: PromptDomain & { defaultHashtags?: unknown };
  format: PromptFormat;
  idea: string;
  pageName?: string | null;
}): Promise<GeneratedContent & { prompt: string }> {
  const prompt = composePrompt(input);
  const request = { systemInstruction: prompt, prompt: `Viết bài Facebook cho ý tưởng: ${input.idea.trim()}`, temperature: 0.7 };

  try {
    const client = new GeminiClient(input.gemini);
    const result = input.format.withImage
      ? await client.generateJson({ ...request, responseSchema: IDEA_POST_SCHEMA, validator: ideaPostValidator })
      : { ...(await client.generateJson({ ...request, responseSchema: TEXT_ONLY_SCHEMA, validator: textOnlyValidator })), image_prompt: '' };

    const { body, hashtags } = splitTrailingHashtags(formatPostText(result.post));
    logger.debug('Gemini generated post from format', { length: body.length, hashtags: hashtags.length });
    return {
      caption: body,
      hashtags: mergeHashtags(hashtags, input.domain.defaultHashtags),
      imagePrompt: result.image_prompt.trim(),
      callToAction: '',
      prompt,
    };
  } catch (error) {
    logger.error('Failed to generate post from format:', { error: (error as Error).message });
    throw new Error(`AI content generation failed: ${(error as Error).message}`);
  }
}
```

(`buildIdeaPrompt` vẫn được `generateFromIdea` dùng tới Task 6.)

- [ ] **Step 4: Chạy test**

Run: `npx vitest run tests/generate-with-format.test.ts tests/gemini.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/ai.service.ts tests/generate-with-format.test.ts
git commit -m "feat(ai): write posts from a domain and format"
```

---

### Task 4: Chuyển đổi, bộ khởi đầu, chọn lĩnh vực/định dạng

**Files:**
- Create: `src/lib/domains.ts`, `tests/domains.db.test.ts`
- Modify: `src/lib/bootstrap.ts` (`runBootstrap`), `src/routes/admin.routes.ts` (POST `/users`), `tests/admin.db.test.ts`

**Interfaces:**
- Consumes: `createError`; `DEFAULT_SYSTEM_PROMPT` (`src/lib/settings.ts`).
- Produces:
  - Hằng: `DOMAIN_LIMIT = 20`, `FORMAT_LIMIT = 10`, `STARTER_KIT`.
  - `ensureDefaultDomain(userId: string, db?: Db): Promise<boolean>` — tạo "Mặc định" + "Bài chuẩn" legacy khi user chưa có lĩnh vực nào; `true` nếu có tạo.
  - `migrateDomains(db?: Db): Promise<number>` — số user được chuyển đổi.
  - `createStarterDomains(userId: string, db?: Db): Promise<void>`.
  - `resolveDomainFormat(userId: string, input: { domainId?: string | null; formatId?: string | null; pageId?: string | null }, db?: Db): Promise<{ domain: ContentDomain; format: ContentFormat }>`.
  - `formatForPost(post: { userId: string; pageId: string; formatId: string | null }, db?: Db): Promise<{ domain: ContentDomain; format: ContentFormat }>`.
  - `type Db = Prisma.TransactionClient`.

- [ ] **Step 1: Viết test** — `tests/domains.db.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createStarterDomains, ensureDefaultDomain, migrateDomains, resolveDomainFormat } from '../src/lib/domains';
import { cleanupTestUsers, createTestUser } from './helpers/users';

const page = (userId: string, tag: string, defaultDomainId?: string) =>
  prisma.facebookPage.create({
    data: { userId, pageId: `DOM_${tag}_${Date.now()}`, pageName: tag, pageAccessToken: 'EAAfaketokendomainsxxxxxxxxxxxxxxx', defaultDomainId },
  });

describe.skipIf(!process.env.RUN_DB_TESTS)('content domains', { timeout: 60_000 }, () => {
  beforeAll(() => cleanupTestUsers());
  afterAll(async () => {
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it("migration turns the user's old system prompt into a verbatim legacy format, once", async () => {
    const { user } = await createTestUser();
    await prisma.setting.create({ data: { userId: user.id, key: 'systemPrompt', value: 'Prompt riêng của tôi {{topic}}' } });

    expect(await migrateDomains()).toBeGreaterThanOrEqual(1);
    await migrateDomains();
    const domains = await prisma.contentDomain.findMany({ where: { userId: user.id }, include: { formats: true } });
    expect(domains).toHaveLength(1);
    expect(domains[0].name).toBe('Mặc định');
    expect(domains[0].formats).toEqual([
      expect.objectContaining({ name: 'Bài chuẩn', instructions: 'Prompt riêng của tôi {{topic}}', isDefault: true, legacyPrompt: true, length: 'MEDIUM', withImage: true }),
    ]);
  });

  it('users without a saved prompt get the built-in default prompt', async () => {
    const { user } = await createTestUser();
    expect(await ensureDefaultDomain(user.id)).toBe(true);
    expect(await ensureDefaultDomain(user.id)).toBe(false);
    const format = await prisma.contentFormat.findFirstOrThrow({ where: { domain: { userId: user.id } } });
    expect(format.instructions).toMatch(/^Bạn là chuyên gia viết content/);
  });

  it('new members get the starter kit: "Chung" with 3 formats, one default', async () => {
    const { user } = await createTestUser();
    await createStarterDomains(user.id);
    await createStarterDomains(user.id);
    const domains = await prisma.contentDomain.findMany({ where: { userId: user.id }, include: { formats: { orderBy: { sortOrder: 'asc' } } } });
    expect(domains.map((d) => d.name)).toEqual(['Chung']);
    expect(domains[0].formats.map((f) => [f.name, f.length, f.isDefault])).toEqual([
      ['Mẹo ngắn', 'SHORT', true],
      ['Listicle 5 ý', 'MEDIUM', false],
      ['Hỏi đáp', 'MEDIUM', false],
    ]);
  });

  it("resolves: explicit format · domain's default · Page default · first active domain", async () => {
    const { user } = await createTestUser();
    await createStarterDomains(user.id);
    const chung = await prisma.contentDomain.findFirstOrThrow({ where: { userId: user.id }, include: { formats: true } });
    const qa = chung.formats.find((f) => f.name === 'Hỏi đáp')!;
    const other = await prisma.contentDomain.create({
      data: { userId: user.id, name: 'Tiếng Nhật', sortOrder: 5, formats: { create: { name: 'Bài chuẩn', instructions: 'x', isDefault: true } } },
      include: { formats: true },
    });
    const withDefault = await page(user.id, 'withDefault', other.id);
    const archivedDefault = await prisma.contentDomain.create({ data: { userId: user.id, name: 'Cũ', isArchived: true } });
    const stale = await page(user.id, 'stale', archivedDefault.id);

    expect((await resolveDomainFormat(user.id, { formatId: qa.id })).format.id).toBe(qa.id);
    expect((await resolveDomainFormat(user.id, { domainId: chung.id })).format.name).toBe('Mẹo ngắn');
    expect((await resolveDomainFormat(user.id, { pageId: withDefault.id })).domain.id).toBe(other.id);
    expect((await resolveDomainFormat(user.id, { pageId: stale.id })).domain.id).toBe(chung.id);
    expect((await resolveDomainFormat(user.id, {})).domain.id).toBe(chung.id);
  });

  it("rejects another user's ids (404) and a format from another domain (400)", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await createStarterDomains(a.user.id);
    await createStarterDomains(b.user.id);
    const aDomain = await prisma.contentDomain.findFirstOrThrow({ where: { userId: a.user.id } });
    const aOther = await prisma.contentDomain.create({
      data: { userId: a.user.id, name: 'Khác', formats: { create: { name: 'F', instructions: 'x', isDefault: true } } },
      include: { formats: true },
    });
    const bFormat = await prisma.contentFormat.findFirstOrThrow({ where: { domain: { userId: b.user.id } } });

    await expect(resolveDomainFormat(a.user.id, { formatId: bFormat.id })).rejects.toMatchObject({ statusCode: 404 });
    await expect(resolveDomainFormat(a.user.id, { domainId: bFormat.domainId })).rejects.toMatchObject({ statusCode: 404 });
    await expect(resolveDomainFormat(a.user.id, { domainId: aDomain.id, formatId: aOther.formats[0].id })).rejects.toMatchObject({
      statusCode: 400,
      message: 'Định dạng không thuộc lĩnh vực đã chọn.',
    });
  });

  it('a user with no domain at all gets the migrated default on first use', async () => {
    const { user } = await createTestUser();
    expect((await resolveDomainFormat(user.id, {})).format).toMatchObject({ name: 'Bài chuẩn', legacyPrompt: true });
  });
});
```

Trong `tests/admin.db.test.ts`, test `creates a member with the password the admin chose…`, ngay sau `expect(created.json.data).not.toHaveProperty('passwordHash');` thêm:

```ts
    // Every new member starts with the starter domain
    expect(await prisma.contentDomain.count({ where: { userId: created.json.data.id } })).toBe(1);
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `RUN_DB_TESTS=1 npx vitest run tests/domains.db.test.ts tests/admin.db.test.ts`
Expected: FAIL — module `../src/lib/domains` không tồn tại.

- [ ] **Step 3: Viết `src/lib/domains.ts`**

```ts
import type { ContentDomain, ContentFormat, FormatLength, Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { createError } from '../middleware/error.middleware';
import { DEFAULT_SYSTEM_PROMPT } from './settings';

/** Content domains: per-user writing profiles, each with several post formats (spec §5). */

export type Db = Prisma.TransactionClient;

export const DOMAIN_LIMIT = 20; // per user, archived included
export const FORMAT_LIMIT = 10; // per domain

const MIGRATED_DOMAIN = 'Mặc định';
const MIGRATED_FORMAT = 'Bài chuẩn';

/** What a member created by the admin starts with (spec §7.4). */
export const STARTER_KIT: {
  domain: { name: string; description: string };
  formats: Array<{ name: string; length: FormatLength; instructions: string }>;
} = {
  domain: { name: 'Chung', description: 'Lĩnh vực mẫu — sửa đối tượng, giọng văn cho đúng Fanpage của bạn' },
  formats: [
    {
      name: 'Mẹo ngắn',
      length: 'SHORT',
      instructions:
        'Mở đầu bằng 1 câu nêu vấn đề quen thuộc với độc giả. Đưa ra đúng 1 mẹo cụ thể, làm được ngay, kèm ví dụ ngắn. Kết bằng 1 câu hỏi mời bình luận.',
    },
    {
      name: 'Listicle 5 ý',
      length: 'MEDIUM',
      instructions:
        'Câu mở đầu hứa hẹn lợi ích rõ ràng. Liệt kê đúng 5 ý, mỗi ý bắt đầu bằng 1️⃣…5️⃣ và một tiêu đề ngắn, sau đó 1–2 câu giải thích. Kết bằng lời mời lưu bài hoặc chia sẻ.',
    },
    {
      name: 'Hỏi đáp',
      length: 'MEDIUM',
      instructions:
        'Mở đầu bằng 1 câu hỏi độc giả hay gặp. Trả lời thẳng trong 1 câu, rồi giải thích 3–4 câu kèm ví dụ cụ thể. Kết bằng lời mời độc giả gửi câu hỏi tiếp theo.',
    },
  ],
};

/** "Mặc định" + legacy "Bài chuẩn" from the user's old system prompt, if the user has no domain yet. */
export async function ensureDefaultDomain(userId: string, db: Db = prisma): Promise<boolean> {
  if ((await db.contentDomain.count({ where: { userId } })) > 0) return false;
  const saved = await db.setting.findUnique({ where: { userId_key: { userId, key: 'systemPrompt' } } });
  await db.contentDomain.create({
    data: {
      userId,
      name: MIGRATED_DOMAIN,
      formats: {
        create: {
          name: MIGRATED_FORMAT,
          instructions: saved?.value?.trim() ? saved.value : DEFAULT_SYSTEM_PROMPT,
          length: 'MEDIUM',
          withImage: true,
          isDefault: true,
          legacyPrompt: true,
        },
      },
    },
  });
  return true;
}

/** Startup migration (idempotent): every user without a domain gets the legacy one. */
export async function migrateDomains(db: Db = prisma): Promise<number> {
  const users = await db.user.findMany({ where: { domains: { none: {} } }, select: { id: true } });
  let migrated = 0;
  for (const { id } of users) if (await ensureDefaultDomain(id, db)) migrated++;
  return migrated;
}

export async function createStarterDomains(userId: string, db: Db = prisma): Promise<void> {
  if ((await db.contentDomain.count({ where: { userId } })) > 0) return;
  await db.contentDomain.create({
    data: {
      userId,
      ...STARTER_KIT.domain,
      formats: { create: STARTER_KIT.formats.map((f, i) => ({ ...f, isDefault: i === 0, sortOrder: i })) },
    },
  });
}

const defaultFormatOf = (domainId: string, db: Db) =>
  db.contentFormat.findFirst({
    where: { domainId, isArchived: false },
    orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  });

/**
 * Domain + format for a new post / schedule (spec §5.3):
 * explicit format → explicit domain's default format → first Page's default domain →
 * the user's first active domain. Ids must belong to the user (404);
 * a format from another domain is refused (400).
 */
export async function resolveDomainFormat(
  userId: string,
  input: { domainId?: string | null; formatId?: string | null; pageId?: string | null },
  db: Db = prisma
): Promise<{ domain: ContentDomain; format: ContentFormat }> {
  if (input.formatId) {
    const found = await db.contentFormat.findFirst({ where: { id: input.formatId, domain: { userId } }, include: { domain: true } });
    if (!found) throw createError(404, 'Định dạng không tồn tại.');
    if (input.domainId && found.domainId !== input.domainId) throw createError(400, 'Định dạng không thuộc lĩnh vực đã chọn.');
    if (found.isArchived || found.domain.isArchived) throw createError(400, 'Lĩnh vực hoặc định dạng này đã được lưu trữ.');
    const { domain, ...format } = found;
    return { domain, format };
  }

  let domain: ContentDomain | null = null;
  if (input.domainId) {
    domain = await db.contentDomain.findFirst({ where: { id: input.domainId, userId } });
    if (!domain) throw createError(404, 'Lĩnh vực không tồn tại.');
    if (domain.isArchived) throw createError(400, 'Lĩnh vực này đã được lưu trữ.');
  } else {
    if (input.pageId) {
      const page = await db.facebookPage.findFirst({ where: { id: input.pageId, userId }, select: { defaultDomain: true } });
      if (page?.defaultDomain && !page.defaultDomain.isArchived) domain = page.defaultDomain;
    }
    if (!domain) {
      await ensureDefaultDomain(userId, db);
      domain = await db.contentDomain.findFirst({
        where: { userId, isArchived: false },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
    }
    if (!domain) throw createError(400, 'Chưa có lĩnh vực nào đang dùng. Mở mục Lĩnh vực để tạo.');
  }

  const format = await defaultFormatOf(domain.id, db);
  if (!format) throw createError(400, `Lĩnh vực "${domain.name}" chưa có định dạng nào.`);
  return { domain, format };
}

/** The post's own format (even if archived later), else what a new post for its Page would get. */
export async function formatForPost(
  post: { userId: string; pageId: string; formatId: string | null },
  db: Db = prisma
): Promise<{ domain: ContentDomain; format: ContentFormat }> {
  if (post.formatId) {
    const found = await db.contentFormat.findFirst({ where: { id: post.formatId, domain: { userId: post.userId } }, include: { domain: true } });
    if (found) {
      const { domain, ...format } = found;
      return { domain, format };
    }
  }
  return resolveDomainFormat(post.userId, { pageId: post.pageId }, db);
}
```

`src/lib/bootstrap.ts`:
- Thêm `import { migrateDomains } from './domains';`.
- Sửa `runBootstrap`:

```ts
export async function runBootstrap(): Promise<void> {
  assertJwtSecret();
  await ensureAdmin();
  const migrated = await migrateDomains();
  if (migrated) logger.info('[Bootstrap] Content domains created from old system prompts', { users: migrated });
}
```

`src/routes/admin.routes.ts`:
- Thêm `import { createStarterDomains } from '../lib/domains';`.
- Trong POST `/users`, ngay sau khối `prisma.user.create(...)` thêm: `await createStarterDomains(user.id);`.

- [ ] **Step 4: Chạy test**

Run: `npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run tests/domains.db.test.ts tests/admin.db.test.ts tests/bootstrap.db.test.ts`
Expected: PASS (domains 6, admin 7, bootstrap 3).

- [ ] **Step 5: Commit**

```bash
git add src/lib/domains.ts src/lib/bootstrap.ts src/routes/admin.routes.ts tests/domains.db.test.ts tests/admin.db.test.ts
git commit -m "feat(domains): migrate old prompts, starter kit for new members, resolve domain and format"
```

---

### Task 5: API lĩnh vực & định dạng

**Files:**
- Create: `src/routes/domains.routes.ts`, `src/routes/formats.routes.ts`, `tests/domains-api.db.test.ts`
- Modify: `src/app.ts` (`API_ROUTERS`), `tests/isolation.db.test.ts` (`ROUTE_CASES`, `Ids`, dữ liệu của B)

**Interfaces:**
- Consumes: `DOMAIN_LIMIT`, `FORMAT_LIMIT` (Task 4); `composePrompt`, `cleanTag` (Task 2); `generateWithFormat` (Task 3); `getSettings`.
- Produces (spec §5.4):
  - `GET /api/domains?archived=1` ⇒ `ContentDomain & { formats: (ContentFormat & { _count: { posts } })[]; _count: { pages; posts; schedules } }[]`.
  - `POST /api/domains` `{ …domainFields, format: formatFields }` ⇒ 201.
  - `PATCH /api/domains/:id` `{ …domainFields?, isArchived? }`; `DELETE /api/domains/:id`.
  - `POST /api/domains/:id/formats` `{ …formatFields, isDefault? }` ⇒ 201.
  - `PATCH /api/formats/:id` `{ …formatFields?, isDefault?, isArchived? }`; `DELETE /api/formats/:id`.
  - `POST /api/formats/:id/preview` `{ idea, pageId?, generate? }` ⇒ `{ prompt, post?, hashtags?, imagePrompt? }`.

- [ ] **Step 1: Viết test** — `tests/domains-api.db.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { GeminiClient } from '../src/lib/clients/gemini';
import { saveSettings } from '../src/lib/settings';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;
const newDomain = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  audience: 'Người đi làm',
  format: { name: 'Bài chuẩn', instructions: 'Viết ngắn gọn.' },
  ...extra,
});

describe.skipIf(!process.env.RUN_DB_TESTS)('domains & formats API', { timeout: 90_000 }, () => {
  beforeAll(async () => {
    await cleanupTestUsers();
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('creates a domain with its default format; hashtags are stored without "#"; duplicate name 409', async () => {
    const { cookie } = await createTestUser();
    const res = await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('Tiếng Nhật', { defaultHashtags: ['#NhatNgu', 'nhatngu', ' Hoc Tieng '] }) });
    expect(res.status).toBe(201);
    expect(res.json.data.defaultHashtags).toEqual(['NhatNgu', 'nhatngu', 'HocTieng']);
    expect(res.json.data.formats).toEqual([expect.objectContaining({ name: 'Bài chuẩn', isDefault: true, length: 'MEDIUM', withImage: true })]);
    expect((await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('Tiếng Nhật') })).status).toBe(409);
    expect((await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('X', { defaultHashtags: Array(11).fill('a') }) })).status).toBe(400);
  });

  it('allows at most 20 domains per user, archived included', async () => {
    const { user, cookie } = await createTestUser();
    await prisma.contentDomain.createMany({ data: Array.from({ length: 20 }, (_, i) => ({ userId: user.id, name: `D${i}`, isArchived: i % 2 === 0 })) });
    const res = await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('Thứ 21') });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch('20');
  });

  it('lists active domains with formats and usage counts; ?archived=1 adds archived ones', async () => {
    const { user, cookie } = await createTestUser();
    const a = (await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('A') })).json.data;
    await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('B') });
    await prisma.facebookPage.create({ data: { userId: user.id, pageId: `LIST_${Date.now()}`, pageName: 'P', pageAccessToken: 'EAAfaketokenlistxxxxxxxxxxxxxxxxxx', defaultDomainId: a.id } });
    await api(server.baseUrl, 'PATCH', `/api/domains/${a.id}`, { cookie, body: { isArchived: true } });

    const active = (await api(server.baseUrl, 'GET', '/api/domains', { cookie })).json.data;
    expect(active.map((d: { name: string }) => d.name)).toEqual(['B']);
    const all = (await api(server.baseUrl, 'GET', '/api/domains?archived=1', { cookie })).json.data;
    expect(all.map((d: { name: string }) => d.name)).toEqual(['B', 'A']);
    expect(all[0]._count).toEqual({ pages: 0, posts: 0, schedules: 0 });
  });

  it('archiving a domain clears it as Page default; the last active domain cannot be archived or deleted', async () => {
    const { user, cookie } = await createTestUser();
    const a = (await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('A') })).json.data;
    const b = (await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('B') })).json.data;
    const page = await prisma.facebookPage.create({
      data: { userId: user.id, pageId: `ARCH_${Date.now()}`, pageName: 'P', pageAccessToken: 'EAAfaketokenarchivexxxxxxxxxxxxxxx', defaultDomainId: a.id },
    });

    expect((await api(server.baseUrl, 'PATCH', `/api/domains/${a.id}`, { cookie, body: { isArchived: true } })).status).toBe(200);
    expect((await prisma.facebookPage.findUniqueOrThrow({ where: { id: page.id } })).defaultDomainId).toBeNull();

    const last = await api(server.baseUrl, 'PATCH', `/api/domains/${b.id}`, { cookie, body: { isArchived: true } });
    expect(last.status).toBe(409);
    expect(last.json.error).toBe('Cần giữ ít nhất 1 lĩnh vực đang dùng.');
    expect((await api(server.baseUrl, 'DELETE', `/api/domains/${b.id}`, { cookie })).status).toBe(409);
  });

  it('a domain used by a post cannot be deleted (409); an unused one can', async () => {
    const { user, cookie } = await createTestUser();
    const used = (await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('Dùng') })).json.data;
    const unused = (await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('Không dùng') })).json.data;
    await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('Giữ lại') });
    const page = await prisma.facebookPage.create({ data: { userId: user.id, pageId: `DEL_${Date.now()}`, pageName: 'P', pageAccessToken: 'EAAfaketokendelxxxxxxxxxxxxxxxxxxx' } });
    await prisma.post.create({ data: { userId: user.id, pageId: page.id, domainId: used.id, caption: 'x' } });

    const blocked = await api(server.baseUrl, 'DELETE', `/api/domains/${used.id}`, { cookie });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toMatch('lưu trữ');
    expect((await api(server.baseUrl, 'DELETE', `/api/domains/${unused.id}`, { cookie })).status).toBe(200);
    expect(await prisma.contentFormat.count({ where: { domainId: unused.id } })).toBe(0);
  });

  it('formats: a new default replaces the old one; the default cannot be unset, archived or deleted; 10 per domain', async () => {
    const { cookie } = await createTestUser();
    const d = (await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('F') })).json.data;
    const first = d.formats[0];
    const second = (await api(server.baseUrl, 'POST', `/api/domains/${d.id}/formats`, { cookie, body: { name: 'Ngắn', instructions: 'x', length: 'SHORT', isDefault: true } })).json.data;
    expect(second.isDefault).toBe(true);
    expect((await prisma.contentFormat.findUniqueOrThrow({ where: { id: first.id } })).isDefault).toBe(false);

    expect((await api(server.baseUrl, 'PATCH', `/api/formats/${second.id}`, { cookie, body: { isDefault: false } })).status).toBe(409);
    expect((await api(server.baseUrl, 'PATCH', `/api/formats/${second.id}`, { cookie, body: { isArchived: true } })).status).toBe(409);
    expect((await api(server.baseUrl, 'DELETE', `/api/formats/${second.id}`, { cookie })).status).toBe(409);

    const back = await api(server.baseUrl, 'PATCH', `/api/formats/${first.id}`, { cookie, body: { isDefault: true, withImage: false, example: 'Mẫu' } });
    expect(back.json.data).toMatchObject({ isDefault: true, withImage: false, example: 'Mẫu' });
    expect((await api(server.baseUrl, 'DELETE', `/api/formats/${second.id}`, { cookie })).status).toBe(200);

    for (let i = 0; i < 9; i++) await api(server.baseUrl, 'POST', `/api/domains/${d.id}/formats`, { cookie, body: { name: `F${i}`, instructions: 'x' } });
    const eleventh = await api(server.baseUrl, 'POST', `/api/domains/${d.id}/formats`, { cookie, body: { name: 'F10', instructions: 'x' } });
    expect(eleventh.status).toBe(409);
  });

  it('preview returns the composed prompt free; generate=true calls Gemini once and saves nothing', async () => {
    const { user, cookie } = await createTestUser();
    await saveSettings(user.id, { geminiApiKey: 'AIzaFakeKeyPreviewTest00000000000000' });
    const d = (await api(server.baseUrl, 'POST', '/api/domains', { cookie, body: newDomain('Nhật', { defaultHashtags: ['NhatNgu'] }) })).json.data;
    const formatId = d.formats[0].id;
    const spy = vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ post: 'Bài thử\n\n#hoc', image_prompt: 'a desk' } as never);

    const free = await api(server.baseUrl, 'POST', `/api/formats/${formatId}/preview`, { cookie, body: { idea: 'Chào sếp' } });
    expect(free.status).toBe(200);
    expect(free.json.data.prompt).toMatch('lĩnh vực "Nhật"');
    expect(free.json.data.prompt).toMatch('Ý tưởng bài viết: Chào sếp');
    expect(free.json.data.post).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();

    const paid = await api(server.baseUrl, 'POST', `/api/formats/${formatId}/preview`, { cookie, body: { idea: 'Chào sếp', generate: true } });
    expect(paid.json.data).toMatchObject({ post: 'Bài thử', hashtags: ['hoc', 'NhatNgu'], imagePrompt: 'a desk' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await prisma.post.count({ where: { userId: user.id } })).toBe(0);
  });
});
```

Trong `tests/isolation.db.test.ts`:

1. Sửa `type Ids` thành:

```ts
type Ids = { postId: string; pageId: string; targetId: string; scheduleId: string; templateId: string; domainId: string; formatId: string };
```

2. Thêm vào `ROUTE_CASES` (trước dòng `'GET /api/images/:postId'`):

```ts
  'GET /api/domains': { kind: 'list', path: '/api/domains?archived=1' },
  'POST /api/domains': {
    kind: 'own-scope',
    path: '/api/domains',
    body: { name: 'iso', format: { name: 'f', instructions: 'x' } },
    why: 'gắn req.user.id',
  },
  'PATCH /api/domains/:id': { kind: 'foreign-id', path: (b) => `/api/domains/${b.domainId}`, body: { name: 'hack' } },
  'DELETE /api/domains/:id': { kind: 'foreign-id', path: (b) => `/api/domains/${b.domainId}` },
  'POST /api/domains/:id/formats': { kind: 'foreign-id', path: (b) => `/api/domains/${b.domainId}/formats`, body: { name: 'hack', instructions: 'x' } },
  'PATCH /api/formats/:id': { kind: 'foreign-id', path: (b) => `/api/formats/${b.formatId}`, body: { name: 'hack' } },
  'DELETE /api/formats/:id': { kind: 'foreign-id', path: (b) => `/api/formats/${b.formatId}` },
  'POST /api/formats/:id/preview': { kind: 'foreign-id', path: (b) => `/api/formats/${b.formatId}/preview`, body: { idea: 'x' } },
```

3. Trong `beforeAll`, trước dòng `b = { postId: …` thêm:

```ts
    const domain = await prisma.contentDomain.create({
      data: { userId: userB.id, name: `${B_MARK} lĩnh vực`, formats: { create: { name: `${B_MARK} định dạng`, instructions: 'của B', isDefault: true } } },
      include: { formats: true },
    });
```

và sửa dòng gán `b` thành:

```ts
    b = {
      postId: post.id,
      pageId: page.id,
      targetId: post.targets[0].id,
      scheduleId: schedule.id,
      templateId: template.id,
      domainId: domain.id,
      formatId: domain.formats[0].id,
    };
```

4. Trong test `user B's data is intact…` thêm:

```ts
    expect(await prisma.contentDomain.findUnique({ where: { id: b.domainId } })).toMatchObject({ name: `${B_MARK} lĩnh vực`, isArchived: false });
    expect(await prisma.contentFormat.findUnique({ where: { id: b.formatId } })).toMatchObject({ name: `${B_MARK} định dạng` });
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `RUN_DB_TESTS=1 npx vitest run tests/domains-api.db.test.ts tests/isolation.db.test.ts`
Expected: FAIL — `/api/domains` trả 404; test phủ route báo thiếu route đã khai báo.

- [ ] **Step 3: Viết route**

`src/routes/domains.routes.ts`:

```ts
import { Router, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { DOMAIN_LIMIT, FORMAT_LIMIT } from '../lib/domains';
import { cleanTag } from '../lib/compose-prompt';

/** A user's content domains and their formats (spec §5.4). Formats by id live in formats.routes. */
const router = Router();
router.use(authenticate);

/** Optional text: '' clears it (null); absent stays absent (PATCH keeps the value). */
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null));

export const domainFields = {
  name: z.string().trim().min(1, 'Nhập tên lĩnh vực.').max(80),
  description: text(300),
  audience: text(1000),
  voice: text(1000),
  rules: text(2000),
  defaultHashtags: z
    .array(z.string())
    .max(10, 'Tối đa 10 hashtag mặc định.')
    .transform((tags) => [...new Set(tags.map(cleanTag).filter(Boolean))])
    .optional(),
  imageStyle: text(500),
  sortOrder: z.number().int().min(0).max(1000).optional(),
};

export const formatFields = {
  name: z.string().trim().min(1, 'Nhập tên định dạng.').max(80),
  instructions: z.string().trim().min(1, 'Nhập cấu trúc bài.').max(4000),
  example: text(4000),
  length: z.enum(['SHORT', 'MEDIUM', 'LONG']).optional(),
  withImage: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
};

export const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

const KEEP_ONE = 'Cần giữ ít nhất 1 lĩnh vực đang dùng.';

async function ownedDomain(id: string, userId: string) {
  const domain = await prisma.contentDomain.findFirst({ where: { id, userId } });
  if (!domain) throw createError(404, 'Lĩnh vực không tồn tại.');
  return domain;
}

const activeDomains = (userId: string) => prisma.contentDomain.count({ where: { userId, isArchived: false } });

router.get(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const withArchived = req.query.archived === '1';
    const domains = await prisma.contentDomain.findMany({
      where: { userId: req.user!.id, ...(withArchived ? {} : { isArchived: false }) },
      orderBy: [{ isArchived: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        formats: {
          where: withArchived ? {} : { isArchived: false },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          include: { _count: { select: { posts: true } } },
        },
        _count: { select: { pages: true, posts: true, schedules: true } },
      },
    });
    res.json({ success: true, data: domains });
  })
);

router.post(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { format, ...domain } = z.object({ ...domainFields, format: z.object(formatFields) }).parse(req.body);
    if ((await prisma.contentDomain.count({ where: { userId } })) >= DOMAIN_LIMIT) {
      throw createError(409, `Tối đa ${DOMAIN_LIMIT} lĩnh vực (tính cả lĩnh vực đã lưu trữ). Hãy xoá bớt lĩnh vực không dùng.`);
    }
    try {
      const created = await prisma.contentDomain.create({
        data: { ...domain, defaultHashtags: domain.defaultHashtags ?? [], userId, formats: { create: { ...format, isDefault: true } } },
        include: { formats: true },
      });
      res.status(201).json({ success: true, data: created });
    } catch (e) {
      if (isUniqueViolation(e)) throw createError(409, 'Bạn đã có lĩnh vực trùng tên này.');
      throw e;
    }
  })
);

router.patch(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const change = z.object({ ...domainFields, isArchived: z.boolean() }).partial().parse(req.body);
    const domain = await ownedDomain(req.params.id, userId);
    const archiving = change.isArchived === true && !domain.isArchived;
    if (archiving && (await activeDomains(userId)) <= 1) throw createError(409, KEEP_ONE);

    try {
      const updated = await prisma.$transaction(async (tx) => {
        // An archived domain is no Page's default any more
        if (archiving) await tx.facebookPage.updateMany({ where: { defaultDomainId: domain.id }, data: { defaultDomainId: null } });
        return tx.contentDomain.update({ where: { id: domain.id }, data: change, include: { formats: true } });
      });
      res.json({ success: true, data: updated });
    } catch (e) {
      if (isUniqueViolation(e)) throw createError(409, 'Bạn đã có lĩnh vực trùng tên này.');
      throw e;
    }
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const domain = await prisma.contentDomain.findFirst({
      where: { id: req.params.id, userId },
      include: { _count: { select: { pages: true, posts: true, schedules: true } } },
    });
    if (!domain) throw createError(404, 'Lĩnh vực không tồn tại.');
    const { pages, posts, schedules } = domain._count;
    if (pages + posts + schedules > 0) {
      throw createError(409, `Lĩnh vực đang được dùng (${pages} Page, ${posts} bài, ${schedules} lịch) — hãy lưu trữ thay vì xoá.`);
    }
    if (!domain.isArchived && (await activeDomains(userId)) <= 1) throw createError(409, KEEP_ONE);
    await prisma.contentDomain.delete({ where: { id: domain.id } });
    res.json({ success: true });
  })
);

router.post(
  '/:id/formats',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = z.object({ ...formatFields, isDefault: z.boolean().optional() }).parse(req.body);
    const domain = await ownedDomain(req.params.id, req.user!.id);
    if ((await prisma.contentFormat.count({ where: { domainId: domain.id } })) >= FORMAT_LIMIT) {
      throw createError(409, `Mỗi lĩnh vực tối đa ${FORMAT_LIMIT} định dạng.`);
    }
    try {
      const created = await prisma.$transaction(async (tx) => {
        if (body.isDefault) await tx.contentFormat.updateMany({ where: { domainId: domain.id }, data: { isDefault: false } });
        return tx.contentFormat.create({ data: { ...body, domainId: domain.id } });
      });
      res.status(201).json({ success: true, data: created });
    } catch (e) {
      if (isUniqueViolation(e)) throw createError(409, 'Lĩnh vực này đã có định dạng trùng tên.');
      throw e;
    }
  })
);

export default router;
```

`src/routes/formats.routes.ts`:

```ts
import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { composePrompt } from '../lib/compose-prompt';
import { getSettings } from '../lib/settings';
import { generateWithFormat } from '../services/ai.service';
import { formatFields, isUniqueViolation } from './domains.routes';

/** A single post format, found through its domain's owner (spec §5.4). */
const router = Router();
router.use(authenticate);

async function ownedFormat(id: string, userId: string) {
  const format = await prisma.contentFormat.findFirst({ where: { id, domain: { userId } }, include: { domain: true } });
  if (!format) throw createError(404, 'Định dạng không tồn tại.');
  return format;
}

const DEFAULT_NEEDED = 'Mỗi lĩnh vực cần 1 định dạng mặc định — hãy đặt định dạng khác làm mặc định trước.';

router.patch(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const change = z.object({ ...formatFields, isDefault: z.boolean(), isArchived: z.boolean() }).partial().parse(req.body);
    const format = await ownedFormat(req.params.id, req.user!.id);
    const willBeDefault = change.isDefault ?? format.isDefault;
    const willBeArchived = change.isArchived ?? format.isArchived;
    if (format.isDefault && change.isDefault === false) throw createError(409, DEFAULT_NEEDED);
    if (willBeDefault && willBeArchived) {
      throw createError(409, format.isDefault ? DEFAULT_NEEDED : 'Định dạng đã lưu trữ không làm mặc định được.');
    }

    try {
      const updated = await prisma.$transaction(async (tx) => {
        if (change.isDefault === true && !format.isDefault) {
          await tx.contentFormat.updateMany({ where: { domainId: format.domainId }, data: { isDefault: false } });
        }
        return tx.contentFormat.update({ where: { id: format.id }, data: change });
      });
      res.json({ success: true, data: updated });
    } catch (e) {
      if (isUniqueViolation(e)) throw createError(409, 'Lĩnh vực này đã có định dạng trùng tên.');
      throw e;
    }
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const format = await ownedFormat(req.params.id, req.user!.id);
    if (format.isDefault) throw createError(409, DEFAULT_NEEDED);
    const [posts, schedules] = await Promise.all([
      prisma.post.count({ where: { formatId: format.id } }),
      prisma.postSchedule.count({ where: { formatId: format.id } }),
    ]);
    if (posts + schedules > 0) throw createError(409, `Định dạng đang được dùng (${posts} bài, ${schedules} lịch) — hãy lưu trữ thay vì xoá.`);
    await prisma.contentFormat.delete({ where: { id: format.id } });
    res.json({ success: true });
  })
);

// Show the prompt (free) or try one generation (costs one Gemini call); never creates a post
router.post(
  '/:id/preview',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const body = z
      .object({
        idea: z.string().trim().min(1, 'Nhập ý tưởng để thử.').max(500),
        pageId: z.string().uuid().optional(),
        generate: z.boolean().optional(),
      })
      .parse(req.body);
    const format = await ownedFormat(req.params.id, userId);

    let pageName: string | null = null;
    if (body.pageId) {
      const page = await prisma.facebookPage.findFirst({ where: { id: body.pageId, userId }, select: { pageName: true } });
      if (!page) throw createError(404, 'Page not found');
      pageName = page.pageName;
    }

    const input = { domain: format.domain, format, idea: body.idea, pageName };
    if (!body.generate) {
      res.json({ success: true, data: { prompt: composePrompt(input) } });
      return;
    }

    const settings = await getSettings(userId);
    if (!settings.geminiApiKey) throw createError(400, 'Chưa có Gemini API key — nhập trong Cài đặt.');
    const { prompt, caption, hashtags, imagePrompt } = await generateWithFormat({
      ...input,
      gemini: { apiKey: settings.geminiApiKey, model: settings.geminiModel },
    });
    res.json({ success: true, data: { prompt, post: caption, hashtags, imagePrompt } });
  })
);

export default router;
```

`src/app.ts`:
- import `domainsRoutes from './routes/domains.routes'` và `formatsRoutes from './routes/formats.routes'`.
- Trong `API_ROUTERS`, sau `['/api/templates', templatesRoutes],` thêm:

```ts
  ['/api/domains', domainsRoutes],
  ['/api/formats', formatsRoutes],
```

- [ ] **Step 4: Chạy test**

Run: `npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run tests/domains-api.db.test.ts tests/isolation.db.test.ts`
Expected: PASS (domains-api 7, isolation 5).

- [ ] **Step 5: Commit**

```bash
git add src/routes/domains.routes.ts src/routes/formats.routes.ts src/app.ts tests/domains-api.db.test.ts tests/isolation.db.test.ts
git commit -m "feat(domains): API for content domains, formats and prompt preview"
```

---

### Task 6: Bài viết theo lĩnh vực/định dạng (route + worker + ảnh)

**Files:**
- Create: `src/services/post-writer.ts`, `tests/posts-domains.db.test.ts`
- Modify: `src/routes/posts.routes.ts` (schema create/update, list, get, generate, image generate), `src/services/scheduler.service.ts` (bước AI + ảnh), `src/services/ai.service.ts` (xoá `generateFromIdea`), `tests/multi-page.db.test.ts`, `tests/isolation.db.test.ts`

**Interfaces:**
- Consumes: `resolveDomainFormat`, `formatForPost` (Task 4); `generateWithFormat` (Task 3); `styledImagePrompt` (Task 2).
- Produces:
  - `writePost(post: WritablePost, settings: AppSettings): Promise<WrittenPost>` với `WritablePost = { userId: string; pageId: string; formatId: string | null; template: ContentTemplate | null; inputData: Prisma.JsonValue | null }` và `WrittenPost = { generated: GeneratedContent; aiPrompt: string | null; domainId: string | null; formatId: string | null }`.
  - `imageStyleOf(domainId: string | null): Promise<string | null>`.
  - API bài:
    - `POST /api/posts` và `PATCH /api/posts/:id` nhận `domainId?`, `formatId?`;
    - `GET /api/posts?domainId=` lọc theo lĩnh vực;
    - bài trả về kèm `domain: { id, name } | null`, `format: { id, name } | null`;
    - `POST /api/posts/:id/generate` lưu `aiPrompt`, `domainId`, `formatId`.

- [ ] **Step 1: Viết test** — `tests/posts-domains.db.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { GeminiClient } from '../src/lib/clients/gemini';
import { CloudflareClient } from '../src/lib/clients/cloudflare';
import { buildIdeaPrompt } from '../src/lib/compose-prompt';
import { createStarterDomains } from '../src/lib/domains';
import { removeImage } from '../src/lib/image-store';
import { saveSettings } from '../src/lib/settings';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('img')]);

/** A user with keys, one postable Page (Graph never called: token already VALID for the saved App ID) */
async function setup() {
  const u = await createTestUser();
  await saveSettings(u.user.id, {
    geminiApiKey: 'AIzaFakeKeyPostsDomains000000000000000',
    cfAccountId: 'fakeaccount',
    cfApiToken: 'fake-cf-token-posts-domains',
    fbAppId: '111',
  });
  const page = await prisma.facebookPage.create({
    data: { userId: u.user.id, pageId: `PD_${Date.now()}_${Math.random()}`, pageName: 'Nihongo', pageAccessToken: 'EAAfaketokenpostsdomainsxxxxxxxxxx', tokenStatus: 'VALID', tokenAppId: '111' },
  });
  return { ...u, page };
}

const gem = (post = 'Bài viết\n\n#ai', image_prompt = 'a teacher') =>
  vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ post, image_prompt } as never);

describe.skipIf(!process.env.RUN_DB_TESTS)('posts with domains and formats', { timeout: 90_000 }, () => {
  beforeAll(async () => {
    await cleanupTestUsers();
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('an old account writes exactly as before (legacy "Bài chuẩn" from its system prompt)', async () => {
    const { user, cookie, page } = await setup();
    await saveSettings(user.id, { systemPrompt: 'Prompt cũ của tôi. Chủ đề: {{topic}}' });
    const spy = gem();

    const created = await api(server.baseUrl, 'POST', '/api/posts', { cookie, body: { pageIds: [page.id], inputData: { basicInfo: 'Chào sếp' } } });
    expect(created.status).toBe(201);
    expect(created.json.data.format).toMatchObject({ name: 'Bài chuẩn' });

    const gen = await api(server.baseUrl, 'POST', `/api/posts/${created.json.data.id}/generate`, { cookie });
    expect(gen.status).toBe(200);
    const call = spy.mock.calls[0][0] as { systemInstruction: string; prompt: string };
    expect(call.systemInstruction).toBe(buildIdeaPrompt('Prompt cũ của tôi. Chủ đề: {{topic}}', 'Chào sếp'));
    expect(call.prompt).toBe('Viết bài Facebook cho ý tưởng: Chào sếp');
    expect(gen.json.data).toMatchObject({ caption: 'Bài viết', hashtags: ['ai'], imagePrompt: 'a teacher', aiPrompt: call.systemInstruction });
  });

  it('writes with the chosen domain + format, adds default hashtags and stores the prompt', async () => {
    const { user, cookie, page } = await setup();
    const domain = await prisma.contentDomain.create({
      data: {
        userId: user.id,
        name: 'Tiếng Nhật',
        voice: 'Dí dỏm',
        defaultHashtags: ['NhatNgu'],
        formats: { create: [{ name: 'Hỏi đáp', instructions: 'Mở bằng câu hỏi.', isDefault: true }, { name: 'Mẹo', instructions: 'Một mẹo.', length: 'SHORT' }] },
      },
      include: { formats: true },
    });
    const tip = domain.formats.find((f) => f.name === 'Mẹo')!;
    const spy = gem();

    const created = await api(server.baseUrl, 'POST', '/api/posts', {
      cookie,
      body: { pageIds: [page.id], domainId: domain.id, formatId: tip.id, inputData: { basicInfo: 'Chào sếp' } },
    });
    expect(created.json.data).toMatchObject({ domainId: domain.id, formatId: tip.id });
    const gen = await api(server.baseUrl, 'POST', `/api/posts/${created.json.data.id}/generate`, { cookie });

    const prompt = (spy.mock.calls[0][0] as { systemInstruction: string }).systemInstruction;
    expect(prompt).toMatch('lĩnh vực "Tiếng Nhật"');
    expect(prompt).toMatch('Định dạng bài "Mẹo":\nMột mẹo.\nĐộ dài: khoảng 80–120 từ.');
    expect(gen.json.data.hashtags).toEqual(['ai', 'NhatNgu']);
    expect(gen.json.data.aiPrompt).toBe(prompt);

    // Switching format on the draft (PATCH) is used by the next generation
    const qa = domain.formats.find((f) => f.name === 'Hỏi đáp')!;
    expect((await api(server.baseUrl, 'PATCH', `/api/posts/${created.json.data.id}`, { cookie, body: { formatId: qa.id } })).json.data.formatId).toBe(qa.id);
  });

  it('refuses a format from another domain (400) and filters the list by domain', async () => {
    const { user, cookie, page } = await setup();
    await createStarterDomains(user.id);
    const chung = await prisma.contentDomain.findFirstOrThrow({ where: { userId: user.id } });
    const other = await prisma.contentDomain.create({
      data: { userId: user.id, name: 'Khác', formats: { create: { name: 'F', instructions: 'x', isDefault: true } } },
      include: { formats: true },
    });
    const bad = await api(server.baseUrl, 'POST', '/api/posts', {
      cookie,
      body: { pageIds: [page.id], domainId: chung.id, formatId: other.formats[0].id, inputData: { basicInfo: 'x' } },
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('Định dạng không thuộc lĩnh vực đã chọn.');

    await api(server.baseUrl, 'POST', '/api/posts', { cookie, body: { pageIds: [page.id], domainId: other.id, inputData: { basicInfo: 'x' } } });
    await api(server.baseUrl, 'POST', '/api/posts', { cookie, body: { pageIds: [page.id], domainId: chung.id, inputData: { basicInfo: 'y' } } });
    const list = await api(server.baseUrl, 'GET', `/api/posts?domainId=${other.id}`, { cookie });
    expect(list.json.data).toHaveLength(1);
    expect(list.json.data[0]).toMatchObject({ domain: { id: other.id, name: 'Khác' }, format: { name: 'F' } });
  });

  it("AI images use the domain's image style", async () => {
    const { user, cookie, page } = await setup();
    const domain = await prisma.contentDomain.create({
      data: { userId: user.id, name: 'Ảnh', imageStyle: 'flat pastel illustration', formats: { create: { name: 'F', instructions: 'x', isDefault: true } } },
    });
    const post = await prisma.post.create({ data: { userId: user.id, pageId: page.id, domainId: domain.id, imagePrompt: 'a cat', caption: 'x' } });
    const cf = vi.spyOn(CloudflareClient.prototype, 'generateImage').mockResolvedValue({ buffer: PNG, mimeType: 'image/png' } as never);

    const res = await api(server.baseUrl, 'POST', `/api/posts/${post.id}/image/generate`, { cookie, body: {} });
    expect(res.status).toBe(200);
    expect(cf.mock.calls[0][0]).toBe('flat pastel illustration. a cat');
    expect(res.json.data.imagePrompt).toBe('a cat'); // stored without the style
    await removeImage((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).imagePath);
  });
});
```

Trong `tests/multi-page.db.test.ts`:
- Thêm vào import: `import { GeminiClient } from '../src/lib/clients/gemini';` và `import { CloudflareClient } from '../src/lib/clients/cloudflare';`.
- Thêm test trước `it('a double click never publishes the same Page twice'`:

```ts
  it('a text-only format publishes without generating an image', async () => {
    const domain = await prisma.contentDomain.create({
      data: { userId, name: `Chỉ chữ ${Date.now()}`, formats: { create: { name: 'Status', instructions: 'Một câu.', withImage: false, isDefault: true } } },
      include: { formats: true },
    });
    vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ post: 'Chỉ có chữ' } as never);
    const cf = vi.spyOn(CloudflareClient.prototype, 'generateImage');
    const post = await prisma.post.create({
      data: {
        userId,
        pageId: pages[0].id,
        domainId: domain.id,
        formatId: domain.formats[0].id,
        inputData: { basicInfo: 'Một ý' },
        status: 'GENERATING',
        targets: { create: [{ pageId: pages[0].id }] },
      },
      include: { targets: true },
    });
    try {
      await enqueuePost(post.id, userId, { targetIds: post.targets.map((t) => t.id), intervalMs: 0 });
      const done = await waitForStatus(post.id, ['PUBLISHED', 'FAILED']);
      expect(done).toMatchObject({ status: 'PUBLISHED', caption: 'Chỉ có chữ', imagePath: null, formatId: domain.formats[0].id });
      expect(done.aiPrompt).toMatch('Định dạng bài "Status"');
      expect(cf).not.toHaveBeenCalled();
    } finally {
      await prisma.post.delete({ where: { id: post.id } });
      await prisma.contentDomain.delete({ where: { id: domain.id } });
    }
  });
```

(`enqueuePost` không có `skipAi` ⇒ worker chạy bước AI. `mockFacebook` trong `beforeEach` đã chặn Graph, và nhánh `publishText` gọi POST `/{page}/feed`.)

Trong `tests/isolation.db.test.ts`, test `user A cannot attach user B's Page or template…`: thêm vào mảng `attempts`:

```ts
      ['POST', '/api/posts', { pageIds: [aOwn.pageId], domainId: b.domainId, inputData: { basicInfo: 'x' } }],
      ['POST', '/api/posts', { pageIds: [aOwn.pageId], formatId: b.formatId, inputData: { basicInfo: 'x' } }],
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `RUN_DB_TESTS=1 npx vitest run tests/posts-domains.db.test.ts tests/multi-page.db.test.ts tests/isolation.db.test.ts`
Expected: FAIL. Bài không có `format`. Prompt legacy vẫn lấy từ `settings.systemPrompt`: có thể trùng nội dung nhưng `aiPrompt` = null. Cloudflare nhận prompt không kèm style. Bài text-only không có `aiPrompt`. Isolation trả 201 thay vì 404.

- [ ] **Step 3: Viết code**

`src/services/post-writer.ts`:

```ts
import type { ContentTemplate, Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { createError } from '../middleware/error.middleware';
import type { AppSettings } from '../lib/settings';
import { formatForPost } from '../lib/domains';
import { generatePostContent, generateWithFormat, type GeneratedContent } from './ai.service';

/** One place that turns a post's idea into text — used by the route and the worker. */

export interface WritablePost {
  userId: string;
  pageId: string;
  formatId: string | null;
  template: ContentTemplate | null;
  inputData: Prisma.JsonValue | null;
}

export interface WrittenPost {
  generated: GeneratedContent;
  aiPrompt: string | null;
  domainId: string | null;
  formatId: string | null;
}

export async function writePost(post: WritablePost, settings: AppSettings): Promise<WrittenPost> {
  const variables = (post.inputData as Record<string, string> | null) ?? {};
  const gemini = { apiKey: settings.geminiApiKey, model: settings.geminiModel };

  // Legacy posts created from a content template
  if (post.template) {
    const generated = await generatePostContent({ gemini, templatePrompt: post.template.promptTemplate, variables });
    return { generated, aiPrompt: null, domainId: null, formatId: null };
  }

  const idea = variables.basicInfo?.trim();
  if (!idea) throw createError(400, 'Hãy nhập ý tưởng / thông tin cơ bản cho bài viết.');
  const { domain, format } = await formatForPost(post);
  const page = await prisma.facebookPage.findUnique({ where: { id: post.pageId }, select: { pageName: true } });
  const { prompt, ...generated } = await generateWithFormat({ gemini, domain, format, idea, pageName: page?.pageName });
  return { generated, aiPrompt: prompt, domainId: domain.id, formatId: format.id };
}

/** Visual style of the post's domain, prefixed to AI image prompts. */
export async function imageStyleOf(domainId: string | null): Promise<string | null> {
  if (!domainId) return null;
  const domain = await prisma.contentDomain.findUnique({ where: { id: domainId }, select: { imageStyle: true } });
  return domain?.imageStyle ?? null;
}
```

`src/routes/posts.routes.ts`:

1. Import:
   - `import { resolveDomainFormat } from '../lib/domains';`
   - `import { imageStyleOf, writePost } from '../services/post-writer';`
   - `import { styledImagePrompt } from '../lib/compose-prompt';`
   - Dòng import ai.service đổi thành `import { improveCaption } from '../services/ai.service';` (bỏ `generateFromIdea`, `generatePostContent`).
2. Thêm hằng (sau `LOCKED_MESSAGE`):

```ts
/** Domain + format labels shown with a post */
const domainFormatSelect = { domain: { select: { id: true, name: true } }, format: { select: { id: true, name: true } } } as const;
```

3. Trong `createPostSchema` thêm:

```ts
  domainId: z.string().uuid().optional(),
  formatId: z.string().uuid().optional(),
```

4. Trong `updatePostSchema`, trong `.object({ … })` thêm:

```ts
    domainId: z.string().uuid(),
    formatId: z.string().uuid(),
```

5. List route:
   - Destructure `const { status, pageId, domainId, page = '1', limit = '20' } = req.query;`.
   - Trong `where` thêm `...(domainId && { domainId: domainId as string }),`.
   - Trong `select` thêm `...domainFormatSelect,`.
6. Get route: trong `include` thêm `...domainFormatSelect,`.
7. Create route:
   - Ngay **trước** `const pageIds = await assertOwnPages(userId, requested);` thêm đoạn dưới. Id không thuộc user phải trả 404 **trước** mọi kiểm tra Page đăng được (409), như `assertOwnTemplate`:

```ts
    const { domain, format } = await resolveDomainFormat(userId, { domainId: data.domainId, formatId: data.formatId, pageId: requested[0] });
```

   - Trong `prisma.post.create({ data: { … } })` thêm `domainId: domain.id, formatId: format.id,`.
   - Trong `include` của nó thêm `...domainFormatSelect,`.
8. PATCH route: ngay trước `const caption = …` thêm:

```ts
    // Changing domain/format applies to the next "Viết lại"
    const picked =
      data.domainId || data.formatId
        ? await resolveDomainFormat(req.user!.id, { domainId: data.domainId, formatId: data.formatId, pageId: post.pageId })
        : null;
```

   - Trong `data: { … }` của `prisma.post.update` thêm `...(picked && { domainId: picked.domain.id, formatId: picked.format.id }),`.
   - Trong `include` thêm `...domainFormatSelect,`.
9. Generate route: thay toàn bộ thân `asyncHandler` bằng:

```ts
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await prisma.post.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { template: true },
    });
    if (!post) throw createError(404, 'Post not found');

    const settings = await getSettings(req.user!.id);
    const { generated, aiPrompt, domainId, formatId } = await writePost(post, settings);

    const updated = await prisma.post.update({
      where: { id: post.id },
      data: {
        caption: generated.caption,
        hashtags: generated.hashtags,
        imagePrompt: generated.imagePrompt,
        callToAction: generated.callToAction,
        aiResponse: JSON.stringify(generated),
        aiPrompt,
        ...(formatId && { domainId, formatId }),
        status: 'READY',
      },
      include: domainFormatSelect,
    });

    res.json({ success: true, data: { ...updated, generated } });
  })
```

10. Image generate route (`['/:id/preview-image', '/:id/image/generate']`): đổi dòng `const buffer = await generateImage({ cloudflare: cloudflareConfigFrom(settings), prompt });` thành:

```ts
    const buffer = await generateImage({
      cloudflare: cloudflareConfigFrom(settings),
      prompt: styledImagePrompt(await imageStyleOf(post.domainId), prompt),
    });
```

`src/services/scheduler.service.ts`:
- Import `import { imageStyleOf, writePost } from './post-writer';` và `import { styledImagePrompt } from '../lib/compose-prompt';`. Bỏ `generateFromIdea, generatePostContent` khỏi import `./ai.service` (xoá hẳn dòng import nếu không còn gì).
- Trong `runPublishJob`, thay khối từ `const settings = await getSettings(userId);\n      const gemini = …` đến hết `Object.assign(post, { … });` bằng:

```ts
      const settings = await getSettings(userId);
      const { generated, aiPrompt, domainId, formatId } = await writePost(post, settings);

      await prisma.post.update({
        where: { id: postId },
        data: {
          caption: generated.caption,
          hashtags: generated.hashtags,
          imagePrompt: generated.imagePrompt,
          callToAction: generated.callToAction,
          aiResponse: JSON.stringify(generated),
          aiPrompt,
          ...(formatId && { domainId, formatId }),
        },
      });

      await logStep(postId, 'ai_generation_completed', {
        captionLength: generated.caption.length,
        hashtagCount: generated.hashtags.length,
      });

      // Reload post with updated data
      Object.assign(post, {
        caption: generated.caption,
        hashtags: generated.hashtags,
        imagePrompt: generated.imagePrompt,
        callToAction: generated.callToAction,
        ...(formatId && { domainId, formatId }),
      });
```

- Trong bước ảnh, đổi `prompt: post.imagePrompt,` thành `prompt: styledImagePrompt(await imageStyleOf(post.domainId), post.imagePrompt),`.

`src/services/ai.service.ts`:
- Xoá hàm `generateFromIdea`.
- Import compose-prompt đổi thành `import { buildIdeaPrompt, composePrompt, mergeHashtags, type PromptDomain, type PromptFormat } from '../lib/compose-prompt';` và giữ `export { buildIdeaPrompt };` (tests/idea-prompt dùng).

- [ ] **Step 4: Chạy test**

Run: `npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run tests/posts-domains.db.test.ts tests/multi-page.db.test.ts tests/isolation.db.test.ts tests/generate-with-format.test.ts`
Expected: PASS (posts-domains 4, multi-page 11, isolation 5, generate-with-format 3).

- [ ] **Step 5: Commit**

```bash
git add src/services/post-writer.ts src/routes/posts.routes.ts src/services/scheduler.service.ts src/services/ai.service.ts tests/posts-domains.db.test.ts tests/multi-page.db.test.ts tests/isolation.db.test.ts
git commit -m "feat(posts): write with the chosen domain and format; image style; aiPrompt saved"
```

---

### Task 7: Lĩnh vực mặc định của Page, lịch đăng theo lĩnh vực, SQL Hostinger — **kết thúc M2**

**Files:**
- Modify: `src/routes/pages.routes.ts`, `src/routes/schedules.routes.ts`, `src/services/scheduler.service.ts` (`runScheduleJob`), `tests/isolation.db.test.ts`, `tests/multi-page.db.test.ts`, `prisma/hostinger-schema.sql`, `ROADMAP.md`

**Interfaces:**
- Consumes: `resolveDomainFormat` (Task 4).
- Produces:
  - `PATCH /api/pages/:id` `{ defaultDomainId: string | null }` ⇒ `{ id, defaultDomainId }`; `GET /api/pages` trả thêm `defaultDomainId`.
  - `POST /api/schedules` và `PUT /api/schedules/:id` nhận `domainId?`, `formatId?`.
  - Bài do lịch tạo mang `domainId` / `formatId` của lịch.

- [ ] **Step 1: Viết test**

`tests/isolation.db.test.ts`:
- Thêm vào `ROUTE_CASES` (sau `'POST /api/pages/:id/refresh-token'`): 

```ts
  'PATCH /api/pages/:id': { kind: 'foreign-id', path: (b) => `/api/pages/${b.pageId}`, body: { defaultDomainId: null } },
```

- Trong mảng `attempts` của test `user A cannot attach…` thêm:

```ts
      ['PATCH', `/api/pages/${aOwn.pageId}`, { defaultDomainId: b.domainId }],
      ['PUT', `/api/schedules/${aOwn.scheduleId}`, { domainId: b.domainId }],
      ['POST', '/api/schedules', { pageId: aOwn.pageId, formatId: b.formatId, name: 'x', frequency: 'DAILY', startDate: future }],
```

- Và sau `expect(failures).toEqual([]);` thêm:

```ts
    expect(await prisma.facebookPage.findUnique({ where: { id: aOwn.pageId } })).toMatchObject({ defaultDomainId: null });
```

- Test `user B's data is intact…` thêm: `expect(await prisma.facebookPage.findUnique({ where: { id: b.pageId } })).toMatchObject({ defaultDomainId: null });`

`tests/multi-page.db.test.ts`, thêm test trước `it('a double click…'`:

```ts
  it("a schedule's posts carry the schedule's domain and format", async () => {
    const domain = await prisma.contentDomain.create({
      data: { userId, name: `Lịch ${Date.now()}`, formats: { create: { name: 'F', instructions: 'x', isDefault: true } } },
      include: { formats: true },
    });
    const schedule = await prisma.postSchedule.create({
      data: {
        userId,
        pageId: pages[0].id,
        name: 'Lịch theo lĩnh vực',
        frequency: 'DAILY',
        startDate: new Date(Date.now() - 86_400_000),
        domainId: domain.id,
        formatId: domain.formats[0].id,
      },
    });
    const key = `schedule:${schedule.id}`;
    try {
      await upsertKeyedJob(key, 'run_schedule', { scheduleId: schedule.id }, new Date());
      const until = Date.now() + 15_000;
      let post = null;
      while (Date.now() < until && !post) {
        await new Promise((r) => setTimeout(r, 150));
        post = await prisma.post.findFirst({ where: { userId, targets: { some: { pageId: pages[0].id } }, domainId: domain.id } });
      }
      expect(post).toMatchObject({ domainId: domain.id, formatId: domain.formats[0].id });
    } finally {
      await prisma.job.deleteMany({ where: { key } });
      await prisma.post.deleteMany({ where: { domainId: domain.id } });
      await prisma.postSchedule.delete({ where: { id: schedule.id } });
      await prisma.contentDomain.delete({ where: { id: domain.id } });
    }
  });
```

Tạo `tests/pages-domain.db.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';

let server: Awaited<ReturnType<typeof startTestServer>>;

describe.skipIf(!process.env.RUN_DB_TESTS)('Page default domain', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await cleanupTestUsers();
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('sets and clears the default domain; archived domains are refused; the list shows it', async () => {
    const { user, cookie } = await createTestUser();
    const page = await prisma.facebookPage.create({ data: { userId: user.id, pageId: `PDD_${Date.now()}`, pageName: 'P', pageAccessToken: 'EAAfaketokenpagedomainxxxxxxxxxxxx' } });
    const domain = await prisma.contentDomain.create({ data: { userId: user.id, name: 'Nhật' } });
    const archived = await prisma.contentDomain.create({ data: { userId: user.id, name: 'Cũ', isArchived: true } });

    const set = await api(server.baseUrl, 'PATCH', `/api/pages/${page.id}`, { cookie, body: { defaultDomainId: domain.id } });
    expect(set.json.data).toEqual({ id: page.id, defaultDomainId: domain.id });
    const listed = (await api(server.baseUrl, 'GET', '/api/pages', { cookie })).json.data;
    expect(listed.find((p: { id: string }) => p.id === page.id).defaultDomainId).toBe(domain.id);

    expect((await api(server.baseUrl, 'PATCH', `/api/pages/${page.id}`, { cookie, body: { defaultDomainId: archived.id } })).status).toBe(404);
    expect((await api(server.baseUrl, 'PATCH', `/api/pages/${page.id}`, { cookie, body: { defaultDomainId: null } })).json.data.defaultDomainId).toBeNull();
  });
});
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `RUN_DB_TESTS=1 npx vitest run tests/pages-domain.db.test.ts tests/isolation.db.test.ts tests/multi-page.db.test.ts`
Expected: FAIL — PATCH `/api/pages/:id` 404 (route chưa có); lịch tạo bài không có `domainId`; isolation thiếu route.

- [ ] **Step 3: Viết code**

`src/routes/pages.routes.ts`:
- Trong `publicPageSelect` thêm `defaultDomainId: true,`.
- Trước route `router.delete('/:id', …)` thêm:

```ts
// ─── Default content domain of a Page ───────────

router.patch(
  '/:id',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { defaultDomainId } = z.object({ defaultDomainId: z.string().uuid().nullable() }).parse(req.body);
    const page = await prisma.facebookPage.findFirst({ where: { id: req.params.id, userId }, select: { id: true } });
    if (!page) throw createError(404, 'Page not found');
    if (defaultDomainId && !(await prisma.contentDomain.findFirst({ where: { id: defaultDomainId, userId, isArchived: false } }))) {
      throw createError(404, 'Lĩnh vực không tồn tại.');
    }
    const updated = await prisma.facebookPage.update({
      where: { id: page.id },
      data: { defaultDomainId },
      select: { id: true, defaultDomainId: true },
    });
    res.json({ success: true, data: updated });
  })
);
```

(Nếu file chưa import `z` thì thêm `import { z } from 'zod';`.)

`src/routes/schedules.routes.ts`:
- `import { resolveDomainFormat } from '../lib/domains';`
- Trong `createScheduleSchema` thêm `domainId: z.string().uuid().optional(), formatId: z.string().uuid().optional(),`.
- POST: sau `await assertOwnTemplate(userId, data.templateId);` thêm:

```ts
    const picked =
      data.domainId || data.formatId ? await resolveDomainFormat(userId, { domainId: data.domainId, formatId: data.formatId, pageId: data.pageId }) : null;
```

  - Trong `prisma.postSchedule.create({ data: { … } })` thêm `domainId: picked?.domain.id, formatId: picked?.format.id,`.
- PUT: sau `await assertOwnTemplate(req.user!.id, data.templateId);` thêm:

```ts
    const picked =
      data.domainId || data.formatId
        ? await resolveDomainFormat(req.user!.id, { domainId: data.domainId, formatId: data.formatId, pageId: data.pageId ?? schedule.pageId })
        : null;
```

  - Sửa `data: { ...data, … }` của `prisma.postSchedule.update` thành:

```ts
      data: {
        ...data,
        startDate: data.startDate ? new Date(data.startDate) : undefined,
        endDate: data.endDate ? new Date(data.endDate) : undefined,
        ...(picked && { domainId: picked.domain.id, formatId: picked.format.id }),
      },
```

`src/services/scheduler.service.ts` (`runScheduleJob`): trong `prisma.post.create({ data: { … } })` thêm `domainId: schedule.domainId, formatId: schedule.formatId,`.

- [ ] **Step 4: Chạy test**

Run: `npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run tests/pages-domain.db.test.ts tests/isolation.db.test.ts tests/multi-page.db.test.ts`
Expected: PASS.

- [ ] **Step 5: SQL Hostinger + ROADMAP + toàn bộ test**

```bash
head -9 prisma/hostinger-schema.sql > "$TMPDIR/head.sql"
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > "$TMPDIR/body.sql"
cat "$TMPDIR/head.sql" "$TMPDIR/body.sql" > prisma/hostinger-schema.sql
R="docker exec -i autopost_mariadb mariadb -uroot -pautopost_root"
$R -e "DROP DATABASE IF EXISTS sqltest; CREATE DATABASE sqltest CHARACTER SET utf8mb4;" && $R sqltest < prisma/hostinger-schema.sql && $R sqltest -e "SHOW TABLES LIKE 'content_%'" && $R -e "DROP DATABASE sqltest"
```
(`$TMPDIR` = thư mục scratchpad của phiên.) Expected: 2 bảng `content_domains`, `content_formats`.

`ROADMAP.md`, trong mục Phase 1d, đổi dòng `- ⬜ M2 Lĩnh vực & Định dạng (backend) · …` thành:

```markdown
- ✅ M2 (2026-09-28) Lĩnh vực & Định dạng (backend): bảng `content_domains`/`content_formats`, ghép prompt, chuyển prompt cũ thành "Mặc định / Bài chuẩn" (viết y hệt trước), bộ khởi đầu cho member mới, API + xem trước prompt, lĩnh vực mặc định của Page, lịch theo lĩnh vực — plan `docs/superpowers/plans/2026-09-28-m2-m4-content-domains.md`
- ⬜ M3 Giao diện Lĩnh vực/Tạo bài · ⬜ M4 Tài liệu & deploy
```

Toàn bộ test (không có dev server):

```bash
netstat -ano | grep -E ":(3000|5173) .*LISTENING" || echo "no dev servers"
npx tsc --noEmit && npx vitest run && RUN_DB_TESTS=1 npx vitest run
```
Expected: tất cả PASS.

- [ ] **Step 6: Commit và DỪNG (checkpoint M2)**

```bash
git branch --show-current
git add src/routes/pages.routes.ts src/routes/schedules.routes.ts src/services/scheduler.service.ts tests/isolation.db.test.ts tests/multi-page.db.test.ts tests/pages-domain.db.test.ts prisma/hostinger-schema.sql ROADMAP.md
git commit -m "feat(domains): Page default domain, schedules by domain; M2 done"
```

Báo người dùng: M2 xong (API, chưa có giao diện). Tài khoản cũ viết y hệt. Chờ người dùng đồng ý rồi mới sang M3.

---

# M3 — Giao diện

### Task 8: Client API cho lĩnh vực + menu + route

**Files:**
- Modify: `client/src/api.ts`, `client/src/App.tsx`, `client/src/components/Sidebar.tsx`
- Create: `client/src/pages/DomainsPage.tsx` (tạm, viết thật ở Task 9)

**Interfaces:**
- Produces:
  - Kiểu: `FormatLength`, `ContentFormat`, `ContentDomain`, `DomainInput`, `FormatInput`, `FormatPreview`, và `LENGTH_LABEL: Record<FormatLength, string>`.
  - `domainsApi`: `list(archived?)`, `create`, `update`, `remove`, `createFormat`, `updateFormat`, `removeFormat`, `preview`.
  - `pagesApi.setDefaultDomain(id, domainId | null)`; `PageInfo.defaultDomainId: string | null`.
  - `postsApi.list` params nhận `domainId`; `PostUpdate` có `domainId?`, `formatId?`.
  - `ApiError` dùng thông báo validation đầu tiên thay cho "Validation failed".

- [ ] **Step 1: Sửa `client/src/api.ts`**

Trong `apiFetch`, đổi dòng throw thành:

```ts
    // Zod errors: show the first field message instead of "Validation failed"
    const detail: string | undefined = Array.isArray(data.details) ? data.details[0]?.message : undefined;
    throw new ApiError(detail ?? data.error ?? 'Request failed', response.status, code);
```

Trong `interface PageInfo` thêm `defaultDomainId: string | null;`. Trong `pagesApi` thêm:

```ts
  setDefaultDomain: (id: string, defaultDomainId: string | null) =>
    apiFetch<{ id: string; defaultDomainId: string | null }>(`/pages/${id}`, { method: 'PATCH', body: JSON.stringify({ defaultDomainId }) }),
```

Trong `interface PostUpdate` thêm `domainId?: string; formatId?: string;`. Trong `postsApi.list` đổi kiểu params thành `params?: { status?: string; pageId?: string; domainId?: string; page?: string; limit?: string }`.

Sau khối `// ─── Pages API` (trước `// ─── Templates`), thêm:

```ts
// ─── Content domains & formats ──────────────────

export type FormatLength = 'SHORT' | 'MEDIUM' | 'LONG';

export const LENGTH_LABEL: Record<FormatLength, string> = {
  SHORT: 'Ngắn · 80–120 từ',
  MEDIUM: 'Vừa · 150–250 từ',
  LONG: 'Dài · 300–450 từ',
};

export interface ContentFormat {
  id: string;
  domainId: string;
  name: string;
  instructions: string;
  example: string | null;
  length: FormatLength;
  withImage: boolean;
  isDefault: boolean;
  legacyPrompt: boolean;
  isArchived: boolean;
  sortOrder: number;
  _count?: { posts: number };
}

export interface ContentDomain {
  id: string;
  name: string;
  description: string | null;
  audience: string | null;
  voice: string | null;
  rules: string | null;
  defaultHashtags: string[] | null;
  imageStyle: string | null;
  isArchived: boolean;
  sortOrder: number;
  formats: ContentFormat[];
  _count?: { pages: number; posts: number; schedules: number };
}

export interface DomainInput {
  name?: string;
  description?: string | null;
  audience?: string | null;
  voice?: string | null;
  rules?: string | null;
  defaultHashtags?: string[];
  imageStyle?: string | null;
  isArchived?: boolean;
}

export interface FormatInput {
  name?: string;
  instructions?: string;
  example?: string | null;
  length?: FormatLength;
  withImage?: boolean;
  isDefault?: boolean;
  isArchived?: boolean;
}

export interface FormatPreview {
  prompt: string;
  post?: string;
  hashtags?: string[];
  imagePrompt?: string;
}

export const domainsApi = {
  list: (archived = false) => apiFetch<ContentDomain[]>(`/domains${archived ? '?archived=1' : ''}`),
  create: (body: DomainInput & { name: string; format: FormatInput & { name: string; instructions: string } }) =>
    apiFetch<ContentDomain>('/domains', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: DomainInput) => apiFetch<ContentDomain>(`/domains/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (id: string) => apiFetch(`/domains/${id}`, { method: 'DELETE' }),
  createFormat: (domainId: string, body: FormatInput & { name: string; instructions: string }) =>
    apiFetch<ContentFormat>(`/domains/${domainId}/formats`, { method: 'POST', body: JSON.stringify(body) }),
  updateFormat: (id: string, body: FormatInput) => apiFetch<ContentFormat>(`/formats/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  removeFormat: (id: string) => apiFetch(`/formats/${id}`, { method: 'DELETE' }),
  /** `generate: true` costs one Gemini call of the user's key */
  preview: (formatId: string, body: { idea: string; pageId?: string; generate?: boolean }) =>
    apiFetch<FormatPreview>(`/formats/${formatId}/preview`, { method: 'POST', body: JSON.stringify(body) }),
};
```

- [ ] **Step 2: Route + menu**

- `client/src/pages/DomainsPage.tsx` (tạm): `export default function DomainsPage() {\n  return null;\n}`.
- `App.tsx`:
  - `import DomainsPage from './pages/DomainsPage';`.
  - Trước route `/admin/users` thêm:

```tsx
        <Route
          path="/domains"
          element={
            <ProtectedRoute>
              <AppLayout>
                <DomainsPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
```

- `Sidebar.tsx`:
  - Thêm `Shapes` vào import lucide.
  - Trong nhóm "Nội dung", ngay sau NavLink "Lịch đăng" (tìm `<span className="nav-label">Lịch đăng</span>` rồi tới `</NavLink>` kế tiếp) thêm:

```tsx
          <NavLink to="/domains" className={navClass}>
            <Shapes className="nav-icon" strokeWidth={1.8} />
            <span className="nav-label">Lĩnh vực</span>
          </NavLink>
```

- [ ] **Step 3: Kiểm tra**

Run: `cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b`
Expected: sạch.

- [ ] **Step 4: Commit**

```bash
git add client/src/api.ts client/src/App.tsx client/src/components/Sidebar.tsx client/src/pages/DomainsPage.tsx
git commit -m "feat(client): domains API client, menu item and route"
```

---

### Task 9: Trang Lĩnh vực

**Files:**
- Create: `client/src/components/FormatDrawer.tsx`, `client/src/components/PromptPreview.tsx`
- Modify: `client/src/pages/DomainsPage.tsx` (viết thật), `client/src/index.css`

**Interfaces:**
- Consumes: `domainsApi`, `ContentDomain`, `ContentFormat`, `LENGTH_LABEL`, `ApiError` (Task 8); `useToast`.
- Produces:
  - `FormatDrawer({ domainId, format?, onClose, onSaved })`.
  - `PromptPreview({ formats: ContentFormat[]; pageId?: string; idea?: string; compact?: boolean })` (dùng lại ở Tạo bài).
  - `DOMAINS_SEEN_KEY = 'autopost.domainsSeen'` (export từ `DomainsPage.tsx`, Dashboard dùng).

- [ ] **Step 1: `client/src/components/PromptPreview.tsx`**

```tsx
import { useState } from 'react';
import { Eye, Sparkles } from 'lucide-react';
import { domainsApi, ApiError, type ContentFormat, type FormatPreview } from '../api';

interface Props {
  formats: ContentFormat[];
  /** Fixed format (Create Post); otherwise a select is shown */
  formatId?: string;
  pageId?: string;
  idea?: string;
  compact?: boolean;
}

/** "Xem prompt" (free) and "Thử viết" (1 Gemini call) for a format. */
export default function PromptPreview({ formats, formatId: fixedFormat, pageId, idea: fixedIdea, compact = false }: Props) {
  const [formatId, setFormatId] = useState(fixedFormat ?? formats.find((f) => f.isDefault)?.id ?? formats[0]?.id ?? '');
  const [idea, setIdea] = useState('');
  const [result, setResult] = useState<FormatPreview | null>(null);
  const [busy, setBusy] = useState<null | 'prompt' | 'write'>(null);
  const [error, setError] = useState<string | null>(null);
  const activeFormat = fixedFormat ?? formatId;
  const activeIdea = (fixedIdea ?? idea).trim();

  async function run(generate: boolean) {
    if (!activeFormat || !activeIdea) return setError('Nhập ý tưởng để xem prompt.');
    setBusy(generate ? 'write' : 'prompt');
    setError(null);
    try {
      setResult((await domainsApi.preview(activeFormat, { idea: activeIdea, pageId, generate })).data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Không xem trước được.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={`prompt-preview ${compact ? 'compact' : ''}`}>
      {!compact && (
        <div className="prompt-preview-inputs">
          <label className="form-label" htmlFor="pp-idea">Ý tưởng thử</label>
          <input id="pp-idea" className="form-input" value={idea} maxLength={500} onChange={(e) => setIdea(e.target.value)} placeholder="VD: Cách chào sếp buổi sáng" />
          {!fixedFormat && formats.length > 1 && (
            <select className="form-select" aria-label="Định dạng để thử" value={formatId} onChange={(e) => setFormatId(e.target.value)}>
              {formats.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          )}
        </div>
      )}
      <div className="row prompt-preview-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => run(false)} disabled={!!busy}>
          {busy === 'prompt' ? <div className="spinner" /> : <Eye size={14} aria-hidden="true" />} Xem prompt
        </button>
        {!compact && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => run(true)} disabled={!!busy}>
            {busy === 'write' ? <div className="spinner" /> : <Sparkles size={14} aria-hidden="true" />} Thử viết
          </button>
        )}
        {!compact && <span className="field-hint prompt-cost">Thử viết dùng 1 lượt Gemini của bạn · không tạo bài</span>}
      </div>
      {error && <p className="auth-error" role="alert">{error}</p>}
      {result && (
        <div className="prompt-result">
          <pre className="prompt-text" aria-label="Prompt gửi cho AI">{result.prompt}</pre>
          {result.post && (
            <div className="prompt-sample">
              <strong>Bài thử</strong>
              <p>{result.post}</p>
              {!!result.hashtags?.length && <p className="muted">{result.hashtags.map((h) => `#${h}`).join(' ')}</p>}
              {result.imagePrompt && <p className="muted mono">image_prompt: {result.imagePrompt}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: `client/src/components/FormatDrawer.tsx`**

```tsx
import { useState, type FormEvent } from 'react';
import { X, Archive, ArchiveRestore, Trash2 } from 'lucide-react';
import { domainsApi, ApiError, LENGTH_LABEL, type ContentFormat, type FormatLength } from '../api';
import { useToast } from './Toast';

interface Props {
  domainId: string;
  format?: ContentFormat;
  onClose: () => void;
  onSaved: () => void;
}

const LENGTHS: FormatLength[] = ['SHORT', 'MEDIUM', 'LONG'];

/** Side panel to add or edit a post format of a domain. */
export default function FormatDrawer({ domainId, format, onClose, onSaved }: Props) {
  const toast = useToast();
  const [name, setName] = useState(format?.name ?? '');
  const [instructions, setInstructions] = useState(format?.instructions ?? '');
  const [example, setExample] = useState(format?.example ?? '');
  const [length, setLength] = useState<FormatLength>(format?.length ?? 'MEDIUM');
  const [withImage, setWithImage] = useState(format?.withImage ?? true);
  const [isDefault, setIsDefault] = useState(format?.isDefault ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast.success(done);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Không lưu được. Thử lại sau.');
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const body = { name, instructions, example: example.trim() || null, length, withImage, isDefault };
    void act(
      () => (format ? domainsApi.updateFormat(format.id, body) : domainsApi.createFormat(domainId, body)),
      format ? `Đã lưu định dạng "${name}".` : `Đã thêm định dạng "${name}".`
    );
  }

  return (
    <div className="modal-overlay drawer-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="drawer-panel" role="dialog" aria-modal="true" aria-labelledby="fd-title" onSubmit={submit}>
        <header className="modal-head">
          <h2 id="fd-title">{format ? `Sửa định dạng "${format.name}"` : 'Thêm định dạng bài'}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Đóng">
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="member-body">
          {format?.legacyPrompt && (
            <p className="field-hint legacy-note">
              Định dạng chuyển từ System prompt cũ: AI dùng <strong>nguyên văn</strong> phần cấu trúc bên dưới, không dùng các khối của lĩnh vực.
            </p>
          )}
          <label className="form-label" htmlFor="fd-name">Tên định dạng</label>
          <input id="fd-name" className="form-input" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="VD: Hỏi đáp" />

          <label className="form-label" htmlFor="fd-ins">Cấu trúc bài</label>
          <textarea
            id="fd-ins"
            className="form-textarea"
            rows={7}
            required
            maxLength={4000}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Mở bài thế nào, thân bài gồm gì, kết bài ra sao. Có thể dùng {{idea}}, {{page_name}}."
          />

          <span className="form-label" id="fd-len">Độ dài</span>
          <div className="segmented" role="radiogroup" aria-labelledby="fd-len">
            {LENGTHS.map((l) => (
              <button key={l} type="button" role="radio" aria-checked={length === l} className={length === l ? 'active' : ''} onClick={() => setLength(l)}>
                {LENGTH_LABEL[l]}
              </button>
            ))}
          </div>

          <label className="form-label" htmlFor="fd-ex">Bài mẫu (tuỳ chọn)</label>
          <textarea id="fd-ex" className="form-textarea" rows={5} maxLength={4000} value={example} onChange={(e) => setExample(e.target.value)} placeholder="AI tham khảo phong cách, không chép lại." />

          <label className="check-row">
            <input type="checkbox" checked={withImage} onChange={(e) => setWithImage(e.target.checked)} />
            Kèm ảnh AI (bỏ chọn cho bài chỉ có chữ)
          </label>
          <label className="check-row">
            <input type="checkbox" checked={isDefault} disabled={format?.isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            Định dạng mặc định của lĩnh vực
          </label>

          {error && <p className="auth-error" role="alert">{error}</p>}
        </div>

        <footer className="modal-foot">
          <div className="row" style={{ gap: 6 }}>
            {format && !format.isDefault && (
              <>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() =>
                    act(() => domainsApi.updateFormat(format.id, { isArchived: !format.isArchived }), format.isArchived ? 'Đã dùng lại định dạng.' : 'Đã lưu trữ định dạng.')
                  }
                >
                  {format.isArchived ? <ArchiveRestore size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
                  {format.isArchived ? 'Dùng lại' : 'Lưu trữ'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm danger-hover"
                  disabled={busy}
                  aria-label="Xoá định dạng"
                  onClick={() => act(() => domainsApi.removeFormat(format.id), 'Đã xoá định dạng.')}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </>
            )}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Huỷ</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy && <div className="spinner" />} {format ? 'Lưu' : 'Thêm định dạng'}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: `client/src/pages/DomainsPage.tsx`**

```tsx
import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Plus, Star, Archive, ArchiveRestore, Trash2, ImageIcon, Type, X } from 'lucide-react';
import { domainsApi, ApiError, LENGTH_LABEL, type ContentDomain, type ContentFormat, type DomainInput } from '../api';
import { useToast } from '../components/Toast';
import FormatDrawer from '../components/FormatDrawer';
import PromptPreview from '../components/PromptPreview';
import { cleanTagInput } from '../components/PostBits';

export const DOMAINS_SEEN_KEY = 'autopost.domainsSeen';

type Draft = Required<Pick<DomainInput, 'name'>> & {
  description: string;
  audience: string;
  voice: string;
  rules: string;
  imageStyle: string;
  defaultHashtags: string[];
};

const EMPTY: Draft = { name: '', description: '', audience: '', voice: '', rules: '', imageStyle: '', defaultHashtags: [] };
const NEW_FORMAT = { name: 'Bài chuẩn', instructions: 'Mở bằng 1 câu gây chú ý, 3–4 đoạn ngắn dễ đọc trên điện thoại, kết bằng lời mời bình luận.' };

const toDraft = (d: ContentDomain): Draft => ({
  name: d.name,
  description: d.description ?? '',
  audience: d.audience ?? '',
  voice: d.voice ?? '',
  rules: d.rules ?? '',
  imageStyle: d.imageStyle ?? '',
  defaultHashtags: d.defaultHashtags ?? [],
});

/** Content domains: how AI writes (spec §6 "/domains"). */
export default function DomainsPage() {
  const toast = useToast();
  const [domains, setDomains] = useState<ContentDomain[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [tagDraft, setTagDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ format?: ContentFormat } | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  async function load(keep?: string) {
    try {
      const list = (await domainsApi.list(true)).data;
      setDomains(list);
      const next = keep && list.some((d) => d.id === keep) ? keep : list.find((d) => !d.isArchived)?.id ?? null;
      setSelectedId((cur) => (cur === 'new' && !keep ? cur : next));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Không tải được lĩnh vực.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    try {
      localStorage.setItem(DOMAINS_SEEN_KEY, '1');
    } catch {
      /* private mode */
    }
  }, []);

  const selected = domains.find((d) => d.id === selectedId) ?? null;
  useEffect(() => {
    setDraft(selected ? toDraft(selected) : EMPTY);
    setTagDraft('');
  }, [selectedId, selected?.id]);

  const active = useMemo(() => domains.filter((d) => !d.isArchived), [domains]);
  const archived = useMemo(() => domains.filter((d) => d.isArchived), [domains]);
  const set = (key: keyof Draft) => (value: string) => setDraft((d) => ({ ...d, [key]: value }));

  function addTags(raw: string) {
    const tags = raw.split(/[,\s]+/).map(cleanTagInput).filter(Boolean);
    if (tags.length) setDraft((d) => ({ ...d, defaultHashtags: [...new Set([...d.defaultHashtags, ...tags])].slice(0, 10) }));
    setTagDraft('');
  }

  function onTagKey(e: KeyboardEvent<HTMLInputElement>) {
    if (['Enter', ',', ' '].includes(e.key)) {
      e.preventDefault();
      addTags(tagDraft);
    }
  }

  async function run(key: string, fn: () => Promise<unknown>, done: string, keep?: string) {
    setBusy(key);
    try {
      await fn();
      toast.success(done);
      await load(keep);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Không lưu được.');
    } finally {
      setBusy(null);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const body = {
      name: draft.name,
      description: draft.description,
      audience: draft.audience,
      voice: draft.voice,
      rules: draft.rules,
      imageStyle: draft.imageStyle,
      defaultHashtags: draft.defaultHashtags,
    };
    if (selectedId === 'new') {
      setBusy('save');
      try {
        const created = (await domainsApi.create({ ...body, format: NEW_FORMAT })).data;
        toast.success(`Đã tạo lĩnh vực "${created.name}" kèm định dạng "Bài chuẩn".`);
        await load(created.id);
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'Không tạo được.');
      } finally {
        setBusy(null);
      }
      return;
    }
    if (selected) await run('save', () => domainsApi.update(selected.id, body), 'Đã lưu lĩnh vực.', selected.id);
  }

  if (loading) return <div className="loading-page"><div className="spinner spinner-lg" /></div>;

  const count = (d: ContentDomain) => `${d.formats.filter((f) => !f.isArchived).length} định dạng · ${d._count?.pages ?? 0} Page · ${d._count?.posts ?? 0} bài`;

  return (
    <div className="stack domains-page">
      <div className="page-header">
        <h1>Lĩnh vực nội dung</h1>
        <p>Mỗi lĩnh vực là một cách viết (đối tượng, giọng văn, quy tắc, ảnh) với nhiều định dạng bài. Khi tạo bài bạn chọn lĩnh vực + định dạng.</p>
      </div>

      <div className="domains-grid">
        <aside className="card flush domain-list" aria-label="Danh sách lĩnh vực">
          {active.map((d) => (
            <button key={d.id} type="button" className={`domain-item ${d.id === selectedId ? 'selected' : ''}`} aria-current={d.id === selectedId} onClick={() => setSelectedId(d.id)}>
              <span className="name">{d.name}</span>
              <span className="muted">{count(d)}</span>
            </button>
          ))}
          <button type="button" className="domain-item add" onClick={() => setSelectedId('new')} disabled={domains.length >= 20}>
            <Plus size={15} aria-hidden="true" /> Lĩnh vực mới
          </button>
          {archived.length > 0 && (
            <>
              <button type="button" className="link-btn domain-archived-toggle" onClick={() => setShowArchived((v) => !v)}>
                {showArchived ? 'Ẩn' : 'Xem'} {archived.length} lĩnh vực đã lưu trữ
              </button>
              {showArchived &&
                archived.map((d) => (
                  <button key={d.id} type="button" className={`domain-item archived ${d.id === selectedId ? 'selected' : ''}`} onClick={() => setSelectedId(d.id)}>
                    <span className="name">{d.name}</span>
                    <span className="muted">Đã lưu trữ · {count(d)}</span>
                  </button>
                ))}
            </>
          )}
        </aside>

        {selectedId && (
          <div className="stack" style={{ minWidth: 0 }}>
            <form className="card stack domain-form" onSubmit={save} key={selectedId}>
              <div className="row domain-form-head">
                <h2 className="card-title">{selectedId === 'new' ? 'Lĩnh vực mới' : draft.name || 'Lĩnh vực'}</h2>
                {selected?.isArchived && <span className="badge badge-draft">Đã lưu trữ</span>}
              </div>

              <fieldset className="domain-block">
                <legend>Thông tin</legend>
                <label className="form-label" htmlFor="d-name">Tên lĩnh vực</label>
                <input id="d-name" className="form-input" required maxLength={80} value={draft.name} onChange={(e) => set('name')(e.target.value)} placeholder="VD: Tiếng Nhật cho người đi làm" />
                <label className="form-label" htmlFor="d-desc">Mô tả ngắn</label>
                <input id="d-desc" className="form-input" maxLength={300} value={draft.description} onChange={(e) => set('description')(e.target.value)} />
              </fieldset>

              <fieldset className="domain-block">
                <legend>Đối tượng & giọng văn</legend>
                <label className="form-label" htmlFor="d-aud">Đối tượng độc giả</label>
                <textarea id="d-aud" className="form-textarea" rows={2} maxLength={1000} value={draft.audience} onChange={(e) => set('audience')(e.target.value)} placeholder="Ai đọc bài? Tuổi, nghề, họ quan tâm gì." />
                <label className="form-label" htmlFor="d-voice">Giọng văn</label>
                <textarea id="d-voice" className="form-textarea" rows={2} maxLength={1000} value={draft.voice} onChange={(e) => set('voice')(e.target.value)} placeholder="VD: Thân thiện, dí dỏm, xưng mình – bạn." />
              </fieldset>

              <fieldset className="domain-block">
                <legend>Quy tắc</legend>
                <textarea id="d-rules" aria-label="Quy tắc bắt buộc" className="form-textarea" rows={3} maxLength={2000} value={draft.rules} onChange={(e) => set('rules')(e.target.value)} placeholder="Điều AI luôn/không bao giờ làm. VD: không hứa hẹn cam kết đầu ra." />
              </fieldset>

              <fieldset className="domain-block">
                <legend>Hashtag mặc định</legend>
                <div className="tag-input" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement)?.focus()}>
                  {draft.defaultHashtags.map((t) => (
                    <span key={t} className="tag-chip">
                      #{t}
                      <button type="button" onClick={() => setDraft((d) => ({ ...d, defaultHashtags: d.defaultHashtags.filter((x) => x !== t) }))} aria-label={`Xoá #${t}`}>
                        <X size={11} aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                  <input
                    value={tagDraft}
                    aria-label="Thêm hashtag mặc định"
                    placeholder={draft.defaultHashtags.length ? '' : 'Gõ rồi Enter · tối đa 10, được thêm vào mọi bài'}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onKeyDown={onTagKey}
                    onBlur={() => addTags(tagDraft)}
                  />
                </div>
              </fieldset>

              <fieldset className="domain-block">
                <legend>Phong cách ảnh</legend>
                <input id="d-style" aria-label="Phong cách ảnh (tiếng Anh)" className="form-input" maxLength={500} value={draft.imageStyle} onChange={(e) => set('imageStyle')(e.target.value)} placeholder="Tiếng Anh, VD: flat illustration, pastel colors, soft light" />
              </fieldset>

              <div className="row domain-actions">
                {selected && (
                  <>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={!!busy}
                      onClick={() =>
                        run(
                          'archive',
                          () => domainsApi.update(selected.id, { isArchived: !selected.isArchived }),
                          selected.isArchived ? 'Đã dùng lại lĩnh vực.' : 'Đã lưu trữ — các Page dùng lĩnh vực này làm mặc định được bỏ chọn.',
                          selected.id
                        )
                      }
                    >
                      {selected.isArchived ? <ArchiveRestore size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
                      {selected.isArchived ? 'Dùng lại' : 'Lưu trữ'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm danger-hover"
                      disabled={!!busy}
                      aria-label="Xoá lĩnh vực"
                      onClick={() => run('delete', () => domainsApi.remove(selected.id), `Đã xoá "${selected.name}".`)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </>
                )}
                <button type="submit" className="btn btn-primary" disabled={!!busy} style={{ marginLeft: 'auto' }}>
                  {busy === 'save' && <div className="spinner" />} {selectedId === 'new' ? 'Tạo lĩnh vực' : 'Lưu lĩnh vực'}
                </button>
              </div>
            </form>

            {selected && (
              <section className="card stack" aria-labelledby="formats-title">
                <div className="row">
                  <h2 id="formats-title" className="card-title" style={{ flex: 1 }}>Định dạng bài</h2>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDrawer({})} disabled={selected.formats.length >= 10}>
                    <Plus size={14} aria-hidden="true" /> Định dạng
                  </button>
                </div>
                <div className="format-grid">
                  {selected.formats.map((f) => (
                    <article key={f.id} className={`format-card ${f.isArchived ? 'archived' : ''}`}>
                      <div className="row" style={{ gap: 6 }}>
                        <strong className="format-name">{f.name}</strong>
                        {f.isDefault && <span className="badge badge-published"><Star size={11} aria-hidden="true" /> Mặc định</span>}
                        {f.legacyPrompt && <span className="badge badge-draft">Prompt cũ</span>}
                        {f.isArchived && <span className="badge badge-draft">Lưu trữ</span>}
                      </div>
                      <p className="format-meta">
                        {LENGTH_LABEL[f.length]} · {f.withImage ? <><ImageIcon size={12} aria-hidden="true" /> Có ảnh</> : <><Type size={12} aria-hidden="true" /> Chỉ chữ</>} · {f._count?.posts ?? 0} bài
                      </p>
                      <p className="format-ins">{f.instructions}</p>
                      <div className="row" style={{ gap: 6 }}>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDrawer({ format: f })}>Sửa</button>
                        {!f.isDefault && !f.isArchived && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={!!busy}
                            onClick={() => run(`default:${f.id}`, () => domainsApi.updateFormat(f.id, { isDefault: true }), `"${f.name}" là định dạng mặc định.`, selected.id)}
                          >
                            Đặt mặc định
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            )}

            {selected && selected.formats.some((f) => !f.isArchived) && (
              <section className="card stack" aria-labelledby="try-title">
                <h2 id="try-title" className="card-title">Xem prompt & thử viết</h2>
                <PromptPreview formats={selected.formats.filter((f) => !f.isArchived)} />
              </section>
            )}
          </div>
        )}
      </div>

      {drawer && selected && (
        <FormatDrawer
          domainId={selected.id}
          format={drawer.format}
          onClose={() => setDrawer(null)}
          onSaved={() => {
            setDrawer(null);
            void load(selected.id);
          }}
        />
      )}
    </div>
  );
}
```

`client/src/components/PostBits.tsx`: thêm export

```ts
/** Hashtag typed by a person: no leading "#", no spaces */
export const cleanTagInput = (t: string) => t.trim().replace(/^#+/, '').replace(/\s+/g, '');
```

- [ ] **Step 4: CSS** — thêm cuối `client/src/index.css`:

```css
/* ─── Content domains ──────────────────────── */
.domains-grid { display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: 20px; align-items: start; }
.domain-list { display: flex; flex-direction: column; position: sticky; top: 16px; }
.domain-item {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 12px 16px; border: none;
  border-bottom: 1px solid var(--border-subtle); background: transparent; text-align: left; cursor: pointer;
  transition: background var(--transition-fast), box-shadow var(--transition-fast);
}
.domain-item .name { font-weight: 600; color: var(--text-primary); }
.domain-item .muted { font-size: 12px; }
.domain-item:hover { background: var(--bg-secondary); }
.domain-item.selected { background: var(--primary-50, var(--bg-secondary)); box-shadow: inset 3px 0 0 var(--primary-500); }
.domain-item.add { flex-direction: row; align-items: center; gap: 6px; color: var(--primary-600); font-weight: 600; }
.domain-item.archived .name { color: var(--text-tertiary); }
.domain-item:focus-visible { outline: 2px solid var(--border-focus); outline-offset: -2px; }
.domain-archived-toggle { padding: 10px 16px; text-align: left; }
.domain-form { gap: 14px; animation: auth-in var(--transition-base) both; }
.domain-form-head { gap: 8px; }
.domain-block { border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 12px 14px 14px; margin: 0; display: flex; flex-direction: column; gap: 6px; }
.domain-block legend { padding: 0 6px; font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-tertiary); }
.domain-block .form-label { margin: 4px 0 0; }
.domain-actions { flex-wrap: wrap; gap: 8px; }
.format-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.format-card {
  display: flex; flex-direction: column; gap: 8px; padding: 14px; border: 1px solid var(--border-default); border-radius: var(--radius-md);
  background: var(--bg-card); transition: border-color var(--transition-fast), transform var(--transition-fast), box-shadow var(--transition-fast);
}
.format-card:hover { border-color: var(--border-strong); transform: translateY(-1px); box-shadow: var(--shadow-sm); }
.format-card.archived { opacity: 0.6; }
.format-card .badge { display: inline-flex; align-items: center; gap: 3px; }
.format-name { font-size: 14.5px; }
.format-meta { margin: 0; font-size: 12.5px; color: var(--text-tertiary); display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.format-ins { margin: 0; font-size: 13px; color: var(--text-secondary); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.drawer-overlay { justify-content: flex-end; align-items: stretch; padding: 0; }
.drawer-panel {
  width: min(520px, 100%); height: 100%; display: flex; flex-direction: column; background: var(--bg-card);
  box-shadow: var(--shadow-lg); animation: drawer-in var(--transition-slow) both;
}
.drawer-panel .member-body { flex: 1; }
.drawer-panel .modal-foot { border-radius: 0; }
.legacy-note { background: var(--bg-secondary); padding: 8px 10px; border-radius: var(--radius-sm); margin: 0; }
.segmented { display: inline-flex; border: 1px solid var(--border-default); border-radius: var(--radius-sm); overflow: hidden; flex-wrap: wrap; }
.segmented button { border: none; background: var(--bg-card); padding: 8px 12px; font-size: 13px; cursor: pointer; color: var(--text-secondary); transition: background var(--transition-fast), color var(--transition-fast); }
.segmented button + button { border-left: 1px solid var(--border-default); }
.segmented button.active { background: var(--primary-500); color: #fff; }
.segmented button:focus-visible { outline: 2px solid var(--border-focus); outline-offset: -2px; }
.check-row { display: flex; align-items: center; gap: 8px; font-size: 13.5px; margin-top: 6px; cursor: pointer; }
.prompt-preview { display: flex; flex-direction: column; gap: 10px; }
.prompt-preview-inputs { display: grid; grid-template-columns: minmax(0, 1fr) 200px; gap: 8px; align-items: end; }
.prompt-preview-inputs .form-label { grid-column: 1 / -1; margin: 0; }
.prompt-preview-actions { flex-wrap: wrap; gap: 8px; }
.prompt-cost { margin: 0; }
.prompt-text {
  margin: 0; max-height: 280px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: var(--font-mono); font-size: 12px;
  line-height: 1.6; background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 10px 12px;
}
.prompt-sample { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.prompt-sample p { margin: 0; white-space: pre-wrap; font-size: 13.5px; }
@keyframes drawer-in { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
@media (max-width: 900px) {
  .domains-grid { grid-template-columns: 1fr; }
  .domain-list { position: static; }
  .prompt-preview-inputs { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  .domain-form, .drawer-panel { animation: none; }
  .format-card:hover { transform: none; }
}
```

- [ ] **Step 5: Kiểm tra**

Run:
```bash
cd client
grep -nE -- "--(primary-50|radius-md|text-secondary|font-mono)\b" src/index.css | head
npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b
```
Expected:
- Token nào không có trong `index.css`: đổi sang token có sẵn (`--primary-100`, `--radius-sm`, `--text-tertiary`, `monospace`) và ghi `Ruling:` vào ledger.
- tsc sạch.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/DomainsPage.tsx client/src/components/FormatDrawer.tsx client/src/components/PromptPreview.tsx client/src/components/PostBits.tsx client/src/index.css
git commit -m "feat(client): content domains page with format drawer and prompt preview"
```

---

### Task 10: Tạo bài theo lĩnh vực / định dạng

**Files:**
- Modify: `client/src/pages/CreatePostPage.tsx`, `client/src/index.css`

**Interfaces:**
- Consumes: `domainsApi`, `ContentDomain`, `PageInfo.defaultDomainId`, `PostUpdate.domainId/formatId` (Task 8); `PromptPreview` (Task 9).

- [ ] **Step 1: State và nạp dữ liệu** — trong `CreatePostPage.tsx`:

Import: thêm `domainsApi, type ContentDomain` vào import từ `'../api'`; `import PromptPreview from '../components/PromptPreview';`; thêm `AlertTriangle` vào import lucide.

Sau hằng `PAGES_KEY` thêm:

```ts
const FORMAT_KEY = 'autopost.lastFormat';

function rememberedFormat(): { domainId?: string; formatId?: string } {
  try {
    return JSON.parse(localStorage.getItem(FORMAT_KEY) ?? '{}');
  } catch {
    return {};
  }
}
```

Trong component, sau `const [confirmPublish, …]` thêm:

```ts
  const [domains, setDomains] = useState<ContentDomain[]>([]);
  const [domainId, setDomainId] = useState('');
  const [formatId, setFormatId] = useState('');
  /** Domain/format the post was last saved/written with (null = not written yet) */
  const [savedPick, setSavedPick] = useState<{ domainId: string; formatId: string } | null>(null);
  const [writtenPick, setWrittenPick] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
```

Sửa `useEffect` nạp Page thành nạp cả lĩnh vực và chọn mặc định:

```ts
  useEffect(() => {
    Promise.all([pagesApi.list(), domainsApi.list()])
      .then(([pagesRes, domainsRes]) => {
        const active = pagesRes.data.filter((p) => p.isActive);
        setPages(active);
        const postable = active.filter((p) => p.postable);
        const kept = rememberedPages().filter((id) => postable.some((p) => p.id === id));
        const picked = kept.length ? kept : postable[0] ? [postable[0].id] : [];
        setPageIds(picked);

        const list = domainsRes.data;
        setDomains(list);
        // Last choice → first Page's default domain → first domain
        const last = rememberedFormat();
        const firstPage = active.find((p) => p.id === picked[0]);
        const domain =
          list.find((d) => d.id === last.domainId) ?? list.find((d) => d.id === firstPage?.defaultDomainId) ?? list[0];
        if (domain) {
          setDomainId(domain.id);
          const format = domain.formats.find((f) => f.id === last.formatId) ?? domain.formats.find((f) => f.isDefault) ?? domain.formats[0];
          setFormatId(format?.id ?? '');
        }
      })
      .catch(() => toast.error('Không tải được Page hoặc lĩnh vực.'));
  }, []);
```

Thêm effect nhớ lựa chọn (sau effect lưu `PAGES_KEY`):

```ts
  useEffect(() => {
    try {
      if (domainId && formatId) localStorage.setItem(FORMAT_KEY, JSON.stringify({ domainId, formatId }));
    } catch {
      /* private mode */
    }
  }, [domainId, formatId]);
```

Sau `const message = …` thêm:

```ts
  const domain = domains.find((d) => d.id === domainId);
  const format = domain?.formats.find((f) => f.id === formatId);
  const pickKey = `${domainId}:${formatId}`;
  const pickChanged = !!writtenPick && writtenPick !== pickKey;
  const pickDomain = (id: string) => {
    const next = domains.find((d) => d.id === id);
    setDomainId(id);
    setFormatId(next?.formats.find((f) => f.isDefault)?.id ?? next?.formats[0]?.id ?? '');
  };
  const ownPages = pages.filter((p) => p.defaultDomainId === domainId);
  const otherPages = pages.filter((p) => p.defaultDomainId !== domainId);
  const offDomainSelected = selectedPages.filter((p) => p.defaultDomainId && p.defaultDomainId !== domainId);
```

- [ ] **Step 2: Gửi lĩnh vực/định dạng khi tạo / viết**

Thay `ensurePost` bằng:

```ts
  /** Create the post on first use; keep its idea, domain and format in sync afterwards. */
  async function ensurePost(): Promise<string> {
    const pick = domainId && formatId ? { domainId, formatId } : undefined;
    if (postId) {
      const body: PostUpdate = {};
      if (idea.trim() !== savedIdea) body.idea = idea.trim();
      if (pick && (pick.domainId !== savedPick?.domainId || pick.formatId !== savedPick?.formatId)) Object.assign(body, pick);
      if (Object.keys(body).length) {
        await postsApi.update(postId, body);
        setSavedIdea(idea.trim());
        if (pick) setSavedPick(pick);
      }
      return postId;
    }
    const res = await postsApi.create({ pageIds: selectedPages.map((p) => p.id), inputData: { basicInfo: idea.trim() }, ...pick });
    setPostId(res.data.id);
    setSavedIdea(idea.trim());
    setSavedPick({ domainId: res.data.domainId, formatId: res.data.formatId });
    return res.data.id;
  }
```

Trong `write()`, sau `setTimings({ writing: performance.now() - t0 });` thêm `setWrittenPick(pickKey);`.

- [ ] **Step 3: Giao diện chọn lĩnh vực + định dạng, Xem prompt**

Trong khung `{/* ─── Editor ─── */}`, thay section đầu tiên (`<section className="card">` chứa `htmlFor="idea"`) bằng:

```tsx
        <section className="card stack" style={{ gap: 12 }}>
          {domains.length > 0 && (
            <div className="pick-row">
              <label className="form-label" htmlFor="domain">Lĩnh vực</label>
              <select id="domain" className="form-select" value={domainId} onChange={(e) => pickDomain(e.target.value)}>
                {domains.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
              <span className="form-label" id="format-label">Định dạng</span>
              <div className="format-chips" role="radiogroup" aria-labelledby="format-label">
                {domain?.formats.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    role="radio"
                    aria-checked={f.id === formatId}
                    className={`chip-btn ${f.id === formatId ? 'active' : ''}`}
                    onClick={() => setFormatId(f.id)}
                    title={f.withImage ? 'Có ảnh' : 'Chỉ chữ'}
                  >
                    {f.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <label htmlFor="idea" className="form-label">Ý tưởng bài viết</label>
            <div className="row" style={{ alignItems: 'stretch' }}>
              <input
                id="idea"
                className="form-input"
                value={idea}
                maxLength={500}
                onChange={(e) => setIdea(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !busy && write()}
                placeholder="VD: Tóm tắt biên bản cuộc họp dài thành danh sách việc cần làm"
              />
              <button type="button" className="btn btn-dark" onClick={write} disabled={!!busy || !idea.trim() || !selectedPages.length}>
                {busy === 'writing' ? <div className="spinner" /> : hasContent ? <RefreshCw size={15} aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />}
                {hasContent ? 'Viết lại' : 'Viết bài bằng AI'}
              </button>
            </div>
          </div>
          {pickChanged && hasContent && (
            <p className="field-warning" role="status">Bạn vừa đổi lĩnh vực/định dạng — bấm <strong>Viết lại</strong> để AI viết theo lựa chọn mới.</p>
          )}
          <p className="field-hint" style={{ margin: 0 }}>
            AI viết theo lĩnh vực <strong>{domain?.name ?? '…'}</strong> · định dạng <strong>{format?.name ?? '…'}</strong>
            {format && !format.withImage ? ' (chỉ chữ, không tạo ảnh)' : ''}, rồi tự tách đoạn và đưa hashtag xuống cuối.{' '}
            <button type="button" className="link-btn" onClick={() => setShowPrompt((v) => !v)} aria-expanded={showPrompt}>
              {showPrompt ? 'Ẩn prompt' : 'Xem prompt'}
            </button>
          </p>
          {showPrompt && format && domain && (
            <PromptPreview key={`${formatId}:${idea}`} formats={domain.formats} formatId={formatId} idea={idea || 'ý tưởng của bạn'} pageId={page?.id} compact />
          )}
        </section>
```

- [ ] **Step 4: Nhóm Page theo lĩnh vực**

Thay khối `<div className="page-picker" role="group" …> … </div>` bằng:

```tsx
              {[
                { title: 'Page của lĩnh vực này', list: ownPages },
                { title: 'Page khác', list: otherPages },
              ]
                .filter((g) => g.list.length > 0)
                .map((g, i, groups) => (
                  <div key={g.title} className="page-group">
                    {groups.length > 1 && <span className="page-group-title">{g.title}</span>}
                    <div className="page-picker" role="group" aria-label={g.title}>
                      {g.list.map((p) => (
                        <label key={p.id} className={`page-option ${p.postable ? '' : 'disabled'}`} title={p.blockMessage ?? p.pageName}>
                          <input
                            type="checkbox"
                            id={`page-${p.id}`}
                            checked={p.postable && pageIds.includes(p.id)}
                            onChange={() => togglePage(p.id)}
                            disabled={!p.postable}
                          />
                          <span className="avatar" aria-hidden="true">{pageInitials(p.pageName)}</span>
                          <span className="name">
                            {p.pageName}
                            {!p.postable && <span className="why">{p.blockReason === 'OTHER_APP' ? 'Token của app cũ' : p.blockMessage}</span>}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              {offDomainSelected.length > 0 && (
                <p className="field-warning">
                  <AlertTriangle size={13} aria-hidden="true" style={{ verticalAlign: -2 }} /> {offDomainSelected.map((p) => p.pageName).join(', ')} mặc định dùng lĩnh vực khác — bài vẫn viết theo lĩnh vực đã chọn.
                </p>
              )}
```

- [ ] **Step 5: CSS** — thêm cuối `client/src/index.css`:

```css
/* ─── Create post: domain & format ─────────── */
.pick-row { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 12px; align-items: center; }
.pick-row .form-label { margin: 0; }
.format-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip-btn.active { background: var(--primary-500); border-color: var(--primary-500); color: #fff; }
.page-group { display: flex; flex-direction: column; gap: 6px; }
.page-group + .page-group { margin-top: 10px; }
.page-group-title { font-size: 11.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-tertiary); }
@media (max-width: 640px) { .pick-row { grid-template-columns: 1fr; } }
```

- [ ] **Step 6: Kiểm tra + commit**

Run: `cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b`
Expected: sạch.

```bash
git add client/src/pages/CreatePostPage.tsx client/src/index.css
git commit -m "feat(client): choose domain and format when creating a post"
```

---

### Task 11: Kênh Facebook, Bài đăng, Cài đặt, Dashboard

**Files:**
- Modify: `client/src/pages/PagesPage.tsx`, `client/src/pages/PostsPage.tsx`, `client/src/pages/SettingsPage.tsx`, `client/src/pages/DashboardPage.tsx`, `client/src/index.css`

**Interfaces:**
- Consumes: `domainsApi`, `pagesApi.setDefaultDomain`, `ContentDomain` (Task 8); `DOMAINS_SEEN_KEY` (Task 9); `useAuth` (M1).

- [ ] **Step 1: Kênh Facebook — cột "Lĩnh vực mặc định"**

`PagesPage.tsx`:
- Import `domainsApi, type ContentDomain` từ `'../api'`.
- State `const [domains, setDomains] = useState<ContentDomain[]>([]);`.
- Trong effect nạp ban đầu (nơi gọi `pagesApi.list()` lần đầu) thêm `domainsApi.list().then((r) => setDomains(r.data)).catch(() => {});`.
- Thêm hàm:

```ts
  async function setDefaultDomain(id: string, domainId: string | null) {
    try {
      await pagesApi.setDefaultDomain(id, domainId);
      setPages((list) => list.map((p) => (p.id === id ? { ...p, defaultDomainId: domainId } : p)));
      toast.success(domainId ? 'Đã đặt lĩnh vực mặc định cho Page.' : 'Đã bỏ lĩnh vực mặc định.');
    } catch (e: any) {
      toast.error(e.message);
    }
  }
```

- Trong `<thead>` bảng Page đang kết nối, sau `<th scope="col">Trạng thái</th>` thêm `<th scope="col">Lĩnh vực mặc định</th>`.
- Đổi `colSpan={6}` của dòng "Không có Page nào" thành `colSpan={7}`.
- Truyền cho `PageRow`: `domains={domains}` và `onDomain={(domainId) => setDefaultDomain(p.id, domainId)}`.
- `RowProps` thêm `domains: ContentDomain[]; onDomain: (domainId: string | null) => void;`. Destructure trong `PageRow`.
- Sau `<td>` trạng thái (khối có `<PageStatusBadge page={p} />`) thêm:

```tsx
      <td>
        <select
          className="form-select select-sm"
          aria-label={`Lĩnh vực mặc định của ${p.pageName}`}
          value={p.defaultDomainId ?? ''}
          onChange={(e) => onDomain(e.target.value || null)}
        >
          <option value="">— Không —</option>
          {domains.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </td>
```

- Bảng Page đã ngắt (nếu dùng chung `PageRow`) truyền `domains={domains}` và `onDomain={() => {}}`, rồi thêm `<th>` tương ứng.

- [ ] **Step 2: Bài đăng — lọc theo lĩnh vực, nhãn trên dòng**

`PostsPage.tsx`:
- Import `domainsApi, type ContentDomain`.
- `interface PostData` thêm `domain?: { id: string; name: string } | null; format?: { id: string; name: string } | null;`.
- State `const [domains, setDomains] = useState<ContentDomain[]>([]);` và `const domainFilter = params.get('domain') ?? '';`.
- `load()` gọi `postsApi.list({ limit: '50', ...(domainFilter && { domainId: domainFilter }) })`. Effect nạp đổi thành:

```ts
  useEffect(() => {
    domainsApi.list(true).then((r) => setDomains(r.data)).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [domainFilter]);
```

(xoá `useEffect(() => { load(); }, []);` cũ).
- Trong `<div className="row">` chứa `filter-tabs`, sau `</div>` của tabs thêm:

```tsx
          {domains.length > 1 && (
            <select className="form-select select-sm" aria-label="Lọc theo lĩnh vực" value={domainFilter} onChange={(e) => setParam('domain', e.target.value)}>
              <option value="">Mọi lĩnh vực</option>
              {domains.map((d) => (
                <option key={d.id} value={d.id}>{d.name}{d.isArchived ? ' (lưu trữ)' : ''}</option>
              ))}
            </select>
          )}
```

- Trong `post-meta` (nhánh không lỗi), trước `{(p.targets?.length ?? 0) > 1 ? …` thêm:

```tsx
                      {p.domain && <span className="domain-tag">{p.domain.name}{p.format ? ` · ${p.format.name}` : ''}</span>}
```

CSS thêm cuối `index.css`:

```css
.domain-tag { display: inline-block; margin-right: 6px; padding: 1px 7px; border-radius: var(--radius-full); background: var(--bg-secondary); color: var(--text-secondary); font-size: 11.5px; font-weight: 500; }
.select-sm { height: 34px; font-size: 13px; padding-top: 0; padding-bottom: 0; }
```

- [ ] **Step 3: Cài đặt — bỏ System prompt**

`SettingsPage.tsx`:
- `type FieldKey = Exclude<keyof PublicSettings, 'systemPrompt'>;`.
- `GROUP_FIELDS.gemini` = `['geminiApiKey', 'geminiModel']`.
- `toForm` bỏ dòng `systemPrompt: s.systemPrompt,`.
- Thay khối `<div className="form-group">` chứa `System prompt` (tới hết `</div>` của nó) bằng:

```tsx
                <p className="field-hint settings-domains-link">
                  Cách AI viết bài (đối tượng, giọng văn, cấu trúc) giờ nằm ở <Link to="/domains">Lĩnh vực</Link>. Prompt cũ của bạn đã được chuyển thành lĩnh vực "Mặc định".
                </p>
```

- Thêm `import { Link } from 'react-router-dom';`.
- Nếu có kiểu `FormState = Record<FieldKey, string>` hoặc chỗ nào khác dùng `systemPrompt`: chạy `grep -n systemPrompt client/src/pages/SettingsPage.tsx` và bỏ hết.

- [ ] **Step 4: Dashboard — checklist khởi động, chào đúng tên**

`DashboardPage.tsx`:
- Import `pagesApi, domainsApi` từ `'../api'`; `import { useAuth } from '../auth';`; `import { DOMAINS_SEEN_KEY } from './DomainsPage';`; thêm `ListChecks` vào lucide.
- Trong component: `const { user } = useAuth();` và `const [postableCount, setPostableCount] = useState(0);`.
- Trong `Promise.all([...])` thêm `pagesApi.list().then((r) => setPostableCount(r.data.filter((p) => p.isActive && p.postable).length)).catch(() => {}),`.
- Đổi `<h1>{greeting()}, Admin</h1>` thành `<h1>{greeting()}, {user?.name ?? 'bạn'}</h1>`.
- Trước `{stats && (<div className="stats-grid" …` thêm:

```tsx
      {stats && settings && <StartChecklist settings={settings} postableCount={postableCount} totalPosts={stats.totalPosts} />}
```

- Cuối file thêm:

```tsx
function seenDomains(): boolean {
  try {
    return localStorage.getItem(DOMAINS_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** First steps for a new account; ticks itself and disappears when all are done (spec §6). */
function StartChecklist({ settings, postableCount, totalPosts }: { settings: PublicSettings; postableCount: number; totalPosts: number }) {
  const items = [
    { done: settings.geminiApiKey.source !== 'none' && settings.cfApiToken.source !== 'none', label: 'Nhập key Gemini và Cloudflare', to: '/settings#gemini' },
    { done: !!settings.fbAppId && postableCount > 0, label: 'Nhập Facebook App và đồng bộ Page', to: '/pages?sync=1' },
    { done: seenDomains(), label: 'Xem lĩnh vực nội dung (cách AI viết)', to: '/domains' },
    { done: totalPosts > 0, label: 'Tạo bài đầu tiên', to: '/posts/create' },
  ];
  const left = items.filter((i) => !i.done).length;
  if (left === 0) return null;
  return (
    <section className="card stack start-checklist" aria-labelledby="start-title">
      <div className="row">
        <ListChecks size={18} aria-hidden="true" />
        <h2 id="start-title" className="card-title" style={{ flex: 1 }}>Bắt đầu</h2>
        <span className="muted">{items.length - left}/{items.length} xong</span>
      </div>
      <ol className="checklist">
        {items.map((i) => (
          <li key={i.label} className={i.done ? 'done' : ''}>
            {i.done ? <CheckCircle2 size={16} aria-hidden="true" /> : <span className="dot-todo" aria-hidden="true" />}
            {i.done ? <span>{i.label}</span> : <Link to={i.to}>{i.label}</Link>}
          </li>
        ))}
      </ol>
    </section>
  );
}
```

- Đổi hint `Viết theo System prompt trong Cài đặt` thành `Viết theo lĩnh vực đã chọn lần trước`.

CSS thêm cuối `index.css`:

```css
.start-checklist { gap: 12px; animation: auth-in var(--transition-base) both; }
.checklist { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px 16px; }
.checklist li { display: flex; align-items: center; gap: 8px; font-size: 13.5px; }
.checklist li.done { color: var(--text-tertiary); text-decoration: line-through; }
.checklist li.done svg { color: var(--success-500); }
.dot-todo { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--border-strong); flex-shrink: 0; }
@media (prefers-reduced-motion: reduce) { .start-checklist { animation: none; } }
```

- [ ] **Step 5: Kiểm tra + commit**

Run: `cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b`
Expected: sạch.

```bash
git add client/src/pages/PagesPage.tsx client/src/pages/PostsPage.tsx client/src/pages/SettingsPage.tsx client/src/pages/DashboardPage.tsx client/src/index.css
git commit -m "feat(client): Page default domain, post filter by domain, settings link, start checklist"
```

---

### Task 12: Kiểm tra trên trình duyệt — **kết thúc M3**

**Files:**
- Modify: `ROADMAP.md`

- [ ] **Step 1: Chạy thử**

- Tạo 2 tài khoản thử `@autopost.test`: admin + member, bằng script `npx tsx` trong scratchpad dùng `hashPassword`; mật khẩu ngẫu nhiên lưu ở scratchpad, không in ra chat.
- Chạy API: `npx tsx src/server.ts`, chạy nền.
- Chạy Vite: `cd client && npx -y -p node@22 -- node node_modules/vite/bin/vite.js --port 5173 --strictPort`, chạy nền.
- Chặn Gemini/Cloudflare/Facebook thật: **không** bấm "Thử viết", "Viết bài bằng AI" hay "Đăng" với key thật. Chỉ kiểm tra những gì không tốn phí: Xem prompt, tạo/sửa lĩnh vực và định dạng, chọn lĩnh vực mặc định của Page.

Dùng Playwright, đăng nhập bằng member:
1. `/domains`: thấy lĩnh vực "Chung" với 3 định dạng (bộ khởi đầu). Sửa giọng văn → Lưu. Thêm định dạng "Chỉ chữ" (bỏ Kèm ảnh) → thẻ hiện "Chỉ chữ". Đặt mặc định. Xem prompt với ý tưởng "Chào sếp" → prompt có `lĩnh vực "Chung"` và đúng định dạng. Lưu trữ lĩnh vực cuối cùng → toast lỗi "Cần giữ ít nhất 1 lĩnh vực đang dùng." Chụp `.playwright-mcp/m3-domains.png`.
2. `/posts/create`: chọn lĩnh vực + chip định dạng, "Xem prompt" mở khung prompt. Chụp `.playwright-mcp/m3-create.png`.
3. `/pages`: cột Lĩnh vực mặc định (nếu member chưa có Page thì dùng admin@example.com local nếu có Page, hoặc bỏ qua bước này và ghi lại).
4. `/posts`: có ô lọc lĩnh vực khi có ≥ 2 lĩnh vực.
5. `/settings#gemini`: không còn ô System prompt, có link Lĩnh vực.
6. `/`: checklist "Bắt đầu" hiện, mục "Xem lĩnh vực" đã tick.
7. Bề ngang 390px trên `/domains` và `/posts/create`: không cuộn ngang. Chụp `.playwright-mcp/m3-mobile.png`.

Console không có lỗi ngoài 401 `/auth/me` trước khi đăng nhập.

- Tắt hẳn server: `for p in $(netstat -ano | grep -E ":(3000|5173) .*LISTENING" | awk '{print $NF}' | sort -u); do taskkill //PID $p //T //F; done`.
- Xoá tài khoản thử: `docker exec autopost_mariadb mariadb -uautopost -pautopost_secret autopost_db -e "DELETE FROM users WHERE email LIKE '%@autopost.test'"`.

- [ ] **Step 2: ROADMAP + commit và DỪNG (checkpoint M3)**

`ROADMAP.md` đổi `- ⬜ M3 Giao diện Lĩnh vực/Tạo bài · ⬜ M4 Tài liệu & deploy` thành:

```markdown
- ✅ M3 (2026-09-28) Giao diện: trang Lĩnh vực (định dạng, xem prompt, thử viết), Tạo bài chọn lĩnh vực + định dạng, cột lĩnh vực mặc định ở Kênh Facebook, lọc bài theo lĩnh vực, checklist khởi động
- ⬜ M4 Tài liệu & deploy
```

```bash
git add ROADMAP.md
git commit -m "docs(roadmap): M3 done"
```

Báo người dùng: M3 xong, gửi kèm ảnh chụp màn hình. Chờ duyệt rồi mới sang M4.

---

# M4 — Tài liệu & deploy

### Task 13: Tài liệu khớp với bản nhiều người dùng

**Files:**
- Modify: `AGENTS.md`, `README.md`, `docs/DEPLOY_HOSTINGER.md`, `ROADMAP.md`

Quyết định (spec §10 nói "trang checklist"): checklist nâng cấp nằm **trong** `docs/DEPLOY_HOSTINGER.md` (mục mới), không tạo trang riêng.

- [ ] **Step 1: `AGENTS.md`**

Thay mục `## Current State & Constraints` bằng:

```markdown
## Current State & Constraints
- **Authentication (multi-user, 2026-09):** login with email + password; session = JWT `{ sub, tv }` in the httpOnly cookie `ap_session`; `authenticate` in `auth.middleware.ts` checks `isActive` and `tokenVersion`. Roles `ADMIN` / `USER`; admins manage members at `/admin/users` (`admin.routes.ts`) and never see members' content. Non-GET `/api` requests need the header `X-Requested-With: autopost`.
- **Data isolation:** every query filters by `req.user.id`; ids that belong to another user return 404, also ids sent in a request body. New API routes MUST be added to `ROUTE_CASES` in `tests/isolation.db.test.ts` (the test fails otherwise).
- **Content domains:** AI writes with the post's content domain + format (`content_domains`, `content_formats`, `src/lib/compose-prompt.ts`, `src/services/post-writer.ts`). The old Settings system prompt became the "Mặc định / Bài chuẩn" legacy format.
- **API Keys:** each user brings their own Gemini / Cloudflare / Facebook App keys (Settings, stored per user, encrypted). Only the ADMIN account falls back to `.env` keys. `VITE_FB_APP_ID` for the frontend FB SDK.
- **Startup:** `runBootstrap()` (`src/lib/bootstrap.ts`) refuses a weak `JWT_SECRET` in production, ensures an admin (`ADMIN_EMAIL` / `ADMIN_PASSWORD` on first deploy) and migrates content domains.
```

Trong `## Core Pipeline`, đổi bước 3 thành: `3. Worker calls \`writePost\` (\`post-writer.ts\` → \`ai.service.ts\`) to generate caption + image prompt with the post's content domain + format.`

- [ ] **Step 2: `README.md`**

- Dòng tóm tắt deploy (dòng 87) đổi `bắt buộc \`BASIC_AUTH_USER/PASS\`` thành `bắt buộc \`JWT_SECRET\` (≥ 32 ký tự); lần đầu cần \`ADMIN_EMAIL\` + \`ADMIN_PASSWORD\``.
- Thêm mục trước `## 🌐 Deploy`:

```markdown
## 👥 Tài khoản & lĩnh vực

- Đăng nhập bằng email + mật khẩu. Không có tự đăng ký: **admin** tạo tài khoản ở **Người dùng** và đặt mật khẩu cho member.
- Mỗi người chỉ thấy Page, bài, lịch, lĩnh vực và cấu hình của mình; mỗi người tự nhập key Gemini / Cloudflare / Facebook App trong **Cài đặt**.
- **Lĩnh vực** quyết định cách AI viết (đối tượng, giọng văn, quy tắc, hashtag, phong cách ảnh); mỗi lĩnh vực có nhiều **định dạng bài** (Mẹo ngắn, Listicle, Hỏi đáp…). Khi tạo bài, chọn lĩnh vực + định dạng.
- Chạy local lần đầu: đặt `ADMIN_EMAIL` và `ADMIN_PASSWORD` (≥ 8 ký tự) trong `.env`, khởi động server, đăng nhập bằng thông tin đó.
```

- Trong `## 🛡️ Security`, thay dòng nói về Basic Auth (nếu có) bằng: `- Đăng nhập bằng cookie httpOnly; mọi dữ liệu tách theo tài khoản (test \`tests/isolation.db.test.ts\` duyệt mọi route).`

- [ ] **Step 3: `docs/DEPLOY_HOSTINGER.md`**

1. Bảng biến môi trường (mục 2):
   - Dòng `JWT_SECRET` đổi thành `| \`JWT_SECRET\` | mục 1.2 — **bắt buộc**, ≥ 32 ký tự ngẫu nhiên (thiếu/yếu thì app không khởi động) |`.
   - Hai dòng `BASIC_AUTH_*` đổi thành `| \`BASIC_AUTH_USER\`, \`BASIC_AUTH_PASS\` | **tuỳ chọn** — lớp mật khẩu thứ hai cho cả trang; app đã có đăng nhập riêng |`.
   - Thêm `| \`ADMIN_EMAIL\`, \`ADMIN_PASSWORD\` | lần deploy đầu: tài khoản quản trị (mật khẩu ≥ 8 ký tự). Xoá \`ADMIN_PASSWORD\` sau khi đăng nhập được |`.
2. Thay đoạn cảnh báo `> ⚠️ **Không bao giờ bỏ trống \`BASIC_AUTH_USER\` …` bằng:

```markdown
> ⚠️ **`JWT_SECRET` phải là chuỗi ngẫu nhiên ≥ 32 ký tự** (mục 1.2). Ai biết chuỗi này có thể giả phiên đăng nhập. Không dùng giá trị mẫu cũ trong `.env.example`.
```

3. Mục 3 (Kiểm tra sau deploy), bước 2 đổi thành: `2. \`https://ten-mien/\` → trang **Đăng nhập** → nhập \`ADMIN_EMAIL\` / \`ADMIN_PASSWORD\` → vào Dashboard.`
4. Mục 1.2: bỏ dòng tạo `BASIC_AUTH_PASS` (hoặc ghi "tuỳ chọn").
5. Bảng Xử lý sự cố (mục 7):
   - Thay 2 dòng `BASIC_AUTH` bằng: `| Không đăng nhập được admin | Kiểm tra \`ADMIN_EMAIL\`/\`ADMIN_PASSWORD\` rồi **Restart**; log có dòng \`[Bootstrap]\` cho biết đã đặt mật khẩu hay chưa |`.
   - Thêm: `| App không khởi động, log \`JWT_SECRET phải là chuỗi ngẫu nhiên…\` | Đặt \`JWT_SECRET\` ≥ 32 ký tự ngẫu nhiên, Restart |`.
6. Thêm mục mới trước `## 7. Xử lý sự cố`:

```markdown
## 6b. Checklist nâng cấp lên bản nhiều người dùng (Phase 1d)

Làm **một lần** khi đưa bản có đăng nhập + lĩnh vực lên host đang chạy:

1. hPanel → Environment variables:
   - kiểm tra `JWT_SECRET` là chuỗi ngẫu nhiên ≥ 32 ký tự;
   - thêm `ADMIN_EMAIL` (email bạn sẽ dùng) và `ADMIN_PASSWORD` (≥ 8 ký tự).
2. Merge `feature/multi-user-domains` vào `main` → `npm run deploy:branch -- --push`. Build tự chạy `db push`, chỉ **thêm** bảng/cột, không xoá dữ liệu.
3. Mở trang → đăng nhập bằng `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Kiểm tra:
   - Page và bài cũ vẫn còn;
   - **Lĩnh vực** có "Mặc định / Bài chuẩn" (chính là System prompt cũ);
   - tạo 1 bài → nội dung giống cách viết trước đây.
4. Xoá `ADMIN_PASSWORD` (và `BASIC_AUTH_USER`, `BASIC_AUTH_PASS` nếu không muốn giữ lớp mật khẩu thứ hai) khỏi hPanel → **Redeploy**.
5. **Người dùng** → Thêm member cho từng người (đặt mật khẩu, gửi riêng cho họ). Mỗi member tự nhập key trong **Cài đặt** và đồng bộ Page của mình.

Không đổi: Cron Job `/cron/tick`, `/health`, UptimeRobot, đồng bộ Page, branch `deploy`.
```

- [ ] **Step 4: ROADMAP + kiểm tra cuối + commit và DỪNG**

`ROADMAP.md` đổi `- ⬜ M4 Tài liệu & deploy` thành `- ✅ M4 (2026-09-28) Tài liệu: AGENTS.md, README, DEPLOY_HOSTINGER (mục 6b checklist nâng cấp) — deploy do người dùng thực hiện theo mục 6b`. Đổi tiêu đề Phase 1d từ `🔄` thành `✅` sau khi người dùng deploy xong (không đổi trong commit này).

```bash
grep -n "BASIC_AUTH\|bypass" AGENTS.md README.md docs/DEPLOY_HOSTINGER.md
```
Expected: không còn câu nói "đăng nhập đang tắt" / "auth bypassed"; `BASIC_AUTH` chỉ còn ở chỗ ghi "tuỳ chọn".

```bash
netstat -ano | grep -E ":(3000|5173) .*LISTENING" || echo "no dev servers"
npx tsc --noEmit && npx vitest run && RUN_DB_TESTS=1 npx vitest run
(cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b && npx -y -p node@22 -- node node_modules/vite/bin/vite.js build)
git branch --show-current
git add AGENTS.md README.md docs/DEPLOY_HOSTINGER.md ROADMAP.md
git diff --cached | grep -E "^\+" | grep -cE "AIza[0-9A-Za-z_-]{30}|P2026|u774510961_u_|ybtdv" || true
git commit -m "docs: multi-user login, content domains and the upgrade checklist"
```

Báo người dùng: Phase 1d xong trên branch, **chưa merge / chưa deploy**. Việc tiếp theo do người dùng quyết: push branch, merge vào `main`, làm theo mục 6b.
