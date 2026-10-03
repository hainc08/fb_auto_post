import { randomUUID } from 'node:crypto';
import { open, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { edgeTts } from './edge-tts';
import * as renderer from './render';
import { buildAss, buildLines, displayWords } from './subtitles';
import { inspectMp4, reelsProblem } from '../mp4-info';

/**
 * "Can this host make Reels?" — run after a deploy (GET /cron/reel-check). Makes one short sample with the
 * real voice service and the real FFmpeg, touches no post and no database row, and reports every step,
 * so a failure says what is missing (FFmpeg, the font, the voice service, the encoder).
 */

export interface ReelCheck {
  ok: boolean;
  problems: string[];
  ffmpeg: string | null;
  /** Font file libass picked for the subtitles; "BeVietnamPro-Bold" when the bundled font is used */
  font: string | null;
  voice: { ms: number; words: number; bytes: number } | null;
  render: { ms: number; durationSec: number; width: number; height: number; bytes: number } | null;
  /** The sample video */
  file: Buffer | null;
}

const SAMPLE = 'Xin chào, đây là video thử của Auto Post. Phụ đề tiếng Việt có dấu đầy đủ: ă, â, ê, ô, ơ, ư, đ.';

async function inspectFile(file: string) {
  const { size } = await stat(file);
  const handle = await open(file, 'r');
  try {
    return await inspectMp4({
      size,
      read: async (offset, length) => {
        const buf = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
        if (buf.length) await handle.read(buf, 0, buf.length, offset);
        return buf;
      },
    });
  } finally {
    await handle.close();
  }
}

export async function reelSelfCheck(): Promise<ReelCheck> {
  const check: ReelCheck = { ok: false, problems: [], ffmpeg: null, font: null, voice: null, render: null, file: null };

  check.ffmpeg = await renderer.ffmpegVersion();
  if (!check.ffmpeg) check.problems.push('FFmpeg: không chạy được (gói ffmpeg-static chưa tải được file, hoặc máy chủ không cho chạy).');

  if (check.ffmpeg) {
    check.font = await renderer.probeSubtitleFont();
    if (!check.font) check.problems.push('Phụ đề: FFmpeg không dựng được phụ đề (thiếu libass).');
    else if (check.font !== renderer.REEL_FONT_NAME) check.problems.push(`Phụ đề: đang dùng font "${check.font}" thay vì Be Vietnam Pro (thiếu thư mục assets/fonts?).`);
  }

  let speech: Awaited<ReturnType<typeof edgeTts.synthesize>> | null = null;
  const voiceStart = Date.now();
  try {
    speech = await edgeTts.synthesize(SAMPLE, 'vi-VN-HoaiMyNeural');
    check.voice = { ms: Date.now() - voiceStart, words: speech.words.length, bytes: speech.audio.length };
    if (!speech.words.length) check.problems.push('Giọng đọc: dịch vụ không trả về mốc thời gian của từng từ.');
  } catch (error) {
    check.problems.push(`Giọng đọc: ${(error as Error).message}`);
  }

  if (check.ffmpeg && speech?.words.length) {
    const out = path.join(os.tmpdir(), `autopost-reel-check-${randomUUID()}.mp4`);
    const renderStart = Date.now();
    try {
      // With a picture, like most posts: decoding, blurring and overlaying are FFmpeg steps of their own
      const image = { buffer: await renderer.samplePicture(), mime: 'image/png' as const };
      const ass = buildAss(buildLines(displayWords(SAMPLE, speech.words)), { withImage: true });
      await renderer.reelRenderer.render({ audio: speech.audio, ass, image, outPath: out });
      const info = await inspectFile(out);
      if (!info) throw new Error('file dựng ra không phải MP4 hợp lệ.');
      check.file = await readFile(out);
      check.render = { ms: Date.now() - renderStart, ...info, bytes: check.file.length };
      const problem = reelsProblem(info);
      if (problem) check.problems.push(`Video: ${problem}`);
    } catch (error) {
      check.problems.push(`Dựng video: ${(error as Error).message}`);
    } finally {
      await rm(out, { force: true }).catch(() => {});
    }
  }

  check.ok = check.problems.length === 0;
  return check;
}
