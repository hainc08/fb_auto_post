/**
 * Read duration and display size from an MP4/MOV (ISO-BMFF) header without
 * loading the file: only box headers, mvhd and tkhd are read. Pure; tested
 * with synthetic files (tests/helpers/mp4.ts).
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

/** Real files have a handful of boxes per level; a crafted one could have millions */
const MAX_BOXES = 10_000;

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
    const inTrak = await readBoxes(src, trak.start + trak.headerSize, trak.start + trak.size);
    const tkhd = inTrak && find(inTrak, 'tkhd');
    if (!tkhd) continue;
    const body = await src.read(tkhd.start + tkhd.headerSize, Math.min(tkhd.size - tkhd.headerSize, 92)); // v1 tkhd body is 92 bytes
    const matrixAt = body[0] === 1 ? 52 : 40;
    if (body.length < matrixAt + 44) continue;
    const w = body.readUInt32BE(matrixAt + 36) / 65536;
    const h = body.readUInt32BE(matrixAt + 40) / 65536;
    if (!w || !h) continue; // audio track
    // matrix[1] ≠ 0 ⇒ rotated 90°/270° (phones record portrait this way)
    const rotated = body.readInt32BE(matrixAt + 4) !== 0;
    return {
      durationSec: Math.round((duration / timescale) * 10) / 10,
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
