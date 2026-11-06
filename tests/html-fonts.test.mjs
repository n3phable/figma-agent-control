/**
 * [INPUT]: src/html/fonts parseFont/findFont; handwritten minimal sfnt/TTC bytes; local Kanit when available.
 * [OUTPUT]: No exports; node:test cases.
 * [POS]: Font metric tests cover metric fields, missing/short OS/2, name-platform priority and IDs 16/17, fvar named instances, TTC faces, truncation, and missing tables. Temporary-directory lookup covers PostScript and normalized family/style, unreadable directories/bad files, first-match precedence, and process-local caching. Deletes only test-owned directories.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFont, findFont } from '../src/html/fonts.mjs';

// -- Synthetic sfnt -------------------------------------------------------
// Align tables to 4 bytes after the directory and use zero checksums, which parsing ignores. base is the face offset; TTC table offsets are relative to the entire file.
const block = (size, fill) => { const bytes = new Uint8Array(size); fill(new DataView(bytes.buffer)); return bytes; };
const head = (upm = 1000, size = 54) => block(size, v => v.setUint16(18, upm));
const hhea = ([ascender, descender, lineGap]) => block(36, v => { v.setInt16(4, ascender); v.setInt16(6, descender); v.setInt16(8, lineGap); });
const os2 = ({ weight = 400, fsSelection = 0, typo = [0, 0, 0], win = [0, 0], size = 78 } = {}) => block(size, v => {
  v.setUint16(4, weight);
  if (size < 78) return;
  v.setUint16(62, fsSelection);
  typo.forEach((x, i) => v.setInt16(68 + 2 * i, x));
  win.forEach((x, i) => v.setUint16(74 + 2 * i, x));
});
// name records: [platform, encoding, language, name ID, text]; platform 1 uses single-byte encoding, others UTF-16BE.
const utf16 = s => block(2 * s.length, v => { for (let i = 0; i < s.length; i++) v.setUint16(2 * i, s.charCodeAt(i)); });
const name = records => {
  const strings = records.map(([platform, , , , s]) => platform === 1 ? Uint8Array.from(s, c => c.charCodeAt(0)) : utf16(s));
  const start = 6 + 12 * records.length, bytes = new Uint8Array(start + strings.reduce((n, s) => n + s.length, 0)), v = new DataView(bytes.buffer);
  v.setUint16(2, records.length); v.setUint16(4, start);
  let offset = 0;
  records.forEach(([platform, encoding, language, id], i) => {
    [platform, encoding, language, id, strings[i].length, offset].forEach((x, k) => v.setUint16(6 + 12 * i + 2 * k, x));
    bytes.set(strings[i], start + offset); offset += strings[i].length;
  });
  return bytes;
};
const win = (id, s, language = 0x409) => [3, 1, language, id, s];
const mac = (id, s) => [1, 0, 0, id, s];
// fvar instances are [subfamilyNameID, postScriptNameID?]; withName=false omits the postScriptNameID field.
const fvar = (axes, instances, withName = true) => {
  const size = axes * 4 + (withName ? 6 : 4);
  return block(16 + 20 * axes + size * instances.length, v => {
    [1, 0, 16, 2, axes, 20, instances.length, size].forEach((x, k) => v.setUint16(2 * k, x));
    instances.forEach(([sub, ps], i) => {
      const at = 16 + 20 * axes + size * i;
      v.setUint16(at, sub);
      if (withName) v.setUint16(at + 4 + 4 * axes, ps ?? 0xffff);
    });
  });
};
const tables = ({ family = 'Test', style = 'Regular', ps = 'Test-Regular', upm = 1000, metrics = [800, -200, 0], os2: o = {}, names = [], extra = {} } = {}) =>
  ({ head: head(upm), hhea: hhea(metrics), 'OS/2': os2(o), name: name([win(1, family), win(2, style), win(6, ps), ...names]), ...extra });
const sfnt = (t, { base = 0, version = 0x00010000 } = {}) => {
  const entries = Object.entries(t).filter(([, bytes]) => bytes), pad = n => (n + 3) & ~3, dir = 12 + 16 * entries.length;
  const bytes = new Uint8Array(entries.reduce((n, [, b]) => n + pad(b.length), dir)), v = new DataView(bytes.buffer);
  v.setUint32(0, version); v.setUint16(4, entries.length);
  let at = dir;
  entries.forEach(([tag, b], i) => {
    for (let k = 0; k < 4; k++) v.setUint8(12 + 16 * i + k, tag.charCodeAt(k));
    v.setUint32(12 + 16 * i + 8, base + at); v.setUint32(12 + 16 * i + 12, b.length);
    bytes.set(b, at); at += pad(b.length);
  });
  return bytes;
};
const ttc = list => {
  let at = 12 + 4 * list.length;
  const fonts = list.map(t => { const f = sfnt(t, { base: at }); at += f.length; return f; });
  const bytes = new Uint8Array(at), v = new DataView(bytes.buffer);
  v.setUint32(0, 0x74746366); v.setUint32(4, 0x00010000); v.setUint32(8, list.length);
  at = 12 + 4 * list.length;
  fonts.forEach((f, i) => { v.setUint32(12 + 4 * i, at); bytes.set(f, at); at += f.length; });
  return bytes;
};
const one = (t, file) => { const records = parseFont(sfnt(t), file); assert.equal(records.length, 1); return records[0]; };

// -- Parsing --------------------------------------------------------------
test('Parse unitsPerEm, hhea, typo, win, USE_TYPO_METRICS, and OTTO/true versions; missing or short OS/2 yields null typo/win', () => {
  const kanit = { upm: 1000, metrics: [1100, -395, 0], os2: { weight: 300, fsSelection: 0xc0, typo: [1100, -395, 0], win: [1180, 400] } };
  assert.deepEqual(one(tables(kanit), '/fonts/a.ttf'), {
    file: '/fonts/a.ttf', index: 0, postScriptName: 'Test-Regular', family: 'Test', style: 'Regular', unitsPerEm: 1000,
    hhea: { ascender: 1100, descender: -395, lineGap: 0 }, typo: { ascender: 1100, descender: -395, lineGap: 0 }, win: { ascent: 1180, descent: 400 },
    useTypoMetrics: true, weightClass: 300, instance: false,
  });
  // Bit 6 alone (REGULAR) does not enable USE_TYPO_METRICS.
  const sf = one(tables({ upm: 2048, metrics: [1950, -494, 0], os2: { fsSelection: 0x40, typo: [1536, -512, 102], win: [1950, 494] } }));
  assert.deepEqual([sf.unitsPerEm, sf.hhea, sf.typo, sf.win, sf.useTypoMetrics, sf.file],
    [2048, { ascender: 1950, descender: -494, lineGap: 0 }, { ascender: 1536, descender: -512, lineGap: 102 }, { ascent: 1950, descent: 494 }, false, '']);
  for (const version of [0x4f54544f, 0x74727565]) assert.equal(parseFont(sfnt(tables(), { version }))[0].unitsPerEm, 1000);

  const bare = one({ ...tables(), 'OS/2': null });
  assert.deepEqual([bare.typo, bare.win, bare.useTypoMetrics, bare.weightClass], [null, null, false, null]);
  const short = one(tables({ os2: { weight: 500, size: 68 } }));
  assert.deepEqual([short.typo, short.win, short.useTypoMetrics, short.weightClass], [null, null, false, 500]);
});

test('Name priority is platform 3 English, other platform 3, platform 0, then platform 1 regardless of order; IDs 16/17 precede 1/2, platform 1 is latin1, and absent ID 6 is empty', () => {
  const pick = names => one({ ...tables(), name: name(names) });
  assert.equal(pick([mac(1, 'Mac'), win(1, 'Win')]).family, 'Win', 'Platform 3 wins over platform 1');
  assert.equal(pick([win(1, '\u4e2d\u6587', 0x804), win(1, 'English')]).family, 'English');
  assert.equal(pick([[0, 3, 0, 1, 'Unicode'], win(1, '\u4e2d\u6587', 0x804)]).family, '\u4e2d\u6587');
  assert.equal(pick([mac(1, 'Mac'), [0, 3, 0, 1, 'Unicode'], [2, 0, 0, 1, 'ISO']]).family, 'Unicode', 'Platform 2 is ignored');
  assert.equal(pick([mac(1, 'Café')]).family, 'Café');
  assert.equal(pick([[1, 1, 11, 1, 'Japanese']]).family, '', 'Platform 1 accepts only encoding 0');

  const typographic = pick([win(1, 'Fam Semibold'), win(2, 'Regular'), win(16, 'Fam'), win(17, 'Semibold'), win(6, 'Fam-Semibold')]);
  assert.deepEqual([typographic.family, typographic.style, typographic.postScriptName], ['Fam', 'Semibold', 'Fam-Semibold']);
  assert.equal(pick([win(1, 'Fam')]).postScriptName, '');
});

test('fvar returns the default face then named instances sharing family/metrics; missing or 0xFFFF PostScript IDs yield empty names', () => {
  const names = [win(256, 'Medium'), win(257, 'Var-Medium'), win(258, 'Bold')];
  const records = parseFont(sfnt(tables({ family: 'Var', ps: 'Var-Regular', names, extra: { fvar: fvar(3, [[256, 257], [258, 0xffff]]) } })));
  assert.deepEqual(records.map(r => [r.postScriptName, r.family, r.style, r.instance]),
    [['Var-Regular', 'Var', 'Regular', false], ['Var-Medium', 'Var', 'Medium', true], ['', 'Var', 'Bold', true]]);
  assert.deepEqual(records[1].hhea, records[0].hhea);
  const unnamed = parseFont(sfnt(tables({ names, extra: { fvar: fvar(2, [[256], [258]], false) } })));
  assert.deepEqual(unnamed.map(r => [r.postScriptName, r.style]), [['Test-Regular', 'Regular'], ['', 'Medium'], ['', 'Bold']]);
});

test('TTC faces have ordered indexes and file-relative table offsets', () => {
  const records = parseFont(ttc([tables({ family: 'A', ps: 'A-Regular' }), tables({ family: 'B', ps: 'B-Bold', style: 'Bold', metrics: [900, -300, 10] })]), 'x.ttc');
  assert.deepEqual(records.map(r => [r.index, r.family, r.style, r.postScriptName, r.hhea.ascender, r.hhea.lineGap, r.file]),
    [[0, 'A', 'Regular', 'A-Regular', 800, 0, 'x.ttc'], [1, 'B', 'Bold', 'B-Bold', 900, 10, 'x.ttc']]);
});

test('Reject non-sfnt data, missing head/hhea/name, short tables, truncated files, and out-of-bounds TTC faces', () => {
  const bytes = sfnt(tables());
  assert.throws(() => parseFont(new TextEncoder().encode('wOFF0000000000000000')), /Not an sfnt/);
  assert.throws(() => parseFont(bytes.subarray(0, 8)), /out of bounds/);
  for (const tag of ['head', 'hhea', 'name']) assert.throws(() => parseFont(sfnt({ ...tables(), [tag]: null })), new RegExp(`Missing ${tag} table`));
  assert.throws(() => parseFont(sfnt({ ...tables(), head: head(1000, 20) })), /head table too short/);
  assert.throws(() => parseFont(sfnt({ ...tables(), head: head(0) })), /unitsPerEm/);
  assert.throws(() => parseFont(bytes.subarray(0, bytes.length - 8)), /out of bounds/);
  assert.throws(() => parseFont(ttc([tables(), tables()]).subarray(0, 40)));
});

// -- Lookup ---------------------------------------------------------------
test('findFont matches exact PostScript or normalized family/style, recurses, skips unreadable directories/bad files, takes first duplicates, and caches its index per process', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fac-fonts-')), locked = path.join(tmp, 'a', 'locked');
  try {
    const a = path.join(tmp, 'a'), b = path.join(tmp, 'b');
    const put = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
    put(path.join(a, 'MyFam.ttf'), sfnt(tables({ family: 'My Fam', style: 'Semi Bold', ps: 'MyFam-SemiBold', metrics: [1, -1, 0] })));
    put(path.join(a, 'broken.ttf'), new TextEncoder().encode('not a font'));
    put(path.join(a, 'notes.txt'), sfnt(tables({ ps: 'Ignored-Regular' })));
    put(path.join(a, 'z.otf'), sfnt(tables({ family: 'Same', ps: 'Same-Regular', metrics: [3, -3, 0] })));
    put(path.join(a, 'm.otf'), sfnt(tables({ family: 'Same', ps: 'Same-Regular', metrics: [2, -2, 0] })));
    put(path.join(a, 'deep', 'Var.TTC'), ttc([tables({ family: 'Other', ps: 'Other-Regular' }), tables({
      family: 'Var', ps: 'Var-Regular', names: [win(256, 'Regular'), win(257, 'Var-Regular'), win(258, 'Heavy'), win(259, 'Var-Heavy')],
      extra: { fvar: fvar(1, [[256, 257], [258, 259]]) } })]));
    put(path.join(b, 'MyFam.ttf'), sfnt(tables({ family: 'My Fam', style: 'Semi Bold', ps: 'MyFam-SemiBold', metrics: [9, -9, 0] })));
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0);
    const dirs = [a, path.join(tmp, 'missing'), b];

    const hit = findFont({ postScriptName: 'MyFam-SemiBold' }, dirs);
    assert.deepEqual([hit?.file, hit?.hhea.ascender], [path.join(a, 'MyFam.ttf'), 1], 'Directories follow supplied order');
    assert.equal(findFont({ family: 'myfam', style: 'semi-bold' }, dirs), hit);
    assert.equal(findFont({ family: 'MY_FAM', style: 'SemiBold' }, dirs), hit);
    assert.equal(findFont({ postScriptName: 'Nope', family: 'My Fam', style: 'Semi Bold' }, dirs), hit, 'Fall back to family/style when PostScript does not match');
    assert.equal(findFont({ postScriptName: 'myfam-semibold' }, dirs), null, 'PostScript names are case-sensitive');
    assert.equal(findFont({ family: 'Nope', style: 'Regular' }, dirs), null);
    assert.equal(findFont({}, dirs), null);
    assert.equal(findFont({ postScriptName: 'Ignored-Regular' }, dirs), null, 'Only ttf/otf/ttc/otc files count');
    assert.equal(findFont({ postScriptName: 'Same-Regular' }, dirs)?.hhea.ascender, 2, 'Paths sort within a directory, so m precedes z');

    const heavy = findFont({ postScriptName: 'Var-Heavy' }, dirs);
    assert.deepEqual([heavy?.file, heavy?.index, heavy?.style, heavy?.instance], [path.join(a, 'deep', 'Var.TTC'), 1, 'Heavy', true]);
    assert.equal(findFont({ postScriptName: 'Var-Regular' }, dirs)?.instance, false, 'A default face precedes same-named instances');
    assert.equal(findFont({ family: 'Var', style: 'Regular' }, dirs)?.instance, false);

    assert.equal(findFont({ postScriptName: 'MyFam-SemiBold' }, [b, a])?.hhea.ascender, 9, 'Different directory order creates a separate index');
    fs.chmodSync(locked, 0o755);
    fs.rmSync(a, { recursive: true });
    assert.equal(findFont({ postScriptName: 'MyFam-SemiBold' }, dirs), hit, 'A deleted file still matches the cached index');
  } finally { if (fs.existsSync(locked)) fs.chmodSync(locked, 0o755); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('Local Kanit matches the same record by PostScript and family/style, with file-consistent metrics', t => {
  const kanit = findFont({ postScriptName: 'Kanit-Light' });
  if (!kanit) return t.skip('Kanit is not installed locally');
  assert.deepEqual([kanit.family, kanit.style, kanit.unitsPerEm, kanit.hhea, kanit.typo, kanit.win, kanit.useTypoMetrics],
    ['Kanit', 'Light', 1000, { ascender: 1100, descender: -395, lineGap: 0 }, { ascender: 1100, descender: -395, lineGap: 0 }, { ascent: 1180, descent: 400 }, true]);
  assert.equal(findFont({ family: 'Kanit', style: 'Light' }), kanit);
});
