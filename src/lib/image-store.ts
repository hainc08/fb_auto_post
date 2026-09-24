import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Post images on local disk (storage/images, git-ignored, never under public/).
 * Served through GET /api/images/:postId. File names are generated here only.
 */

export const IMAGE_DIR = path.resolve(process.cwd(), 'storage', 'images');
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // Facebook accepts larger, but 8 MB keeps uploads fast

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

const EXT: Record<ImageMime, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Identify the format from magic bytes — never trust a filename or client MIME. */
export function detectImageMime(buffer: Buffer): ImageMime | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export interface StoredImage {
  /** Relative to the project root, stored in Post.imagePath */
  imagePath: string;
  /** Public API path, stored in Post.imageUrl (cache-busted per version) */
  imageUrl: string;
  mime: ImageMime;
}

export async function saveImage(postId: string, buffer: Buffer): Promise<StoredImage> {
  if (!/^[0-9a-f-]{36}$/i.test(postId)) throw new Error('Invalid post id');
  const mime = detectImageMime(buffer);
  if (!mime) throw new Error('Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP.');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('Ảnh vượt quá 8 MB.');

  const version = Date.now();
  const fileName = `${postId}-${version}.${EXT[mime]}`;
  await mkdir(IMAGE_DIR, { recursive: true });
  await writeFile(path.join(IMAGE_DIR, fileName), buffer);

  return { imagePath: `storage/images/${fileName}`, imageUrl: `/api/images/${postId}?v=${version}`, mime };
}

/** Resolve a stored imagePath safely (must stay inside IMAGE_DIR). */
function resolveStored(imagePath: string): string | null {
  const full = path.resolve(process.cwd(), imagePath);
  return full.startsWith(IMAGE_DIR + path.sep) ? full : null;
}

export async function readImage(imagePath: string): Promise<{ buffer: Buffer; mime: ImageMime } | null> {
  const full = resolveStored(imagePath);
  if (!full) return null;
  try {
    const buffer = await readFile(full);
    const mime = detectImageMime(buffer);
    return mime ? { buffer, mime } : null;
  } catch {
    return null;
  }
}

export async function removeImage(imagePath: string | null | undefined): Promise<void> {
  if (!imagePath) return;
  const full = resolveStored(imagePath);
  if (full) await unlink(full).catch(() => {});
}
