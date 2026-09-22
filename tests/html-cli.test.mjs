/**
 * [INPUT]: Imports node:test, node:assert/strict, node:fs, node:os, node:path, ./helpers/generate.mjs, ../src/html/page.mjs, ../src/html/overrides.mjs, ../src/html/generate.mjs, ../src/html/match.mjs, ../src/png.mjs, ../src/project.mjs.
 * [OUTPUT]: Node.js test cases and fixture setup for this revision.
 * [POS]: Regression coverage for html cli; tests use local synthetic inputs and isolated state.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extracted, run } from './helpers/generate.mjs';
import { assemble, pageFile, readMeta, readRefs, indexPages, writePage } from '../src/html/page.mjs';
import { loadOverrides } from '../src/html/overrides.mjs';
import { GENERATOR } from '../src/html/generate.mjs';
import { crop } from '../src/html/match.mjs';
import { decodePng, encodePng } from '../src/png.mjs';
import { hash } from '../src/project.mjs';

// -- Fixtures -------------------------------------------------------------
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fac-html-cli-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const tmpdir = () => fs.mkdtempSync(path.join(temp, 'd-'));
// Persist extracted binaries under dir using output file/sha256 descriptors, matching bridge task evidence layout.
const land = (dir, output, bytes) => {
  const walk = v => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (typeof v.file === 'string' && v.sha256 in bytes) { fs.mkdirSync(path.dirname(path.join(dir, v.file)), { recursive: true }); fs.writeFileSync(path.join(dir, v.file), bytes[v.sha256]); }
      else Object.values(v).forEach(walk);
    }
  };
  walk(output);
};
const meta = node => `<!doctype html><html><head><meta charset="utf-8"><meta name="figma-agent-control" content="extract=e; node=${node}; scale=1; overrides=none; generator=g">`;

// -- Page layer -----------------------------------------------------------
test('pageFile sanitizes invalid/control characters and leading dots, defaults empty names to frame, truncates at 120 bytes without splitting emoji, and handles instance chains/long IDs', () => {
  assert.equal(pageFile('a/b:c*?"<>|\\\t\u0001\u007fd', '1:2'), 'a_b_c__________d__1-2.html');
  assert.equal(pageFile('  ..env. ', '1:2'), 'env.__1-2.html');
  for (const name of ['', ' . ', '...']) assert.equal(pageFile(name, '1:2'), 'frame__1-2.html');
  assert.equal(pageFile('a' + '😀'.repeat(40), '1:2'), `a${'😀'.repeat(29)}__1-2.html`, '1 + 29 * 4 = 117 bytes; one more emoji would exceed 120');
  assert.equal(pageFile('\u6309\u94ae', 'I1:2;3:4'), '\u6309\u94ae__I1-2-3-4.html');
  assert.equal(pageFile('Help Center', '5161:70114'), 'Help Center__5161-70114.html');
  const chain = 'I' + Array.from({ length: 41 }, (_, i) => `${i + 1}:${i + 1}`).join(';'), long = pageFile('x'.repeat(120), chain);
  assert.equal(long, `${'x'.repeat(120)}__${hash(chain).slice(0, 12)}.html`);
  assert.ok(Buffer.byteLength(long) <= 200);
});

test('readMeta/readRefs round-trip provenance and ref rectangles from generated HTML, ignore plain HTML, and accept semicolon node IDs', async () => {
  const { output } = await extracted('1:2');
  const r = run(output, { extract: 'e', overrides: { '2:8': { bake: 'ref', note: 'n' }, '3:8': { bake: 'ref', note: 'n' } } });
  assert.equal(r.refs.length, 2);
  assert.deepEqual(readRefs(r.html), r.refs.map(({ node, rect }) => ({ node, rect })));
  assert.deepEqual(readMeta(r.html), { extract: 'e', node: '1:2', scale: 1, overrides: 'none', generator: GENERATOR });
  assert.equal(readMeta('<!doctype html><html><head><title>x</title></head><body></body></html>'), null);
  assert.deepEqual(readRefs(run(output).html), []);
  assert.equal(readMeta(run({ ...output, root: { ...output.root, id: 'I1:2;3:4' } }, { overridesHash: 'abc' }).html)?.node, 'I1:2;3:4');
});

test('assemble reads explicit islands, bitmaps, and references by directory, inlines cropped PNG refs without placeholders, and reuses cache across frames', async () => {
  const { output, bytes } = await extracted('1:3', { islands: ['4:1', '4:15', '4:16', '4:28'] }), dir = tmpdir();
  land(dir, output, bytes);
  // Replace the mock's white reference with unique pixels so incorrect crop coordinates cannot accidentally match.
  const pixels = new Uint8Array(160 * 160 * 4).map((_, i) => i % 4 === 3 ? 255 : (i >> 2) % 251);
  fs.writeFileSync(path.join(dir, output.reference.file), encodePng(160, 160, pixels));
  const cache = new Map(), overrides = { '4:13': { bake: 'ref', note: 'n' } };
  const a = assemble(output, { dir, extract: 'e', overrides, overridesHash: 'abc', cache });
  assert.deepEqual([a.violations, a.result.needsIsland, a.expected, a.html.includes('fac-asset:')], [[], [], { width: 160, height: 160 }, false]);
  assert.equal(cache.size, Object.keys(output.images).length);
  const src = /data-bake="ref"[^>]*><img src="data:image\/png;base64,([^"]+)"/.exec(a.html)[1];
  assert.deepEqual(decodePng(Buffer.from(src, 'base64')).data, crop(pixels, 160, a.result.refs[0].rect));
  // Absolute file descriptors also read correctly; cache hits remain byte-identical.
  const b = assemble({ ...output, reference: { ...output.reference, file: path.join(dir, output.reference.file) } }, { dir, extract: 'e', overrides, overridesHash: 'abc', cache: new Map(cache) });
  assert.equal(b.html, a.html);
});

test('indexPages/writePage recognize top-level meta-bearing HTML, delete renamed pages for the same node before atomic writes, and leave other/unreadable files untouched', async () => {
  const dir = tmpdir(), put = (name, text) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); };
  put('\u65e7\u540d__1-2.html', meta('1:2')); put('\u753b\u677f__1-2.html', meta('1:2') + 'old'); put('\u522b\u7684__1-3.html', meta('1:3')); put('\u8bf4\u660e.html', '<p>\u65e0 meta</p>');
  put('notes.txt', meta('1:2')); put('sub/x__1-2.html', meta('1:2')); put('late__1-2.html', ' '.repeat(16384) + meta('1:2'));
  put('locked__1-2.html', meta('1:2')); fs.chmodSync(path.join(dir, 'locked__1-2.html'), 0);   // No read permission.
  const index = await indexPages(dir);
  assert.deepEqual([...index.keys()].sort(), ['1:2', '1:3']);
  assert.deepEqual(index.get('1:2').sort(), ['\u65e7\u540d__1-2.html', '\u753b\u677f__1-2.html'].sort(), 'Files without metadata in the first 16 KiB or without read access count as no-meta');
  await writePage(dir, '\u753b\u677f__1-2.html', '1:2', meta('1:2') + 'new', index);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['late__1-2.html', 'locked__1-2.html', 'notes.txt', 'sub', '\u522b\u7684__1-3.html', '\u753b\u677f__1-2.html', '\u8bf4\u660e.html'].sort());
  assert.ok(fs.readFileSync(path.join(dir, '\u753b\u677f__1-2.html'), 'utf8').endsWith('new'));
  assert.equal(fs.statSync(path.join(dir, '\u753b\u677f__1-2.html')).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(path.join(dir, 'sub/x__1-2.html')));
  assert.deepEqual(await indexPages(path.join(dir, 'missing')), new Map());
});

// -- Overrides trust boundary ---------------------------------------------
test('loadOverrides reports paths for read/parse errors, invalid node keys, entries, and values, and returns the first 12 SHA-256 digits for valid files', () => {
  const dir = tmpdir(), file = (name, value) => { const f = path.join(dir, name); fs.writeFileSync(f, typeof value === 'string' ? value : JSON.stringify(value)); return f; };
  assert.throws(() => loadOverrides(path.join(dir, 'missing.json')), /^Error: Cannot read --overrides: .*ENOENT/);
  const note = 'n', cases = [
    ['[]', /top level must be an object/], ['{', /Cannot read/], [{ '129-3229': {} }, /\["129-3229"\]: must be a node ID/], [{ '1:2': { '2-8': { note } } }, /\["1:2","2-8"\]: must be a node ID/],
    [{ '1:2': [] }, /\["1:2"\]: group must be an object/], [{ '1:2': { '2:1': 'x' } }, /\["1:2","2:1"\]: entry must be an object/],
    [{ '1:2': { '2:1': { style: { width: '1px' } } } }, /\["1:2","2:1","note"\]: required/], [{ '1:2': { '2:1': { note: ' ' } } }, /"note"\]: required/],
    [{ '1:2': { '2:1': { note, color: 'red' } } }, /"color"\]: unknown key/],
    [{ '1:2': { '2:1': { note, style: { Width: '1px' } } } }, /"style","Width"\]: property name/], [{ '1:2': { '2:1': { note, basis: { width: '1px;color:red' } } } }, /"basis","width"\]: value must be a string/],
    [{ '1:2': { '2:1': { note, style: { width: 1 } } } }, /"style","width"\]: value must be a string/], [{ '1:2': { '2:1': { note, style: { top: 'a}b' } } } }, /without ;\{\}, newlines/],
    [{ '1:2': { '2:1': { note, style: { top: 'a\nb' } } } }, /without ;\{\}, newlines/], [{ '1:2': { '2:1': { note, style: [] } } }, /"style"\]: must be an object/],
    // CSS forms that swallow later declarations, verified in Chrome, and external resources.
    ...['1px\\', 'translate(1px,2px) /*', '1px "', "1px '", 'url(x)', 'calc(1px', '1px)', '[a'].map(v => [{ '1:2': { '2:1': { note, basis: { transform: v } } } }, /"basis","transform"\]: value must be a string without .*with balanced brackets/]),
    [{ '1:2': { '2:1': { note, skip: 'yes' } } }, /"skip"\]: must be a boolean/], [{ '1:2': { '2:1': { note, bake: 'png' } } }, /"bake"\]: only "svg" or "ref" is accepted/],
    [{ '1:2': { '2:1': { note, bake: 'ref', skip: true } } }, /"bake"\]: a "ref" entry may only also have note/], [{ '1:2': { '2:1': { note, bake: 'ref', style: {} } } }, /may only also have note/]];
  for (const [value, message] of cases) {
    assert.throws(() => loadOverrides(file('bad.json', value)), error => /^(Invalid --overrides|Cannot read --overrides): /.test(error.message) && message.test(error.message), JSON.stringify(value));
  }
  const good = { '1:2': { '2:1': { note, bake: 'ref' }, '2:2': { note, bake: 'svg' }, '2:3': { note, skip: true },
    '2:4': { note, style: { transform: 'translate(1px,2px)', '-webkit-mask': '', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.2))' }, basis: { transform: '' } } }, 'I1:3;4:5': { 'I1:3;4:5;6:7': { note } } };
  const f = file('good.json', good), { groups, sha } = loadOverrides(f);
  assert.deepEqual([groups, sha], [good, hash(fs.readFileSync(f)).slice(0, 12)]);
});
