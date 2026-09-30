# Tải video từ máy lên & đăng video / Reels · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Người dùng tải một video MP4/MOV (≤ 100 MB) từ máy lên bài viết và đăng lên các Page dưới dạng **bài video thường** hoặc **Reels**, chọn lúc đăng. Nếu video không hợp chuẩn Reels thì hệ thống báo trước khi đăng.

**Architecture:**
- **Lưu và kiểm tra video:** video được ghi thẳng xuống đĩa (`STORAGE_DIR/videos`, qua `multer.diskStorage`, không giữ trong RAM). Hàm thuần `inspectMp4` đọc thời lượng và kích thước khung hình từ header MP4, đã tính cả video xoay 90° của điện thoại.
- **Đăng lên Facebook:** thêm `publishVideo` (`graph-video.facebook.com/{page}/videos`) và `publishReel` (quy trình 3 bước `video_reels` start → `rupload` → finish). Worker chọn hàm theo `Post.videoKind`. File được đọc bằng `fs.openAsBlob`, không nạp cả file vào RAM.
- **Ảnh và video loại trừ nhau:** mỗi bài có một ảnh **hoặc** một video. Tải cái này lên sẽ xoá cái kia; khi bài có video, worker không tạo ảnh AI.

**Tech Stack:** Node.js + Express 4 + TypeScript, multer (đã có), Prisma 6 + MariaDB, Vitest 5, React 19 + Vite 8.

**Spec:** không có file spec riêng. Các quyết định dưới đây, do người dùng chốt ngày 2026-09-30, đóng vai trò spec.

## Quyết định (thay cho spec)

1. Kiểu đăng: **cả hai**, chọn **Bài video** hoặc **Reels** cho từng bài. Mặc định là Bài video.
2. Dung lượng tối đa **100 MB**; định dạng **MP4 hoặc MOV** (nhận biết bằng byte đầu file `ftyp`, không tin phần đuôi tên file).
3. Điều kiện Reels (theo khuyến nghị của Meta): **video dọc** (cao > rộng), **tối thiểu 540×960**, **dài 3–90 giây**. Không đạt thì nút Reels bị khoá và API trả 400 kèm lý do.
4. Mỗi bài có một ảnh **hoặc** một video. Tải video lên thì xoá ảnh, và ngược lại.
5. Không tạo video bằng AI. AI vẫn viết phần chữ như bình thường.
6. Tính năng này **không cần** thêm quyền Facebook nào: quyền `pages_manage_posts` đã có là đủ.

## Global Constraints

- **Git:**
  - Branch làm việc: `feature/video-upload` (tách từ `main@eee7da3`).
  - Trước mỗi commit: `git branch --show-current`, **stage từng file theo tên**, quét diff xem có lộ key/token không.
  - Không commit `.env*` hay `prompt_creator_video.md`. Không push khi người dùng chưa đồng ý.
- **Dependency và schema:**
  - Không thêm dependency npm mới.
  - Schema chỉ **thêm** cột/enum. Áp dụng local bằng `npx prisma db push --skip-generate`, sau đó chạy `npx prisma generate`.
- **Lỗi API:**
  - Dùng `asyncHandler` + `createError`, thông báo tiếng Việt.
  - Id không thuộc user trả **404**.
  - Mọi route mới phải có trong `ROUTE_CASES` của `tests/isolation.db.test.ts`.
- **Test:**
  - Không gọi Facebook thật: stub `fetch` **trong từng test**.
  - **Tắt mọi dev server** (`npm run dev`, kể cả tiến trình `tsx watch` tự khởi động lại) trước khi chạy test database.
  - Các file test DB chạy song song: chỉ file `tests/multi-page.db.test.ts` được bật worker, nên mọi test cần worker phải đặt ở file đó.
  - `vitest.config.mts` có `restoreMocks`/`unstubGlobals`, vì vậy spy/stub đặt trong test hoặc `beforeEach`.
- **Client:**
  - Build cần Node 22: `cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b`.
  - UI tiếng Việt, dùng token CSS có sẵn, không cuộn ngang ở bề ngang 390 px, tôn trọng `prefers-reduced-motion`.
- Hằng số: `MAX_VIDEO_BYTES = 100 * 1024 * 1024`; timeout khi tải video lên Facebook là `VIDEO_TIMEOUT_MS = 15 * 60_000`.

## Review Focus

1. **Video quay dọc bằng điện thoại** (file lưu 1920×1080 kèm ma trận xoay 90°): phải được hiểu là 1080×1920 (dọc) và đủ điều kiện Reels → test ở Task 2.
2. **File không phải video** (ảnh PNG đổi đuôi thành `.mp4`, file cắt dở, MP4 không có `moov`): trả 400 "Video không hợp lệ…", **không để lại file tạm** trong `videos/tmp` → test ở Task 5.
3. **Chọn Reels cho video ngang hoặc dài hơn 90 giây**: PATCH trả 400 kèm lý do cụ thể; worker cũng chặn (trường hợp bài hẹn giờ được đổi thành Reels bằng cách khác) → test ở Task 5 và Task 6.
4. **Tải ảnh lên cho bài đang có video (hoặc ngược lại)**: file cũ bị xoá khỏi đĩa, bài chỉ còn một loại media → test ở Task 5.
5. **Xoá bài hoặc xoá member có video**: file video cũng bị xoá khỏi đĩa → test ở Task 5.

---

## File Structure

| File | Trách nhiệm |
|---|---|
| `prisma/schema.prisma` (sửa) | Enum `VideoKind`, các cột video của `Post` |
| `src/lib/mp4-info.ts` (mới) | Hàm thuần: `inspectMp4`, `reelsProblem`, kiểu `VideoInfo`, `ByteSource` |
| `src/lib/video-store.ts` (mới) | Thư mục video, nhận biết MIME, lưu từ file tạm, mở dạng Blob, xoá |
| `src/lib/clients/facebook.ts` (sửa) | `publishVideo`, `publishReel`, chuẩn hoá permalink |
| `src/routes/posts.routes.ts` (sửa) | Tải lên / xoá video, `videoKind` trong PATCH, ảnh và video loại trừ nhau, dọn file khi xoá bài |
| `src/routes/videos.routes.ts` (mới) | `GET /api/videos/:postId` (chỉ chủ bài, hỗ trợ Range) |
| `src/routes/admin.routes.ts` (sửa) | Xoá member thì xoá cả file video |
| `src/services/scheduler.service.ts` (sửa) | Worker đăng video/Reels; không tạo ảnh AI khi có video |
| `src/app.ts` (sửa) | Gắn `/api/videos` |
| `tests/helpers/mp4.ts` (mới) | Sinh MP4 nhỏ hợp lệ cho test |
| `client/src/api.ts`, `client/src/components/VideoField.tsx` (mới), `CreatePostPage.tsx`, `PostsPage.tsx`, `EditPostModal.tsx`, `PostBits.tsx`, `index.css` | Giao diện |
| `docs/DEPLOY_HOSTINGER.md`, `CLAUDE.md`, `ROADMAP.md`, `prisma/hostinger-schema.sql` | Tài liệu |

---

### Task 1: Schema video

**Files:** Modify `prisma/schema.prisma`

**Interfaces:**
- Produces:
  - enum `VideoKind { FEED REEL }`;
  - các cột `Post.videoPath String?`, `Post.videoUrl String? @db.Text`, `Post.videoMime String?`, `Post.videoMeta Json?` (`{ durationSec, width, height, bytes }`), `Post.videoKind VideoKind?`.

- [ ] **Step 1: Sửa schema.** Sau enum `FormatLength { … }` thêm:

```prisma
/// How a post's video is published: a normal Page video post or a Reel
enum VideoKind {
  FEED
  REEL
}
```

Trong `model Post`, ngay sau dòng `imagePrompt  String? @db.Text // Prompt used to generate image` thêm:

```prisma
  // Video uploaded from the user's computer (a post has an image OR a video)
  videoPath    String? // storage/videos/{postId}-{ts}.mp4
  videoUrl     String? @db.Text // /api/videos/{postId}?v=…
  videoMime    String?
  videoMeta    Json? // { durationSec, width, height, bytes }
  videoKind    VideoKind?
```

- [ ] **Step 2: Áp dụng và kiểm tra**

```bash
npx prisma format && npx prisma generate && npx prisma db push --skip-generate
docker exec autopost_mariadb mariadb -uautopost -pautopost_secret autopost_db -e "SHOW COLUMNS FROM posts LIKE 'video%'"
npx tsc --noEmit
```
Expected: 5 cột `video*`; tsc sạch.

- [ ] **Step 3: Commit**

```bash
git branch --show-current
git add prisma/schema.prisma
git commit -m "feat(db): video columns on posts"
```

---

### Task 2: Đọc thông tin MP4 (hàm thuần) + điều kiện Reels

**Files:** Create `src/lib/mp4-info.ts`, `tests/helpers/mp4.ts`, `tests/mp4-info.test.ts`

**Interfaces:**
- Produces:
  - `interface ByteSource { size: number; read(offset: number, length: number): Promise<Buffer> }`;
  - `interface VideoInfo { durationSec: number; width: number; height: number }`;
  - `inspectMp4(src: ByteSource): Promise<VideoInfo | null>`;
  - `bufferSource(buf: Buffer): ByteSource`;
  - `reelsProblem(info: VideoInfo): string | null`;
  - test helper `tinyMp4(opts: { durationSec: number; width: number; height: number; rotate90?: boolean; moovAtEnd?: boolean; brand?: string }): Buffer`.

- [ ] **Step 1: Helper sinh MP4** — `tests/helpers/mp4.ts`

