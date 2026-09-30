/**
 * A minimal ISO-BMFF file (ftyp + mdat + moov/mvhd/trak/tkhd) — enough for inspectMp4.
 * `fragments` builds a fragmented MP4 instead (mvhd duration 0, mvex, moof/traf/trun
 * per fragment, as OBS fMP4 writes), with the length in mehd when `mehd` is set.
 */
const box = (type: string, ...parts: Buffer[]) => {
  const payload = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
};

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};

export function tinyMp4(opts: {
  durationSec: number;
  width: number;
  height: number;
  rotate90?: boolean;
  moovAtEnd?: boolean;
  brand?: string;
  fragments?: number;
  mehd?: boolean;
}): Buffer {
  if (opts.fragments) return fragmentedMp4(opts as Required<Pick<typeof opts, 'fragments'>> & typeof opts);
  const ftyp = box('ftyp', Buffer.from((opts.brand ?? 'isom').padEnd(4).slice(0, 4), 'latin1'), u32(512), Buffer.from('isomiso2mp41', 'latin1'));
  const timescale = 1000;
  // mvhd v0: version/flags, ctime, mtime, timescale, duration, then 80 bytes we don't read
  const mvhd = box('mvhd', u32(0), u32(0), u32(0), u32(timescale), u32(Math.round(opts.durationSec * timescale)), Buffer.alloc(80));
  const identity = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  const rotated = [0, 0x00010000, 0, 0xffff0000, 0, 0, 0, 0, 0x40000000];
  const matrix = Buffer.concat((opts.rotate90 ? rotated : identity).map(u32));
  // tkhd v0 (flags=3): ctime, mtime, trackId, reserved, duration, reserved(8), layer/altGroup/volume/reserved(8), matrix, width, height
  const tkhd = box(
    'tkhd',
    u32(3),
    u32(0),
    u32(0),
    u32(1),
    u32(0),
    u32(Math.round(opts.durationSec * timescale)),
    Buffer.alloc(8),
    Buffer.alloc(8),
    matrix,
    u32(opts.width * 65536),
    u32(opts.height * 65536)
  );
  const audioTkhd = box('tkhd', u32(3), u32(0), u32(0), u32(2), u32(0), u32(0), Buffer.alloc(16), Buffer.concat(identity.map(u32)), u32(0), u32(0));
  const moov = box('moov', mvhd, box('trak', audioTkhd), box('trak', tkhd));
  const mdat = box('mdat', Buffer.alloc(64, 7));
  return opts.moovAtEnd ? Buffer.concat([ftyp, mdat, moov]) : Buffer.concat([ftyp, moov, mdat]);
}

/** Video track timescale 90 kHz (as ffmpeg/OBS), 30 fps → 3000 ticks per sample */
const VIDEO_SCALE = 90_000;
const SAMPLE_TICKS = 3000;

function fragmentedMp4(opts: { durationSec: number; width: number; height: number; fragments: number; mehd?: boolean }): Buffer {
  const ftyp = box('ftyp', Buffer.from('iso5', 'latin1'), u32(512), Buffer.from('iso5iso6mp41', 'latin1'));
  const mvhd = box('mvhd', u32(0), u32(0), u32(0), u32(1000), u32(0), Buffer.alloc(80));
  const identity = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32);
  const tkhd = (trackId: number, w: number, h: number) =>
    box('tkhd', u32(3), u32(0), u32(0), u32(trackId), u32(0), u32(0), Buffer.alloc(16), ...identity, u32(w * 65536), u32(h * 65536));
  const mdhd = (scale: number) => box('mdhd', u32(0), u32(0), u32(0), u32(scale), u32(0), u32(0));
  const video = box('trak', tkhd(1, opts.width, opts.height), box('mdia', mdhd(VIDEO_SCALE)));
  const audio = box('trak', tkhd(2, 0, 0), box('mdia', mdhd(48_000)));
  // trex: version/flags, track_ID, default_sample_description_index, default_sample_duration, size, flags
  const trex = (trackId: number, dur: number) => box('trex', u32(0), u32(trackId), u32(1), u32(dur), u32(0), u32(0));
  const mvex = box(
    'mvex',
    ...(opts.mehd ? [box('mehd', u32(0), u32(Math.round(opts.durationSec * 1000)))] : []),
    trex(1, SAMPLE_TICKS),
    trex(2, 1024)
  );
  const moov = box('moov', mvhd, audio, video, mvex);

  const total = Math.round((opts.durationSec * VIDEO_SCALE) / SAMPLE_TICKS);
  const parts: Buffer[] = [ftyp, moov];
  for (let f = 0; f < opts.fragments; f++) {
    const count = Math.floor(total / opts.fragments) + (f < total % opts.fragments ? 1 : 0);
    // Even fragments: per-sample durations (0x100) + sizes (0x200) after a data offset (0x01);
    // odd fragments: no per-sample durations, so the trex default applies
    const trun =
      f % 2 === 0
        ? box('trun', u32(0x000301), u32(count), u32(0), ...Array.from({ length: count }, () => [u32(SAMPLE_TICKS), u32(10)]).flat())
        : box('trun', u32(0x000200), u32(count), ...Array.from({ length: count }, () => u32(10)));
    const videoTraf = box('traf', box('tfhd', u32(0x020000), u32(1)), trun);
    // An audio fragment with big durations that must not be counted
    const audioTraf = box('traf', box('tfhd', u32(0x020008), u32(2), u32(999_999)), box('trun', u32(0), u32(50)));
    parts.push(box('moof', box('mfhd', u32(0), u32(f + 1)), audioTraf, videoTraf), box('mdat', Buffer.alloc(16, 7)));
  }
  return Buffer.concat(parts);
}
