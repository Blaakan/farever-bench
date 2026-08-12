// ---------------------------------------------------------------------------
// bc7.mjs - full BC7 (BPTC) block decoder, per Microsoft's "BC7 Format" and
// "BC7 Format Mode Reference" (the D3D11 functional spec's tables).
//
// A block is 128 bits, read LSB-first. The mode is unary: mode m is m zero
// bits then a one, all within the first byte; a first byte of zero means no
// mode bit within 8 bits, which the spec reserves and requires to decode as
// transparent black. Field order after the mode bits: partition, rotation,
// index-selection bit, endpoints component-major (all R, then G, B, A; within
// a component subset0.e0, subset0.e1, subset1.e0, ...), p-bits, then index
// data (modes 4/5 carry a second index plane).
//
// Endpoint dequantization order matters: the p-bit is appended first (one
// more bit of precision), THEN the value is expanded to 8 bits by
// left-shift-and-replicate: (v << (8-b)) | (v >> (2b-8)). Doing the expansion
// before the p-bit lands every endpoint a fraction low.
//
// Interpolation is fixed-point: (e0*(64-w) + e1*w + 32) >> 6, with the
// 2/3/4-bit weight tables below. Modes 0-3 have no alpha bits and decode
// opaque; both endpoints being 255 makes the interpolation come out 255 for
// any weight, so alpha needs no special case. Modes 4/5 rotate one colour
// channel into alpha after interpolation so the separate alpha index plane
// can serve whichever channel needs the precision.
// ---------------------------------------------------------------------------

// Index interpolation weights, by index bit width.
const WEIGHTS = [
  null, null,
  [0, 21, 43, 64],                                              // 2-bit
  [0, 9, 18, 26, 37, 46, 55, 64],                               // 3-bit
  [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64],// 4-bit
];

// Per-mode configuration - Microsoft "BC7 Format" table, one row per mode:
//   ns   subsets              pb   partition bits
//   rb   rotation bits        isb  index-selection bit (mode 4 only)
//   cb   colour bits/channel  ab   alpha bits (0 = opaque mode)
//   epb  per-endpoint p-bit   spb  per-subset shared p-bit (mode 1 only)
//   ib   index bits           ib2  secondary index bits (modes 4/5)
const MODES = [
  { ns: 3, pb: 4, rb: 0, isb: 0, cb: 4, ab: 0, epb: 1, spb: 0, ib: 3, ib2: 0 },
  { ns: 2, pb: 6, rb: 0, isb: 0, cb: 6, ab: 0, epb: 0, spb: 1, ib: 3, ib2: 0 },
  { ns: 3, pb: 6, rb: 0, isb: 0, cb: 5, ab: 0, epb: 0, spb: 0, ib: 2, ib2: 0 },
  { ns: 2, pb: 6, rb: 0, isb: 0, cb: 7, ab: 0, epb: 1, spb: 0, ib: 2, ib2: 0 },
  { ns: 1, pb: 0, rb: 2, isb: 1, cb: 5, ab: 6, epb: 0, spb: 0, ib: 2, ib2: 3 },
  { ns: 1, pb: 0, rb: 2, isb: 0, cb: 7, ab: 8, epb: 0, spb: 0, ib: 2, ib2: 2 },
  { ns: 1, pb: 0, rb: 0, isb: 0, cb: 7, ab: 7, epb: 1, spb: 0, ib: 4, ib2: 0 },
  { ns: 2, pb: 6, rb: 0, isb: 0, cb: 5, ab: 5, epb: 1, spb: 0, ib: 2, ib2: 0 },
];