```ts
/** A minimal ISO-BMFF file (ftyp + mdat + moov/mvhd/trak/tkhd) — enough for inspectMp4. */
const box = (type: string, ...parts: Buffer[]) => {
  const payload = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
};

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};

export function tinyMp4(opts: { durationSec: number; width: number; height: number; rotate90?: boolean; moovAtEnd?: boolean; brand?: string }): Buffer {
  const ftyp = box('ftyp', Buffer.from((opts.brand ?? 'isom').padEnd(4).slice(0, 4), 'latin1'), u32(512), Buffer.from('isomiso2mp41', 'latin1'));
  const timescale = 1000;
  // mvhd v0: version/flags, ctime, mtime, timescale, duration, then 80 bytes we don't read
  const mvhd = box('mvhd', u32(0), u32(0), u32(0), u32(timescale), u32(Math.round(opts.durationSec * timescale)), Buffer.alloc(80));
  const identity = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  const rotated = [0, 0x00010000, 0, 0xffff0000, 0, 0, 0, 0, 0x40000000];
  const matrix = Buffer.concat((opts.rotate90 ? rotated : identity).map(u32));
  // tkhd v0 (flags=3): ctime, mtime, trackId, reserved, duration, reserved(8), layer, altGroup, volume, reserved(2), matrix, width, height
  const tkhd = box(
    'tkhd',
    u32(3), u32(0), u32(0), u32(1), u32(0), u32(Math.round(opts.durationSec * timescale)),
    Buffer.alloc(8), Buffer.alloc(8), matrix,
    u32(opts.width * 65536), u32(opts.height * 65536)
  );
  const audioTkhd = box('tkhd', u32(3), u32(0), u32(0), u32(2), u32(0), u32(0), Buffer.alloc(16), Buffer.concat(identity.map(u32)), u32(0), u32(0));
  const moov = box('moov', mvhd, box('trak', audioTkhd), box('trak', tkhd));
  const mdat = box('mdat', Buffer.alloc(64, 7));
  return opts.moovAtEnd ? Buffer.concat([ftyp, mdat, moov]) : Buffer.concat([ftyp, moov, mdat]);
}
```

- [ ] **Step 2: Viết test** — `tests/mp4-info.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { bufferSource, inspectMp4, reelsProblem } from '../src/lib/mp4-info';
import { tinyMp4 } from './helpers/mp4';

describe('inspectMp4', () => {
  it('reads duration and frame size, skipping audio tracks', async () => {
    expect(await inspectMp4(bufferSource(tinyMp4({ durationSec: 12.5, width: 1280, height: 720 })))).toEqual({
      durationSec: 12.5,
      width: 1280,
      height: 720,
    });
  });

  it('a phone video stored landscape with a 90° rotation is portrait', async () => {
    const info = await inspectMp4(bufferSource(tinyMp4({ durationSec: 20, width: 1920, height: 1080, rotate90: true })));
    expect(info).toMatchObject({ width: 1080, height: 1920 });
  });

  it('finds moov at the end of the file (typical of camera recordings)', async () => {
    expect(await inspectMp4(bufferSource(tinyMp4({ durationSec: 5, width: 1080, height: 1920, moovAtEnd: true })))).toMatchObject({ durationSec: 5 });
  });

  it('returns null for non-video or truncated data', async () => {
    expect(await inspectMp4(bufferSource(Buffer.from('\x89PNG\r\n\x1a\nnot a video', 'latin1')))).toBeNull();
    const full = tinyMp4({ durationSec: 5, width: 1080, height: 1920, moovAtEnd: true });
    expect(await inspectMp4(bufferSource(full.subarray(0, full.length - 40)))).toBeNull();
    expect(await inspectMp4(bufferSource(Buffer.alloc(0)))).toBeNull();
  });
});

describe('reelsProblem', () => {
  it('accepts vertical ≥ 540×960 between 3 and 90 seconds', () => {
    expect(reelsProblem({ durationSec: 30, width: 1080, height: 1920 })).toBeNull();
    expect(reelsProblem({ durationSec: 3, width: 540, height: 960 })).toBeNull();
  });

  it('explains what is wrong', () => {
    expect(reelsProblem({ durationSec: 30, width: 1920, height: 1080 })).toMatch(/video dọc/);
    expect(reelsProblem({ durationSec: 30, width: 480, height: 854 })).toMatch(/540×960/);
    expect(reelsProblem({ durationSec: 2, width: 1080, height: 1920 })).toMatch(/3–90 giây/);
    expect(reelsProblem({ durationSec: 95, width: 1080, height: 1920 })).toMatch(/3–90 giây/);
  });
});
```

- [ ] **Step 3: Chạy để thấy fail**

Run: `npx vitest run tests/mp4-info.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/mp4-info'`.

- [ ] **Step 4: Viết `src/lib/mp4-info.ts`**

```ts
/**
 * Read duration and display size from an MP4/MOV (ISO-BMFF) header without
 * loading the file: only box headers, mvhd and tkhd are read. Pure; tested
 * with synthetic files (tests/helpers/mp4.ts).
 */

export interface ByteSource {
  size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

export interface VideoInfo {
  durationSec: number;
  width: number;
  height: number;
}

interface Box {
  type: string;
  start: number;
  headerSize: number;
  size: number;
}

export const bufferSource = (buf: Buffer): ByteSource => ({
  size: buf.length,
  read: async (offset, length) => buf.subarray(offset, Math.min(buf.length, offset + length)),
});

async function readBoxes(src: ByteSource, start: number, end: number): Promise<Box[] | null> {
  const boxes: Box[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    const head = await src.read(pos, 16);
    if (head.length < 8) return null;
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    let headerSize = 8;
    if (size === 1) {
      if (head.length < 16) return null;
      size = Number(head.readBigUInt64BE(8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos; // box runs to the end of its parent
    }
    if (size < headerSize || pos + size > end) return null; // truncated or corrupt
    boxes.push({ type, start: pos, headerSize, size });
    pos += size;
  }
  return boxes;
}

const find = (boxes: Box[], type: string) => boxes.find((b) => b.type === type);

export async function inspectMp4(src: ByteSource): Promise<VideoInfo | null> {
  const top = await readBoxes(src, 0, src.size);
  if (!top || top[0]?.type !== 'ftyp') return null;
  const moov = find(top, 'moov');
  if (!moov) return null;
  const inMoov = await readBoxes(src, moov.start + moov.headerSize, moov.start + moov.size);
  const mvhd = inMoov && find(inMoov, 'mvhd');
  if (!inMoov || !mvhd) return null;

  const mv = await src.read(mvhd.start + mvhd.headerSize, 32);
  if (mv.length < 32) return null;
  const v1 = mv[0] === 1;
  const timescale = v1 ? mv.readUInt32BE(20) : mv.readUInt32BE(12);
  const duration = v1 ? Number(mv.readBigUInt64BE(24)) : mv.readUInt32BE(16);
  if (!timescale) return null;

  for (const trak of inMoov.filter((b) => b.type === 'trak')) {
    const inTrak = await readBoxes(src, trak.start + trak.headerSize, trak.start + trak.size);
    const tkhd = inTrak && find(inTrak, 'tkhd');
    if (!tkhd) continue;
    const body = await src.read(tkhd.start + tkhd.headerSize, tkhd.size - tkhd.headerSize);
    const matrixAt = body[0] === 1 ? 52 : 40;
    if (body.length < matrixAt + 44) continue;
    const w = body.readUInt32BE(matrixAt + 36) / 65536;
    const h = body.readUInt32BE(matrixAt + 40) / 65536;
    if (!w || !h) continue; // audio track
    // matrix[1] ≠ 0 ⇒ rotated 90°/270° (phones record portrait this way)
    const rotated = body.readInt32BE(matrixAt + 4) !== 0;
    return {
      durationSec: Math.round((duration / timescale) * 10) / 10,
      width: Math.round(rotated ? h : w),
      height: Math.round(rotated ? w : h),
    };
  }
  return null;
}

/** Why this video can't be a Reel (null = fine). Meta: vertical, ≥ 540×960, 3–90 s. */
export function reelsProblem(info: VideoInfo): string | null {
  if (info.width >= info.height) return `Reels cần video dọc 9:16 (video này ${info.width}×${info.height}).`;
  if (info.width < 540 || info.height < 960) return `Reels cần độ phân giải tối thiểu 540×960 (video này ${info.width}×${info.height}).`;
  if (info.durationSec < 3 || info.durationSec > 90) return `Reels cần dài 3–90 giây (video này ${info.durationSec} giây).`;
  return null;
}
```

- [ ] **Step 5: Chạy test**

Run: `npx vitest run tests/mp4-info.test.ts && npx tsc --noEmit`
Expected: PASS (6 test); tsc sạch.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mp4-info.ts tests/helpers/mp4.ts tests/mp4-info.test.ts
git commit -m "feat(video): read MP4 duration and size; Reels requirements"
```

---

### Task 3: Kho video trên đĩa

**Files:** Create `src/lib/video-store.ts`, `tests/video-store.test.ts`

**Interfaces:**
- Consumes: `inspectMp4`, `ByteSource`, `VideoInfo` (Task 2).
- Produces:
  - Hằng: `VIDEO_DIR`, `VIDEO_TMP_DIR`, `MAX_VIDEO_BYTES`.
  - Kiểu: `type VideoMime = 'video/mp4' | 'video/quicktime'`, `interface VideoMeta extends VideoInfo { bytes: number }`, `interface StoredVideo { videoPath: string; videoUrl: string; mime: VideoMime; meta: VideoMeta }`.
  - `detectVideoMime(head: Buffer): VideoMime | null`.
  - `saveUploadedVideo(postId: string, tmpPath: string): Promise<StoredVideo>` — throw `Error` kèm thông báo tiếng Việt nếu file không hợp lệ; file tạm **luôn** bị xoá.
  - `resolveVideo(videoPath: string): string | null` (đường dẫn tuyệt đối, chỉ nhận tên file do module này sinh ra).
  - `openVideo(videoPath: string): Promise<{ blob: Blob; size: number; mime: VideoMime } | null>`.
  - `removeVideo(videoPath: string | null | undefined): Promise<void>`.

- [ ] **Step 1: Viết test** — `tests/video-store.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { VIDEO_TMP_DIR, detectVideoMime, openVideo, removeVideo, resolveVideo, saveUploadedVideo } from '../src/lib/video-store';
import { tinyMp4 } from './helpers/mp4';

