import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { ImageMime } from '../image-store';
import { buildAss, DEFAULT_REEL_FONT } from './subtitles';

/**
 * Renders a Reel with FFmpeg: the voice + karaoke subtitles over the post's picture (blurred to fill 9:16,
 * the picture itself on top), or over a plain dark ground when there is no picture.
 *
 * FFmpeg is the binary shipped by the npm package `ffmpeg-static` (FFMPEG_PATH overrides it), so the
 * production host needs nothing installed. The subtitle font is assets/fonts/BeVietnamPro-Bold.ttf.
 */

/** `ffmpeg-static` is an optional dependency: when its download failed at install time the package is absent */
function bundledFfmpeg(): string | null {
  return createRequire(path.join(process.cwd(), 'package.json'))('ffmpeg-static') as string | null;
}

/** FFMPEG_PATH, else the binary shipped by ffmpeg-static, else "ffmpeg" on PATH (the feature hides itself when none runs) */
export function ffmpegPath(env: string | undefined = process.env.FFMPEG_PATH, bundled: () => string | null = bundledFfmpeg): string {
  if (env) return env;
  try {
    return bundled() || 'ffmpeg';
  } catch {
    return 'ffmpeg';
  }
}

const FFMPEG = ffmpegPath();
const RENDER_TIMEOUT_MS = 180_000;
/**
 * The shared host has 64 cores and a per-account limit: libx264 with default threads cannot start there.
 * Every decoder, filter graph and encoder is held to 2 threads.
 */
const THREADS = ['-threads', '2'];
const FILTER_THREADS = ['-filter_threads', '2', '-filter_complex_threads', '2'];
const EXT: Record<ImageMime, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const REEL_FONT_FILE = path.resolve(process.cwd(), 'assets', 'fonts', 'BeVietnamPro-Bold.ttf');
/** How libass names the bundled font once it has picked it */
export const REEL_FONT_NAME = path.basename(REEL_FONT_FILE, path.extname(REEL_FONT_FILE));

/**
 * The font libass chose, from its log line "fontselect: (Family, 700, 0) -> <name or file>, 0, <PostScript name>".
 * libass versions differ in what comes first after "->"; the bundled font is recognised in either form.
 */
export function selectedFont(log: string): string | null {
  const line = /fontselect: \([^)]*\) -> ([^\r\n]+)/.exec(log)?.[1];
  if (!line) return null;
  return line.includes(REEL_FONT_NAME) ? REEL_FONT_NAME : line.split(',')[0].trim();
}

function run(args: string[], cwd?: string, onStdout?: (text: string) => void, loglevel = 'error'): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(FFMPEG, ['-y', '-hide_banner', '-loglevel', loglevel, ...args], { cwd, timeout: RENDER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, _out, stderr) =>
      error ? reject(new Error(error.killed ? 'quá thời gian cho phép.' : String(stderr || error.message).trim().split('\n').pop())) : resolve(String(stderr))
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

/** "ffmpeg version 7.0.2-static …", or null when FFmpeg cannot run */
export function ffmpegVersion(): Promise<string | null> {
  return new Promise((resolve) => execFile(FFMPEG, ['-version'], { timeout: 10_000 }, (error, out) => resolve(error ? null : String(out).split('\n')[0].trim())));
}

/**
 * A private work folder. File names inside it are relative (cwd): a Windows drive colon would need
 * escaping inside an FFmpeg filter. The bundled font is copied in so libass finds it through `fontsdir`.
 */
async function workDir(): Promise<{ dir: string; assFilter: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'autopost-reel-'));
  if (!existsSync(REEL_FONT_FILE)) return { dir, assFilter: 'ass=subs.ass' };
  await mkdir(path.join(dir, 'fonts'));
  await copyFile(REEL_FONT_FILE, path.join(dir, 'fonts', path.basename(REEL_FONT_FILE)));
  return { dir, assFilter: 'ass=subs.ass:fontsdir=fonts' };
}

/**
 * Which font file libass picks for the subtitles ("BeVietnamPro-Bold" when the bundled font is used);
 * null when FFmpeg or its subtitle filter does not work. One frame, a fraction of a second.
 */
