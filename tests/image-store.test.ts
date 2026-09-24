import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { detectImageMime, saveImage, readImage, removeImage, MAX_IMAGE_BYTES } from '../src/lib/image-store';

const POST_ID = '00000000-0000-4000-8000-00000000test'.replace('test', 'abcd');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

const created: string[] = [];
afterEach(async () => {
  for (const p of created.splice(0)) await removeImage(p);
});

describe('detectImageMime', () => {
  it('recognises JPEG, PNG and WebP by magic bytes', () => {
    expect(detectImageMime(JPEG)).toBe('image/jpeg');
    expect(detectImageMime(PNG)).toBe('image/png');
    expect(detectImageMime(WEBP)).toBe('image/webp');
  });

  it('rejects other content even if it claims to be an image', () => {
    expect(detectImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(detectImageMime(Buffer.from('GIF89a'))).toBeNull();
    expect(detectImageMime(Buffer.alloc(0))).toBeNull();
  });
});

describe('saveImage / readImage / removeImage', () => {
  it('stores under storage/images with a versioned API url, reads it back, removes it', async () => {
    const stored = await saveImage(POST_ID, PNG);
    created.push(stored.imagePath);

    expect(stored.imagePath).toMatch(new RegExp(`^storage/images/${POST_ID}-\\d+\\.png$`));
    expect(stored.imageUrl).toMatch(new RegExp(`^/api/images/${POST_ID}\\?v=\\d+$`));
    expect(stored.mime).toBe('image/png');

    const read = await readImage(stored.imagePath);
    expect(read?.mime).toBe('image/png');
    expect(read?.buffer.equals(PNG)).toBe(true);

    await removeImage(stored.imagePath);
    expect(existsSync(path.resolve(stored.imagePath))).toBe(false);
  });

  it('refuses non-images and oversized files', async () => {
    await expect(saveImage(POST_ID, Buffer.from('not an image'))).rejects.toThrow(/JPG, PNG hoặc WebP/);
    const huge = Buffer.concat([JPEG, Buffer.alloc(MAX_IMAGE_BYTES)]);
    await expect(saveImage(POST_ID, huge)).rejects.toThrow(/8 MB/);
  });

  it('refuses a post id that is not a UUID (no path tricks)', async () => {
    await expect(saveImage('../../etc/passwd', JPEG)).rejects.toThrow(/Invalid post id/);
  });

  it('never reads or deletes outside storage/images', async () => {
    expect(await readImage('package.json')).toBeNull();
    expect(await readImage('storage/images/../../package.json')).toBeNull();
    await removeImage('package.json');
    expect(existsSync(path.resolve('package.json'))).toBe(true);
  });
});
