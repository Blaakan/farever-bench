// ---------------------------------------------------------------------------
// dds.mjs - DDS container parser for the textures the game ships.
//
//   'DDS ' magic, the 124-byte DDS_HEADER, and - on every texture both the
//   game and gen-atlas write - the 20-byte DX10 extension naming a
//   dxgiFormat. Formats 98/99 are BC7_UNORM / BC7_UNORM_SRGB, which is all
//   the decoder downstream can consume, so only those are let through. The
//   error names whatever format was actually found, because "unsupported"
//   with no name means re-opening the file in a hex viewer.
//
//   Mip payload sizes are computed, not read: BC7 is 4x4 blocks of 16 bytes,
//   so a WxH level is ceil(W/4)*ceil(H/4)*16, and each dimension halves
//   (floored, min 1) per level. The 2x2 and 1x1 tails still cost one whole
//   block each.
// ---------------------------------------------------------------------------

const HEADER_SIZE = 4 + 124;         // magic + DDS_HEADER
const DX10_SIZE = 20;
const DDSD_MIPMAPCOUNT = 0x20000;
const DDPF_FOURCC = 0x4;

// Names for the error message only - everything here except 98/99 is refused.
const DXGI_NAMES = new Map([
  [28, 'R8G8B8A8_UNORM'], [71, 'BC1_TYPELESS'], [72, 'BC1_UNORM'],
  [73, 'BC1_UNORM_SRGB'], [74, 'BC2_TYPELESS'], [75, 'BC2_UNORM'],
  [76, 'BC2_UNORM_SRGB'], [77, 'BC3_TYPELESS'], [78, 'BC3_UNORM'],
  [79, 'BC3_UNORM_SRGB'], [80, 'BC4_TYPELESS'], [81, 'BC4_UNORM'],
  [83, 'BC5_TYPELESS'], [84, 'BC5_UNORM'], [87, 'B8G8R8A8_UNORM'],
  [95, 'BC6H_UF16'], [96, 'BC6H_SF16'], [97, 'BC7_TYPELESS'],
  [98, 'BC7_UNORM'], [99, 'BC7_UNORM_SRGB'],
]);

const bc7MipSize = (w, h) => (((w + 3) >> 2) * ((h + 3) >> 2)) << 4;

export function parseDds(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer
    : ArrayBuffer.isView(buffer)
      ? Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : Buffer.from(buffer);

  if (buf.length < HEADER_SIZE || buf.toString('ascii', 0, 4) !== 'DDS ')
    throw new Error('not a DDS file (no "DDS " magic)');
  if (buf.readUInt32LE(4) !== 124)
    throw new Error(`DDS header size ${buf.readUInt32LE(4)}, expected 124`);

  const flags = buf.readUInt32LE(8);
  const height = buf.readUInt32LE(12);
  const width = buf.readUInt32LE(16);
  // Writers that omit DDSD_MIPMAPCOUNT leave the field 0 (or 1); either way
  // there is at least the top level.
  const mipField = buf.readUInt32LE(28);
  const mipCount = (flags & DDSD_MIPMAPCOUNT) || mipField
    ? Math.max(1, mipField) : 1;

  if (buf.readUInt32LE(76) !== 32)
    throw new Error(`DDS pixel format size ${buf.readUInt32LE(76)}, expected 32`);
  const pfFlags = buf.readUInt32LE(80);
  if (!(pfFlags & DDPF_FOURCC)) {
    const bpp = buf.readUInt32LE(88);
    throw new Error(`DDS is uncompressed ${bpp}-bit data; only BC7 is supported`);
  }
  const fourCC = buf.toString('ascii', 84, 88);
  if (fourCC !== 'DX10')
    throw new Error(`DDS fourCC "${fourCC}"; only DX10-header BC7 is supported`);
  if (buf.length < HEADER_SIZE + DX10_SIZE)
    throw new Error('DDS truncated inside the DX10 header');

  const dxgiFormat = buf.readUInt32LE(128);
  if (dxgiFormat !== 98 && dxgiFormat !== 99) {
    const name = DXGI_NAMES.get(dxgiFormat) || `dxgiFormat ${dxgiFormat}`;
    throw new Error(`DDS is ${name} (dxgiFormat ${dxgiFormat}); only BC7 is supported`);
  }
  const format = dxgiFormat === 98 ? 'BC7_UNORM' : 'BC7_UNORM_SRGB';

  const mips = [];
  let off = HEADER_SIZE + DX10_SIZE;
  let w = width, h = height;
  for (let i = 0; i < mipCount; i++) {
    const size = bc7MipSize(w, h);
    if (off + size > buf.length)
      throw new Error(`DDS mip ${i} (${w}x${h}) truncated: ` +
                      `needs ${size} bytes at ${off}, file has ${buf.length}`);
    mips.push({ width: w, height: h, data: buf.subarray(off, off + size) });
    off += size;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }

  return { width, height, format, mipCount, mips };
}
