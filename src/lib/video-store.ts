import { openAsBlob } from 'node:fs';
import { mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
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

/**
 * Delete temp uploads older than maxAgeMs: an upload the browser aborted can
 * leave a partial file behind. Returns how many files were removed.
 */
export async function sweepVideoTmp(maxAgeMs = 60 * 60_000, now = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(VIDEO_TMP_DIR);
  } catch {
    return 0; // no uploads yet
  }
  let removed = 0;
  for (const name of names) {
    const full = path.join(VIDEO_TMP_DIR, name);
    const info = await stat(full).catch(() => null);
    if (info?.isFile() && now - info.mtimeMs > maxAgeMs) {
      await unlink(full).catch(() => {});
      removed++;
    }
  }
  return removed;
}