// Partition table, 2 subsets: 64 partitions x 16 texels (row-major in the
// block). Values are the subset each texel belongs to.
const PARTITION2 = Uint8Array.from([
  0,0,1,1, 0,0,1,1, 0,0,1,1, 0,0,1,1,   // 0
  0,0,0,1, 0,0,0,1, 0,0,0,1, 0,0,0,1,   // 1
  0,1,1,1, 0,1,1,1, 0,1,1,1, 0,1,1,1,   // 2
  0,0,0,1, 0,0,1,1, 0,0,1,1, 0,1,1,1,   // 3
  0,0,0,0, 0,0,0,1, 0,0,0,1, 0,0,1,1,   // 4
  0,0,1,1, 0,1,1,1, 0,1,1,1, 1,1,1,1,   // 5
  0,0,0,1, 0,0,1,1, 0,1,1,1, 1,1,1,1,   // 6
  0,0,0,0, 0,0,0,1, 0,0,1,1, 0,1,1,1,   // 7
  0,0,0,0, 0,0,0,0, 0,0,0,1, 0,0,1,1,   // 8
  0,0,1,1, 0,1,1,1, 1,1,1,1, 1,1,1,1,   // 9
  0,0,0,0, 0,0,0,1, 0,1,1,1, 1,1,1,1,   // 10
  0,0,0,0, 0,0,0,0, 0,0,0,1, 0,1,1,1,   // 11
  0,0,0,1, 0,1,1,1, 1,1,1,1, 1,1,1,1,   // 12
  0,0,0,0, 0,0,0,0, 1,1,1,1, 1,1,1,1,   // 13
  0,0,0,0, 1,1,1,1, 1,1,1,1, 1,1,1,1,   // 14
  0,0,0,0, 0,0,0,0, 0,0,0,0, 1,1,1,1,   // 15
  0,0,0,0, 1,0,0,0, 1,1,1,0, 1,1,1,1,   // 16
  0,1,1,1, 0,0,0,1, 0,0,0,0, 0,0,0,0,   // 17
  0,0,0,0, 0,0,0,0, 1,0,0,0, 1,1,1,0,   // 18
  0,1,1,1, 0,0,1,1, 0,0,0,1, 0,0,0,0,   // 19
  0,0,1,1, 0,0,0,1, 0,0,0,0, 0,0,0,0,   // 20
  0,0,0,0, 1,0,0,0, 1,1,0,0, 1,1,1,0,   // 21
  0,0,0,0, 0,0,0,0, 1,0,0,0, 1,1,0,0,   // 22
  0,1,1,1, 0,0,1,1, 0,0,1,1, 0,0,0,1,   // 23
  0,0,1,1, 0,0,0,1, 0,0,0,1, 0,0,0,0,   // 24
  0,0,0,0, 1,0,0,0, 1,0,0,0, 1,1,0,0,   // 25
  0,1,1,0, 0,1,1,0, 0,1,1,0, 0,1,1,0,   // 26
  0,0,1,1, 0,1,1,0, 0,1,1,0, 1,1,0,0,   // 27
  0,0,0,1, 0,1,1,1, 1,1,1,0, 1,0,0,0,   // 28
  0,0,0,0, 1,1,1,1, 1,1,1,1, 0,0,0,0,   // 29
  0,1,1,1, 0,0,0,1, 1,0,0,0, 1,1,1,0,   // 30
  0,0,1,1, 1,0,0,1, 1,0,0,1, 1,1,0,0,   // 31
  0,1,0,1, 0,1,0,1, 0,1,0,1, 0,1,0,1,   // 32
  0,0,0,0, 1,1,1,1, 0,0,0,0, 1,1,1,1,   // 33
  0,1,0,1, 1,0,1,0, 0,1,0,1, 1,0,1,0,   // 34
  0,0,1,1, 0,0,1,1, 1,1,0,0, 1,1,0,0,   // 35
  0,0,1,1, 1,1,0,0, 0,0,1,1, 1,1,0,0,   // 36
  0,1,0,1, 0,1,0,1, 1,0,1,0, 1,0,1,0,   // 37
  0,1,1,0, 1,0,0,1, 0,1,1,0, 1,0,0,1,   // 38
  0,1,0,1, 1,0,1,0, 1,0,1,0, 0,1,0,1,   // 39
  0,1,1,1, 0,0,1,1, 1,1,0,0, 1,1,1,0,   // 40
  0,0,0,1, 0,0,1,1, 1,1,0,0, 1,0,0,0,   // 41
  0,0,1,1, 0,0,1,0, 0,1,0,0, 1,1,0,0,   // 42
  0,0,1,1, 1,0,1,1, 1,1,0,1, 1,1,0,0,   // 43
  0,1,1,0, 1,0,0,1, 1,0,0,1, 0,1,1,0,   // 44
  0,0,1,1, 1,1,0,0, 1,1,0,0, 0,0,1,1,   // 45
  0,1,1,0, 0,1,1,0, 1,0,0,1, 1,0,0,1,   // 46
  0,0,0,0, 0,1,1,0, 0,1,1,0, 0,0,0,0,   // 47
  0,1,0,0, 1,1,1,0, 0,1,0,0, 0,0,0,0,   // 48
  0,0,1,0, 0,1,1,1, 0,0,1,0, 0,0,0,0,   // 49
  0,0,0,0, 0,0,1,0, 0,1,1,1, 0,0,1,0,   // 50
  0,0,0,0, 0,1,0,0, 1,1,1,0, 0,1,0,0,   // 51
  0,1,1,0, 1,1,0,0, 1,0,0,1, 0,0,1,1,   // 52
  0,0,1,1, 0,1,1,0, 1,1,0,0, 1,0,0,1,   // 53
  0,1,1,0, 0,0,1,1, 1,0,0,1, 1,1,0,0,   // 54
  0,0,1,1, 1,0,0,1, 1,1,0,0, 0,1,1,0,   // 55
  0,1,1,0, 1,1,0,0, 1,1,0,0, 1,0,0,1,   // 56
  0,1,1,0, 0,0,1,1, 0,0,1,1, 1,0,0,1,   // 57
  0,1,1,1, 1,1,1,0, 1,0,0,0, 0,0,0,1,   // 58
  0,0,0,1, 1,0,0,0, 1,1,1,0, 0,1,1,1,   // 59
  0,0,0,0, 1,1,1,1, 0,0,1,1, 0,0,1,1,   // 60
  0,0,1,1, 0,0,1,1, 1,1,1,1, 0,0,0,0,   // 61
  0,0,1,0, 0,0,1,0, 1,1,1,0, 1,1,1,0,   // 62
  0,1,0,0, 0,1,0,0, 1,1,1,0, 1,1,1,0,   // 63
]);

