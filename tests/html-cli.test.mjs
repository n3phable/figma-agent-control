/**
 * [INPUT]: Imports node:test, node:assert/strict, node:fs, node:os, node:path, node:crypto, node:child_process, node:util, node:perf_hooks, node:timers/promises, ./helpers/generate.mjs, ./helpers/doc.mjs, ./helpers/harness.mjs, ../src/html/command.mjs, ../src/html/page.mjs, ../src/html/overrides.mjs, ../src/html/summary.mjs, ../src/html/chrome.mjs, ../src/html/generate.mjs, ../src/html/match.mjs, ../src/args.mjs, ../src/bridge.mjs, ../src/client.mjs, ../src/record.mjs, ../src/session.mjs, ../src/png.mjs, ../src/project.mjs.
 * [OUTPUT]: Node.js test cases and fixture setup for this revision.
 * [POS]: Regression coverage for html cli; tests use local synthetic inputs and isolated state.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { extracted, run } from './helpers/generate.mjs';
import { extractDoc } from './helpers/doc.mjs';
import { harness, cliFile } from './helpers/harness.mjs';
import { html, htmlCheck, glassDefaults } from '../src/html/command.mjs';
import { assemble, pageFile, readMeta, readRefs, indexPages, writePage } from '../src/html/page.mjs';
import { loadOverrides } from '../src/html/overrides.mjs';
import { quote } from '../src/html/summary.mjs';
import { findChrome } from '../src/html/chrome.mjs';
import { GENERATOR } from '../src/html/generate.mjs';
import { crop } from '../src/html/match.mjs';
import { parse } from '../src/args.mjs';
import { start } from '../src/bridge.mjs';
import { call } from '../src/client.mjs';
import { waitForResult } from '../src/record.mjs';
import { pairingToken, NOT_DELIVERED, ABANDONED } from '../src/session.mjs';
import { decodePng, encodePng } from '../src/png.mjs';
import { hash, init, root } from '../src/project.mjs';

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

// -- GLASS defaults: pure function ----------------------------------------
test('glassDefaults lists visible library-bound GLASS nodes with all-default parameters in preorder, excluding nondefault, unbound, and hidden nodes', async () => {
  assert.deepEqual(glassDefaults((await extracted('1:2')).output.root), ['3:1']);
  assert.equal(glassDefaults((await extracted('1:3')).output.root).includes('4:23'), false, '4:23 has radius 6');
  const g = extra => ({ id: '1:1', effects: [{ type: 'GLASS', visible: true, radius: 0, refraction: 0, lightAngle: 0, lightIntensity: 0, dispersion: 0, boundVariables: { radius: {} }, ...extra }] });
  assert.deepEqual(glassDefaults(g()), ['1:1'], 'Missing splay/depth keys use defaults');
  for (const extra of [{ boundVariables: {} }, { boundVariables: undefined }, { splay: 0.2 }, { depth: 30 }, { visible: false }]) assert.deepEqual(glassDefaults(g(extra)), [], JSON.stringify(extra));
});

// -- Command fixtures -----------------------------------------------------
// Bind project to page 1:1 so frames 1:2 and 1:3 are in scope. landRun builds runs/<id> with job/result or recovery JSON and persisted binaries.
const URL1 = 'https://www.figma.com/design/example/Test?node-id=1-1';
const project = async () => { const cwd = tmpdir(); await init(cwd, URL1); return cwd; };
async function landRun(cwd, { node = '1:2', id = randomUUID(), job = {}, result = undefined, recovery = undefined } = {}) {
  const { output, bytes } = await extracted(node), dir = path.join(root(cwd), 'runs', id), finishedAt = new Date().toISOString();
  fs.mkdirSync(dir, { recursive: true });
  land(dir, output, bytes);
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ id, operation: 'extract', targetNodeId: node, state: 'done', risk: { level: 'normal' }, ...job }));
  if (recovery) fs.writeFileSync(path.join(dir, 'recovery.json'), JSON.stringify(recovery));
  else if (result !== null) fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(typeof result === 'function' ? { id, ok: true, output: result(output), finishedAt } : result ?? { id, ok: true, output, finishedAt }));
  return { id, dir, output };
}
// Normalize options through args exactly as bin does before dispatch.
const args = (...argv) => parse(['html', ...argv]).options;
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const manifestOf = out => readJson(path.join(out, 'html.json'));
const runIds = cwd => { const dir = path.join(root(cwd), 'runs'); return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []; };
const quiet = { stderr: () => {} };
const exec = promisify(execFile);

// ── --from ───────────────────────────────────────────────────────────────
test('--from persists pages/html.json byte-identical to assemble, marks fonts missing in Figma, and exits 0 without verdicts under --no-check', async () => {
  const cwd = await project(), out = path.join(cwd, 'out');
  const mark = node => { if (node.id === '2:15') node.hasMissingFont = true; node.children?.forEach(mark); };
  const { id, dir } = await landRun(cwd, { result: output => { mark(output.root); return output; } }), { output } = readJson(path.join(dir, 'result.json'));
  const r = await html(cwd, args('--from', id, '--out', out, '--no-check'), quiet);
  const file = path.join(out, '\u753b\u677f__1-2.html'), text = fs.readFileSync(file, 'utf8'), m = manifestOf(out), f = m.frames[0];
  assert.deepEqual([readMeta(text).extract, text === assemble(output, { dir, extract: id }).html, text.includes('fac-asset:')], [id, true, false]);
  assert.deepEqual([f.node, f.name, f.source, f.extract, f.html, f.size], ['1:2', '\u753b\u677f', 'from', id, file, { width: 160, height: 160 }]);
  assert.deepEqual([Object.keys(f.ms), typeof f.approximations.glass], [['extract', 'generate', 'write', 'check'], 'number']);
  assert.deepEqual(f.fonts.filter(x => x.figmaMissing).map(x => `${x.family} ${x.style}`).sort(), ['Kanit Light', 'Kanit Regular']);
  assert.ok(f.fonts.length > 2 && f.fonts.every(x => typeof x.figmaMissing === 'boolean' && !('face' in x)));
  for (const key of ['verdict', 'check', 'top', 'suggest', 'extracts', 'needsExtract']) assert.equal(key in f, false, key);
  assert.deepEqual(['browser' in m, typeof m.ms.fontIndex, m.done, m.pending, m.remaining, m.overrides, m.exitCode, r.exitCode], [false, 'number', [id], [], [], 'none', 0, 0]);
  assert.deepEqual(r.summary.frames.map(x => [x.node, x.verdict]), [['1:2', undefined]]);
  assert.deepEqual([r.summary.summary, 'done' in r.summary], [path.join(out, 'html.json'), false]);
  // Mock 3:1 has a library-bound GLASS with default parameters: warnings/guidance leave exit code unchanged, and per-node approximation counts also exist under --no-check.
  assert.deepEqual([f.glassDefaults, f.warnings.filter(w => /^GLASS parameters are all defaults while bound to library variables \(1 node\(s\), e\.g\. 3:1\)/.test(w)).length], [['3:1'], 1]);
  // Batch commands re-extract default-only GLASS frames with --node instead of rereading the same --from task.
  assert.match(r.summary.instruction, /^Some frames have all-default GLASS parameters \(glassDefaults\): .*the command below re-extracts these frames with --node\. Then run figma-agent-control html --node '1:2' --out [^ ]+ --no-check$/);
  assert.deepEqual(Object.entries(f.approximations).sort(), Object.entries(f.approximationNodes.reduce((n, a) => ({ ...n, [a.kind]: (n[a.kind] ?? 0) + 1 }), {})).sort());
});

test('--from frame records include stub-check font status/substitution, structure/layout counts, and ordered structure/font/GLASS guidance with exit 0', async () => {
  const cwd = await project(), { id } = await landRun(cwd), out = path.join(cwd, 'out'), white = encodePng(160, 160, new Uint8Array(160 * 160 * 4).fill(255));
  // The first face is unloaded; the page contains only the frame and one untracked node.
  const evaluate = async () => ({ ids: [], names: [], rects: [], facts: {}, faces: { f0: { status: 'error', names: ['SFProText-Bold'] } }, els: [{ node: '2:9', face: 'f0', chars: 3 }],
    nodes: ['1:2', '0:0'], texts: {} });
  const launch = async () => ({ version: 'Fake/1', close: async () => {}, page: async () => ({ browser: { version: 'Fake/1' }, open: async () => {}, shot: async () => white, evaluate, close: async () => {} }) });
  const r = await html(cwd, args('--from', id, '--out', out), { ...quiet, launch }), m = manifestOf(out), f = m.frames[0];
  assert.deepEqual([f.verdict, f.layout, f.structure.untracked, f.structure.missing > 0, f.structure.textMismatch, 'cause' in f], ['pass-with-findings', {}, 1, true, 0, false]);
  assert.deepEqual([f.fonts[0].postScriptName, f.fonts[0].status, f.fonts[0].substituted, f.fonts.slice(1).every(x => x.substituted === false && !('status' in x))], ['SFProText-Bold', 'error', true, true]);
  assert.deepEqual([m.totals.fonts[0].postScriptName, m.totals.fonts[0].substituted, r.exitCode], ['SFProText-Bold', true, 0]);
  assert.match(r.summary.instruction, /^Page has data-node elements outside the extract tree \(untracked\).*\. Page is missing nodes or its text differs from Figma.*\. Local fonts do not match the declared fonts: SF Pro Text Bold \(SFProText-Bold -> not loaded\).*\. Some frames have all-default GLASS parameters/);
  // White reference and screenshot have no pixel differences or top entries; all five backdrop-dependent clusters in mock 1:2 remain idle.
  assert.deepEqual([f.top, f.suggest, f.clusters.map(c => [c.target, c.outcome]), f.hints], [[], [], ['3:1', '3:4', '3:5', '3:6', '3:8'].map(t => [t, 'idle']), []]);
});

test('Preflight rejects bad overrides, hyphen keys, 501 SVG bakes, non-extract or non-1x evidence, missing tasks, and duplicate --from/--node before output creation or submission', async () => {
  const cwd = await project(), out = path.join(cwd, 'out'), { id } = await landRun(cwd);
  const inspect = (await landRun(cwd, { job: { operation: 'inspect' } })).id, scaled = (await landRun(cwd, { job: { scale: 2 } })).id;
  const file = (name, value) => { const f = path.join(cwd, name); fs.writeFileSync(f, typeof value === 'string' ? value : JSON.stringify(value)); return f; };
  const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`5:${i}`, { bake: 'svg', note: 'n' }])), runs = runIds(cwd);
  for (const [argv, message] of [
    [['--from', id, '--overrides', file('bad.json', '{')], /^Cannot read --overrides: /],
    [['--from', id, '--overrides', file('dash.json', { '1-2': {} })], /^Invalid --overrides: \["1-2"\]: must be a node ID/],
    [['--node', '1:3', '--overrides', file('many.json', { '1:3': many })], /^Invalid --overrides: \["1:3"\]: 501 bake:"svg" entries, at most 500 per frame/],
    [['--from', inspect], new RegExp(`^--from only accepts extract jobs: ${inspect} is inspect$`)],
    [['--from', scaled], new RegExp(`^--from only accepts extracts with scale 1: ${scaled} has scale 2$`)],
    [['--from', randomUUID()], /^--from job does not exist or its evidence is incomplete: /],
    [['--from', id, '--node', '1-2'], /^Same frame given twice: 1:2$/],
  ]) await assert.rejects(html(cwd, args(...argv, '--out', out), quiet), error => message.test(error.message), argv.join(' '));
  assert.deepEqual([fs.existsSync(out), runIds(cwd)], [false, runs]);
});

test('overrides apply current-frame groups, validate other groups, expose stale entries, inline ref PNGs, fingerprint metadata, and exit 1', async () => {
  const cwd = await project(), { id, dir, output } = await landRun(cwd), out = path.join(cwd, 'out'), file = path.join(cwd, 'o.json');
  const group = { '2:15': { style: { opacity: '0.5' }, note: 'n' }, '9:99': { style: { opacity: '0' }, note: 'n' }, '2:8': { bake: 'ref', note: 'n' }, '1:2': { bake: 'ref', note: 'n' } };
  fs.writeFileSync(file, JSON.stringify({ '1:2': group, '9:9': { '9:10': { skip: true, note: 'n' } } }));
  const r = await html(cwd, args('--from', id, '--out', out, '--overrides', file, '--no-check'), quiet);
  const m = manifestOf(out), f = m.frames[0], sha = hash(fs.readFileSync(file)).slice(0, 12), page = fs.readFileSync(f.html, 'utf8');
  const byNode = list => [...list].sort((a, b) => (a.node ?? a).localeCompare(b.node ?? b));
  assert.deepEqual([byNode(f.overrides.applied), byNode(f.overrides.stale)], [['2:15', '2:8'], [{ node: '1:2', kind: 'invalid', reason: 'root' }, { node: '9:99', kind: 'missing' }]]);
  const expected = assemble(output, { dir, extract: id, overrides: group, overridesHash: sha });
  assert.deepEqual([f.refs.map(x => x.rect), readRefs(page).map(x => x.rect)], [expected.result.refs.map(x => x.rect), expected.result.refs.map(x => x.rect)]);
  const src = /data-bake="ref"[^>]*><img src="data:image\/png;base64,([^"]+)"/.exec(page)[1], ref = decodePng(fs.readFileSync(path.join(dir, output.reference.file)));
  assert.deepEqual(decodePng(Buffer.from(src, 'base64')).data, crop(ref.data, ref.width, f.refs[0].rect));
  assert.deepEqual([readMeta(page).overrides, m.overrides, r.exitCode, m.totals.stale], [sha, { file, sha }, 1, 2]);
  assert.deepEqual(byNode(r.summary.frames[0].stale.map(x => x.node)), ['1:2', '9:99']);
  assert.match(r.summary.instruction, /^Some frames have all-default GLASS parameters \(glassDefaults\): .*re-extracts these frames with --node\. Stale overrides entries were not applied/);
  assert.ok(r.summary.instruction.endsWith(`--node '1:2' --overrides ${quote(file)} --out ${quote(out)} --no-check`), r.summary.instruction);
});

test('--from missing Figma islands still writes a needsExtract page, exits 1, and suggests --node re-extraction', async () => {
  const cwd = await project(), { id } = await landRun(cwd, { node: '1:3' }), out = path.join(cwd, 'out');
  const r = await html(cwd, args('--from', id, '--out', out, '--no-check'), quiet), m = manifestOf(out), f = m.frames[0];
  assert.deepEqual([f.needsIsland, f.needsExtract, fs.existsSync(f.html), m.done, m.totals.needsIsland, r.exitCode], [['4:1', '4:15', '4:16', '4:28'], true, true, [id], 1, 1]);
  assert.deepEqual([/Then run .* --node '1:3'/.test(r.summary.instruction), /--from '/.test(r.summary.instruction)], [true, false]);
});

test('Output directories use 0700; only same-node renamed pages are deleted, same names overwrite, and no-meta/other-node/non-HTML files remain', async () => {
  const cwd = await project(), { id } = await landRun(cwd), out = path.join(cwd, 'deep', 'out');
  await html(cwd, args('--from', id, '--out', out, '--no-check'), quiet);
  assert.deepEqual([fs.statSync(out).mode & 0o777, fs.statSync(path.join(out, 'html.json')).mode & 0o777], [0o700, 0o600]);
  const put = (name, text) => fs.writeFileSync(path.join(out, name), text);
  put('\u65e7\u540d__1-2.html', meta('1:2')); put('\u8bf4\u660e.html', '<p>\u65e0 meta</p>'); put('\u522b\u7684__1-3.html', meta('1:3')); put('\u753b\u677f__1-2.html', meta('1:2') + 'old'); put('notes.txt', 'n');
  await html(cwd, args('--from', id, '--out', out, '--no-check'), quiet);
  assert.deepEqual(fs.readdirSync(out).sort(), ['html.json', 'notes.txt', '\u522b\u7684__1-3.html', '\u753b\u677f__1-2.html', '\u8bf4\u660e.html'].sort());
  assert.deepEqual([readMeta(fs.readFileSync(path.join(out, '\u753b\u677f__1-2.html'), 'utf8')).extract, fs.readFileSync(path.join(out, '\u522b\u7684__1-3.html'), 'utf8')], [id, meta('1:3')]);
});

test('Unusable --from tasks classify interruptions as remaining/exit 2, deterministic failures as nonretryable errors/exit 1, running jobs as pending, and corrupt evidence per frame', async () => {
  const cwd = await project(), out = path.join(cwd, 'out');
  const go = (...ids) => html(cwd, args(...ids.flatMap(id => ['--from', id]), '--out', out, '--no-check'), quiet);
  const failed = error => ({ result: id => ({ id, ok: false, executionStarted: false, error, finishedAt: 'x' }) });
  const land = async ({ result, ...rest } = {}) => { const id = randomUUID(); await landRun(cwd, { id, ...rest, ...(result ? { result: result(id) } : {}) }); return id; };
  for (const id of [await land({ job: { state: 'running' }, recovery: { status: 'unknown-after-disconnect' } }), await land(failed(ABANDONED)), await land(failed(NOT_DELIVERED))]) {
    const r = await go(id), m = manifestOf(out);
    assert.deepEqual([m.frames.map(f => [f.extract, f.error?.code]), m.remaining, m.done, r.exitCode], [[[id, 'EXTRACT_INTERRUPTED']], ['1:2'], [], 2], id);
    assert.match(r.summary.instruction, /^Interrupted extracts are re-extracted with --node; run figma-agent-control html --node '1:2' --out /);
    assert.doesNotMatch(r.summary.instruction, /wait/);
  }
  const over = await land(failed('\u7ed3\u6784\u5316\u7ed3\u679c\u8d85\u8fc7\u4e0a\u9650')), r = await go(over), m = manifestOf(out);
  assert.deepEqual([m.frames[0].error, m.done, m.pending, m.remaining, r.exitCode], [{ code: 'EXTRACT_FAILED', message: '\u7ed3\u6784\u5316\u7ed3\u679c\u8d85\u8fc7\u4e0a\u9650' }, [], [], [], 1]);
  assert.match(r.summary.instruction, /^For frames with errors, see error in html\.json; the command below re-extracts frames that have no page\. Then run figma-agent-control html --node '1:2' --out /);
  const queued = await land({ node: '1:3', job: { state: 'queued' }, result: () => null }), ok = await land();
  const both = await go(queued, ok), mb = manifestOf(out);
  assert.deepEqual([mb.pending, mb.done, mb.frames.map(f => f.node), both.exitCode], [[queued], [ok], ['1:2'], 2]);
  // Default-only GLASS on 1:2 resumes with --node re-extraction rather than rereading the same --from task.
  assert.equal(both.summary.instruction, `First run figma-agent-control wait ${queued}, then run figma-agent-control html --from ${quote(queued)} --node '1:2' --out ${quote(out)} --no-check`);
  const broken = await land({ node: '1:3', result: () => ({ id: randomUUID(), ok: true, output: {} }) }), mixed = await go(broken, ok), mm = manifestOf(out);
  assert.deepEqual([mm.frames.map(f => [f.node, f.error?.code, !!f.html]), mm.done, mixed.exitCode], [[['1:3', 'COMMAND_FAILED', false], ['1:2', undefined, true]], [ok], 1]);
});

test('html-check preflights unreadable/no-meta/non-extract/non-1x/unavailable pages before Chrome and reports each page path', async () => {
  const cwd = await project(), { id } = await landRun(cwd), queued = (await landRun(cwd, { job: { state: 'queued' }, result: null })).id, dir = tmpdir();
  const page = (name, content) => { const f = path.join(dir, name); fs.writeFileSync(f, content); return f; };
  const tag = (extract, scale = 1) => `<meta name="figma-agent-control" content="extract=${extract}; node=1:2; scale=${scale}; overrides=none; generator=g">`;
  let launches = 0;
  const launch = async () => { launches++; throw Object.assign(Error('Must not launch'), { code: 'CHROME_LAUNCH_FAILED' }); };
  for (const [file, message] of [
    [path.join(dir, 'missing.html'), /Cannot read .*missing\.html: .*ENOENT/],
    [page('plain.html', '<p>x</p>'), /plain\.html is not a page generated by figma-agent-control \(missing meta\)$/],
    [page('offline.html', tag('offline')), /offline\.html is not a page generated from an extract$/],
    [page('2x.html', tag(id, 2)), /2x\.html has scale 2; html-check only checks 1x pages$/],
    [page('gone.html', tag(randomUUID())), /gone\.html: extract job .* is not available in the current project \(.*\); run in the project directory that generated the page$/],
    [page('queued.html', tag(queued)), /queued\.html: extract job .* is not available in the current project \(no result yet\)/],
  ]) await assert.rejects(htmlCheck(cwd, [file], { launch }), error => message.test(error.message), file);
  assert.equal(launches, 0);
});

test('html-check preflights --node/--zoom membership, task existence/type/scale, frame containment, and zoom reference decoding before Chrome', async () => {
  const cwd = await project(), { id } = await landRun(cwd), out = path.join(cwd, 'out');
  await html(cwd, args('--from', id, '--out', out, '--no-check'), quiet);
  const file = path.join(out, '\u753b\u677f__1-2.html'), other = (await landRun(cwd, { node: '1:3', result: output => ({ ...output, scale: 2 }) })).id;
  const preview = (await landRun(cwd, { job: { operation: 'preview' } })).id, bad = await landRun(cwd, { result: output => ({ ...output, scale: 2 }) }), garbled = bad.id;
  fs.writeFileSync(path.join(bad.dir, bad.output.reference.file), 'garbage');
  let launches = 0;
  const launch = async () => { launches++; throw Object.assign(Error('Must not launch'), { code: 'CHROME_LAUNCH_FAILED' }); };
  for (const [argv, message] of [[['--node', '9:9'], /^--node 9:9 is not inside any page's frame$/], [['--zoom', randomUUID()], /^--zoom job does not exist or its evidence is incomplete/],
    [['--zoom', preview], /^--zoom only accepts extract jobs: .* is preview$/], [['--zoom', id], /^--zoom needs an extract job with --scale greater than 1 \(at most 4\), got 1$/],
    [['--zoom', other], /^--zoom node 1:3 is not inside any page's frame$/], [['--zoom', garbled], new RegExp(`^Cannot decode the --zoom reference image \\(File is not a valid PNG\\): ${garbled}$`)]])
    await assert.rejects(htmlCheck(cwd, [file], parse(['html-check', file, ...argv]).options, { launch }), error => message.test(error.message), argv.join(' '));
  assert.equal(launches, 0);
});

// html-check browser stub returns sequential shots, defaulting to white, and merged RECTS/page facts containing only supplied nodes.
const checkStub = (shots = [], nodes = []) => {
  const white = encodePng(160, 160, new Uint8Array(160 * 160 * 4).fill(255));
  let n = 0;
  return async () => ({ version: 'Fake/1', close: async () => {}, page: async () => {
    const shot = shots[n++] ?? white;
    return { browser: { version: 'Fake/1' }, open: async () => {}, shot: async () => shot, close: async () => {},
      evaluate: async () => ({ ids: [], names: [], rects: [], facts: {}, faces: {}, els: [], nodes, texts: {} }) };
  } });
};

test('html-check records a normal per-page error like html frame errors, continues other pages, and exits 1', async () => {
  const cwd = await project(), a = await landRun(cwd), b = await landRun(cwd, { node: '1:3' }), out = path.join(cwd, 'out');
  await html(cwd, args('--from', a.id, '--from', b.id, '--out', out, '--no-check'), quiet);
  const files = manifestOf(out).frames.map(f => f.html), r = await htmlCheck(cwd, files, {}, { launch: checkStub([encodePng(10, 10, new Uint8Array(400))]) });
  const [p, q] = r.summary.pages;
  assert.deepEqual([p.error.code, /Screenshot size/.test(p.error.message), 'verdict' in p, q.verdict, q.error, r.summary.totals.errors, r.exitCode], ['COMMAND_FAILED', true, false, 'pass-with-findings', undefined, 1, 1]);
  assert.match(r.summary.instruction, /^For pages with errors, see error$/);
});

test('html-check zoom timeouts preserve 1x verdicts and record zoom.reason, replace the browser, and continue later pages', async () => {
  const cwd = await project(), a = await landRun(cwd), b = await landRun(cwd, { node: '1:3' }), out = path.join(cwd, 'out');
  await html(cwd, args('--from', a.id, '--from', b.id, '--out', out, '--no-check'), quiet);
  // Zoom task extracts all of frame 1:2 at scale 2 with a 320x320 reference; the stub times out on dsf != 1 opens.
  const z = await landRun(cwd, { result: output => ({ ...output, scale: 2 }) });
  fs.writeFileSync(path.join(z.dir, z.output.reference.file), encodePng(320, 320, new Uint8Array(320 * 320 * 4).fill(255)));
  const white = encodePng(160, 160, new Uint8Array(160 * 160 * 4).fill(255)), fact = { found: true, box: [0, 0, 160, 160], style: '', chain: [1, 0, 0, 1] };
  let launches = 0;
  const launch = async () => { launches++; return { version: 'Fake/1', close: async () => {}, page: async () => ({ browser: { version: 'Fake/1' }, close: async () => {}, shot: async () => white,
    open: async (url, w, h, dsf = 1) => { if (dsf !== 1) throw Object.assign(Error('Timed out'), { code: 'RENDER_TIMEOUT' }); },
    evaluate: async () => ({ ids: [], names: [], rects: [], facts: { '1:2': fact }, faces: {}, els: [], nodes: [], texts: {} }) }) }; };
  const files = manifestOf(out).frames.map(f => f.html), r = await htmlCheck(cwd, files, parse(['html-check', ...files, '--zoom', z.id]).options, { launch });
  const [p, q] = r.summary.pages;
  assert.deepEqual([p.zoom.reason, p.verdict, q.verdict, q.reason, launches], ['RENDER_TIMEOUT', 'pass-with-findings', 'pass-with-findings', undefined, 2]);
});

test('html-check restores override context from adjacent html.json with recovered/exact flags; missing context or manual page edits add separate warnings', async () => {
  const cwd = await project(), { id } = await landRun(cwd), out = path.join(cwd, 'out'), file = path.join(cwd, 'o.json');
  fs.writeFileSync(file, JSON.stringify({ '1:2': { '2:8': { bake: 'ref', note: 'n' } } }));
  await html(cwd, args('--from', id, '--out', out, '--overrides', file, '--no-check'), quiet);
  const page = manifestOf(out).frames[0].html, evidence = path.join(root(cwd), 'check', id, 'check.json');
  const go = async () => { const r = await htmlCheck(cwd, [page], {}, { launch: checkStub() }); return { p: r.summary.pages[0], c: readJson(evidence) }; };
  const ok = await go();
  assert.deepEqual([ok.p.context, ok.c.context, ok.p.warnings, ok.p.refs.map(x => x.node)], [{ overrides: 'recovered', exact: true }, { overrides: 'recovered', exact: true }, undefined, ['2:8']]);
  fs.appendFileSync(page, '<!-- \u624b\u6539 -->');
  const edited = await go();
  assert.deepEqual([edited.p.context, edited.p.warnings], [{ overrides: 'recovered', exact: false }, ['Page differs from the regenerated output (page was edited); diagnostics use the regenerated output']]);
  fs.rmSync(path.join(out, 'html.json'));
  const lost = await go();
  assert.deepEqual(lost.p.context, { overrides: 'unavailable', exact: false });
  assert.match(lost.p.warnings[0], /^Page has overrides \([0-9a-f]{12}\) but no file with the same fingerprint was found; diagnostics use the output generated without overrides$/);
});

test('bin caps user-derived long error text at 2000 characters while stdout remains one JSON under 16 KiB', async () => {
  const cwd = tmpdir(), bad = '\u0001'.repeat(20000);
  const { stdout } = await exec(process.execPath, [cliFile, 'html', '--from', bad, '--out', 'd'], { cwd, env: { ...process.env, FIGMA_AGENT_CONTROL_HOME: path.join(cwd, 'home') } })
    .then(() => assert.fail('Expected exit code 1'), error => { assert.equal(error.code, 1); return error; });
  const value = JSON.parse(stdout);
  assert.ok(Buffer.byteLength(stdout) <= 16384, `${Buffer.byteLength(stdout)} bytes`);
  assert.deepEqual([value.code, value.error.length, value.error.endsWith('...'), value.error.startsWith('--from must be an extract job ID')], ['COMMAND_FAILED', 2000, true, true]);
});

// -- Browser lifecycle without Chrome -------------------------------------
test('Without Chrome, subprocess HTML export still writes unchecked/CHROME_NOT_FOUND pages without evidence and exits 1; html-check reports CHROME_NOT_FOUND directly', async () => {
  const cwd = await project(), { id } = await landRun(cwd), out = path.join(cwd, 'out'), env = { ...process.env, FIGMA_AGENT_CONTROL_CHROME: '/nonexistent', FIGMA_AGENT_CONTROL_HOME: path.join(cwd, 'home') };
  const cli = (...argv) => exec(process.execPath, [cliFile, ...argv], { cwd, env }).then(({ stdout }) => ({ code: 0, stdout }), ({ code, stdout }) => ({ code, stdout }));
  const a = await cli('html', '--from', id, '--out', out), f = manifestOf(out).frames[0];
  assert.deepEqual([a.code, Buffer.byteLength(a.stdout) <= 16384, JSON.parse(a.stdout).totals.unchecked], [1, true, 1]);
  assert.deepEqual([f.verdict, f.reason, 'check' in f, fs.existsSync(f.html), fs.existsSync(path.join(root(cwd), 'check'))], ['unchecked', 'CHROME_NOT_FOUND', false, true, false]);
  const b = await cli('html-check', f.html);
  assert.deepEqual([b.code, JSON.parse(b.stdout).code], [1, 'CHROME_NOT_FOUND']);
});

test('Injected browser failures mark the current frame unchecked and replace the browser; timeouts stop further checks, launch failures affect each frame, and thrown checks preserve page fields', async () => {
  const white = encodePng(160, 160, new Uint8Array(160 * 160 * 4).fill(255)), coded = code => Object.assign(Error(`Stub: ${code}`), { code });
  // plan[n] defines the nth browser launch: launch fails startup, open fails navigation, and shot supplies a screenshot.
  const stub = plan => {
    const log = { launches: 0, closed: [], pageClosed: 0 };
    const launch = async () => {
      const n = log.launches++, step = plan[n] ?? {};
      if (step.launch) throw coded(step.launch);
      return { version: 'Fake/1', close: async () => { log.closed.push(n); }, page: async () => ({ browser: { version: 'Fake/1' },
        open: async () => { if (step.open) throw coded(step.open); }, shot: async () => step.shot ?? white,
        evaluate: async () => ({ ids: [], names: [], rects: [], facts: {}, faces: {}, els: [], nodes: [], texts: {} }), close: async () => { log.pageClosed++; } }) };
    };
    return { launch, log };
  };
  const cases = [
    // Stub pages lack data-node elements, so structure reports missing and otherwise healthy frames are pass-with-findings.
    ...['CHROME_PROTOCOL', 'CHROME_EXITED'].map(code => ({ plan: [{ open: code }], frames: [['unchecked', code, false, false], ['pass-with-findings', undefined, true, true]], launches: 2, closed: [0, 1] })),
    { plan: [{ open: 'RENDER_TIMEOUT' }], frames: [['unchecked', 'RENDER_TIMEOUT', true, true], ['unchecked', 'RENDER_TIMEOUT', false, false]], launches: 1, closed: [0] },
    { plan: [{ launch: 'CHROME_LAUNCH_FAILED' }], frames: [['unchecked', 'CHROME_LAUNCH_FAILED', false, false], ['unchecked', 'CHROME_LAUNCH_FAILED', false, false]], launches: 1, closed: [] },
  ];
  for (const { plan, frames, launches, closed } of cases) {
    const cwd = await project(), a = await landRun(cwd), b = await landRun(cwd, { node: '1:3' }), out = path.join(cwd, 'out'), { launch, log } = stub(plan);
    const r = await html(cwd, args('--from', a.id, '--from', b.id, '--out', out), { ...quiet, launch }), m = manifestOf(out), label = JSON.stringify(plan);
    assert.deepEqual(m.frames.map(f => [f.verdict, f.reason, fs.existsSync(path.join(root(cwd), 'check', f.extract, 'check.json')), 'check' in f]), frames, label);
    assert.deepEqual([log.launches, log.closed, m.frames.every(f => fs.existsSync(f.html)), r.exitCode], [launches, closed, true, 1], label);
  }
  const cwd = await project(), { id } = await landRun(cwd), out = path.join(cwd, 'out'), { launch, log } = stub([{ shot: encodePng(10, 10, new Uint8Array(400)) }]);
  const r = await html(cwd, args('--from', id, '--out', out), { ...quiet, launch }), f = manifestOf(out).frames[0];
  assert.deepEqual([f.error.code, /Screenshot size/.test(f.error.message), fs.existsSync(f.html), f.size, manifestOf(out).done, r.exitCode], ['COMMAND_FAILED', true, true, { width: 160, height: 160 }, [id], 1]);
  assert.deepEqual([log.launches, log.pageClosed, log.closed], [1, 1, [0]]);
});

// -- --node: real bridge, real VM plugin, mock document ---------------------
const live = t => harness(t, { url: URL1, doc: extractDoc() });
const submitted = () => { const ids = []; return { ids, stderr: line => { const { submitted: id, next } = JSON.parse(line); assert.equal(next, `figma-agent-control wait ${id}`); ids.push(id); } }; };
const jobOf = (cwd, id) => readJson(path.join(root(cwd), 'runs', id, 'job.json'));
const skewed = skew => ({ now: () => performance.now() + skew.ms, sleep: ms => delay(ms) });

test('--node logs each submission to stderr and includes frame SVG bakes on the first extract; no missing islands means one extraction and exit 0', { timeout: 20000 }, async t => {
  const h = await live(t), out = path.join(h.cwd, 'out'), file = path.join(h.cwd, 'o.json'), log = submitted();
  fs.writeFileSync(file, JSON.stringify({ '1:2': { '2:8': { bake: 'svg', note: 'n' } } }));
  const r = await h.drive(html(h.cwd, args('--node', '1:2', '--overrides', file, '--out', out, '--no-check'), log)), f = manifestOf(out).frames[0];
  assert.deepEqual([log.ids.length, jobOf(h.cwd, log.ids[0]).islands, f.extract, 'extracts' in f, f.overrides, r.exitCode], [1, ['2:8'], log.ids[0], false, { applied: ['2:8'], stale: [] }, 0]);
  assert.deepEqual(h.errors, []);
});

test('Missing --node islands trigger a second extract with missing and valid SVG bakes, use its result, and retain both task IDs', { timeout: 20000 }, async t => {
  const h = await live(t), out = path.join(h.cwd, 'out'), file = path.join(h.cwd, 'o.json'), log = submitted();
  // 4:13 is valid; 9:99 lies outside the frame, so extraction skips it, generation marks it missing, and the second extract omits it.
  fs.writeFileSync(file, JSON.stringify({ '1:3': { '4:13': { bake: 'svg', note: 'n' }, '9:99': { bake: 'svg', note: 'n' } } }));
  const r = await h.drive(html(h.cwd, args('--node', '1:3', '--overrides', file, '--out', out, '--no-check'), log)), m = manifestOf(out), f = m.frames[0], [a, b] = log.ids;
  assert.deepEqual([log.ids.length, jobOf(h.cwd, a).islands, jobOf(h.cwd, b).islands, readMeta(fs.readFileSync(f.html, 'utf8')).extract],
    [2, ['4:13', '9:99'], ['4:1', '4:15', '4:16', '4:28', '4:13'], b]);
  assert.deepEqual([f.extract, f.extracts, f.needsIsland, f.overrides, m.done, r.exitCode], [b, [a, b], undefined, { applied: ['4:13'], stale: [{ node: '9:99', kind: 'missing' }] }, [b], 1]);
});

test('If second extraction still lacks islands, write the first result with approximations/warnings, mark done, exit 1, and suggest --node re-extraction', { timeout: 20000 }, async t => {
  const h = await live(t), out = path.join(h.cwd, 'out'), log = submitted(), node = h.doc.all.get('4:1'), exportAsync = node.exportAsync;
  node.exportAsync = async options => { if (options.format === 'SVG') throw Error('\u5bfc\u51fa\u5931\u8d25'); return exportAsync(options); };
  const r = await h.drive(html(h.cwd, args('--node', '1:3', '--out', out, '--no-check'), log)), m = manifestOf(out), f = m.frames[0], [a, b] = log.ids;
  assert.ok(readJson(path.join(root(h.cwd), 'runs', b, 'result.json')).output.islandsSkipped.includes('4:1'));
  assert.deepEqual([f.extract, f.extracts, f.approximations['second-extract-failed'], f.needsIsland.length, 'needsExtract' in f, m.done, r.exitCode], [a, [a, b], 4, 4, false, [a], 1]);
  assert.ok(f.warnings.some(w => w.startsWith('Second extract did not complete (islands-missing): Still missing island(s) 4:1')), f.warnings.join('\n'));
  assert.match(r.summary.instruction, /Then run figma-agent-control html --node '1:3' --out /);
});

test('Wait timeout moves the task to pending and later frames to remaining with exit 2; wait and guided resume complete the batch', { timeout: 20000 }, async t => {
  const h = await live(t), out = path.join(h.cwd, 'out'), log = submitted();
  await h.pause();
  const r = await html(h.cwd, args('--node', '1:2', '--node', '1:3', '--timeout', '1', '--out', out, '--no-check'), log), m = manifestOf(out), [id] = log.ids;
  assert.deepEqual([log.ids.length, m.pending, m.remaining, m.stop.code, m.frames, r.exitCode], [1, [id], ['1:3'], 'WAIT_TIMEOUT', [], 2]);
  assert.equal(r.summary.instruction, `Wait for extract timed out; first run figma-agent-control wait ${id}, then run figma-agent-control html --from ${quote(id)} --node '1:3' --out ${quote(out)} --no-check --timeout '1'`);
  await h.drive(waitForResult(h.cwd, id));
  const again = await h.drive(html(h.cwd, args('--from', id, '--node', '1:3', '--out', out, '--no-check'), quiet));
  assert.deepEqual([manifestOf(out).frames.map(f => f.node), again.exitCode], [['1:2', '1:3'], 0]);
});

test('Expired budgets cap the submitted frame wait at 1 s, prevent later submissions, and stop with BUDGET_EXPIRED', { timeout: 20000 }, async t => {
  const h = await live(t), out = path.join(h.cwd, 'out'), skew = { ms: 0 }, log = submitted();
  await h.pause();
  const stderr = line => { log.stderr(line); skew.ms += 1e9; }, started = performance.now();
  const r = await html(h.cwd, args('--node', '1:2', '--node', '1:3', '--budget', '10', '--out', out, '--no-check'), { clock: skewed(skew), stderr }), m = manifestOf(out);
  assert.deepEqual([m.pending, m.remaining, m.stop.code, runIds(h.cwd), r.exitCode], [log.ids, ['1:3'], 'BUDGET_EXPIRED', log.ids, 2]);
  assert.ok(performance.now() - started < 5000);
  assert.match(r.summary.instruction, /^Time budget expired; first run figma-agent-control wait /);
});

test('Budget gates always submit the first frame for resume progress, then stop submitting with less than 1 s remaining', { timeout: 20000 }, async t => {
  const h = await live(t), out = path.join(h.cwd, 'out'), log = submitted();
  // Freeze the clock at 1e9 after t0: budget is exhausted but the first wait never expires, so its result persists and only the gate can stop the batch.
  let calls = 0;
  const clock = { now: () => calls++ ? 1e9 : 0, sleep: ms => delay(ms) };
  const r = await h.drive(html(h.cwd, args('--node', '1:2', '--node', '1:3', '--out', out, '--no-check'), { clock, stderr: log.stderr })), m = manifestOf(out);
  assert.deepEqual([log.ids.length, runIds(h.cwd), m.frames.map(f => f.node), m.done, m.pending, m.remaining, m.stop.code, r.exitCode], [1, log.ids, ['1:2'], log.ids, [], ['1:3'], 'BUDGET_EXPIRED', 2]);
  assert.equal(m.stop.message, 'Time budget of 90 s expired; remaining frames were not submitted');
});

test('Second-extract timeout writes the first page, records the second task pending with exit 2, and completes through --from after the task finishes', { timeout: 20000 }, async t => {
  const h = await live(t), out = path.join(h.cwd, 'out'), skew = { ms: 0 }, log = submitted(), second = Promise.withResolvers();
  // After second submission, close the plugin gate and advance beyond budget; the second wait caps at 1 s without a result.
  const stderr = line => { log.stderr(line); if (log.ids.length === 2) { skew.ms += 1e9; void h.pause(); second.resolve(); } };
  const running = html(h.cwd, args('--node', '1:3', '--out', out, '--no-check'), { clock: skewed(skew), stderr });
  // Custom driver stops pumping on the second stderr line because settle would hang on the gated request.
  let driving = true;
  second.promise.then(() => { driving = false; });
  while (driving) { await Promise.race([h.tick().then(h.settle), second.promise]); await delay(10); }
  const r = await running, m = manifestOf(out), f = m.frames[0], [a, b] = log.ids;
  assert.deepEqual([f.extract, f.extracts, f.approximations['second-extract-failed'], fs.existsSync(f.html), m.pending, m.done, m.stop.code, r.exitCode],
    [a, [a, b], 4, true, [b], [], 'BUDGET_EXPIRED', 2]);
  assert.ok(f.warnings.some(w => w.startsWith('Second extract did not complete (wait-timeout)')));
  assert.ok(r.summary.instruction.endsWith(`then run figma-agent-control html --from ${quote(b)} --out ${quote(out)} --no-check`), r.summary.instruction);
  await h.drive(waitForResult(h.cwd, b));
  const again = await html(h.cwd, args('--from', b, '--out', out, '--no-check'), quiet);
  assert.deepEqual([manifestOf(out).frames[0].needsIsland, again.exitCode], [undefined, 0]);
});

test('409 ACTIVE_JOB does not preempt; it stops immediately with exit 2 and identifies the active task', { timeout: 20000 }, async t => {
  const h = await live(t), out = path.join(h.cwd, 'out');
  await h.pause();
  const { data: { id: held } } = await call(h.cwd, '/job', { operation: 'extract', targetNodeId: '1:2' });
  const r = await html(h.cwd, args('--node', '1:3', '--out', out, '--no-check'), quiet), m = manifestOf(out);
  assert.deepEqual([m.remaining, m.stop.code, m.stop.active, runIds(h.cwd), r.exitCode], [['1:3'], 'ACTIVE_JOB', held, [held], 2]);
  assert.match(r.summary.instruction, new RegExp(`^Another job is in progress \\(${held}\\); after it finishes, run figma-agent-control html --node '1:3'`));
});

test('409 RECONNECTING retries after 1, 2, and 4 s, then stops with exit 2 without creating a task', async t => {
  const cwd = await project(), out = path.join(cwd, 'out'), slept = [];
  const bridge = await start(cwd, 0, { pollHoldMs: 50, pluginToken: await pairingToken(path.join(cwd, 'home')) });
  t.after(() => bridge.close());
  const r = await html(cwd, args('--node', '1:2', '--node', '1:3', '--out', out, '--no-check'), { ...quiet, clock: { now: () => performance.now(), sleep: async ms => { slept.push(ms); } } });
  const m = manifestOf(out);
  assert.deepEqual([slept, m.remaining, m.stop.kind, m.stop.code, runIds(cwd), r.exitCode], [[1000, 2000, 4000], ['1:2', '1:3'], 'retry', 'RECONNECTING', [], 2]);
  assert.match(r.summary.instruction, /^Plugin not connected: run the plugin in Figma.*, then run figma-agent-control html --node '1:2' --node '1:3'/);
});

test('Bridge close after submission marks an undelivered task INTERRUPTED/exit 2; later missing session is fatal NO_SESSION/exit 1 with connect-first guidance', { timeout: 20000 }, async t => {
  const h = await live(t), out = path.join(h.cwd, 'out');
  await h.pause();
  const r = await html(h.cwd, args('--node', '1:2', '--out', out, '--no-check'), { stderr: () => { void h.close(); } }), m = manifestOf(out);
  assert.deepEqual([m.stop.code, m.remaining, m.pending, r.exitCode], ['INTERRUPTED', ['1:2'], [], 2]);
  assert.equal(readJson(path.join(root(h.cwd), 'runs', runIds(h.cwd)[0], 'result.json')).error, NOT_DELIVERED);
  const again = await html(h.cwd, args('--node', '1:2', '--out', out, '--no-check'), quiet), n = manifestOf(out);
  assert.deepEqual([n.stop.kind, n.stop.code, n.remaining, again.exitCode], ['fatal', 'NO_SESSION', ['1:2'], 1]);
  assert.match(again.summary.instruction, /connect.*\. Run figma-agent-control html --node '1:2'/);
});

test('A stopped second submission writes the first page but keeps the frame remaining rather than done, with exit 2', { timeout: 20000 }, async t => {
  const h = await live(t), out = path.join(h.cwd, 'out');
  let n = 0;
  const busy = async (cwd, route, body) => ++n === 2 ? { status: 409, ok: false, data: { code: 'ACTIVE_JOB', error: '\u6709\u672a\u5b8c\u6210\u4efb\u52a1', active: randomUUID() } } : call(cwd, route, body);
  const r = await h.drive(html(h.cwd, args('--node', '1:3', '--out', out, '--no-check'), { ...quiet, call: busy })), m = manifestOf(out), f = m.frames[0];
  assert.deepEqual([fs.existsSync(f.html), f.approximations['second-extract-failed'], m.remaining, m.done, m.stop.code, r.exitCode], [true, 4, ['1:3'], [], 'ACTIVE_JOB', 2]);
  assert.ok(f.warnings.some(w => w.startsWith('Second extract did not complete (stopped)')));
});

test('Injected submission classification: BRIDGE_STOPPING is fatal/exit 1, 400 becomes EXTRACT_REJECTED, and RECONNECTING followed by 202 succeeds', async () => {
  const cwd = await project(), out = path.join(cwd, 'out'), reply = (...replies) => async () => replies.shift();
  const go = (deps, ...argv) => html(cwd, args('--node', '1:2', ...argv, '--out', out, '--no-check'), { ...quiet, ...deps });
  const stopping = await go({ call: reply({ status: 409, ok: false, data: { code: 'BRIDGE_STOPPING', error: '\u6865\u63a5\u6b63\u5728\u505c\u6b62\uff0c\u4efb\u52a1\u672a\u63d0\u4ea4' } }) }, '--node', '1:3');
  assert.deepEqual([manifestOf(out).stop, manifestOf(out).remaining, stopping.exitCode], [{ kind: 'fatal', code: 'BRIDGE_STOPPING', message: '\u6865\u63a5\u6b63\u5728\u505c\u6b62\uff0c\u4efb\u52a1\u672a\u63d0\u4ea4' }, ['1:2', '1:3'], 1]);
  assert.match(stopping.summary.instruction, /^\u6865\u63a5\u6b63\u5728\u505c\u6b62，\u4efb\u52a1\u672a\u63d0\u4ea4\. Rerun figma-agent-control connect\. Run /);
  const rejected = await go({ call: reply({ status: 400, ok: false, data: { error: '\u5c40\u90e8\u76ee\u6807 ID \u65e0\u6548' } }) });
  assert.deepEqual([manifestOf(out).frames, rejected.exitCode], [[{ node: '1:2', source: 'node', error: { code: 'EXTRACT_REJECTED', message: '\u5c40\u90e8\u76ee\u6807 ID \u65e0\u6548' } }], 1]);
  const { id } = await landRun(cwd), slept = [], lines = [];
  const ok = await go({ stderr: line => lines.push(line), clock: { now: () => performance.now(), sleep: async ms => { slept.push(ms); } },
    call: reply({ status: 409, ok: false, data: { code: 'RECONNECTING', error: '\u6b63\u5728\u91cd\u8fde' } }, { status: 202, ok: true, data: { id } }) });
  assert.deepEqual([slept, lines.length, manifestOf(out).frames[0].extract, ok.exitCode], [[1000], 1, id, 0]);
});

test('A write failure after second-extract timeout records both task IDs and resumes this frame only through --from, not --node', async () => {
  const cwd = await project(), out = path.join(cwd, 'out'), first = await landRun(cwd, { node: '1:3' }), second = await landRun(cwd, { node: '1:3', job: { state: 'queued' }, result: null });
  fs.mkdirSync(path.join(out, '\u751f\u6210\u5668\u753b\u677f__1-3.html'), { recursive: true });   // A directory occupies the target filename, causing atomic rename to fail.
  const replies = [{ status: 202, ok: true, data: { id: first.id } }, { status: 202, ok: true, data: { id: second.id } }];
  let now = 0;
  const clock = { now: () => now, sleep: async ms => { now += ms; } };
  const r = await html(cwd, args('--node', '1:3', '--timeout', '1', '--out', out, '--no-check'), { ...quiet, clock, call: async () => replies.shift() }), m = manifestOf(out), f = m.frames[0];
  assert.deepEqual([f.extract, f.extracts, 'html' in f, typeof f.error.code, m.pending, m.done, m.remaining, m.stop.code, r.exitCode],
    [first.id, [first.id, second.id], false, 'string', [second.id], [], [], 'WAIT_TIMEOUT', 2]);
  assert.equal(r.summary.instruction, `Wait for extract timed out; first run figma-agent-control wait ${second.id}, then run figma-agent-control html --from ${quote(second.id)} --out ${quote(out)} --no-check --timeout '1'`);
});

// -- Requires Chrome ------------------------------------------------------
let chrome = '';
try { findChrome(); } catch (error) { chrome = `${error.code}: ${error.message}`; }
test('Check and html-check persist task evidence matching check.json; replacing the reference with the render makes both clean except local-font findings, with exit 0', { skip: chrome || false, timeout: 60000 }, async () => {
  const cwd = await project(), { id, dir, output } = await landRun(cwd), out = path.join(cwd, 'out'), evidence = path.join(root(cwd), 'check', id);
  await html(cwd, args('--from', id, '--out', out), quiet);
  const m = manifestOf(out), f = m.frames[0], c = readJson(path.join(evidence, 'check.json'));
  const images = c.blocks.flatMap(b => b.image ? [b.image] : []);
  assert.ok(images.length === Math.min(c.blocks.length, 10), 'Each of the first 10 structural blocks has a crop image');
  assert.deepEqual([fs.readdirSync(evidence).sort(), f.verdict, f.diffRatio, f.check], [[...images, 'check.json', 'diff.png', 'render.png'].sort(), c.verdict, c.diffRatio, path.join(evidence, 'check.json')]);
  assert.ok(m.browser.version.length > 0 && m.browser.launchMs >= 0);
  const hc = await htmlCheck(cwd, [f.html]), [p] = hc.summary.pages;
  assert.deepEqual([p.diffRatio, p.verdict, p.context, Object.keys(hc.summary.totals)], [f.diffRatio, f.verdict, { overrides: 'none', exact: true }, ['pages', 'clean', 'passWithFindings', 'fail', 'unchecked', 'errors']]);
  fs.copyFileSync(path.join(evidence, 'render.png'), path.join(dir, output.reference.file));
  const again = await html(cwd, args('--from', id, '--out', out), quiet), g = manifestOf(out).frames[0];
  // Missing local SF Pro Text, PingFang SC, or Kanit causes substitution findings and pass-with-findings, still exit 0.
  assert.deepEqual([g.verdict, again.exitCode, (await htmlCheck(cwd, [f.html])).exitCode], [g.fonts.some(x => x.substituted) ? 'pass-with-findings' : 'clean', 0, 0]);
  assert.ok(g.fonts.every(x => typeof x.substituted === 'boolean'), JSON.stringify(g.fonts));
  assert.deepEqual(fs.readdirSync(evidence).sort(), ['check.json', 'diff.png', 'render.png'], 'A later check without structural blocks removes old block images');
});
