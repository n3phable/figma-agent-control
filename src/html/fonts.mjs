/**
 * [INPUT]: Uses node:fs openSync/readSync/fstatSync/closeSync/readdirSync, node:os homedir and node:path; reads local ttf/otf/ttc/otc files.
 * [OUTPUT]: FONT_DIRS, parseFont(bytes, file) -> FontRecord[], findFont({ postScriptName?, family?, style? }, dirs) -> FontRecord | null.
 * [POS]: Dependency-free sfnt metrics parser for head, hhea, OS/2, name and fvar, including TTC and named variable-font instances. Finds fonts by PostScript name or
 *        (family, style). generate does not import this module; callers pass FontRecord metrics as plain data to keep generation pure.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {{ ascender: number, descender: number, lineGap: number }} VerticalMetrics
 * @typedef {{
 *   file: string,
 *   index: number,
 *   postScriptName: string,
 *   family: string,
 *   style: string,
 *   unitsPerEm: number,
 *   hhea: VerticalMetrics,
 *   typo: VerticalMetrics | null,
 *   win: { ascent: number, descent: number } | null,
 *   useTypoMetrics: boolean,
 *   weightClass: number | null,
 *   instance: boolean
 * }} FontRecord
 * file is the font path; index is the TTC face index, or 0 for a single font. postScriptName uses name ID 6, or fvar postScriptNameID for named instances, defaulting to ''.
 * family uses name ID 16, falling back to ID 1; named instances reuse the default face family. style uses name ID 17, falling back to ID 2, or subfamilyNameID for named instances.
 * hhea.descender is negative. typo/win are null when OS/2 is absent or short; both win values are positive. useTypoMetrics is OS/2 fsSelection bit 7.
 * weightClass is diagnostic OS/2 usWeightClass; instance marks a named fvar instance.
 * @typedef {(offset: number, length: number) => DataView} Reader
 */

// User fonts come first, matching macOS priority; the first matching name wins.
export const FONT_DIRS = [path.join(os.homedir(), 'Library/Fonts'), '/Library/Fonts', '/System/Library/Fonts'];

// -- sfnt parsing -------------------------------------------------------
// Read only the table directory plus head, hhea, OS/2, name and fvar using OpenType offsets. DataView throws RangeError for out-of-bounds reads; missing/short tables throw Error.
const SFNT = [0x00010000, 0x4f54544f /* OTTO */, 0x74727565 /* true */];
/** @param {DataView} v @param {number} at */
const tag = (v, at) => String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));

/** @param {Uint8Array} bytes @param {string} [file] @returns {FontRecord[]} */
export function parseFont(bytes, file = '') {
  return parse((offset, length) => {
    if (offset + length > bytes.length) throw Error(`Font data out of bounds: ${file}`);
    return new DataView(bytes.buffer, bytes.byteOffset + offset, length);
  }, file);
}

/** @param {Reader} read @param {string} file */
function parse(read, file) {
  const header = read(0, 12);
  if (tag(header, 0) !== 'ttcf') return face(read, 0, 0, file);
  const count = header.getUint32(8), offsets = read(12, 4 * count);
  return Array.from({ length: count }, (_, i) => face(read, offsets.getUint32(4 * i), i, file)).flat();
}

// TTC table offsets are relative to the complete file, not the individual face.
/** @param {Reader} read @param {number} at @param {number} index @param {string} file @returns {FontRecord[]} */
function face(read, at, index, file) {
  const header = read(at, 12);
  if (!SFNT.includes(header.getUint32(0))) throw Error(`Not an sfnt font: ${file}`);
  const count = header.getUint16(4), dir = read(at + 12, 16 * count);
  /** @type {Map<string, { offset: number, length: number }>} */
  const tables = new Map();
  for (let i = 0; i < count; i++) tables.set(tag(dir, 16 * i), { offset: dir.getUint32(16 * i + 8), length: dir.getUint32(16 * i + 12) });
  /** @param {string} name @param {number} min */
  const table = (name, min) => {
    const t = tables.get(name);
    if (!t) return null;
    if (t.length < min) throw Error(`${name} table too short: ${file}`);
    return read(t.offset, t.length);
  };
  /** @param {string} name @param {number} min */
  const required = (name, min) => { const t = table(name, min); if (!t) throw Error(`Missing ${name} table: ${file}`); return t; };

  const unitsPerEm = required('head', 54).getUint16(18);
  if (!unitsPerEm) throw Error(`unitsPerEm is 0: ${file}`);
  const hhea = required('hhea', 36), names = nameTable(required('name', 6));
  // OS/2 tables shorter than 78 bytes (early versions) lack typo and win metrics.
  const os2 = table('OS/2', 0), full = os2 && os2.byteLength >= 78;
  /** @type {FontRecord} */
  const base = {
    file, index,
    postScriptName: names.get(6) ?? '',
    family: names.get(16) ?? names.get(1) ?? '',
    style: names.get(17) ?? names.get(2) ?? '',
    unitsPerEm,
    hhea: { ascender: hhea.getInt16(4), descender: hhea.getInt16(6), lineGap: hhea.getInt16(8) },
    typo: full ? { ascender: os2.getInt16(68), descender: os2.getInt16(70), lineGap: os2.getInt16(72) } : null,
    win: full ? { ascent: os2.getUint16(74), descent: os2.getUint16(76) } : null,
    useTypoMetrics: !!full && (os2.getUint16(62) & 0x80) !== 0,
    weightClass: os2 && os2.byteLength >= 6 ? os2.getUint16(4) : null,
    instance: false,
  };

  // Variable fonts emit an extra record per named instance, reusing the default face family.
  // ponytail: Named instances reuse default-face metrics without MVAR. Fonts whose hhea differs by instance can be inaccurate; apply coordinate-specific MVAR deltas if encountered.
  const fvar = table('fvar', 16), records = [base];
  if (fvar) {
    const axes = fvar.getUint16(8), size = fvar.getUint16(14), withName = size >= axes * 4 + 6;
    for (let i = 0, at = fvar.getUint16(4) + axes * fvar.getUint16(10); i < fvar.getUint16(12); i++, at += size) {
      const id = withName ? fvar.getUint16(at + 4 + axes * 4) : 0xffff;
      records.push({ ...base, postScriptName: id === 0xffff ? '' : names.get(id) ?? '', style: names.get(fvar.getUint16(at)) ?? '', instance: true });
    }
  }
  return records;
}

