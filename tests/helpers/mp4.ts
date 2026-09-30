/** A minimal ISO-BMFF file (ftyp + mdat + moov/mvhd/trak/tkhd) — enough for inspectMp4. */
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

export function tinyMp4(opts: { durationSec: number; width: number; height: number; rotate90?: boolean; moovAtEnd?: boolean; brand?: string }): Buffer {
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