async function tmpFile(content: Buffer) {
  await mkdir(VIDEO_TMP_DIR, { recursive: true });
  const p = path.join(VIDEO_TMP_DIR, `${randomUUID()}.upload`);
  await writeFile(p, content);
  return p;
}

describe('video store', () => {
  it('detects MP4 and MOV by content', () => {
    expect(detectVideoMime(tinyMp4({ durationSec: 5, width: 640, height: 360 }))).toBe('video/mp4');
    expect(detectVideoMime(tinyMp4({ durationSec: 5, width: 640, height: 360, brand: 'qt  ' }))).toBe('video/quicktime');
    expect(detectVideoMime(Buffer.from('\x89PNG\r\n\x1a\n0000', 'latin1'))).toBeNull();
  });

  it('saves a valid upload under a generated name, with its metadata, and removes the temp file', async () => {
    const postId = randomUUID();
    const tmp = await tmpFile(tinyMp4({ durationSec: 20, width: 1080, height: 1920 }));
    const stored = await saveUploadedVideo(postId, tmp);
    expect(stored.videoPath).toMatch(new RegExp(`^storage/videos/${postId}-\\d+\\.mp4$`));
    expect(stored.videoUrl).toMatch(new RegExp(`^/api/videos/${postId}\\?v=\\d+$`));
    expect(stored.meta).toMatchObject({ durationSec: 20, width: 1080, height: 1920 });
    expect(stored.meta.bytes).toBeGreaterThan(0);
    expect(existsSync(tmp)).toBe(false);

    const opened = await openVideo(stored.videoPath);
    expect(opened).toMatchObject({ mime: 'video/mp4', size: stored.meta.bytes });
    expect((await opened!.blob.arrayBuffer()).byteLength).toBe(stored.meta.bytes);

    await removeVideo(stored.videoPath);
    expect(await openVideo(stored.videoPath)).toBeNull();
  });

  it('rejects a non-video or broken file and still deletes the temp file', async () => {
    const png = await tmpFile(Buffer.from('\x89PNG\r\n\x1a\nnot a video at all', 'latin1'));
    await expect(saveUploadedVideo(randomUUID(), png)).rejects.toThrow(/Video không hợp lệ/);
    expect(existsSync(png)).toBe(false);

    const full = tinyMp4({ durationSec: 5, width: 640, height: 360, moovAtEnd: true });
    const cut = await tmpFile(full.subarray(0, full.length - 30));
    await expect(saveUploadedVideo(randomUUID(), cut)).rejects.toThrow(/Video không hợp lệ/);
    expect(existsSync(cut)).toBe(false);
  });

  it('only resolves file names it generated (no path traversal)', () => {
    expect(resolveVideo('storage/videos/../../.env')).toBeNull();
    expect(resolveVideo('/etc/passwd')).toBeNull();
    expect(resolveVideo(`storage/videos/${randomUUID()}-1.mp4`)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `npx vitest run tests/video-store.test.ts`
Expected: FAIL — module `../src/lib/video-store` không tồn tại.

- [ ] **Step 3: Viết `src/lib/video-store.ts`**

```ts
import { openAsBlob } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { inspectMp4, type ByteSource, type VideoInfo } from './mp4-info';

/**
 * Post videos on local disk (STORAGE_DIR/videos, never public). Uploads land
 * in videos/tmp (multer diskStorage), are checked, then renamed here.
 * Served through GET /api/videos/:postId. File names are generated here only.
 */

export const VIDEO_DIR = path.resolve(process.env.STORAGE_DIR || path.join(process.cwd(), 'storage'), 'videos');
export const VIDEO_TMP_DIR = path.join(VIDEO_DIR, 'tmp');
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const LOGICAL_PREFIX = 'storage/videos/';
const STORED_FILE = /^[0-9a-f-]{36}-\d+\.(mp4|mov)$/i;

export type VideoMime = 'video/mp4' | 'video/quicktime';

export interface VideoMeta extends VideoInfo {
  bytes: number;
}

export interface StoredVideo {
  /** Logical path "storage/videos/<file>", stored in Post.videoPath */
  videoPath: string;
  /** API path, stored in Post.videoUrl (cache-busted per version) */
  videoUrl: string;
  mime: VideoMime;
  meta: VideoMeta;
}

const INVALID = 'Video không hợp lệ hoặc bị hỏng. Hãy dùng file MP4 hoặc MOV.';

/** ISO-BMFF files start with a "ftyp" box; QuickTime uses the "qt  " brand. */
export function detectVideoMime(head: Buffer): VideoMime | null {
  if (head.length < 12 || head.toString('latin1', 4, 8) !== 'ftyp') return null;
  return head.toString('latin1', 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
}

export async function saveUploadedVideo(postId: string, tmpPath: string): Promise<StoredVideo> {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(postId)) throw new Error('Invalid post id');
    const { size } = await stat(tmpPath);
    const file = await open(tmpPath, 'r');
    let mime: VideoMime | null;
    let info: VideoInfo | null;
    try {
      const src: ByteSource = {
        size,
        read: async (offset, length) => {
          const buf = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
          if (buf.length) await file.read(buf, 0, buf.length, offset);
          return buf;
        },
      };
      mime = detectVideoMime(await src.read(0, 12));
      info = mime ? await inspectMp4(src) : null;
    } finally {
      await file.close();
    }
    if (!mime || !info) throw new Error(INVALID);

    const version = Date.now();
    const fileName = `${postId}-${version}.${mime === 'video/quicktime' ? 'mov' : 'mp4'}`;
    await mkdir(VIDEO_DIR, { recursive: true });
    await rename(tmpPath, path.join(VIDEO_DIR, fileName));
    return {
      videoPath: `${LOGICAL_PREFIX}${fileName}`,
      videoUrl: `/api/videos/${postId}?v=${version}`,
      mime,
      meta: { ...info, bytes: size },
    };
  } finally {
    await unlink(tmpPath).catch(() => {}); // already renamed on success
  }
}

/** Absolute path of a stored video — only names this module generates, inside VIDEO_DIR. */
export function resolveVideo(videoPath: string): string | null {
  if (!videoPath.startsWith(LOGICAL_PREFIX)) return null;
  const fileName = videoPath.slice(LOGICAL_PREFIX.length);
  return STORED_FILE.test(fileName) ? path.join(VIDEO_DIR, fileName) : null;
}

/** A file-backed Blob (not loaded into memory) for uploading to Facebook. */
export async function openVideo(videoPath: string): Promise<{ blob: Blob; size: number; mime: VideoMime } | null> {
  const full = resolveVideo(videoPath);
  if (!full) return null;
  const mime: VideoMime = full.endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
  try {
    const { size } = await stat(full);
    return { blob: await openAsBlob(full, { type: mime }), size, mime };
  } catch {
    return null;
  }
}

export async function removeVideo(videoPath: string | null | undefined): Promise<void> {
  if (!videoPath) return;
  const full = resolveVideo(videoPath);
  if (full) await unlink(full).catch(() => {});
}
```

- [ ] **Step 4: Chạy test**

Run: `npx vitest run tests/video-store.test.ts && npx tsc --noEmit`
Expected: PASS (4 test).

- [ ] **Step 5: Commit**

```bash
git add src/lib/video-store.ts tests/video-store.test.ts
git commit -m "feat(video): video storage with content checks"
```

---

### Task 4: Đăng video và Reels lên Facebook

**Files:** Modify `src/lib/clients/facebook.ts`; Create `tests/facebook-video.test.ts`

**Interfaces:**
- Produces:
  - `FacebookClient.publishVideo(pageId, pageToken, video: { blob: Blob; mime: string }, message): Promise<PublishedPost>`;
  - `FacebookClient.publishReel(pageId, pageToken, video: { blob: Blob; size: number }, message): Promise<PublishedPost>`;
  - `PublishedPost.videoId?: string`;
  - `getPermalink` trả URL tuyệt đối (thêm tiền tố `https://www.facebook.com` cho đường dẫn tương đối của video).

- [ ] **Step 1: Viết test** — `tests/facebook-video.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
import { FacebookClient } from '../src/lib/clients/facebook';

const TOKEN = 'EAAfaketokenvideotestxxxxxxxxxxxxxx';
const client = () => new FacebookClient({ appId: '123', appSecret: 'fake-secret', graphVersion: 'v23.0' }, [TOKEN]);
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const video = () => ({ blob: new Blob([Buffer.alloc(32, 1)], { type: 'video/mp4' }), size: 32, mime: 'video/mp4' });

describe('FacebookClient video publishing', () => {
  it('publishVideo uploads to graph-video with the caption as description', async () => {
    const fetch = vi.fn(async () => json({ id: 'VID1' }));
    vi.stubGlobal('fetch', fetch);
    const res = await client().publishVideo('PAGE1', TOKEN, video(), 'Chào bà con');
    expect(res).toEqual({ postId: 'VID1', videoId: 'VID1' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://graph-video.facebook.com/v23.0/PAGE1/videos');
    const form = init.body as FormData;
    expect(form.get('description')).toBe('Chào bà con');
    expect(form.get('access_token')).toBe(TOKEN);
    expect(form.get('source')).toBeInstanceOf(Blob);
  });

  it('publishReel runs start → upload → finish', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ video_id: 'REEL1', upload_url: 'https://rupload.facebook.com/video-upload/v23.0/REEL1' }))
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(json({ success: true }));
    vi.stubGlobal('fetch', fetch);
    const res = await client().publishReel('PAGE1', TOKEN, video(), 'Reel mới');
    expect(res).toEqual({ postId: 'REEL1', videoId: 'REEL1' });

    const [startUrl, startInit] = fetch.mock.calls[0] as [string, RequestInit];
    expect(startUrl).toBe('https://graph.facebook.com/v23.0/PAGE1/video_reels');
    expect(String(startInit.body)).toContain('upload_phase=start');

    const [upUrl, upInit] = fetch.mock.calls[1] as [string, RequestInit];
    expect(upUrl).toBe('https://rupload.facebook.com/video-upload/v23.0/REEL1');
    expect(upInit.headers).toMatchObject({ Authorization: `OAuth ${TOKEN}`, offset: '0', file_size: '32' });

    const [, finishInit] = fetch.mock.calls[2] as [string, RequestInit];
    const finish = new URLSearchParams(String(finishInit.body));
    expect(finish.get('upload_phase')).toBe('finish');
    expect(finish.get('video_id')).toBe('REEL1');
    expect(finish.get('video_state')).toBe('PUBLISHED');
    expect(finish.get('description')).toBe('Reel mới');
  });

  it('a failed Reel upload stops before publishing', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ video_id: 'REEL2' })).mockResolvedValueOnce(json({ success: false }));
    vi.stubGlobal('fetch', fetch);
    await expect(client().publishReel('PAGE1', TOKEN, video(), 'x')).rejects.toThrow(/Reels/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('video permalinks (relative) become absolute', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ permalink_url: '/PAGE1/videos/VID1/' })));
    expect(await client().getPermalink('VID1', TOKEN)).toBe('https://www.facebook.com/PAGE1/videos/VID1/');
  });
});
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `npx vitest run tests/facebook-video.test.ts`
Expected: FAIL — `publishVideo is not a function`.

- [ ] **Step 3: Sửa `src/lib/clients/facebook.ts`**

Sau `const TIMEOUT_MS = 60_000;` thêm:

```ts
const GRAPH_VIDEO_BASE = 'https://graph-video.facebook.com';
const RUPLOAD_BASE = 'https://rupload.facebook.com/video-upload';
/** Uploading up to 100 MB from a shared host can take minutes */
const VIDEO_TIMEOUT_MS = 15 * 60_000;
```

Thay hàm `postOnce` bằng hai hàm sau:

```ts
  /**
   * POST once, never retried here: Facebook may have created the post even when
   * we never saw the response, and a blind retry would publish it twice.
   */
  private async postOnce<T>(path: string, body: FormData | URLSearchParams, pageToken: string): Promise<T> {
    return this.postOnceTo<T>(this.url(path), { method: 'POST', body }, pageToken);
  }

  private async postOnceTo<T>(url: string, init: RequestInit, pageToken: string, timeoutMs = TIMEOUT_MS): Promise<T> {
    const response = await fetchWithRetry(url, init, { timeoutMs, retries: 0, retryOnTimeout: false });
    return this.parse<T>(response, [pageToken]);
  }
```

Sau `publishText` thêm:

```ts
  /** Normal Page video post (video + caption in the feed). */
  async publishVideo(pageId: string, pageToken: string, video: { blob: Blob; mime: string }, message: string): Promise<PublishedPost> {
    const form = new FormData();
    form.append('source', video.blob, `post-video.${video.mime === 'video/quicktime' ? 'mov' : 'mp4'}`);
    form.append('description', message);
    form.append('access_token', pageToken);
    const res = await this.postOnceTo<{ id: string }>(
      `${GRAPH_VIDEO_BASE}/${this.config.graphVersion}/${pageId}/videos`,
      { method: 'POST', body: form },
      pageToken,
      VIDEO_TIMEOUT_MS
    );
    return { postId: res.id, videoId: res.id };
  }

  /** Page Reel: start an upload session, send the bytes, then publish. */
  async publishReel(pageId: string, pageToken: string, video: { blob: Blob; size: number }, message: string): Promise<PublishedPost> {
    const start = await this.postOnce<{ video_id: string }>(
      `${pageId}/video_reels`,
      new URLSearchParams({ upload_phase: 'start', access_token: pageToken }),
      pageToken
    );
    const uploaded = await this.postOnceTo<{ success?: boolean }>(
      `${RUPLOAD_BASE}/${this.config.graphVersion}/${start.video_id}`,
      {
        method: 'POST',
        headers: { Authorization: `OAuth ${pageToken}`, offset: '0', file_size: String(video.size) },
        body: video.blob,
      },
      pageToken,
      VIDEO_TIMEOUT_MS
    );
    // Nothing is public until "finish", so a failed upload can simply be retried
    if (!uploaded.success) throw new Error('Facebook không nhận được video Reels. Hãy thử lại.');
    await this.postOnce(
      `${pageId}/video_reels`,
      new URLSearchParams({
        upload_phase: 'finish',
        video_id: start.video_id,
        video_state: 'PUBLISHED',
        description: message,
        access_token: pageToken,
      }),
      pageToken
    );
    return { postId: start.video_id, videoId: start.video_id };
  }
```

Trong `getPermalink`, đổi `return res.permalink_url;` thành:

```ts
      const link = res.permalink_url;
      // Video nodes return a site-relative path
      return link?.startsWith('/') ? `https://www.facebook.com${link}` : link;
```

Trong `interface PublishedPost`, thêm `videoId?: string;`.

- [ ] **Step 4: Chạy test**

Run: `npx vitest run tests/facebook-video.test.ts tests/facebook.test.ts tests/publish.test.ts && npx tsc --noEmit`
Expected: PASS (các test cũ vẫn xanh).

- [ ] **Step 5: Commit**

```bash
git add src/lib/clients/facebook.ts tests/facebook-video.test.ts
git commit -m "feat(facebook): publish Page videos and Reels"
```

---

### Task 5: API video (tải lên, xoá, chọn kiểu, phát lại)

**Files:**
- Create `src/routes/videos.routes.ts`, `tests/videos.db.test.ts`
- Modify `src/routes/posts.routes.ts`, `src/routes/admin.routes.ts`, `src/app.ts`, `tests/isolation.db.test.ts`

**Interfaces:**
- Consumes: `saveUploadedVideo`, `removeVideo`, `resolveVideo`, `MAX_VIDEO_BYTES`, `VIDEO_TMP_DIR` (Task 3); `reelsProblem`, `VideoInfo` (Task 2).
- Produces:
  - `POST /api/posts/:id/video/upload` (multipart, trường `video`) ⇒ `{ videoUrl, videoKind, videoMeta, reelsProblem }`;
  - `DELETE /api/posts/:id/video`;
  - `PATCH /api/posts/:id` nhận `videoKind: 'FEED' | 'REEL'`;
  - `GET /api/posts/:id` trả thêm `reelsProblem`;
  - `GET /api/posts` trả thêm `videoUrl`, `videoKind`;
  - `GET /api/videos/:postId` (có cookie; hỗ trợ `Range`).

- [ ] **Step 1: Viết test** — `tests/videos.db.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import '../src/config';
import prisma from '../src/utils/prisma';
import { createApp } from '../src/app';
import { resolveVideo, VIDEO_TMP_DIR } from '../src/lib/video-store';
import { readImage } from '../src/lib/image-store';
import { startTestServer, api } from './helpers/http';
import { cleanupTestUsers, createTestUser } from './helpers/users';
import { tinyMp4 } from './helpers/mp4';

let server: Awaited<ReturnType<typeof startTestServer>>;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('img')]);

async function upload(cookie: string, postId: string, kind: 'video' | 'image', content: Buffer, name: string) {
  const form = new FormData();
  form.append(kind, new Blob([content]), name);
  const res = await fetch(`${server.baseUrl}/api/posts/${postId}/${kind}/upload`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-Requested-With': 'autopost' },
    body: form,
  });
  return { status: res.status, json: await res.json() };
}

async function draft(userId: string) {
  const page = await prisma.facebookPage.create({
    data: { userId, pageId: `VID_${Date.now()}_${Math.random()}`, pageName: 'P', pageAccessToken: 'EAAfaketokenvideosxxxxxxxxxxxxxxxx' },
  });
  return prisma.post.create({ data: { userId, pageId: page.id, caption: 'x' } });
}

const tmpLeftovers = async () => (existsSync(VIDEO_TMP_DIR) ? (await readdir(VIDEO_TMP_DIR)).length : 0);

describe.skipIf(!process.env.RUN_DB_TESTS)('post videos', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await cleanupTestUsers();
    server = await startTestServer(createApp());
  });
  afterAll(async () => {
    await server.close();
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  it('uploads a video, reports Reels eligibility, serves it with Range, and replaces the image', async () => {
    const { user, cookie } = await createTestUser();
    const post = await draft(user.id);
    const img = await upload(cookie, post.id, 'image', PNG, 'a.png');
    expect(img.status).toBe(200);
    const imagePath = (await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).imagePath;

    const res = await upload(cookie, post.id, 'video', tinyMp4({ durationSec: 30, width: 1920, height: 1080 }), 'clip.mp4');
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ videoKind: 'FEED', videoMeta: { durationSec: 30, width: 1920, height: 1080 } });
    expect(res.json.data.reelsProblem).toMatch(/video dọc/);

    const saved = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(saved).toMatchObject({ imagePath: null, imageUrl: null, videoMime: 'video/mp4' });
    expect(await readImage(imagePath!)).toBeNull(); // the image file was deleted

    const ranged = await fetch(`${server.baseUrl}${res.json.data.videoUrl}`, { headers: { Cookie: cookie, Range: 'bytes=0-15' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-type')).toBe('video/mp4');
    expect((await ranged.arrayBuffer()).byteLength).toBe(16);

    // Reels refused for a landscape video, allowed for a vertical one
    const bad = await api(server.baseUrl, 'PATCH', `/api/posts/${post.id}`, { cookie, body: { videoKind: 'REEL' } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/video dọc/);
    await upload(cookie, post.id, 'video', tinyMp4({ durationSec: 20, width: 1080, height: 1920 }), 'reel.mp4');
    expect((await api(server.baseUrl, 'PATCH', `/api/posts/${post.id}`, { cookie, body: { videoKind: 'REEL' } })).json.data.videoKind).toBe('REEL');
    expect(existsSync(resolveVideo(saved.videoPath!)!)).toBe(false); // the first video file is gone
  });

  it('rejects a file that is not a video and leaves no temp file', async () => {
    const { user, cookie } = await createTestUser();
    const post = await draft(user.id);
    const before = await tmpLeftovers();
    const res = await upload(cookie, post.id, 'video', PNG, 'fake.mp4');
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/Video không hợp lệ/);
    expect(await tmpLeftovers()).toBe(before);
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).videoPath).toBeNull();
  });

  it('an image upload replaces the video; removing and deleting clean up the file', async () => {
    const { user, cookie } = await createTestUser();
    const post = await draft(user.id);
    await upload(cookie, post.id, 'video', tinyMp4({ durationSec: 10, width: 640, height: 360 }), 'v.mp4');
    const first = (await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).videoPath!;
    await upload(cookie, post.id, 'image', PNG, 'a.png');
    expect(await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ videoPath: null, videoKind: null });
    expect(existsSync(resolveVideo(first)!)).toBe(false);

    await upload(cookie, post.id, 'video', tinyMp4({ durationSec: 10, width: 640, height: 360 }), 'v.mp4');
    const second = (await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).videoPath!;
    expect((await api(server.baseUrl, 'DELETE', `/api/posts/${post.id}/video`, { cookie })).status).toBe(200);
    expect(existsSync(resolveVideo(second)!)).toBe(false);

    await upload(cookie, post.id, 'video', tinyMp4({ durationSec: 10, width: 640, height: 360 }), 'v.mp4');
    const third = (await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).videoPath!;
    expect((await api(server.baseUrl, 'DELETE', `/api/posts/${post.id}`, { cookie })).status).toBe(200);
    expect(existsSync(resolveVideo(third)!)).toBe(false);
  });

  it("deleting a member removes that member's video files", async () => {
    const admin = await createTestUser({ role: 'ADMIN' });
    const member = await createTestUser();
    const post = await draft(member.user.id);
    await upload(member.cookie, post.id, 'video', tinyMp4({ durationSec: 10, width: 640, height: 360 }), 'v.mp4');
    const file = resolveVideo((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).videoPath!)!;
    const del = await api(server.baseUrl, 'DELETE', `/api/admin/users/${member.user.id}`, { cookie: admin.cookie, body: { confirmEmail: member.user.email } });
    expect(del.status).toBe(200);
    expect(existsSync(file)).toBe(false);
  });
});
```

Sửa `tests/isolation.db.test.ts`:
- Import: `import { saveUploadedVideo, VIDEO_TMP_DIR, removeVideo } from '../src/lib/video-store';`, `import { tinyMp4 } from './helpers/mp4';`, `import { mkdir, writeFile } from 'node:fs/promises';`, `import path from 'node:path';`.
- Trong `ROUTE_CASES`, trước dòng `'GET /api/images/:postId'` thêm:

```ts
  'POST /api/posts/:id/video/upload': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/video/upload`, body: {} },
  'DELETE /api/posts/:id/video': { kind: 'foreign-id', path: (b) => `/api/posts/${b.postId}/video` },
  'GET /api/videos/:postId': { kind: 'foreign-id', path: (b) => `/api/videos/${b.postId}` },
```

