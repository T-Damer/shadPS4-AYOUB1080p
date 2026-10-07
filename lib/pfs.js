// Reader for the PS4 PFS filesystem inside a PKG.
//
// A PKG holds an "outer" PFS image (decrypted by PkgTool: pkg_extractouterpfs) containing one
// big file, pfs_image.dat, usually PFSC-compressed. That file is the "inner" PFS with the game
// files under uroot/. Inner files are mostly stored contiguously: the first direct block pointer
// is the start block and the next ones are 0xFFFFFFFF markers. LibOrbisPkg 0.2 (PkgTool) treats
// those markers as real pointers, which corrupts or drops large files - hence this reader.
'use strict';
const fs = require('fs');
const zlib = require('zlib');

const SIGNED = 0x1, IS64 = 0x2;

class FileReader {
  constructor(path) { this.fd = fs.openSync(path, 'r'); this.size = fs.fstatSync(this.fd).size; }
  read(pos, len) {
    const buf = Buffer.alloc(len);
    let done = 0;
    while (done < len) {
      const n = fs.readSync(this.fd, buf, done, len - done, pos + done);
      if (n <= 0) throw new Error(`short read at ${pos + done}`);
      done += n;
    }
    return buf;
  }
  close() { fs.closeSync(this.fd); }
}

/** Random access over a PFSC container (zlib blocks with an offset table); null if not PFSC. */
function pfscReader(read) {
  const h = read(0, 0x30);
  if (h.toString('latin1', 0, 4) !== 'PFSC') return null;
  const blockSize = Number(h.readBigUInt64LE(0x10));
  const tableOff = Number(h.readBigUInt64LE(0x18));
  const dataLen = Number(h.readBigUInt64LE(0x28));
  const count = Math.ceil(dataLen / blockSize);
  const table = read(tableOff, (count + 1) * 8);
  const cache = new Map();
  const block = (i) => {
    let data = cache.get(i);
    if (data) return data;
    const a = Number(table.readBigUInt64LE(i * 8)), b = Number(table.readBigUInt64LE(i * 8 + 8));
    if (a === b) data = Buffer.alloc(blockSize);
    else {
      const raw = read(a, b - a);
      data = b - a === blockSize ? raw
        : zlib.inflateSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      if (data.length < blockSize) { const t = Buffer.alloc(blockSize); data.copy(t); data = t; }
    }
    if (cache.size > 64) cache.delete(cache.keys().next().value);
    cache.set(i, data);
    return data;
  };
  return {
    size: dataLen,
    read(pos, len) {
      const out = Buffer.alloc(len);
      for (let done = 0; done < len;) {
        const bi = Math.floor((pos + done) / blockSize), bo = (pos + done) % blockSize;
        const n = Math.min(blockSize - bo, len - done);
        block(bi).copy(out, done, bo, bo + n);
        done += n;
      }
      return out;
    },
  };
}