// Partition table, 3 subsets: 64 partitions x 16 texels.
const PARTITION3 = Uint8Array.from([
  0,0,1,1, 0,0,1,1, 0,2,2,1, 2,2,2,2,   // 0
  0,0,0,1, 0,0,1,1, 2,2,1,1, 2,2,2,1,   // 1
  0,0,0,0, 2,0,0,1, 2,2,1,1, 2,2,1,1,   // 2
  0,2,2,2, 0,0,2,2, 0,0,1,1, 0,1,1,1,   // 3
  0,0,0,0, 0,0,0,0, 1,1,2,2, 1,1,2,2,   // 4
  0,0,1,1, 0,0,1,1, 0,0,2,2, 0,0,2,2,   // 5
  0,0,2,2, 0,0,2,2, 1,1,1,1, 1,1,1,1,   // 6
  0,0,1,1, 0,0,1,1, 2,2,1,1, 2,2,1,1,   // 7
  0,0,0,0, 0,0,0,0, 1,1,1,1, 2,2,2,2,   // 8
  0,0,0,0, 1,1,1,1, 1,1,1,1, 2,2,2,2,   // 9
  0,0,0,0, 1,1,1,1, 2,2,2,2, 2,2,2,2,   // 10
  0,0,1,2, 0,0,1,2, 0,0,1,2, 0,0,1,2,   // 11
  0,1,1,2, 0,1,1,2, 0,1,1,2, 0,1,1,2,   // 12
  0,1,2,2, 0,1,2,2, 0,1,2,2, 0,1,2,2,   // 13
  0,0,1,1, 0,1,1,2, 1,1,2,2, 1,2,2,2,   // 14
  0,0,1,1, 2,0,0,1, 2,2,0,0, 2,2,2,0,   // 15
  0,0,0,1, 0,0,1,1, 0,1,1,2, 1,1,2,2,   // 16
  0,1,1,1, 0,0,1,1, 2,0,0,1, 2,2,0,0,   // 17
  0,0,0,0, 1,1,2,2, 1,1,2,2, 1,1,2,2,   // 18
  0,0,2,2, 0,0,2,2, 0,0,2,2, 1,1,1,1,   // 19
  0,1,1,1, 0,1,1,1, 0,2,2,2, 0,2,2,2,   // 20
  0,0,0,1, 0,0,0,1, 2,2,2,1, 2,2,2,1,   // 21
  0,0,0,0, 0,0,1,1, 0,1,2,2, 0,1,2,2,   // 22
  0,0,0,0, 1,1,0,0, 2,2,1,0, 2,2,1,0,   // 23
  0,1,2,2, 0,1,2,2, 0,0,1,2, 0,0,0,1,   // 24
  0,0,1,2, 0,0,1,2, 1,1,2,2, 2,2,2,2,   // 25
  0,1,1,0, 1,2,2,1, 1,2,2,1, 0,1,1,0,   // 26
  0,0,0,0, 0,1,1,0, 1,2,2,1, 1,2,2,1,   // 27
  0,0,2,2, 1,1,0,2, 1,1,0,2, 0,0,2,2,   // 28
  0,1,1,0, 0,1,1,0, 2,0,0,2, 2,2,2,2,   // 29
  0,0,1,1, 0,1,2,2, 0,1,2,2, 0,0,1,1,   // 30
  0,0,0,0, 2,0,0,0, 2,2,1,1, 2,2,2,1,   // 31
  0,0,0,0, 0,0,0,2, 1,1,2,2, 1,2,2,2,   // 32
  0,2,2,2, 0,0,2,2, 0,0,1,2, 0,0,1,1,   // 33
  0,0,1,1, 0,0,1,2, 0,0,2,2, 0,2,2,2,   // 34
  0,1,2,0, 0,1,2,0, 0,1,2,0, 0,1,2,0,   // 35
  0,0,0,0, 1,1,1,1, 2,2,2,2, 0,0,0,0,   // 36
  0,1,2,0, 1,2,0,1, 2,0,1,2, 0,1,2,0,   // 37
  0,1,2,0, 2,0,1,2, 1,2,0,1, 0,1,2,0,   // 38
  0,0,1,1, 2,2,0,0, 1,1,2,2, 0,0,1,1,   // 39
  0,0,1,1, 1,1,2,2, 2,2,0,0, 0,0,1,1,   // 40
  0,1,0,1, 0,1,0,1, 2,2,2,2, 2,2,2,2,   // 41
  0,0,0,0, 0,0,0,0, 2,1,2,1, 2,1,2,1,   // 42
  0,0,2,2, 1,1,2,2, 0,0,2,2, 1,1,2,2,   // 43
  0,0,2,2, 0,0,1,1, 0,0,2,2, 0,0,1,1,   // 44
  0,2,2,0, 1,2,2,1, 0,2,2,0, 1,2,2,1,   // 45
  0,1,0,1, 2,2,2,2, 2,2,2,2, 0,1,0,1,   // 46
  0,0,0,0, 2,1,2,1, 2,1,2,1, 2,1,2,1,   // 47
  0,1,0,1, 0,1,0,1, 0,1,0,1, 2,2,2,2,   // 48
  0,2,2,2, 0,1,1,1, 0,2,2,2, 0,1,1,1,   // 49
  0,0,0,2, 1,1,1,2, 0,0,0,2, 1,1,1,2,   // 50
  0,0,0,0, 2,1,1,2, 2,1,1,2, 2,1,1,2,   // 51
  0,2,2,2, 0,1,1,1, 0,1,1,1, 0,2,2,2,   // 52
  0,0,0,2, 1,1,1,2, 1,1,1,2, 0,0,0,2,   // 53
  0,1,1,0, 0,1,1,0, 0,1,1,0, 2,2,2,2,   // 54
  0,0,0,0, 0,0,0,0, 2,1,1,2, 2,1,1,2,   // 55
  0,1,1,0, 0,1,1,0, 2,2,2,2, 2,2,2,2,   // 56
  0,0,2,2, 0,0,1,1, 0,0,1,1, 0,0,2,2,   // 57
  0,0,2,2, 1,1,2,2, 1,1,2,2, 0,0,2,2,   // 58
  0,0,0,0, 0,0,0,0, 0,0,0,0, 2,1,1,2,   // 59
  0,0,0,2, 0,0,0,1, 0,0,0,2, 0,0,0,1,   // 60
  0,2,2,2, 1,2,2,2, 0,2,2,2, 1,2,2,2,   // 61
  0,1,0,1, 2,2,2,2, 2,2,2,2, 2,2,2,2,   // 62
  0,1,1,1, 2,0,1,1, 2,2,0,1, 2,2,2,0,   // 63
]);

