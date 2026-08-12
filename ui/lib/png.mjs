// ---------------------------------------------------------------------------
// png.mjs - minimal PNG writer: 8-bit RGBA, one IDAT, no filtering.
//
// Every scanline carries filter type 0 (None), so the raw stream is just the
// pixel data with one prefix byte per row; zlib does whatever compressing
// happens. CRC32 is the PNG polynomial (0xEDB88320 reflected), computed over
// chunk type + data - not the length - per the spec.
// ---------------------------------------------------------------------------

import { deflateSync } from 'node:zlib';

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePng(rgba, width, height) {
  const stride = width * 4;
  if (rgba.length < stride * height)
    throw new Error(`RGBA buffer is ${rgba.length} bytes; ` +
                    `${width}x${height} needs ${stride * height}`);
  const src = Buffer.isBuffer(rgba)
    ? rgba : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA (compression/filter/interlace stay 0)

  const raw = Buffer.alloc(height * (stride + 1));   // filter bytes stay 0
  for (let y = 0; y < height; y++)
    src.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
