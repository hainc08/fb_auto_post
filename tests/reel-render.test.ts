import { describe, it, expect, afterAll, vi } from 'vitest';
import { edgeTts } from '../src/lib/reel/edge-tts';
import { reelSelfCheck } from '../src/lib/reel/self-check';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ffmpegAvailable, reelRenderer } from '../src/lib/reel/render';
import { buildAss, buildLines } from '../src/lib/reel/subtitles';
import { inspectMp4, reelsProblem } from '../src/lib/mp4-info';

import { existsSync } from 'node:fs';
import { ffmpegPath, ffmpegVersion, probeSubtitleFont, REEL_FONT_FILE, selectedFont } from '../src/lib/reel/render';

const FFMPEG = ffmpegPath();
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

describe('which FFmpeg, which font (no FFmpeg needed)', () => {
  it('FFMPEG_PATH wins; else the bundled binary; else "ffmpeg" on PATH', () => {
    expect(ffmpegPath('/opt/ffmpeg', () => '/bundled/ffmpeg')).toBe('/opt/ffmpeg');
    expect(ffmpegPath(undefined, () => '/bundled/ffmpeg')).toBe('/bundled/ffmpeg');
    expect(ffmpegPath('', () => null)).toBe('ffmpeg');
  });

  it('a build where the optional ffmpeg-static package is missing still starts', () => {
    expect(
      ffmpegPath(undefined, () => {
        throw new Error("Cannot find module 'ffmpeg-static'");
      })
    ).toBe('ffmpeg');
  });

  it('reads the chosen font from either form of the libass log line', () => {
    expect(selectedFont('[Parsed_ass_0 @ 0x1] fontselect: (Be Vietnam Pro, 700, 0) -> BeVietnamPro-Bold, 0, BeVietnamPro-Bold\n')).toBe('BeVietnamPro-Bold');
    expect(selectedFont('[Parsed_ass_0 @ 0x1] fontselect: (Be Vietnam Pro, 700, 0) -> fonts/BeVietnamPro-Bold.ttf, 0, BeVietnamPro-Bold\n')).toBe('BeVietnamPro-Bold');
    expect(selectedFont('fontselect: (Be Vietnam Pro, 700, 0) -> /usr/share/fonts/DejaVuSans-Bold.ttf, 0, DejaVuSans-Bold')).toBe('/usr/share/fonts/DejaVuSans-Bold.ttf');
    expect(selectedFont('no font lines here')).toBeNull();
  });
});

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

  it('uses the FFmpeg the app ships with', async () => {
    expect(ffmpegPath(undefined)).toMatch(/ffmpeg-static/);
    expect(await ffmpegVersion()).toMatch(/^ffmpeg version \S+/);
  });

  it('finds the bundled font and uses it for Vietnamese subtitles', async () => {
    expect(existsSync(REEL_FONT_FILE)).toBe(true);
    expect(await probeSubtitleFont()).toBe('BeVietnamPro-Bold');
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

  /** Average colour of the frame at `seconds` */
  const colourAt = (file: string, seconds: number) => {
    const rgb = execFileSync(FFMPEG, ['-loglevel', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    return { r: rgb[0], g: rgb[1], b: rgb[2] };
  };
  const solid = (colour: string) => {
    const file = path.join(dir, `${colour}.png`);
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${colour}:s=640x640`, '-frames:v', '1', file]);
    return { buffer: readFileSync(file), mime: 'image/png' as const };
  };

  it('shows each scene\'s picture from its start time, then the next one', async () => {
    fixtures();
    const outPath = path.join(dir, 'scenes.mp4');
    const red = solid('red');
    await reelRenderer.render({
      audio: readFileSync(voice),
      ass,
      outPath,
      scenes: [
        { image: red, startMs: 0 },
        { image: solid('green'), startMs: 1500 },
        { image: null, startMs: 2600 },
        // the same picture again: its ground is made once
        { image: red, startMs: 3300 },
      ],
    });
    const info = await inspect(outPath);
    expect(info).toMatchObject({ width: 1080, height: 1920 });
    expect(info!.durationSec).toBeGreaterThanOrEqual(3.5);
    expect(info!.durationSec).toBeLessThanOrEqual(4.6);
    const first = colourAt(outPath, 0.7);
    expect(first.r).toBeGreaterThan(first.g + 40);
    const second = colourAt(outPath, 2.0);
    expect(second.g).toBeGreaterThan(second.r + 40);
    const third = colourAt(outPath, 2.95);
    expect(Math.max(third.r, third.g, third.b)).toBeLessThan(70);
    const fourth = colourAt(outPath, 3.7);
    expect(fourth.r).toBeGreaterThan(fourth.g + 40);
  });

  it('reports how far the encoding is, up to the end', async () => {
    fixtures();
    const seen: number[] = [];
    await reelRenderer.render({ audio: readFileSync(voice), ass, outPath: path.join(dir, 'progress.mp4'), durationMs: 4000, onProgress: (f) => seen.push(f) });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((f) => f >= 0 && f <= 1)).toBe(true);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(seen[seen.length - 1]).toBeGreaterThanOrEqual(0.9);
  });

  it('self-check: renders a sample and reports every step', async () => {
    fixtures();
    vi.spyOn(edgeTts, 'synthesize').mockResolvedValue({
      audio: readFileSync(voice),
      words: ['Xin', 'chào', 'đây', 'là', 'video', 'thử'].map((text, i) => ({ text, startMs: i * 600, durationMs: 500 })),
    });
    const render = vi.spyOn(reelRenderer, 'render');
    const check = await reelSelfCheck();
    // the sample has a picture: that path (decode, blur, overlay) is the one most posts take
    expect(render.mock.calls[0][0].image).toMatchObject({ mime: 'image/png' });
    expect(render.mock.calls[0][0].ass).toMatch(/,2,80,80,430,1$/m);
    expect(check.problems).toEqual([]);
    expect(check).toMatchObject({ ok: true, font: 'BeVietnamPro-Bold', voice: { words: 6 }, render: { width: 1080, height: 1920 } });
    expect(check.ffmpeg).toMatch(/^ffmpeg version/);
    expect(check.file!.subarray(4, 8).toString()).toBe('ftyp');
  });

  it('self-check: says which step failed and goes on with the others', async () => {
    vi.spyOn(edgeTts, 'synthesize').mockRejectedValue(new Error('Dịch vụ giọng đọc từ chối kết nối (HTTP 403).'));
    const check = await reelSelfCheck();
    expect(check.ok).toBe(false);
    expect(check.problems).toEqual(['Giọng đọc: Dịch vụ giọng đọc từ chối kết nối (HTTP 403).']);
    expect(check).toMatchObject({ font: 'BeVietnamPro-Bold', voice: null, render: null, file: null });
  });

  it('leaves no work folder behind and says why it failed', async () => {
    const before = readdirSync(os.tmpdir()).filter((n) => n.startsWith('autopost-reel-')).length;
    await expect(reelRenderer.render({ audio: Buffer.from('not audio'), ass, outPath: path.join(dir, 'bad.mp4') })).rejects.toThrow(/Dựng video thất bại/);
    expect(readdirSync(os.tmpdir()).filter((n) => n.startsWith('autopost-reel-')).length).toBe(before);
  });
});