/** A PFS image read through `read(pos, len)`. */
class Pfs {
  constructor(read) {
    this.read = read;
    const sb = read(0, 0x60);
    this.blockSize = sb.readInt32LE(0x20);
    const mode = sb.readUInt16LE(0x1c);
    const signed = (mode & SIGNED) !== 0, is64 = (mode & IS64) !== 0;
    this.inodeSize = signed ? (is64 ? 0x310 : 0x2c8) : (is64 ? 0x100 : 0xa8);
    this.ptrSize = signed ? (is64 ? 40 : 36) : (is64 ? 8 : 4);
    this.ptrOff = signed ? 32 : 0;
    this.is64 = is64;
    this.inodeCount = Number(sb.readBigUInt64LE(0x30));
    this.superroot = Number(sb.readBigUInt64LE(0x48));
    this.inodesPerBlock = Math.floor(this.blockSize / this.inodeSize);
  }
  inode(n) {
    const blk = 1 + Math.floor(n / this.inodesPerBlock);
    const raw = this.read(blk * this.blockSize + (n % this.inodesPerBlock) * this.inodeSize, this.inodeSize);
    return {
      raw, mode: raw.readUInt16LE(0), flags: raw.readUInt32LE(4),
      size: Number(raw.readBigUInt64LE(8)), csize: Number(raw.readBigUInt64LE(0x10)),
      blocks: raw.readUInt32LE(0x60),
    };
  }
  ptr(buf, off) { return this.is64 ? Number(buf.readBigUInt64LE(off)) : buf.readUInt32LE(off); }
  blockList(ino) {
    const { raw, blocks } = ino, base = 0x64, step = this.ptrSize, off = this.ptrOff;
    const marker = this.is64 ? 0xffffffffffffffff : 0xffffffff;
    const out = [];
    if (blocks > 1 && this.ptr(raw, base + step + off) === marker) {
      const start = this.ptr(raw, base + off); // contiguous file
      for (let k = 0; k < blocks; k++) out.push(start + k);
      return out;
    }
    for (let k = 0; k < 12 && out.length < blocks; k++) out.push(this.ptr(raw, base + k * step + off));
    const per = Math.floor(this.blockSize / step);
    const walk = (blk, depth) => {
      if (out.length >= blocks || blk === 0) return;
      const b = this.read(blk * this.blockSize, this.blockSize);
      for (let i = 0; i < per && out.length < blocks; i++) {
        const e = this.ptr(b, i * step + off);
        if (depth === 0) out.push(e); else walk(e, depth - 1);
      }
    };
    for (let lvl = 0; lvl < 5 && out.length < blocks; lvl++) walk(this.ptr(raw, base + (12 + lvl) * step + off), lvl);
    return out;
  }
  /** Reader of a file's stored bytes (compressed files: their PFSC container). */
  rawReader(ino) {
    const blocks = this.blockList(ino), bs = this.blockSize;
    return (pos, len) => {
      const out = Buffer.alloc(len);
      for (let done = 0; done < len;) {
        const bi = Math.floor((pos + done) / bs), bo = (pos + done) % bs;
        const n = Math.min(bs - bo, len - done);
        this.read(blocks[bi] * bs + bo, n).copy(out, done);
        done += n;
      }
      return out;
    };
  }
  /** { size, read } of a file's content, decompressing it if needed. */
  content(ino) {
    const raw = this.rawReader(ino);
    if ((ino.flags & 1) && ino.csize !== ino.size) {
      const r = pfscReader(raw);
      if (r) return r;
    }
    return { size: ino.size, read: raw };
  }
  dir(n) {
    const ino = this.inode(n), rd = this.rawReader(ino), out = [];
    for (let b = 0; b * this.blockSize < ino.size; b++) {
      const buf = rd(b * this.blockSize, Math.min(this.blockSize, ino.size - b * this.blockSize));
      for (let p = 0; p + 16 <= buf.length;) {
        const e = { ino: buf.readInt32LE(p), type: buf.readInt32LE(p + 4) };
        const nameLen = buf.readInt32LE(p + 8), entSize = buf.readInt32LE(p + 12);
        if (entSize <= 0) break;
        e.name = buf.toString('utf8', p + 16, p + 16 + nameLen);
        if ((e.ino > 0 || e.type > 0) && e.type !== 4 && e.type !== 5 && e.name !== '.' && e.name !== '..') out.push(e);
        p += entSize;
      }
    }
    return out;
  }
  /** All files under uroot: [{ path, ino }]. */
  files() {
    const root = this.dir(this.superroot).find((e) => e.name === 'uroot');
    if (!root) throw new Error('no uroot in the PFS image');
    const out = [];
    const walk = (n, rel) => {
      for (const e of this.dir(n)) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.type === 3) walk(e.ino, p);
        else if (e.type === 2) out.push({ path: p, ino: this.inode(e.ino) });
      }
    };
    walk(root.ino, '');
    return out;
  }
}

/** Opens the inner PFS from a decrypted outer PFS image file. */
function openInner(outerPath) {
  const file = new FileReader(outerPath);
  const outer = new Pfs((p, l) => file.read(p, l));
  // The outer image holds a single large file: the inner image.
  let best = null;
  for (let n = 0; n < outer.inodeCount; n++) {
    const ino = outer.inode(n);
    if ((ino.mode & 0x8000) && (!best || ino.size > best.size)) best = ino;
  }
  if (!best) throw new Error('no inner image in the outer PFS');
  const content = outer.content(best);
  return { pfs: new Pfs(content.read), close: () => file.close() };
}

module.exports = { Pfs, openInner, pfscReader };
