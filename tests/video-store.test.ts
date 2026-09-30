import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { VIDEO_TMP_DIR, detectVideoMime, openVideo, removeVideo, resolveVideo, saveUploadedVideo, sweepVideoTmp } from '../src/lib/video-store';
import { tinyMp4 } from './helpers/mp4';

async function tmpFile(content: Buffer) {
  await mkdir(VIDEO_TMP_DIR, { recursive: true });
  const p = path.join(VIDEO_TMP_DIR, `vs-${randomUUID()}.upload`); // prefix: not counted as an upload by videos.db tests
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

  it('sweeps temp uploads older than an hour and keeps recent ones', async () => {
    const old = await tmpFile(Buffer.from('partial'));
    const fresh = await tmpFile(Buffer.from('in progress'));
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(old, twoHoursAgo, twoHoursAgo);
    await sweepVideoTmp();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    await unlink(fresh);
  });
});