- Trong `beforeAll`, ngay sau khi tạo `post` của B (trước `const schedule =`), cho bài của B một file video thật, để route `GET /api/videos` có thứ để lộ ra nếu thiếu kiểm tra chủ bài:

```ts
    await mkdir(VIDEO_TMP_DIR, { recursive: true });
    const tmp = path.join(VIDEO_TMP_DIR, `iso-${post.id}.upload`);
    await writeFile(tmp, tinyMp4({ durationSec: 5, width: 640, height: 360 }));
    const stored = await saveUploadedVideo(post.id, tmp);
    bVideoPath = stored.videoPath;
    await prisma.post.update({ where: { id: post.id }, data: { videoPath: stored.videoPath, videoUrl: stored.videoUrl, videoMime: stored.mime } });
```

  Thêm `let bVideoPath: string;` cạnh `let bImagePath: string;`, và trong `afterAll` thêm `await removeVideo(bVideoPath);`.

- [ ] **Step 2: Chạy để thấy fail**

Run: `RUN_DB_TESTS=1 npx vitest run tests/videos.db.test.ts tests/isolation.db.test.ts`
Expected: FAIL — route `/video/upload` 404 và test phủ route báo thiếu route đã khai báo.

- [ ] **Step 3: Viết code**

`src/routes/videos.routes.ts`:

