/**
 * [INPUT]: src/html/zoom zoomTarget/renderZoom/zoomCompare; src/html/check check/writeEvidence; src/html/chrome findChrome/launch; src/png decodePng/encodePng; local Chrome for two cases.
 * [OUTPUT]: No exports; node:test cases.
 * [POS]: Zoom comparison tests cover scale/target/rotation/reflection/size preflight, skipped comparisons, timeout retention of 1x reports, and identical-image search suppression without Chrome. Chrome cases isolate target subtrees and neutralize ancestors, search/fix at 1/k px, and persist evidence. Missing Chrome skips with a reason; profiles and processes belong only to this suite.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { zoomTarget, renderZoom, zoomCompare } from '../src/html/zoom.mjs';
import { check, writeEvidence } from '../src/html/check.mjs';
import { findChrome, launch } from '../src/html/chrome.mjs';
import { decodePng, encodePng } from '../src/png.mjs';

let chrome = null, reason = '';
try { chrome = findChrome(); } catch (error) { reason = `${error.code}: ${error.message}`; }
const needs = { skip: chrome ? false : reason };

// Frame 0:1 is 100x40: 3:1 is 40x20 at (30,10), 3:2 rotates 30 degrees, 3:3 is horizontally reflected, and 3:4 is a child of 3:1.
const N = (id, t, w, h, extra = {}) => ({ id, name: id, type: 'FRAME', transform: t, width: w, height: h, renderBounds: null, ...extra });
const c30 = Math.cos(Math.PI / 6), s30 = Math.sin(Math.PI / 6);
const frame = () => ({ scale: 1, islands: {}, root: N('0:1', [[1, 0, 0], [0, 1, 0]], 100, 40, { children: [N('3:1', [[1, 0, 30], [0, 1, 10]], 40, 20, { children: [N('3:4', [[1, 0, 30], [0, 1, 10]], 1, 1)] }),
  N('3:2', [[c30, -s30, 0], [s30, c30, 0]], 10, 10), N('3:3', [[-1, 0, 70], [0, 1, 10]], 40, 20)] }) });
const zoomOf = (id, k, w = 40, h = 20) => ({ scale: k, islands: {}, root: N(id, [[1, 0, 0], [0, 1, 0]], w, h) });
const solid = (w, h, rgba) => encodePng(w, h, new Uint8Array(w * h * 4).map((_, i) => rgba[i % 4]));

test('zoomTarget requires scale (1,4] and an in-frame unrotated node, allows reflection, returns frame bounds/expected zoom size, and warns on size mismatch', () => {
  for (const [z, message] of [[zoomOf('3:1', 1), /^--zoom needs an extract job with --scale greater than 1 \(at most 4\), got 1$/], [zoomOf('3:1', 4.5), /got 4\.5$/],
    [zoomOf('9:9', 2), /^--zoom node 9:9 is not inside any page's frame$/], [zoomOf('3:2', 2, 10, 10), /^Zoom comparison does not support rotated nodes: 3:2$/]])
    assert.throws(() => zoomTarget(frame(), z), error => message.test(error.message), String(message));
  assert.deepEqual(zoomTarget(frame(), zoomOf('3:1', 4)), { node: '3:1', k: 4, box: [30, 10, 40, 20], expected: { width: 160, height: 80 }, warnings: [] });
  assert.deepEqual(zoomTarget(frame(), zoomOf('3:3', 2.5)).box, [30, 10, 40, 20], 'Horizontal reflection is allowed');
  assert.deepEqual(zoomTarget(frame(), zoomOf('3:1', 2, 41, 20)).warnings, ['Node size changed between the two extracts: 40x20 in the frame, 41x20 in the zoom job']);
});

test('Wrong zoom-reference size, ref overlap, or missing elements do not open a page; zoom timeout records only zoom.reason and preserves the 1x report', async () => {
  let opened = 0;
  const idle = { open: async () => { opened++; }, shot: async () => Buffer.alloc(0), evaluate: async () => ({}) };
  const target = zoomTarget(frame(), zoomOf('3:1', 4)), reference = solid(160, 80, [255, 0, 0, 255]), placement = { style: 'transform:translate(30px,10px)', chain: [1, 0, 0, 1] };
  const base = { node: '3:1', extract: 'e', scale: 4, size: [160, 80], dir: 'zoom-3-1' };
  const run = extra => zoomCompare(idle, { url: 'about:blank', target, extract: 'e', reference, placement, inRef: false, ...extra });
  assert.deepEqual(await run({ reference: solid(158, 80, [0, 0, 0, 255]) }), { result: { ...base, size: [158, 80], expected: [160, 80], reason: 'REFERENCE_SIZE' } });
  assert.deepEqual(await run({ inRef: true }), { result: { ...base, reason: 'IN_REF' } });
  assert.deepEqual(await run({ placement: undefined }), { result: { ...base, reason: 'NOT_RENDERED' } });
  assert.equal(opened, 0);

  // Through check: 1x succeeds but opening at dsf != 1 times out; a ref inside 3:1's subtree yields IN_REF.
  const white = solid(100, 40, [255, 255, 255, 255]), fact = { found: true, box: [30, 10, 40, 20], style: 'transform:translate(30px,10px)', chain: [1, 0, 0, 1] };
  const stub = { browser: { version: 'fake' }, shot: async () => white, open: async (url, w, h, dsf = 1) => { if (dsf !== 1) throw Object.assign(Error('\u8d85\u65f6'), { code: 'RENDER_TIMEOUT' }); },
    evaluate: async () => ({ ids: [], names: [], rects: [], facts: { '3:1': fact }, faces: {}, els: [], nodes: ['0:1', '3:1', '3:4'], texts: {} }) };
  const input = refs => ({ url: 'about:blank', reference: white, expected: { width: 100, height: 40 }, refs,
    frame: { output: frame(), result: { approximations: [], overrides: { applied: [] }, fonts: [] }, overrides: {}, zoom: { target, extract: 'e', reference } } });
  const late = (await check(stub, input([]))).report;
  assert.deepEqual([late.verdict, late.mismatched, late.zoom, Number.isInteger(late.ms.zoom)], ['clean', 0, { ...base, reason: 'RENDER_TIMEOUT' }, true]);
  assert.equal((await check(stub, input([{ node: '3:4', rect: [30, 10, 31, 11] }]))).report.zoom.reason, 'IN_REF');
});

test('zoomCompare skips search and hints for identical images even above the search-area limit', async () => {
  const big = solid(500, 500, [9, 9, 9, 255]), page = { open: async () => {}, evaluate: async () => {}, shot: async () => big };
  const target = { node: '3:1', k: 4, box: [30, 10, 40, 20], expected: { width: 500, height: 500 }, warnings: [] };
  const { result } = await zoomCompare(page, { url: 'about:blank', target, extract: 'e', reference: big, placement: { style: 'transform:translate(30px,10px)', chain: [1, 0, 0, 1] }, inRef: false });
  assert.deepEqual([result.mismatched, result.shift, result.fix, result.hint], [0, undefined, undefined, undefined]);
});

describe('Zoom comparison (requires Chrome)', () => {
  let browser, tab, dir, tmp;
  // X=3:1: translucent ancestor 2:1 clips its right half and has a green background; sibling 3:2 covers it. X has alternating 1 px black/white rows, with half the pixels changing after a 0.5 px shift.
  const page = y => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}
#canvas{position:relative;width:100px;height:40px;overflow:hidden} .n{position:absolute;left:0;top:0;transform-origin:0 0}</style></head><body>
<div id="canvas" data-node="0:1"><div class="n" data-node="2:1" style="transform:translate(10px,10px);width:40px;height:20px;opacity:0.5;overflow:hidden;background:#0f0">
<div class="n" data-node="3:1" style="transform:translate(20px,${y}px);width:40px;height:20px;background:repeating-linear-gradient(#000 0 1px,#fff 1px 2px)"></div>
<div class="n" data-node="3:2" style="transform:translate(25px,5px);width:10px;height:10px;background:#f00"></div></div></div></body></html>`;
  const url = (name, html) => { const file = path.join(dir, name); fs.writeFileSync(file, html); return pathToFileURL(file).href; };
  before(async () => {
    if (!chrome) return;
    // Keep profiles in this suite's temporary directory; other suites count fac-chrome-* in system temporary storage.
    tmp = process.env.TMPDIR; process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fac-html-zoom-'));
    dir = process.env.TMPDIR;
    browser = await launch({ executable: chrome });
    tab = await browser.page();
  });
  after(async () => {
    if (!chrome) return;
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (tmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = tmp;
  });

  test('renderZoom keeps only X\'s subtree, removing ancestor opacity/clipping/background and covering siblings, at k=2 and k=4', needs, async () => {
    for (const k of [2, 4]) {
      const img = decodePng(await renderZoom(tab, url(`z${k}.html`, page(0)), { node: '3:1', k, box: [30, 10, 40, 20] }, { width: 40 * k, height: 20 * k }));
      assert.deepEqual([img.width, img.height], [40 * k, 20 * k]);
      const at = (x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
      // Row 0 is black and row k white (one stripe per CSS pixel), including the clipped right half and sibling position; all pixels are opaque.
      assert.deepEqual([at(0, 0), at(0, k), at(img.width - 1, 0), at(5 * k, 5 * k), at(6 * k, 6 * k)], [[0, 0, 0, 255], [255, 255, 255, 255], [0, 0, 0, 255], [255, 255, 255, 255], [0, 0, 0, 255]]);
    }
  });

  test('zoomCompare self-comparison has no shift; a 0.5 px downward offset yields dy=-0.5 and a restoring fix; writeEvidence saves three zoom-<node>/ images', needs, async () => {
    const target = { node: '3:1', k: 4, box: [30, 10, 40, 20], expected: { width: 160, height: 80 }, warnings: [] };
    const reference = await renderZoom(tab, url('ref.html', page(0)), target, { width: 160, height: 80 });
    const style = y => `transform:translate(20px,${y}px);width:40px;height:20px`;
    const same = await zoomCompare(tab, { url: url('same.html', page(0)), target, extract: 'e', reference, placement: { style: style(0), chain: [1, 0, 0, 1] }, inRef: false });
    assert.deepEqual([same.result.mismatched, same.result.shift, same.result.fix], [0, undefined, undefined]);
    const moved = await zoomCompare(tab, { url: url('moved.html', page(0.5)), target, extract: 'e', reference, placement: { style: style(0.5), chain: [1, 0, 0, 1] }, inRef: false });
    const r = moved.result;
    assert.ok(r.mismatched > 1000, `${r.mismatched}`);
    assert.deepEqual([r.shift.dx, r.shift.dy, r.fix, r.flat, r.dir], [0, -0.5, { style: { transform: 'translate(20px,0px)' }, basis: { transform: 'translate(20px,0.5px)' } }, undefined, 'zoom-3-1']);
    assert.ok(r.shift.after < r.shift.before * 0.1, JSON.stringify(r.shift));
    const out = path.join(dir, 'evidence'), one = encodePng(1, 1, new Uint8Array(4));
    fs.mkdirSync(out);
    await writeEvidence(out, { blocks: [] }, { width: 1, height: 1, render: one, diff: new Uint8Array(4), ref: new Uint8Array(4), act: new Uint8Array(4), zoom: moved.images });
    assert.deepEqual(fs.readdirSync(path.join(out, 'zoom-3-1')).sort(), ['diff.png', 'figma.png', 'html.png']);
    assert.deepEqual(fs.readFileSync(path.join(out, 'zoom-3-1', 'figma.png')), reference);
    assert.deepEqual(['html', 'diff'].map(n => { const p = decodePng(fs.readFileSync(path.join(out, 'zoom-3-1', `${n}.png`))); return [p.width, p.height]; }), [[160, 80], [160, 80]]);
  });
});