// Select the highest-priority entry for each name ID: platform 3 English (0x409), other platform 3 languages, platform 0, then platform 1 encoding 0;
// platforms 0/3 use UTF-16BE; platform 1 encoding 0 maps bytes through latin1.
/** @param {DataView} t */
function nameTable(t) {
  const count = t.getUint16(2), strings = t.getUint16(4);
  /** @type {Map<number, { rank: number, at: number, length: number }>} */
  const best = new Map();
  for (let i = 0, r = 6; i < count; i++, r += 12) {
    const platform = t.getUint16(r), id = t.getUint16(r + 6);
    const rank = platform === 3 ? (t.getUint16(r + 4) === 0x409 ? 0 : 1) : platform === 0 ? 2 : platform === 1 && t.getUint16(r + 2) === 0 ? 3 : -1;
    if (rank < 0 || (best.get(id)?.rank ?? 4) <= rank) continue;
    best.set(id, { rank, at: strings + t.getUint16(r + 10), length: t.getUint16(r + 8) });
  }
  /** @type {Map<number, string>} */
  const names = new Map();
  for (const [id, { rank, at, length }] of best) {
    const step = rank < 3 ? 2 : 1;
    let s = '';
    for (let i = 0; i + step <= length; i += step) s += String.fromCharCode(step === 2 ? t.getUint16(at + i) : t.getUint8(at + i));
    names.set(id, s);
  }
  return names;
}

// -- Lookup -------------------------------------------------------------
// Build an index on first lookup for each dirs set and cache it for the process without invalidation. Read by offsets instead of whole files (Apple Color Emoji.ttc is about 180 MB); skip parse failures.
// Traverse directories incrementally, skipping only unreadable branches; a single recursive listing could lose the entire font directory on one permission error. Do not follow directory symlinks.
/** @type {Map<string, { ps: Map<string, FontRecord>, name: Map<string, FontRecord> }>} */
const indexes = new Map();
/** @param {string} family @param {string} style */
const nameKey = (family, style) => `${family}\0${style}`.toLowerCase().replace(/[\s_-]/g, '');

/** @param {{ postScriptName?: string, family?: string, style?: string }} query @param {string[]} [dirs] */
export function findFont({ postScriptName, family, style }, dirs = FONT_DIRS) {
  const key = dirs.join('\0');
  let index = indexes.get(key);
  if (!index) indexes.set(key, index = build(dirs));
  return (postScriptName && index.ps.get(postScriptName)) || (family != null && index.name.get(nameKey(family, style ?? ''))) || null;
}

/** @param {string[]} dirs */
function build(dirs) {
  const index = { ps: new Map(), name: new Map() };
  for (const dir of dirs) {
    /** @type {string[]} */
    const files = [];
    /** @param {string} d */
    const list = d => {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) { const f = path.join(d, e.name); if (e.isDirectory()) list(f); else files.push(f); }
    };
    list(dir);
    for (const file of files.filter(f => /\.(ttf|otf|ttc|otc)$/i.test(f)).sort()) {
      let records;
      try { records = load(file); } catch { continue; }
      for (const r of records) {
        if (r.postScriptName && !index.ps.has(r.postScriptName)) index.ps.set(r.postScriptName, r);
        const k = nameKey(r.family, r.style);
        if (r.family && !index.name.has(k)) index.name.set(k, r);
      }
    }
  }
  return index;
}

/** @param {string} file */
function load(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    return parse((offset, length) => {
      if (offset + length > size) throw Error(`Font data out of bounds: ${file}`);
      const bytes = new Uint8Array(length);
      fs.readSync(fd, bytes, 0, length, offset);
      return new DataView(bytes.buffer);
    }, file);
  } finally { fs.closeSync(fd); }
}