```ts
import { Router, Response, NextFunction } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { resolveVideo } from '../lib/video-store';

/** Post videos for the owner's browser preview. sendFile handles Range (seeking). */
const router = Router();
router.use(authenticate);

router.get(
  '/:postId',
  asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
    const post = await prisma.post.findFirst({
      where: { id: req.params.postId, userId: req.user!.id },
      select: { videoPath: true, videoMime: true },
    });
    const full = post?.videoPath ? resolveVideo(post.videoPath) : null;
    if (!full) throw createError(404, 'Video not found');
    res.sendFile(
      full,
      { headers: { 'Content-Type': post!.videoMime ?? 'video/mp4', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } },
      (err) => {
        if (err && !res.headersSent) next(createError(404, 'Video not found'));
      }
    );
  })
);

export default router;
```

`src/app.ts`: `import videosRoutes from './routes/videos.routes';` và trong `API_ROUTERS` sau `['/api/images', imagesRoutes],` thêm `['/api/videos', videosRoutes],`.

`src/routes/posts.routes.ts`:

1. Import:

```ts
import { randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import { MAX_VIDEO_BYTES, VIDEO_TMP_DIR, removeVideo, saveUploadedVideo } from '../lib/video-store';
import { reelsProblem, type VideoInfo } from '../lib/mp4-info';
```

2. Trong `updatePostSchema`, thêm trường `videoKind: z.enum(['FEED', 'REEL']),`.
3. Thêm helper sau `domainFormatSelect`:

```ts
const videoProblem = (meta: unknown) => (meta ? reelsProblem(meta as VideoInfo) : null);
const videoState = (p: { videoUrl: string | null; videoKind: string | null; videoMeta: unknown }) => ({
  videoUrl: p.videoUrl,
  videoKind: p.videoKind,
  videoMeta: p.videoMeta,
  reelsProblem: videoProblem(p.videoMeta),
});
/** Clears a post's video columns (an image replaces it) */
const noVideo = { videoPath: null, videoUrl: null, videoMime: null, videoMeta: Prisma.DbNull, videoKind: null };
```

4. List route: trong `select` thêm `videoUrl: true, videoKind: true,`.
5. Get route: đổi `res.json({ success: true, data: post });` thành `res.json({ success: true, data: { ...post, reelsProblem: videoProblem(post.videoMeta) } });`.
6. PATCH route: trước `const updated = await prisma.post.update(` thêm:

```ts
    if (data.videoKind) {
      if (!post.videoPath) throw createError(400, 'Bài chưa có video.');
      const problem = data.videoKind === 'REEL' ? videoProblem(post.videoMeta) : null;
      if (problem) throw createError(400, problem);
    }
```

   và trong `data: { … }` của update thêm `...(data.videoKind && { videoKind: data.videoKind }),`.
7. `replacePostImage`: đổi chữ ký và thân hàm:

```ts
/** Store a new image for the post and delete the previous file (an image replaces a video). */
async function replacePostImage(post: { id: string; imagePath: string | null; videoPath: string | null }, buffer: Buffer, extra: Record<string, unknown>, action: string) {
  let stored;
  try {
    stored = await saveImage(post.id, buffer);
  } catch (error) {
    throw createError(400, (error as Error).message);
  }
  const updated = await prisma.post.update({
    where: { id: post.id },
    data: { imagePath: stored.imagePath, imageUrl: stored.imageUrl, ...noVideo, ...extra },
  });
  await removeImage(post.imagePath);
  await removeVideo(post.videoPath);
  await prisma.postLog.create({ data: { postId: post.id, action, details: { bytes: buffer.length, mime: stored.mime } } });
  return updated;
}
```

   Sửa 2 chỗ gọi: `replacePostImage(post.id, post.imagePath, buffer, { imagePrompt: prompt }, 'image_generated')` → `replacePostImage(post, buffer, { imagePrompt: prompt }, 'image_generated')`; `replacePostImage(post.id, post.imagePath, file.buffer, {}, 'image_uploaded')` → `replacePostImage(post, file.buffer, {}, 'image_uploaded')`.
8. Sau route `DELETE /:id/image` thêm:

