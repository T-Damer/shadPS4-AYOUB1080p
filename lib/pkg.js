// PS4 PKG helpers: header entry table, param.sfo, and PkgTool (LibOrbisPkg) calls for the
// parts that need keys (outer PFS decryption, encrypted metadata entries).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ZERO_PASSCODE = '0'.repeat(32);

/** Unencrypted entry of the PKG header by id (0x1000 = param.sfo). */
function readEntry(pkgPath, wantedId) {
  const fd = fs.openSync(pkgPath, 'r');
  try {
    const head = Buffer.alloc(0x20);
    fs.readSync(fd, head, 0, 0x20, 0);
    if (head.readUInt32BE(0) !== 0x7f434e54) throw new Error(`${pkgPath} is not a PS4 PKG`);
    const count = head.readUInt32BE(0x10), tableOff = head.readUInt32BE(0x18);
    const table = Buffer.alloc(count * 32);
    fs.readSync(fd, table, 0, table.length, tableOff);
    for (let i = 0; i < count; i++) {
      const o = i * 32;
      if (table.readUInt32BE(o) !== wantedId) continue;
      const off = table.readUInt32BE(o + 16), size = table.readUInt32BE(o + 20);
      const data = Buffer.alloc(size);
      fs.readSync(fd, data, 0, size, off);
      return data;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** param.sfo key/values. */
function parseSfo(buf) {
  if (buf.readUInt32LE(0) !== 0x46535000) throw new Error('not a param.sfo');
  const keyTable = buf.readUInt32LE(8), dataTable = buf.readUInt32LE(12), count = buf.readUInt32LE(16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const o = 20 + i * 16;
    const keyOff = buf.readUInt16LE(o), fmt = buf.readUInt16LE(o + 2), len = buf.readUInt32LE(o + 4);
    const dataOff = buf.readUInt32LE(o + 12);
    const keyEnd = buf.indexOf(0, keyTable + keyOff);
    const key = buf.toString('utf8', keyTable + keyOff, keyEnd);
    const at = dataTable + dataOff;
    out[key] = fmt === 0x0404 ? buf.readUInt32LE(at) : buf.toString('utf8', at, at + len).replace(/\0+$/, '');
  }
  return out;
}

function pkgSfo(pkgPath) {
  const data = readEntry(pkgPath, 0x1000);
  if (!data) throw new Error(`${pkgPath} has no param.sfo entry`);
  return parseSfo(data);
}

class PkgTool {
  constructor(dll) {
    if (!fs.existsSync(dll)) throw new Error(`PkgTool not found: ${dll}`);
    this.dll = dll;
  }
  run(args, opts = {}) {
    return execFileSync('dotnet', [this.dll, ...args], {
      encoding: 'utf8', maxBuffer: 64 << 20,
      env: { ...process.env, DOTNET_ROLL_FORWARD: 'Major' }, ...opts,
    });
  }
  /** [{ index, name, encrypted }] */
  entries(pkgPath) {
    const out = [];
    for (const line of this.run(['pkg_listentries', pkgPath]).split(/\r?\n/).slice(1)) {
      const m = line.trim().match(/^0x[0-9A-F]+\s+0x[0-9A-F]+\s+[0-9A-F]+\s+(\d+)\s+(\d+)?\s*(\S+)$/i);
      if (m) out.push({ index: Number(m[1]), encrypted: m[2] !== undefined, name: m[3] });
    }
    return out;
  }
  extractEntry(pkgPath, index, outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    this.run(['pkg_extractentry', '--passcode', ZERO_PASSCODE, pkgPath, String(index), outPath]);
  }
  /** Decrypts the outer PFS image (as large as the PKG) to outPath. */
  extractOuterPfs(pkgPath, outPath) {
    this.run(['pkg_extractouterpfs', '--passcode', ZERO_PASSCODE, pkgPath, outPath], { stdio: 'inherit' });
  }
}

// Metadata entries that are not files of sce_sys (or already in the PFS image).
const NOT_SCE_SYS = new Set(['DIGESTS', 'ENTRY_KEYS', 'IMAGE_KEY', 'GENERAL_DIGESTS', 'METAS',
  'ENTRY_NAMES', 'LICENSE_DAT', 'LICENSE_INFO', 'PSRESERVED_DAT', 'PARAM_SFO']);

/** PkgTool entry name -> path under sce_sys: TROPHY__TROPHY00_TRP -> trophy/trophy00.trp */
function sceSysPath(name) {
  if (NOT_SCE_SYS.has(name)) return null;
  const parts = name.toLowerCase().split('__');
  const last = parts.length - 1;
  parts[last] = parts[last].replace(/_([a-z0-9]+)$/, '.$1').replace(/^playgo_/, 'playgo-');
  return parts.join('/');
}

module.exports = { PkgTool, pkgSfo, parseSfo, sceSysPath };
