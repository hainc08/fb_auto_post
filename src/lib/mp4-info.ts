/**
 * Read duration and display size from an MP4/MOV (ISO-BMFF) header without
 * loading the file: only box headers, mvhd and tkhd are read. Pure; tested
 * with synthetic files (tests/helpers/mp4.ts).
 *
 * Fragmented MP4 (OBS "fMP4", some phone/screen recorders) leaves the mvhd
 * duration at 0; the length then comes from mvex/mehd, or from adding up the
 * video track's sample durations in every moof fragment.
 */

export interface ByteSource {
  size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

export interface VideoInfo {
  durationSec: number;
  width: number;
  height: number;
}

interface Box {
  type: string;
  start: number;
  headerSize: number;
  size: number;
}

export const bufferSource = (buf: Buffer): ByteSource => ({
  size: buf.length,
  read: async (offset, length) => buf.subarray(offset, Math.min(buf.length, offset + length)),
});

/**
 * Real files have a handful of boxes per level (a long fragmented recording a
 * few thousand moof/mdat pairs); a crafted one could have millions.
 */
const MAX_BOXES = 100_000;
/** A trun larger than this is not from a ≤ 100 MB video we can post */
const MAX_TRUN_BYTES = 4 * 1024 * 1024;

async function readBoxes(src: ByteSource, start: number, end: number): Promise<Box[] | null> {
  const boxes: Box[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    if (boxes.length >= MAX_BOXES) return null;
    const head = await src.read(pos, 16);
    if (head.length < 8) return null;
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    let headerSize = 8;
    if (size === 1) {
      if (head.length < 16) return null;
      size = Number(head.readBigUInt64BE(8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos; // box runs to the end of its parent
    }
    if (size < headerSize || pos + size > end) return null; // truncated or corrupt
    boxes.push({ type, start: pos, headerSize, size });
    pos += size;
  }
  return boxes;
}

const find = (boxes: Box[], type: string) => boxes.find((b) => b.type === type);
const children = (src: ByteSource, box: Box) => readBoxes(src, box.start + box.headerSize, box.start + box.size);
const body = (src: ByteSource, box: Box, max: number) => src.read(box.start + box.headerSize, Math.min(box.size - box.headerSize, max));
/** Full-box fields: version is byte 0, flags bytes 1–3 */
const flagsOf = (b: Buffer) => b.readUInt32BE(0) & 0xffffff;

/** Timescale of a track (trak/mdia/mdhd), or null */
async function trackTimescale(src: ByteSource, trak: Box[]): Promise<number | null> {
  const mdia = find(trak, 'mdia');
  const inMdia = mdia && (await children(src, mdia));
  const mdhd = inMdia && find(inMdia, 'mdhd');
  if (!mdhd) return null;
  const b = await body(src, mdhd, 24);
  const at = b[0] === 1 ? 20 : 12;
  return b.length >= at + 4 ? b.readUInt32BE(at) || null : null;
}

/** mvex/mehd: whole-file duration in movie timescale units (0 = absent) */
async function mehdDuration(src: ByteSource, mvex: Box[]): Promise<number> {
  const mehd = find(mvex, 'mehd');
  if (!mehd) return 0;
  const b = await body(src, mehd, 12);
  if (b[0] === 1) return b.length >= 12 ? Number(b.readBigUInt64BE(4)) : 0;
  return b.length >= 8 ? b.readUInt32BE(4) : 0;
}

/** mvex/trex default sample duration for a track */
async function trexDefaultDuration(src: ByteSource, mvex: Box[], trackId: number): Promise<number> {
  for (const trex of mvex.filter((b) => b.type === 'trex')) {
    const b = await body(src, trex, 16);
    if (b.length >= 16 && b.readUInt32BE(4) === trackId) return b.readUInt32BE(12);
  }
  return 0;
}

/** Sum of one track's sample durations over every moof (null = unreadable) */
async function fragmentTicks(src: ByteSource, top: Box[], trackId: number, trexDefault: number): Promise<number | null> {
  let ticks = 0;
  for (const moof of top.filter((b) => b.type === 'moof')) {
    const inMoof = await children(src, moof);
    if (!inMoof) return null;
    for (const traf of inMoof.filter((b) => b.type === 'traf')) {
      const inTraf = await children(src, traf);
      const tfhd = inTraf && find(inTraf, 'tfhd');
      if (!inTraf || !tfhd) return null;
      const h = await body(src, tfhd, 32);
      if (h.length < 8 || h.readUInt32BE(4) !== trackId) continue;
      const hf = flagsOf(h);
      let dflt = trexDefault;
      if (hf & 0x08) {
        const at = 8 + (hf & 0x01 ? 8 : 0) + (hf & 0x02 ? 4 : 0);
        if (h.length < at + 4) return null;
        dflt = h.readUInt32BE(at);
      }
      for (const trun of inTraf.filter((b) => b.type === 'trun')) {
        if (trun.size - trun.headerSize > MAX_TRUN_BYTES) return null;
        const t = await body(src, trun, MAX_TRUN_BYTES);
        if (t.length < 8) return null;
        const tf = flagsOf(t);
        const count = t.readUInt32BE(4);
        if (!(tf & 0x100)) {
          ticks += count * dflt;
          continue;
        }
        let at = 8 + (tf & 0x01 ? 4 : 0) + (tf & 0x04 ? 4 : 0);
        const stride = 4 * [0x100, 0x200, 0x400, 0x800].filter((bit) => tf & bit).length;
        if (t.length < at + count * stride) return null;
        for (let i = 0; i < count; i++, at += stride) ticks += t.readUInt32BE(at);
      }
    }
  }
  return ticks;
}

export async function inspectMp4(src: ByteSource): Promise<VideoInfo | null> {
  const top = await readBoxes(src, 0, src.size);
  if (!top || top[0]?.type !== 'ftyp') return null;
  const moov = find(top, 'moov');
  if (!moov) return null;
  const inMoov = await readBoxes(src, moov.start + moov.headerSize, moov.start + moov.size);
  const mvhd = inMoov && find(inMoov, 'mvhd');
  if (!inMoov || !mvhd) return null;

  const mv = await src.read(mvhd.start + mvhd.headerSize, 32);
  if (mv.length < 32) return null;
  const v1 = mv[0] === 1;
  const timescale = v1 ? mv.readUInt32BE(20) : mv.readUInt32BE(12);
  const duration = v1 ? Number(mv.readBigUInt64BE(24)) : mv.readUInt32BE(16);
  if (!timescale) return null;

  for (const trak of inMoov.filter((b) => b.type === 'trak')) {
    const inTrak = await children(src, trak);
    const tkhd = inTrak && find(inTrak, 'tkhd');
    if (!inTrak || !tkhd) continue;
    const tk = await body(src, tkhd, 92); // v1 tkhd body is 92 bytes
    const matrixAt = tk[0] === 1 ? 52 : 40;
    if (tk.length < matrixAt + 44) continue;
    const w = tk.readUInt32BE(matrixAt + 36) / 65536;
    const h = tk.readUInt32BE(matrixAt + 40) / 65536;
    if (!w || !h) continue; // audio track
    // matrix[1] ≠ 0 ⇒ rotated 90°/270° (phones record portrait this way)
    const rotated = tk.readInt32BE(matrixAt + 4) !== 0;

    let seconds = duration / timescale;
    const mvex = find(inMoov, 'mvex');
    const inMvex = mvex && (await children(src, mvex));
    if (inMvex) {
      // Fragmented MP4: mehd if the writer filled it; otherwise mvhd only covers
      // the samples inside moov (often none), so add the fragments' samples
      const mehd = (await mehdDuration(src, inMvex)) / timescale;
      if (mehd) seconds = mehd;
      else {
        const trackId = tk.readUInt32BE(tk[0] === 1 ? 20 : 12);
        const ticks = await fragmentTicks(src, top, trackId, await trexDefaultDuration(src, inMvex, trackId));
        const trackScale = (await trackTimescale(src, inTrak)) ?? timescale;
        if (ticks) seconds += ticks / trackScale;
      }
    }
    return {
      durationSec: Math.round(seconds * 10) / 10,
      width: Math.round(rotated ? h : w),
      height: Math.round(rotated ? w : h),
    };
  }
  return null;
}

/** Why this video can't be a Reel (null = fine). Meta: vertical, ≥ 540×960, 3–90 s. */
export function reelsProblem(info: VideoInfo): string | null {
  if (info.width >= info.height) return `Reels cần video dọc 9:16 (video này ${info.width}×${info.height}).`;
  if (info.width < 540 || info.height < 960) return `Reels cần độ phân giải tối thiểu 540×960 (video này ${info.width}×${info.height}).`;
  if (info.durationSec < 3 || info.durationSec > 90) return `Reels cần dài 3–90 giây (video này ${info.durationSec} giây).`;
  return null;
}
