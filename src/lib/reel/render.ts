import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ImageMime } from '../image-store';

/**
 * Renders a Reel with the FFmpeg program installed on the machine (FFMPEG_PATH, default "ffmpeg" on PATH):
 * the voice + karaoke subtitles over the post's picture (blurred to fill 9:16, the picture itself on top),
 * or over a plain dark ground when there is no picture.
 */

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const RENDER_TIMEOUT_MS = 180_000;
const EXT: Record<ImageMime, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function run(args: string[], cwd?: string, onStdout?: (text: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { cwd, timeout: RENDER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, _out, stderr) =>
      error ? reject(new Error(String(stderr || error.message).trim().split('\n').pop())) : resolve()
    );
    if (onStdout) child.stdout?.on('data', (chunk) => onStdout(String(chunk)));
  });
}

/** `-progress pipe:1` prints "out_time_us=<microseconds encoded so far>" about twice a second */
function encodedMs(text: string): number | null {
  const marks = [...text.matchAll(/out_time_(?:us|ms)=(\d+)/g)];
  return marks.length ? Number(marks[marks.length - 1][1]) / 1000 : null;
}

export function ffmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => execFile(FFMPEG, ['-version'], { timeout: 10_000 }, (error) => resolve(!error)));
}

async function render(input: {
  audio: Buffer;
  ass: string;
  image?: { buffer: Buffer; mime: ImageMime } | null;
  outPath: string;
  /** Length of the voice; with `onProgress`, the encoded share (0–1) is reported as the video is written */
  durationMs?: number;
  onProgress?: (fraction: number) => void;
}): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'autopost-reel-'));
  try {
    await writeFile(path.join(dir, 'voice.mp3'), input.audio);
    await writeFile(path.join(dir, 'subs.ass'), input.ass, 'utf8');

    // File names are relative to `dir` (cwd): a Windows drive colon would need escaping inside the filter
    let video: string[];
    if (input.image) {
      const picture = `picture.${EXT[input.image.mime]}`;
      await writeFile(path.join(dir, picture), input.image.buffer);
      // The still ground is made once; blurring every frame of the video would be far slower
      await run(
        ['-i', picture, '-filter_complex',
          '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:4,eq=brightness=-0.28[bg];[0:v]scale=960:-2[fg];[bg][fg]overlay=(W-w)/2:200',
          '-frames:v', '1', 'ground.png'],
        dir
      );
      video = ['-loop', '1', '-framerate', '30', '-i', 'ground.png'];
    } else {
      video = ['-f', 'lavfi', '-i', 'color=c=0x17191F:s=1080x1920:r=30'];
    }
    const { durationMs, onProgress } = input;
    let reported = 0;
    const report =
      durationMs && onProgress
        ? (text: string) => {
            const ms = encodedMs(text);
            if (ms === null) return;
            // never backwards, never past the end
            reported = Math.max(reported, Math.min(1, ms / durationMs));
            onProgress(reported);
          }
        : undefined;
    await run(
      [...(report ? ['-progress', 'pipe:1', '-nostats'] : []), ...video, '-i', 'voice.mp3', '-vf', 'ass=subs.ass',
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '160k',
        '-shortest', '-movflags', '+faststart', 'reel.mp4'],
      dir,
      report
    );
    await copyFile(path.join(dir, 'reel.mp4'), input.outPath);
  } catch (error) {
    throw new Error(`Dựng video thất bại: ${(error as Error).message}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** An object, so tests (and another renderer, e.g. Remotion) replace `render` */
export const reelRenderer = { render };