```ts
// ─── Post Video: upload (to disk) / remove ──────

const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      mkdir(VIDEO_TMP_DIR, { recursive: true }).then(() => cb(null, VIDEO_TMP_DIR), (e) => cb(e as Error, VIDEO_TMP_DIR));
    },
    filename: (_req, _file, cb) => cb(null, `${randomUUID()}.upload`),
  }),
  limits: { fileSize: MAX_VIDEO_BYTES, files: 1 },
});

router.post(
  '/:id/video/upload',
  // Check the post before accepting up to 100 MB
  asyncHandler(async (req: AuthRequest, _res: Response, next) => {
    await findImageEditablePost(req);
    next();
  }),
  (req, res, next) =>
    videoUpload.single('video')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return next(createError(400, 'Video vượt quá 100 MB.'));
      next(err);
    }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const file = (req as AuthRequest & { file?: Express.Multer.File }).file;
    if (!file) throw createError(400, 'Chưa chọn video để tải lên.');
    let post;
    try {
      post = await findImageEditablePost(req);
    } catch (error) {
      await unlink(file.path).catch(() => {});
      throw error;
    }
    let stored;
    try {
      stored = await saveUploadedVideo(post.id, file.path);
    } catch (error) {
      throw createError(400, (error as Error).message);
    }
    const updated = await prisma.post.update({
      where: { id: post.id },
      data: {
        videoPath: stored.videoPath,
        videoUrl: stored.videoUrl,
        videoMime: stored.mime,
        videoMeta: { ...stored.meta },
        videoKind: 'FEED',
        imagePath: null,
        imageUrl: null,
      },
    });
    await removeVideo(post.videoPath);
    await removeImage(post.imagePath);
    await prisma.postLog.create({ data: { postId: post.id, action: 'video_uploaded', details: { ...stored.meta } } });
    logger.info('Post video uploaded', { postId: post.id, bytes: stored.meta.bytes });
    res.json({ success: true, data: videoState(updated) });
  })
);

router.delete(
  '/:id/video',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const post = await findImageEditablePost(req);
    await prisma.post.update({ where: { id: post.id }, data: noVideo });
    await removeVideo(post.videoPath);
    await prisma.postLog.create({ data: { postId: post.id, action: 'video_removed' } });
    res.json({ success: true, data: { videoUrl: null } });
  })
);
```

9. Route xoá bài: sau `await removeImage(post.imagePath);` thêm `await removeVideo(post.videoPath);`.

`src/routes/admin.routes.ts` (DELETE `/users/:id`):
- `import { removeVideo } from '../lib/video-store';`.
- Đổi truy vấn `images` thành:

```ts
      prisma.post.findMany({
        where: { userId: target.id, OR: [{ imagePath: { not: null } }, { videoPath: { not: null } }] },
        select: { imagePath: true, videoPath: true },
      }),
```

- Đổi `await Promise.all(images.map((i) => removeImage(i.imagePath)));` thành `await Promise.all(images.flatMap((i) => [removeImage(i.imagePath), removeVideo(i.videoPath)]));`.

- [ ] **Step 4: Chạy test**

Run: `npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run tests/videos.db.test.ts tests/isolation.db.test.ts tests/admin.db.test.ts tests/posts-domains.db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/videos.routes.ts src/routes/posts.routes.ts src/routes/admin.routes.ts src/app.ts tests/videos.db.test.ts tests/isolation.db.test.ts
git commit -m "feat(video): upload, remove and play post videos; Reels choice"
```

---

### Task 6: Worker đăng video / Reels

**Files:** Modify `src/services/scheduler.service.ts`, `tests/multi-page.db.test.ts`

**Interfaces:**
- Consumes: `openVideo` (Task 3); `reelsProblem`, `VideoInfo` (Task 2); `publishVideo`, `publishReel` (Task 4).

- [ ] **Step 1: Viết test** — trong `tests/multi-page.db.test.ts`:
- Thêm import: `import { saveUploadedVideo, removeVideo, VIDEO_TMP_DIR } from '../src/lib/video-store';`, `import { tinyMp4 } from './helpers/mp4';`, `import { mkdir, writeFile } from 'node:fs/promises';`, `import path from 'node:path';`.
- Thêm helper trong file (trên `describe`):

