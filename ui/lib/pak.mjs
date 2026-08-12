// Vendored verbatim from D:\Gits\farever-mods\tools\lib\pak.mjs - the packaged exe cannot reach farever-mods.
// ---------------------------------------------------------------------------
// pak.mjs - reader for Shiro/Heaps .pak archives.
//
//   "PAK" u8:version
//   u32   headerSize          (prologue + entry tree + "DATA" marker)
//   u32   dataSize            (low 32 bits of the data section size)
//   entry root                (tree; the root has an empty name)
//   "DATA"                    (at headerSize-4)
//   ...file data...           (at headerSize + entry.dataPos)
//
//   entry := u8 nameLen, char name[nameLen], u8 flags
//     flags & 1 : directory -> u32 childCount, entry children[childCount]
//     else      : dataPos (f64 LE if flags & 2, else u32), u32 size,
//                 u32 checksum
//
// The f64 position matches hxd.fmt.pak.Data, where dataPosition is a Float so
// archives can pass 2^31. Only the header is read up front; file bodies are
// pulled with a targeted seek.
// ---------------------------------------------------------------------------

import { openSync, readSync, closeSync } from 'node:fs';

export function openPak(path) {
  const fd = openSync(path, 'r');
  const head = Buffer.alloc(12);
  readSync(fd, head, 0, 12, 0);
  if (head.toString('ascii', 0, 3) !== 'PAK') {
    closeSync(fd);
    throw new Error(`${path}: not a PAK archive`);
  }
  const version = head[3];
  const headerSize = head.readUInt32LE(4);

  const header = Buffer.alloc(headerSize - 16);
  readSync(fd, header, 0, headerSize - 16, 12);

  const marker = Buffer.alloc(4);
  readSync(fd, marker, 0, 4, headerSize - 4);
  if (marker.toString('ascii') !== 'DATA') {
    closeSync(fd);
    throw new Error(`${path}: no DATA marker - not a format we understand`);
  }

  const files = [];   // { path, pos, size }
  let p = 0;
  (function readEntry(prefix) {
    const nameLen = header[p++];
    const name = header.toString('utf8', p, p + nameLen);
    p += nameLen;
    const flags = header[p++];
    const full = prefix ? `${prefix}/${name}` : name;
    if (flags & 1) {
      const n = header.readUInt32LE(p);
      p += 4;
      for (let i = 0; i < n; i++) readEntry(full);
    } else {
      let pos;
      if (flags & 2) {
        pos = header.readDoubleLE(p);
        p += 8;
      } else {
        pos = header.readUInt32LE(p);
        p += 4;
      }
      const size = header.readUInt32LE(p);
      p += 8;   // size + checksum
      files.push({ path: full, pos, size });
    }
  })('');

  const byPath = new Map(files.map((f) => [f.path, f]));

  return {
    version,
    files,
    find: (path) => byPath.get(path) || null,
    read(entryOrPath) {
      const e = typeof entryOrPath === 'string' ? byPath.get(entryOrPath)
                                                : entryOrPath;
      if (!e) throw new Error(`pak: no entry ${entryOrPath}`);
      const buf = Buffer.alloc(e.size);
      readSync(fd, buf, 0, e.size, headerSize + e.pos);
      return buf;
    },
    close: () => closeSync(fd),
  };
}
