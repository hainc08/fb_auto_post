import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ffmpegAvailable, reelRenderer } from '../src/lib/reel/render';
import { buildAss, buildLines } from '../src/lib/reel/subtitles';
import { inspectMp4, reelsProblem } from '../src/lib/mp4-info';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;
const dir = mkdtempSync(path.join(os.tmpdir(), 'reel-render-test-'));

async function inspect(file: string) {
  const { size } = await stat(file);
  const f = await open(file, 'r');
  try {
    return await inspectMp4({
      size,
      read: async (offset, length) => {
        const buf = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
        if (buf.length) await f.read(buf, 0, buf.length, offset);
        return buf;
      },
    });
  } finally {
    await f.close();
  }
}

const ass = buildAss(buildLines([{ text: 'Xin', startMs: 0, durationMs: 400 }, { text: 'chào', startMs: 400, durationMs: 400 }, { text: 'Việt', startMs: 1200, durationMs: 400 }, { text: 'Nam!', startMs: 1600, durationMs: 400 }]), { withImage: false });

describe.skipIf(!hasFfmpeg)('reelRenderer (needs FFmpeg)', { timeout: 120_000 }, () => {
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // 4 seconds of tone as the "voice", and a square picture
  const voice = path.join(dir, 'voice.mp3');
  const picture = path.join(dir, 'picture.png');
  const fixtures = () => {
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:a', 'libmp3lame', voice]);
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=640x640:d=1', '-frames:v', '1', picture]);
  };

  it('finds FFmpeg', async () => {
    expect(await ffmpegAvailable()).toBe(true);
  });

  it('renders a vertical video as long as the voice, with and without a picture', async () => {
    fixtures();
    for (const [name, image] of [['plain', null], ['picture', { buffer: readFileSync(picture), mime: 'image/png' as const }]] as const) {
      const outPath = path.join(dir, `${name}.mp4`);
      await reelRenderer.render({ audio: readFileSync(voice), ass, image, outPath });
      const info = await inspect(outPath);
      expect(info).toMatchObject({ width: 1080, height: 1920 });
      expect(info!.durationSec).toBeGreaterThanOrEqual(3.5);
      expect(info!.durationSec).toBeLessThanOrEqual(4.6);
      expect(reelsProblem(info!)).toBeNull();
    }
  });

  it('leaves no work folder behind and says why it failed', async () => {
    const before = readdirSync(os.tmpdir()).filter((n) => n.startsWith('autopost-reel-')).length;
    await expect(reelRenderer.render({ audio: Buffer.from('not audio'), ass, outPath: path.join(dir, 'bad.mp4') })).rejects.toThrow(/Dựng video thất bại/);
    expect(readdirSync(os.tmpdir()).filter((n) => n.startsWith('autopost-reel-')).length).toBe(before);
  });
});