```ts
async function attachVideo(postId: string, opts: { durationSec: number; width: number; height: number }, kind: 'FEED' | 'REEL') {
  await mkdir(VIDEO_TMP_DIR, { recursive: true });
  const tmp = path.join(VIDEO_TMP_DIR, `mp-${postId}.upload`);
  await writeFile(tmp, tinyMp4(opts));
  const stored = await saveUploadedVideo(postId, tmp);
  await prisma.post.update({
    where: { id: postId },
    data: { videoPath: stored.videoPath, videoUrl: stored.videoUrl, videoMime: stored.mime, videoMeta: { ...stored.meta }, videoKind: kind, imagePrompt: 'never used' },
  });
  return stored.videoPath;
}

/** Graph stub for video publishing: records which endpoint each call hit */
function videoFetch(calls: string[]) {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${url.host}${url.pathname}`);
    if (url.pathname.endsWith('/video_reels')) {
      const phase = new URLSearchParams(String(init?.body)).get('upload_phase');
      return new Response(JSON.stringify(phase === 'start' ? { video_id: 'REEL_X' } : { success: true }), { status: 200 });
    }
    if (url.host === 'rupload.facebook.com') return new Response(JSON.stringify({ success: true }), { status: 200 });
    if (url.pathname.endsWith('/videos')) return new Response(JSON.stringify({ id: 'VID_X' }), { status: 200 });
    return new Response(JSON.stringify({ permalink_url: '/page/videos/VID_X/' }), { status: 200 });
  });
}
```

- Thêm 2 test trước `it('a double click never publishes the same Page twice'`:

```ts
  it('publishes an uploaded video as a normal Page video, without generating an image', async () => {
    const post = await createPost(1);
    const videoPath = await attachVideo(post.id, { durationSec: 12, width: 1280, height: 720 }, 'FEED');
    const calls: string[] = [];
    vi.stubGlobal('fetch', videoFetch(calls));
    try {
      await enqueuePost(post.id, userId, { skipAi: true, targetIds: post.targets.map((t) => t.id), intervalMs: 0 });
      const done = await waitForStatus(post.id, ['PUBLISHED', 'FAILED']);
      expect(done.status).toBe('PUBLISHED');
      expect(done.imagePath).toBeNull();
      expect(calls).toContain('graph-video.facebook.com/v23.0/TEST_MP_1/videos');
      const target = await prisma.postTarget.findFirstOrThrow({ where: { postId: post.id } });
      expect(target).toMatchObject({ fbPostId: 'VID_X', fbPermalink: 'https://www.facebook.com/page/videos/VID_X/' });
    } finally {
      await removeVideo(videoPath);
    }
  });

  it('publishes a vertical video as a Reel (start → upload → finish)', async () => {
    const post = await createPost(1);
    const videoPath = await attachVideo(post.id, { durationSec: 20, width: 1080, height: 1920 }, 'REEL');
    const calls: string[] = [];
    vi.stubGlobal('fetch', videoFetch(calls));
    try {
      await enqueuePost(post.id, userId, { skipAi: true, targetIds: post.targets.map((t) => t.id), intervalMs: 0 });
      expect((await waitForStatus(post.id, ['PUBLISHED', 'FAILED'])).status).toBe('PUBLISHED');
      expect(calls.filter((c) => c.endsWith('/video_reels'))).toHaveLength(2);
      expect(calls).toContain('rupload.facebook.com/video-upload/v23.0/REEL_X');
      const target = await prisma.postTarget.findFirstOrThrow({ where: { postId: post.id } });
      expect(target.fbPostId).toBe('REEL_X');
      expect(target.fbPermalink).toMatch(/facebook\.com/);
    } finally {
      await removeVideo(videoPath);
    }
  });

  it('refuses to publish a Reel that does not meet the Reels requirements', async () => {
    const post = await createPost(1);
    const videoPath = await attachVideo(post.id, { durationSec: 20, width: 1920, height: 1080 }, 'REEL');
    const calls: string[] = [];
    vi.stubGlobal('fetch', videoFetch(calls));
    try {
      await enqueuePost(post.id, userId, { skipAi: true, targetIds: post.targets.map((t) => t.id), intervalMs: 0 });
      const done = await waitForStatus(post.id, ['PUBLISHED', 'FAILED']);
      expect(done.status).toBe('FAILED');
      expect(done.errorMessage).toMatch(/video dọc/);
      expect(calls.filter((c) => c.includes('video'))).toEqual([]);
    } finally {
      await removeVideo(videoPath);
    }
  });
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `RUN_DB_TESTS=1 npx vitest run tests/multi-page.db.test.ts`
Expected: FAIL — worker đăng qua `/photos` hoặc `/feed`, không qua video.

- [ ] **Step 3: Sửa `src/services/scheduler.service.ts`**
- Import: `import { openVideo } from '../lib/video-store';`, `import { reelsProblem, type VideoInfo } from '../lib/mp4-info';`.
- Trong `runPublishJob`, bước ảnh:
  - đổi `} else if (!skipImageGeneration && post.imagePrompt) {` thành `} else if (!skipImageGeneration && post.imagePrompt && !post.videoPath) {`;
  - đổi `if (!finalMessage && !hasImage) {` thành `if (!finalMessage && !hasImage && !post.videoPath) {`.
- Trong `runTargetJob`, ngay sau dòng `if (post.imagePath && !image) throw …` thêm:

```ts
    const video = post.videoPath ? await openVideo(post.videoPath) : null;
    if (post.videoPath && !video) throw new UnrecoverableJobError('Không đọc được video của bài trên máy chủ. Hãy tải lại video.');
    const reelIssue = post.videoKind === 'REEL' && post.videoMeta ? reelsProblem(post.videoMeta as unknown as VideoInfo) : null;
    if (reelIssue) throw new UnrecoverableJobError(reelIssue);
```

- Đổi khối chọn cách đăng thành:

```ts
    const published = video
      ? post.videoKind === 'REEL'
        ? await facebook.publishReel(page.pageId, pageToken, video, finalMessage)
        : await facebook.publishVideo(page.pageId, pageToken, video, finalMessage)
      : image
        ? await facebook.publishPhoto(page.pageId, pageToken, image, finalMessage)
        : await facebook.publishText(page.pageId, pageToken, finalMessage);
```

- Đổi `const permalink = await facebook.getPermalink(published.postId, pageToken);` thành:

```ts
    // A Reel may still be processing: fall back to its public URL
    const permalink =
      (await facebook.getPermalink(published.postId, pageToken)) ??
      (post.videoKind === 'REEL' && video ? `https://www.facebook.com/reel/${published.postId}` : undefined);
```

- [ ] **Step 4: Chạy test**

Run: `npx tsc --noEmit && RUN_DB_TESTS=1 npx vitest run tests/multi-page.db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/scheduler.service.ts tests/multi-page.db.test.ts
git commit -m "feat(video): worker publishes Page videos and Reels"
```

---

### Task 7: Client — tải video lên, chọn Bài video / Reels

**Files:**
- Create `client/src/components/VideoField.tsx`
- Modify `client/src/api.ts`, `client/src/pages/CreatePostPage.tsx`, `client/src/index.css`

**Interfaces:**
- Produces:
  - Kiểu: `type VideoKind = 'FEED' | 'REEL'`, `interface VideoMeta { durationSec; width; height; bytes }`, `interface VideoState { videoUrl: string | null; videoKind: VideoKind | null; videoMeta: VideoMeta | null; reelsProblem: string | null }`, `EMPTY_VIDEO: VideoState`.
  - Hằng: `MAX_VIDEO_BYTES`, `VIDEO_TYPES`.
  - `postsApi.uploadVideo(id, file, onProgress?)`, `postsApi.removeVideo(id)`; `PostUpdate.videoKind?`.
  - `VideoField({ postId, ensurePost, value, onChange, disabled })`.

- [ ] **Step 1: `client/src/api.ts`** — sau `export const UPLOAD_TYPES = …` thêm:

```ts
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime'];

export type VideoKind = 'FEED' | 'REEL';

export interface VideoMeta {
  durationSec: number;
  width: number;
  height: number;
  bytes: number;
}

export interface VideoState {
  videoUrl: string | null;
  videoKind: VideoKind | null;
  videoMeta: VideoMeta | null;
  /** Why the video can't be a Reel (null = it can) */
  reelsProblem: string | null;
}

export const EMPTY_VIDEO: VideoState = { videoUrl: null, videoKind: null, videoMeta: null, reelsProblem: null };
```

Trong `interface PostUpdate` thêm `videoKind?: VideoKind;`. Trong `postsApi`, sau `removeImage` thêm:

```ts
  /** XHR (not fetch) so a 100 MB upload can report progress */
  uploadVideo: (id: string, file: File, onProgress?: (percent: number) => void) =>
    new Promise<VideoState>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/posts/${id}/video/upload`);
      xhr.withCredentials = true;
      xhr.setRequestHeader('X-Requested-With', 'autopost');
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
      xhr.onload = () => {
        let data: any = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          /* non-JSON error page (e.g. proxy 413) */
        }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data.data as VideoState);
        if (data.code === 'UNAUTHENTICATED') window.dispatchEvent(new CustomEvent(AUTH_EVENT, { detail: { code: data.code } }));
        const message = xhr.status === 413 ? 'Máy chủ từ chối file quá lớn.' : data.error || 'Tải video lên thất bại.';
        reject(new ApiError(message, xhr.status, data.code));
      };
      xhr.onerror = () => reject(new ApiError('Mất kết nối khi tải video lên.', 0));
      const body = new FormData();
      body.append('video', file);
      xhr.send(body);
    }),

  removeVideo: (id: string) => apiFetch<{ videoUrl: null }>(`/posts/${id}/video`, { method: 'DELETE' }),
```

- [ ] **Step 2: `client/src/components/VideoField.tsx`**

```tsx
import { useRef, useState } from 'react';
import { Film, Upload, Trash2 } from 'lucide-react';
import { postsApi, assetUrl, ApiError, MAX_VIDEO_BYTES, VIDEO_TYPES, EMPTY_VIDEO, type VideoKind, type VideoState } from '../api';
import { useToast } from './Toast';

interface Props {
  postId: string | null;
  /** Create the post first when needed (Create Post page) */
  ensurePost?: () => Promise<string>;
  value: VideoState;
  onChange: (value: VideoState) => void;
  disabled?: boolean;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;

/** Upload a local video (≤ 100 MB), choose "Bài video" or "Reels", remove it. */
export default function VideoField({ postId, ensurePost, value, onChange, disabled }: Props) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  async function pick(file?: File) {
    if (!file) return;
    if (!VIDEO_TYPES.includes(file.type)) return toast.error('Chỉ hỗ trợ video MP4 hoặc MOV.');
    if (file.size > MAX_VIDEO_BYTES) return toast.error('Video vượt quá 100 MB.');
    setBusy(true);
    setProgress(0);
    try {
      const id = postId ?? (ensurePost ? await ensurePost() : null);
      if (!id) throw new Error('Chưa có bài để gắn video.');
      onChange(await postsApi.uploadVideo(id, file, setProgress));
      toast.success('Đã tải video lên — video sẽ được đăng thay cho ảnh.');
    } catch (e) {
      toast.error(e instanceof ApiError || e instanceof Error ? e.message : 'Tải video lên thất bại.');
    } finally {
      setBusy(false);
      setProgress(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function setKind(kind: VideoKind) {
    if (!postId || kind === value.videoKind) return;
    try {
      await postsApi.update(postId, { videoKind: kind });
      onChange({ ...value, videoKind: kind });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Không đổi được kiểu đăng.');
    }
  }

  async function remove() {
    if (!postId) return;
    setBusy(true);
    try {
      await postsApi.removeVideo(postId);
      onChange(EMPTY_VIDEO);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Không bỏ được video.');
    } finally {
      setBusy(false);
    }
  }

  const input = <input ref={fileRef} type="file" accept="video/mp4,video/quicktime" hidden onChange={(e) => pick(e.target.files?.[0])} />;

  if (!value.videoUrl) {
    return (
      <div className="video-field empty">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()} disabled={disabled || busy}>
          {busy ? <div className="spinner" /> : <Upload size={14} aria-hidden="true" />} Tải video lên
        </button>
        <span className="field-hint">MP4/MOV, tối đa 100 MB. Video sẽ thay cho ảnh.</span>
        {progress !== null && (
          <div className="upload-progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Tiến độ tải video">
            <span style={{ width: `${progress}%` }} />
            <em>{progress}%</em>
          </div>
        )}
        {input}
      </div>
    );
  }

  const meta = value.videoMeta;
  return (
    <div className="video-field">
      <video className="video-preview" src={assetUrl(value.videoUrl)!} controls preload="metadata" />
      <div className="stack" style={{ gap: 8, minWidth: 0 }}>
        {meta && (
          <span className="muted video-meta">
            <Film size={13} aria-hidden="true" /> {mmss(meta.durationSec)} · {meta.width}×{meta.height} · {mb(meta.bytes)}
          </span>
        )}
        <div className="segmented" role="radiogroup" aria-label="Kiểu đăng video">
          <button type="button" role="radio" aria-checked={value.videoKind !== 'REEL'} className={value.videoKind !== 'REEL' ? 'active' : ''} onClick={() => setKind('FEED')} disabled={disabled}>
            Bài video
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={value.videoKind === 'REEL'}
            className={value.videoKind === 'REEL' ? 'active' : ''}
            onClick={() => setKind('REEL')}
            disabled={disabled || !!value.reelsProblem}
            title={value.reelsProblem ?? 'Đăng dạng Reels'}
          >
            Reels
          </button>
        </div>
        {value.reelsProblem && <span className="field-hint">Không đăng Reels được: {value.reelsProblem}</span>}
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()} disabled={disabled || busy}>
            <Upload size={14} aria-hidden="true" /> Đổi video
          </button>
          <button type="button" className="btn btn-secondary btn-sm danger-hover" onClick={remove} disabled={disabled || busy} aria-label="Bỏ video">
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </div>
        {progress !== null && (
          <div className="upload-progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Tiến độ tải video">
            <span style={{ width: `${progress}%` }} />
            <em>{progress}%</em>
          </div>
        )}
      </div>
      {input}
    </div>
  );
}
```

- [ ] **Step 3: `client/src/pages/CreatePostPage.tsx`**
- Import: `EMPTY_VIDEO, type VideoState` từ `'../api'`; `import VideoField from '../components/VideoField';`.
- State: `const [video, setVideo] = useState<VideoState>(EMPTY_VIDEO);`.
- Trong khung ảnh (`<section className="card">` chứa `htmlFor="image-prompt"`), ngay trước `</section>` đóng khung đó thêm:

```tsx
          <div className="settings-divider" style={{ margin: '14px 0 10px' }} />
          <span className="form-label">Hoặc đăng video</span>
          <VideoField
            postId={postId}
            ensurePost={ensurePost}
            value={video}
            onChange={(v) => {
              setVideo(v);
              if (v.videoUrl) setPreviewImage(null); // the server removed the image
            }}
            disabled={!!busy || !selectedPages.length}
          />
```

- Ảnh và video loại trừ nhau trên giao diện: nút **Tạo ảnh bằng AI** và **Tải ảnh lên** thêm điều kiện `|| !!video.videoUrl` vào `disabled`. Sau khi tạo hoặc tải ảnh thành công (trong `makeImage` và `uploadImage`), gọi `setVideo(EMPTY_VIDEO)`.
- Khung xem trước Facebook: thay khối `{previewImage ? (<img className="fb-image" …/>) : (<div className="fb-image placeholder">…</div>)}` bằng:

```tsx
          {video.videoUrl ? (
            <video className="fb-image fb-video" src={assetUrl(video.videoUrl)!} controls muted preload="metadata" />
          ) : previewImage ? (
            <img className="fb-image" src={previewImage} alt="" />
          ) : (
            <div className="fb-image placeholder">{imagePrompt ? 'Ảnh sẽ được AI tạo khi đăng' : 'Ảnh AI sẽ hiện ở đây'}</div>
          )}
```

- Nút Đăng: khi `video.videoKind === 'REEL'`, nhãn đổi thành `Duyệt & đăng Reels`.

- [ ] **Step 4: CSS** — thêm cuối `client/src/index.css`:

```css
/* ─── Post video ───────────────────────────── */
.video-field { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: 14px; align-items: start; }
.video-field.empty { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.video-field.empty .field-hint { margin: 0; }
.video-preview { width: 160px; max-height: 240px; border-radius: 9px; background: #000; object-fit: contain; }
.video-meta { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; }
.upload-progress { position: relative; flex-basis: 100%; height: 22px; border-radius: var(--radius-full); background: var(--bg-secondary); overflow: hidden; }
.upload-progress span { position: absolute; inset: 0 auto 0 0; background: var(--primary-500); transition: width var(--transition-fast); }
.upload-progress em { position: relative; display: block; text-align: center; font-size: 12px; font-style: normal; line-height: 22px; color: var(--text-primary); mix-blend-mode: difference; filter: invert(1); }
.fb-video { aspect-ratio: auto; max-height: 520px; background: #000; object-fit: contain; }
@media (max-width: 640px) { .video-field { grid-template-columns: 1fr; } .video-preview { width: 100%; } }
@media (prefers-reduced-motion: reduce) { .upload-progress span { transition: none; } }
```

- [ ] **Step 5: Kiểm tra + commit**

Run: `cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b`
Expected: sạch.

```bash
git add client/src/api.ts client/src/components/VideoField.tsx client/src/pages/CreatePostPage.tsx client/src/index.css
git commit -m "feat(client): upload a video and choose Page video or Reels when creating a post"
```

---

### Task 8: Client — Bài đăng & Sửa bài hiển thị video; kiểm tra trên trình duyệt

**Files:** Modify `client/src/components/PostBits.tsx`, `client/src/pages/PostsPage.tsx`, `client/src/components/EditPostModal.tsx`

- [ ] **Step 1: `PostBits.tsx`** — `PostThumb` nhận thêm `video?: boolean`:

```tsx
export function PostThumb({ src, size = 52, video = false }: { src?: string | null; size?: number; video?: boolean }) {
  if (video) {
    return (
      <span className="post-thumb" style={{ width: size, height: size }} aria-label="Bài có video">
        <Film size={20} strokeWidth={1.8} aria-hidden="true" />
      </span>
    );
  }
  if (src) return <img className="post-thumb" src={assetUrl(src)!} alt="" style={{ width: size, height: size }} />;
  return (
    <span className="post-thumb" style={{ width: size, height: size }} aria-hidden="true">
      <ImageIcon size={20} strokeWidth={1.8} />
    </span>
  );
}
```

(Thêm `Film` vào import lucide.)

- [ ] **Step 2: `PostsPage.tsx`**
- `interface PostData` thêm `videoUrl?: string | null; videoKind?: 'FEED' | 'REEL' | null;`.
- Dòng danh sách: `<PostThumb src={p.imageUrl} size={56} />` → `<PostThumb src={p.imageUrl} size={56} video={!!p.videoUrl} />`. Trong `post-meta`, trước số từ thêm `{p.videoKind === 'REEL' ? 'Reels · ' : p.videoUrl ? 'Video · ' : ''}`.
- Xem trước bên phải: thay `{detail.imageUrl ? (<img className="fb-image" …/>) : (…placeholder…)}` bằng:

```tsx
              {detail.videoUrl ? (
                <video className="fb-image fb-video" src={assetUrl(detail.videoUrl)!} controls muted preload="metadata" />
              ) : detail.imageUrl ? (
                <img className="fb-image" src={assetUrl(detail.imageUrl)!} alt="Ảnh đăng kèm bài" />
              ) : (
```

  giữ nguyên nhánh placeholder hiện có.
- Thêm `detail.videoUrl` vào mảng phụ thuộc của `useEffect` đang theo dõi `selected?.imageUrl`.

- [ ] **Step 3: `EditPostModal.tsx`**
- Import `VideoField` và `EMPTY_VIDEO, type VideoState`.
- State: `const [video, setVideo] = useState<VideoState>({ videoUrl: post.videoUrl ?? null, videoKind: post.videoKind ?? null, videoMeta: post.videoMeta ?? null, reelsProblem: post.reelsProblem ?? null });` (thêm các trường này, đều optional, vào kiểu `post` mà modal nhận).
- Ở khối ảnh (`{post.imageUrl ? (<img className="image-editor-thumb" …/>)`): nếu `video.videoUrl` thì hiện `<VideoField postId={post.id} value={video} onChange={setVideo} disabled={saving} />` thay cho toàn bộ khối sửa ảnh, kèm dòng ghi chú `<p className="field-hint">Bài dùng video — bỏ video để quay lại dùng ảnh.</p>`. Nếu không có video thì giữ nguyên khối ảnh, và thêm `<VideoField postId={post.id} value={video} onChange={setVideo} disabled={saving} />` ngay dưới các nút ảnh.
- Khung xem trước (`{post.imageUrl ? (<img className="fb-image" …/>)`): thêm nhánh `video.videoUrl` hiển thị `<video className="fb-image fb-video" … />` như ở Step 2.
- Khi đóng modal, báo thay đổi video lên trang cha giống cách ảnh đang làm (gọi lại `onSaved`/tải lại bài). Làm theo đúng cơ chế đang dùng cho `applyImage` trong file.

- [ ] **Step 3b: Kiểm tra kiểu**

Run: `cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b`
Expected: sạch.

- [ ] **Step 4: Chạy thử trên trình duyệt**
- **Tắt test trước.** Chạy API bằng `npm run dev` và client bằng Vite (xem `CLAUDE.md`). Đăng nhập bằng tài khoản local.
- **Không** bấm Đăng với Page thật.
- Dùng Playwright để kiểm tra:
  1. `/posts/create`: nhập ý tưởng rồi **Tải video lên** một MP4 ngang có sẵn trên máy (hoặc file tạo từ `tinyMp4` rồi ghi ra đĩa). Thấy thanh tiến độ, xem trước bằng `<video>`, dòng thời lượng và kích thước; Reels bị khoá kèm lý do; khung xem trước Facebook phát video; nút tạo ảnh bị khoá.
  2. Tải video dọc 1080×1920 dài 20 giây: Reels bấm được, nhãn nút đổi thành "Duyệt & đăng Reels".
  3. **Bỏ video**: quay lại khung ảnh bình thường.
  4. **Lưu, duyệt sau**, rồi mở `/posts`: dòng có biểu tượng phim và chữ "Video ·"; khung xem trước phát video; nút **Sửa** mở modal có VideoField.
  5. Bề ngang 390 px: không cuộn ngang.
- Chụp `.playwright-mcp/video-create.png` và `.playwright-mcp/video-posts.png`.
- Xong thì tắt hẳn server (`taskkill` cả cây `npm run dev`).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/PostBits.tsx client/src/pages/PostsPage.tsx client/src/components/EditPostModal.tsx
git commit -m "feat(client): show videos in the post list, preview and edit dialog"
```

---

### Task 9: Tài liệu, SQL Hostinger, kiểm tra toàn bộ

**Files:** Modify `docs/DEPLOY_HOSTINGER.md`, `CLAUDE.md`, `ROADMAP.md`, `prisma/hostinger-schema.sql`

- [ ] **Step 1: SQL Hostinger** — sinh lại như trong `CLAUDE.md` (giữ phần header), rồi thử import vào một database tạm. Expected: bảng `posts` có các cột `video*`.
- [ ] **Step 2: `docs/DEPLOY_HOSTINGER.md`**
  - Mục 1.3 (STORAGE_DIR): thêm câu "Video bài viết nằm ở `STORAGE_DIR/videos` (tối đa 100 MB mỗi video). Theo dõi dung lượng đĩa của gói."
  - Mục 3 (Kiểm tra sau deploy): thêm bước "Tải thử một video khoảng 50–100 MB. Nếu báo 'Máy chủ từ chối file quá lớn' (lỗi 413 từ proxy của Hostinger) thì giới hạn tải lên của gói thấp hơn 100 MB — dùng video nhỏ hơn."
  - Bảng Xử lý sự cố: thêm dòng `| Tải video báo "Máy chủ từ chối file quá lớn" | Proxy của Hostinger giới hạn dung lượng tải lên; dùng video nhỏ hơn hoặc nén lại |`.
- [ ] **Step 3: `CLAUDE.md`** — trong đoạn **Images**, thêm câu: "Videos (MP4/MOV ≤ 100 MB) live under `STORAGE_DIR/videos` (`src/lib/video-store.ts`, header parsed by `src/lib/mp4-info.ts`), served by `GET /api/videos/:postId`; a post has an image OR a video, and `Post.videoKind` picks `publishVideo` (feed) or `publishReel`."
- [ ] **Step 4: `ROADMAP.md`** — thêm vào cuối mục Phase 1: `- ✅ (2026-09-30) Tải video từ máy lên (MP4/MOV ≤ 100 MB), đăng dạng bài video hoặc Reels (kiểm tra điều kiện Reels trước khi đăng) — plan docs/superpowers/plans/2026-09-30-video-upload.md`.
- [ ] **Step 5: Kiểm tra toàn bộ** (không có dev server)

```bash
netstat -ano | grep -E ":(3000|5173) .*LISTENING" || echo "no dev servers"
npx tsc --noEmit && npx vitest run && RUN_DB_TESTS=1 npx vitest run
(cd client && npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b && npx -y -p node@22 -- node node_modules/vite/bin/vite.js build)
ls storage/videos/tmp 2>/dev/null | wc -l
```
Expected: tất cả PASS; build OK; thư mục tạm không còn file.

- [ ] **Step 6: Commit và DỪNG**

```bash
git branch --show-current
git add docs/DEPLOY_HOSTINGER.md CLAUDE.md ROADMAP.md prisma/hostinger-schema.sql
git commit -m "docs: video upload (storage, upload limit on Hostinger)"
```

Báo người dùng: tính năng đã xong trên `feature/video-upload`, chưa merge, chưa deploy. Nhắc họ thử tải video 100 MB trên Hostinger để kiểm tra giới hạn tải lên của proxy.