// Anchor texel of the SECOND subset, per 2-subset partition. Subset 0's
// anchor is always texel 0; an anchor's index is stored with one fewer bit,
// its high bit implicitly zero.
const ANCHOR2 = Uint8Array.from([
  15,15,15,15,15,15,15,15, 15,15,15,15,15,15,15,15,
  15, 2, 8, 2, 2, 8, 8,15,  2, 8, 2, 2, 8, 8, 2, 2,
  15,15, 6, 8, 2, 8,15,15,  2, 8, 2, 2, 2,15,15, 6,
   6, 2, 6, 8,15,15, 2, 2, 15,15,15,15,15, 2, 2,15,
]);

// Anchor texels of the second and third subsets, per 3-subset partition.
const ANCHOR3_2 = Uint8Array.from([
   3, 3,15,15, 8, 3,15,15,  8, 8, 6, 6, 6, 5, 3, 3,
   3, 3, 8,15, 3, 3, 6,10,  5, 8, 8, 6, 8, 5,15,15,
   8,15, 3, 5, 6,10, 8,15, 15, 3,15, 5,15,15,15,15,
   3,15, 5, 5, 5, 8, 5,10,  5,10, 8,13,15,12, 3, 3,
]);
const ANCHOR3_3 = Uint8Array.from([
  15, 8, 8, 3,15,15, 3, 8, 15,15,15,15,15,15,15, 8,
  15, 8,15, 3,15, 8,15, 8,  3,15, 6,10,15,15,10, 8,
  15, 3,15,10,10, 8, 9,10,  6,15, 8,15, 3, 6, 6, 8,
  15, 3,15,15,15,15,15,15, 15,15,15,15, 3,15,15, 8,
]);

