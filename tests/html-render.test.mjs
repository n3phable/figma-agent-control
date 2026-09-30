/**
 * [INPUT]: Imports node:test, node:assert/strict, node:fs, node:os, node:path, node:child_process, node:url, ../src/html/chrome.mjs, ../src/html/check.mjs, ../src/html/generate.mjs, ../src/png.mjs, ./helpers/generate.mjs.
 * [OUTPUT]: Node.js test cases and fixture setup for this revision.
 * [POS]: Regression coverage for html render; tests use local synthetic inputs and isolated state.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { findChrome, launch } from '../src/html/chrome.mjs';
import { check, raster, writeEvidence, BLOCK_IMAGES } from '../src/html/check.mjs';
import { embed, dataUri } from '../src/html/generate.mjs';
import { decodePng, encodePng } from '../src/png.mjs';
import { extracted, run } from './helpers/generate.mjs';

let chrome = null, reason = '';
try { chrome = findChrome(); } catch (error) { reason = `${error.code}: ${error.message}`; }
// Without Chrome, every dependent case below is skipped with the discovery error as its reason.
const needs = { skip: chrome ? false : reason };
const exited = pid => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
const profiles = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('fac-chrome-')).length;

// Fixture pages position nested .n elements with transforms like the generator; the background-free canvas should remain transparent in empty areas.
const page = (body, { width = 200, height = 120 } = {}) => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0} #canvas{position:relative;width:${width}px;height:${height}px;overflow:hidden} .n{position:absolute;left:0;top:0;transform-origin:0 0}
</style></head><body><div id="canvas" data-node="1:1" data-name="\u5e27">${body}</div></body></html>`;
const blocks = blueY => page(`<div class="n" data-node="1:2" data-name="\u7ea2\u5757" style="transform:translate(20px,20px);width:60px;height:40px;background:#e53935"></div>
<div class="n" data-node="1:3" data-name="\u84dd\u5757" style="transform:translate(110px,${blueY}px);width:60px;height:60px;background:#1e88e5"></div>
<div class="n" data-node="1:4" data-name="\u6587\u5b57" style="transform:translate(20px,80px);font:16px sans-serif;color:#222">Hello</div>`);

test('findChrome rejects an invalid environment override without fallback and preserves a valid executable path', () => {
  assert.throws(() => findChrome({ FIGMA_AGENT_CONTROL_CHROME: '/nonexistent', PATH: process.env.PATH }), error => error.code === 'CHROME_NOT_FOUND' && /nonexistent/.test(error.message));
  assert.throws(() => findChrome({ FIGMA_AGENT_CONTROL_CHROME: os.tmpdir() }), { code: 'CHROME_NOT_FOUND' }, 'A directory is not an executable file');
  assert.equal(findChrome({ FIGMA_AGENT_CONTROL_CHROME: process.execPath }), process.execPath);
});

test('Immediate process exit reports CHROME_LAUNCH_FAILED and removes its temporary profile', async () => {
  const before = profiles();
  // Node rejects Chrome startup flags and immediately exits nonzero.
  await assert.rejects(launch({ executable: process.execPath }), error => error.code === 'CHROME_LAUNCH_FAILED' && error.message.includes(process.execPath));
  assert.equal(profiles(), before);
});

test('Non-CDP pipe messages terminate the child with CHROME_LAUNCH_FAILED without crashing the host or leaving a profile', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fac-html-render-')), fake = path.join(dir, 'fake-chrome'), before = profiles();
  // Write one non-JSON message then suspend; exec makes the suspended process itself the termination target, leaving no orphan.
  fs.writeFileSync(fake, '#!/bin/sh\nprintf "garbage\\000" >&4\nexec sleep 30\n', { mode: 0o755 });
  try { await assert.rejects(launch({ executable: fake }), error => error.code === 'CHROME_LAUNCH_FAILED' && /unparsable/.test(error.message)); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(profiles(), before);
});

test('raster respects paint order, rounds partially covered pixels outward, and clips to the canvas', () => {
  const owner = raster([0, 0, 0, 4, 3, 1, 1.5, 0.5, 1, 1, 2, -5, 2, 100, 9], 4, 3);
  assert.deepEqual([...owner], [0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 2, 2]);
  assert.deepEqual([...raster([], 2, 1)], [-1, -1]);
});

test('Refs prevent clean verdicts, report per-rectangle differences and union bakedShare, while failures still apply', async () => {
  // Stub page with a fixed screenshot and no data-node elements: a 10x10 white reference differs at (1,1) and (6,6).
  const W = 10, white = () => new Uint8Array(W * W * 4).fill(255), shot = white();
  for (const [x, y] of [[1, 1], [6, 6]]) shot.set([0, 0, 0, 255], (y * W + x) * 4);
  const fake = png => ({ browser: { version: 'fake' }, open: async () => {}, shot: async () => png, evaluate: async () => ({ ids: [], names: [], rects: [] }) });
  const input = { url: 'about:blank', reference: encodePng(W, W, white()), expected: { width: W, height: W } };
  assert.equal((await check(fake(encodePng(W, W, white())), input)).report.verdict, 'clean');
  const refs = [{ node: '1:2', rect: [0, 0, 4, 4], share: 0.16 }, { node: '1:3', rect: [2, 2, 8, 8], share: 0.36 }];
  const { report } = await check(fake(encodePng(W, W, shot)), { ...input, refs });
  assert.deepEqual([report.verdict, report.mismatched, report.bakedShare], ['pass-with-findings', 2, 0.48], 'Union area is 16 + 36 - 4 = 48 pixels');
  assert.deepEqual(report.refs, [{ node: '1:2', rect: [0, 0, 4, 4], share: 0.16, px: 1 }, { node: '1:3', rect: [2, 2, 8, 8], share: 0.36, px: 1 }]);
  const plain = (await check(fake(encodePng(W, W, shot)), input)).report;
  assert.deepEqual([plain.verdict, plain.refs, plain.bakedShare], ['clean', undefined, undefined], 'The same differences without refs are clean and omit both ref fields');
  const dark = new Uint8Array(W * W * 4).fill(0);
  assert.equal((await check(fake(encodePng(W, W, dark)), { ...input, refs })).report.verdict, 'fail');

  // Rectangles are half-open and exclude antialiasing. A black/gray/white reference differs by a brighter gray antialiasing pixel at (4,2) and a black mismatch at (8,8).
  const stripe = () => { const img = new Uint8Array(W * W * 4); for (let i = 0; i < W * W; i++) { const x = i % W, v = x < 4 ? 0 : x === 4 ? 128 : 255; img.set([v, v, v, 255], i * 4); } return img; };
  const edge = stripe();
  edge.set([230, 230, 230, 255], (2 * W + 4) * 4);
  edge.set([0, 0, 0, 255], (8 * W + 8) * 4);
  const rects = [[3, 0, 6, 4], [6, 6, 8, 9], [6, 6, 9, 8], [8, 8, 9, 9]].map((rect, i) => ({ node: `1:${i}`, rect }));
  const half = (await check(fake(encodePng(W, W, edge)), { ...input, reference: encodePng(W, W, stripe()), refs: rects })).report;
  assert.deepEqual([half.mismatched, half.aa, half.refs.map(x => x.px), half.bakedShare], [1, 1, [0, 0, 0, 1], 0.21], '(8,8) lies only in the final rectangle');
});

// Stub page with fixed screenshot; evaluate merges RECTS and page-fact results, and facts may be a throwing function.
const stub = (png, { ids = [], names = [], rects = [], facts = {}, faces = {}, els = [], nodes = [], texts = {} } = {}) => {
  let calls = 0;
  return { browser: { version: 'fake' }, open: async () => {}, shot: async () => png,
    evaluate: async () => { if (calls++ && typeof facts === 'function') facts(); return { ids, names, rects, facts, faces, els, nodes, texts }; } };
};

test('Without frame, report keys match image-only checking plus blocks[].image; writeEvidence saves the first 10 block crops and removes stale ones', async () => {
  // A 400x100 white image contains twelve separated 16x16 black screenshot blocks, each forming a structural block.
  const W = 400, H = 100, white = () => new Uint8Array(W * H * 4).fill(255), shot = white();
  for (let n = 0; n < 12; n++) for (let y = 16; y < 32; y++) for (let x = n * 32; x < n * 32 + 16; x++) shot.set([0, 0, 0, 255], (y * W + x) * 4);
  const { report, images } = await check(stub(encodePng(W, H, shot)), { url: 'about:blank', reference: encodePng(W, H, white()), expected: { width: W, height: H } });
  assert.deepEqual(Object.keys(report), ['verdict', 'expected', 'reference', 'mismatched', 'aa', 'diffRatio', 'blocks', 'nodes', 'unattributed', 'browser', 'checker', 'ms']);
  assert.deepEqual(Object.keys(report.ms), ['render', 'decode', 'match', 'blocks', 'attrib']);
  assert.equal(report.blocks.length, 12);
  assert.deepEqual(report.blocks.map(b => Object.keys(b).join()), [...Array(BLOCK_IMAGES).fill('x,y,w,h,diffPx,bboxPx,nodes,image'), 'x,y,w,h,diffPx,bboxPx,nodes', 'x,y,w,h,diffPx,bboxPx,nodes']);
  assert.deepEqual(report.blocks.map(b => b.image).filter(Boolean), Array.from({ length: BLOCK_IMAGES }, (_, i) => `block-${i + 1}.png`));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fac-html-render-'));
  try {
    for (const old of ['block-3.png', 'block-11.png', 'block-12.png', 'keep.txt']) fs.writeFileSync(path.join(dir, old), 'old');
    await writeEvidence(dir, report, images);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['block-1.png', 'block-10.png', 'block-2.png', 'block-3.png', 'block-4.png', 'block-5.png', 'block-6.png', 'block-7.png', 'block-8.png',
      'block-9.png', 'check.json', 'diff.png', 'keep.txt', 'render.png']);
    // Enlarge 16x16 blocks 8x within a 480 px long edge; stack reference, render, and diff with four transparent rows between them.
    const img = decodePng(fs.readFileSync(path.join(dir, 'block-3.png'))), px = y => [...img.data.subarray(y * img.width * 4, y * img.width * 4 + 4)];
    assert.deepEqual([img.width, img.height], [128, 3 * 128 + 2 * 4]);
    assert.deepEqual([px(0), px(128), px(132), px(264)], [[255, 255, 255, 255], [0, 0, 0, 0], [0, 0, 0, 255], [255, 0, 0, 255]]);
    // A subsequent check without blocks removes all old block images.
    await writeEvidence(dir, { blocks: [] }, images);
    assert.deepEqual(fs.readdirSync(dir).filter(f => f.startsWith('block-')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Frame-aware stub checks include two-sided top/fix/basis/layout data; geometry/fonts/structure yield findings, informational ink/focus stay clean, and fact timeouts leave the frame unchecked', async () => {
  // A 200x100 white image contains a 30x5 dark bar 1:1 at y=5 in the reference and y=7 in the screenshot; 1:9 is unpainted and absent from the page.
  const W = 200, H = 100, img = y0 => { const d = new Uint8Array(W * H * 4).fill(255); for (let y = y0; y < y0 + 5; y++) for (let x = 5; x < 35; x++) d.set([20, 20, 20, 255], (y * W + x) * 4); return encodePng(W, H, d); };
  const N = (id, name, x, y, w, h, extra = {}) => ({ id, name, type: 'FRAME', transform: [[1, 0, x], [0, 1, y]], width: w, height: h, renderBounds: [x, y, w, h], ...extra });
  const tree = (bar = {}) => ({ root: N('0:1', '\u5e27', 0, 0, W, H, { children: [N('1:1', '\u6697\u6761', 5, 5, 30, 5, bar), N('1:8', '\u65c1\u8fb9', 100, 10, 10, 10), N('1:9', '\u8fdc\u5904', 100, 50, 10, 10, { renderBounds: null })] }),
    islands: {}, scale: 1 });
  const style = 'transform:translate(5px,7px);width:30px;height:5px', bar = { found: true, box: [5, 7, 30, 5], style, chain: [1, 0, 0, 1] };
  const page = (facts, extra = {}) => stub(img(7), { ids: ['0:1', '1:1'], names: ['\u5e27', '\u6697\u6761'], rects: [0, 0, 0, W, H, 1, 5, 7, 30, 5], nodes: ['0:1', '1:1', '1:8'],
    facts: facts ?? { '1:1': bar, '1:9': { found: false } }, ...extra });
  const input = (frame = {}) => ({ url: 'about:blank', reference: img(5), expected: { width: W, height: H },
    frame: { output: tree(), result: { approximations: [{ node: '1:1', kind: 'blend-mode', detail: 'node' }, { node: '1:1', kind: 'blend-mode' }], overrides: { applied: [] }, fonts: [] }, overrides: {}, ...frame } });

  // The page bar is 2 px below Figma, so the box mismatch prevents clean.
  const { report } = await check(page(), input());
  assert.deepEqual([report.verdict, report.mismatched, report.focus, report.fonts, report.untracked, report.missing, report.textMismatch, 'cause' in report],
    ['pass-with-findings', 120, undefined, [], [], [], [], false]);
  assert.deepEqual(report.top, [{ node: '1:1', name: '\u6697\u6761', htmlPx: 60, figmaPx: 60, px: 60, approximations: ['blend-mode'], shift: { dx: 0, dy: -2, before: 120, after: 0 },
    fix: { style: { transform: 'translate(5px,5px)' }, basis: { transform: 'translate(5px,7px)' } }, layout: [{ kind: 'box', html: [5, 7, 30, 5], figma: [5, 5, 30, 5] }],
    hint: 'After moving up 2px: differing pixels 120->0' }]);
  assert.ok(['figma', 'facts', 'fonts', 'top', 'structure', 'suggest'].every(k => Number.isInteger(report.ms[k])), JSON.stringify(report.ms));
  assert.deepEqual([report.clusters.map(c => [c.target, c.outcome]), report.suggest, report.hints], [[['1:1', 'idle']], [], []], 'The bar\'s blend approximation forms an idle cluster with only 60 differing pixels');

  // An applied transform override uses its original basis, or omits basis if absent; intentional displacement suppresses box findings and allows clean.
  const entry = { style: { transform: 'translate(5px,7px)' }, basis: { transform: 'translate(5px,5px)' }, note: '' }, applied = { approximations: [], overrides: { applied: ['1:1'] }, fonts: [] };
  const moved = (frame = {}) => input({ result: applied, overrides: { '1:1': entry }, ...frame });
  const kept = (await check(page(), moved())).report;
  assert.deepEqual([kept.verdict, kept.top[0].fix.basis, kept.top[0].layout], ['clean', { transform: 'translate(5px,5px)' }, []]);
  assert.deepEqual((await check(page(), input({ result: applied, overrides: { '1:1': { ...entry, basis: undefined } } }))).report.top[0].fix, { style: { transform: 'translate(5px,5px)' } });

  // focus assigns zero side counts to unranked nodes, gives only a hint for absent elements, and does not let focused box mismatches change the verdict.
  const focused = (await check(page({ '1:1': bar, '1:8': { ...bar, box: [100, 12, 10, 10] }, '1:9': { found: false } }), moved({ focus: ['1:9', '1:8'] }))).report;
  assert.deepEqual([focused.verdict, focused.top.length, focused.focus[0]], ['clean', 1, { node: '1:9', name: '\u8fdc\u5904', htmlPx: 0, figmaPx: 0, px: 0, hint: 'No element for this node in the page' }]);
  assert.deepEqual(focused.focus[1].layout, [{ kind: 'box', html: [100, 12, 10, 10], figma: [100, 10, 10, 10] }]);

  // Informational text ink-offset alone remains clean.
  const text = { type: 'TEXT', textAutoResize: 'NONE', textAlignVertical: 'TOP' }, ink = { lh: 5, lines: 1, firstTop: 7, ink: [5.6, 7, 35, 12], linear: [1, 0, 0, 1] };
  const inked = (await check(page({ '1:1': { ...bar, text: ink } }), moved({ output: tree(text) }))).report;
  assert.deepEqual([inked.verdict, inked.top[0].layout], ['clean', [{ kind: 'ink-offset', dx: 0.6, dy: 2, dw: -0.6, dh: 0 }]]);
  // Rotated text checks only its box and explains this in a hint.
  const turned = (await check(page({ '1:1': { ...bar, text: { ...ink, linear: [0, 1, -1, 0] } } }), moved({ output: tree(text) }))).report;
  assert.deepEqual([turned.verdict, turned.top[0].layout, /Rotated or flipped text skips line-box and ink checks$/.test(turned.top[0].hint)], ['clean', [], true]);

  // Structure checks cover page-only data-node elements and extracted nodes missing from the page.
  const extra = (await check(page(undefined, { nodes: ['0:1', '1:1', '1:8', '9:9'] }), moved())).report;
  assert.deepEqual([extra.verdict, extra.untracked, extra.missing], ['pass-with-findings', ['9:9'], []]);
  assert.deepEqual((await check(page(undefined, { nodes: ['0:1', '1:1'] }), moved())).report.missing, ['1:8']);

  // An unloaded face is substituted; the bar using it owns exactly half the HTML differences (60/120), meeting the cause threshold.
  const fonts = [{ family: 'Kanit', style: 'Light', postScriptName: 'Kanit-Light', source: 'segment', metrics: true, face: 'f0' }];
  const sub = (await check(page(undefined, { faces: { f0: { status: 'error', names: ['Kanit-Light'] } }, els: [{ node: '1:1', face: 'f0', chars: 5 }] }),
    moved({ result: { ...applied, fonts } }))).report;
  assert.deepEqual([sub.verdict, sub.cause, sub.fonts, sub.top[0].fonts], ['pass-with-findings', 'font-substitution',
    [{ family: 'Kanit', style: 'Light', postScriptName: 'Kanit-Light', source: 'segment', face: 'f0', status: 'error', substituted: true }], [{ postScriptName: 'Kanit-Light', status: 'error' }]]);

  const late = (await check(page(() => { throw Object.assign(Error('\u9875\u9762\u53d6\u6570\u8d85\u65f6'), { code: 'RENDER_TIMEOUT' }); }), input())).report;
  assert.deepEqual([late.verdict, late.reason, late.top], ['unchecked', 'RENDER_TIMEOUT', undefined]);
  await assert.rejects(check(page('\u574f'), input()), /returned an unexpected shape/, 'Unexpected page-script result shapes still throw');
});

test('Triggered clusters prevent clean whether suggesting a bake or only hinting at oversized targets; idle clusters stay clean, and refs report seam metrics/hard-edge hints', async () => {
  // A 400x100 white image has sparse 0.2-density differences that form no structural blocks. Glass button INSTANCE 1:1 contains GLASS 1:2; full-frame card INSTANCE 3:1 contains small GLASS 3:2.
  const W = 400, H = 100, white = () => new Uint8Array(W * H * 4).fill(255);
  const sparse = ([x0, y0, x1, y1]) => { const d = white(); for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if ((x + y) % 5 === 0) d.set([0, 0, 0, 255], (y * W + x) * 4); return encodePng(W, H, d); };
  const N = (id, type, x, y, w, h, extra = {}) => ({ id, name: id, type, transform: [[1, 0, x], [0, 1, y]], width: w, height: h, renderBounds: [x, y, w, h], ...extra });
  const tree = kids => ({ root: N('0:1', 'FRAME', 0, 0, W, H, { children: kids }), islands: {}, scale: 1, reference: { file: 'r.png', bytes: 1, sha256: 'x', type: 'png', width: W, height: H } });
  const button = [N('1:1', 'INSTANCE', 10, 10, 50, 50, { children: [N('1:2', 'RECTANGLE', 10, 10, 50, 50)] })];
  const card = [N('3:1', 'INSTANCE', 0, 0, W, H, { children: [N('3:2', 'RECTANGLE', 150, 60, 20, 20)] })];
  const ids = output => { const out = []; const walk = n => { out.push(n.id); n.children?.forEach(walk); }; walk(output.root); return out; };
  const run = async (output, layer, png, refs = []) => (await check(stub(png, { nodes: ids(output) }), { url: 'about:blank', reference: encodePng(W, H, white()), expected: { width: W, height: H }, refs,
    frame: { output, result: { approximations: [{ node: layer, kind: 'glass' }], overrides: { applied: [] }, fonts: [] }, overrides: {} } })).report;
  const idle = await run(tree(button), '1:2', encodePng(W, H, white()));
  assert.deepEqual([idle.verdict, idle.clusters.map(c => c.outcome)], ['clean', ['idle']]);
  const proposed = await run(tree(button), '1:2', sparse([10, 10, 60, 60]));
  assert.deepEqual([proposed.verdict, proposed.blocks.length, proposed.clusters[0].ownPx, proposed.suggest.map(x => [x.node, x.rect, x.entry.note])],
    ['pass-with-findings', 0, 500, [['1:1', [10, 10, 60, 60], 'glass']]]);
  const wide = await run(tree(card), '3:2', sparse([0, 0, 50, 50]));
  assert.deepEqual([wide.verdict, wide.clusters.map(c => [c.target, c.outcome]), wide.suggest, wide.hints.length], ['pass-with-findings', [['3:1', 'span']], [], 1]);
  // A black ring around ref 1:2 contrasts with the white reference: hard=edges generates hints while interior pixels still count normally.
  const framed = white();
  for (let y = 9; y <= 60; y++) for (let x = 9; x <= 60; x++) if (x === 9 || x === 60 || y === 9 || y === 60) framed.set([0, 0, 0, 255], (y * W + x) * 4);
  const seam = await run(tree(button), '1:2', encodePng(W, H, framed), [{ node: '1:2', rect: [10, 10, 60, 60] }]);
  assert.deepEqual([seam.refs[0].px, seam.refs[0].seam, seam.clusters], [0, { edges: 200, mean: 255, hard: 200, max: 255 }, []]);
  assert.deepEqual(seam.hints, ['ref 1:2 has hard edges on its rectangle border (hard 200/200, threshold 4): the target may cover only part of a component; use a component-level target']);
});

describe('Rendering and checking (requires Chrome)', () => {
  let browser, tab, dir, url, reference;
  before(async () => {
    if (!chrome) return;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fac-html-render-'));
    url = (name, html) => { const file = path.join(dir, name); fs.writeFileSync(file, html); return pathToFileURL(file).href; };
    browser = await launch({ executable: chrome });
    tab = await browser.page();
    await tab.open(url('a.html', blocks(30)), 200, 120);
    reference = await tab.shot();
  });
  after(async () => {
    if (!chrome) return;
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
    assert.ok(exited(browser.pid) && !fs.existsSync(browser.profile), 'The suite-owned Chrome exited and its profile was removed');
  });

  test('Self-comparison is zero without structural blocks; solid-color probes match and empty canvas remains transparent', needs, async () => {
    const { report } = await check(tab, { url: url('self.html', blocks(30)), reference, expected: { width: 200, height: 120 } });
    assert.deepEqual([report.verdict, report.mismatched, report.diffRatio, report.blocks, report.nodes], ['clean', 0, 0, [], []]);
    assert.match(report.browser.version, /Chrome\//);
    assert.ok(report.browser.args.includes('--disable-gpu') && /^[a-f0-9]{12}$/.test(report.checker));
    const img = decodePng(reference), px = (x, y) => [...img.data.subarray((y * 200 + x) * 4, (y * 200 + x) * 4 + 4)];
    const near = (actual, expected) => actual.every((v, i) => Math.abs(v - expected[i]) <= 40);
    assert.ok(near(px(50, 40), [229, 57, 53, 255]), `Red block ${px(50, 40)}`);
    assert.ok(near(px(140, 60), [30, 136, 229, 255]), `Blue block ${px(140, 60)}`);
    assert.equal(px(190, 5)[3], 0, 'Transparent background');
  });

  test('Moving the blue block down 6 px yields two 60x6 difference bands, attributes the new position to the node and vacated area to the frame, and writes evidence', needs, async () => {
    const { report, images } = await check(tab, { url: url('moved.html', blocks(36)), reference, expected: { width: 200, height: 120 } });
    assert.equal(report.mismatched, 720);
    assert.equal(report.verdict, 'fail', '720/24000 = 3%');
    assert.deepEqual(report.nodes.map(n => [n.node, n.px]).sort(), [['1:1', 360], ['1:3', 360]]);
    assert.equal(report.nodes.find(n => n.node === '1:3').area, 3600);
    const lower = report.blocks.find(b => b.y >= 80);
    // A block encloses the union of hot cells; all its differences come from the blue block.
    assert.deepEqual(lower.nodes, [{ node: '1:3', name: '\u84dd\u5757', px: lower.diffPx, share: 1 }]);
    assert.equal(lower.bboxPx, lower.diffPx, 'share divides by differing pixels inside the bounding box; hot cells fill that box here');
    assert.equal(report.blocks.find(b => b.y < 80).nodes[0].node, '1:1', 'HTML sees only the node currently painting a position; Figma-side attribution covers vacated areas');

    const evidence = path.join(dir, 'evidence');
    await writeEvidence(evidence, report, images);
    assert.equal(JSON.parse(fs.readFileSync(path.join(evidence, 'check.json'), 'utf8')).mismatched, 720);
    assert.deepEqual([decodePng(fs.readFileSync(path.join(evidence, 'render.png'))).width, decodePng(fs.readFileSync(path.join(evidence, 'diff.png'))).height], [200, 120]);
  });

  test('Repeated elements with one node ID merge counts, while portions outside clipping ancestors are unattributed', needs, async () => {
    await tab.open(url('empty.html', page('')), 200, 120);
    const empty = await tab.shot();
    const html = page(`<div class="n" data-node="5:1" data-name="\u62c6\u5c42" style="transform:translate(10px,10px);width:20px;height:20px;background:#000"></div>
<div class="n" data-node="5:1" data-name="\u62c6\u5c42" style="transform:translate(100px,10px);width:30px;height:20px;background:#000"></div>
<div class="n" data-node="5:2" data-name="\u88c1\u5207" style="transform:translate(10px,60px);width:40px;height:20px;overflow:hidden">
<div class="n" data-node="5:3" data-name="\u6ea2\u51fa" style="width:80px;height:20px;background:#000"></div></div>`);
    const { report } = await check(tab, { url: url('dup.html', html), reference: empty, expected: { width: 200, height: 120 } });
    assert.deepEqual(report.nodes.map(n => [n.node, n.px, n.area]), [['5:1', 1000, 1000], ['5:3', 800, 800]]);
    assert.equal(report.mismatched, 1800);
  });

  test('Stroke layers and mask wrappers own no rectangles; child/sibling differences keep their owners and stroke pixels belong to the container', needs, async () => {
    await tab.open(url('empty2.html', page('')), 200, 120);
    const empty = await tab.shot();
    const html = page(`<div class="n" data-node="6:1" data-name="\u5e26\u63cf\u8fb9\u7684\u5bb9\u5668" style="transform:translate(10px,10px);width:40px;height:20px">
<div class="n" data-node="6:2" data-name="\u5b50\u8282\u70b9" style="transform:translate(5px,5px);width:10px;height:10px;background:#000"></div>
<div data-layer="stroke" style="position:absolute;inset:0;outline:1px solid #000;outline-offset:-1px"></div></div>
<div class="n" data-node="7:1" data-name="\u5e26\u8499\u7248\u7684\u5bb9\u5668" style="transform:translate(100px,10px);width:60px;height:40px">
<div class="n" data-node="7:2" data-name="\u8499\u7248\u4e4b\u524d\u7684\u5144\u5f1f" style="transform:translate(5px,5px);width:20px;height:20px;background:#000"></div>
<div class="n" data-mask="7:3" data-name="\u8499\u7248" style="width:60px;height:40px;overflow:hidden">
<div class="n" data-node="7:4" data-name="\u8499\u7248\u4e4b\u540e\u7684\u5144\u5f1f" style="transform:translate(40px,5px);width:10px;height:10px;background:#000"></div></div></div>`);
    const { report } = await check(tab, { url: url('stroke.html', html), reference: empty, expected: { width: 200, height: 120 } });
    const px = Object.fromEntries(report.nodes.map(n => [n.node, n.px]));
    assert.deepEqual([px['6:2'], px['7:2'], px['7:4'], px['7:1']], [100, 400, 100, undefined], JSON.stringify(report.nodes));
    assert.equal(px['6:1'] + px['6:2'] + px['7:2'] + px['7:4'], report.mismatched);
  });

  test('Reference sizes differing by more than 1 px are unchecked/REFERENCE_SIZE without rendering; a 1 px difference compares at reference size and marks fractional', needs, async () => {
    const bad = await check(tab, { url: 'about:blank', reference, expected: { width: 203, height: 120 } });
    assert.deepEqual([bad.report.verdict, bad.report.reason, bad.report.reference, bad.images], ['unchecked', 'REFERENCE_SIZE', { width: 200, height: 120 }, undefined]);
    const fractional = await check(tab, { url: url('frac.html', blocks(30)), reference, expected: { width: 201, height: 119 } });
    assert.deepEqual([fractional.report.sizeNote, fractional.report.mismatched, fractional.images.width], ['fractional', 0, 200]);
    // Missing, NaN, or fractional expected dimensions fail explicitly so size checking cannot silently vanish; viewports also require positive integers.
    for (const expected of [{ width: NaN, height: 120 }, { width: 200 }, { width: 200.5, height: 120 }, undefined])
      await assert.rejects(check(tab, { url: 'about:blank', reference, expected }), /Expected size must be positive integers/);
    await assert.rejects(tab.open('about:blank', 10.5, 7.25), /Viewport size must be positive integers/);
  });

  test('A failed navigation permits immediate reopening of the same page without leaving a pending load event', needs, async () => {
    await assert.rejects(tab.open(pathToFileURL(path.join(dir, 'missing.html')).href, 200, 120), /ERR_FILE_NOT_FOUND/);
    const t = performance.now();
    await tab.open(url('after.html', blocks(30)), 200, 120);
    assert.ok(performance.now() - t < 5000, `Reopening took ${Math.round(performance.now() - t)} ms`);
  });

  test('open scales screenshot pixels by dsf, accepts only (0,4], and exposes raw CDP commands on the page session', needs, async () => {
    await tab.open(url('dsf.html', blocks(30)), 200, 120, 2);
    const img = decodePng(await tab.shot());
    assert.deepEqual([img.width, img.height, [...img.data.subarray((50 * 400 + 50) * 4, (50 * 400 + 50) * 4 + 4)]], [400, 240, [229, 57, 53, 255]], 'Red block starts at (20,20); pixel (50,50) is CSS (25,25)');
    for (const dsf of [0, 5, NaN]) await assert.rejects(tab.open(url('dsf.html', blocks(30)), 200, 120, dsf), /dsf must be a number in \(0, 4\]/, String(dsf));
    assert.equal(typeof (await tab.cdp('DOM.getDocument', { depth: 0 })).root.nodeId, 'number');
    await tab.open(url('dsf1.html', blocks(30)), 200, 120);
    assert.deepEqual((await tab.shot()).equals(reference), true, 'Reopening with default dsf returns to 1x');
  });

  test('Render timeout yields unchecked/RENDER_TIMEOUT, and closing removes the owned process and profile', needs, async () => {
    const hung = await launch({ executable: chrome, timeout: 1500 });
    try {
      const { report } = await check(await hung.page(), { url: url('hang.html', '<script>for(;;){}</script>'), reference, expected: { width: 200, height: 120 } });
      assert.deepEqual([report.verdict, report.reason], ['unchecked', 'RENDER_TIMEOUT']);
    } finally { await hung.close(); }
    assert.ok(exited(hung.pid), `pid ${hung.pid} exited`);
    assert.equal(fs.existsSync(hung.profile), false);
  });

  test('SIGKILL during Chrome operation rejects pending and later commands with CHROME_EXITED, while close removes the profile', needs, async () => {
    const b = await launch({ executable: chrome });
    try {
      const hanging = (await b.page()).evaluate('new Promise(() => {})');
      process.kill(b.pid, 'SIGKILL');
      await assert.rejects(hanging, { code: 'CHROME_EXITED' });
      await assert.rejects(b.page(), { code: 'CHROME_EXITED' });
    } finally { await b.close(); }
    assert.ok(exited(b.pid), `pid ${b.pid} exited`);
    assert.equal(fs.existsSync(b.profile), false);
  });

  test('SIGTERM also terminates owned Chrome and removes its profile while preserving the parent SIGTERM exit', needs, async () => {
    const lib = new URL('../src/html/chrome.mjs', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `const { launch } = await import(${JSON.stringify(lib)});
const b = await launch({ executable: ${JSON.stringify(chrome)} }); console.log(JSON.stringify({ pid: b.pid, profile: b.profile })); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
    const ended = new Promise(resolve => child.once('exit', (code, signal) => resolve(signal)));
    let info;
    try {
      info = JSON.parse(await new Promise(resolve => child.stdout.once('data', resolve)));
      child.kill('SIGTERM');
      assert.equal(await ended, 'SIGTERM');
      assert.equal(fs.existsSync(info.profile), false);
      // Chrome has received SIGKILL but may briefly remain a zombie until the system reaps it.
      for (let i = 0; i < 100 && !exited(info.pid); i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(exited(info.pid), `pid ${info.pid} exited`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await ended; }
      if (info) { try { process.kill(info.pid, 'SIGKILL'); } catch {} fs.rmSync(info.profile, { recursive: true, force: true }); }
    }
  });

  // A signal before handler registration exits immediately and can leave a new profile behind. Signal as soon as the profile appears to hit the window before process startup.
  test('SIGTERM during startup immediately after profile creation leaves no profile', needs, async () => {
    const lib = new URL('../src/html/chrome.mjs', import.meta.url).href, tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fac-sig-'));
    try {
      for (let i = 0; i < 8; i++) {
        const child = spawn(process.execPath, ['--input-type=module', '-e', `const { launch } = await import(${JSON.stringify(lib)});
await launch({ executable: ${JSON.stringify(chrome)} }); setInterval(() => {}, 1000);`], { stdio: 'ignore', env: { ...process.env, TMPDIR: tmp } });
        const ended = new Promise(resolve => child.once('exit', (code, signal) => resolve(signal)));
        for (let t = 0; t < 2500 && !fs.readdirSync(tmp).length; t++) await new Promise(resolve => setTimeout(resolve, 2));
        child.kill('SIGTERM');
        assert.equal(await ended, 'SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.deepEqual(fs.readdirSync(tmp), [], `Attempt ${i + 1}`);
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('Mock-document fix round trip: perturbed overrides produce restoring fixes/original bases, restore zero diff, invert rotated-parent coordinates, and diagnose left/top through focus', needs, async () => {
    // Inline bitmaps so image fills render; the reference is the same page without overrides.
    const build = async (id, overrides = {}) => {
      const { output, bytes } = await extracted(id), result = run(output, { overrides });
      return { output, result, html: embed(result.html, Object.fromEntries(Object.entries(bytes).map(([k, b]) => [k, dataUri('png', b)]))).html };
    };
    const shots = {};
    for (const id of ['1:2', '1:3']) { await tab.open(url(`fd-${id.replace(':', '-')}.html`, (await build(id)).html), 160, 160); shots[id] = await tab.shot(); }
    let n = 0;
    const checked = async (id, overrides, focus) => {
      const p = await build(id, overrides);
      assert.deepEqual(p.result.overrides.applied, Object.keys(overrides), 'Perturbation overrides were applied');
      return (await check(tab, { url: url(`fd-${n++}.html`, p.html), reference: shots[id], expected: { width: 160, height: 160 }, frame: { output: p.output, result: p.result, overrides, ...(focus ? { focus } : {}) } })).report;
    };
    // Fix preserves the linear transform and restores translation within 0.01 px.
    const nums = t => t.match(/-?[\d.]+(?:e-?\d+)?/g).map(Number);
    const near = (t, want) => nums(t).length === nums(want).length && nums(t).every((v, i) => Math.abs(v - nums(want)[i]) <= 0.01);
    const perturb = (node, from, to) => ({ [node]: { style: { transform: to }, basis: { transform: from }, note: '\u6270\u52a8' } });

    // (a) Move 4:27 down 2 px.
    const a = await checked('1:3', perturb('4:27', 'translate(100px,110px)', 'translate(100px,112px)')), ea = a.top.find(e => e.node === '4:27');
    assert.ok(ea?.fix, JSON.stringify(a.top));
    assert.deepEqual([ea.shift.dx, ea.shift.dy, near(ea.fix.style.transform, 'translate(100px,110px)'), ea.fix.basis], [0, -2, true, { transform: 'translate(100px,110px)' }]);
    assert.ok(ea.htmlPx > 0 && ea.figmaPx > 0);
    assert.equal((await checked('1:3', { '4:27': { style: ea.fix.style, basis: ea.fix.basis, note: '\u4fee\u6b63' } })).mismatched, 0, 'Applying the fix matches the reference');

    // (b) Perturb 4:8 inside 30-degree group 4:7 by canvas (-3,3), using local inverse(L) * (-3,3). Most slanted-edge differences classify as antialiasing:
    //     a canvas (0,2) shift gives only about 20 mismatches below the fix threshold, so move 3 px on both axes.
    const c30 = Math.cos(Math.PI / 6), s30 = Math.sin(Math.PI / 6), moved4 = `translate(${(-3 * c30 + 3 * s30).toFixed(3)}px,${(3 * s30 + 3 * c30).toFixed(3)}px)`;
    const b = await checked('1:3', perturb('4:8', 'translate(0px,0px)', moved4)), eb = b.top.find(e => e.node === '4:8');
    assert.ok(eb?.fix, JSON.stringify(b.top));
    assert.deepEqual([eb.shift.dx, eb.shift.dy, near(eb.fix.style.transform, 'translate(0px,0px)'), eb.flat], [3, -3, true, undefined], eb.fix.style.transform);

    // (c) Move passthrough group 3:3, rendered with left/top, down 2 px and diagnose through focus.
    const c = await checked('1:2', perturb('3:3', 'translate(30px,60px)', 'translate(30px,62px)'), ['3:3']), [ec] = c.focus;
    assert.deepEqual([ec.node, ec.fix?.style.transform, ec.fix?.basis, ec.flat], ['3:3', 'translate(30px,60px)', { transform: 'translate(30px,60px)' }, true], JSON.stringify(ec));
    assert.match(ec.hint, /left\/top/);
  });

  // Worst-case frame-aware search: five 440x440 noise blocks shift 2 px, each searching about 444x446 near the 200,000 px limit and occupying the top five ranks.
  test('A 1440x6000 frame shifted 1 px checks within 1.6 s with attribution within 1 s; maximum-area top searches stay within 500 ms and added stages within 800 ms', needs, async t => {
    const rows = Array.from({ length: 300 }, (_, i) => `<div class="n" data-node="2:${i}" data-name="\u884c${i}" style="transform:translate(24px,${i * 20}px);width:1392px;height:20px">
<div class="n" data-node="3:${i}" data-name="\u8272\u5757${i}" style="transform:translate(0,2px);width:16px;height:16px;background:hsl(${i * 7 % 360},70%,50%)"></div>
<div class="n" data-node="4:${i}" data-name="\u6587\u5b57${i}" style="transform:translate(28px,1px);font:14px sans-serif;white-space:pre">\u7b2c ${i} \u884c Row ${i} · The quick brown fox jumps over the lazy dog</div></div>`).join('');
    let seed = 1;
    const noise = new Uint8Array(440 * 440 * 4).map((_, i) => i % 4 === 3 ? 255 : (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24);
    const z = `<style>.z{background:url(data:image/png;base64,${encodePng(440, 440, noise).toString('base64')})}</style>`;
    const blocks5 = d => Array.from({ length: 5 }, (_, n) => `<div class="n z" data-node="5:${n}" data-name="\u566a\u58f0${n}" style="transform:translate(980px,${200 + n * 1100 + d}px);width:440px;height:440px"></div>`).join('');
    const tall = (dy, d, name) => url(name, page(`${z}<div class="n" data-node="1:9" data-name="\u5185\u5bb9" style="transform:translate(0,${dy}px)">${rows}</div>${blocks5(d)}`, { width: 1440, height: 6000 }));
    // Handwritten extracted tree generated from the same rows as the page.
    const N = (id, name, x, y, w, h, extra = {}) => ({ id, name, type: 'FRAME', transform: [[1, 0, x], [0, 1, y]], width: w, height: h, renderBounds: [x, y, w, h], ...extra });
    const tree = N('1:1', '\u5e27', 0, 0, 1440, 6000, { children: [N('1:9', '\u5185\u5bb9', 24, 0, 1392, 6000, { children: Array.from({ length: 300 }, (_, i) => N(`2:${i}`, `\u884c${i}`, 24, i * 20, 1392, 20,
      { children: [N(`3:${i}`, `\u8272\u5757${i}`, 24, i * 20 + 2, 16, 16), N(`4:${i}`, `\u6587\u5b57${i}`, 52, i * 20 + 1, 600, 18, { type: 'TEXT' })] })) }),
      ...Array.from({ length: 5 }, (_, n) => N(`5:${n}`, `\u566a\u58f0${n}`, 980, 200 + n * 1100, 440, 440))] });
    const frame = { output: { root: tree, islands: {} }, result: { approximations: [], overrides: { applied: [] }, fonts: [] }, overrides: {} };
    await tab.open(tall(0, 0, 'tall-a.html'), 1440, 6000);
    const ref = await tab.shot();
    const { report } = await check(tab, { url: tall(1, 2, 'tall-b.html'), reference: ref, expected: { width: 1440, height: 6000 }, frame });
    const ms = report.ms, base = ms.decode + ms.match + ms.blocks + ms.attrib, added = ms.figma + ms.facts + ms.fonts + ms.top + ms.structure + ms.suggest;
    t.diagnostic(`ms ${JSON.stringify(ms)}; top ${JSON.stringify(report.top.map(e => [e.node, e.px, e.shift?.before, e.shift?.after]))}`);
    assert.ok(report.mismatched > 10000 && report.nodes.length > 100, `Translation should cause widespread differences: ${report.mismatched} px, ${report.nodes.length} nodes`);
    assert.ok(base <= 1600, `Check stages ${JSON.stringify(ms)}`);
    assert.ok(ms.attrib <= 1000, `Attribution ${ms.attrib} ms`);
    assert.deepEqual(report.top.map(e => [e.node, e.shift?.dy, !!e.fix]).sort(), [0, 1, 2, 3, 4].map(n => [`5:${n}`, -2, true]));
    assert.ok(ms.top <= 500 && added <= 800, `top ${ms.top} ms, added stages ${added} ms`);
  });
});
