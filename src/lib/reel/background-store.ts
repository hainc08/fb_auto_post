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