// --- bit cursor over one block ---------------------------------------------
//
// Module-level scratch: the decoder is synchronous and single-threaded, so
// one 17-byte buffer (16 + a zero guard, letting the 16-bit read window run
// off the end) and one cursor serve every block without per-block allocation.
// No field is wider than 8 bits, so a two-byte window always covers a read.

const block = new Uint8Array(17);
let bitPos = 0;

function bits(n) {
  const i = bitPos >> 3;
  const v = ((block[i] | (block[i + 1] << 8)) >> (bitPos & 7)) & ((1 << n) - 1);
  bitPos += n;
  return v;
}

// (v << (8-b)) | (v >> (2b-8)): left-shift then replicate the high bits into
// the vacated low bits, exact for b in 4..8 (b=8 is the identity).
const unquant = (v, b) => ((v << (8 - b)) | (v >> (2 * b - 8))) & 0xff;

const endpoints = new Int32Array(24);   // 6 endpoints x RGBA
const idx0 = new Uint8Array(16);
const idx1 = new Uint8Array(16);

// Decode one 128-bit block into px (16 RGBA texels, row-major).
function decodeBlock(src, off, px) {
  for (let i = 0; i < 16; i++) block[i] = src[off + i];

  const b0 = block[0];
  if (b0 === 0) { px.fill(0); return; }   // reserved mode: transparent black
  let mode = 0;
  while (!((b0 >> mode) & 1)) mode++;
  bitPos = mode + 1;

  const m = MODES[mode];
  const nEp = m.ns * 2;
  const partition = m.pb ? bits(m.pb) : 0;
  const rotation = m.rb ? bits(m.rb) : 0;
  const idxMode = m.isb ? bits(1) : 0;

  for (let ch = 0; ch < 3; ch++)
    for (let e = 0; e < nEp; e++) endpoints[e * 4 + ch] = bits(m.cb);
  if (m.ab)
    for (let e = 0; e < nEp; e++) endpoints[e * 4 + 3] = bits(m.ab);

  if (m.epb) {
    for (let e = 0; e < nEp; e++) {
      const p = bits(1);
      endpoints[e * 4] = (endpoints[e * 4] << 1) | p;
      endpoints[e * 4 + 1] = (endpoints[e * 4 + 1] << 1) | p;
      endpoints[e * 4 + 2] = (endpoints[e * 4 + 2] << 1) | p;
      if (m.ab) endpoints[e * 4 + 3] = (endpoints[e * 4 + 3] << 1) | p;
    }
  } else if (m.spb) {
    // Mode 1: one p-bit per subset, shared by both its endpoints.
    for (let s = 0; s < m.ns; s++) {
      const p = bits(1);
      for (let e = s * 2; e < s * 2 + 2; e++) {
        endpoints[e * 4] = (endpoints[e * 4] << 1) | p;
        endpoints[e * 4 + 1] = (endpoints[e * 4 + 1] << 1) | p;
        endpoints[e * 4 + 2] = (endpoints[e * 4 + 2] << 1) | p;
      }
    }
  }

  const cb = m.cb + (m.epb || m.spb ? 1 : 0);
  const ab = m.ab + (m.ab && m.epb ? 1 : 0);
  for (let e = 0; e < nEp; e++) {
    endpoints[e * 4] = unquant(endpoints[e * 4], cb);
    endpoints[e * 4 + 1] = unquant(endpoints[e * 4 + 1], cb);
    endpoints[e * 4 + 2] = unquant(endpoints[e * 4 + 2], cb);
    endpoints[e * 4 + 3] = m.ab ? unquant(endpoints[e * 4 + 3], ab) : 255;
  }

  let a1 = 16, a2 = 16;   // 16: no such anchor
  if (m.ns === 2) a1 = ANCHOR2[partition];
  else if (m.ns === 3) { a1 = ANCHOR3_2[partition]; a2 = ANCHOR3_3[partition]; }

  for (let t = 0; t < 16; t++)
    idx0[t] = bits(m.ib - (t === 0 || t === a1 || t === a2 ? 1 : 0));
  if (m.ib2)
    for (let t = 0; t < 16; t++)
      idx1[t] = bits(m.ib2 - (t === 0 ? 1 : 0));

  const partTable = m.ns === 3 ? PARTITION3 : PARTITION2;
  const w0 = WEIGHTS[m.ib];
  const w1 = m.ib2 ? WEIGHTS[m.ib2] : null;

  for (let t = 0; t < 16; t++) {
    const s = m.ns === 1 ? 0 : partTable[partition * 16 + t];
    const e0 = s * 8, e1 = s * 8 + 4;
    // Mode 4's index-selection bit swaps which plane drives colour; mode 5
    // always keeps colour on the first plane and alpha on the second; the
    // single-plane modes drive both from the one index.
    let wc, wa;
    if (!m.ib2) wc = wa = w0[idx0[t]];
    else if (idxMode) { wc = w1[idx1[t]]; wa = w0[idx0[t]]; }
    else { wc = w0[idx0[t]]; wa = w1[idx1[t]]; }

    let r = (endpoints[e0] * (64 - wc) + endpoints[e1] * wc + 32) >> 6;
    let g = (endpoints[e0 + 1] * (64 - wc) + endpoints[e1 + 1] * wc + 32) >> 6;
    let b = (endpoints[e0 + 2] * (64 - wc) + endpoints[e1 + 2] * wc + 32) >> 6;
    let a = (endpoints[e0 + 3] * (64 - wa) + endpoints[e1 + 3] * wa + 32) >> 6;

    if (rotation === 1) { const x = a; a = r; r = x; }
    else if (rotation === 2) { const x = a; a = g; g = x; }
    else if (rotation === 3) { const x = a; a = b; b = x; }

    const d = t * 4;
    px[d] = r; px[d + 1] = g; px[d + 2] = b; px[d + 3] = a;
  }
}