export async function probeSubtitleFont(font = DEFAULT_REEL_FONT): Promise<string | null> {
  const { dir, assFilter } = await workDir();
  try {
    await writeFile(path.join(dir, 'subs.ass'), buildAss([[{ text: 'Tiếng Việt', startMs: 0, durationMs: 1000 }]], { withImage: false, font }), 'utf8');
    const log = await run([...FILTER_THREADS, '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:r=30', '-vf', assFilter, ...THREADS, '-frames:v', '1', '-f', 'null', '-'], dir, undefined, 'verbose');
    return selectedFont(log);
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface RenderScene {
  /** The scene's picture; null = a plain dark ground */
  image: { buffer: Buffer; mime: ImageMime } | null;
  /** When the voice reaches the scene, from the start of the audio */
  startMs: number;
}

/** The picture on a blurred, darkened copy of itself that fills 9:16 */
const GROUND_FILTER =
  '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:4,eq=brightness=-0.28[bg];[0:v]scale=960:-2[fg];[bg][fg]overlay=(W-w)/2:200';

async function render(input: {
  audio: Buffer;
  ass: string;
  /** One still per scene, shown from its start to the next scene's (default: one scene with `image`) */
  scenes?: RenderScene[];
  image?: { buffer: Buffer; mime: ImageMime } | null;
  outPath: string;
  /** Length of the voice; with `onProgress`, the encoded share (0–1) is reported as the video is written */
  durationMs?: number;
  onProgress?: (fraction: number) => void;
}): Promise<void> {
  const scenes: RenderScene[] = input.scenes?.length ? input.scenes : [{ image: input.image ?? null, startMs: 0 }];
  const { dir, assFilter } = await workDir();
  try {
    await writeFile(path.join(dir, 'voice.mp3'), input.audio);
    await writeFile(path.join(dir, 'subs.ass'), input.ass, 'utf8');

    // One still ground per distinct picture: scenes sharing a picture (or having none) share the file.
    // Made once each; blurring every frame of the video would be far slower.
    const grounds = new Map<Buffer | null, string>();
    for (const scene of scenes) {
      const key = scene.image?.buffer ?? null;
      if (grounds.has(key)) continue;
      const n = grounds.size;
      const ground = `ground${n}.png`;
      if (scene.image) {
        const picture = `picture${n}.${EXT[scene.image.mime]}`;
        await writeFile(path.join(dir, picture), scene.image.buffer);
        await run([...FILTER_THREADS, ...THREADS, '-i', picture, '-filter_complex', GROUND_FILTER, ...THREADS, '-frames:v', '1', ground], dir);
      } else {
        await run([...FILTER_THREADS, '-f', 'lavfi', '-i', 'color=c=0x17191F:s=1080x1920', ...THREADS, '-frames:v', '1', ground], dir);
      }
      grounds.set(key, ground);
    }

    // Each scene is its still for as long as it lasts; the last one runs until the voice ends (-shortest)
    const stills = scenes.flatMap((scene, i) => {
      const next = scenes[i + 1];
      const seconds = next ? Math.max(0.1, (next.startMs - scene.startMs) / 1000) : 3600;
      return ['-loop', '1', '-framerate', '30', '-t', seconds.toFixed(3), '-i', grounds.get(scene.image?.buffer ?? null)!];
    });
    const graph =
      scenes.length > 1
        ? `${scenes.map((_, i) => `[${i}:v]`).join('')}concat=n=${scenes.length}:v=1:a=0,${assFilter}[v]`
        : `[0:v]${assFilter}[v]`;

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
      [...(report ? ['-progress', 'pipe:1', '-nostats'] : []), ...FILTER_THREADS, ...stills, '-i', 'voice.mp3',
        '-filter_complex', graph, '-map', '[v]', '-map', `${scenes.length}:a`,
        ...THREADS, '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '160k',
        '-shortest', '-movflags', '+faststart', 'reel.mp4'],
      dir,
      report
    );
    await copyFile(path.join(dir, 'reel.mp4'), input.outPath);
  } catch (error) {
    throw new Error(`Dựng video thất bại: ${(error as Error).message}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** A small generated picture (PNG), for the host self-check: the picture path is the one most posts take */
export async function samplePicture(): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'autopost-reel-'));
  try {
    await run([...FILTER_THREADS, '-f', 'lavfi', '-i', 'gradients=s=640x640:c0=0x2447C4:c1=0xF2B84B', ...THREADS, '-frames:v', '1', 'sample.png'], dir);
    return await readFile(path.join(dir, 'sample.png'));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** An object, so tests (and another renderer, e.g. Remotion) replace `render` */
export const reelRenderer = { render };
