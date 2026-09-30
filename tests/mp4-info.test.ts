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
    expect(await inspectMp4(bufferSource(tinyMp4({ durationSec: 5, width: 1080, height: 1920, moovAtEnd: true })))).toMatchObject({
      durationSec: 5,
    });
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