// Decode a BC7 payload of ceil(width/4) x ceil(height/4) blocks to RGBA.
export function decodeBc7(data, width, height) {
  const src = ArrayBuffer.isView(data) ? data : new Uint8Array(data);
  const bw = (width + 3) >> 2, bh = (height + 3) >> 2;
  if (src.length < bw * bh * 16)
    throw new Error(`BC7 payload is ${src.length} bytes; ` +
                    `${width}x${height} needs ${bw * bh * 16}`);

  const out = new Uint8Array(width * height * 4);
  const px = new Uint8Array(64);
  let off = 0;
  for (let by = 0; by < bh; by++) {
    // Blocks on the right/bottom edge of a non-multiple-of-4 image still
    // hold 16 texels; only the in-bounds ones are written.
    const ny = Math.min(4, height - by * 4);
    for (let bx = 0; bx < bw; bx++, off += 16) {
      decodeBlock(src, off, px);
      const nx = Math.min(4, width - bx * 4);
      for (let y = 0; y < ny; y++) {
        let d = ((by * 4 + y) * width + bx * 4) * 4;
        let sPix = y * 16;
        for (let x = 0; x < nx; x++, d += 4, sPix += 4) {
          out[d] = px[sPix];
          out[d + 1] = px[sPix + 1];
          out[d + 2] = px[sPix + 2];
          out[d + 3] = px[sPix + 3];
        }
      }
    }
  }
  return out;
}
