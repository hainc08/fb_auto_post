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
