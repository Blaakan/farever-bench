// ---------------------------------------------------------------------------
// Copied from Blaakan/farever-mods (tools/lib/hbson.mjs), MIT - the reader
// only; the node walker that file also carries is map tooling and stays there.
//
// hbson.mjs - reader for the container Heaps/hide prefabs ship in.
//
// The name is the game's own: `hxd.fmt.hbson.Reader` appears in the bytecode
// string table. The format was reversed from the shipped files; every one of
// the 830 world prefabs, 377 instance prefabs and 3370 res.pak prefabs parses
// with `bytes consumed == file size` and no unknown tags, which is the check
// that says the grammar below is complete rather than merely plausible.
//
//   "HBSON" | u8 version | one tagged value (the root)
//
// STRINGS are a u32 whose top byte is a flag:
//   0x40  new string, length in the low 24 bits, and it joins a per-file cache
//   0x80  new string, length in the low 24 bits, not cached
//   0x00  the whole u32 is an index into that cache
// The writer caches strings of 16 bytes or fewer and inlines longer ones.
// That detail matters beyond this file: it means a raw byte scan for "@" +
// id - the '@' really being the 0x40 flag - is silently blind to every
// identifier of 17 characters or more.
//
// VALUES are a tag byte then a payload:
//   0x00 zero     0x04 true     0x08 object, u8 field count
//   0x01 i8       0x05 false    0x09 object, u32 field count
//   0x02 i32      0x06 null     0x0a string
//   0x03 f64      0x07 {}       0x0b []
//                               0x0c array, u8 count
//                               0x0d array, u32 count
// Object keys are bare strings with no tag of their own; values are tagged.
// ---------------------------------------------------------------------------

export function readHBSON(buf) {
  if (buf.length < 6 || buf.toString('ascii', 0, 5) !== 'HBSON')
    throw new Error('not an HBSON file');
  let p = 5;
  const version = buf[p++];
  const cache = [];

  function str() {
    const v = buf.readUInt32LE(p);
    p += 4;
    const flag = v >>> 24;
    const len = v & 0xffffff;
    if (flag === 0x00) {
      if (v >= cache.length) throw new Error(`string cache miss ${v} at ${p - 4}`);
      return cache[v];
    }
    if (flag !== 0x40 && flag !== 0x80)
      throw new Error(`string flag 0x${flag.toString(16)} at ${p - 4}`);
    const s = buf.toString('utf8', p, p + len);
    p += len;
    if (flag === 0x40) cache.push(s);
    return s;
  }

  function u32() {
    const v = buf.readUInt32LE(p);
    p += 4;
    return v;
  }

  function value() {
    const at = p;
    const tag = buf[p++];
    switch (tag) {
      case 0x00: return 0;
      case 0x01: { const v = buf.readInt8(p); p += 1; return v; }
      case 0x02: { const v = buf.readInt32LE(p); p += 4; return v; }
      case 0x03: { const v = buf.readDoubleLE(p); p += 8; return v; }
      case 0x04: return true;
      case 0x05: return false;
      case 0x06: return null;
      case 0x07: return {};
      case 0x0a: return str();
      case 0x0b: return [];
      case 0x08:
      case 0x09: {
        const n = tag === 0x08 ? buf[p++] : u32();
        const o = {};
        for (let i = 0; i < n; i++) {
          const k = str();
          o[k] = value();
        }
        return o;
      }
      case 0x0c:
      case 0x0d: {
        const n = tag === 0x0c ? buf[p++] : u32();
        const a = [];
        for (let i = 0; i < n; i++) a.push(value());
        return a;
      }
      default: {
        const ctx = buf.subarray(Math.max(0, at - 24), at + 24)
            .toString('latin1').replace(/[^\x20-\x7e]/g, '.');
        throw new Error(`unknown tag 0x${tag.toString(16)} at ${at}: ${ctx}`);
      }
    }
  }

  const root = value();
  return { version, root, bytesRead: p, size: buf.length };
}
