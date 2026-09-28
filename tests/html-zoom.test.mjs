/**
 * [INPUT]: Imports node:test, node:assert/strict, node:fs, node:os, node:path, node:url, ../src/html/zoom.mjs, ../src/html/chrome.mjs, ../src/png.mjs.
 * [OUTPUT]: Node.js test cases and fixture setup for this revision.
 * [POS]: Regression coverage for html zoom; tests use local synthetic inputs and isolated state.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { zoomTarget, renderZoom, zoomCompare } from '../src/html/zoom.mjs';
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

  
});
